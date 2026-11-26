'use strict';
const crypto = require('crypto');
const env = require('../config/env');

const newToken = () => crypto.randomBytes(32).toString('base64url'); // 256 bits
const newCsrf = () => crypto.randomBytes(32).toString('hex');
// O banco guarda apenas o HMAC do token: vazamento do banco não permite sequestrar sessões.
const hashToken = (token) => crypto.createHmac('sha256', env.SESSION_SECRET).update(token).digest('hex');

const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

module.exports = { newToken, newCsrf, hashToken, safeEqual };
