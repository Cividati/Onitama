'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../public/game.js');
const { LEVELS, chooseMove } = require('../lib/bot.js');

function emptyGame() {
  const g = O.newGame();
  g.board.fill(null);
  g.hands = { red: ['Tiger', 'Boar'], blue: ['Crab', 'Ox'] };
  g.spare = 'Horse';
  g.turn = 'red';
  return g;
}

test('every level takes a win in one move', () => {
  for (const level of Object.keys(LEVELS)) {
    const g = emptyGame();
    g.board[22] = { c: 'red', m: true };
    g.board[17] = { c: 'red', m: false };
    g.board[7] = { c: 'blue', m: true }; // two squares ahead of the student: Tiger captures
    const move = chooseMove(g, level);
    assert.equal(O.applyMove(g, move), null);
    assert.equal(g.winner, 'red', level);
  }
});

test('hard bot does not leave its master to be captured', () => {
  const g = emptyGame();
  g.turn = 'blue';
  g.board[2] = { c: 'blue', m: true };
  g.board[12] = { c: 'red', m: false }; // Tiger takes the master on 2 unless it steps aside
  g.board[22] = { c: 'red', m: true };
  assert.equal(O.applyMove(g, chooseMove(g, 'hard')), null);
  const reply = O.legalMoves(g).filter((m) => g.board[m.to] && g.board[m.to].m);
  assert.deepEqual(reply, []);
});

test('bot passes when it has no legal move', () => {
  const g = emptyGame();
  g.hands.red = ['Tiger', 'Tiger'];
  // A full column: every Tiger jump or step back lands on a friend or off the board.
  g.board[2] = { c: 'red', m: true };
  for (const index of [7, 12, 17, 22]) g.board[index] = { c: 'red', m: false };
  g.board[20] = { c: 'blue', m: true };
  const move = chooseMove(g, 'medium');
  assert.equal(move.from, null);
  assert.equal(O.applyPass(g, move.card), null);
});

test('bots only play legal moves through whole games', () => {
  for (const [red, blue] of [['easy', 'hard'], ['medium', 'medium']]) {
    const g = O.newGame();
    for (let ply = 0; ply < 300 && !g.winner; ply++) {
      const move = chooseMove(g, g.turn === 'red' ? red : blue);
      const error = move.from === null ? O.applyPass(g, move.card) : O.applyMove(g, move);
      assert.equal(error, null);
    }
  }
});

test('search leaves the game untouched', () => {
  const g = O.newGame();
  const before = JSON.stringify(g);
  chooseMove(g, 'hard');
  assert.equal(JSON.stringify(g), before);
});
