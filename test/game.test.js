'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../public/game.js');

function emptyGame() {
  const g = O.newGame();
  g.board.fill(null);
  g.hands = { red: ['Tiger', 'Boar'], blue: ['Crab', 'Ox'] };
  g.spare = 'Horse';
  g.turn = 'red';
  return g;
}

test('deck has 16 cards, 8 per stamp colour, no duplicate or null moves', () => {
  const cards = Object.values(O.CARDS);
  assert.equal(cards.length, 16);
  assert.equal(cards.filter((c) => c.stamp === 'red').length, 8);
  for (const card of cards) {
    const keys = card.moves.map(String);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(!keys.includes('0,0'));
  }
});

test('new game: masters on temples, 5 distinct cards, spare stamp starts', () => {
  const g = O.newGame();
  assert.deepEqual(g.board[O.TEMPLE.red], { c: 'red', m: true });
  assert.deepEqual(g.board[O.TEMPLE.blue], { c: 'blue', m: true });
  assert.equal(g.board.filter(Boolean).length, 10);
  assert.equal(new Set([...g.hands.red, ...g.hands.blue, g.spare]).size, 5);
  assert.equal(g.turn, O.CARDS[g.spare].stamp);
});

test('moves are mirrored for blue', () => {
  const g = emptyGame();
  g.board[12] = { c: 'red', m: false };
  assert.deepEqual(O.movesFor(g, 'red', 'Tiger', 12).sort(), [17, 2]); // 2 forward (up), 1 back
  g.board[12] = { c: 'blue', m: false };
  assert.deepEqual(O.movesFor(g, 'blue', 'Tiger', 12).sort(), [22, 7]);
  // Ox steps to the holder's right: +x for red, -x for blue.
  assert.ok(O.movesFor(g, 'blue', 'Ox', 12).includes(11));
  g.board[12] = { c: 'red', m: false };
  assert.ok(O.movesFor(g, 'red', 'Ox', 12).includes(13));
});

test('cannot leave the board or land on own piece; cards rotate', () => {
  const g = emptyGame();
  g.board[22] = { c: 'red', m: true };
  g.board[21] = { c: 'red', m: false };
  g.board[2] = { c: 'blue', m: true };
  assert.deepEqual(O.movesFor(g, 'red', 'Boar', 22).sort(), [17, 23]);
  assert.equal(O.applyMove(g, { card: 'Boar', from: 22, to: 21 }), 'Illegal move');
  assert.equal(O.applyMove(g, { card: 'Crab', from: 22, to: 17 }), 'You do not hold that card');
  assert.equal(O.applyMove(g, { card: 'Boar', from: 22, to: 17 }), null);
  assert.deepEqual(g.hands.red, ['Tiger', 'Horse']);
  assert.equal(g.spare, 'Boar');
  assert.equal(g.turn, 'blue');
});

test('capturing the master wins (stone)', () => {
  const g = emptyGame();
  g.board[12] = { c: 'red', m: false };
  g.board[2] = { c: 'blue', m: true };
  g.board[22] = { c: 'red', m: true };
  assert.equal(O.applyMove(g, { card: 'Tiger', from: 12, to: 2 }), null);
  assert.equal(g.winner, 'red');
  assert.equal(g.winReason, 'stone');
  assert.equal(O.applyMove(g, { card: 'Crab', from: 2, to: 3 }), 'The game is over');
});

test('master reaching the enemy temple wins (stream); a student does not', () => {
  const g = emptyGame();
  g.board[12] = { c: 'red', m: false };
  g.board[0] = { c: 'blue', m: true };
  g.board[24] = { c: 'red', m: true };
  assert.equal(O.applyMove(g, { card: 'Tiger', from: 12, to: 2 }), null);
  assert.equal(g.winner, null);

  const h = emptyGame();
  h.board[12] = { c: 'red', m: true };
  h.board[0] = { c: 'blue', m: true };
  assert.equal(O.applyMove(h, { card: 'Tiger', from: 12, to: 2 }), null);
  assert.equal(h.winner, 'red');
  assert.equal(h.winReason, 'stream');
});

test('pass is only allowed with no legal move, and still swaps a card', () => {
  const g = emptyGame();
  g.board[0] = { c: 'red', m: true }; // top-left corner
  g.board[24] = { c: 'blue', m: true };
  g.hands.red = ['Tiger', 'Boar'];
  assert.equal(O.applyPass(g, 'Tiger'), 'You have a legal move and must take it'); // Boar can step right
  g.hands.red = ['Tiger', 'Horse']; // Tiger: off-board both ways... back is on board
  g.board[5] = { c: 'red', m: false };
  g.board[10] = { c: 'red', m: false };
  g.board[15] = { c: 'red', m: false };
  g.board[20] = { c: 'red', m: false };
  g.hands.red = ['Horse', 'Tiger'];
  g.spare = 'Boar';
  // Column 0 full of red: Horse (left/fwd/back) and Tiger (fwd 2/back 1) are all blocked or off-board.
  assert.equal(O.legalMoves(g).length, 0);
  assert.equal(O.applyPass(g, 'Horse'), null);
  assert.deepEqual(g.hands.red, ['Boar', 'Tiger']);
  assert.equal(g.spare, 'Horse');
  assert.equal(g.turn, 'blue');
});

test('resigning hands the win to the opponent and history records moves', () => {
  const g = O.newGame();
  const first = g.turn;
  assert.equal(O.applyMove(g, O.legalMoves(g)[0]), null);
  assert.equal(g.history.length, 1);
  assert.equal(g.history[0].color, first);
  assert.equal(O.resign(g, first), null);
  assert.equal(g.winner, O.other(first));
  assert.equal(g.winReason, 'resign');
  assert.equal(O.resign(g, first), 'The game is over');
});

test('replay rebuilds any earlier position, and the full game exactly', () => {
  const g = O.newGame();
  const snapshots = [JSON.stringify(g)];
  for (let ply = 0; ply < 60 && !g.winner; ply++) {
    const moves = O.legalMoves(g);
    if (moves.length) O.applyMove(g, moves[Math.floor(Math.random() * moves.length)]);
    else O.applyPass(g, g.hands[g.turn][0]);
    snapshots.push(JSON.stringify(g));
  }
  snapshots.forEach((expected, ply) => assert.equal(JSON.stringify(O.replay(g, ply)), expected));
});

test('random playouts keep invariants', () => {
  for (let n = 0; n < 300; n++) {
    const g = O.newGame();
    for (let ply = 0; ply < 400 && !g.winner; ply++) {
      const moves = O.legalMoves(g);
      const err = moves.length
        ? O.applyMove(g, moves[Math.floor(Math.random() * moves.length)])
        : O.applyPass(g, g.hands[g.turn][0]);
      assert.equal(err, null);
      assert.equal(new Set([...g.hands.red, ...g.hands.blue, g.spare]).size, 5);
      const masters = g.board.filter((p) => p && p.m).length;
      assert.equal(masters, g.winReason === 'stone' ? 1 : 2);
    }
  }
});
