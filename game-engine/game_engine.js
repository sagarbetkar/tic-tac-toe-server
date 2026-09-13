const WINNING_LINES = [
  [0,1,2], [3,4,5], [6,7,8],
  [0,3,6], [1,4,7], [2,5,8],
  [0,4,8], [2,4,6],
];

function createInitialState() {
  return {
    board: Array(9).fill(null),
    histories: { X: [], O: [] },
    currentPlayer: 'X',
    moveCount: 0,
    status: 'PLAYING',
    winner: null,
  };
}

function cloneState(state) {
  return {
    ...state,
    board: [...state.board],
    histories: { X: [...state.histories.X], O: [...state.histories.O] },
  };
}

function applyMove(state, player, cell) {
  if (state.status !== 'PLAYING') throw new Error('GAME_FINISHED');
  if (state.currentPlayer !== player) throw new Error('NOT_YOUR_TURN');
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw new Error('INVALID_CELL');
  if (state.board[cell] !== null) throw new Error('CELL_OCCUPIED');

  const next = cloneState(state);
  next.board[cell] = player;
  next.histories[player].push(cell);
  next.moveCount += 1;

  // Only the latest 3 moves made by each player stay visible.
  while (next.histories[player].length > 3) {
    const expired = next.histories[player].shift();
    if (next.board[expired] === player) next.board[expired] = null;
  }

  if (hasWinner(next.board, player)) {
    next.status = 'FINISHED';
    next.winner = player;
  } else {
    next.currentPlayer = player === 'X' ? 'O' : 'X';
  }

  return next;
}

function hasWinner(board, player) {
  return WINNING_LINES.some(([a,b,c]) => board[a] === player && board[b] === player && board[c] === player);
}

function findWinningMove(state, player) {
  for (let cell = 0; cell < 9; cell += 1) {
    if (state.board[cell] !== null) continue;
    try {
      const next = applyMove(state, player, cell);
      if (next.winner === player) return cell;
    } catch (_) {}
  }
  return null;
}

function legalMoves(state) {
  return state.board.map((v, i) => v === null ? i : -1).filter(i => i >= 0);
}

function botChooseMove(state, botPlayer, difficulty = 'MEDIUM') {
  const moves = legalMoves(state);
  if (!moves.length) return null;
  const opponent = botPlayer === 'X' ? 'O' : 'X';

  if (difficulty === 'EASY') {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  const win = findWinningMove(state, botPlayer);
  if (win !== null) return win;

  const block = findWinningMove(state, opponent);
  if (block !== null) return block;

  if (difficulty === 'HARD') {
    if (moves.includes(4)) return 4;
    const corners = moves.filter(m => [0,2,6,8].includes(m));
    if (corners.length) return corners[Math.floor(Math.random() * corners.length)];
  }

  return moves[Math.floor(Math.random() * moves.length)];
}

module.exports = { createInitialState, applyMove, hasWinner, botChooseMove, legalMoves, WINNING_LINES };
