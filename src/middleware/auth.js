'use strict';
const env = require('../config/env');
const { query } = require('../db/pool');
const { hashToken, safeEqual } = require('../utils/security');

// Em produção usa o prefixo __Host-, que obriga Secure + Path=/ + sem Domain.
const COOKIE_NAME = env.isProd ? '__Host-sid' : 'sid';

const cookieOptions = (expires) => ({
  httpOnly: true,            // JavaScript do navegador NÃO consegue ler (protege contra XSS)
  secure: env.isProd,        // só trafega por HTTPS em produção
  sameSite: 'strict',        // não é enviado em requisições vindas de outros sites (CSRF)
  path: '/',
  ...(expires ? { expires } : {}),
});

// Identifica o usuário a partir do cookie. Nunca confia em dados enviados pelo cliente.
async function loadSession(req, _res, next) {
  req.auth = null;
  try {
    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (typeof token === 'string' && token.length >= 20 && token.length <= 100) {
      const { rows } = await query(
        `SELECT s.id AS session_id, s.csrf_token, u.id AS user_id, u.name, u.email
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hashToken(token)],
      );
      if (rows[0]) {
        req.auth = {
          sessionId: rows[0].session_id,
          csrf: rows[0].csrf_token,
          user: { id: rows[0].user_id, name: rows[0].name, email: rows[0].email },
        };
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

const requireAuth = (req, res, next) => {
  if (!req.auth) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  return next();
};

const requirePage = (req, res, next) => {
  if (!req.auth) return res.redirect('/login');
  return next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Proteção CSRF em camadas: SameSite=Strict + checagem de Origin + exigência de
// Content-Type JSON (força preflight CORS) + token CSRF por sessão no header.
function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.get('host'); } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'Origem não permitida.' });
  } else {
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      return res.status(403).json({ error: 'Origem não permitida.' });
    }
  }

  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type deve ser application/json.' });
  }

  if (req.auth && !safeEqual(req.get('x-csrf-token'), req.auth.csrf)) {
    return res.status(403).json({ error: 'Token CSRF inválido.' });
  }
  return next();
}

module.exports = { COOKIE_NAME, cookieOptions, loadSession, requireAuth, requirePage, csrfGuard };
