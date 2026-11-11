// Onitama online: a dependency-free Node server.
// State lives in memory; clients get updates over Server-Sent Events and send
// moves with plain POSTs, so it works behind any HTTP proxy or tunnel.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Onitama = require('./public/game.js');
const db = require('./lib/db');
const accounts = require('./lib/accounts');
const bot = require('./lib/bot');
const tournaments = require('./lib/tournaments');
const { json, readJson, sseHeaders, clientIp } = require('./lib/http');

const { other } = Onitama;
const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = 2000;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const VISITOR_TTL_MS = 15 * 1000; // a lobby visitor counts as online this long after a poll
const CHAT_KEEP = 100;
const CHAT_MAX_LENGTH = 200;
const NAME = { red: 'Red', blue: 'Blue' };
const BOT_DELAY_MS = 700; // pause before a bot answers, so its moves can be followed
const FIRST_MOVE_MS = 30 * 1000; // time to make the first move of a tournament game

// Seconds on the clock at the start, and seconds added after each move.
const TIME_CONTROLS = {
  '1+0': { initial: 60, increment: 0 },
  '2+1': { initial: 120, increment: 1 },
  '3+0': { initial: 180, increment: 0 },
  '3+2': { initial: 180, increment: 2 },
  '5+0': { initial: 300, increment: 0 },
  '5+3': { initial: 300, increment: 3 },
  '10+0': { initial: 600, increment: 0 },
  '10+5': { initial: 600, increment: 5 },
  '15+10': { initial: 900, increment: 10 },
  '30+0': { initial: 1800, increment: 0 },
  '30+20': { initial: 1800, increment: 20 },
};

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
  '/game.js': ['game.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.svg', 'image/svg+xml'],
};

// code -> room (see createRoom)
const rooms = new Map();
// time control -> { res, user } of the one player waiting to be paired
const seekers = new Map();
// address and browser of a lobby visitor -> when they last polled
const visitors = new Map();

