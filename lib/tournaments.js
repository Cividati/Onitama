// Arena tournaments: for a fixed time, the players who are on the tournament
// page are paired again and again; a win is worth 2 points and a draw 1.
// Tournaments and scores live in Postgres; who is connected and who is playing
// is kept in memory.
'use strict';

const db = require('./db');
const accounts = require('./accounts');
const rating = require('./rating');
const { json, readJson, sseHeaders } = require('./http');

const DURATIONS = [20, 30, 45, 60, 90, 120]; // minutes
const MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000; // how far in the future one may be scheduled
const MAX_OPEN_PER_USER = 3;
const TICK_MS = 3000; // how often waiting players are paired
const KEEP_FINISHED_MS = 60 * 60 * 1000; // a finished tournament stays in memory this long
const POINTS = { wins: 2, draws: 1, losses: 0 };

// id -> tournament that is upcoming, running or just finished (see build)
const live = new Map();
// { timeControls, startGame(tc, userA, userB, tournament) } from server.js
let host = null;

const statusOf = (t, now) => (now < t.startsAt ? 'upcoming' : now < t.endsAt ? 'running' : 'finished');

function build(row, playerRows) {
  const startsAt = new Date(row.starts_at).getTime();
  const t = {
    id: row.id,
    name: row.name,
    tc: row.tc,
    minutes: row.minutes,
    startsAt,
    endsAt: startsAt + row.minutes * 60 * 1000,
    createdBy: row.creator,
    creatorId: row.created_by,
    players: new Map(), // user id -> player (see addPlayer)
    clients: new Set(), // { res, userId } for everyone with the page open
  };
  t.status = statusOf(t, Date.now());
  for (const p of playerRows) {
    addPlayer(t, { id: p.user_id, name: p.username, rating: Math.round(p.rating), games: p.rated_games }, p);
  }
  return t;
}

// `user` is an account as returned by accounts.userFromRequest; `stats` a tournament_players row, if any.
function addPlayer(t, user, stats) {
  t.players.set(user.id, {
    id: user.id,
    name: user.name,
    rating: user.rating,
    ratedGames: user.games,
    score: stats ? stats.score : 0,
    played: stats ? stats.played : 0,
    wins: stats ? stats.wins : 0,
    draws: stats ? stats.draws : 0,
    losses: stats ? stats.losses : 0,
    withdrawn: stats ? stats.withdrawn : false,
    room: null, // code of the game they are playing
    lastOpponent: null,
  });
}

const TOURNAMENT_SQL = `select t.*, u.username as creator from tournaments t left join users u on u.id = t.created_by`;
const PLAYERS_SQL = `select p.*, u.username, u.rating, u.games as rated_games
  from tournament_players p join users u on u.id = p.user_id`;

// The tournament from memory, or rebuilt from the database once it is long over.
async function load(id) {
  if (live.has(id)) return live.get(id);
  const found = await db.query(`${TOURNAMENT_SQL} where t.id = $1`, [id]);
  if (!found.rows[0]) return null;
  const players = await db.query(`${PLAYERS_SQL} where p.tournament_id = $1`, [id]);
  return build(found.rows[0], players.rows);
}

// Best score first; ties go to more wins, then the higher rating.
function standings(t) {
  return [...t.players.values()].sort(
    (a, b) => b.score - a.score || b.wins - a.wins || b.rating - a.rating || a.id - b.id
  );
}

function snapshot(t) {
  return {
    id: t.id,
    name: t.name,
    tc: t.tc,
    minutes: t.minutes,
    startsAt: t.startsAt,
    endsAt: t.endsAt,
    now: Date.now(), // lets the page count down on the server's clock
    status: t.status,
    createdBy: t.createdBy,
    creatorId: t.creatorId,
    standings: standings(t).map((p) => ({
      id: p.id,
      name: p.name,
      rating: p.rating,
      provisional: p.ratedGames < rating.PROVISIONAL_GAMES,
      score: p.score,
      played: p.played,
      wins: p.wins,
      draws: p.draws,
      losses: p.losses,
      withdrawn: p.withdrawn,
      room: p.room,
    })),
  };
}

function broadcast(t) {
  const payload = `data: ${JSON.stringify(snapshot(t))}\n\n`;
  for (const client of t.clients) client.res.write(payload);
}

// ---------- pairing ----------

