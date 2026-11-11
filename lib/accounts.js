// Accounts: password and Google sign-in, sessions, ratings, match history.
'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./db');
const rating = require('./rating');
const mail = require('./mail');
const { json, redirect, readJson, cookies, isHttps, clientIp, setCookie } = require('./http');

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'sid';
const SESSION_SECONDS = 60 * 60 * 24 * 90;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFY_HOURS = 24; // how long a verification link works
const RESEND_SECONDS = 60; // shortest wait between two verification emails to one account
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Where the Donate page sends people; only an https link is passed on.
const DONATE_URL = /^https:\/\/\S+$/.test(process.env.DONATE_URL || '') ? process.env.DONATE_URL : null;
// Shown in the footer: the package version, plus the deployed commit on Railway.
const VERSION = `v${require('../package.json').version}` +
  (process.env.RAILWAY_GIT_COMMIT_SHA ? ` (${process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7)})` : '');
const googleEnabled = db.enabled && !!GOOGLE_ID && !!GOOGLE_SECRET;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// What other players may see about an account.
function publicUser(row) {
  return {
    id: row.id,
    name: row.username,
    rating: Math.round(row.rating),
    games: row.games,
    provisional: row.games < rating.PROVISIONAL_GAMES,
  };
}

// ---------- passwords and sessions ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function checkPassword(password, stored) {
  const [scheme, salt, hash] = (stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Only a hash of the session token is stored, so a database leak does not hand out logins.
async function startSession(req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('insert into sessions (token_hash, user_id) values ($1, $2)', [sha256(token), userId]);
  return setCookie(req, SESSION_COOKIE, token, SESSION_SECONDS);
}

async function userFromRequest(req) {
  if (!db.enabled) return null;
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await db.query(
    'select u.* from sessions s join users u on u.id = s.user_id where s.token_hash = $1',
    [sha256(token)]
  );
  return rows[0] ? publicUser(rows[0]) : null;
}

// Slows down password guessing: a handful of attempts per address per window.
const attempts = new Map();
function tooManyAttempts(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let entry = attempts.get(ip);
  if (!entry || entry.reset < now) {
    entry = { count: 0, reset: now + 10 * 60 * 1000 };
    attempts.set(ip, entry);
  }
  if (attempts.size > 10000) attempts.clear();
  return ++entry.count > 30;
}

// ---------- sign-up / sign-in ----------

// With mail on, a password account has to confirm its email address before it
// can sign in. Accounts made before emails were asked for have none and are
// left alone, as is everyone when the server cannot send mail.
const mustVerify = (row) => mail.enabled && !!row.password_hash && !!row.email && !row.email_verified_at;

// Emails a single-use link; only its hash is stored. Rejects if the mail could not be sent.
async function sendVerification(req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.query('insert into email_tokens (token_hash, user_id) values ($1, $2)', [sha256(token), user.id]);
  const link = `${publicOrigin(req)}/auth/verify?token=${token}`;
  await mail.send({
    to: user.email,
    subject: 'Confirm your email for Onitama',
    text:
      `Hello ${user.username},\n\nConfirm your email address to finish creating your Onitama account:\n\n${link}\n\n` +
      `The link works for ${VERIFY_HOURS} hours. If you did not create this account, you can ignore this message.\n`,
    html:
      `<p>Hello ${user.username},</p><p>Confirm your email address to finish creating your Onitama account:</p>` +
      `<p><a href="${link}">Confirm my email</a></p>` +
      `<p>The link works for ${VERIFY_HOURS} hours. If you did not create this account, you can ignore this message.</p>`,
  });
}

async function register(req, res) {
  const body = await readJson(req);
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) {
    return json(res, 400, { error: 'Username must be 3–20 letters, digits, _ or -' });
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return json(res, 400, { error: 'Enter a valid email address' });
  }
  if (password.length < 8 || password.length > 200) {
    return json(res, 400, { error: 'Password must be at least 8 characters' });
  }
  const taken = await db.query('select 1 from users where lower(email) = $1', [email.toLowerCase()]);
  if (taken.rows[0]) return json(res, 409, { error: 'An account with that email already exists' });
  const { rows } = await db.query(
    `insert into users (username, username_lower, password_hash, email) values ($1, $2, $3, $4)
     on conflict (username_lower) do nothing returning *`,
    [username, username.toLowerCase(), await hashPassword(password), email]
  );
  const user = rows[0];
  if (!user) return json(res, 409, { error: 'That username is taken' });
  if (!mustVerify(user)) {
    return json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': await startSession(req, user.id) });
  }
  try {
    await sendVerification(req, user);
  } catch (err) {
    // Without the email the account could never be used, so it is not kept.
    console.error('Could not send verification email', err);
    await db.query('delete from users where id = $1', [user.id]);
    return json(res, 502, { error: 'We could not send the verification email. Please try again later.' });
  }
  json(res, 201, { verify: true, email: user.email });
}

