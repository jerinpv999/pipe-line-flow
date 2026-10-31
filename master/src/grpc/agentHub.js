// Keeps the live gRPC stream for each connected agent.
const connections = new Map(); // agentId -> ServerDuplexStream

module.exports = {
  set(agentId, call) {
    connections.set(agentId, call);
  },
  get(agentId) {
    return connections.get(agentId);
  },
  // Only removes the entry if it still belongs to this call (a newer connection may have replaced it)
  remove(agentId, call) {
    if (connections.get(agentId) === call) {
      connections.delete(agentId);
      return true;
    }
    return false;
  },
  isOnline(agentId) {
    return connections.has(String(agentId));
  },
  send(agentId, message) {
    const call = connections.get(String(agentId));
    if (!call) return false;
    try {
      call.write(message);
      return true;
    } catch (err) {
      console.error(`[grpc] failed to write to agent ${agentId}:`, err.message);
      return false;
    }
  },
  onlineIds() {
    return [...connections.keys()];
  },
};
