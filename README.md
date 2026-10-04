# Morning Coffee

A shared, mobile-first coffee service for your household. Keep a bean shelf, follow V60 or Chemex pours, and remember how each cup turned out. Postgres stores bags, photos, brew history, and results; Tailscale keeps it private.

## The experience

- **Bean shelf:** roaster, coffee name, origin, process, variety, roast, tasting notes, purchase/roast/open dates, price, regular/decaf/half-caf, and a bag photo. A newly added bag becomes the default. Archive empty bags without losing history.
- **Guided brewing:** choose beans and grams, get cumulative water targets, bloom/rest timing, Encore starting settings, and a temperature in **°F**. Recipe-specific temperatures and your overrides are remembered per recipe. Timed steps advance automatically; untimed hands-on steps wait for **Done → Continue**. The timer survives reloads and attempts to keep the screen awake.
- **Automatic journal:** starting a timer records a brew. Finish or discard updates it automatically. Retrying a request never creates a second brew or double-counts beans. Recipe and coffee-name snapshots preserve what you used even if the bag is later edited.
- **Mistakes/test brews:** use **Delete brew** on a completed or discarded journal entry. Confirm to permanently remove its results/servings and return its dose to the bag inventory. Finish or discard an active brew first. If you actually used the beans, keep the discarded record instead. Deletion requires a connection.
- **Dialing in:** selecting a bag shows its most recent completed brew across recipes, including dose, temperature, grind, rating, taste, and notes. **Repeat this brew** loads its settings without starting a timer or using beans. **Refresh last brew** picks up edits from another device; an unavailable preview never blocks brewing.
- **Results:** optional 1–5 rating, taste, notes, actual water added, and individual household servings with milk choice. Repeat a past brew without manually copying its settings.
- **Shared cups:** today's completed brews and servings across the database, including entered caffeine amounts and explicitly unknown amounts. The day uses the viewing device's local time zone.
- **Inventory:** original bag weight minus coffee used by all started brews, including discarded brews. This is an estimate; it doesn't account for spills or coffee used outside the app. Negative inventory is shown rather than silently hiding a discrepancy. Deleted mistakes/test brews do not count toward usage.

### Caffeine and breastfeeding

The app **does not calculate a safe bean dose or infer caffeine from coffee grams**. Caffeine varies substantially with beans and brewing; decaf is not caffeine-free. Enter a caffeine amount only when you have an appropriate source. Blank means unknown, never zero. Daily totals include only logged servings, not other caffeine sources. Ask a clinician about breastfeeding guidance appropriate to your household. Serving volume is the coffee actually consumed, not brew water or beverage yield.

## Run locally

Requires Node.js 22+ and PostgreSQL 14+. No frontend build step. Runtime dependencies are `pg` and the official Cooklang parser (`@cooklang/cooklang`).

```sh
npm ci
export DATABASE_URL='postgresql://coffee:YOUR_PASSWORD@127.0.0.1:5432/coffee'
npm start
# http://127.0.0.1:8080
```

Use a dedicated database and login that can create tables in its schema. On startup the app applies numbered migrations atomically under a database advisory lock; it will not listen if the database is unavailable or migrations fail. `/health` checks the database connection. Restarting the service preserves all server records and photos.

## Docker + Tailscale

On a Docker host already connected to your tailnet, with an existing Postgres server reachable **from the container**:

```sh
cp .env.example .env
# Edit DATABASE_URL and APP_ORIGIN in .env before continuing.
docker compose pull
docker compose up -d
curl http://127.0.0.1:8080/health
tailscale serve --bg http://127.0.0.1:8080
```

Open the HTTPS address printed by Tailscale Serve from your phone with Tailscale connected. Serve may prompt you to enable HTTPS for your tailnet. If Serve already hosts other apps, integrate this upstream into your existing routing rather than replacing it. This app expects to be hosted at the root of its own origin, not a URL subpath.