async function login(req, res) {
  const body = await readJson(req);
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const { rows } = await db.query('select * from users where username_lower = $1', [username]);
  const valid = rows[0] && (await checkPassword(password, rows[0].password_hash));
  if (!valid) return json(res, 401, { error: 'Wrong username or password' });
  if (mustVerify(rows[0])) {
    return json(res, 403, { error: 'Confirm your email address first: check your inbox for the link.', unverified: true });
  }
  json(res, 200, { user: publicUser(rows[0]) }, { 'Set-Cookie': await startSession(req, rows[0].id) });
}

// Sends the link again. Always answers the same, so it does not reveal which usernames exist.
async function resendVerification(req, res) {
  const body = await readJson(req);
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const { rows } = await db.query('select * from users where username_lower = $1', [username]);
  const user = rows[0];
  if (user && mustVerify(user)) {
    const recent = await db.query(
      `select 1 from email_tokens where user_id = $1 and created_at > now() - make_interval(secs => $2)`,
      [user.id, RESEND_SECONDS]
    );
    if (!recent.rows[0]) {
      await sendVerification(req, user).catch((err) => console.error('Could not send verification email', err));
    }
  }
  json(res, 200, { ok: true });
}

// The link from the email: confirms the address and signs the player in.
async function verifyEmail(req, res, url) {
  const token = url.searchParams.get('token') || '';
  const { rows } = await db.query(
    `select user_id from email_tokens
     where token_hash = $1 and created_at > now() - make_interval(hours => $2)`,
    [sha256(token), VERIFY_HOURS]
  );
  if (!rows[0]) return redirect(res, '/?signup=expired');
  const userId = rows[0].user_id;
  await db.query('update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1', [userId]);
  await db.query('delete from email_tokens where user_id = $1', [userId]);
  redirect(res, '/?signup=verified', { 'Set-Cookie': await startSession(req, userId) });
}

async function logout(req, res) {
  const token = cookies(req)[SESSION_COOKIE];
  if (token) await db.query('delete from sessions where token_hash = $1', [sha256(token)]);
  json(res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, SESSION_COOKIE, '', 0) });
}

// ---------- Google sign-in (OAuth 2 authorization-code flow) ----------

function publicOrigin(req) {
  return process.env.PUBLIC_URL || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
}

