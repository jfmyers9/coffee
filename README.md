# Morning Coffee

A mobile-first, prescriptive coffee helper for V60 and Chemex, with Baratza Encore starting settings. Choose a bean weight, prep your brewer, and follow timed pours with **cumulative scale targets** and grams-per-second guidance.

## Run locally

Requires Node.js 22 or newer. No runtime dependencies or build step.

```sh
npm start
# http://127.0.0.1:8080
```

## Docker + Tailscale

On a Docker host already connected to your tailnet:

```sh
docker compose pull
docker compose up -d
curl http://127.0.0.1:8080/health
tailscale serve --bg http://127.0.0.1:8080
```

Open the HTTPS address printed by Tailscale Serve from your phone with Tailscale connected. Serve may prompt you to enable HTTPS for your tailnet. If Serve already hosts other apps, integrate this upstream into your existing routing rather than replacing it. This app expects to be hosted at the root of its own origin, not a URL subpath.

Compose binds only to localhost; Tailscale Serve provides tailnet-only HTTPS. **Do not use Tailscale Funnel** (public access). There is no app authentication: restrict access using your tailnet ACLs/grants. Nothing here installs or configures Tailscale automatically. HTTPS also enables screen wake lock on supported mobile browsers. The app has no third-party fonts, analytics, APIs, or network dependencies at runtime.

### Image publishing

[GitHub Actions](https://github.com/jfmyers9/coffee/actions) runs unit and browser tests, builds the container, smoke-tests it as a non-root user with a read-only filesystem, then publishes **`ghcr.io/jfmyers9/coffee`** for `linux/amd64` and `linux/arm64` with provenance and an SBOM.

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

## The first recipes

| | V60 02 | Chemex 6–8 cup |
| --- | --- | --- |
| Default coffee | 20 g | 30 g |
| Supported dose | 12–30 g | 20–45 g |
| Water | 16 × coffee weight | 16 × coffee weight |
| Original Encore starting dial | 15 | 20 |
| Temperature | 94–96°C | 94–96°C |
| Bloom | 3 × coffee weight, pour for 15s; rest until 0:45 | Same |
| Remaining water | Three equal pours, 25s each, with 20s rests | Three equal pours, 35s each, with 20s rests |
| Target total time | 3:30 | 4:30 |

These are opinionated starting recipes for medium-roast beans, not manufacturer-certified or universally optimal settings. The Encore suggestions are for the **original Encore, not Encore ESP**. Calibration and beans vary. If a brew drains too slowly or tastes bitter/astringent, try coarser; if it drains too quickly or tastes sour/thin, try finer. Taste matters more than hitting the exact time. Save your preferred grinder setting separately for each brewer.

Water targets mean **water added**, not beverage yield. Tare once before brewing; don't tare between pours. Pour rates are suggested averages, not measurements. Never overflow the brewer to keep up with the timer: pause the guide if the bed is full. The timer does not auto-finish at the target drawdown time; tap Finish brew when draining is done.

## State and limitations

- Preferences and the current brew are saved in this browser's local storage, not on the server; no cross-device sync or history yet.
- Elapsed time uses timestamps rather than counting ticks, so reloads and background tabs catch up correctly. Pauses freeze the guide. Avoid changing the device clock mid-brew.
- Best-effort screen wake lock while running; mobile OS restrictions may still suspend the page. No background audio/notifications or offline service worker. Keep the page visible.
- Use one tab per brew. Multiple tabs don't coordinate their timers.
- Recipe settings are locked during a brew. Discard or finish and choose Make another cup to change them.

## Development and checks

```sh
npm ci
npx playwright install chromium webkit
npm run check
```

`npm test` covers recipe arithmetic, every supported dose, phase boundaries, and timer state. `npm run test:e2e` exercises desktop Chromium and mobile WebKit, persistence, validation, pause/resume, reload recovery, completion, narrow layouts, and server routes.

Structure: `public/recipe.js` owns recipe generation; `public/timer.js` owns clock transitions; `public/app.js` connects them to the DOM; `public/storage.js` handles persistence. `server.js` serves a fixed set of static assets and a health endpoint. Future recipe customization can grow from the recipe module without adding a backend prematurely.
