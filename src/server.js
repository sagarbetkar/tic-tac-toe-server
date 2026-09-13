const http = require('http');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');
const {
  createInitialState,
  applyMove,
  botChooseMove,
} = require('../game-engine/game_engine');

const PORT = process.env.PORT || 8080;
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGINS || '*')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS.includes('*') ? true : CLIENT_ORIGINS }));
app.get('/', (_req, res) => res.json({ ok: true, service: 'rolling-ttt-server', protocol: 'socket.io' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'rolling-ttt-server' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGINS.includes('*') ? '*' : CLIENT_ORIGINS,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

const rooms = new Map();
const matchmakingQueue = [];
const matchmakingTimers = new Map();

function participantId() {
  return crypto.randomUUID();
}

function makeCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function makeRoom(type = 'RANDOM') {
  let id;
  do id = makeCode(); while (rooms.has(id));
  const room = {
    id,
    type,
    maxPlayers: 2,
    ownerId: null,
    players: { X: null, O: null },
    state: createInitialState(),
    createdAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

function publicState(room) {
  return {
    roomId: room.id,
    type: room.type,
    maxPlayers: room.maxPlayers,
    state: room.state,
    players: {
      X: room.players.X
        ? { id: room.players.X.id, name: room.players.X.name, isBot: !!room.players.X.isBot }
        : null,
      O: room.players.O
        ? { id: room.players.O.id, name: room.players.O.name, isBot: !!room.players.O.isBot }
        : null,
    },
  };
}

function emitState(room, event = 'STATE', extra = {}) {
  io.to(room.id).emit(event, { game: publicState(room), ...extra });
}

function assignPlayer(room, socket, name, forcedMark = null) {
  const mark = forcedMark || (room.players.X ? (room.players.O ? null : 'O') : 'X');
  if (!mark) return null;

  room.players[mark] = {
    id: socket.id,
    name: String(name || 'Player').slice(0, 20),
    isBot: false,
  };

  socket.join(room.id);
  if (!room.ownerId) room.ownerId = socket.id;
  socket.data.roomId = room.id;
  socket.data.mark = mark;
  socket.data.playerName = room.players[mark].name;
  socket.emit('ROOM_JOINED', { mark, game: publicState(room) });
  return mark;
}

function addBot(room) {
  const mark = room.players.X ? 'O' : 'X';
  room.players[mark] = {
    id: `bot-${participantId()}`,
    name: 'Nova',
    isBot: true,
  };
  return mark;
}

function clearMatchmaking(socket) {
  const index = matchmakingQueue.indexOf(socket.id);
  if (index >= 0) matchmakingQueue.splice(index, 1);
  const timer = matchmakingTimers.get(socket.id);
  if (timer) clearTimeout(timer);
  matchmakingTimers.delete(socket.id);
}

function getQueuedSocket() {
  while (matchmakingQueue.length) {
    const socketId = matchmakingQueue.shift();
    const socket = io.sockets.sockets.get(socketId);
    if (socket && socket.connected && !socket.data.roomId) {
      matchmakingTimers.delete(socketId);
      return socket;
    }
    const timer = matchmakingTimers.get(socketId);
    if (timer) clearTimeout(timer);
    matchmakingTimers.delete(socketId);
  }
  return null;
}

function startBotFallback(socket) {
  const timer = matchmakingTimers.get(socket.id);
  if (timer) clearTimeout(timer);
  matchmakingTimers.delete(socket.id);

  if (!socket.connected || socket.data.roomId) return;

  const index = matchmakingQueue.indexOf(socket.id);
  if (index >= 0) matchmakingQueue.splice(index, 1);

  const room = makeRoom('BOT');
  assignPlayer(room, socket, socket.data.playerName || 'Player');
  addBot(room);
  emitState(room, 'GAME_STARTED');
  maybeBotMove(room);
}

function maybeBotMove(room) {
  if (!rooms.has(room.id) || room.state.status !== 'PLAYING') return;
  const mark = room.state.currentPlayer;
  const player = room.players[mark];
  if (!player?.isBot) return;

  setTimeout(() => {
    if (!rooms.has(room.id) || room.state.status !== 'PLAYING') return;
    const botCell = botChooseMove(room.state, mark, 'MEDIUM');
    if (botCell === null) return;

    try {
      room.state = applyMove(room.state, mark, botCell);
      emitState(room, 'STATE', { move: { player: mark, cell: botCell, bot: true } });
      if (room.state.status === 'FINISHED') scheduleRoomCleanup(room);
      else maybeBotMove(room);
    } catch (error) {
      io.to(room.id).emit('ERROR', { code: error.message || 'BOT_MOVE_FAILED' });
    }
  }, 700);
}

function scheduleRoomCleanup(room) {
  setTimeout(() => {
    const current = rooms.get(room.id);
    if (current && current.state.status === 'FINISHED') {
      rooms.delete(room.id);
    }
  }, 5 * 60 * 1000);
}

io.on('connection', (socket) => {
  socket.on('PLAY_ONLINE', ({ name } = {}) => {
    clearMatchmaking(socket);
    socket.data.playerName = String(name || 'Player').slice(0, 20);

    const opponent = getQueuedSocket();
    if (opponent) {
      const room = makeRoom('RANDOM');
      assignPlayer(room, opponent, opponent.data.playerName || 'Player');
      assignPlayer(room, socket, socket.data.playerName);
      emitState(room, 'GAME_STARTED');
      return;
    }

    matchmakingQueue.push(socket.id);
    socket.emit('MATCHMAKING', { status: 'WAITING' });
    const timer = setTimeout(() => startBotFallback(socket), 7000);
    matchmakingTimers.set(socket.id, timer);
  });

  socket.on('CANCEL_MATCHMAKING', () => {
    clearMatchmaking(socket);
    socket.emit('MATCHMAKING_CANCELLED');
  });

  socket.on('CREATE_PRIVATE', ({ name } = {}) => {
    clearMatchmaking(socket);
    const room = makeRoom('PRIVATE');
    assignPlayer(room, socket, name || 'Host');
    socket.emit('PRIVATE_CREATED', { roomId: room.id, game: publicState(room) });
  });

  socket.on('JOIN_ROOM', ({ roomId, name } = {}) => {
    clearMatchmaking(socket);
    const code = String(roomId || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit('ERROR', { code: 'ROOM_NOT_FOUND' });
    if (socket.data.roomId) return socket.emit('ERROR', { code: 'ALREADY_IN_ROOM' });

    const occupiedCount = Number(Boolean(room.players.X)) + Number(Boolean(room.players.O));
    if (occupiedCount >= room.maxPlayers) {
      return socket.emit('ERROR', { code: 'ROOM_FULL' });
    }

    // Private rooms are strictly 1 host + 1 invited friend.
    if (room.type === 'PRIVATE' && occupiedCount !== 1) {
      return socket.emit('ERROR', { code: 'PRIVATE_ROOM_UNAVAILABLE' });
    }
    if (room.state.status !== 'PLAYING') return socket.emit('ERROR', { code: 'GAME_FINISHED' });

    assignPlayer(room, socket, name || 'Player');
    if (room.players.X && room.players.O) {
      emitState(room, 'GAME_STARTED');
    }
  });

  socket.on('MOVE', ({ cell } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return socket.emit('ERROR', { code: 'ROOM_NOT_FOUND' });
    if (!socket.data.mark) return socket.emit('ERROR', { code: 'NOT_IN_GAME' });
    if (room.players[socket.data.mark]?.isBot) return socket.emit('ERROR', { code: 'INVALID_PLAYER' });

    try {
      const parsedCell = Number(cell);
      room.state = applyMove(room.state, socket.data.mark, parsedCell);
      emitState(room, 'STATE', {
        move: { player: socket.data.mark, cell: parsedCell, bot: false },
      });
      if (room.state.status === 'FINISHED') scheduleRoomCleanup(room);
      else maybeBotMove(room);
    } catch (error) {
      socket.emit('ERROR', { code: error.message || 'MOVE_FAILED' });
    }
  });

  socket.on('GET_STATE', () => {
    const room = rooms.get(socket.data.roomId);
    if (room) socket.emit('STATE', { game: publicState(room) });
  });

  socket.on('LEAVE_ROOM', () => {
    clearMatchmaking(socket);
    const room = rooms.get(socket.data.roomId);
    if (room) {
      const mark = socket.data.mark;
      if (mark && room.players[mark] && !room.players[mark].isBot) {
        socket.to(room.id).emit('OPPONENT_DISCONNECTED', { mark });
      }
      socket.leave(room.id);
      delete socket.data.roomId;
      delete socket.data.mark;
    }
  });

  socket.on('disconnect', () => {
    clearMatchmaking(socket);
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const mark = socket.data.mark;
    if (mark && room.players[mark] && !room.players[mark].isBot) {
      socket.to(room.id).emit('OPPONENT_DISCONNECTED', { mark });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Rolling TTT Socket.IO server listening on ${PORT}`);
});
