# Onitama Online

Play [Onitama](https://en.wikipedia.org/wiki/Onitama) in the browser, with a lichess-style interface.

- **Quick pairing** at 3+2, 5+0 or 10+0: click a time control and you are matched with the next player who picks the same one.
- **Play with a friend**: create a game (untimed or timed) and send the invite link.
- **In the game**: clocks, chat, draw offers, takeback requests, resign and rematch.
- **Replay**: step through the moves with the buttons under the clock, the arrow keys, or by clicking the move list. A finished game has an "Analysis board" link that encodes the whole game in the URL.
- **Spectate** any running game from the lobby's live list.
- **Accounts** (optional): sign up with a username and password or with Google. Quick-pairing games between two signed-in players are rated (Elo, starting at 1500); every finished game of a signed-in player is kept in their match history and can be replayed.
- **Sound**: a chime when an opponent is found and when the game ends.

## Run

```sh
npm start        # http://localhost:3000 (set PORT to change)
npm test         # rules engine tests
```

Needs Node 18+ and `npm install` (the only dependency is the Postgres client).

## Configuration

All optional — with none of these set the game runs with accounts switched off.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DATABASE_URL` | Postgres connection string; enables accounts, ratings and match history. Tables are created on start. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enable "Continue with Google". The OAuth client's redirect URI must be `https://YOUR-DOMAIN/auth/google/callback`. |
| `PUBLIC_URL` | Public origin (e.g. `https://onitama.example`) if it cannot be derived from the request |

## Deploy

Any host that runs `npm start` and provides `PORT` works. With Railway:

```sh
railway up
```

Merging a pull request into `main` deploys automatically: `.github/workflows/deploy.yml` runs the tests and then `railway up`. It needs a Railway project token saved as the `RAILWAY_TOKEN` repository secret.

Run a single instance: games in progress are kept in memory, so they are lost on restart and can't be shared across replicas. Accounts and finished games live in Postgres.

## Layout

- `public/game.js` — rules engine, shared by server and browser
- `server.js` — HTTP server: rooms, pairing, clocks, move validation, Server-Sent Events for live updates
- `lib/` — accounts and sessions, Elo ratings, Postgres schema
- `public/client.js`, `index.html`, `style.css` — the UI
