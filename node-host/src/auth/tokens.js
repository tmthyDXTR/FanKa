const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL_MS } = require('../env');

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

// Throws if the token is missing, malformed, expired, or has a bad signature.
function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateRefreshToken() {
  const token = crypto.randomBytes(48).toString('hex');
  return {
    token,
    tokenHash: hashRefreshToken(token),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
  };
}

module.exports = { signAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken };
