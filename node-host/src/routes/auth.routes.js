const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { hashPassword, verifyPassword } = require('../auth/passwords');
const { signAccessToken, generateRefreshToken, hashRefreshToken } = require('../auth/tokens');
const { requireAuth } = require('../auth/middleware');
const { isProduction, REFRESH_TOKEN_TTL_MS } = require('../env');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REFRESH_COOKIE = 'refreshToken';
const REFRESH_COOKIE_BASE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/api',
};
const REFRESH_COOKIE_SET_OPTIONS = { ...REFRESH_COOKIE_BASE_OPTIONS, maxAge: REFRESH_TOKEN_TTL_MS };

// Throttle auth endpoints to slow down credential-stuffing / brute-force attempts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function issueSession(res, user) {
  const accessToken = signAccessToken(user);
  const { token, tokenHash, expiresAt } = generateRefreshToken();
  db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    user.id,
    tokenHash,
    expiresAt
  );
  res.cookie(REFRESH_COOKIE, token, REFRESH_COOKIE_SET_OPTIONS);
  return accessToken;
}

router.post('/register', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const passwordHash = await hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(normalizedEmail, passwordHash);

  const user = { id: info.lastInsertRowid, email: normalizedEmail };
  const accessToken = issueSession(res, user);
  res.status(201).json({ accessToken, email: user.email });
});

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(normalizedEmail);
  const valid = user && (await verifyPassword(password, user.password_hash));
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const accessToken = issueSession(res, { id: user.id, email: user.email });
  res.json({ accessToken, email: user.email });
});

router.post('/refresh', (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) {
    return res.status(401).json({ error: 'Missing refresh token.' });
  }

  const row = db
    .prepare(
      `SELECT rt.id AS id, rt.expires_at AS expiresAt, u.id AS userId, u.email AS email
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = ?`
    )
    .get(hashRefreshToken(token));

  if (!row || new Date(row.expiresAt) < new Date()) {
    res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_BASE_OPTIONS);
    return res.status(401).json({ error: 'Refresh token expired or invalid.' });
  }

  // Rotate on every use: the old token is immediately invalidated so a stolen,
  // already-used token can't be replayed.
  db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(row.id);
  const accessToken = issueSession(res, { id: row.userId, email: row.email });
  res.json({ accessToken, email: row.email });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) {
    db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(hashRefreshToken(token));
  }
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_BASE_OPTIONS);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email });
});

module.exports = router;
