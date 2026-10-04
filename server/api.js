import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createRecipe, resolveRecipe } from '../public/recipe.js';
import { transaction } from './db.js';
import { HttpError, invalid, keys, uuid, number, string, choice, timestamp, bagInput, brewPatch, photoInput } from './validation.js';

const bagSelect = `SELECT b.data, b.photo IS NOT NULL AS has_photo,
  COALESCE((SELECT SUM(dose) FROM brews WHERE bag_id=b.id),0)::float8 AS used FROM bags b`;
function presentBag(row) {
  return { ...row.data, hasPhoto: row.has_photo, remainingGrams: row.data.weightGrams === null ? null : Math.round((row.data.weightGrams - row.used) * 1e10) / 1e10 };
}
async function getBag(client, id) {
  const result = await client.query(`${bagSelect} WHERE b.id=$1`, [id]);
  if (!result.rowCount) throw new HttpError(404, 'Bag not found');
  return presentBag(result.rows[0]);
}
async function listBags(client) {
  const bags = await client.query(`${bagSelect} ORDER BY b.data->>'createdAt' DESC, b.id`);
  const settings = await client.query('SELECT default_bag_id FROM app_settings WHERE singleton');
  return { bags: bags.rows.map(presentBag), defaultBagId: settings.rows[0].default_bag_id };
}
function brewInput(body) {
  keys(body, ['id', 'bagId', 'recipeId', 'recipeVersion', 'brewer', 'variant', 'dose', 'temperatureF', 'grindSetting', 'startedAt']);
  let recipeId = body.recipeId;
  if (recipeId === undefined) {
    // Legacy outboxes identify one of the original recipes by brewer/variant.
    if (!['v60', 'chemex'].includes(body.brewer) || !['hot', 'japanese-iced'].includes(body.variant ?? 'hot') || (body.brewer === 'chemex' && body.variant && body.variant !== 'hot')) invalid('Unknown recipe');
    recipeId = `${body.brewer}-${body.variant ?? 'hot'}`;
  }
  recipeId = string(recipeId, 'recipeId', 80, true);
  if (!/^[a-z][a-z0-9-]*$/.test(recipeId)) invalid('Invalid recipeId');
  const input = { id: uuid(body.id), bagId: body.bagId == null ? null : uuid(body.bagId),
    recipeId, dose: number(body.dose, 'dose', 0.1, 100),
    temperatureF: number(body.temperatureF, 'temperatureF', 140, 212),
    grindSetting: string(body.grindSetting, 'grindSetting', 80, true),
    startedAt: body.startedAt === undefined ? null : timestamp(body.startedAt) };
  if (body.recipeVersion !== undefined) input.recipeVersion = string(body.recipeVersion, 'recipeVersion', 64, true);
  return input;
}
function normalizeLegacyRequest(request) {
  const { brewer, variant, ...rest } = request;
  return { recipeId: `${brewer}-${variant ?? 'hot'}`, ...rest };
}
async function isBrewDeleted(client, id) {
  return (await client.query('SELECT 1 FROM deleted_brews WHERE id=$1', [id])).rowCount > 0;
}
async function rejectDeletedBrew(client, id) {
  if (await isBrewDeleted(client, id)) throw new HttpError(410, 'Brew was permanently deleted');
}
function pagination(value, fallback, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) invalid('Invalid pagination');
  return Number(value);
}