// Pairs the players who are on the page and not in a game, neighbours in the
// standings first, avoiding an immediate rematch when someone else is waiting.
function pair(t) {
  const connected = new Set();
  for (const client of t.clients) if (client.userId) connected.add(client.userId);
  const waiting = standings(t).filter((p) => !p.withdrawn && !p.room && connected.has(p.id));
  let started = false;
  while (waiting.length >= 2) {
    const a = waiting.shift();
    const fresh = waiting.findIndex((b) => b.id !== a.lastOpponent && b.lastOpponent !== a.id);
    const b = waiting.splice(Math.max(fresh, 0), 1)[0];
    const user = (p) => ({ id: p.id, name: p.name, rating: p.rating, games: p.ratedGames, provisional: p.ratedGames < rating.PROVISIONAL_GAMES });
    const game = host.startGame(t.tc, user(a), user(b), { id: t.id, name: t.name });
    if (!game) break; // server full; try again on the next tick
    [a, b].forEach((p, i) => {
      p.room = game.code;
      p.lastOpponent = (i === 0 ? b : a).id;
      const payload = `event: paired\ndata: ${JSON.stringify({ room: game.code, token: game.tokens[i] })}\n\n`;
      for (const client of t.clients) if (client.userId === p.id) client.res.write(payload);
    });
    started = true;
  }
  if (started) broadcast(t);
}

// Called by the server when a tournament game ends. `ids` = { red, blue } user ids.
// Games still going when the tournament ends do not count.
function gameFinished(id, code, ids, winner) {
  const t = live.get(id);
  if (!t) return;
  const counts = Date.now() < t.endsAt;
  for (const color of ['red', 'blue']) {
    const p = t.players.get(ids[color]);
    if (!p) continue;
    if (p.room === code) p.room = null;
    if (!counts) continue;
    const outcome = winner === 'draw' ? 'draws' : winner === color ? 'wins' : 'losses';
    p[outcome]++;
    p.played++;
    p.score += POINTS[outcome];
    db.query(
      `update tournament_players set score = $3, played = $4, wins = $5, draws = $6, losses = $7
       where tournament_id = $1 and user_id = $2`,
      [t.id, p.id, p.score, p.played, p.wins, p.draws, p.losses]
    ).catch((err) => console.error('Could not save tournament score', err));
  }
  broadcast(t);
}

// The player's rating after a rated tournament game.
function setRating(id, userId, newRating) {
  const t = live.get(id);
  const p = t && t.players.get(userId);
  if (!p) return;
  p.rating = newRating;
  p.ratedGames++;
}

let ticks = 0;
function tick() {
  const now = Date.now();
  const ping = ++ticks % 6 === 0; // comment lines keep idle connections alive through proxies
  for (const t of live.values()) {
    const status = statusOf(t, now);
    if (status !== t.status) {
      t.status = status;
      broadcast(t);
    }
    if (status === 'running') pair(t);
    if (ping) for (const client of t.clients) client.res.write(': ping\n\n');
    if (now > t.endsAt + KEEP_FINISHED_MS) {
      for (const client of t.clients) client.res.end();
      live.delete(t.id);
    }
  }
}

// ---------- HTTP API ----------

async function list(res) {
  const { rows } = await db.query(
    `select t.*, u.username as creator,
       (select count(*)::int from tournament_players p where p.tournament_id = t.id) as players
     from tournaments t left join users u on u.id = t.created_by
     where t.starts_at + t.minutes * interval '1 minute' > now() - interval '30 days'
     order by t.starts_at desc limit 60`
  );
  const now = Date.now();
  json(res, 200, {
    tournaments: rows.map((row) => {
      const startsAt = new Date(row.starts_at).getTime();
      const t = { startsAt, endsAt: startsAt + row.minutes * 60 * 1000 };
      return {
        id: row.id,
        name: row.name,
        tc: row.tc,
        minutes: row.minutes,
        startsAt,
        status: statusOf(t, now),
        players: live.has(row.id) ? live.get(row.id).players.size : row.players,
        createdBy: row.creator,
      };
    }),
  });
}

