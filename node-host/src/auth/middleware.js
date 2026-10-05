const { verifyAccessToken } = require('./tokens');

function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token.' });
  }

  try {
    req.user = verifyAccessToken(token); // { sub, email, iat, exp }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

module.exports = { requireAuth };
