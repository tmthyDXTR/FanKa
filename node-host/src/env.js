require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  if (isProduction) {
    throw new Error('JWT_SECRET environment variable is required in production.');
  }
  console.warn('JWT_SECRET not set; using an insecure development default. Set it before deploying.');
}

module.exports = {
  isProduction,
  JWT_SECRET: JWT_SECRET || 'dev-insecure-secret-change-me',
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  DB_PATH: process.env.DB_PATH || null,
};
