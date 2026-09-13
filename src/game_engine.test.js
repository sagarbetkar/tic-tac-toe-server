const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialState, applyMove, hasWinner } = require('../../../packages/game-engine/game_engine');

test('only latest 3 moves of each player remain', () => {
  let s = createInitialState();
  s = applyMove(s, 'X', 0);
  s = applyMove(s, 'O', 1);
  s = applyMove(s, 'X', 3);
  s = applyMove(s, 'O', 4);
  s = applyMove(s, 'X', 5);
  assert.deepEqual(s.histories.X, [0, 3, 5]);
  s = applyMove(s, 'O', 2);
  s = applyMove(s, 'X', 8);
  assert.deepEqual(s.histories.X, [3, 5, 8]);
  assert.equal(s.board[0], null);
  assert.equal(s.board[3], 'X');
  assert.equal(s.board[5], 'X');
  assert.equal(s.board[8], 'X');
});

test('ordinary tic-tac-toe winning lines still decide the winner', () => {
  let s = createInitialState();
  s = applyMove(s, 'X', 0);
  s = applyMove(s, 'O', 1);
  s = applyMove(s, 'X', 3);
  s = applyMove(s, 'O', 4);
  s = applyMove(s, 'X', 6);
  assert.equal(hasWinner(s.board, 'X'), true);
  assert.equal(s.winner, 'X');
});
