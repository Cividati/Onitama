/* global Onitama */
(function () {
  'use strict';

  const { CARDS, TEMPLE, other, movesFor, legalMoves } = Onitama;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let room = (params.get('room') || '').toUpperCase();
  const watching = params.has('watch'); // spectate without taking a seat
  let analysis = false; // showing a finished game instead of a live room

  const NAME = { red: 'Red', blue: 'Blue' };
  const PIECE_SVG = {
    student: '<circle cx="20" cy="12" r="7"/><path d="M9 35c0-9 4-14 11-14s11 5 11 14z"/>',
    master: '<path d="M6 11l7 7 7-12 7 12 7-7-3 16H9z"/><rect x="8" y="29" width="24" height="6" rx="2"/>',
  };

  // Squares are named like chess, from Red's side: files a–e, ranks 1–5.
  const fileOf = (index) => 'abcde'[index % 5];
  const rankOf = (index) => 5 - Math.floor(index / 5);
  const square = (index) => fileOf(index) + rankOf(index);

  // Signed-in account and what the server supports (from /api/me).
  let account = null;
  let accountsOn = false;
  let googleOn = false;

  // latest server snapshot: { game, seated, online, spectators, you, players, rated, result, tc, clock, offers }
  let snap = null;
  let snapAt = 0; // performance.now() when it arrived, for ticking clocks locally
  let token = null;
  let sel = { card: null, from: null };
  let hint = '';
  let seenMove = -1;
  let offline = false;
  let resignArmed = false;
  let viewPly = null; // move number being looked at in the replay; null = live position
  let shownPly = -1;
  let chat = [];

  async function request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  const post = (pathname, body) => request('POST', `/api/rooms${pathname}`, body || {});

  function storedToken(code) {
    try { return localStorage.getItem(`onitama:${code}`); } catch { return null; }
  }
  function storeToken(code, value) {
    try { localStorage.setItem(`onitama:${code}`, value); } catch { /* private mode */ }
  }

  const ratingText = (player) => `${player.rating}${player.provisional ? '?' : ''}`;
  const profileHref = (name) => `/?user=${encodeURIComponent(name)}`;

  // ---------- sound ----------
  // One two-note chime, used when a game starts and when it ends.

  let audio = null;
  function audioContext() {
    if (!audio) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) audio = new Ctor();
    }
    return audio;
  }
  // Browsers only allow sound after the user has interacted with the page.
  document.addEventListener('pointerdown', () => { const ctx = audioContext(); if (ctx) ctx.resume(); }, { once: true });

  function chime() {
    const ctx = audioContext();
    if (!ctx) return;
    const asked = performance.now();
    ctx.resume().then(() => {
      if (performance.now() - asked > 500) return; // unlocked too late to be meaningful
      const start = ctx.currentTime + 0.02;
      [[659.25, 0], [987.77, 0.14]].forEach(([frequency, delay]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start + delay);
        gain.gain.exponentialRampToValueAtTime(0.25, start + delay + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.7);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start + delay);
        osc.stop(start + delay + 0.75);
      });
    }).catch(() => {});
  }

  // ---------- account bar and sign-in dialog ----------

  function renderAccount() {
    $('account').hidden = !accountsOn;
    $('signin').hidden = !!account;
    $('signout').hidden = $('me-link').hidden = !account;
    if (account) {
      const link = $('me-link');
      link.href = profileHref(account.name);
      link.innerHTML = '<span></span><em></em>';
      link.children[0].textContent = account.name;
      link.children[1].textContent = ratingText(account);
    }
  }

  function bindDialogs() {
    for (const button of document.querySelectorAll('dialog [data-close]')) {
      button.addEventListener('click', () => button.closest('dialog').close());
    }
    $('signin').addEventListener('click', () => {
      $('google-login').hidden = $('auth-or').hidden = !googleOn;
      $('auth-error').textContent = '';
      $('auth-dialog').showModal();
    });
    $('signout').addEventListener('click', async () => {
      await request('POST', '/api/logout', {}).catch(() => {});
      location.reload();
    });
    $('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const action = e.submitter && e.submitter.value === 'register' ? 'register' : 'login';
      try {
        await request('POST', `/api/${action}`, {
          username: $('auth-username').value,
          password: $('auth-password').value,
        });
        location.reload();
      } catch (err) {
        $('auth-error').textContent = err.message;
      }
    });
  }

  // ---------- lobby ----------

  let seek = null; // { tc, button, events } while waiting to be paired
  let lobbyTimer = null;

  function showLobby(error) {
    $('lobby').hidden = false;
    $('lobby-error').textContent = error || '';
    $('pool-note').textContent = !accountsOn
      ? ''
      : account
        ? 'Quick pairing is rated when your opponent is signed in too.'
        : 'Sign in to play rated games and keep your match history.';
    refreshLobby();
    lobbyTimer = setInterval(refreshLobby, 5000);
    for (const button of document.querySelectorAll('.pool')) {
      button.addEventListener('click', () => toggleSeek(button));
    }
    bindFriendDialog();
  }

  // Moves from the lobby into a room without a page load, so the click that
  // started it still counts as the interaction browsers require for sound.
  function enterRoom(code) {
    clearInterval(lobbyTimer);
    if (seek) seek.events.close();
    history.pushState(null, '', `/?room=${code}`);
    $('lobby').hidden = true;
    room = code;
    startGame();
  }
  window.addEventListener('popstate', () => location.reload());

  // Clicking a pool waits for an opponent; clicking it again cancels.
  function toggleSeek(button) {
    const tc = button.dataset.tc;
    const cancelOnly = seek && seek.tc === tc;
    if (seek) {
      seek.events.close();
      seek.button.classList.remove('seeking');
      seek = null;
    }
    if (cancelOnly) return;
    const events = new EventSource(`/api/seek?tc=${encodeURIComponent(tc)}`);
    seek = { tc, button, events };
    button.classList.add('seeking');
    events.onmessage = (e) => {
      const paired = JSON.parse(e.data);
      events.close();
      storeToken(paired.room, paired.token);
      enterRoom(paired.room);
    };
  }

  function bindFriendDialog() {
    const picker = $('card-picker');
    const picked = new Set();
    const custom = () => document.querySelector('#friend-form input[name="cards"]:checked').value === 'custom';
    const refresh = () => {
      picker.hidden = !custom();
      $('friend-create').disabled = custom() && picked.size !== 5;
      $('friend-error').textContent = custom() && picked.size !== 5 ? `${picked.size} of 5 cards chosen` : '';
    };
    for (const name of Object.keys(CARDS)) {
      const el = cardEl(name, 'neutral', false, () => {
        if (picked.has(name)) picked.delete(name);
        else if (picked.size < 5) picked.add(name);
        el.classList.toggle('selected', picked.has(name));
        refresh();
      });
      el.type = 'button';
      picker.appendChild(el);
    }
    for (const radio of document.querySelectorAll('#friend-form input[name="cards"]')) {
      radio.addEventListener('change', refresh);
    }
    $('create').addEventListener('click', () => {
      refresh();
      $('friend-dialog').showModal();
    });
    $('friend-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const { room: code } = await post('', { tc: $('friend-tc').value, cards: custom() ? [...picked] : null });
        $('friend-dialog').close();
        enterRoom(code);
      } catch (err) {
        $('friend-error').textContent = err.message;
      }
    });
  }

  async function refreshLobby() {
    refreshLive();
    if (!accountsOn) return;
    try {
      const { players } = await request('GET', '/api/leaderboard');
      $('leaderboard').hidden = players.length === 0;
      $('leaders').replaceChildren(
        ...players.map((player) => {
          const li = document.createElement('li');
          li.innerHTML = '<a></a><span></span>';
          li.children[0].textContent = player.name;
          li.children[0].href = profileHref(player.name);
          li.children[1].textContent = ratingText(player);
          return li;
        })
      );
    } catch { /* next poll retries */ }
  }

  async function refreshLive() {
    let games;
    try {
      games = (await request('GET', '/api/rooms')).games;
    } catch {
      return; // keep the last list; the next poll retries
    }
    $('live-empty').hidden = games.length > 0;
    const who = (player) => (player ? `${player.name} (${ratingText(player)})` : 'Anonymous');
    $('live-list').replaceChildren(
      ...games.map((game) => {
        const href = `/?room=${game.room}&watch`;
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="code"></td><td class="time"></td><td class="mode"></td><td class="move"></td>' +
          '<td class="spec"></td><td class="watch"><a>Watch</a></td>';
        tr.querySelector('.code').textContent = `${who(game.players.red)} vs ${who(game.players.blue)}`;
        tr.querySelector('.time').textContent = game.tc || '∞';
        tr.querySelector('.mode').textContent = game.rated ? 'Rated' : 'Casual';
        tr.querySelector('.move').textContent = game.moveCount + 1;
        tr.querySelector('.spec').textContent = game.spectators;
        tr.querySelector('a').href = href;
        tr.addEventListener('click', () => { location.href = href; });
        return tr;
      })
    );
  }

  // ---------- profile and match history ----------

  async function showProfile(name) {
    let data;
    try {
      data = await request('GET', `/api/users/${encodeURIComponent(name)}`);
    } catch (err) {
      history.replaceState(null, '', '/');
      return showLobby(err.message);
    }
    const user = data.user;
    $('profile').hidden = false;
    document.title = `${user.name} — Onitama`;
    $('profile-name').textContent = user.name;
    $('profile-rating').textContent = `Rating ${ratingText(user)}`;
    const since = new Date(user.since).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    $('profile-stats').textContent =
      `${user.games} rated game${user.games === 1 ? '' : 's'} • ${user.wins} wins • ${user.losses} losses • ` +
      `${user.draws} draws • member since ${since}`;
    $('profile-empty').hidden = data.games.length > 0;
    $('profile-list').replaceChildren(
      ...data.games.map((game) => {
        const mine = game.red_id === user.id ? 'red' : 'blue';
        const theirs = other(mine);
        const outcome = game.winner === 'draw' ? 'Draw' : game.winner === mine ? 'Win' : 'Loss';
        const diff = game[`${mine}_diff`];
        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td class="outcome ${outcome.toLowerCase()}">${outcome}</td><td class="opp"></td><td class="mode"></td>` +
          '<td class="plies"></td><td class="diff"></td><td class="date"></td>';
        const oppName = game[`${theirs}_name`];
        const oppRating = game[`${theirs}_rating`];
        tr.querySelector('.opp').textContent = oppName ? `${oppName}${oppRating ? ` (${oppRating})` : ''}` : 'Anonymous';
        tr.querySelector('.mode').textContent = `${game.rated ? 'Rated' : 'Casual'} • ${game.tc || 'Unlimited'}`;
        tr.querySelector('.plies').textContent = game.plies;
        const diffCell = tr.querySelector('.diff');
        if (diff !== null) {
          diffCell.textContent = diff > 0 ? `+${diff}` : diff < 0 ? `−${-diff}` : '±0';
          diffCell.classList.add(diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat');
        }
        tr.querySelector('.date').textContent = new Date(game.ended_at).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        });
        tr.addEventListener('click', () => { location.href = `/?game=${game.id}`; });
        return tr;
      })
    );
  }

  // ---------- analysis board ----------
  // A finished game is either stored on the server (/?game=ID, for signed-in
  // players) or travels in the URL itself (/?analysis=…), deal and moves.

  function analysisHref(g) {
    if (snap.result && snap.result.gameId) return `/?game=${snap.result.gameId}`;
    const data = { i: g.initial, h: g.history.map((m) => [m.card, m.from, m.to]), w: g.winner, r: g.winReason };
    const encoded = btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `/?analysis=${encoded}`;
  }

  function rebuildGame(initial, moves, winner, reason) {
    const history = moves.map(([card, from, to]) => ({ card, from, to }));
    const game = Onitama.replay({ initial, history }, history.length);
    if (game.history.length !== history.length) throw new Error('bad moves');
    if (!game.winner) {
      game.winner = winner || null;
      game.winReason = reason || null;
    }
    return game;
  }

  function startAnalysis(game, extra) {
    analysis = true;
    snap = {
      game,
      seated: { red: true, blue: true },
      online: { red: false, blue: false },
      spectators: 0,
      you: null,
      players: { red: null, blue: null },
      rated: false,
      result: null,
      tc: null,
      clock: null,
      offers: { draw: null, takeback: null },
      ...extra,
    };
    $('game').hidden = false;
    $('game').classList.add('analysis');
    $('chat').hidden = true;
    bindReplay();
    render();
  }

  function startUrlAnalysis(encoded) {
    try {
      const data = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
      startAnalysis(rebuildGame(data.i, data.h, data.w, data.r));
    } catch {
      history.replaceState(null, '', '/');
      showLobby('That analysis link is not valid.');
    }
  }

  async function startStoredAnalysis(id) {
    try {
      const { game: row } = await request('GET', `/api/games/${encodeURIComponent(id)}`);
      const player = (color) =>
        row[`${color}_name`] ? { id: row[`${color}_id`], name: row[`${color}_name`], rating: row[`${color}_rating`] } : null;
      startAnalysis(rebuildGame(row.initial, row.moves, row.winner, row.reason), {
        players: { red: player('red'), blue: player('blue') },
        rated: row.rated,
        tc: row.tc,
        result: { gameId: row.id, diffs: { red: row.red_diff, blue: row.blue_diff } },
      });
    } catch (err) {
      history.replaceState(null, '', '/');
      showLobby(err.message === 'bad moves' ? 'That game could not be loaded.' : err.message);
    }
  }

  // ---------- game ----------

  const bothSeated = (s) => s.seated.red && s.seated.blue;

  async function startGame() {
    let joined;
    try {
      joined = await post(`/${room}/join`, watching ? { spectate: true } : { token: storedToken(room) });
    } catch (err) {
      history.replaceState(null, '', '/');
      return showLobby(`${err.message}. It may have expired — create a new one.`);
    }
    token = joined.token;
    if (token) storeToken(room, token);

    $('game').hidden = false;
    $('room-code').textContent = `Room ${room}`;
    $('share-link').value = `${location.origin}/?room=${room}`;
    $('copy').addEventListener('click', copyLink);
    $('share-link').addEventListener('focus', (e) => e.target.select());
    $('rematch').addEventListener('click', () => act('/rematch', {}));
    $('resign').addEventListener('click', onResign);
    $('draw').addEventListener('click', () => act('/draw', {}));
    $('takeback').addEventListener('click', () => act('/takeback', {}));
    $('offer-accept').addEventListener('click', () => answerOffer('accept'));
    $('offer-decline').addEventListener('click', () => answerOffer('decline'));
    bindReplay();
    bindChat();

    const events = new EventSource(`/api/rooms/${room}/events?token=${encodeURIComponent(token || '')}`);
    events.onmessage = (e) => {
      offline = false;
      const previous = snap;
      snap = JSON.parse(e.data);
      snapAt = performance.now();
      if (snap.game.moveCount !== seenMove) {
        seenMove = snap.game.moveCount;
        sel = { card: null, from: null };
        hint = '';
        viewPly = null; // a new move snaps the board back to the live position
      }
      announce(previous, snap);
      render();
    };
    events.addEventListener('chat', (e) => {
      const data = JSON.parse(e.data);
      chat = data.reset ? data.messages : chat.concat(data.messages);
      renderChat();
    });
    events.onerror = () => {
      offline = true;
      if (snap) render();
    };
    setInterval(updateClocks, 100);
  }

  // Chime when an opponent has been found (the game is ready to start) and when the game ends.
  function announce(previous, current) {
    const fresh = bothSeated(current) && !current.game.winner && current.game.moveCount === 0;
    const wasReady = previous && bothSeated(previous) && !previous.game.winner;
    const started = current.you && fresh && !wasReady;
    const ended = previous && !previous.game.winner && current.game.winner;
    if (started || ended) chime();
  }

  async function copyLink() {
    const input = $('share-link');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    $('copy').textContent = 'Copied!';
    setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
  }

  async function act(pathname, body) {
    try {
      await post(`/${room}${pathname}`, { token, ...body });
    } catch (err) {
      hint = err.message;
      render();
    }
  }

  // Resigning takes two clicks, like lichess.
  function onResign() {
    if (resignArmed) {
      resignArmed = false;
      return act('/resign', {});
    }
    resignArmed = true;
    render();
    setTimeout(() => {
      resignArmed = false;
      if (snap) render();
    }, 3000);
  }

  // The offer (draw or takeback) the opponent is waiting on us to answer.
  function incomingOffer() {
    if (!snap.you) return null;
    return ['draw', 'takeback'].find((kind) => snap.offers[kind] === other(snap.you)) || null;
  }

  function answerOffer(answer) {
    const kind = incomingOffer();
    if (kind) act(`/${kind}`, { answer });
  }

  function bindChat() {
    $('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $('chat-input').value.trim();
      if (!text) return;
      $('chat-input').value = '';
      act('/chat', { text });
    });
  }

  // Account name of the player in a seat, or the seat colour for anonymous players.
  function nameOf(color) {
    const player = snap && snap.players[color];
    return player ? player.name : NAME[color];
  }

  function renderChat() {
    const list = $('chat-list');
    list.replaceChildren(
      ...chat.map((message) => {
        const li = document.createElement('li');
        if (message.from === 'system') {
          li.className = 'system';
          li.textContent = message.text;
        } else {
          li.innerHTML = `<b class="${message.from}"></b>`;
          li.firstChild.textContent = nameOf(message.from);
          li.append(message.text);
        }
        return li;
      })
    );
    list.scrollTop = list.scrollHeight;
  }

  // ---------- replay ----------

  function isLive() {
    return viewPly === null || viewPly >= snap.game.history.length;
  }

  function goTo(ply) {
    const total = snap.game.history.length;
    const clamped = Math.max(0, Math.min(total, ply));
    viewPly = clamped === total ? null : clamped;
    sel = { card: null, from: null };
    render();
  }

  function step(where) {
    if (!snap) return;
    const total = snap.game.history.length;
    const current = isLive() ? total : viewPly;
    goTo({ first: 0, prev: current - 1, next: current + 1, last: total }[where]);
  }

  function bindReplay() {
    for (const button of document.querySelectorAll('#replay button')) {
      button.addEventListener('click', () => step(button.dataset.go));
    }
    document.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      const where = { ArrowLeft: 'prev', ArrowRight: 'next', ArrowUp: 'first', ArrowDown: 'last' }[e.key];
      if (!where) return;
      e.preventDefault();
      step(where);
    });
  }

  // ---------- playing ----------

  function canAct() {
    const g = snap.game;
    return !!snap.you && !g.winner && g.turn === snap.you && bothSeated(snap) && isLive();
  }

  function onCard(name) {
    if (!canAct()) return;
    if (!legalMoves(snap.game).length) return act('/pass', { card: name });
    sel.card = sel.card === name ? null : name;
    hint = '';
    render();
  }

  function onCell(index) {
    if (!canAct()) return;
    const g = snap.game;
    const me = snap.you;
    const piece = g.board[index];
    if (piece && piece.c === me) {
      sel.from = sel.from === index ? null : index;
      hint = '';
      return render();
    }
    if (sel.from === null) return;
    const cards = g.hands[me].filter(
      (card) => (!sel.card || sel.card === card) && movesFor(g, me, card, sel.from).includes(index)
    );
    if (!cards.length) return;
    if (cards.length > 1) {
      hint = 'Both of your cards allow that move — pick the card to use.';
      return render();
    }
    act('/move', { card: cards[0], from: sel.from, to: index });
  }

  // ---------- rendering ----------

  function cardEl(name, tint, flipped, onClick) {
    const el = document.createElement(onClick ? 'button' : 'div');
    el.className = `card ${tint}`;
    // Grid shows moves around the centre square; flipped = seen from across the table.
    const marks = new Set(
      CARDS[name].moves.map(([dx, dy]) => (flipped ? (2 + dy) * 5 + (2 - dx) : (2 - dy) * 5 + (2 + dx)))
    );
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    for (let i = 0; i < 25; i++) {
      const sq = document.createElement('i');
      if (i === 12) sq.className = 'c';
      else if (marks.has(i)) sq.className = 'm';
      grid.appendChild(sq);
    }
    const label = document.createElement('div');
    label.className = 'card-name';
    label.innerHTML = `<span class="stamp ${CARDS[name].stamp}"></span>`;
    label.append(name);
    el.append(grid, label);
    if (onClick) el.addEventListener('click', onClick);
    return el;
  }

  function presenceNote(color) {
    if (analysis) return '';
    if (!snap.seated[color]) return 'not joined yet';
    if (!snap.online[color]) return 'disconnected';
    return '';
  }

  function clockMs(color) {
    let ms = snap.clock.remaining[color];
    if (snap.clock.running === color) ms -= performance.now() - snapAt;
    return Math.max(0, ms);
  }

  function clockText(ms) {
    if (ms < 10000) return `0:${(Math.floor(ms / 100) / 10).toFixed(1).padStart(4, '0')}`;
    const seconds = Math.ceil(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function updateClocks() {
    if (!snap || !snap.clock) return;
    for (const el of document.querySelectorAll('.clock[data-color]')) {
      const ms = clockMs(el.dataset.color);
      el.textContent = clockText(ms);
      el.classList.toggle('low', ms < 20000);
    }
  }

  // "name 1500 +8": a link to the profile for signed-in players, with the rating change once known.
  function identity(color) {
    const player = snap.players[color];
    const wrap = document.createElement('span');
    wrap.className = 'identity';
    const name = document.createElement(player ? 'a' : 'span');
    name.className = 'name';
    name.textContent = nameOf(color);
    wrap.append(name);
    if (player) {
      name.href = profileHref(player.name);
      const rating = document.createElement('span');
      rating.className = 'rating';
      rating.textContent = ratingText(player);
      wrap.append(rating);
      const diff = snap.result && snap.result.diffs[color];
      if (diff !== null && diff !== undefined) {
        const change = document.createElement('span');
        change.className = `diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'}`;
        change.textContent = diff > 0 ? `+${diff}` : diff < 0 ? `−${-diff}` : '±0';
        wrap.append(change);
      }
    }
    return wrap;
  }

  function playerBar(el, color) {
    const g = snap.game;
    const toMove = !g.winner && g.turn === color && bothSeated(snap);
    el.className = `player${toMove ? ' turn' : ''}${snap.clock ? ' timed' : ''}`;
    el.innerHTML =
      `<span class="dot${snap.online[color] ? ' on' : ''}"></span><span class="swatch ${color}"></span>` +
      '<span class="note"></span>' +
      (snap.clock ? `<span class="clock" data-color="${color}"></span>` : '<span class="clock">To move</span>');
    el.querySelector('.note').before(identity(color));
    el.querySelector('.note').textContent = presenceNote(color);
  }

  function renderInfo() {
    const mode = snap.rated ? 'Rated' : 'Casual';
    $('info-title').textContent = `${analysis ? 'Analysis • ' : ''}${snap.tc || 'Unlimited'} • ${mode} • Onitama`;
    $('info-players').replaceChildren(
      ...['red', 'blue'].map((color) => {
        const row = document.createElement('div');
        row.innerHTML = `<span class="swatch ${color}"></span><span class="me"></span>`;
        row.querySelector('.me').before(identity(color));
        row.querySelector('.me').textContent = snap.you === color ? '(you)' : '';
        return row;
      })
    );
    const n = snap.spectators;
    $('watchers').textContent = n ? `${n} spectator${n === 1 ? '' : 's'}` : '';
  }

  function renderMoves() {
    const g = snap.game;
    const current = isLive() ? g.history.length : viewPly;
    const items = [];
    g.history.forEach((move, i) => {
      if (i % 2 === 0) {
        const n = document.createElement('li');
        n.className = 'n';
        n.textContent = i / 2 + 1;
        items.push(n);
      }
      const li = document.createElement('li');
      li.className = `mv${i + 1 === current ? ' current' : ''}`;
      const text = move.from === null ? 'pass' : `${square(move.from)}${move.captured ? 'x' : '-'}${square(move.to)}`;
      li.innerHTML = `<span class="swatch ${move.color}"></span><span></span><b></b>`;
      li.children[1].textContent = text;
      li.children[2].textContent = move.card;
      li.addEventListener('click', () => goTo(i + 1));
      items.push(li);
    });
    const list = $('moves');
    list.replaceChildren(...items);
    if (current !== shownPly) {
      shownPly = current;
      const active = list.querySelector('.current');
      if (active) list.scrollTop = active.offsetTop - list.clientHeight / 2;
      else list.scrollTop = 0;
    }
    const buttons = document.querySelectorAll('#replay button');
    buttons[0].disabled = buttons[1].disabled = current === 0;
    buttons[2].disabled = buttons[3].disabled = current === g.history.length;
  }

  function renderBoard(shown, view, active) {
    const me = snap.you;
    const targets = new Set();
    if (active && sel.from !== null) {
      for (const card of shown.hands[me]) {
        if (sel.card && sel.card !== card) continue;
        for (const to of movesFor(shown, me, card, sel.from)) targets.add(to);
      }
    }
    const cells = [];
    for (let pos = 0; pos < 25; pos++) {
      const index = view === 'blue' ? 24 - pos : pos;
      const row = Math.floor(pos / 5);
      const col = pos % 5;
      const piece = shown.board[index];
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.setAttribute('role', 'gridcell');
      if ((row + col) % 2 === 0) cell.classList.add('dark');
      if (index === TEMPLE.red) cell.classList.add('temple-red');
      if (index === TEMPLE.blue) cell.classList.add('temple-blue');
      if (shown.last && (shown.last.from === index || shown.last.to === index)) cell.classList.add('last');
      if (sel.from === index) cell.classList.add('selected');
      if (active && piece && piece.c === me) cell.classList.add('mine');
      if (targets.has(index)) {
        cell.classList.add('target');
        if (piece) cell.classList.add('capture');
      }
      let html = '';
      if (row === 4) html += `<span class="coord file">${fileOf(index)}</span>`;
      if (col === 4) html += `<span class="coord rank">${rankOf(index)}</span>`;
      if (piece) {
        const kind = piece.m ? 'master' : 'student';
        html += `<svg class="piece ${piece.c} ${kind}" viewBox="0 0 40 40" aria-hidden="true">${PIECE_SVG[kind]}</svg>`;
      }
      cell.innerHTML = html;
      cell.setAttribute('aria-label', piece ? `${square(index)}, ${piece.c} ${piece.m ? 'master' : 'student'}` : square(index));
      cell.addEventListener('click', () => onCell(index));
      cells.push(cell);
    }
    $('board').replaceChildren(...cells);
  }

  function resultText(g) {
    if (g.winner === 'draw') return 'Draw by mutual agreement';
    const loser = nameOf(other(g.winner));
    const how = {
      stone: `${loser}'s master captured`,
      stream: 'Temple reached',
      resign: `${loser} resigned`,
      time: `${loser} ran out of time`,
    }[g.winReason];
    return `${how} • ${nameOf(g.winner)} is victorious`;
  }

  function renderStatus(active, waiting, stuck) {
    const g = snap.game;
    const me = snap.you;
    const status = $('status');
    status.className = '';
    if (!isLive()) {
      status.textContent = `Viewing move ${viewPly} of ${g.history.length}`;
      return;
    }
    if (g.winner) {
      status.className = 'win';
      status.innerHTML = '<span class="result"></span><span></span>';
      status.children[0].textContent =
        g.winner === 'draw' ? 'Draw' : !me ? `${nameOf(g.winner)} wins` : g.winner === me ? 'You win!' : 'You lose';
      status.children[1].textContent = resultText(g);
      return;
    }
    let text;
    if (analysis) text = 'Game in progress';
    else if (offline) text = 'Connection lost — reconnecting…';
    else if (hint) text = hint;
    else if (waiting) text = me ? 'Waiting for your opponent to join…' : 'Waiting for players…';
    else if (!me) text = `You are spectating • ${nameOf(g.turn)} to move`;
    else if (snap.offers.draw === me) text = 'Draw offer sent';
    else if (snap.offers.takeback === me) text = 'Takeback request sent';
    else if (stuck) text = 'No legal move — choose a card to give up.';
    else if (active) text = sel.from === null ? 'Your turn — pick a piece and a card.' : 'Choose where to move.';
    else text = "Waiting for your opponent's move…";
    if (offline || hint) status.className = 'warn';
    status.textContent = text;
  }

  function renderControls(waiting) {
    const g = snap.game;
    const me = snap.you;
    const playing = !!me && !g.winner && !waiting;

    const incoming = playing ? incomingOffer() : null;
    $('offer').hidden = !incoming;
    $('offer-text').textContent =
      incoming === 'draw' ? 'Your opponent offers a draw' : 'Your opponent proposes a takeback';

    const takeback = $('takeback');
    takeback.hidden = !playing;
    takeback.disabled = playing && (snap.offers.takeback === me || g.history.length - (g.turn === me ? 2 : 1) < 0);
    const draw = $('draw');
    draw.hidden = !playing;
    draw.disabled = playing && snap.offers.draw === me;
    const resign = $('resign');
    resign.hidden = !playing;
    resign.textContent = resignArmed ? 'Click again to resign' : '⚑ Resign';
    resign.classList.toggle('armed', resignArmed);

    $('rematch').hidden = !(g.winner && me);
    const link = $('analysis');
    link.hidden = analysis || !g.winner || !g.history.length;
    if (!link.hidden) link.href = analysisHref(g);
  }

  function render() {
    const g = snap.game;
    const me = snap.you;
    const view = me || 'red'; // spectators watch from Red's side
    const opp = other(view);
    const active = canAct();
    const waiting = !bothSeated(snap);
    const stuck = active && legalMoves(g).length === 0;
    const shown = isLive() ? g : Onitama.replay(g, viewPly);

    renderInfo();
    playerBar($('opp-label'), opp);
    playerBar($('my-label'), view);
    updateClocks();

    $('opp-hand').replaceChildren(...shown.hands[opp].map((name) => cardEl(name, opp, true, null)));
    $('my-hand').replaceChildren(
      ...shown.hands[view].map((name) => {
        const el = cardEl(name, view, false, active ? () => onCard(name) : null);
        if (sel.card === name) el.classList.add('selected');
        else if (active && sel.card) el.classList.add('dim');
        return el;
      })
    );

    // Spare card faces whoever picks it up next, i.e. the player about to move.
    $('spare').replaceChildren(cardEl(shown.spare, 'neutral', shown.turn !== view, null));
    const next = !me ? nameOf(shown.turn) : shown.turn === me ? 'you' : 'your opponent';
    $('spare-label').textContent = shown.winner ? '' : `Goes to ${next} after this move`;

    renderBoard(shown, view, active);
    renderMoves();
    renderStatus(active, waiting, stuck);
    renderControls(waiting);
    if (!analysis) renderChat(); // names in the chat follow the players

    $('share').hidden = !(waiting && me);
    $('replay').hidden = $('moves-scroll').hidden = waiting;
    $('chat-form').hidden = !me;
    document.title = analysis ? 'Analysis — Onitama' : active ? 'Your turn — Onitama' : 'Onitama';
  }

  // ---------- start ----------

  async function boot() {
    try {
      const me = await request('GET', '/api/me');
      accountsOn = me.accounts;
      googleOn = me.google;
      account = me.user;
    } catch { /* accounts stay off */ }
    renderAccount();
    bindDialogs();

    if (params.get('user')) showProfile(params.get('user'));
    else if (params.get('game')) startStoredAnalysis(params.get('game'));
    else if (params.get('analysis')) startUrlAnalysis(params.get('analysis'));
    else if (room) startGame();
    else showLobby(params.has('signin') ? 'Google sign-in did not complete. Please try again.' : '');
  }

  boot();
})();
