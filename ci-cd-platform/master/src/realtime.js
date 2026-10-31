// Socket.IO: pushes live agent status, run/job status and log lines to the web UI.
const { Server } = require('socket.io');
const { verifyToken } = require('./auth');

let io = null;

function init(httpServer) {
  io = new Server(httpServer, { cors: { origin: '*' } });

  io.use((socket, next) => {
    try {
      socket.user = verifyToken(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.on('subscribe:job', (jobId) => typeof jobId === 'string' && socket.join(`job:${jobId}`));
    socket.on('unsubscribe:job', (jobId) => typeof jobId === 'string' && socket.leave(`job:${jobId}`));
  });
}

const emit = (event, data) => io && io.emit(event, data);
const emitTo = (room, event, data) => io && io.to(room).emit(event, data);

module.exports = { init, emit, emitTo };
