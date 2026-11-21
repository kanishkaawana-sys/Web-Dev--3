const { Server } = require('socket.io');
const { authenticateToken, extractBearerToken } = require('../middleware/auth');

const ADMIN_ROOM = 'admin-room';
const userRoom = (userId) => `user:${userId}`;

// Server -> client event names, used identically by listeners and the demo client
const SOCKET_EVENTS = Object.freeze({
  SOCKET_READY: 'socket:ready',
  STOCK_UPDATED: 'stock:updated',
  ALERT_LOW_STOCK: 'alert:lowStock',
  ORDER_NEW: 'order:new',
  ORDER_STATUS_CHANGED: 'order:statusChanged'
});

let io = null;

const allowedOrigins = () =>
  (process.env.CLIENT_ORIGIN || 'http://localhost:5000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

/**
 * Attaches Socket.IO to the HTTP server. Call once from server.js.
 *
 * Authentication: the client must send a valid access token in
 * socket.handshake.auth.token (or ?token=... in the query string).
 * Rooms: every user joins "user:<userId>"; admins and managers also join "admin-room".
 */
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins(),
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Handshake authentication
  io.use(async (socket, next) => {
    try {
      const rawToken = (socket.handshake.auth && socket.handshake.auth.token) || socket.handshake.query.token;
      const token = extractBearerToken(rawToken);

      if (!token) {
        return next(new Error('Authentication error: token missing'));
      }

      const user = await authenticateToken(token);
      socket.user = {
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role
      };
      return next();
    } catch (err) {
      return next(new Error(`Authentication error: ${err.message}`));
    }
  });

  io.on('connection', (socket) => {
    const { id, name, role } = socket.user;
    const rooms = [userRoom(id)];

    socket.join(userRoom(id));
    if (role === 'admin' || role === 'manager') {
      socket.join(ADMIN_ROOM);
      rooms.push(ADMIN_ROOM);
    }

    console.log(`[SOCKET] Connected: ${name} (${role}) sid=${socket.id} rooms=${rooms.join(', ')}`);

    // Tells the client who it is and which rooms it joined (drives the demo client's status panel)
    socket.emit(SOCKET_EVENTS.SOCKET_READY, {
      userId: id,
      name,
      role,
      rooms,
      socketId: socket.id,
      connectedAt: new Date().toISOString()
    });

    socket.on('disconnect', (reason) => {
      console.log(`[SOCKET] Disconnected: ${name} (${role}) sid=${socket.id} reason=${reason}`);
    });
  });

  console.log('[SOCKET] Socket.IO server initialised');
  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.IO has not been initialised. Call initSocket(httpServer) first.');
  }
  return io;
};

// Emits to every connected admin and manager. A safe no-op before initialisation.
const emitToAdmins = (event, payload) => {
  if (io) io.to(ADMIN_ROOM).emit(event, payload);
};

// Emits to every connection (tab/device) belonging to one user
const emitToUser = (userId, event, payload) => {
  if (io && userId) io.to(userRoom(userId)).emit(event, payload);
};

module.exports = {
  initSocket,
  getIO,
  emitToAdmins,
  emitToUser,
  ADMIN_ROOM,
  userRoom,
  SOCKET_EVENTS
};