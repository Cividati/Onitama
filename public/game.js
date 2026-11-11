// Onitama rules engine. Shared by the server (authoritative) and the browser
// (move highlighting). No dependencies, no DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Onitama = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 5;
  // Moves are [dx, dy] from the card holder's point of view: +dx is to their
  // right, +dy is forward (towards the opponent). `stamp` decides who starts
  // when the card is the initial spare.
  const CARDS = {
    Tiger:    { stamp: 'blue', moves: [[0, 2], [0, -1]] },
    Dragon:   { stamp: 'red',  moves: [[-2, 1], [2, 1], [-1, -1], [1, -1]] },
    Frog:     { stamp: 'red',  moves: [[-2, 0], [-1, 1], [1, -1]] },
    Rabbit:   { stamp: 'blue', moves: [[2, 0], [1, 1], [-1, -1]] },
    Crab:     { stamp: 'blue', moves: [[-2, 0], [2, 0], [0, 1]] },
    Elephant: { stamp: 'red',  moves: [[-1, 0], [1, 0], [-1, 1], [1, 1]] },
    Goose:    { stamp: 'blue', moves: [[-1, 0], [-1, 1], [1, 0], [1, -1]] },
    Rooster:  { stamp: 'red',  moves: [[-1, 0], [-1, -1], [1, 0], [1, 1]] },
    Monkey:   { stamp: 'blue', moves: [[-1, 1], [1, 1], [-1, -1], [1, -1]] },
    Mantis:   { stamp: 'red',  moves: [[-1, 1], [1, 1], [0, -1]] },
    Horse:    { stamp: 'red',  moves: [[-1, 0], [0, 1], [0, -1]] },
    Ox:       { stamp: 'blue', moves: [[1, 0], [0, 1], [0, -1]] },
    Crane:    { stamp: 'blue', moves: [[0, 1], [-1, -1], [1, -1]] },
    Boar:     { stamp: 'red',  moves: [[-1, 0], [1, 0], [0, 1]] },
    Eel:      { stamp: 'blue', moves: [[-1, 1], [-1, -1], [1, 0]] },
    Cobra:    { stamp: 'red',  moves: [[1, 1], [1, -1], [-1, 0]] },
  };

  // Board is a flat array, index = y * 5 + x, y = 0 is Blue's home row and
  // y = 4 is Red's. Each side's temple is the middle square of its home row.
  const TEMPLE = { red: 22, blue: 2 };

  const other = (color) => (color === 'red' ? 'blue' : 'red');

  // Deals five cards: from the whole deck, or from `cards` when the players
  // picked the five to play with.
  function newGame(rng, cards) {
    rng = rng || Math.random;
    const names = cards ? [...cards] : Object.keys(CARDS);
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
    return fromInitial({
      hands: { red: [names[0], names[1]], blue: [names[2], names[3]] },
      spare: names[4],
      turn: CARDS[names[4]].stamp,
    });
  }

  // Starting position for a given deal. `initial` is kept (never mutated) so
  // any earlier position can be rebuilt with replay().
  function fromInitial(initial) {
    const board = new Array(SIZE * SIZE).fill(null);
    for (let x = 0; x < SIZE; x++) {
      board[x] = { c: 'blue', m: x === 2 };
      board[20 + x] = { c: 'red', m: x === 2 };
    }
    return {
      board,
      hands: { red: [...initial.hands.red], blue: [...initial.hands.blue] },
      spare: initial.spare,
      turn: initial.turn,
      // winner is a colour, or 'draw'. winReason: 'stone' (master captured) |
      // 'stream' (temple reached) | 'resign' | 'time' | 'agreement'.
      winner: null,
      winReason: null,
      last: null,
      history: [], // every move and pass, in order
      moveCount: 0,
      initial,
    };
  }

  // The position after the first `ply` moves of `game`. A move's `ms` (how long
  // it took, set by the server) is carried over.
  function replay(game, ply) {
    const state = fromInitial(game.initial);
    for (const move of game.history.slice(0, ply)) {
      const error = move.from === null ? applyPass(state, move.card) : applyMove(state, move);
      if (error) break;
      if (move.ms != null) state.last.ms = move.ms;
    }
    return state;
  }

  // Squares the piece on `from` can reach with `card`, played by `color`.
  function movesFor(state, color, card, from) {
    const piece = state.board[from];
    if (!piece || piece.c !== color || !CARDS[card]) return [];
    const x = from % SIZE;
    const y = (from - x) / SIZE;
    const dir = color === 'red' ? 1 : -1;
    const out = [];
    for (const [dx, dy] of CARDS[card].moves) {
      const tx = x + dx * dir;
      const ty = y - dy * dir;
      if (tx < 0 || tx >= SIZE || ty < 0 || ty >= SIZE) continue;
      const to = ty * SIZE + tx;
      const target = state.board[to];
      if (target && target.c === color) continue;
      out.push(to);
    }
    return out;
  }

  // Every legal { card, from, to } for the player to move.
  function legalMoves(state) {
    const out = [];
    if (state.winner) return out;
    for (const card of state.hands[state.turn]) {
      for (let from = 0; from < state.board.length; from++) {
        for (const to of movesFor(state, state.turn, card, from)) out.push({ card, from, to });
      }
    }
    return out;
  }

  function swapCard(state, card) {
    const hand = state.hands[state.turn];
    hand[hand.indexOf(card)] = state.spare;
    state.spare = card;
  }

  // Mutates `state`. Returns null on success or an error string.
  function applyMove(state, move) {
    if (state.winner) return 'The game is over';
    const color = state.turn;
    const { card, from, to } = move || {};
    if (!state.hands[color].includes(card)) return 'You do not hold that card';
    if (!movesFor(state, color, card, from).includes(to)) return 'Illegal move';

    const piece = state.board[from];
    const captured = state.board[to];
    state.board[to] = piece;
    state.board[from] = null;
    swapCard(state, card);
    state.last = { color, card, from, to, captured: !!captured };
    state.history.push(state.last);
    state.moveCount++;

    if (captured && captured.m) {
      state.winner = color;
      state.winReason = 'stone';
    } else if (piece.m && to === TEMPLE[other(color)]) {
      state.winner = color;
      state.winReason = 'stream';
    } else {
      state.turn = other(color);
    }
    return null;
  }

  // With no legal move the player must still discard one card for the spare.
  function applyPass(state, card) {
    if (state.winner) return 'The game is over';
    if (legalMoves(state).length) return 'You have a legal move and must take it';
    if (!state.hands[state.turn].includes(card)) return 'You do not hold that card';
    const color = state.turn;
    swapCard(state, card);
    state.last = { color, card, from: null, to: null, captured: false };
    state.history.push(state.last);
    state.moveCount++;
    state.turn = other(color);
    return null;
  }

  // Either player may resign at any time, not only on their own turn.
  function resign(state, color) {
    if (state.winner) return 'The game is over';
    state.winner = other(color);
    state.winReason = 'resign';
    return null;
  }

  return {
    SIZE, CARDS, TEMPLE, other, newGame, fromInitial, replay, movesFor, legalMoves, applyMove, applyPass, resign,
  };
});
