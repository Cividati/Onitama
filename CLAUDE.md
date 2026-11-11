# Onitama Online

A lichess-style site for playing Onitama in the browser. Node `http` server, vanilla JS client, optional Postgres. Live at https://onitama.org.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor workflow and [VOCABULARY.md](VOCABULARY.md) for the terms used in the code (room, seat, spare, seek, ply…). Use those terms.

## Commands

```sh
npm start                 # http://localhost:3000, accounts off
PORT=3977 npm start       # another port
npm test                  # node --test: rules engine and bot
```

With accounts (tournaments, ratings, profiles):

```sh
docker run -d --rm --name onitama-test-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres PORT=3977 node server.js
```

## Architecture

- `public/game.js` — rules engine, UMD, shared by server and browser. Pure: no DOM, no dependencies. The board is a flat array, index `y * 5 + x`; `y = 0` is Blue's home row.
- `server.js` — rooms (in memory), quick pairing, clocks, move validation, bot turns, SSE. Delegates `/api/me`, auth and profiles to `lib/accounts.js` and tournaments to `lib/tournaments.js`.
- `lib/db.js` — Postgres schema, created on start. `db.enabled` is false without `DATABASE_URL`, and every account feature must keep working as "off" in that case.
- `public/client.js` — the whole UI in one IIFE. `index.html` holds one `<main>` per page; `style.css` holds every style.

Things that are easy to get wrong:

- **The server is authoritative.** Validate every action in `server.js` with the engine; never trust the client.
- **Snapshots, not deltas.** A room or tournament change calls `broadcast`, which sends each viewer a full `snapshot`. Actions come in as POST requests; updates go out over SSE.
- **Client navigation is in place.** Lobby, tournaments, profile and donate pages switch without a page load (`navigate`, `showPage`, `leavePage`). Timers for a page must be started with `every(fn, ms)` so `leavePage` clears them. Opening or leaving a game is a full page load.
- **Bind once.** Event listeners are attached once in `boot()` through the `bind…` functions; the `show…` functions only fill in data.
- **`/api/me` is cached** in `localStorage` (`onitama:me`) so the top bar renders before the request returns. A new field on `/api/me` goes through `applyMe`.
- **Single instance.** Games in progress are in memory; a restart loses them.

## Conventions

- No new dependencies, frameworks or build steps. The only dependency is `pg`.
- Two-space indentation, single quotes, semicolons. Comments say why, not what.
- Colours are CSS variables, so the dark and light themes and board colours keep working.
- The top bar is 1400px wide on every page; don't make its width depend on the page.
- Under 980px the game screen must show both hands, the spare, both clocks and the board on one screen, in portrait and landscape. Board size comes from `--cell` in CSS and `maxCell()` in the client; change them together.
- Engine or bot changes need a test in `test/`.
- Commit subjects are a short sentence describing the change (`Show the version in the lobby footer`).

## Deployment

| Environment | Address | Deploys from |
| --- | --- | --- |
| development | https://onitama-development.up.railway.app | `main`, on every push |
| production | https://onitama.org | `production`, moved by publishing a GitHub release |

- Hosting is Railway; the domain and DNS are at Cloudflare (proxied).
- `.github/workflows/release.yml` moves the `production` branch to the released commit. Never push to `production` directly.
- Publishing a release is the maintainer's decision. Don't create one unless asked.
- The footer version is `package.json`'s version plus the deployed commit; bump `package.json` in the commit that will be released.
- The two environments have separate databases and separate variables (`DATABASE_URL`, `DONATE_URL`, Google sign-in, `PUBLIC_URL`).

## Security

- Never commit or print credentials: connection strings, OAuth secrets, Railway or GitHub tokens. They live in Railway variables.
- Links taken from configuration are only passed to the client if they are `https://`.

## Verifying UI changes

Run the server locally and look at the change in a browser, with accounts on and off, at desktop width and at about 390×844. `npm test` does not cover the client.