async function create(req, res) {
  const user = await accounts.userFromRequest(req);
  if (!user) return json(res, 401, { error: 'Sign in to create a tournament' });
  const body = await readJson(req);
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 3 || name.length > 40) return json(res, 400, { error: 'The name must be 3–40 characters' });
  if (typeof body.tc !== 'string' || !Object.hasOwn(host.timeControls, body.tc)) {
    return json(res, 400, { error: 'Unknown time control' });
  }
  if (!DURATIONS.includes(body.minutes)) return json(res, 400, { error: 'Unknown duration' });
  const now = Date.now();
  if (!Number.isFinite(body.startsAt) || body.startsAt > now + MAX_AHEAD_MS) {
    return json(res, 400, { error: 'Choose a start within the next 60 days' });
  }
  const open = [...live.values()].filter((t) => t.creatorId === user.id && t.status !== 'finished');
  if (open.length >= MAX_OPEN_PER_USER) {
    return json(res, 409, { error: `You already have ${MAX_OPEN_PER_USER} tournaments open` });
  }
  const startsAt = new Date(Math.max(body.startsAt, now));
  const { rows } = await db.query(
    'insert into tournaments (name, tc, minutes, starts_at, created_by) values ($1, $2, $3, $4, $5) returning *',
    [name, body.tc, body.minutes, startsAt, user.id]
  );
  live.set(rows[0].id, build({ ...rows[0], creator: user.name }, []));
  json(res, 201, { id: rows[0].id });
}

async function join(req, res, t, withdrawn) {
  const user = await accounts.userFromRequest(req);
  if (!user) return json(res, 401, { error: 'Sign in to join the tournament' });
  if (t.status === 'finished' || !live.has(t.id)) return json(res, 409, { error: 'The tournament is over' });
  const player = t.players.get(user.id);
  if (withdrawn && !player) return json(res, 409, { error: 'You are not in this tournament' });
  await db.query(
    `insert into tournament_players (tournament_id, user_id, withdrawn) values ($1, $2, $3)
     on conflict (tournament_id, user_id) do update set withdrawn = $3`,
    [t.id, user.id, withdrawn]
  );
  if (player) player.withdrawn = withdrawn;
  else if (!t.players.has(user.id)) addPlayer(t, user, null);
  broadcast(t);
  json(res, 200, { ok: true });
}

// Only the player who created a tournament may delete it. Its stored games stay
// in the players' histories; games still being played simply finish.
async function remove(req, res, t) {
  const user = await accounts.userFromRequest(req);
  if (!user) return json(res, 401, { error: 'Sign in to delete the tournament' });
  if (t.creatorId !== user.id) return json(res, 403, { error: 'Only the creator can delete this tournament' });
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query('update games set tournament_id = null where tournament_id = $1', [t.id]);
    await client.query('delete from tournaments where id = $1', [t.id]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  live.delete(t.id);
  for (const viewer of t.clients) viewer.res.end('event: deleted\ndata: {}\n\n');
  json(res, 200, { ok: true });
}

async function openEvents(req, res, t) {
  const user = await accounts.userFromRequest(req);
  sseHeaders(res);
  res.write('retry: 2000\n\n');
  res.write(`data: ${JSON.stringify(snapshot(t))}\n\n`);
  if (!live.has(t.id)) return res.end(); // long over: nothing will change
  const client = { res, userId: user ? user.id : null };
  t.clients.add(client);
  req.on('close', () => t.clients.delete(client));
}

// Handles the tournament URLs. Resolves to false when the URL is not one of them.
async function route(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'tournaments', id?, action?]
  if (parts[1] !== 'tournaments' || parts.length > 4) return false;
  if (!db.enabled) return json(res, 503, { error: 'Tournaments need accounts, which are not available on this server' });
  const get = req.method === 'GET';
  const post = req.method === 'POST';

  if (parts.length === 2) {
    if (get) return list(res);
    if (post) return create(req, res);
    return json(res, 405, { error: 'Method not allowed' });
  }
  const t = /^\d{1,9}$/.test(parts[2]) ? await load(Number(parts[2])) : null;
  if (!t) return json(res, 404, { error: 'Tournament not found' });
  if (parts.length === 3 && req.method === 'DELETE') return remove(req, res, t);
  if (parts[3] === 'events' && get) return openEvents(req, res, t);
  if (parts[3] === 'join' && post) return join(req, res, t, false);
  if (parts[3] === 'withdraw' && post) return join(req, res, t, true);
  return json(res, 404, { error: 'Not found' });
}

// Brings back the tournaments that are not over yet, e.g. after a restart.
async function init(hostApi) {
  host = hostApi;
  if (!db.enabled) return;
  const found = await db.query(`${TOURNAMENT_SQL} where t.starts_at + t.minutes * interval '1 minute' > now()`);
  const players = await db.query(`${PLAYERS_SQL} where p.tournament_id = any($1)`, [found.rows.map((row) => row.id)]);
  for (const row of found.rows) {
    live.set(row.id, build(row, players.rows.filter((p) => p.tournament_id === row.id)));
  }
  setInterval(tick, TICK_MS).unref();
}

module.exports = { init, route, gameFinished, setRating };
