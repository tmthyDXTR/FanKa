const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = { hashPassword, verifyPassword };
