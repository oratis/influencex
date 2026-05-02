const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { queryOne, exec } = require('./database');
const { v4: uuidv4 } = require('uuid');

const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// Rate limiting for login attempts
const loginAttempts = new Map(); // email -> { count, resetAt }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(email) {
  const now = Date.now();
  const record = loginAttempts.get(email);
  if (!record || now > record.resetAt) {
    return { allowed: true };
  }
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    const remainingMs = record.resetAt - now;
    const remainingMin = Math.ceil(remainingMs / 60000);
    return { allowed: false, remainingMin };
  }
  return { allowed: true };
}

function recordLoginAttempt(email, success) {
  const now = Date.now();
  if (success) {
    loginAttempts.delete(email);
    return;
  }
  const record = loginAttempts.get(email) || { count: 0, resetAt: now + LOCKOUT_DURATION };
  record.count += 1;
  record.resetAt = now + LOCKOUT_DURATION;
  loginAttempts.set(email, record);
}

// Cleanup stale entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [email, record] of loginAttempts) {
    if (now > record.resetAt) loginAttempts.delete(email);
  }
}, 30 * 60 * 1000);

// bcrypt cost factor. Each +1 doubles hash time; 12 is the modern OWASP
// recommendation for 2026-era hardware. Existing user hashes at cost 10
// continue to verify (bcrypt encodes cost in the digest); only NEW or RESET
// passwords pay the higher cost. Audit S-8.
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS) || 12;
function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

async function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE).toISOString();
  await exec('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [id, userId, expiresAt]);
  await exec('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
  return { token: id, expiresAt };
}

async function getSession(token) {
  if (!token) return null;
  const session = await queryOne('SELECT s.*, u.id as uid, u.email, u.name, u.role, u.avatar_url FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?', [token]);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await exec('DELETE FROM sessions WHERE id = ?', [token]);
    return null;
  }
  return { id: session.uid, email: session.email, name: session.name, role: session.role, avatar_url: session.avatar_url };
}

async function destroySession(token) {
  await exec('DELETE FROM sessions WHERE id = ?', [token]);
}

// Middleware: extract user from Authorization header or cookie
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const user = await getSession(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(500).json({ error: 'Auth error: ' + e.message });
  }
}

async function registerUser(email, password, name) {
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return { error: 'Email already registered' };
  const id = uuidv4();
  const passwordHash = hashPassword(password);
  const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}`;
  await exec('INSERT INTO users (id, email, password_hash, name, avatar_url) VALUES (?, ?, ?, ?, ?)', [id, email, passwordHash, name, avatarUrl]);
  return { id, email, name, avatar_url: avatarUrl };
}

async function loginUser(email, password) {
  // Check rate limit
  const rateCheck = checkLoginRateLimit(email);
  if (!rateCheck.allowed) {
    return { error: `Too many login attempts. Please try again in ${rateCheck.remainingMin} minutes.` };
  }

  const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    recordLoginAttempt(email, false);
    return { error: 'Invalid email or password' };
  }
  if (!verifyPassword(password, user.password_hash)) {
    recordLoginAttempt(email, false);
    return { error: 'Invalid email or password' };
  }
  recordLoginAttempt(email, true);
  const session = await createSession(user.id);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar_url: user.avatar_url }
  };
}

async function cleanupExpiredSessions() {
  try {
    await exec('DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP');
  } catch (e) {
    console.error('Session cleanup error:', e.message);
  }
}

// Run cleanup every hour
setInterval(cleanupExpiredSessions, 60 * 60 * 1000);

module.exports = { authMiddleware, registerUser, loginUser, destroySession, getSession, cleanupExpiredSessions, createSession };
