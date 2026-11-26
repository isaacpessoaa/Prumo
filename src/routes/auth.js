'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { query } = require('../db/pool');
const { newToken, newCsrf, hashToken } = require('../utils/security');
const {
  registerSchema, loginSchema, changePasswordSchema, deleteAccountSchema,
} = require('../utils/validation');
const { COOKIE_NAME, cookieOptions, requireAuth } = require('../middleware/auth');

const MAX_SESSIONS_PER_USER = 5;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const GENERIC_LOGIN_ERROR = 'E-mail ou senha incorretos, ou conta temporariamente bloqueada.';

// Hash "falso" usado quando o e-mail não existe, para que o tempo de resposta
// seja igual e ninguém consiga descobrir quais e-mails estão cadastrados.
let dummyHashPromise;
const getDummyHash = () => {
  dummyHashPromise ||= bcrypt.hash('senha-falsa-para-igualar-tempo', env.BCRYPT_ROUNDS);
  return dummyHashPromise;
};

function fieldErrors(zodError) {
  const fields = {};
  for (const issue of zodError.issues) {
    const key = issue.path[0] || 'form';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

async function createSession(userId) {
  const token = newToken();
  const csrf = newCsrf();
  const expires = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600 * 1000);
  await query('DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()', [userId]);
  await query(
    `DELETE FROM sessions WHERE id IN (
       SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC OFFSET $2)`,
    [userId, MAX_SESSIONS_PER_USER - 1],
  );
  await query(
    'INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4)',
    [userId, hashToken(token), csrf, expires],
  );
  return { token, csrf, expires };
}

module.exports = function authRoutes(opts = {}) {
  const router = express.Router();
  const authLimit = opts.authRateLimit ?? 20;
  const limiter = (max) => rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' },
  });
  const sensitiveLimiter = limiter(authLimit);

  // ---------- Cadastro ----------
  router.post('/register', sensitiveLimiter, async (req, res, next) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Corrija os campos destacados.', fields: fieldErrors(parsed.error) });
      const { name, email, password } = parsed.data;

      const hash = await bcrypt.hash(password, env.BCRYPT_ROUNDS); // hash ANTES de consultar (tempo constante)
      const { rowCount } = await query(
        'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
        [name, email, hash],
      );
      if (rowCount === 0) {
        return res.status(409).json({ error: 'Não foi possível criar a conta. Se você já tem cadastro, entre com seu e-mail e senha.' });
      }
      return res.status(201).json({ message: 'Conta criada com sucesso. Agora é só entrar.' });
    } catch (err) { return next(err); }
  });

  // ---------- Login ----------
  router.post('/login', sensitiveLimiter, async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Informe um e-mail e uma senha válidos.' });
      const { email, password } = parsed.data;

      const { rows } = await query(
        'SELECT id, name, email, password_hash, locked_until FROM users WHERE email = $1',
        [email],
      );
      const user = rows[0];
      const ok = await bcrypt.compare(password, user ? user.password_hash : await getDummyHash());
      const locked = !!(user && user.locked_until && user.locked_until > new Date());

      if (!user || !ok || locked) {
        if (user && !ok && !locked) {
          await query(
            `UPDATE users SET failed_attempts = failed_attempts + 1,
                    locked_until = CASE WHEN failed_attempts + 1 >= $2
                                        THEN now() + make_interval(mins => $3) ELSE locked_until END
              WHERE id = $1`,
            [user.id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES],
          );
        }
        return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
      }

      await query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
      // Nova sessão a cada login (evita session fixation); descarta a anterior deste navegador.
      if (req.auth) await query('DELETE FROM sessions WHERE id = $1', [req.auth.sessionId]);
      const session = await createSession(user.id);
      res.cookie(COOKIE_NAME, session.token, cookieOptions(session.expires));
      return res.json({ user: { id: user.id, name: user.name, email: user.email }, csrfToken: session.csrf });
    } catch (err) { return next(err); }
  });

  // ---------- Sessão atual ----------
  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.auth.user, csrfToken: req.auth.csrf });
  });

  // ---------- Logout ----------
  router.post('/logout', requireAuth, async (req, res, next) => {
    try {
      await query('DELETE FROM sessions WHERE id = $1', [req.auth.sessionId]);
      res.clearCookie(COOKIE_NAME, cookieOptions());
      res.json({ message: 'Sessão encerrada.' });
    } catch (err) { next(err); }
  });

  // ---------- Troca de senha ----------
  router.post('/change-password', requireAuth, sensitiveLimiter, async (req, res, next) => {
    try {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Corrija os campos destacados.', fields: fieldErrors(parsed.error) });
      const { currentPassword, newPassword } = parsed.data;

      const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.auth.user.id]);
      const ok = rows[0] && (await bcrypt.compare(currentPassword, rows[0].password_hash));
      if (!ok) return res.status(400).json({ error: 'Corrija os campos destacados.', fields: { currentPassword: 'Senha atual incorreta.' } });

      const hash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
      await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, req.auth.user.id]);
      // Encerra TODAS as outras sessões: quem tinha a senha antiga perde o acesso.
      await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.auth.user.id, req.auth.sessionId]);
      res.json({ message: 'Senha alterada. Os outros dispositivos foram desconectados.' });
    } catch (err) { next(err); }
  });

  // ---------- Exclusão da conta (direito do titular) ----------
  router.post('/delete-account', requireAuth, sensitiveLimiter, async (req, res, next) => {
    try {
      const parsed = deleteAccountSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Informe sua senha.' });
      const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.auth.user.id]);
      const ok = rows[0] && (await bcrypt.compare(parsed.data.password, rows[0].password_hash));
      if (!ok) return res.status(400).json({ error: 'Senha incorreta.' });
      await query('DELETE FROM users WHERE id = $1', [req.auth.user.id]); // sessões e lançamentos saem em cascata
      res.clearCookie(COOKIE_NAME, cookieOptions());
      res.json({ message: 'Conta excluída.' });
    } catch (err) { next(err); }
  });

  return router;
};
