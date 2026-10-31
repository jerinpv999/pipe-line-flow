const fs = require('fs');
const http = require('http');
const path = require('path');
const cors = require('cors');
const express = require('express');
const mongoose = require('mongoose');
const cfg = require('./config');
const realtime = require('./realtime');
const apiRouter = require('./routes/api');
const dispatcher = require('./services/dispatcher');
const { startGrpcServer } = require('./grpc/server');

async function main() {
  await mongoose.connect(cfg.mongoUri);
  console.log('[mongo] connected');
  await dispatcher.recoverOnStartup();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRouter);

  // Serve the built React app (web/dist copied to master/public)
  if (fs.existsSync(path.join(cfg.publicDir, 'index.html'))) {
    app.use(express.static(cfg.publicDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
      res.sendFile(path.join(cfg.publicDir, 'index.html'));
    });
  }

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err.name === 'ValidationError' || err.name === 'CastError') status = 400;
    if (err.code === 11000) { status = 409; message = 'A pipeline with that name already exists'; }
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  const server = http.createServer(app);
  realtime.init(server);
  await new Promise((resolve) => server.listen(cfg.httpPort, resolve));
  console.log(`[http] API + UI on http://localhost:${cfg.httpPort}`);

  await startGrpcServer();
}

main().catch((err) => {
  console.error('[master] failed to start:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await dispatcher.flushLogs();
  process.exit(0);
});
