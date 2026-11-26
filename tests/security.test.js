'use strict';
// Testes automatizados de segurança e de funcionamento.
// Rode com:  npm test   (usa um banco de TESTE — o nome precisa terminar com _test)
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
process.env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
process.env.BCRYPT_ROUNDS = '10';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

if (!/_test(\?|$)/.test(process.env.DATABASE_URL)) {
  console.error('Por segurança, os testes só rodam em um banco cujo nome termina com "_test".');
  console.error('Defina TEST_DATABASE_URL=postgresql://usuario:senha@localhost:5432/finapp_test');
  process.exit(1);
}

const { createApp } = require('../src/app');
const { pool, query } = require('../src/db/pool');

let server; let base;
const PASS = 'Senha!Forte2026x';

class Client {
  constructor(b) { this.base = b; this.cookie = ''; this.csrf = null; }
  async req(method, url, body, { headers = {} } = {}) {
    const h = { Origin: this.base, ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    if (body !== undefined && !('Content-Type' in h)) h['Content-Type'] = 'application/json';
    if (method !== 'GET' && this.csrf && !('X-CSRF-Token' in h)) h['X-CSRF-Token'] = this.csrf;
    const res = await fetch(this.base + url, {
      method, headers: h, redirect: 'manual',
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const setCookie = res.headers.getSetCookie();
    for (const c of setCookie) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const val = pair.slice(i + 1);
      this.cookie = val ? pair : '';
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* não é JSON */ }
    return { status: res.status, headers: res.headers, json, text, setCookie };
  }
  async login(email, pw = PASS) {
    const r = await this.req('POST', '/api/auth/login', { email, password: pw });
    if (r.status === 200) this.csrf = r.json.csrfToken;
    return r;
  }
}
const mk = () => new Client(base);
const register = (c, email, name = 'Teste', pw = PASS) =>
  c.req('POST', '/api/auth/register', { name, email, password: pw, passwordConfirm: pw });
async function newUser(email) { const c = mk(); await register(c, email); await c.login(email); return c; }
const tx = (over = {}) => ({ type: 'expense', category: 'Alimentação', description: 'Mercado', amount: '150,50', date: '2026-11-10', ...over });

// requisição HTTP "crua" (não normaliza /../ como o fetch faz)
const rawGet = (p) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path: p }, (res) => {
    let d = ''; res.on('data', (x) => { d += x; }); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
  }).on('error', reject);
});

