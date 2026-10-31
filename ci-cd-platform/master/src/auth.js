const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cfg = require('./config');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function login(username, password) {
  const ok = safeEqual(username, cfg.adminUser) & safeEqual(password, cfg.adminPassword);
  if (!ok) return null;
  return jwt.sign({ sub: username }, cfg.jwtSecret, { expiresIn: '12h' });
}

function verifyToken(token) {
  return jwt.verify(token, cfg.jwtSecret);
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { safeEqual, login, verifyToken, requireAuth };
