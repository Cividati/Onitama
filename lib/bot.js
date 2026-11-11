// Computer opponent: a small alpha-beta search over the rules in public/game.js.
'use strict';

const { CARDS, TEMPLE, SIZE } = require('../public/game.js');

// `depth` is how many moves ahead the bot looks, `noise` how much it misjudges
// a move (in hundredths of a student), `ms` the most it may think.
const LEVELS = {
  easy: { label: 'Easy bot', depth: 1, noise: 120, ms: 100 },
  medium: { label: 'Medium bot', depth: 3, noise: 20, ms: 200 },
  hard: { label: 'Hard bot', depth: 8, noise: 0, ms: 250 },
};

const WIN = 100000;
const STUDENT = 100;
const CENTRE = [0, 3, 5, 3, 0]; // bonus per column: pieces in the middle reach more squares

// Board squares each card reaches, per colour and starting square.
const REACH = {};
for (const [name, card] of Object.entries(CARDS)) {
  REACH[name] = { 1: [], '-1': [] };
  for (const side of [1, -1]) {
    for (let from = 0; from < SIZE * SIZE; from++) {
      const x = from % SIZE;
      const y = (from - x) / SIZE;
      const targets = [];
      for (const [dx, dy] of card.moves) {
        const tx = x + dx * side;
        const ty = y - dy * side;
        if (tx >= 0 && tx < SIZE && ty >= 0 && ty < SIZE) targets.push(ty * SIZE + tx);
      }
      REACH[name][side].push(targets);
    }
  }
}

// Search position: red pieces are positive, blue negative; 1 = student, 2 = master.
function position(game) {
  return {
    board: game.board.map((piece) => (piece ? (piece.c === 'red' ? 1 : -1) * (piece.m ? 2 : 1) : 0)),
    hands: { 1: [...game.hands.red], '-1': [...game.hands.blue] },
    spare: game.spare,
    side: game.turn === 'red' ? 1 : -1,
  };
}

// Moves for the side to play, captures first. With no move, one pass per card (from = -1).
function movesOf(pos) {
  const { board, side } = pos;
  const captures = [];
  const quiet = [];
  const hand = pos.hands[side];
  for (let slot = 0; slot < 2; slot++) {
    const reach = REACH[hand[slot]][side];
    for (let from = 0; from < board.length; from++) {
      if (board[from] * side <= 0) continue;
      for (const to of reach[from]) {
        const target = board[to];
        if (target * side > 0) continue;
        (target ? captures : quiet).push({ slot, from, to });
      }
    }
  }
  if (captures.length || quiet.length) return captures.concat(quiet);
  return [{ slot: 0, from: -1, to: -1 }, { slot: 1, from: -1, to: -1 }];
}

// Plays `move` and returns what is needed to undo it.
function make(pos, move) {
  const { board, side } = pos;
  const hand = pos.hands[side];
  const undo = { captured: 0, card: hand[move.slot] };
  if (move.from >= 0) {
    undo.captured = board[move.to];
    board[move.to] = board[move.from];
    board[move.from] = 0;
  }
  hand[move.slot] = pos.spare;
  pos.spare = undo.card;
  pos.side = -side;
  return undo;
}

function unmake(pos, move, undo) {
  const side = -pos.side;
  pos.side = side;
  pos.spare = pos.hands[side][move.slot];
  pos.hands[side][move.slot] = undo.card;
  if (move.from >= 0) {
    pos.board[move.from] = pos.board[move.to];
    pos.board[move.to] = undo.captured;
  }
}

// Whether the move just made (by the side that is no longer to play) won the game.
function wins(pos, move, undo) {
  if (move.from < 0) return false;
  if (undo.captured === 2 || undo.captured === -2) return true;
  const mover = -pos.side;
  return pos.board[move.to] === mover * 2 && move.to === (mover === 1 ? TEMPLE.blue : TEMPLE.red);
}

// Material and placement, from the point of view of the side to play.
function evaluate(pos) {
  let score = 0;
  for (let i = 0; i < pos.board.length; i++) {
    const piece = pos.board[i];
    if (!piece) continue;
    const x = i % SIZE;
    const y = (i - x) / SIZE;
    const sign = piece > 0 ? 1 : -1;
    const advance = sign === 1 ? SIZE - 1 - y : y;
    score += sign * (piece === sign ? STUDENT + CENTRE[x] + advance * 2 : CENTRE[x] * 2);
  }
  return score * pos.side;
}

class OutOfTime extends Error {}

function search(pos, depth, alpha, beta, ply, clock) {
  if (depth === 0) return evaluate(pos);
  if ((++clock.nodes & 1023) === 0 && Date.now() > clock.deadline) throw new OutOfTime();
  let best = -Infinity;
  for (const move of movesOf(pos)) {
    const undo = make(pos, move);
    let score;
    try {
      score = wins(pos, move, undo) ? WIN - ply : -search(pos, depth - 1, -beta, -alpha, ply + 1, clock);
    } finally {
      unmake(pos, move, undo);
    }
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

// The move a bot of the given level plays in `game`: { card, from, to }, with
// from and to null when it has no legal move and gives up `card` instead.
function chooseMove(game, level, rng) {
  rng = rng || Math.random;
  const { depth, noise, ms } = LEVELS[level] || LEVELS.medium;
  const pos = position(game);
  const moves = movesOf(pos);
  for (let i = moves.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [moves[i], moves[j]] = [moves[j], moves[i]];
  }
  const clock = { nodes: 0, deadline: Date.now() + ms };
  let choice = moves[0];
  try {
    // Deepen step by step, so there is always a finished answer when time runs out.
    for (let d = 1; d <= depth; d++) {
      let best = -Infinity;
      let bestMove = moves[0];
      for (const move of moves) {
        const undo = make(pos, move);
        let score;
        try {
          // A noisy bot needs the true score of every move, so no narrowed window.
          const beta = noise ? Infinity : -best;
          score = wins(pos, move, undo) ? WIN : -search(pos, d - 1, -Infinity, beta, 1, clock);
        } finally {
          unmake(pos, move, undo);
        }
        if (noise && Math.abs(score) < WIN / 2) score += (rng() - 0.5) * 2 * noise;
        if (score > best) {
          best = score;
          bestMove = move;
        }
      }
      choice = bestMove;
      if (best >= WIN / 2) break; // a forced win needs no deeper look
    }
  } catch (err) {
    if (!(err instanceof OutOfTime)) throw err;
  }
  const card = pos.hands[pos.side][choice.slot];
  return choice.from < 0 ? { card, from: null, to: null } : { card, from: choice.from, to: choice.to };
}

module.exports = { LEVELS, chooseMove };
