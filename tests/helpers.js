'use strict';
// Utilitários compartilhados pelos testes que precisam de servidor + banco.
// IMPORTANTE: requerer este arquivo ANTES de qualquer coisa de ../src (ele prepara o ambiente de teste).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
process.env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
process.env.BCRYPT_ROUNDS = '10';

const fs = require('fs');
const path = require('path');

if (!/_test(\?|$)/.test(process.env.DATABASE_URL)) {
  console.error('Por segurança, os testes só rodam em um banco cujo nome termina com "_test".');
  console.error('Defina TEST_DATABASE_URL=postgresql://usuario:senha@localhost:5432/finapp_test');
  process.exit(1);
}

const { createApp } = require('../src/app');
const { pool, query } = require('../src/db/pool');

const PASS = 'Senha!Forte2026x';

class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = null; }
  async req(method, url, body, { headers = {} } = {}) {
    if (method !== 'GET' && body === undefined) body = {}; // como o frontend: todo não-GET leva JSON ({} se vazio)
    const h = { Origin: this.base, ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined && !('Content-Type' in h)) h['Content-Type'] = 'application/json';
    if (method !== 'GET' && this.csrf && !('X-CSRF-Token' in h)) h['X-CSRF-Token'] = this.csrf;
    const res = await fetch(this.base + url, {
      method, headers: h, redirect: 'manual',
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookie = pair.slice(i + 1) ? pair : '';
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* não é JSON */ }
    return { status: res.status, headers: res.headers, json, text };
  }
  async login(email, pw = PASS) {
    const r = await this.req('POST', '/api/auth/login', { email, password: pw });
    if (r.status === 200) this.csrf = r.json.csrfToken;
    return r;
  }
}

// Sobe o app numa porta livre, com as tabelas criadas e o banco de teste zerado.
async function startServer() {
  await query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  await query('TRUNCATE users CASCADE');
  const server = createApp({ authRateLimit: 10000 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    client: () => new Client(base),
    // Cria a conta, faz login e devolve o cliente já autenticado (com token CSRF).
    async newUser(email, name = 'Teste') {
      const c = new Client(base);
      await c.req('POST', '/api/auth/register', { name, email, password: PASS, passwordConfirm: PASS });
      await c.login(email);
      return c;
    },
    async stop() { server.close(); await pool.end(); },
  };
}

const tx = (over = {}) => ({ type: 'expense', category: 'Alimentação', description: 'Mercado', amount: '150,50', date: '2026-11-10', ...over });
const userId = async (email) => (await query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;

module.exports = { startServer, Client, tx, userId, query, PASS };