`DATABASE_URL` is required. Use the Postgres server's hostname/IP reachable from Docker, not `localhost` (which means the app container). URL-encode special characters in the password. Restrict Postgres network access to the app and your administration machines; use TLS with certificate validation when required by your network. Do not commit `.env` or connection credentials.

`APP_ORIGIN` should be the exact browser-facing HTTPS origin, e.g. `https://coffee.example.ts.net`, **without a trailing slash**. It protects against cross-origin browser writes and works when a proxy rewrites the Host header. If omitted, request Origin must match request Host. Forwarded host headers are deliberately not trusted. This check is not authentication.

**Upgrading from the original timer-only app:** configure `DATABASE_URL` before pulling the new image. Browser preferences are retained; old local timers are not retroactively imported into the journal. New brews are recorded automatically. Take a database backup before future upgrades, and pin a known image tag/digest when rollback control matters.

Compose binds only to localhost; Tailscale Serve provides tailnet-only HTTPS. **Do not use Tailscale Funnel** (public access). This is one shared household with **no app authentication or separate user accounts**: anyone who can reach it can read and edit its records. Restrict access using your tailnet ACLs/grants. Nothing here installs or configures Tailscale automatically. HTTPS also enables screen wake lock on supported mobile browsers. No third-party fonts, analytics, or external image requests are used.

### Image publishing

