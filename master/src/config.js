const fs = require('fs');
const path = require('path');
require('dotenv').config();

const cfg = {
  httpPort: parseInt(process.env.HTTP_PORT, 10) || 4000,
  grpcPort: parseInt(process.env.GRPC_PORT, 10) || 50051,
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/cicd',
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-change-me',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  agentToken: process.env.AGENT_TOKEN || 'dev-agent-token',
  grpcTlsCert: process.env.GRPC_TLS_CERT || '',
  grpcTlsKey: process.env.GRPC_TLS_KEY || '',
  // master/proto/agent.proto (Docker image) or ../proto/agent.proto (repo checkout)
  protoPath: process.env.PROTO_PATH || [
    path.join(__dirname, '..', 'proto', 'agent.proto'),
    path.join(__dirname, '..', '..', 'proto', 'agent.proto'),
  ].find((p) => fs.existsSync(p)),
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'),
};

if (process.env.NODE_ENV === 'production') {
  for (const [k, v] of [['JWT_SECRET', process.env.JWT_SECRET], ['AGENT_TOKEN', process.env.AGENT_TOKEN], ['ADMIN_PASSWORD', process.env.ADMIN_PASSWORD]]) {
    if (!v) console.warn(`[config] WARNING: ${k} is not set; using an insecure default`);
  }
}

module.exports = cfg;