export async function api({ pool, recipes, method, url, body }) {
  const path = url.pathname;
  if (path === '/api/recipes' && method === 'GET') return { data: { recipes } };
  if (path === '/api/bags' && method === 'GET') return { data: await listBags(pool) };
  if (path === '/api/bags' && method === 'POST') {
    const data = { ...bagInput(body), id: randomUUID(), createdAt: new Date().toISOString() };
    return { status: 201, data: await transaction(pool, async client => {
      await client.query('SELECT singleton FROM app_settings FOR UPDATE');
      await client.query('INSERT INTO bags(id,data) VALUES($1,$2)', [data.id, data]);
      if (!data.archived) await client.query('UPDATE app_settings SET default_bag_id=$1', [data.id]);
      return getBag(client, data.id);
    }) };
  }
  const bagRoute = /^\/api\/bags\/([^/]+)(?:\/(default|photo))?$/.exec(path);
  if (bagRoute) {
    const id = uuid(bagRoute[1]);
    const action = bagRoute[2];
    if (!action && method === 'GET') return { data: await getBag(pool, id) };
    if (action === 'photo' && method === 'GET') {
      const result = await pool.query('SELECT photo,photo_type FROM bags WHERE id=$1', [id]);
      if (!result.rows[0]?.photo) throw new HttpError(404, 'Photo not found');
      return { bytes: result.rows[0].photo, type: result.rows[0].photo_type };
    }
    if ((!action && method === 'PATCH') || (action === 'default' && method === 'POST') || (action === 'photo' && ['PUT', 'DELETE'].includes(method))) {
      const patch = !action ? bagInput(body, true) : null;
      const photo = action === 'photo' && method === 'PUT' ? photoInput(body) : null;
      if (action === 'default' || method === 'DELETE') keys(body, []);
      return { data: await transaction(pool, async client => {
        // Settings before bags is a consistent lock order for concurrent default/archive writes.
        await client.query('SELECT singleton FROM app_settings FOR UPDATE');
        const result = await client.query('SELECT data FROM bags WHERE id=$1 FOR UPDATE', [id]);
        if (!result.rowCount) throw new HttpError(404, 'Bag not found');
        const data = { ...result.rows[0].data, ...patch };
        if (!action) {
          await client.query('UPDATE bags SET data=$2 WHERE id=$1', [id, data]);
          if (data.archived) await client.query('UPDATE app_settings SET default_bag_id=NULL WHERE default_bag_id=$1', [id]);
        } else if (action === 'default') {
          if (data.archived) throw new HttpError(409, 'Archived bag cannot be the default');
          await client.query('UPDATE app_settings SET default_bag_id=$1', [id]);
          return { defaultBagId: id };
        } else {
          await client.query('UPDATE bags SET photo=$2,photo_type=$3 WHERE id=$1', [id, photo?.bytes ?? null, photo?.type ?? null]);
        }
        return getBag(client, id);
      }) };
    }
  }
  if (path === '/api/brews' && method === 'POST') {
    const input = brewInput(body);
    return transaction(pool, async client => {
      // Serializing the client UUID avoids a double inventory debit even for concurrent retries.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.id]);
      await rejectDeletedBrew(client, input.id);
      const existing = await client.query('SELECT request,data FROM brews WHERE id=$1', [input.id]);
      if (existing.rowCount) {
        // Older queued requests and persisted records predate recipe variants.
        if (!isDeepStrictEqual(normalizeLegacyRequest(existing.rows[0].request), input) || (body.brewer !== undefined && body.brewer !== existing.rows[0].data.brewer) || (body.variant !== undefined && body.variant !== (existing.rows[0].data.variant ?? 'hot'))) throw new HttpError(409, 'Brew ID already used with different start data');
        return { data: existing.rows[0].data };
      }
      let definition, recipe;
      try {
        definition = resolveRecipe(recipes, input);
        recipe = createRecipe(definition, input.dose);
      } catch { invalid('Unknown recipe or invalid dose (use supported range and 0.1 g increments)'); }
      if (body.brewer !== undefined && body.brewer !== recipe.brewer) invalid('Recipe does not match brewer');
      if (body.variant !== undefined && body.variant !== recipe.variant) invalid('Recipe does not match variant');
      if (input.recipeVersion && input.recipeVersion !== recipe.version) throw new HttpError(409, 'Recipe changed since this brew was prepared. Restore its prior file revision to sync this queued brew; reload before preparing a new brew.');
      let bagSnapshot = null;
      if (input.bagId) {
        const bag = await client.query('SELECT data FROM bags WHERE id=$1 FOR SHARE', [input.bagId]);
        if (!bag.rowCount) throw new HttpError(404, 'Bag not found');
        const { name, roaster, caffeineType } = bag.rows[0].data;
        bagSnapshot = { name, roaster, caffeineType };
      }
      const data = { ...input, brewer: recipe.brewer, variant: recipe.variant, startedAt: input.startedAt ?? new Date().toISOString(), recipe, water: recipe.water, ice: recipe.ice, totalWater: recipe.totalWater, bagSnapshot, status: 'brewing', elapsedSeconds: 0, finishedAt: null, rating: null, taste: null, notes: '', waterActual: null, servings: [] };
      await client.query('INSERT INTO brews(id,bag_id,dose,started_at,status,request,data) VALUES($1,$2,$3,$4,$5,$6,$7)', [data.id, data.bagId, data.dose, data.startedAt, data.status, input, data]);
      return { status: 201, data };
    });
  }
  if (path === '/api/brews' && method === 'GET') {
    const params = url.searchParams;
    const limit = pagination(params.get('limit'), 50, 200);
    const offset = pagination(params.get('offset'), 0, 10000000);
    if (!limit) invalid('limit must be positive');
    const values = [], filters = [];
    for (const [field, column, validate] of [ ['bagId', 'bag_id', uuid], ['brewer', "data->>'brewer'", value => string(value, 'brewer', 80, true)], ['status', 'status', value => choice(value, 'status', ['brewing', 'completed', 'discarded'])] ]) {
      if (params.get(field)) { values.push(validate(params.get(field))); filters.push(`${column}=$${values.length}`); }
    }
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const count = await pool.query(`SELECT count(*)::int AS total FROM brews${where}`, values);
    const rows = await pool.query(`SELECT data FROM brews${where} ORDER BY started_at DESC,id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
    return { data: { brews: rows.rows.map(row => row.data), total: count.rows[0].total } };
  }
  const brewRoute = /^\/api\/brews\/([^/]+)$/.exec(path);
  if (brewRoute && ['GET', 'PATCH', 'DELETE'].includes(method)) {
    const id = uuid(brewRoute[1]);
    if (method === 'GET') {
      const result = await pool.query('SELECT data FROM brews WHERE id=$1', [id]);
      if (!result.rowCount) {
        await rejectDeletedBrew(pool, id);
        throw new HttpError(404, 'Brew not found');
      }
      return { data: result.rows[0].data };
    }
    if (method === 'DELETE') {
      keys(body, []);
      return { data: await transaction(pool, async client => {
        // Share the create/update lock: deletion and the tombstone are atomic,
        // including when another device is retrying an old create request.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
        if (await isBrewDeleted(client, id)) return { id, deleted: true };
        const result = await client.query('SELECT status FROM brews WHERE id=$1 FOR UPDATE', [id]);
        if (!result.rowCount) throw new HttpError(404, 'Brew not found');
        if (result.rows[0].status === 'brewing') throw new HttpError(409, 'Finish or discard this brew before deleting it');
        await client.query('INSERT INTO deleted_brews(id) VALUES($1)', [id]);
        await client.query('DELETE FROM brews WHERE id=$1', [id]);
        return { id, deleted: true };
      }) };
    }
    const patch = brewPatch(body);
    return { data: await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      await rejectDeletedBrew(client, id);
      const result = await client.query('SELECT data FROM brews WHERE id=$1 FOR UPDATE', [id]);
      if (!result.rowCount) throw new HttpError(404, 'Brew not found');
      const existing = result.rows[0].data;
      if (existing.status !== 'brewing' && patch.status && patch.status !== existing.status) throw new HttpError(409, 'Terminal brew status cannot change');
      if (patch.finishedAt) {
        if (existing.status !== 'brewing' && patch.finishedAt !== existing.finishedAt) throw new HttpError(409, 'Terminal finish time cannot change');
        if ((patch.status || existing.status) === 'brewing') invalid('finishedAt requires a terminal status');
        if (Date.parse(patch.finishedAt) < Date.parse(existing.startedAt) || Date.parse(patch.finishedAt) > Date.now() + 5 * 60 * 1000) invalid('finishedAt must follow startedAt and not be in the future');
      }
      const data = { ...existing, ...patch };
      // Delayed progress writes must not move a persisted timer backwards.
      data.elapsedSeconds = Math.max(existing.elapsedSeconds, data.elapsedSeconds);
      if (existing.status === 'brewing' && data.status !== 'brewing') {
        data.finishedAt = patch.finishedAt || new Date().toISOString();
        if (Date.parse(data.finishedAt) < Date.parse(data.startedAt)) invalid('finishedAt must follow startedAt');
      }
      await client.query('UPDATE brews SET data=$2,status=$3 WHERE id=$1', [id, data, data.status]);
      return data;
    }) };
  }
  if (path === '/api/summary' && method === 'GET') {
    const from = timestamp(url.searchParams.get('from'), 'from');
    const to = timestamp(url.searchParams.get('to'), 'to');
    const duration = Date.parse(to) - Date.parse(from);
    if (duration <= 0 || duration > 48 * 60 * 60 * 1000) invalid('Summary range must be positive and at most 48 hours');
    const rows = await pool.query("SELECT data FROM brews WHERE status='completed' AND (data->>'finishedAt')::timestamptz >= $1::timestamptz AND (data->>'finishedAt')::timestamptz < $2::timestamptz", [from, to]);
    const people = new Map();
    let totalDose = 0;
    for (const { data } of rows.rows) {
      totalDose += data.dose;
      for (const serving of data.servings) {
        const aggregate = people.get(serving.person) || { person: serving.person, count: 0, volumeMl: 0, knownCaffeineMg: 0, unknownCaffeineCount: 0 };
        aggregate.count++;
        aggregate.volumeMl += serving.volumeMl;
        if (serving.caffeineMg === null) aggregate.unknownCaffeineCount++;
        else aggregate.knownCaffeineMg += serving.caffeineMg;
        people.set(serving.person, aggregate);
      }
    }
    return { data: { brewsCompleted: rows.rowCount, totalDose: Math.round(totalDose * 10) / 10, servings: [...people.values()].sort((a, b) => a.person.localeCompare(b.person)) } };
  }
  if (path === '/api/export' && method === 'GET') {
    const data = await transaction(pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return { ...await listBags(client), brews: (await client.query('SELECT data FROM brews ORDER BY started_at DESC,id')).rows.map(row => row.data) };
    });
    return { data, download: true };
  }
  throw new HttpError(404, 'Not found');
}
