/* global Onitama */
(function () {
  'use strict';

  const { CARDS, TEMPLE, other, newGame, movesFor, legalMoves } = Onitama;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let room = (params.get('room') || '').toUpperCase();
  const watching = params.has('watch'); // spectate without taking a seat
  let analysis = false; // showing a finished game instead of a live room
  const TIMES_KEY = 'onitama:move-times';
  let showTimes = true; // the analysis board lists how long each move took
  try { showTimes = localStorage.getItem(TIMES_KEY) !== 'off'; } catch { /* private mode */ }

  const NAME = { red: 'Red', blue: 'Blue' };
  // Piece shapes, drawn in a 40×40 box and filled with the owner's colour.
  const PIECE_SETS = {
    classic: {
      label: 'Classic',
      student: '<circle cx="20" cy="12" r="7"/><path d="M9 35c0-9 4-14 11-14s11 5 11 14z"/>',
      master: '<path d="M6 11l7 7 7-12 7 12 7-7-3 16H9z"/><rect x="8" y="29" width="24" height="6" rx="2"/>',
    },
    discs: {
      label: 'Discs',
      student: '<circle cx="20" cy="20" r="13"/><circle cx="20" cy="20" r="7.5" fill="none"/>',
      master: '<circle cx="20" cy="20" r="16"/><path d="M11 26l-2-11 5.5 5 5.5-9 5.5 9 5.5-5-2 11z" fill="#fff" fill-opacity="0.9"/>',
    },
    tiles: {
      label: 'Tiles',
      student: '<path d="M20 6l9 5 3 23H8l3-23z"/><path d="M15 27h10" fill="none"/>',
      master: '<path d="M20 3l11 6 4 27H5l4-27z"/><circle cx="20" cy="21" r="5.5" fill="#fff" fill-opacity="0.9"/>',
    },
  };

  // Squares are named like chess, from Red's side: files a–e, ranks 1–5.
  const fileOf = (index) => 'abcde'[index % 5];
  const rankOf = (index) => 5 - Math.floor(index / 5);
  const square = (index) => fileOf(index) + rankOf(index);

  // Signed-in account and what the server supports (from /api/me).
  let account = null;
  let accountsOn = false;
  let donateUrl = null; // where the Donate page sends people, when the server has one
  let googleOn = false;
  let mailOn = false; // the server can send email: confirmation and password recovery

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
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { data });
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
  // "name (1500)" for an account, just the name for a bot.
  const nameAndRating = (player) => (player.bot ? player.name : `${player.name} (${ratingText(player)})`);
  const profileHref = (name) => `/?user=${encodeURIComponent(name)}`;

  // ---------- sound ----------
  // Every sound is synthesized. A theme has a move, a capture and an alert (game
  // started, game over) sound; in the options menu the player picks one theme
  // for the pieces and one for the alert.

  const SOUND_KEY = 'onitama:sound';
  const sound = { move: 'wood', alert: 'wood', volume: 0.6 };
  try {
    const saved = JSON.parse(localStorage.getItem(SOUND_KEY)) || {};
    if (saved.theme) saved.move = saved.alert = saved.theme; // from when one theme covered everything
    for (const key of ['move', 'alert']) if (typeof saved[key] === 'string') sound[key] = saved[key];
    if (typeof saved.volume === 'number') sound.volume = saved.volume;
  } catch { /* keep the defaults */ }

  let audio = null; // { ctx, out } once the first sound is asked for
  function audioOutput() {
    if (!audio) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      const ctx = new Ctor();
      const out = ctx.createGain(); // master volume
      out.connect(ctx.destination);
      audio = { ctx, out };
    }
    audio.out.gain.value = sound.volume;
    return audio;
  }
  // Browsers only allow sound after the user has interacted with the page.
  document.addEventListener('pointerdown', () => { const a = audioOutput(); if (a) a.ctx.resume(); }, { once: true });

  // A note that fades out: `freq` Hz (gliding to `to` if given), `gain` loud, gone after `decay` seconds.
  function tone(a, at, { freq, to, gain, decay, type }) {
    const osc = a.ctx.createOscillator();
    const env = a.ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, at);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, at + decay);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(env).connect(a.out);
    osc.start(at);
    osc.stop(at + decay + 0.02);
  }

  // A burst of noise around `freq` Hz lasting `length` seconds: the "tick" of something hard.
  function tick(a, at, { freq, q, gain, length }) {
    const count = Math.floor(a.ctx.sampleRate * length);
    const buffer = a.ctx.createBuffer(1, count, a.ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / count) ** 2;
    const source = a.ctx.createBufferSource();
    source.buffer = buffer;
    const filter = a.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = a.ctx.createGain();
    env.gain.value = gain;
    source.connect(filter).connect(env).connect(a.out);
    source.start(at);
  }

  // Wood struck by wood: a few milliseconds of noise (the impact) set three
  // resonances ringing, as the body of a wooden piece or block would. `freq` is
  // the lowest resonance, `ring` how many seconds it sounds for. Pitch and the
  // noise itself differ a little on every strike, so repeated moves don't sound stamped.
  function knock(a, at, { freq, gain, ring }) {
    const count = Math.floor(a.ctx.sampleRate * 0.005);
    const buffer = a.ctx.createBuffer(1, count, a.ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) samples[i] = (Math.random() * 2 - 1) * (1 - i / count);
    const source = a.ctx.createBufferSource();
    source.buffer = buffer;
    const pitch = freq * (0.96 + Math.random() * 0.08);
    for (const [ratio, level, length] of [[1, 1, 1], [2.45, 0.45, 0.55], [4.9, 0.2, 0.3]]) {
      const mode = a.ctx.createBiquadFilter();
      mode.type = 'bandpass';
      mode.frequency.value = pitch * ratio;
      mode.Q.value = Math.max(1, Math.PI * pitch * ratio * ring * length * 0.3);
      const env = a.ctx.createGain();
      env.gain.value = gain * level * Math.sqrt(mode.Q.value);
      source.connect(mode).connect(env).connect(a.out);
    }
    source.start(at);
  }

  const SOUND_THEMES = {
    wood: {
      label: 'Soft wood',
      move: (a, t) => knock(a, t, { freq: 620, gain: 1.1, ring: 0.05 }),
      capture: (a, t) => { knock(a, t, { freq: 880, gain: 0.9, ring: 0.035 }); knock(a, t + 0.075, { freq: 540, gain: 1.2, ring: 0.06 }); },
      alert: (a, t) => { knock(a, t, { freq: 660, gain: 1.7, ring: 0.12 }); knock(a, t + 0.15, { freq: 880, gain: 1.7, ring: 0.14 }); },
    },
    click: {
      label: 'Click',
      move: (a, t) => tick(a, t, { freq: 4200, q: 1, gain: 0.35, length: 0.012 }),
      capture: (a, t) => { tick(a, t, { freq: 4200, q: 1, gain: 0.35, length: 0.012 }); tick(a, t + 0.05, { freq: 3200, q: 1, gain: 0.4, length: 0.015 }); },
      alert: (a, t) => tone(a, t, { freq: 880, gain: 0.1, decay: 0.22 }),
    },
    marimba: {
      label: 'Marimba',
      move: (a, t) => { tone(a, t, { freq: 523.25, gain: 0.16, decay: 0.16 }); tone(a, t, { freq: 2093, gain: 0.03, decay: 0.05 }); },
      capture: (a, t) => { tone(a, t, { freq: 392, gain: 0.16, decay: 0.16 }); tone(a, t + 0.07, { freq: 523.25, gain: 0.16, decay: 0.18 }); },
      alert: (a, t) => { [523.25, 659.25, 783.99].forEach((freq, i) => tone(a, t + i * 0.09, { freq, gain: 0.14, decay: 0.3 })); },
    },
    glass: {
      label: 'Glass',
      move: (a, t) => { tone(a, t, { freq: 1318.5, gain: 0.07, decay: 0.2 }); tone(a, t, { freq: 2637, gain: 0.02, decay: 0.12 }); },
      capture: (a, t) => { tone(a, t, { freq: 1318.5, gain: 0.07, decay: 0.2 }); tone(a, t + 0.06, { freq: 1760, gain: 0.07, decay: 0.25 }); },
      alert: (a, t) => { tone(a, t, { freq: 1046.5, gain: 0.08, decay: 0.45 }); tone(a, t + 0.13, { freq: 1568, gain: 0.08, decay: 0.6 }); },
    },
    stone: {
      label: 'Stone',
      move: (a, t) => { tick(a, t, { freq: 3400, q: 4, gain: 0.5, length: 0.018 }); tone(a, t, { freq: 900, to: 700, gain: 0.05, decay: 0.03 }); },
      capture: (a, t) => { SOUND_THEMES.stone.move(a, t); tick(a, t + 0.05, { freq: 2600, q: 4, gain: 0.55, length: 0.022 }); },
      alert: (a, t) => { tick(a, t, { freq: 3000, q: 5, gain: 0.5, length: 0.02 }); tick(a, t + 0.12, { freq: 3800, q: 5, gain: 0.5, length: 0.02 }); },
    },
    felt: {
      label: 'Felt',
      move: (a, t) => tick(a, t, { freq: 420, q: 0.8, gain: 0.7, length: 0.05 }),
      capture: (a, t) => { tick(a, t, { freq: 420, q: 0.8, gain: 0.7, length: 0.05 }); tick(a, t + 0.07, { freq: 320, q: 0.8, gain: 0.8, length: 0.06 }); },
      alert: (a, t) => { tone(a, t, { freq: 330, gain: 0.12, decay: 0.35 }); tone(a, t + 0.14, { freq: 440, gain: 0.12, decay: 0.45 }); },
    },
    pop: {
      label: 'Pop',
      move: (a, t) => tone(a, t, { freq: 420, to: 900, gain: 0.14, decay: 0.06 }),
      capture: (a, t) => { tone(a, t, { freq: 420, to: 900, gain: 0.14, decay: 0.06 }); tone(a, t + 0.07, { freq: 560, to: 1200, gain: 0.14, decay: 0.06 }); },
      alert: (a, t) => { [500, 650, 820].forEach((freq, i) => tone(a, t + i * 0.07, { freq, to: freq * 1.8, gain: 0.12, decay: 0.07 })); },
    },
    drop: {
      label: 'Water drop',
      move: (a, t) => tone(a, t, { freq: 1400, to: 600, gain: 0.12, decay: 0.09 }),
      capture: (a, t) => { tone(a, t, { freq: 1400, to: 600, gain: 0.12, decay: 0.09 }); tone(a, t + 0.08, { freq: 1100, to: 450, gain: 0.12, decay: 0.11 }); },
      alert: (a, t) => { tone(a, t, { freq: 900, to: 1500, gain: 0.1, decay: 0.12 }); tone(a, t + 0.13, { freq: 1200, to: 2000, gain: 0.1, decay: 0.16 }); },
    },
    pluck: {
      label: 'Pluck',
      move: (a, t) => tone(a, t, { freq: 329.63, gain: 0.14, decay: 0.22, type: 'triangle' }),
      capture: (a, t) => { tone(a, t, { freq: 246.94, gain: 0.14, decay: 0.2, type: 'triangle' }); tone(a, t + 0.08, { freq: 329.63, gain: 0.14, decay: 0.25, type: 'triangle' }); },
      alert: (a, t) => { [329.63, 415.3, 493.88].forEach((freq, i) => tone(a, t + i * 0.1, { freq, gain: 0.13, decay: 0.4, type: 'triangle' })); },
    },
    bell: {
      label: 'Bell',
      move: (a, t) => { tone(a, t, { freq: 880, gain: 0.07, decay: 0.35 }); tone(a, t, { freq: 2424, gain: 0.025, decay: 0.2 }); },
      capture: (a, t) => { SOUND_THEMES.bell.move(a, t); tone(a, t + 0.08, { freq: 1174.7, gain: 0.07, decay: 0.4 }); },
      alert: (a, t) => { [[783.99, 0], [1046.5, 0.16]].forEach(([freq, delay]) => { tone(a, t + delay, { freq, gain: 0.09, decay: 0.9 }); tone(a, t + delay, { freq: freq * 2.76, gain: 0.03, decay: 0.5 }); }); },
    },
    retro: {
      label: 'Retro',
      move: (a, t) => tone(a, t, { freq: 660, gain: 0.05, decay: 0.05, type: 'square' }),
      capture: (a, t) => { tone(a, t, { freq: 440, gain: 0.05, decay: 0.05, type: 'square' }); tone(a, t + 0.06, { freq: 880, gain: 0.05, decay: 0.06, type: 'square' }); },
      alert: (a, t) => { [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => tone(a, t + i * 0.07, { freq, gain: 0.05, decay: 0.08, type: 'square' })); },
    },
    off: { label: 'No sound' },
  };

  // Plays 'move', 'capture' or 'alert' in the theme chosen for it (or in `theme`, for previews).
  function playSound(kind, theme) {
    const chosen = theme || (kind === 'alert' ? sound.alert : sound.move);
    const play = (SOUND_THEMES[chosen] || SOUND_THEMES.wood)[kind];
    const a = play && audioOutput();
    if (!a) return;
    const asked = performance.now();
    a.ctx.resume().then(() => {
      if (performance.now() - asked > 500) return; // unlocked too late to be meaningful
      play(a, a.ctx.currentTime + 0.02);
    }).catch(() => {});
  }

  // ---------- menu: account, sound, theme, board, piece set ----------

  const PREFS_KEY = 'onitama:prefs';
  const THEMES = { dark: 'Dark', light: 'Light' };
  const BOARDS = {
    brown: { label: 'Brown', light: '#f0d9b5', dark: '#b58863' },
    blue: { label: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
    green: { label: 'Green', light: '#ffffdd', dark: '#86a666' },
    grey: { label: 'Grey', light: '#dcdcdc', dark: '#8f8f8f' },
    sand: { label: 'Sand', light: '#efe3c0', dark: '#c9b27c' },
    purple: { label: 'Purple', light: '#e8e0f0', dark: '#9f90b0' },
  };
  const prefs = { theme: 'dark', board: 'brown', pieces: 'classic' };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    if (Object.hasOwn(THEMES, saved.theme)) prefs.theme = saved.theme;
    if (Object.hasOwn(BOARDS, saved.board)) prefs.board = saved.board;
    if (Object.hasOwn(PIECE_SETS, saved.pieces)) prefs.pieces = saved.pieces;
  } catch { /* keep the defaults */ }

  function applyPrefs() {
    const root = document.documentElement;
    root.dataset.theme = prefs.theme;
    root.dataset.pieces = prefs.pieces;
    root.style.setProperty('--sq-light', BOARDS[prefs.board].light);
    root.style.setProperty('--sq-dark', BOARDS[prefs.board].dark);
  }
  applyPrefs();

  const pieceSvg = (set, color, kind, extra) =>
    `<svg class="piece ${color} ${kind}${extra || ''}" viewBox="0 0 40 40" aria-hidden="true">${PIECE_SETS[set][kind]}</svg>`;

  function bindMenu() {
    const panel = $('menu-panel');
    const button = $('menu-button');
    let pingTimer = null;

    const showPage = (name) => {
      for (const page of panel.querySelectorAll('.menu-page')) page.hidden = page.dataset.page !== name;
    };
    const close = () => {
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      clearInterval(pingTimer);
    };
    const open = () => {
      showPage('main');
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      measurePing();
      pingTimer = setInterval(measurePing, 3000);
    };
    button.addEventListener('click', () => (panel.hidden ? open() : close()));
    $('menu-profile').addEventListener('click', close);
    document.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !$('menu').contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) close();
    });
    for (const item of panel.querySelectorAll('[data-open]')) {
      item.addEventListener('click', () => showPage(item.dataset.open));
    }
    for (const back of panel.querySelectorAll('.back')) back.addEventListener('click', () => showPage('main'));

    // Sound: one list of themes per kind of sound; choosing one plays it.
    const saveSound = () => {
      try { localStorage.setItem(SOUND_KEY, JSON.stringify(sound)); } catch { /* private mode */ }
    };
    for (const [setting, id] of [['move', 'option-move-sound'], ['alert', 'option-alert-sound']]) {
      const select = $(id);
      for (const [key, theme] of Object.entries(SOUND_THEMES)) select.add(new Option(theme.label, key));
      select.value = sound[setting];
      select.addEventListener('change', () => {
        sound[setting] = select.value;
        saveSound();
        playSound(setting);
      });
    }
    for (const play of panel.querySelectorAll('[data-play]')) {
      play.addEventListener('click', () => playSound(play.dataset.play));
    }
    const volume = $('option-volume');
    volume.value = Math.round(sound.volume * 100);
    volume.addEventListener('input', () => {
      sound.volume = Number(volume.value) / 100;
      saveSound();
    });
    volume.addEventListener('change', () => playSound('move'));

    // Theme, board and piece set: a list each, applied as soon as one is picked.
    const choices = (containerId, setting, options, decorate) => {
      const draw = () => {
        $(containerId).replaceChildren(
          ...Object.entries(options).map(([key, option]) => {
            const item = document.createElement('button');
            item.className = `menu-item choice${prefs[setting] === key ? ' selected' : ''}`;
            if (decorate) item.innerHTML = decorate(key, option);
            item.append(option.label || option);
            item.addEventListener('click', () => {
              prefs[setting] = key;
              try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
              applyPrefs();
              draw();
              if (snap) render();
            });
            return item;
          })
        );
      };
      draw();
    };
    choices('theme-choices', 'theme', THEMES);
    choices('board-choices', 'board', BOARDS, (key, board) =>
      `<span class="swatch2" style="background: linear-gradient(135deg, ${board.light} 50%, ${board.dark} 50%)"></span>`);
    choices('pieces-choices', 'pieces', PIECE_SETS, (key) => pieceSvg(key, 'red', 'master') + pieceSvg(key, 'blue', 'student'));
  }

  // Round trip to the server and how busy it is, shown at the bottom of the menu.
  async function measurePing() {
    const sent = performance.now();
    let ping = null;
    let server = null;
    try {
      server = (await request('GET', '/api/ping')).lag;
      ping = Math.round(performance.now() - sent);
    } catch { /* offline: show dashes */ }
    $('ping-ms').textContent = ping === null ? '–' : ping;
    $('server-ms').textContent = server === null ? '–' : server;
    const bars = ping === null ? 0 : ping < 150 ? 4 : ping < 300 ? 3 : ping < 500 ? 2 : 1;
    document.querySelectorAll('#signal i').forEach((bar, i) => bar.classList.toggle('on', i < bars));
  }

  // ---------- account bar and sign-in dialog ----------

  function renderAccount() {
    $('signin').hidden = !accountsOn || !!account;
    $('menu-account').hidden = !account;
    $('menu-name').textContent = account ? account.name : '';
    $('menu-rating').textContent = account ? ratingText(account) : '';
    if (account) $('menu-profile').href = profileHref(account.name);
  }

  function bindDialogs() {
    for (const button of document.querySelectorAll('dialog [data-close]')) {
      button.addEventListener('click', () => button.closest('dialog').close());
    }
    $('signin').addEventListener('click', openSignIn);
    $('auth-signup').addEventListener('click', () => $('auth-dialog').close());
    $('auth-resend').addEventListener('click', async () => {
      $('auth-resend').hidden = true;
      await resendVerification($('auth-username').value);
      $('auth-error').textContent = 'We sent the link again. Check your inbox.';
    });
    $('signout').addEventListener('click', async () => {
      await request('POST', '/api/logout', {}).catch(() => {});
      location.reload();
    });
    $('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await request('POST', '/api/login', {
          username: $('auth-username').value,
          password: $('auth-password').value,
        });
        // Back to the lobby from the sign-up page, otherwise stay where you are.
        if (['signup', 'forgot', 'reset'].some((key) => new URLSearchParams(location.search).has(key))) location.href = '/';
        else location.reload();
      } catch (err) {
        $('auth-error').textContent = err.message;
        $('auth-resend').hidden = !(err.data && err.data.unverified);
      }
    });
  }

  function openSignIn() {
    $('google-login').hidden = $('auth-or').hidden = !googleOn;
    $('auth-error').textContent = '';
    $('auth-resend').hidden = true;
    $('auth-forgot').hidden = !mailOn;
    $('auth-dialog').showModal();
  }

  const resendVerification = (username) => request('POST', '/api/verify/resend', { username }).catch(() => {});

  // ---------- creating an account ----------

  // /?signup is the form; /?signup=verified and /?signup=expired are where the emailed link lands.
  function showSignup(state) {
    if (!accountsOn || (account && state !== 'verified')) {
      history.replaceState(null, '', '/');
      return showLobby();
    }
    $('signup').hidden = false;
    document.title = 'Create an account — Onitama';
    signupStep(state === 'expired' || (state === 'verified' && account) ? state : 'form');
    $('signup-google').hidden = $('signup-or').hidden = !googleOn;
    $('signup-error').textContent = '';
  }

  function signupStep(step) {
    $('signup-form').hidden = step !== 'form';
    for (const name of ['sent', 'verified', 'expired', 'forgot', 'forgot-sent', 'reset']) {
      $(`signup-${name}`).hidden = step !== name;
    }
  }

  // /?forgot asks where to send the link; /?reset=TOKEN is where that link lands.
  function showRecover(step) {
    if (!accountsOn) {
      history.replaceState(null, '', '/');
      return showLobby();
    }
    $('signup').hidden = false;
    document.title = 'Recover your account — Onitama';
    $('forgot-error').textContent = $('reset-error').textContent = '';
    signupStep(step);
  }

  function bindRecover() {
    $('auth-forgot').addEventListener('click', () => $('auth-dialog').close());
    $('signup-forgot').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('forgot-error').textContent = '';
      $('forgot-submit').disabled = true;
      try {
        await request('POST', '/api/password/forgot', { login: $('forgot-login').value });
        signupStep('forgot-sent');
      } catch (err) {
        $('forgot-error').textContent = err.message;
      } finally {
        $('forgot-submit').disabled = false;
      }
    });
    $('signup-reset').addEventListener('submit', async (e) => {
      e.preventDefault();
      if ($('reset-password').value !== $('reset-password2').value) {
        $('reset-error').textContent = 'The two passwords are not the same';
        return;
      }
      $('reset-error').textContent = '';
      $('reset-submit').disabled = true;
      try {
        await request('POST', '/api/password/reset', {
          token: new URLSearchParams(location.search).get('reset'),
          password: $('reset-password').value,
        });
        location.href = '/'; // signed in with the new password
      } catch (err) {
        $('reset-error').textContent = err.message;
      } finally {
        $('reset-submit').disabled = false;
      }
    });
  }

  function bindSignup() {
    $('signup-signin').addEventListener('click', openSignIn);
    $('signup-expired-signin').addEventListener('click', openSignIn);
    $('signup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if ($('signup-password').value !== $('signup-password2').value) {
        $('signup-error').textContent = 'The two passwords are not the same';
        return;
      }
      $('signup-error').textContent = '';
      $('signup-submit').disabled = true;
      try {
        const made = await request('POST', '/api/register', {
          username: $('signup-username').value,
          email: $('signup-email').value,
          password: $('signup-password').value,
        });
        if (!made.verify) {
          location.href = '/'; // no email to confirm on this server: already signed in
          return;
        }
        $('signup-sent-email').textContent = made.email;
        $('signup-resend-note').textContent = '';
        $('signup-password').value = $('signup-password2').value = '';
        signupStep('sent');
      } catch (err) {
        $('signup-error').textContent = err.message;
      } finally {
        $('signup-submit').disabled = false;
      }
    });
    $('signup-resend').addEventListener('click', async () => {
      $('signup-resend').disabled = true;
      await resendVerification($('signup-username').value);
      $('signup-resend-note').textContent = 'Sent again. It can take a minute to arrive.';
      setTimeout(() => ($('signup-resend').disabled = false), 60000);
    });
  }

  // ---------- lobby ----------

  // Time controls offered for quick pairing, friends, the computer and tournaments.
  const POOLS = [
    ['1+0', 'Bullet'], ['2+1', 'Bullet'], ['3+0', 'Blitz'],
    ['3+2', 'Blitz'], ['5+0', 'Blitz'], ['5+3', 'Blitz'],
    ['10+0', 'Rapid'], ['10+5', 'Rapid'], ['15+10', 'Rapid'],
    ['30+0', 'Classical'], ['30+20', 'Classical'],
  ];

  function fillTimeControls() {
    for (const id of ['friend-tc', 'bot-tc', 'tournament-form-tc']) {
      for (const [tc, perf] of POOLS) $(id).add(new Option(`${tc} ${perf}`, tc));
    }
    $('tournament-form-tc').value = '3+2';
  }

  let seek = null; // { tc, button, events } while waiting to be paired
  let tv = null; // { game, at } the live game on the lobby's small board

  function showLobby(error) {
    $('lobby').hidden = false;
    $('lobby-error').textContent = error || '';
    $('pool-note').textContent = !accountsOn
      ? ''
      : account
        ? 'Quick pairing is rated when your opponent is signed in too.'
        : 'Sign in to play rated games and keep your match history.';
    $('lobby-tournaments').hidden = $('footer-tournaments').hidden = $('lobby-tours').hidden = !accountsOn;
    refreshLive();
    refreshLobby();
    every(refreshLive, 3000);
    every(refreshLobby, 15000);
    every(renderTvClocks, 500);
  }

  function bindLobby() {
    for (const [tc, perf] of POOLS) {
      const button = document.createElement('button');
      button.className = 'pool';
      button.dataset.tc = tc;
      button.innerHTML = '<span class="tc"></span><span class="perf"></span>';
      button.children[0].textContent = tc;
      button.children[1].textContent = perf;
      button.addEventListener('click', () => toggleSeek(button));
      $('pools').appendChild(button);
    }
    const custom = document.createElement('button');
    custom.className = 'pool custom';
    custom.id = 'pool-custom';
    custom.textContent = 'Custom';
    $('pools').appendChild(custom);
    for (const tab of document.querySelectorAll('#lobby-app .tabs button')) {
      tab.addEventListener('click', () => {
        for (const other of tab.parentNode.children) {
          other.classList.toggle('active', other === tab);
          other.setAttribute('aria-selected', other === tab);
        }
        // Quick pairing keeps its place while hidden, so the live list has exactly its size.
        $('pools').classList.toggle('behind', tab.dataset.tab !== 'pools');
        $('live').hidden = tab.dataset.tab !== 'live';
      });
    }
    bindFriendDialog();
    bindBotDialog();
  }

  // Moves from the lobby or a tournament into a room without a page load, so the
  // click that started it still counts as the interaction browsers require for sound.
  function enterRoom(code) {
    leavePage();
    history.pushState(null, '', `/?room=${code}`);
    room = code;
    startGame();
  }

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
    for (const opener of [$('create'), $('pool-custom')]) {
      opener.addEventListener('click', () => {
        refresh();
        $('friend-dialog').showModal();
      });
    }
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

  function bindBotDialog() {
    const open = () => {
      $('bot-error').textContent = '';
      $('bot-dialog').showModal();
    };
    $('play-bot').addEventListener('click', open);
    $('computer-play').addEventListener('click', open);
    $('bot-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const { room: code } = await post('', { tc: $('bot-tc').value, bot: $('bot-level').value });
        $('bot-dialog').close();
        enterRoom(code);
      } catch (err) {
        $('bot-error').textContent = err.message;
      }
    });
  }

  // The slower-moving parts of the lobby: leaderboard and tournaments.
  async function refreshLobby() {
    if (!accountsOn) return;
    refreshTournaments();
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

  // "in 2 hours", "in 5 minutes"
  function inTime(ms) {
    const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    const minutes = Math.max(1, Math.round((ms - Date.now()) / 60000));
    if (minutes < 60) return format.format(minutes, 'minute');
    if (minutes < 60 * 36) return format.format(Math.round(minutes / 60), 'hour');
    return format.format(Math.round(minutes / 1440), 'day');
  }

  // Running and upcoming tournaments, in the box left of quick pairing.
  async function refreshTournaments() {
    let open;
    try {
      const list = (await request('GET', '/api/tournaments')).tournaments;
      open = list.filter((t) => t.status !== 'finished').sort((a, b) => a.startsAt - b.startsAt);
    } catch {
      return; // next poll retries
    }
    const now = Date.now();
    const playersText = (t) => `${t.players} player${t.players === 1 ? '' : 's'}`;
    $('lobby-tours-empty').hidden = open.length > 0;
    $('lobby-tours-list').replaceChildren(
      ...open.slice(0, 5).map((t) => {
        const length = t.minutes * 60000;
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="name"><a></a></td><td class="players"></td>' +
          '<td class="progress"><span class="bar"><i></i><span></span></span></td>';
        tr.querySelector('a').textContent = t.name;
        tr.querySelector('a').href = tournamentHref(t.id);
        const running = t.status === 'running';
        const left = Math.max(1, Math.round((t.startsAt + length - now) / 60000));
        tr.querySelector('.bar i').style.width = running ? `${Math.min(100, ((now - t.startsAt) / length) * 100)}%` : '0';
        tr.querySelector('.bar span').textContent = running
          ? `${left} minute${left === 1 ? '' : 's'} remaining`
          : inTime(t.startsAt);
        tr.querySelector('.players').textContent = playersText(t);
        tr.addEventListener('click', () => navigate(tournamentHref(t.id)));
        return tr;
      })
    );
  }

  async function refreshLive() {
    let data;
    try {
      data = await request('GET', '/api/rooms');
    } catch {
      return; // keep the last list; the next poll retries
    }
    const games = data.games;
    $('count-online').textContent = data.online.toLocaleString();
    $('count-playing').textContent = data.playing.toLocaleString();
    renderTv(games);
    $('live-empty').hidden = games.length > 0;
    const who = (player) => (player ? nameAndRating(player) : 'Anonymous');
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
        tr.addEventListener('click', () => navigate(href));
        return tr;
      })
    );
  }

  // The small board shows one live game and stays on it until it ends; the next
  // pick is the game with the strongest player. With nothing to show it holds
  // the starting position.
  function renderTv(games) {
    const strength = (game) =>
      Math.max(...['red', 'blue'].map((color) => (game.players[color] && game.players[color].rating) || 0));
    const game =
      games.find((g) => tv && tv.game && g.room === tv.game.room) ||
      [...games].sort((a, b) => strength(b) - strength(a))[0] ||
      null;
    tv = { game, at: performance.now() };
    const link = $('lobby-tv');
    if (game) link.href = `/?room=${game.room}&watch`;
    else link.removeAttribute('href');
    const board = game ? game.board : newGame().board;
    const cells = board.map((piece, index) => {
      const cell = document.createElement('span');
      cell.className = 'cell';
      if ((Math.floor(index / 5) + (index % 5)) % 2 === 0) cell.classList.add('dark');
      if (index === TEMPLE.red) cell.classList.add('temple-red');
      if (index === TEMPLE.blue) cell.classList.add('temple-blue');
      if (game && game.last && (game.last.from === index || game.last.to === index)) cell.classList.add('last');
      if (piece) cell.innerHTML = pieceSvg(prefs.pieces, piece.c, piece.m ? 'master' : 'student', piece.c === 'red' ? '' : ' far');
      return cell;
    });
    $('tv-board').replaceChildren(...cells);
    const label = (el, color) => {
      const player = game && game.players[color];
      el.innerHTML = '<i class="turn-dot"></i><span class="name"></span><span class="rating"></span>';
      el.firstChild.classList.add(color);
      el.children[1].textContent = !game ? { blue: 'Onitama TV', red: 'No game in play' }[color] : player ? player.name : 'Anonymous';
      el.children[2].textContent = player && !player.bot ? ratingText(player) : '';
      el.firstChild.hidden = !game;
    };
    label($('tv-top'), 'blue');
    label($('tv-bottom'), 'red');
    renderTvClocks();
  }

  function renderTvClocks() {
    const clock = tv && tv.game && tv.game.clock;
    for (const [id, color] of [['tv-top-clock', 'blue'], ['tv-bottom-clock', 'red']]) {
      let ms = clock ? clock.remaining[color] : 0;
      if (clock && clock.running === color) ms = Math.max(0, ms - (performance.now() - tv.at));
      $(id).textContent = clock ? clockText(ms) : '';
      $(id).classList.toggle('running', !!clock && clock.running === color);
    }
  }

  // ---------- donate ----------

  function showDonate() {
    $('donate').hidden = false;
    document.title = 'Donate — Onitama';
    if (donateUrl) $('donate-link').href = donateUrl;
    $('donate-link').hidden = !donateUrl;
    $('donate-closed').hidden = !!donateUrl;
  }

  // ---------- how the computer plays ----------

  function showComputer() {
    $('computer').hidden = false;
    document.title = 'How the computer plays — Onitama';
  }

  // ---------- profile and match history ----------

  // "3h 20m", or just minutes under an hour.
  function playedText(seconds) {
    const minutes = Math.round((seconds || 0) / 60);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  async function showProfile(name) {
    const mine = visit;
    let data;
    try {
      data = await request('GET', `/api/users/${encodeURIComponent(name)}`);
    } catch (err) {
      if (mine !== visit) return;
      history.replaceState(null, '', '/');
      return showLobby(err.message);
    }
    if (mine !== visit) return; // the visitor has moved on to another page
    const user = data.user;
    $('profile').hidden = false;
    document.title = `${user.name} — Onitama`;
    $('profile-name').textContent = user.name;
    $('profile-rating').textContent = `Rating ${ratingText(user)}`;
    const since = new Date(user.since).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    $('profile-stats').textContent =
      `${user.games} rated game${user.games === 1 ? '' : 's'} • ${user.wins} wins • ${user.losses} losses • ` +
      `${user.draws} draws • ${user.tournamentPoints} tournament point${user.tournamentPoints === 1 ? '' : 's'} • ` +
      `${playedText(user.secondsPlayed)} played • member since ${since}`;
    $('profile-tournaments').hidden = data.tournaments.length === 0;
    $('profile-tournament-list').replaceChildren(
      ...data.tournaments.map((t) => {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="strong"><a></a></td><td class="place"></td><td class="played"></td><td class="wdl"></td>' +
          '<td class="score"></td><td class="date"></td>';
        tr.querySelector('a').textContent = t.name;
        tr.querySelector('a').href = tournamentHref(t.id);
        tr.querySelector('.place').textContent = `${t.place} of ${t.players}`;
        tr.querySelector('.played').textContent = t.played;
        tr.querySelector('.wdl').textContent = `${t.wins} / ${t.draws} / ${t.losses}`;
        tr.querySelector('.score').textContent = t.score;
        tr.querySelector('.date').textContent = new Date(t.starts_at).toLocaleDateString(undefined, { dateStyle: 'medium' });
        tr.addEventListener('click', () => navigate(tournamentHref(t.id)));
        return tr;
      })
    );
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
        tr.addEventListener('click', () => navigate(`/?game=${game.id}`));
        return tr;
      })
    );
  }

  // ---------- tournaments ----------

  const tournamentHref = (id) => `/?tournament=${id}`;
  let tour = null; // latest snapshot of the tournament on screen
  let tourId = null; // id of that tournament
  let tourEvents = null;
  let tourSkew = 0; // the server's clock minus ours

  const dateText = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const durationText = (minutes) => (minutes < 60 ? `${minutes} min` : `${minutes / 60} h`);

  // "4:32", or "1:04:32" from an hour up.
  function countdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const two = (n) => String(n).padStart(2, '0');
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return hours ? `${hours}:${two(minutes)}:${two(total % 60)}` : `${minutes}:${two(total % 60)}`;
  }

  async function showTournaments() {
    $('tournaments').hidden = false;
    document.title = 'Tournaments — Onitama';
    $('tournament-new').hidden = !account;
    const mine = visit;
    const refresh = async () => {
      let list;
      try {
        list = (await request('GET', '/api/tournaments')).tournaments;
      } catch (err) {
        if (mine === visit) $('tournaments-note').textContent = err.message;
        return;
      }
      if (mine !== visit) return;
      $('tournaments-note').textContent = account ? '' : 'Sign in to create or join a tournament.';
      $('tournaments-empty').hidden = list.length > 0;
      $('tournaments-list').replaceChildren(
        ...list.map((t) => {
          const tr = document.createElement('tr');
          tr.innerHTML =
            '<td class="strong"><a></a></td><td class="tc"></td><td class="duration"></td><td class="starts"></td>' +
            '<td class="players"></td><td class="status"></td>';
          tr.querySelector('a').textContent = t.name;
          tr.querySelector('a').href = tournamentHref(t.id);
          tr.querySelector('.tc').textContent = t.tc;
          tr.querySelector('.duration').textContent = durationText(t.minutes);
          tr.querySelector('.starts').textContent = dateText(t.startsAt);
          tr.querySelector('.players').textContent = t.players;
          const status = tr.querySelector('.status');
          status.classList.add(t.status);
          status.textContent = { upcoming: 'Upcoming', running: 'Running', finished: 'Finished' }[t.status];
          tr.addEventListener('click', () => navigate(tournamentHref(t.id)));
          return tr;
        })
      );
    };
    refresh();
    every(refresh, 10000);
  }

  function bindTournamentDialog() {
    $('tournament-new').addEventListener('click', () => {
      // datetime-local wants local time as YYYY-MM-DDTHH:MM; default to five minutes from now.
      const soon = new Date(Date.now() + 5 * 60 * 1000);
      soon.setMinutes(soon.getMinutes() - soon.getTimezoneOffset());
      $('tournament-form-start').value = soon.toISOString().slice(0, 16);
      $('tournament-form-error').textContent = '';
      $('tournament-dialog').showModal();
    });
    $('tournament-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const { id } = await request('POST', '/api/tournaments', {
          name: $('tournament-form-name').value,
          tc: $('tournament-form-tc').value,
          minutes: Number($('tournament-form-minutes').value),
          startsAt: new Date($('tournament-form-start').value).getTime(),
        });
        $('tournament-dialog').close();
        navigate(tournamentHref(id));
      } catch (err) {
        $('tournament-form-error').textContent = err.message;
      }
    });
  }

  const myEntry = () => (account && tour ? tour.standings.find((p) => p.id === account.id) : null) || null;

  function bindTournament() {
    const act = async (action) => {
      try {
        $('tournament-error').textContent = '';
        await request('POST', `/api/tournaments/${encodeURIComponent(tourId)}/${action}`, {});
      } catch (err) {
        $('tournament-error').textContent = err.message;
      }
    };
    $('tournament-join').addEventListener('click', () => act('join'));
    $('tournament-withdraw').addEventListener('click', () => act('withdraw'));
    // Deleting takes two clicks, like resigning.
    let deleteArmed = false;
    $('tournament-delete').addEventListener('click', async () => {
      const button = $('tournament-delete');
      if (!deleteArmed) {
        deleteArmed = true;
        button.textContent = 'Click again to delete';
        button.classList.add('armed');
        setTimeout(() => {
          deleteArmed = false;
          button.textContent = 'Delete tournament';
          button.classList.remove('armed');
        }, 3000);
        return;
      }
      try {
        await request('DELETE', `/api/tournaments/${encodeURIComponent(tourId)}`, {});
        navigate('/?tournaments');
      } catch (err) {
        $('tournament-error').textContent = err.message;
      }
    });
  }

  function showTournament(id) {
    tourId = id;
    $('tournament-error').textContent = '';
    const events = (tourEvents = new EventSource(`/api/tournaments/${encodeURIComponent(id)}/events`));
    events.onmessage = (e) => {
      tour = JSON.parse(e.data);
      tourSkew = tour.now - Date.now();
      if (tour.status === 'finished') events.close(); // nothing more will change
      // A game of ours is running (e.g. after a reload): go back to it.
      const me = myEntry();
      if (me && me.room && storedToken(me.room)) return enterRoom(me.room);
      $('tournament').hidden = false; // shown once there is something to show
      renderTournament();
      renderTournamentClock();
    };
    events.addEventListener('paired', (e) => {
      const paired = JSON.parse(e.data);
      storeToken(paired.room, paired.token);
      enterRoom(paired.room);
    });
    events.addEventListener('deleted', () => {
      events.close();
      navigate('/?tournaments');
    });
    events.onerror = () => {
      if (tour) return; // a dropped connection reconnects by itself
      leavePage();
      history.replaceState(null, '', '/');
      showLobby('That tournament could not be found.');
    };
    every(renderTournamentClock, 1000);
  }

  function renderTournamentClock() {
    if (!tour) return;
    const now = Date.now() + tourSkew;
    let text;
    if (tour.status === 'finished') text = `Finished ${dateText(tour.endsAt)}`;
    else if (tour.status === 'running') text = `${countdown(tour.endsAt - now)} left`;
    else if (tour.startsAt - now < 24 * 60 * 60 * 1000) text = `Starts in ${countdown(tour.startsAt - now)}`;
    else text = `Starts ${dateText(tour.startsAt)}`;
    $('tournament-clock').textContent = text;
  }

  function renderTournament() {
    const t = tour;
    const me = myEntry();
    const open = t.status !== 'finished';
    const playing = !!me && !me.withdrawn;
    document.title = `${t.name} — Onitama`;
    $('tournament-name').textContent = t.name;
    $('tournament-meta').textContent =
      `${t.tc} • ${durationText(t.minutes)} • Rated arena${t.createdBy ? ` • by ${t.createdBy}` : ''}`;
    renderTournamentClock();

    $('tournament-join').hidden = !(account && open && !playing);
    $('tournament-join').textContent = me ? 'Rejoin' : 'Join';
    $('tournament-withdraw').hidden = !(open && playing);
    $('tournament-delete').hidden = !(account && account.id === t.creatorId);
    const note = $('tournament-note');
    note.className = '';
    const leader = t.standings[0];
    if (!open) note.textContent = leader && leader.played ? `Winner: ${leader.name}` : 'The tournament is over.';
    else if (!account) note.textContent = 'Sign in to join.';
    else if (!playing) note.textContent = me ? 'You withdrew. Your score is kept.' : '';
    else if (t.status === 'upcoming') note.textContent = 'You are in. Keep this page open — your first game starts by itself.';
    else if (me.room) note.textContent = 'Your game is in progress.';
    else {
      note.textContent = 'Waiting for an opponent…';
      note.className = 'waiting';
    }

    $('tournament-empty').hidden = t.standings.length > 0;
    $('tournament-standings').replaceChildren(
      ...t.standings.map((p, i) => {
        const tr = document.createElement('tr');
        tr.className = `${me && p.id === me.id ? 'me' : ''}${p.withdrawn ? ' withdrawn' : ''}`;
        tr.innerHTML =
          '<td class="rank"></td><td class="strong"><a></a><span class="rating"></span></td><td class="played"></td>' +
          '<td class="wdl"></td><td class="score"></td><td class="watch"></td>';
        tr.querySelector('.rank').textContent = i + 1;
        tr.querySelector('a').textContent = p.name;
        tr.querySelector('a').href = profileHref(p.name);
        tr.querySelector('.rating').textContent = ratingText(p);
        tr.querySelector('.played').textContent = p.played;
        tr.querySelector('.wdl').textContent = `${p.wins} / ${p.draws} / ${p.losses}`;
        tr.querySelector('.score').textContent = p.score;
        if (p.room) {
          const watch = document.createElement('a');
          watch.href = `/?room=${p.room}&watch`;
          watch.textContent = 'Playing';
          tr.querySelector('.watch').append(watch);
        }
        return tr;
      })
    );
  }

  // ---------- analysis board ----------
  // A finished game is either stored on the server (/?game=ID, for signed-in
  // players) or travels in the URL itself (/?analysis=…), deal and moves.

  function analysisHref(g) {
    if (snap.result && snap.result.gameId) return `/?game=${snap.result.gameId}`;
    const data = { i: g.initial, h: g.history.map((m) => [m.card, m.from, m.to, m.ms]), w: g.winner, r: g.winReason };
    const encoded = btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `/?analysis=${encoded}`;
  }

  function rebuildGame(initial, moves, winner, reason) {
    const history = moves.map(([card, from, to, ms]) => ({ card, from, to, ms }));
    const game = Onitama.replay({ initial, history }, history.length);
    if (game.history.length !== history.length) throw new Error('bad moves');
    if (!game.winner) {
      game.winner = winner || null;
      game.winReason = reason || null;
    }
    return game;
  }

  function startAnalysis(game, extra) {
    analysis = inGame = true;
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
    inGame = true; // leaving now takes a page load, even while the game is still being fetched
    try {
      const { game: row } = await request('GET', `/api/games/${encodeURIComponent(id)}`);
      const player = (color) =>
        row[`${color}_name`]
          ? { id: row[`${color}_id`], name: row[`${color}_name`], rating: row[`${color}_rating`], bot: row[`${color}_id`] === null }
          : null;
      startAnalysis(rebuildGame(row.initial, row.moves, row.winner, row.reason), {
        players: { red: player('red'), blue: player('blue') },
        rated: row.rated,
        tc: row.tc,
        result: { gameId: row.id, diffs: { red: row.red_diff, blue: row.blue_diff } },
      });
    } catch (err) {
      inGame = false;
      history.replaceState(null, '', '/');
      showLobby(err.message === 'bad moves' ? 'That game could not be loaded.' : err.message);
    }
  }

  // ---------- game ----------

  const bothSeated = (s) => s.seated.red && s.seated.blue;

  async function startGame() {
    inGame = true;
    let joined;
    try {
      joined = await post(`/${room}/join`, watching ? { spectate: true } : { token: storedToken(room) });
    } catch (err) {
      inGame = false;
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
      // A move was played (not a takeback or a rematch, which lower the count).
      if (previous && snap.game.moveCount > previous.game.moveCount && snap.game.last.from !== null) {
        playSound(snap.game.last.captured ? 'capture' : 'move');
      }
      if (snap.game.moveCount !== seenMove) {
        seenMove = snap.game.moveCount;
        sel = { card: null, from: null };
        hint = '';
        // A takeback changes the position under an open card chooser.
        if ($('move-card-dialog').open) $('move-card-dialog').close();
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

  // Alert sound when an opponent has been found (the game is ready to start) and when the game ends.
  function announce(previous, current) {
    const fresh = bothSeated(current) && !current.game.winner && current.game.moveCount === 0;
    const wasReady = previous && bothSeated(previous) && !previous.game.winner;
    const started = current.you && fresh && !wasReady;
    const ended = previous && !previous.game.winner && current.game.winner;
    if (started || ended) playSound('alert');
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
    for (const button of document.querySelectorAll('#replay button[data-go]')) {
      button.addEventListener('click', () => step(button.dataset.go));
    }
    $('move-times').addEventListener('click', () => {
      showTimes = !showTimes;
      try { localStorage.setItem(TIMES_KEY, showTimes ? 'on' : 'off'); } catch { /* private mode */ }
      renderMoves();
    });
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
    if (cards.length > 1) return chooseCard(cards, sel.from, index);
    act('/move', { card: cards[0], from: sel.from, to: index });
  }

  // Both cards reach the square: ask which one to play rather than guess.
  function chooseCard(cards, from, to) {
    const dialog = $('move-card-dialog');
    $('move-card-choices').replaceChildren(
      ...cards.map((name) => {
        const el = cardEl(name, snap.you, false, () => {
          dialog.close();
          if (canAct()) act('/move', { card: name, from, to });
        });
        el.type = 'button';
        return el;
      })
    );
    dialog.showModal();
    dialog.querySelector('.card').focus();
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
    const player = snap.players[color] && !snap.players[color].bot ? snap.players[color] : null;
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
    const event = snap.tournament ? snap.tournament.name : 'Onitama';
    $('info-title').textContent = `${analysis ? 'Analysis • ' : ''}${snap.tc || 'Unlimited'} • ${mode} • ${event}`;
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

  // How long a move took: "0.8s", "12s", "1:05".
  function moveTime(ms) {
    if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function renderMoves() {
    const g = snap.game;
    const current = isLive() ? g.history.length : viewPly;
    // Move times belong to the analysis board, and only games played since they were recorded have them.
    const timed = analysis && g.history.some((move) => move.ms != null);
    $('move-times').hidden = !timed;
    $('move-times').setAttribute('aria-pressed', String(showTimes));
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
      li.innerHTML = `<span class="swatch ${move.color}"></span><span></span><b></b><i></i>`;
      li.children[1].textContent = text;
      li.children[2].textContent = move.card;
      li.children[3].textContent = timed && showTimes && move.ms != null ? moveTime(move.ms) : '';
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
    const buttons = document.querySelectorAll('#replay button[data-go]');
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
        html += pieceSvg(prefs.pieces, piece.c, kind, piece.c === view ? '' : ' far');
      }
      cell.innerHTML = html;
      cell.setAttribute('aria-label', piece ? `${square(index)}, ${piece.c} ${piece.m ? 'master' : 'student'}` : square(index));
      cell.addEventListener('click', () => onCell(index));
      cells.push(cell);
    }
    $('board').replaceChildren(...cells, resizeHandle);
  }

  // ---------- board size ----------

  // The square size is set in whole pixels, so all 25 squares are exactly the same size.
  const SIZE_KEY = 'onitama:board-cell';
  const MIN_CELL = 44;
  const narrow = matchMedia('(max-width: 980px)');
  const resizeHandle = document.createElement('div');
  resizeHandle.id = 'board-resize';
  resizeHandle.title = 'Drag to resize the board (double-click to reset)';

  function storedCell() {
    try { return Number(localStorage.getItem(SIZE_KEY)) || null; } catch { return null; }
  }

  // Largest square that still leaves room for the columns beside the board.
  function maxCell() {
    const width = document.documentElement.clientWidth;
    if (narrow.matches) {
      // Leave room for the bar, both hands and both clocks (or, on a phone held sideways, a column of them).
      const height = document.documentElement.clientHeight;
      const sideways = width > height && height <= 560;
      const fit = sideways ? Math.min((height - 54) / 5, (width - 290) / 5) : Math.min((width - 16) / 5, (height - 318) / 5);
      return Math.floor(Math.max(40, Math.min(96, fit)));
    }
    // Side columns 240 + 320 (370 on the analysis board), gaps 32, padding 32.
    return Math.floor((width - (analysis ? 674 : 624)) / 5);
  }

  function applyBoardSize(wanted) {
    const max = maxCell();
    let cell = max;
    if (!narrow.matches) {
      const fallback = Math.min(112, Math.floor((window.innerHeight - 96) / 5));
      cell = Math.min(max, Math.max(MIN_CELL, wanted || storedCell() || fallback));
    }
    document.documentElement.style.setProperty('--cell', `${cell}px`);
    return cell;
  }

  function bindBoardResize() {
    let cell = null; // set while dragging
    resizeHandle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      resizeHandle.setPointerCapture(event.pointerId);
      resizeHandle.classList.add('dragging');
      cell = applyBoardSize();
    });
    resizeHandle.addEventListener('pointermove', (event) => {
      if (cell === null) return;
      const rect = $('board').getBoundingClientRect();
      const side = Math.max(event.clientX - rect.left, event.clientY - rect.top);
      cell = applyBoardSize(Math.round(side / 5));
    });
    const finish = () => {
      if (cell === null) return;
      try { localStorage.setItem(SIZE_KEY, String(cell)); } catch { /* private mode */ }
      cell = null;
      resizeHandle.classList.remove('dragging');
    };
    resizeHandle.addEventListener('pointerup', finish);
    resizeHandle.addEventListener('pointercancel', finish);
    resizeHandle.addEventListener('dblclick', () => {
      try { localStorage.removeItem(SIZE_KEY); } catch { /* private mode */ }
      applyBoardSize();
    });
    window.addEventListener('resize', () => applyBoardSize());
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => applyBoardSize());
    applyBoardSize();
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

    $('rematch').hidden = !(g.winner && me) || !!snap.tournament;
    // Players go back for their next pairing once the game is over; spectators at any time.
    const back = $('back-tournament');
    back.hidden = !snap.tournament || (!!me && !g.winner);
    if (snap.tournament) back.href = tournamentHref(snap.tournament.id);
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
    // The game ended, or the clock ran out, while the card chooser was open.
    if (!active && $('move-card-dialog').open) $('move-card-dialog').close();
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

  // Moving between the lobby, tournaments, profiles and the donate and computer pages swaps
  // the visible <main> without loading a new document, so the top bar stays put.
  // A game holds too much state to tear down: entering or leaving one is a page load.

  let inGame = false;
  let visit = 0; // goes up on every page change, so late replies for an old page can be dropped
  let pageTimers = [];

  // An interval that stops when the visitor leaves the page.
  function every(fn, ms) {
    pageTimers.push(setInterval(fn, ms));
  }

  function leavePage() {
    visit++;
    pageTimers.forEach(clearInterval);
    pageTimers = [];
    if (seek) {
      seek.events.close();
      seek.button.classList.remove('seeking');
      seek = null;
    }
    if (tourEvents) tourEvents.close();
    tourEvents = tour = null;
    for (const main of document.querySelectorAll('main')) main.hidden = true;
  }

  const isGameUrl = (url) => ['room', 'game', 'analysis'].some((key) => url.searchParams.get(key));

  function showPage(error) {
    const query = new URLSearchParams(location.search);
    document.title = 'Onitama';
    if (query.get('user')) showProfile(query.get('user'));
    else if (query.has('tournaments')) showTournaments();
    else if (query.has('donate')) showDonate();
    else if (query.has('computer')) showComputer();
    else if (query.has('signup')) showSignup(query.get('signup'));
    else if (query.has('forgot')) showRecover('forgot');
    else if (query.get('reset')) showRecover('reset');
    else if (query.get('tournament')) showTournament(query.get('tournament'));
    else if (query.get('game')) startStoredAnalysis(query.get('game'));
    else if (query.get('analysis')) startUrlAnalysis(query.get('analysis'));
    else if (query.get('room')) startGame();
    else showLobby(error);
  }

  function navigate(href) {
    const url = new URL(href, location.href);
    if (url.href === location.href) return;
    if (inGame || isGameUrl(url)) {
      location.href = url.href;
      return;
    }
    leavePage();
    history.pushState(null, '', url.pathname + url.search);
    showPage();
    window.scrollTo(0, 0);
  }

  // Plain clicks on links to our own pages are handled here instead of by the browser.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link || link.target || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || url.pathname !== '/') return;
    e.preventDefault();
    navigate(url.href);
  });

  window.addEventListener('popstate', () => {
    if (inGame || isGameUrl(new URL(location.href))) return location.reload();
    leavePage();
    showPage();
  });

  // What the server last said about accounts and who is signed in, kept so the
  // top bar can be drawn at once on the next page load instead of popping in.
  const ME_KEY = 'onitama:me';

  function applyMe(me) {
    accountsOn = !!me.accounts;
    donateUrl = me.donate || null;
    googleOn = !!me.google;
    mailOn = !!me.mail;
    $('version').textContent = me.version || '';
    account = me.user || null;
    renderAccount();
    $('nav-tournaments').hidden = !accountsOn;
  }

  async function boot() {
    try {
      applyMe(JSON.parse(localStorage.getItem(ME_KEY)) || {});
    } catch {
      applyMe({});
    }
    try {
      const me = await request('GET', '/api/me');
      applyMe(me);
      try { localStorage.setItem(ME_KEY, JSON.stringify(me)); } catch { /* private mode */ }
    } catch { /* keep what we knew */ }
    bindDialogs();
    bindSignup();
    bindRecover();
    bindMenu();
    bindBoardResize();
    fillTimeControls();
    bindLobby();
    bindTournamentDialog();
    bindTournament();
    showPage(params.has('signin') ? 'Google sign-in did not complete. Please try again.' : '');
  }

  boot();
})();
