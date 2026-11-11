# Vocabulary

The words used in the code, the API and the UI. When a word has a specific name in the code it is shown `like this`.

## The game

| Term | Meaning |
| --- | --- |
| Board | Five by five squares. In the code it is a flat array of 25 entries, index `y * 5 + x`. Row `y = 0` is Blue's home row and `y = 4` is Red's. |
| Red, Blue | The two sides (`'red'`, `'blue'`). Red sits at the bottom of the board as stored; each player sees their own side at the bottom. |
| Master | The one special piece of each side (`m: true`). Losing it loses the game. |
| Student | Any of the four other pieces of a side (`m: false`). |
| Temple | The middle square of a side's home row (`TEMPLE`). Moving your master onto the opponent's temple wins. |
| Card | One of the sixteen movement cards (`CARDS`). A card lists the squares a piece may move to, as `[dx, dy]` seen from the player holding it: `+dx` is to their right, `+dy` is towards the opponent. |
| Hand | The two cards a player holds (`hands.red`, `hands.blue`). |
| Spare | The fifth card, lying beside the board (`spare`). After you play a card it becomes the spare, and you take the previous spare. |
| Stamp | The colour printed on a card (`stamp`). The stamp of the first spare card decides who moves first. |
| Deal | The five cards a game is played with. A friend game can choose them; otherwise they are drawn from all sixteen. |
| Move | Playing a card to take a piece from one square to another: `{ card, from, to }`. |
| Capture | Moving onto a square held by an opposing piece, which removes it. |
| Pass | When a player has no legal move they must still give one card up for the spare (`applyPass`). Passing is not allowed otherwise. |
| Ply | One turn by one player, a move or a pass. `history` holds every ply in order and `replay(game, ply)` rebuilds the position after that many. |
| Way of the Stone | Winning by capturing the opposing master (`winReason: 'stone'`). |
| Way of the Stream | Winning by reaching the opposing temple with your master (`winReason: 'stream'`). |
| Other endings | `'resign'`, `'time'` (the clock ran out) and `'agreement'` (a draw both players accepted). |
| Initial | The starting deal of a game (`initial`). It is never changed, so any earlier position can be rebuilt from it. |

## Playing online

| Term | Meaning |
| --- | --- |
| Lobby | The home page: quick pairing, live games, Onitama TV, the leaderboard. |
| Room | One game on the server (`rooms`). Rooms live in memory only and are dropped after twelve hours or on a restart. |
| Code | The short identifier of a room, which is also its address (`/ABCDEF`). The alphabet leaves out look-alike characters such as 0/O and 1/I/L. |
| Seat | A place at the board, red or blue. A seat is held by a token, by a signed-in user, or by a bot. |
| Token | The secret that proves a browser holds a seat in a room. It is kept in that browser and sent with every action. |
| Spectator | Someone watching a room without a seat. They see the game and the chat but cannot act. |
| Time control (`tc`) | Minutes on the clock plus seconds added after each move, written `5+3`. The list is `TIME_CONTROLS`; a game without one is untimed. |
| Increment | The seconds added to your clock after each of your moves. |
| Flag | To lose on time (`flag`). |
| Quick pairing | Clicking a time control in the lobby. You wait in a pool and are matched with the next player who picks the same one. |
| Seek, seeker | A player waiting in a quick-pairing pool (`seekers`, `/api/seek`). |
| Friend game | A game created with "Play with a friend", joined through its invite link. Never rated. |
| Bot | The computer opponent (`lib/bot.js`), at level easy, medium or hard. Bot games are never rated. |
| Offer | A request the opponent must answer: a draw or a takeback. |
| Takeback | Undoing your last move with the opponent's agreement. |
| Rematch | A new game in the same room after one has ended, with a fresh deal and the same seats. Either player can start it; tournament games have none. |
| Snapshot | The full state of a room or tournament as sent to one viewer (`snapshot`). Clients never receive partial updates. |
| Events, SSE | Server-Sent Events: the one-way stream a browser keeps open to receive snapshots. Actions go the other way as ordinary POST requests. |
| Presence | Whether each seated player currently has the game open. |
| Onitama TV | The small board in the lobby showing one live game. |
| Analysis board | A replay of a game that encodes all of it in the URL, so it can be shared without an account. |

## Accounts and ratings

| Term | Meaning |
| --- | --- |
| Accounts on / off | Whether the server has a database (`DATABASE_URL`). With accounts off there are no sign-ins, ratings, profiles or tournaments, and the UI hides them. |
| Session | A signed-in browser, identified by the `sid` cookie. |
| Rating | An Elo number starting at 1500 (`lib/rating.js`). |
| Provisional | A rating shown with a `?` until the player has ten rated games. |
| Rated game | A game that changes ratings: quick-pairing games between two signed-in players, and tournament games. |
| Match history | The finished games of a signed-in player, kept in the database and replayable from their profile. |
| Leaderboard | The highest-rated players, shown in the lobby. |

## Tournaments

| Term | Meaning |
| --- | --- |
| Arena | The only tournament format. For a fixed duration, players who are on the tournament page are paired again and again. |
| Points | A win scores 2, a draw 1, a loss 0 (`POINTS`). |
| Standings | The players of a tournament ordered by points. |
| Tick | The check that runs every few seconds to start and finish tournaments and pair waiting players (`tick`). |
| Withdraw | To stop being paired without leaving the standings. |
| First-move time | A tournament game is lost by a player who does not make their first move within thirty seconds. |

## Project and deployment

| Term | Meaning |
| --- | --- |
| Development | The test site, https://onitama-development.up.railway.app. It follows the `main` branch and has its own database. |
| Production | The real site, https://onitama.org. It follows the `production` branch. |
| Release | A published GitHub release. Publishing one moves `production` to that commit, which is the only way production is updated. |
| Version | The number in the home page footer: the `package.json` version, plus the deployed commit. |
| Theme | Dark or light colours, chosen in the menu. Board colours, piece sets and sound themes are separate preferences. All are kept in the browser, not in the account. |
