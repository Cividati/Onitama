# Onitama Online

Play [Onitama](https://en.wikipedia.org/wiki/Onitama) in the browser, with a lichess-style interface.

- **Quick pairing** at eleven time controls from 1+0 bullet to 30+20 classical: click a time control and you are matched with the next player who picks the same one.
- **Play with a friend**: create a game (untimed or timed) and send the invite link.
- **Play with the computer**: easy, medium or hard bot, untimed or timed. Bot games are never rated.
- **Tournaments** (needs accounts): anyone signed in can schedule an arena. While it runs, the players on the tournament page are paired again and again; a win scores 2 points, a draw 1. Tournament games are rated. The creator can delete their tournament, and profiles list each player's tournaments and total points.
- **In the game**: clocks, chat, draw offers, takeback requests, resign and rematch.
- **Replay**: step through the moves with the buttons under the clock, the arrow keys, or by clicking the move list. A finished game has an "Analysis board" link that encodes the whole game in the URL.
- **Spectate** any running game from the lobby's live list.
- **Accounts** (optional): sign up with a username, email and password, or with Google. When the server can send email, the address has to be confirmed before the account can be used. Quick-pairing games between two signed-in players are rated (Elo, starting at 1500); every finished game of a signed-in player is kept in their match history and can be replayed.
- **Menu** (top right): profile and sign out, plus preferences kept in the browser — the sound of the pieces and of a game starting or ending (a dozen themes, or none, and the volume), a dark or light theme, board colours and piece sets. It also shows the ping to the server.

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
| `DONATE_URL` | An `https://` link (Ko-fi, GitHub Sponsors, PayPal…) for the button on the Donate page. Without it the page says donations are not open yet. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enable "Continue with Google". The OAuth client's redirect URI must be `https://YOUR-DOMAIN/auth/google/callback`. |
| `RESEND_API_KEY`, `MAIL_FROM` | Turn on outgoing email through [Resend](https://resend.com). `MAIL_FROM` is the sender, e.g. `Onitama <noreply@onitama.example>`, on a domain verified at Resend. A placeholder that does not start with `re_` counts as not set. With both set, a new password account must confirm its email address before it can sign in, and "Forgot your password?" emails a link to choose a new one. Without them an email is still asked for, but nothing is sent, accounts work straight away and passwords cannot be recovered. |
| `MAIL_TO_CONSOLE` | Set to `1` to print emails to the server log instead of sending them (for development). |
| `PUBLIC_URL` | Public origin (e.g. `https://onitama.example`). Used in emailed links and the Google redirect; set it whenever email is on, otherwise it is derived from the request. |

## Deploy

Any host that runs `npm start` and provides `PORT` works. With Railway:

```sh
railway up
```

The Railway project has two environments, each with its own database:

| Environment | Deploys from | When |
| --- | --- | --- |
| development — https://onitama-development.up.railway.app | `main` | every push to `main` |
| production — https://onitama.org | `production` | every published GitHub release |

Publishing a release (`gh release create v1.2.3 --generate-notes`) runs `.github/workflows/release.yml`, which moves the `production` branch to the released commit; Railway then deploys it. Don't push to `production` by hand.

Run a single instance: games in progress are kept in memory, so they are lost on restart and can't be shared across replicas. Accounts, finished games and tournament scores live in Postgres; a restart during a tournament drops the games being played, and the players are paired again when they return to the tournament page.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, make a change and get it released, and [VOCABULARY.md](VOCABULARY.md) for the terms used in the code and the UI.

## Layout

- `public/game.js` — rules engine, shared by server and browser
- `server.js` — HTTP server: rooms, pairing, clocks, move validation, Server-Sent Events for live updates
- `lib/` — accounts and sessions, Elo ratings, tournaments, the bot's search, Postgres schema
- `public/client.js`, `index.html`, `style.css` — the UI

## License

[MIT](LICENSE). Onitama is a board game by Shimpei Sato, published by Arcane Wonders; this is an unofficial fan project.