function newCode() {
  for (;;) {
    let code = '';
    for (const byte of crypto.randomBytes(5)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
}

const newToken = () => crypto.randomBytes(16).toString('hex');

// `cards` is null for a random deal, or the five card names the creator chose.
function createRoom(tc, cards) {
  const code = newCode();
  const room = {
    code,
    game: Onitama.newGame(null, cards),
    cards,
    tc: TIME_CONTROLS[tc] ? tc : null,
    clock: null,
    quick: false, // made by quick pairing: the clock runs from the start
    rated: false,
    tokens: { red: null, blue: null },
    users: { red: null, blue: null }, // signed-in account in each seat, if any
    bot: null, // { color, level } when the computer plays one side
    botTimer: null,
    tournament: null, // { id, name } for a tournament game
    result: null, // { gameId, diffs } once a finished game has been stored
    clients: new Set(),
    chat: [],
    offers: { draw: null, takeback: null }, // colour that made the offer
    touched: Date.now(),
  };
  room.clock = newClock(room.tc);
  rooms.set(code, room);
  return { code, room };
}

function seatOf(room, token) {
  if (typeof token !== 'string' || !token) return null;
  if (room.tokens.red === token) return 'red';
  if (room.tokens.blue === token) return 'blue';
  return null;
}

// ---------- clocks ----------
// A clock only runs for the player to move, and starts after the first move.

function newClock(tc) {
  const control = TIME_CONTROLS[tc];
  if (!control) return null;
  const ms = control.initial * 1000;
  return { increment: control.increment * 1000, remaining: { red: ms, blue: ms }, running: null, since: 0, timer: null };
}

function timeLeft(clock, color) {
  if (clock.running !== color) return clock.remaining[color];
  return Math.max(0, clock.remaining[color] - (Date.now() - clock.since));
}

function stopClock(room) {
  const clock = room.clock;
  if (!clock) return;
  if (clock.running) clock.remaining[clock.running] = timeLeft(clock, clock.running);
  clock.running = null;
  clearTimeout(clock.timer);
}

function startClock(room) {
  const clock = room.clock;
  if (!clock) return;
  stopClock(room);
  clock.running = room.game.turn;
  clock.since = Date.now();
  let ms = clock.remaining[clock.running];
  // In a tournament a player who does not show up loses quickly instead of holding up their opponent.
  if (room.tournament && room.game.history.length < 2) ms = Math.min(ms, FIRST_MOVE_MS);
  clock.timer = setTimeout(() => flag(room), ms + 10);
  clock.timer.unref();
}

function flag(room) {
  const clock = room.clock;
  if (room.game.winner || !clock || !clock.running) return;
  const loser = clock.running;
  stopClock(room);
  clock.remaining[loser] = 0;
  finish(room, other(loser), 'time');
  say(room, 'system', `${seatName(room, loser)} ran out of time`);
  broadcast(room);
}

// Settles the clock and clears offers after anything that changes the game;
// with a `winner` it also ends the game.
function finish(room, winner, reason) {
  if (winner) {
    room.game.winner = winner;
    room.game.winReason = reason;
  }
  stopClock(room);
  room.offers = { draw: null, takeback: null };
  if (room.game.winner) recordGame(room);
}

const recorded = new WeakSet(); // games already handed to recordGame

const isAccount = (user) => !!user && !user.bot;

// Stores a finished game for signed-in players and applies rating changes.
// Games that end before both sides have moved count as aborted, except for
// the tournament score.
function recordGame(room) {
  const game = room.game;
  if (!accounts.enabled || recorded.has(game)) return;
  recorded.add(game);
  const tournament = room.tournament;
  if (tournament) {
    tournaments.gameFinished(tournament.id, room.code, { red: room.users.red.id, blue: room.users.blue.id }, game.winner);
  }
  if (game.history.length < 2 || (!isAccount(room.users.red) && !isAccount(room.users.blue))) return;
  accounts
    .saveGame({
      tc: room.tc,
      rated: room.rated,
      tournament: tournament ? tournament.id : null,
      users: room.users,
      winner: game.winner,
      reason: game.winReason,
      initial: game.initial,
      moves: game.history.map((m) => [m.card, m.from, m.to]),
    })
    .then((saved) => {
      for (const color of ['red', 'blue']) {
        if (!isAccount(room.users[color])) continue;
        room.users[color] = { ...room.users[color], rating: saved.ratings[color] };
        if (tournament) tournaments.setRating(tournament.id, room.users[color].id, saved.ratings[color]);
      }
      if (room.game !== game) return; // a rematch already started
      room.result = { gameId: saved.id, diffs: saved.diffs };
      broadcast(room);
    })
    .catch((err) => console.error('Could not save game', err));
}

// ---------- pushing state to clients ----------

function presence(room) {
  const online = { red: false, blue: false };
  if (room.bot) online[room.bot.color] = true;
  let spectators = 0;
  for (const client of room.clients) {
    if (client.color) online[client.color] = true;
    else spectators++;
  }
  return { online, spectators };
}

function snapshot(room, color) {
  const clock = room.clock;
  return {
    game: room.game,
    seated: { red: !!room.tokens.red, blue: !!room.tokens.blue },
    ...presence(room),
    you: color,
    players: room.users,
    rated: room.rated,
    tournament: room.tournament,
    result: room.result,
    tc: room.tc,
    clock: clock && {
      remaining: { red: timeLeft(clock, 'red'), blue: timeLeft(clock, 'blue') },
      running: clock.running,
    },
    offers: room.offers,
  };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const client of room.clients) {
    client.res.write(`data: ${JSON.stringify(snapshot(room, client.color))}\n\n`);
  }
  scheduleBot(room);
}

// Account name of the player in a seat, or the seat colour for anonymous players.
const seatName = (room, color) => (room.users[color] ? room.users[color].name : NAME[color]);

// `from` is 'red', 'blue' or 'system'.
function say(room, from, text) {
  const message = { from, text };
  room.chat.push(message);
  if (room.chat.length > CHAT_KEEP) room.chat.shift();
  const payload = `event: chat\ndata: ${JSON.stringify({ messages: [message] })}\n\n`;
  for (const client of room.clients) client.res.write(payload);
}

function openEvents(req, res, room, token) {
  const client = { res, color: seatOf(room, token) };
  sseHeaders(res);
  res.write('retry: 2000\n\n');
  res.write(`event: chat\ndata: ${JSON.stringify({ reset: true, messages: room.chat })}\n\n`);
  room.clients.add(client);
  broadcast(room);
  req.on('close', () => {
    room.clients.delete(client);
    broadcast(room);
  });
}

// People on the site right now: whoever polled the lobby lately, plus everyone
// connected to a room.
function onlineCount(req) {
  const now = Date.now();
  visitors.set(`${clientIp(req)} ${req.headers['user-agent']}`, now);
  let count = 0;
  for (const [key, seen] of visitors) {
    if (now - seen > VISITOR_TTL_MS) visitors.delete(key);
    else count++;
  }
  for (const room of rooms.values()) count += room.clients.size;
  return count;
}

// Games in progress that the lobby offers for spectating: both seats taken,
// not finished, and at least one player still connected.
function liveGames() {
  const games = [];
  for (const [code, room] of rooms) {
    if (!room.tokens.red || !room.tokens.blue || room.game.winner) continue;
    const { spectators } = presence(room);
    if (spectators === room.clients.size) continue;
    games.push({
      room: code,
      players: room.users,
      rated: room.rated,
      tc: room.tc,
      moveCount: room.game.moveCount,
      turn: room.game.turn,
      board: room.game.board,
      last: room.game.last && { from: room.game.last.from, to: room.game.last.to },
      clock: room.clock && {
        remaining: { red: timeLeft(room.clock, 'red'), blue: timeLeft(room.clock, 'blue') },
        running: room.clock.running,
      },
      spectators,
      touched: room.touched,
    });
  }
  return games.sort((a, b) => b.touched - a.touched);
}

// ---------- quick pairing ----------
// The connection stays open until a second player asks for the same time
// control; both are then told which room to go to and which seat is theirs.

async function openSeek(req, res, tc) {
  if (!TIME_CONTROLS[tc]) return json(res, 400, { error: 'Unknown time control' });
  const user = await accounts.userFromRequest(req);
  sseHeaders(res);
  res.write('retry: 2000\n\n');
  let waiting = seekers.get(tc);
  // The same account seeking twice (two tabs) replaces its earlier request.
  if (waiting && user && waiting.user && waiting.user.id === user.id) {
    waiting.res.end();
    waiting = null;
  }
  if (!waiting || waiting.res.destroyed) {
    const seeker = { res, user };
    seekers.set(tc, seeker);
    req.on('close', () => {
      if (seekers.get(tc) === seeker) seekers.delete(tc);
    });
    return;
  }
  seekers.delete(tc);
  const paired = startPairedGame(tc, waiting.user, user, null);
  if (!paired) {
    res.end();
    waiting.res.end();
    return;
  }
  waiting.res.end(`data: ${JSON.stringify({ room: paired.code, token: paired.tokens[0] })}\n\n`);
  res.end(`data: ${JSON.stringify({ room: paired.code, token: paired.tokens[1] })}\n\n`);
}

// Seats two players in a new room with the clock already running. Returns
// { code, tokens: [first player's, second player's] }, or null when the server is full.
function startPairedGame(tc, userA, userB, tournament) {
  if (rooms.size >= MAX_ROOMS) return null;
  const { code, room } = createRoom(tc, null);
  const [first, second] = Math.random() < 0.5 ? ['red', 'blue'] : ['blue', 'red'];
  room.tokens = { red: newToken(), blue: newToken() };
  room.users[first] = userA;
  room.users[second] = userB;
  room.quick = true;
  room.rated = accounts.enabled && !!userA && !!userB; // rated when both are signed in
  room.tournament = tournament;
  if (tournament) say(room, 'system', `Tournament game: make your first move within ${FIRST_MOVE_MS / 1000} seconds`);
  startClock(room);
  return { code, tokens: [room.tokens[first], room.tokens[second]] };
}

// ---------- playing against the computer ----------
// Bot games are never rated: only quick pairing and tournaments set `rated`.

function seatBot(room, level) {
  const color = Math.random() < 0.5 ? 'red' : 'blue';
  room.bot = { color, level };
  room.tokens[color] = newToken();
  room.users[color] = { id: null, name: bot.LEVELS[level].label, rating: null, bot: true };
}

const botToMove = (room) =>
  !!room.bot && !room.game.winner && room.game.turn === room.bot.color && !!room.tokens.red && !!room.tokens.blue;

function scheduleBot(room) {
  if (room.botTimer || !botToMove(room)) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!botToMove(room)) return; // e.g. the move was taken back meanwhile
    const move = bot.chooseMove(room.game, room.bot.level);
    const error = move.from === null ? Onitama.applyPass(room.game, move.card) : Onitama.applyMove(room.game, move);
    if (error) return console.error('Bot move rejected:', error);
    afterMove(room, room.bot.color);
    broadcast(room);
  }, BOT_DELAY_MS);
  room.botTimer.unref();
}

