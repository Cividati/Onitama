# Contributing

Thanks for wanting to help with Onitama Online. This page covers how to get the project running, what a change should look like, and how it reaches the live site. The words used in the code and the UI are explained in [VOCABULARY.md](VOCABULARY.md).

## Getting started

You need Node 18 or newer.

```sh
git clone https://github.com/Cividati/Onitama.git
cd Onitama
npm install
npm start        # http://localhost:3000
npm test
```

With no configuration the game runs with accounts switched off: you can play a friend, the computer, or use quick pairing in two browser windows. Tournaments, ratings, profiles and match history need a database.

### Running with accounts

Start a throwaway Postgres and point the server at it. The tables are created on start.

```sh
docker run -d --rm --name onitama-pg -e POSTGRES_PASSWORD=dev -p 127.0.0.1:55432:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:dev@127.0.0.1:55432/postgres npm start
```

Add `MAIL_TO_CONSOLE=1` to try email confirmation and password recovery: the links are printed in the server log instead of being sent.

The other settings (`DONATE_URL`, email, Google sign-in, `PUBLIC_URL`) are listed in the [README](README.md#configuration).

## Where things are

| Path | What it holds |
| --- | --- |
| `public/game.js` | The rules engine. Shared by the server (which decides what is legal) and the browser (which highlights moves). No dependencies, no DOM. |
| `server.js` | HTTP server: rooms, quick pairing, clocks, move validation, bot turns, Server-Sent Events. |
| `lib/accounts.js` | Sign-up, sign-in, sessions, profiles, match history, `/api/me`. |
| `lib/tournaments.js` | Arena tournaments: scheduling, pairing, standings. |
| `lib/bot.js` | The computer opponent's search. |
| `lib/rating.js`, `lib/db.js`, `lib/http.js` | Elo, the Postgres schema, small HTTP helpers. |
| `public/client.js`, `index.html`, `style.css` | The whole UI: one page, one script, one stylesheet. |
| `test/` | Tests for the rules engine and the bot (`node --test`). |

## Ground rules

- **Keep it dependency-light.** The only dependency is the Postgres client. There is no framework, bundler or build step; the browser loads the files in `public/` as they are. Please don't add one without discussing it in an issue first.
- **The server is the authority.** Every move is validated on the server with `public/game.js`. The client may only use the engine to show what is possible.
- **Rule changes need tests.** Anything that touches `public/game.js` or `lib/bot.js` should come with a test in `test/`.
- **Match the surrounding code.** Plain modern JavaScript, two-space indentation, single quotes, semicolons. Comments explain why something is the way it is, not what the line does.
- **Colours come from CSS variables.** The dark and light themes and the board colours are all variables in `style.css`; don't hard-code a colour in a rule.
- **Check the phone layout.** Under 980px wide the game switches to a single-column layout where both hands, the spare card, both clocks and the board must fit on one screen. If you change the game screen, look at it at about 390×844 and sideways.
- **Never commit credentials.** Connection strings, OAuth secrets and tokens belong in environment variables.

## Making a change

1. For anything larger than a small fix, open an issue first so the approach can be agreed.
2. Fork the repository and create a branch from `main`.
3. Make the change, run `npm test`, and try it in the browser. For UI changes, try it with accounts on and off.
4. Write the commit subject as a short sentence saying what the change does, for example `Fit a whole game on one phone screen`. Use the body for the reason, if it isn't obvious.
5. Open a pull request against `main`. Say what you changed, how you checked it, and add a screenshot for anything visual.

## How changes go live

| Environment | Address | Updated by |
| --- | --- | --- |
| development | https://onitama-development.up.railway.app | every push to `main` |
| production | https://onitama.org | every published GitHub release |

A merged pull request appears on development within a few minutes. Production moves only when a maintainer publishes a release; the release workflow points the `production` branch at the released commit and Railway deploys it. Never push to `production` by hand.

The two environments have separate databases, so accounts created on development do not exist on production.

The version in the home page footer comes from `package.json`. Maintainers bump it in the commit that is going to be released.

## Reporting a bug

Open an issue with what you did, what you expected and what happened. The version from the home page footer, the browser, and the game link (for a finished game, the "Analysis board" link holds the whole game) make a bug much easier to reproduce.

## A note on the name

Onitama is a board game designed by Shimpei Sato and published by Arcane Wonders. This project is an unofficial fan implementation and is not affiliated with them. Please don't add artwork or text taken from the published game.
