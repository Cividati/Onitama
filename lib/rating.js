// Elo ratings. Everyone starts at 1500; new players move faster.
'use strict';

const START = 1500;
const PROVISIONAL_GAMES = 10; // shown with a "?" until this many rated games

const kFactor = (games) => (games < 30 ? 40 : 20);

// `score` is 1 for a win, 0.5 for a draw, 0 for a loss, from the player's side.
function ratingChange(rating, opponentRating, score, games) {
  const expected = 1 / (1 + 10 ** ((opponentRating - rating) / 400));
  return kFactor(games) * (score - expected);
}

module.exports = { START, PROVISIONAL_GAMES, ratingChange };