[GitHub Actions](https://github.com/jfmyers9/coffee/actions) runs unit, real-Postgres API, and browser tests, builds the container, smoke-tests it against Postgres as a non-root user with a read-only filesystem, then publishes **`ghcr.io/jfmyers9/coffee`** for `linux/amd64` and `linux/arm64` with provenance and an SBOM.

- Push to `main`: publishes `latest`, `main`, and `sha-<full commit SHA>`.
- Push a version tag such as `v0.1.0`: publishes `0.1.0` and a commit tag. Version tags do not move `latest`.
- Pull requests: run tests and Docker builds without logging in or publishing.
- Manual workflow runs: publish only from `main` or a `v*` tag.

Publishing uses the repository's automatic `GITHUB_TOKEN` with `packages: write`; no personal token or registry password needs to be stored in repository secrets. Actions are pinned to commit SHAs and Dependabot tracks updates.

**One-time GHCR visibility:** a public GitHub repository does not automatically make its container package public. After the first publish, open [the coffee package settings](https://github.com/users/jfmyers9/packages/container/coffee/settings) and set visibility to **Public**. Until then, pulling requires GHCR authentication. Public visibility allows anonymous pulls; do not put secrets in the image.

To update the homelab, run `docker compose pull && docker compose up -d`. To pin a release, set `COFFEE_IMAGE=ghcr.io/jfmyers9/coffee:0.1.0` in your shell or a local `.env` file. A digest (`ghcr.io/jfmyers9/coffee@sha256:…`) is the strongest immutable pin. Updating GitHub does not automatically restart your homelab container.

To build and run locally instead of pulling:

```sh
docker build -t coffee:local .
COFFEE_IMAGE=coffee:local docker compose up -d --pull never
```

## Authoring recipes

Recipes live in [`recipes/*.cook`](recipes/). Add a file, run `npm run check:recipes`, then restart the app and reload the page. No recipe registry or JavaScript edit is required; brewers and recipe choices are discovered automatically. For Docker, rebuild the image to include the files.

See the [authoring guide](recipes/README.md) for the supported Cooklang conventions and a complete example. The three original recipes are included; an AeroPress test fixture demonstrates an additional brewer using only a recipe file.

## The first recipes

| | V60 02 | Chemex 6–8 cup |
| --- | --- | --- |
| Default coffee | 20 g | 30 g |
| Supported dose | 12–30 g | 20–45 g |
| Water | 16 × coffee weight | 16 × coffee weight |
| Original Encore starting dial | 15 | 20 |
| Temperature | 203°F default (editable) | 203°F default (editable) |
| Bloom | 3 × coffee weight, pour for 15s; rest until 0:45 | Same |
| Remaining water | Three equal pours, 25s each, with 20s rests | Three equal pours, 35s each, with 20s rests |
| Target total time | 3:30 | 4:30 |

These are opinionated starting recipes for medium-roast beans, not manufacturer-certified or universally optimal settings. The Encore suggestions are for the **original Encore, not Encore ESP**. Calibration and beans vary. If a brew drains too slowly or tastes bitter/astringent, try coarser; if it drains too quickly or tastes sour/thin, try finer. Taste matters more than hitting the exact time. With a bag selected, your grinder override is saved for that **bag + recipe**. Without a bag selected, it is saved as a recipe-wide fallback. The order is bag-specific override → saved recipe setting → built-in recipe suggestion. Clear a bag override to return to the fallback; older recipe settings are preserved. These preferences stay in this browser, and an active brew keeps its recorded grinder setting.

Water targets mean **water added**, not beverage yield. Tare once before brewing; don't tare between pours. Pour rates are suggested averages, not measurements. Never overflow the brewer to keep up with the timer: pause the guide if the bed is full. The timer does not auto-finish at the target drawdown time; tap Finish brew when draining is done.

### Japanese Iced V60

Choose **V60 → Japanese Iced**. This recipe keeps its own remembered dose, temperature, and grinder override, separate from hot V60, and is saved/repeated as an iced recipe in the journal.

At the default **15 g coffee**, start at **203°F** and **Encore 13** (two clicks finer than the hot V60 starting suggestion; adjust to taste):

1. Rinse the filter and discard the rinse water. Add **75 g ice** to the carafe, assemble the brewer with grounds, then **tare the scale**.
2. **0:00–0:10:** bloom to **30 g**, about **3 g/s**; rest until **0:30**.
3. **0:30–0:50:** pour to **90 g**, about **3 g/s**; rest until **1:00**.
4. **1:00–1:20:** pour to **150 g**, about **3 g/s**.
5. Let drain, aiming around **2:30**. Finish when drained, swirl to chill, and **top with ice to taste**.

These timings are app starting points, not timings attributed to the original video. Hot water is 10× the bean dose and brewing ice is 5×: **150 g hot water + 75 g ice = 225 g combined**, a nominal 1:15 ratio **before topping ice**, not beverage yield. Only hot-water additions appear in pour targets and the journal's actual-water field. Ice must not be included when reading those targets. Weights round to whole grams; pour durations scale with dose to keep roughly the same flow rate. Bloom ends at 30 seconds, the inter-pour rest stays 10 seconds, and drawdown has a 70-second starting allowance. The temperature remains editable; switching recipes restores that recipe’s own temperature override or default.

Existing saved brews and queued events without a variant remain hot recipes. No database migration is needed for this additive snapshot metadata.

### Hoffmann French Press

Choose **French Press** for James Hoffmann's technique, with attribution and a
link to the original video below the recipe. Start with **30 g coffee, 500 g
water, a medium grind, and freshly boiled water** (212°F at sea level).

- Add the water; leave undisturbed until **4:00** on the brew clock.
- Break the crust and skim. Tap **Done → Continue** when finished.
- Leave undisturbed for **five minutes**, starting from that confirmation.
- Serve gently without plunging; confirm when done, then **Finish brew**.

The pour has a practical 30-second allowance; skim and serve have no artificial
deadline. The guide contains **9:00 of timed steps plus hands-on time**.
Hoffmann suggests five to eight minutes for settling; the recipe explains how
to extend the rest. The clock includes manual work but excludes explicit pauses.
For recipes with manual steps, progress tracks steps rather than a predicted
total duration. Old active timers keep their saved definition and temperature.

## Persistence, backup, and limits

- Bags, photos, the default bag, brew history, recipe snapshots, and results live in Postgres and are shared across devices. Personal recipe input preferences and active timer controls remain browser-local; you cannot take over a running timer on another phone. Refresh/navigate to see another device's changes.
- Automatic brew start/finish/discard events use a persistent browser outbox. If the network drops, keep the browser data: updates retry on reconnect, every 15 seconds, and via **Retry sync**. UUID-based idempotency avoids double records after a lost response. Unsynced events are not yet in the database and clearing browser data loses them.
- Brew timestamps and entered parameters retain the original local values when replayed. If the first save was offline, the coffee-name snapshot is taken when Postgres receives it; edits to the bag made before that first sync may appear in the snapshot. New clients send a recipe version: if that file changed before the first sync, the event stays queued rather than silently saving different instructions. Restore that file revision and restart to sync it. Sync pending brews before editing/removing recipes.
- Bean and result forms require a successful server save; they show errors and preserve form input when a save fails. They are not an offline editing system.
- If another device closes a brew first, a conflicting local status change is retained for review. **Use saved journal version** explicitly keeps the server record and removes the conflicting local event. Other brews can still sync independently.
- Elapsed time uses timestamps rather than counting ticks, so reloads and background tabs catch up correctly. Pauses freeze the guide. Avoid changing the device clock mid-brew.
- Best-effort screen wake lock while running; mobile OS restrictions may still suspend the page. No background audio/notifications or offline service worker. Keep the page visible.
- Use one tab per brew. Web Locks protect outbox writes across tabs where supported, but live timer controls are not coordinated between tabs.
- Deleted brew contents are removed from the database, journal, daily totals, and JSON export. Only the UUID and deletion timestamp remain to prevent delayed offline requests from recreating the entry. Confirmed deletion clears queued updates for that brew on retry; other brews are unaffected. Database backups made before deletion still contain the old record.
- Temperatures are remembered per recipe. On upgrade, a non-default legacy global temperature is retained for the selected recipe only; the old implicit 203°F default yields to recipe defaults. An active brew always retains its temperature.
- Recipe settings are locked during a brew. Discard or finish and choose Make another cup to change them.
- Photos are resized in the browser to at most 1200 pixels and re-encoded as JPEG, removing source metadata. The server accepts JPEG/PNG/WebP signatures with a 2 MB decoded limit and stores bytes in Postgres, so no writable upload volume is required. Phone formats the browser cannot decode (such as some HEIC files) need conversion first.

Back up the dedicated database using your normal Postgres backup process, e.g. `pg_dump --format=custom --file=coffee.dump "$DATABASE_URL"`; this includes photos and migration history. Test restoring to a separate database with `pg_restore`. Protect backups: they contain household consumption data and uploaded photos. The journal's **Export all data** downloads readable JSON metadata/history for portability, but excludes photo bytes and is **not a full backup or automatic import format**.

## Development and checks

```sh
npm ci
npx playwright install chromium webkit
export TEST_DATABASE_URL='postgresql://coffee_test:TEST_PASSWORD@127.0.0.1:5432/coffee_test'
npm run check
```

Use a disposable test database whose role can create schemas. API tests and the browser test server each create and clean up uniquely named schemas; they never truncate the app's tables. You may set a separate `BROWSER_DATABASE_URL` for Playwright. Without `TEST_DATABASE_URL`, `npm test` skips the API suite; a full verification requires the variable and Postgres. Browser tests require one of those test connection variables.

`npm test` covers recipe arithmetic, supported doses, timer state, validation, concurrency/idempotency, immutable snapshots, photo storage, database reconnection/persistence, daily totals, and origin protection. Browser checks exercise desktop Chromium and mobile WebKit: bean creation/photo, defaults/archive, automatic recording, ratings/shared servings, journal replay, lost responses, reload recovery, conflicts, and narrow layouts.

Structure: `public/recipe.js` owns recipe generation; `public/timer.js` owns clock transitions; `public/app.js` integrates brewing; `public/service.js` owns the bean shelf/journal; `public/sync.js` handles queued brew events. `server.js` serves fixed assets and the JSON API, `server/api.js` owns transactional operations, `server/validation.js` validates inputs, and `server/db.js` applies `migrations/*.sql`. No external services beyond your Postgres server are needed.