before(async () => {
  await query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8')); // garante as tabelas
  await query('TRUNCATE users CASCADE');
  server = createApp({ authRateLimit: 10000 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

/* ===================== Cadastro e senhas ===================== */
test('cadastro válido cria usuário e a senha é salva com hash bcrypt (nunca em texto)', async () => {
  const c = mk();
  const r = await register(c, 'ana@teste.com', 'Ana');
  assert.equal(r.status, 201);
  const { rows } = await query("SELECT password_hash FROM users WHERE email='ana@teste.com'");
  assert.match(rows[0].password_hash, /^\$2[aby]\$\d{2}\$/);
  assert.ok(!rows[0].password_hash.includes(PASS));
});

test('senhas fracas, curtas, longas demais ou diferentes são recusadas', async () => {
  const c = mk();
  for (const pw of ['curta1A', 'semnumeroNENHUM', 'SEMMINUSCULA123', 'semmaiuscula123', 'Password12345', 'Senha@123456', 'A1'.repeat(40)]) {
    const r = await register(c, `fraca${Math.random()}@teste.com`, 'X Y', pw);
    assert.equal(r.status, 400, `deveria recusar: ${pw.slice(0, 12)}`);
  }
  const r = await c.req('POST', '/api/auth/register', { name: 'Zé', email: 'ze@teste.com', password: PASS, passwordConfirm: PASS + 'x' });
  assert.equal(r.status, 400);
});

test('e-mail duplicado não cria 2ª conta (409) e e-mail é normalizado', async () => {
  const c = mk();
  assert.equal((await register(c, 'dup@teste.com')).status, 201);
  assert.equal((await register(c, 'DUP@Teste.com')).status, 409);
});

test('mass assignment: campos extras no cadastro são rejeitados', async () => {
  const r = await mk().req('POST', '/api/auth/register', { name: 'Hack', email: 'hack@teste.com', password: PASS, passwordConfirm: PASS, id: 'x', isAdmin: true });
  assert.equal(r.status, 400);
});

test('SQL injection em cadastro/login não funciona e as tabelas continuam intactas', async () => {
  const c = mk();
  const evil = "Robert'); DROP TABLE users;--";
  assert.equal((await register(c, 'bob@teste.com', evil)).status, 201);
  const { rows } = await query("SELECT name FROM users WHERE email='bob@teste.com'");
  assert.equal(rows[0].name, evil); // gravado como texto puro
  const r = await c.req('POST', '/api/auth/login', { email: "' OR '1'='1", password: "' OR '1'='1" });
  assert.ok([400, 401].includes(r.status));
  const login2 = await c.req('POST', '/api/auth/login', { email: { $ne: null }, password: { $ne: null } });
  assert.equal(login2.status, 400); // injeção por objeto (NoSQL-style) é recusada
  assert.equal((await query('SELECT count(*)::int AS n FROM users')).rows[0].n > 0, true);
});

/* ===================== Login, sessão e cookies ===================== */
test('login correto: cookie HttpOnly + SameSite=Strict; token no banco é só o hash', async () => {
  const c = mk();
  await register(c, 'cookie@teste.com');
  const r = await c.login('cookie@teste.com');
  assert.equal(r.status, 200);
  const sc = r.setCookie[0];
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Strict/i);
  assert.ok(!JSON.stringify(r.json).includes('password'), 'resposta não pode conter senha/hash');
  const token = sc.split(';')[0].split('=')[1];
  const { rows } = await query('SELECT token_hash FROM sessions');
  assert.ok(rows.every((x) => x.token_hash !== token), 'o token cru nunca é guardado');
  assert.ok(rows.every((x) => /^[0-9a-f]{64}$/.test(x.token_hash)));
});

test('mensagem de erro de login é idêntica para e-mail inexistente e senha errada', async () => {
  const c = mk();
  await register(c, 'igual@teste.com');
  const a = await c.req('POST', '/api/auth/login', { email: 'igual@teste.com', password: 'Errada!12345' });
  const b = await c.req('POST', '/api/auth/login', { email: 'naoexiste@teste.com', password: 'Errada!12345' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.json, b.json);
});

test('bloqueio de conta após 5 tentativas erradas (mesmo com a senha certa) e recuperação', async () => {
  const c = mk();
  await register(c, 'lock@teste.com');
  for (let i = 0; i < 5; i++) await c.req('POST', '/api/auth/login', { email: 'lock@teste.com', password: 'Errada!12345' });
  const blocked = await c.login('lock@teste.com');
  assert.equal(blocked.status, 401);
  await query("UPDATE users SET locked_until = now() - interval '1 minute' WHERE email='lock@teste.com'");
  assert.equal((await c.login('lock@teste.com')).status, 200);
});

test('fixação de sessão: cada login gera um token novo', async () => {
  const c = mk();
  await register(c, 'fix@teste.com');
  await c.login('fix@teste.com'); const t1 = c.cookie;
  await c.login('fix@teste.com'); const t2 = c.cookie;
  assert.notEqual(t1, t2);
});

test('rotas protegidas exigem login (API 401, página redireciona)', async () => {
  const c = mk();
  assert.equal((await c.req('GET', '/api/transactions')).status, 401);
  assert.equal((await c.req('GET', '/api/dashboard')).status, 401);
  assert.equal((await c.req('POST', '/api/transactions', tx())).status, 401);
  const p = await c.req('GET', '/dashboard');
  assert.equal(p.status, 302); assert.equal(p.headers.get('location'), '/login');
});

test('cookie forjado/aleatório não autentica', async () => {
  const c = mk(); c.cookie = 'sid=' + 'a'.repeat(43);
  assert.equal((await c.req('GET', '/api/auth/me')).status, 401);
  c.cookie = "sid=' OR 1=1--";
  assert.equal((await c.req('GET', '/api/auth/me')).status, 401);
});

test('sessão expirada no banco é recusada', async () => {
  const c = await newUser('exp@teste.com');
  assert.equal((await c.req('GET', '/api/auth/me')).status, 200);
  await query("UPDATE sessions SET expires_at = now() - interval '1 second'");
  assert.equal((await c.req('GET', '/api/auth/me')).status, 401);
});

test('logout destrói a sessão no servidor (cookie antigo para de funcionar)', async () => {
  const c = await newUser('out@teste.com');
  const old = c.cookie;
  assert.equal((await c.req('POST', '/api/auth/logout', {})).status, 200);
  c.cookie = old;
  assert.equal((await c.req('GET', '/api/auth/me')).status, 401);
});

test('trocar a senha derruba as outras sessões e invalida a senha antiga', async () => {
  const a = await newUser('troca@teste.com');
  const b = mk(); await b.login('troca@teste.com');
  const NEW = 'OutraSenha#2027zz';
  const bad = await a.req('POST', '/api/auth/change-password', { currentPassword: 'errada', newPassword: NEW, newPasswordConfirm: NEW });
  assert.equal(bad.status, 400);
  const ok = await a.req('POST', '/api/auth/change-password', { currentPassword: PASS, newPassword: NEW, newPasswordConfirm: NEW });
  assert.equal(ok.status, 200);
  assert.equal((await b.req('GET', '/api/auth/me')).status, 401);
  assert.equal((await a.req('GET', '/api/auth/me')).status, 200);
  assert.equal((await mk().login('troca@teste.com', PASS)).status, 401);
  assert.equal((await mk().login('troca@teste.com', NEW)).status, 200);
});

test('excluir conta exige senha e apaga tudo do usuário', async () => {
  const c = await newUser('apagar@teste.com');
  await c.req('POST', '/api/transactions', tx());
  assert.equal((await c.req('POST', '/api/auth/delete-account', { password: 'errada' })).status, 400);
  assert.equal((await c.req('POST', '/api/auth/delete-account', { password: PASS })).status, 200);
  const { rows } = await query("SELECT count(*)::int AS n FROM users WHERE email='apagar@teste.com'");
  assert.equal(rows[0].n, 0);
  assert.equal((await query('SELECT count(*)::int AS n FROM transactions t LEFT JOIN users u ON u.id=t.user_id WHERE u.id IS NULL')).rows[0].n, 0);
});

/* ===================== CSRF ===================== */
test('CSRF: sem token, token errado, origem externa e content-type errado são barrados', async () => {
  const c = await newUser('csrf@teste.com');
  const good = c.csrf;
  c.csrf = null;
  assert.equal((await c.req('POST', '/api/transactions', tx())).status, 403);
  assert.equal((await c.req('POST', '/api/transactions', tx(), { headers: { 'X-CSRF-Token': 'x'.repeat(64) } })).status, 403);
  c.csrf = good;
  assert.equal((await c.req('POST', '/api/transactions', tx(), { headers: { Origin: 'https://site-malicioso.com' } })).status, 403);
  assert.equal((await c.req('POST', '/api/transactions', tx(), { headers: { 'Sec-Fetch-Site': 'cross-site', Origin: undefined } })).status, 403);
  assert.equal((await c.req('POST', '/api/transactions', JSON.stringify(tx()), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await c.req('POST', '/api/transactions', 'a=1&b=2', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await c.req('POST', '/api/transactions', tx())).status, 201); // o legítimo funciona
});

test('login também recusa origem externa (login CSRF)', async () => {
  const r = await mk().req('POST', '/api/auth/login', { email: 'a@a.com', password: 'x' }, { headers: { Origin: 'https://evil.com' } });
  assert.equal(r.status, 403);
});

/* ===================== Autorização (IDOR) ===================== */
test('IDOR: um usuário não vê, edita nem apaga lançamentos de outro', async () => {
  const a = await newUser('a-idor@teste.com');
  const b = await newUser('b-idor@teste.com');
  const created = (await a.req('POST', '/api/transactions', tx({ description: 'Segredo da Ana' }))).json;
  assert.equal((await b.req('PUT', `/api/transactions/${created.id}`, tx({ description: 'invadido' }))).status, 404);
  assert.equal((await b.req('DELETE', `/api/transactions/${created.id}`, {})).status, 404);
  const list = (await b.req('GET', '/api/transactions?month=2026-11')).json;
  assert.equal(list.items.length, 0);
  const dash = (await b.req('GET', '/api/dashboard?month=2026-11')).json;
  assert.equal(dash.expenseCents, 0);
  const mine = (await a.req('GET', '/api/transactions?month=2026-11')).json.items;
  assert.equal(mine[0].description, 'Segredo da Ana'); // intacto
});

test('mass assignment em lançamentos: user_id/id extras são rejeitados', async () => {
  const c = await newUser('mass@teste.com');
  assert.equal((await c.req('POST', '/api/transactions', { ...tx(), user_id: '00000000-0000-0000-0000-000000000000' })).status, 400);
  assert.equal((await c.req('POST', '/api/transactions', { ...tx(), id: '1' })).status, 400);
});

test('ids inválidos (não-UUID, injeção) retornam 404 sem erro de banco', async () => {
  const c = await newUser('uuid@teste.com');
  for (const id of ['1', "1' OR '1'='1", '../../etc/passwd', '%00']) {
    assert.equal((await c.req('DELETE', `/api/transactions/${encodeURIComponent(id)}`, {})).status, 404);
  }
});

/* ===================== Validação de entrada ===================== */
test('valores e datas inválidos são recusados', async () => {
  const c = await newUser('valid@teste.com');
  for (const amount of ['0', '-10', '10,999', 'abc', '1e9', '9999999999', '', ' ', '1,2,3', 'NaN', 'Infinity']) {
    assert.equal((await c.req('POST', '/api/transactions', tx({ amount }))).status, 400, `amount=${amount}`);
  }
  assert.equal((await c.req('POST', '/api/transactions', tx({ amount: 12.5 }))).status, 400); // só string
  for (const date of ['2026-02-30', '2026-13-01', 'ontem', '1800-01-01', '2026-1-1', '9999-01-01']) {
    assert.equal((await c.req('POST', '/api/transactions', tx({ date }))).status, 400, `date=${date}`);
  }
  assert.equal((await c.req('POST', '/api/transactions', tx({ category: 'Salário' }))).status, 400); // categoria de entrada em saída
  assert.equal((await c.req('POST', '/api/transactions', tx({ type: 'transfer' }))).status, 400);
  assert.equal((await c.req('POST', '/api/transactions', tx({ description: 'x'.repeat(121) }))).status, 400);
  assert.equal((await c.req('POST', '/api/transactions', tx({ description: 'a\u0000b' }))).status, 400);
});

test('SQL injection em filtros e descrição: parâmetros são tratados como dado', async () => {
  const c = await newUser('sqli@teste.com');
  for (const q of ["type=expense' OR '1'='1", "month=2026-11';DROP TABLE users;--", 'page=1;SELECT 1', 'page=-1', 'page=abc']) {
    assert.equal((await c.req('GET', `/api/transactions?${q}`)).status, 400, q);
  }
  assert.equal((await c.req('GET', "/api/dashboard?month=2026-11'--")).status, 400);
  const evil = "x'); DELETE FROM transactions;--";
  const r = await c.req('POST', '/api/transactions', tx({ description: evil }));
  assert.equal(r.status, 201);
  assert.equal(r.json.description, evil);
  assert.equal((await c.req('GET', '/api/transactions?month=2026-11')).json.items.length, 1);
});

test('XSS: payload é armazenado como texto e devolvido como JSON (nunca como HTML)', async () => {
  const c = await newUser('xss@teste.com');
  const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const r = await c.req('POST', '/api/transactions', tx({ description: payload }));
  assert.equal(r.status, 201);
  const list = await c.req('GET', '/api/transactions?month=2026-11');
  assert.match(list.headers.get('content-type'), /application\/json/);
  assert.equal(list.json.items[0].description, payload);
  assert.equal(list.headers.get('x-content-type-options'), 'nosniff');
});

test('corpo muito grande (413) e JSON quebrado (400) não vazam detalhes internos', async () => {
  const c = await newUser('body@teste.com');
  const big = await c.req('POST', '/api/transactions', { ...tx(), description: 'x'.repeat(20000) });
  assert.equal(big.status, 413);
  const bad = await c.req('POST', '/api/transactions', '{"type": ');
  assert.equal(bad.status, 400);
  assert.ok(!/at\s.+\.js|node_modules|SyntaxError/.test(bad.text), 'sem stack trace');
});

/* ===================== Regras de negócio ===================== */
test('dashboard soma corretamente entradas, saídas, saldo e categorias', async () => {
  const c = await newUser('calc@teste.com');
  await c.req('POST', '/api/transactions', tx({ type: 'income', category: 'Salário', description: 'Salário', amount: '3000,00', date: '2026-10-05' }));
  await c.req('POST', '/api/transactions', tx({ type: 'income', category: 'Freelance', description: 'Job', amount: '500,25', date: '2026-11-05' }));
  await c.req('POST', '/api/transactions', tx({ amount: '200,10', date: '2026-11-06' }));
  await c.req('POST', '/api/transactions', tx({ category: 'Lazer', description: 'Cinema', amount: '49,90', date: '2026-11-07' }));
  const d = (await c.req('GET', '/api/dashboard?month=2026-11')).json;
  assert.equal(d.incomeCents, 50025);
  assert.equal(d.expenseCents, 25000);
  assert.equal(d.monthBalanceCents, 25025);
  assert.equal(d.accumulatedBalanceCents, 325025);
  assert.equal(d.expensesByCategory[0].category, 'Alimentação');
  assert.equal(d.history.length, 6);
  assert.equal(d.history[4].incomeCents, 300000);
  assert.equal(d.history[5].expenseCents, 25000);
});

test('criar, editar e excluir lançamento funciona para o dono', async () => {
  const c = await newUser('crud@teste.com');
  const created = (await c.req('POST', '/api/transactions', tx())).json;
  assert.equal(created.amountCents, 15050);
  const upd = await c.req('PUT', `/api/transactions/${created.id}`, tx({ amount: '99,99', description: 'Editado' }));
  assert.equal(upd.status, 200); assert.equal(upd.json.amountCents, 9999);
  assert.equal((await c.req('DELETE', `/api/transactions/${created.id}`, {})).status, 204);
  assert.equal((await c.req('GET', '/api/transactions?month=2026-11')).json.items.length, 0);
});

/* ===================== Cabeçalhos, arquivos e vazamentos ===================== */
test('cabeçalhos de segurança presentes e sem X-Powered-By', async () => {
  const r = await mk().req('GET', '/login');
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp.includes("default-src 'self'") && csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"));
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.ok(r.headers.get('permissions-policy'));
  const api = await mk().req('GET', '/api/auth/me');
  assert.equal(api.headers.get('cache-control'), 'no-store');
});

test('path traversal e arquivos sensíveis NÃO são servidos', async () => {
  const paths = ['/.env', '/%2e%2e/.env', '/../.env', '/..%2f.env', '/public/../.env', '/package.json', '/server.js',
    '/src/config/env.js', '/src/db/schema.sql', '/views/dashboard.html', '/node_modules/express/package.json',
    '/.git/config', '/%2e%2e/%2e%2e/etc/passwd', '/js/..%2f..%2f.env', '/css/%00.css'];
  for (const p of paths) {
    const r = await rawGet(p);
    assert.ok([400, 403, 404].includes(r.status), `${p} => ${r.status}`);
    assert.ok(!/DATABASE_URL|SESSION_SECRET|root:x:/.test(r.body), `${p} vazou conteúdo`);
  }
});

test('frontend não contém segredos nem práticas inseguras', () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  });
  walk(path.join(__dirname, '../public')); walk(path.join(__dirname, '../views'));
  assert.ok(files.length >= 7);
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/DATABASE_URL|SESSION_SECRET|password_hash|postgres(ql)?:\/\//i.test(s), `${f}: segredo exposto`);
    assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(s), `${f}: armazenamento inseguro no navegador`);
    assert.ok(!/\binnerHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\beval\s*\(|new Function\s*\(/.test(s), `${f}: sink de XSS`);
    if (f.endsWith('.html')) {
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(s), `${f}: script inline`);
      assert.ok(!/\son[a-z]+\s*=/i.test(s), `${f}: handler inline`);
      assert.ok(!/\sstyle\s*=/i.test(s), `${f}: style inline`);
      assert.ok(!/<script[^>]+src=["']https?:/i.test(s), `${f}: script externo`);
    }
  }
});

test('404 da API e de páginas não vazam informação', async () => {
  const c = await newUser('nf@teste.com');
  const a = await c.req('GET', '/api/nao-existe');
  assert.equal(a.status, 404);
  assert.equal((await rawGet('/qualquer-coisa')).status, 404);
});

test('limite de tentativas (rate limit) bloqueia força bruta com 429', async () => {
  const s = createApp({ authRateLimit: 3 }).listen(0);
  await new Promise((r) => s.once('listening', r));
  const c = new Client(`http://127.0.0.1:${s.address().port}`);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await c.req('POST', '/api/auth/login', { email: 'x@x.com', password: 'Errada!12345' })).status);
  s.close();
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});