function googleStart(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  const query = new URLSearchParams({
    client_id: GOOGLE_ID,
    redirect_uri: `${publicOrigin(req)}/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${query}`, {
    'Set-Cookie': setCookie(req, 'gstate', state, 600),
  });
}

// A free username based on the Google profile: "ana", then "ana2", "ana3"…
async function createGoogleUser(profile) {
  const source = profile.given_name || profile.name || (profile.email || '').split('@')[0] || '';
  let base = source.normalize('NFKD').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
  if (base.length < 3) base = 'player';
  for (let n = 1; n < 500; n++) {
    const username = n === 1 ? base : `${base}${n}`;
    const { rows } = await db.query(
      `insert into users (username, username_lower, google_sub, email, email_verified_at) values ($1, $2, $3, $4, now())
       on conflict (username_lower) do nothing returning *`,
      [username, username.toLowerCase(), profile.sub, profile.email || null]
    );
    if (rows[0]) return rows[0];
  }
  throw new Error('Could not find a free username');
}

async function googleCallback(req, res, url) {
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!code || !state || state !== cookies(req).gstate) return redirect(res, '/?signin=failed');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_ID,
      client_secret: GOOGLE_SECRET,
      redirect_uri: `${publicOrigin(req)}/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok || !tokens.id_token) return redirect(res, '/?signin=failed');
  // The ID token came straight from Google over TLS, so its claims can be read without checking the signature.
  const profile = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
  if (profile.aud !== GOOGLE_ID || !profile.sub) return redirect(res, '/?signin=failed');

  const existing = await db.query('select * from users where google_sub = $1', [profile.sub]);
  const user = existing.rows[0] || (await createGoogleUser(profile));
  res.setHeader('Set-Cookie', [await startSession(req, user.id), setCookie(req, 'gstate', '', 0)]);
  redirect(res, '/');
}

// ---------- ratings and match history ----------

// Stores a finished game and, if it was rated, moves both ratings.
// `game` = { tc, rated, tournament, users: { red, blue }, winner, reason, initial, moves }.
// Returns { id, diffs: { red, blue }, ratings: { red, blue } }.
async function saveGame(game) {
  const { red, blue } = game.users;
  const before = { red: red ? red.rating : null, blue: blue ? blue.rating : null };
  const diffs = { red: null, blue: null };
  const client = await db.connect();
  try {
    await client.query('begin');
    if (game.rated) {
      const { rows } = await client.query('select * from users where id = any($1) order by id for update', [
        [red.id, blue.id],
      ]);
      const row = { red: rows.find((r) => r.id === red.id), blue: rows.find((r) => r.id === blue.id) };
      const score = { red: game.winner === 'red' ? 1 : game.winner === 'draw' ? 0.5 : 0 };
      score.blue = 1 - score.red;
      for (const color of ['red', 'blue']) {
        const mine = row[color];
        const theirs = row[color === 'red' ? 'blue' : 'red'];
        before[color] = Math.round(mine.rating);
        diffs[color] = Math.round(rating.ratingChange(mine.rating, theirs.rating, score[color], mine.games));
      }
      for (const color of ['red', 'blue']) {
        await client.query(
          `update users set rating = rating + $2, games = games + 1,
             wins = wins + $3, draws = draws + $4, losses = losses + $5 where id = $1`,
          [row[color].id, diffs[color], +(score[color] === 1), +(score[color] === 0.5), +(score[color] === 0)]
        );
      }
    }
    const inserted = await client.query(
      `insert into games (tc, rated, red_id, blue_id, red_name, blue_name, red_rating, blue_rating,
         red_diff, blue_diff, winner, reason, initial, moves, plies, tournament_id, seconds)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [
        game.tc, game.rated, red && red.id, blue && blue.id, red && red.name, blue && blue.name,
        before.red, before.blue, diffs.red, diffs.blue, game.winner, game.reason,
        JSON.stringify(game.initial), JSON.stringify(game.moves), game.moves.length, game.tournament || null,
        game.seconds == null ? null : game.seconds,
      ]
    );
    await client.query('commit');
    return {
      id: inserted.rows[0].id,
      diffs,
      ratings: {
        red: before.red === null ? null : before.red + (diffs.red || 0),
        blue: before.blue === null ? null : before.blue + (diffs.blue || 0),
      },
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

const GAME_COLUMNS = `id, tc, rated, red_id, blue_id, red_name, blue_name, red_rating, blue_rating,
  red_diff, blue_diff, winner, reason, plies, ended_at`;

async function profile(res, name) {
  const found = await db.query('select * from users where username_lower = $1', [name.toLowerCase()]);
  const user = found.rows[0];
  if (!user) return json(res, 404, { error: 'Player not found' });
  const games = await db.query(
    `select ${GAME_COLUMNS} from games where red_id = $1 or blue_id = $1 order by id desc limit 50`,
    [user.id]
  );
  // Games stored before `seconds` existed have no duration and count as none.
  const played = await db.query(
    'select coalesce(sum(seconds), 0)::int as seconds from games where red_id = $1 or blue_id = $1',
    [user.id]
  );
  // Place = one more than the number of players who scored higher (ties share a place).
  const tournaments = await db.query(
    `select t.id, t.name, t.tc, t.starts_at, p.score, p.played, p.wins, p.draws, p.losses,
       (select count(*)::int + 1 from tournament_players o
         where o.tournament_id = p.tournament_id and o.score > p.score) as place,
       (select count(*)::int from tournament_players o where o.tournament_id = p.tournament_id) as players
     from tournament_players p join tournaments t on t.id = p.tournament_id
     where p.user_id = $1 order by t.starts_at desc`,
    [user.id]
  );
  json(res, 200, {
    user: {
      ...publicUser(user),
      wins: user.wins,
      losses: user.losses,
      draws: user.draws,
      since: user.created_at,
      secondsPlayed: played.rows[0].seconds,
      tournamentPoints: tournaments.rows.reduce((sum, row) => sum + row.score, 0),
    },
    games: games.rows,
    tournaments: tournaments.rows.slice(0, 30),
  });
}

async function storedGame(res, id) {
  if (!/^\d{1,9}$/.test(id)) return json(res, 404, { error: 'Game not found' });
  const { rows } = await db.query(`select ${GAME_COLUMNS}, initial, moves from games where id = $1`, [Number(id)]);
  if (!rows[0]) return json(res, 404, { error: 'Game not found' });
  json(res, 200, { game: rows[0] });
}

async function leaderboard(res) {
  const { rows } = await db.query('select * from users where games > 0 order by rating desc, id limit 10');
  json(res, 200, { players: rows.map(publicUser) });
}

// ---------- routing ----------

// Handles the account-related URLs. Resolves to false when the URL is not one of them.
async function route(req, res, url) {
  const p = url.pathname;
  const get = req.method === 'GET';
  const post = req.method === 'POST';

  if (p === '/api/me' && get) {
    return json(res, 200, {
      accounts: db.enabled,
      google: googleEnabled,
      donate: DONATE_URL,
      version: VERSION,
      user: await userFromRequest(req),
    });
  }
  const mine =
    ['/api/register', '/api/login', '/api/logout', '/api/leaderboard', '/api/verify/resend', '/auth/verify'].includes(p) ||
    p.startsWith('/api/users/') || p.startsWith('/api/games/') || p.startsWith('/auth/google');
  if (!mine) return false;
  if (!db.enabled) return json(res, 503, { error: 'Accounts are not available on this server' });

  if (p === '/api/register' && post) {
    if (tooManyAttempts(req)) return json(res, 429, { error: 'Too many attempts, try again later' });
    return register(req, res);
  }
  if (p === '/api/login' && post) {
    if (tooManyAttempts(req)) return json(res, 429, { error: 'Too many attempts, try again later' });
    return login(req, res);
  }
  if (p === '/api/verify/resend' && post) {
    if (tooManyAttempts(req)) return json(res, 429, { error: 'Too many attempts, try again later' });
    return resendVerification(req, res);
  }
  if (p === '/auth/verify' && get) return verifyEmail(req, res, url);
  if (p === '/api/logout' && post) return logout(req, res);
  if (p === '/api/leaderboard' && get) return leaderboard(res);
  if (p.startsWith('/api/users/') && get) return profile(res, decodeURIComponent(p.slice('/api/users/'.length)));
  if (p.startsWith('/api/games/') && get) return storedGame(res, p.slice('/api/games/'.length));
  if (p.startsWith('/auth/google')) {
    if (!googleEnabled) return redirect(res, '/?signin=unavailable');
    if (p === '/auth/google' && get) return googleStart(req, res);
    if (p === '/auth/google/callback' && get) return googleCallback(req, res, url);
  }
  return json(res, 404, { error: 'Not found' });
}

module.exports = { enabled: db.enabled, route, userFromRequest, saveGame };
