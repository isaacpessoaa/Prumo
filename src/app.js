'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const { loadSession, requireAuth, requirePage, csrfGuard } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const transactionRoutes = require('./routes/transactions');
const budgetRoutes = require('./routes/budgets');

const VIEWS = path.join(__dirname, '..', 'views');
const PUBLIC = path.join(__dirname, '..', 'public');

function createApp(opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],          // nenhum script inline: bloqueia XSS injetado
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],     // anti-clickjacking
        ...(env.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: env.isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });

  app.use(express.json({ limit: '10kb', strict: true }));
  app.use(cookieParser());

  // Limite geral por IP em toda a API.
  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: opts.apiRateLimit ?? 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' },
  }));

  // Respostas da API e páginas autenticadas nunca ficam em cache.
  const noStore = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };

  app.use('/api', noStore, loadSession, csrfGuard);
  app.use('/api/auth', authRoutes(opts));
  app.use('/api', requireAuth, transactionRoutes());
  app.use('/api', requireAuth, budgetRoutes());
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

  // Arquivos estáticos (apenas /public — o resto do projeto NUNCA é servido).
  app.use(express.static(PUBLIC, { index: false, dotfiles: 'deny', maxAge: env.isProd ? '1h' : 0 }));

  // Páginas
  const sendView = (name) => (_req, res) => res.sendFile(name, { root: VIEWS });
  app.get('/', noStore, loadSession, (req, res) => res.redirect(req.auth ? '/dashboard' : '/login'));
  app.get('/login', noStore, loadSession, (req, res, next) => (req.auth ? res.redirect('/dashboard') : next()), sendView('login.html'));
  app.get('/register', noStore, loadSession, (req, res, next) => (req.auth ? res.redirect('/dashboard') : next()), sendView('register.html'));
  app.get('/dashboard', noStore, loadSession, requirePage, sendView('dashboard.html'));

  app.use((_req, res) => res.status(404).type('text').send('Página não encontrada.'));

  // Tratador de erros: nunca devolve stack trace nem detalhes internos ao cliente.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requisição grande demais.' });
    if (env.NODE_ENV !== 'test') console.error(`[erro] ${req.method} ${req.path}: ${err.message}`);
    return res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  });

  return app;
}

module.exports = { createApp };
