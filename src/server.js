const http = require('http');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createInitialState, applyMove, botChooseMove } = require('../game-engine/game_engine');

const PORT = process.env.PORT || 8080;
const app = express();
app.use(cors());
app.get('/health', (_, res) => res.json({ ok: true, service: 'rolling-ttt-server' }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/' });
const rooms = new Map();
const matchmaking = [];

function makeCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function makeRoom(type = 'RANDOM') {
  let code;
  do code = makeCode(); while (rooms.has(code));
  const room = {
    id: code,
    type,
    players: { X: null, O: null },
    sockets: new Map(),
    state: createInitialState(),
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function participantId() { return crypto.randomUUID(); }

function send(socket, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(room, payload) {
  for (const socket of room.sockets.keys()) send(socket, payload);
}

function publicState(room) {
  return {
    roomId: room.id,
    type: room.type,
    state: room.state,
    players: {
      X: room.players.X ? { id: room.players.X.id, name: room.players.X.name, isBot: !!room.players.X.isBot } : null,
      O: room.players.O ? { id: room.players.O.id, name: room.players.O.name, isBot: !!room.players.O.isBot } : null,
    },
  };
}

function joinRoom(room, socket, player) {
  const mark = room.players.X ? (room.players.O ? null : 'O') : 'X';
  if (!mark) return false;
  room.players[mark] = player;
  room.sockets.set(socket, mark);
  socket.roomId = room.id;
  socket.playerId = player.id;
  socket.mark = mark;
  send(socket, { type: 'ROOM_JOINED', mark, game: publicState(room) });
  if (room.players.X && room.players.O) broadcast(room, { type: 'GAME_STARTED', game: publicState(room) });
  return true;
}

function addBot(room) {
  if (!room.players.X) room.players.X = { id: participantId(), name: 'Nova', isBot: true };
  else if (!room.players.O) room.players.O = { id: participantId(), name: 'Nova', isBot: true };
}

function maybeBotMove(room) {
  const current = room.state.currentPlayer;
  const player = room.players[current];
  if (!player?.isBot || room.state.status !== 'PLAYING') return;
  setTimeout(() => {
    if (!rooms.has(room.id) || room.state.status !== 'PLAYING') return;
    const cell = botChooseMove(room.state, current, 'MEDIUM');
    if (cell === null) return;
    try {
      room.state = applyMove(room.state, current, cell);
      broadcast(room, { type: 'STATE', game: publicState(room), move: { player: current, cell, bot: true } });
    } catch (e) {
      broadcast(room, { type: 'ERROR', code: e.message });
    }
    maybeBotMove(room);
  }, 700);
}

function findWaitingHuman() {
  while (matchmaking.length) {
    const socket = matchmaking.shift();
    if (socket.readyState === WebSocket.OPEN && !socket.roomId) return socket;
  }
  return null;
}

function handleMessage(socket, message) {
  let data;
  try { data = JSON.parse(message.toString()); } catch { return send(socket, { type: 'ERROR', code: 'INVALID_JSON' }); }

  if (data.type === 'PLAY_ONLINE') {
    const waiting = findWaitingHuman();
    if (waiting) {
      const room = makeRoom('RANDOM');
      joinRoom(room, waiting, { id: waiting.playerId || participantId(), name: waiting.playerName || 'Player' });
      joinRoom(room, socket, { id: participantId(), name: data.name || 'Player' });
      return;
    }
    socket.playerName = data.name || 'Player';
    matchmaking.push(socket);
    send(socket, { type: 'MATCHMAKING', status: 'WAITING' });
    setTimeout(() => {
      const idx = matchmaking.indexOf(socket);
      if (idx >= 0 && socket.readyState === WebSocket.OPEN) {
        matchmaking.splice(idx, 1);
        const room = makeRoom('BOT');
        joinRoom(room, socket, { id: participantId(), name: socket.playerName || 'Player' });
        addBot(room);
        send(socket, { type: 'GAME_STARTED', game: publicState(room) });
        maybeBotMove(room);
      }
    }, 7000);
    return;
  }

  if (data.type === 'CREATE_PRIVATE') {
    const room = makeRoom('PRIVATE');
    joinRoom(room, socket, { id: participantId(), name: data.name || 'Host' });
    send(socket, { type: 'PRIVATE_CREATED', roomId: room.id, game: publicState(room) });
    return;
  }

  if (data.type === 'JOIN_ROOM') {
    const room = rooms.get(String(data.roomId || '').toUpperCase());
    if (!room) return send(socket, { type: 'ERROR', code: 'ROOM_NOT_FOUND' });
    if (room.players.X && room.players.O) return send(socket, { type: 'ERROR', code: 'ROOM_FULL' });
    joinRoom(room, socket, { id: participantId(), name: data.name || 'Player' });
    return;
  }

  if (data.type === 'MOVE') {
    const room = rooms.get(socket.roomId);
    if (!room) return send(socket, { type: 'ERROR', code: 'ROOM_NOT_FOUND' });
    try {
      room.state = applyMove(room.state, socket.mark, Number(data.cell));
      broadcast(room, { type: 'STATE', game: publicState(room), move: { player: socket.mark, cell: Number(data.cell), bot: false } });
      maybeBotMove(room);
    } catch (e) {
      send(socket, { type: 'ERROR', code: e.message });
    }
    return;
  }

  if (data.type === 'GET_STATE') {
    const room = rooms.get(socket.roomId);
    if (room) send(socket, { type: 'STATE', game: publicState(room) });
    return;
  }
}

wss.on('connection', socket => {
  socket.on('message', msg => handleMessage(socket, msg));
  socket.on('close', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.sockets.delete(socket);
    const player = room.players[socket.mark];
    if (player && !player.isBot) {
      broadcast(room, { type: 'OPPONENT_DISCONNECTED', mark: socket.mark });
    }
  });
});

server.listen(PORT, () => console.log(`Rolling TTT server listening on ${PORT}`));
