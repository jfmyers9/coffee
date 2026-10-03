export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function invalid(message) { throw new HttpError(400, message); }
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected a JSON object');
}
export function keys(value, allowed) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Unknown or immutable field');
}
export function string(value, name, max = 120, required = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) invalid(`Invalid ${name}`);
  return value.trim();
}
export function number(value, name, min, max, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`Invalid ${name}`);
  return value;
}
export function choice(value, name, allowed, nullable = false) {
  if (nullable && value === null) return null;
  if (!allowed.includes(value)) invalid(`Invalid ${name}`);
  return value;
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid('Invalid UUID');
  return value.toLowerCase();
}
function date(value, name) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid(`Invalid ${name}`);
  return value;
}
export function timestamp(value, name = 'startedAt') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(`Invalid ${name}`);
  date(value.slice(0, 10), name);
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) invalid(`Invalid ${name}`);
  return new Date(value).toISOString();
}
const bagText = ['origin', 'process', 'variety', 'roastLevel', 'tastingNotes', 'notes'];
const bagDates = ['purchasedOn', 'roastedOn', 'openedOn'];
export function bagInput(body, partial = false) {
  keys(body, ['roaster', 'name', ...bagText, ...bagDates, 'caffeineType', 'weightGrams', 'price', 'archived']);
  const value = partial ? {} : { origin: '', process: '', variety: '', roastLevel: '', tastingNotes: '', notes: '', purchasedOn: null, roastedOn: null, openedOn: null, weightGrams: null, price: null, caffeineType: 'regular', archived: false };
  for (const field of ['roaster', 'name']) if (!partial || field in body) value[field] = string(body[field], field, 120, true);
  for (const field of bagText) if (field in body) value[field] = string(body[field], field, ['notes', 'tastingNotes'].includes(field) ? 5000 : 120);
  for (const field of bagDates) if (field in body) value[field] = date(body[field], field);
  if ('caffeineType' in body) value.caffeineType = choice(body.caffeineType, 'caffeineType', ['regular', 'decaf', 'half-caf']);
  if ('weightGrams' in body) { value.weightGrams = number(body.weightGrams, 'weightGrams', Number.MIN_VALUE, 10000, true); }
  if ('price' in body) value.price = number(body.price, 'price', 0, 1000000, true);
  if ('archived' in body) { if (typeof body.archived !== 'boolean') invalid('Invalid archived'); value.archived = body.archived; }
  return value;
}
export function brewPatch(body) {
  keys(body, ['status', 'elapsedSeconds', 'rating', 'taste', 'notes', 'waterActual', 'servings', 'finishedAt']);
  const result = {};
  if ('finishedAt' in body) result.finishedAt = timestamp(body.finishedAt, 'finishedAt');
  if ('status' in body) result.status = choice(body.status, 'status', ['brewing', 'completed', 'discarded']);
  if ('elapsedSeconds' in body) result.elapsedSeconds = number(body.elapsedSeconds, 'elapsedSeconds', 0, 86400);
  if ('rating' in body) { result.rating = number(body.rating, 'rating', 1, 5, true); if (result.rating !== null && !Number.isInteger(result.rating)) invalid('Invalid rating'); }
  if ('taste' in body) result.taste = choice(body.taste, 'taste', ['balanced', 'sour', 'bitter', 'weak', 'strong'], true);
  if ('notes' in body) result.notes = string(body.notes, 'notes', 10000);
  if ('waterActual' in body) result.waterActual = number(body.waterActual, 'waterActual', 0, 2000, true);
  if ('servings' in body) {
    if (!Array.isArray(body.servings) || body.servings.length > 10) invalid('Invalid servings');
    result.servings = body.servings.map(serving => {
      keys(serving, ['person', 'volumeMl', 'milk', 'caffeineMg']);
      return { person: string(serving.person, 'person', 60, true), volumeMl: number(serving.volumeMl, 'volumeMl', Number.MIN_VALUE, 2000), milk: choice(serving.milk, 'milk', ['none', 'dairy', 'oat', 'other']), caffeineMg: number(serving.caffeineMg ?? null, 'caffeineMg', 0, 1000, true) };
    });
  }
  return result;
}
export function photoInput(body) {
  keys(body, ['dataUrl']);
  if (typeof body.dataUrl !== 'string') invalid('Invalid photo');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(body.dataUrl);
  if (!match || match[2].length % 4) invalid('Invalid photo data URL');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 2 * 1024 * 1024) throw new HttpError(413, 'Photo exceeds 2 MB');
  const valid = match[1] === 'jpeg' ? bytes.length >= 4 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) && bytes.subarray(-2).equals(Buffer.from([255, 217]))
    : match[1] === 'png' ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR'
      : bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) invalid('Photo signature does not match its image type');
  return { bytes, type: `image/${match[1]}` };
}