// Clock and offers once `color` has moved or passed.
function afterMove(room, color) {
  // Moving implicitly turns down any pending offer.
  finish(room, null);
  if (room.clock) room.clock.remaining[color] += room.clock.increment;
  if (!room.game.winner) startClock(room);
}

// ---------- draw offers and takebacks ----------

// How many moves remain after `color` takes back their last move, or -1 if
// they have none: undo one move if the opponent is to play, two otherwise.
function takebackPly(game, color) {
  return game.history.length - (game.turn === color ? 2 : 1);
}

// Returns null on success or an error string.
function handleOffer(room, color, kind, answer) {
  const theirs = room.offers[kind] === other(color);
  const label = kind === 'draw' ? 'Draw offer' : 'Takeback request';

  if (answer === 'decline') {
    if (!theirs) return 'There is nothing to decline';
    room.offers[kind] = null;
    say(room, 'system', `${label} declined`);
    return null;
  }
  if (answer === 'accept' && !theirs) return 'There is nothing to accept';

  if (theirs) {
    if (kind === 'draw') {
      finish(room, 'draw', 'agreement');
      say(room, 'system', 'Draw agreed');
    } else {
      room.game = Onitama.replay(room.game, takebackPly(room.game, other(color)));
      finish(room, null);
      if (room.game.history.length || room.quick) startClock(room);
      say(room, 'system', 'Takeback accepted');
    }
    return null;
  }

  if (room.offers[kind] === color) return `${label} already sent`;
  if (kind === 'takeback' && takebackPly(room.game, color) < 0) return 'You have no move to take back';
  room.offers[kind] = color;
  say(room, 'system', kind === 'draw' ? `${seatName(room, color)} offers a draw` : `${seatName(room, color)} proposes a takeback`);
  // A bot lets you take a move back, but plays on rather than agree a draw.
  if (room.bot && room.bot.color === other(color)) {
    return handleOffer(room, room.bot.color, kind, kind === 'takeback' ? 'accept' : 'decline');
  }
  return null;
}

// ---------- HTTP API ----------

// The creator's chosen cards as a clean list, or false if they are not five distinct real cards.
function validCards(cards) {
  if (!Array.isArray(cards) || cards.length !== 5 || new Set(cards).size !== 5) return false;
  if (!cards.every((name) => typeof name === 'string' && Object.hasOwn(Onitama.CARDS, name))) return false;
  return [...cards];
}

// How late the event loop runs its timers, in ms: the "server" figure in the menu.
let lag = 0;
let lastBeat = performance.now();
setInterval(() => {
  const now = performance.now();
  lag = Math.max(0, now - lastBeat - 1000);
  lastBeat = now;
}, 1000).unref();

async function handleApi(req, res, url) {
  if (url.pathname === '/api/ping') return json(res, 200, { lag: Math.round(lag) });
  if ((await accounts.route(req, res, url)) !== false) return;
  if ((await tournaments.route(req, res, url)) !== false) return;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', code?, action?]

  if (parts[1] === 'seek' && parts.length === 2 && req.method === 'GET') {
    return openSeek(req, res, url.searchParams.get('tc'));
  }
  if (parts[1] !== 'rooms' || parts.length > 4) return json(res, 404, { error: 'Not found' });

  if (parts.length === 2) {
    if (req.method === 'GET') {
      const games = liveGames();
      return json(res, 200, { games: games.slice(0, 50), playing: games.length, online: onlineCount(req) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Server is full, try again later' });
    const body = await readJson(req);
    const cards = body.cards === undefined || body.cards === null ? null : validCards(body.cards);
    if (cards === false) return json(res, 400, { error: 'Choose exactly five different cards' });
    const level = body.bot === undefined || body.bot === null ? null : body.bot;
    if (level !== null && !Object.hasOwn(bot.LEVELS, level)) return json(res, 400, { error: 'Unknown bot level' });
    const created = createRoom(body.tc, cards);
    if (level) seatBot(created.room, level);
    return json(res, 201, { room: created.code });
  }

  const room = rooms.get(parts[2].toUpperCase());
  if (!room) return json(res, 404, { error: 'Game not found' });
  const action = parts[3];

  if (action === 'events' && req.method === 'GET') {
    return openEvents(req, res, room, url.searchParams.get('token'));
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const body = await readJson(req);

  if (action === 'join') {
    if (body.spectate) return json(res, 200, { color: null, token: null });
    let color = seatOf(room, body.token);
    let token = body.token;
    if (!color) {
      color = !room.tokens.red ? 'red' : !room.tokens.blue ? 'blue' : null;
      if (!color) return json(res, 200, { color: null, token: null }); // spectator
      token = newToken();
      room.tokens[color] = token;
      room.users[color] = await accounts.userFromRequest(req);
      broadcast(room);
    }
    return json(res, 200, { color, token });
  }

  const color = seatOf(room, body.token);
  if (!color) return json(res, 403, { error: 'You are not a player in this game' });
  const ok = () => {
    broadcast(room);
    return json(res, 200, { ok: true });
  };

  if (action === 'chat') {
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, CHAT_MAX_LENGTH) : '';
    if (!text) return json(res, 400, { error: 'Empty message' });
    say(room, color, text);
    return json(res, 200, { ok: true });
  }

  if (action === 'rematch') {
    if (!room.game.winner) return json(res, 409, { error: 'The game is still in progress' });
    if (room.tournament) return json(res, 409, { error: 'Tournament games have no rematch' });
    finish(room, null);
    room.game = Onitama.newGame(null, room.cards);
    room.result = null;
    room.clock = newClock(room.tc);
    if (room.quick) startClock(room);
    say(room, 'system', 'Rematch started');
    return ok();
  }

  if (!['move', 'pass', 'resign', 'draw', 'takeback'].includes(action)) return json(res, 404, { error: 'Not found' });
  if (!room.tokens.red || !room.tokens.blue) return json(res, 409, { error: 'Waiting for the second player' });
  if (room.game.winner) return json(res, 409, { error: 'The game is over' });

  if (action === 'resign') {
    finish(room, other(color), 'resign');
    say(room, 'system', `${seatName(room, color)} resigned`);
    return ok();
  }

  if (action === 'draw' || action === 'takeback') {
    const error = handleOffer(room, color, action, body.answer);
    if (error) return json(res, 400, { error });
    return ok();
  }

  if (room.game.turn !== color) return json(res, 409, { error: 'It is not your turn' });
  if (room.clock && room.clock.running === color && timeLeft(room.clock, color) <= 0) {
    flag(room);
    return json(res, 409, { error: 'You ran out of time' });
  }
  const error =
    action === 'move'
      ? Onitama.applyMove(room.game, { card: body.card, from: body.from, to: body.to })
      : Onitama.applyPass(room.game, body.card);
  if (error) return json(res, 400, { error });
  afterMove(room, color);
  return ok();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    handleApi(req, res, url).catch((err) => {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'Server error' });
    });
    return;
  }
  const entry = STATIC[url.pathname];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(path.join(__dirname, 'public', entry[0]), (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

// Comment lines keep idle SSE connections alive through proxies.
setInterval(() => {
  for (const room of rooms.values()) for (const client of room.clients) client.res.write(': ping\n\n');
  for (const seeker of seekers.values()) seeker.res.write(': ping\n\n');
}, 20000).unref();

setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && room.touched < cutoff) {
      stopClock(room);
      clearTimeout(room.botTimer);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

db.init()
  .then(() => tournaments.init({ timeControls: TIME_CONTROLS, startGame: startPairedGame }))
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Onitama running on http://localhost:${PORT}${db.enabled ? '' : ' (no DATABASE_URL: accounts off)'}`);
    });
  })
  .catch((err) => {
    console.error('Could not prepare the database', err);
    process.exit(1);
  });
