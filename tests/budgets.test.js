'use strict';
// Testes do orçamento por categoria: API (CRUD, validação, CSRF, IDOR) e o cálculo no painel.
// Rode com:  npm test   (usa o banco de TESTE — o nome precisa terminar com _test)
const { startServer, tx, query } = require('./helpers'); // helpers primeiro: prepara o ambiente de teste
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let app;
before(async () => { app = await startServer(); });
after(async () => { await app.stop(); });

const put = (c, category, limit) => c.req('PUT', '/api/budgets', { category, limit });

/* ===================== Acesso ===================== */
test('orçamento exige login em todas as rotas', async () => {
  const c = app.client();
  assert.equal((await c.req('GET', '/api/budgets')).status, 401);
  assert.equal((await c.req('PUT', '/api/budgets', { category: 'Lazer', limit: '100,00' })).status, 401);
  assert.equal((await c.req('DELETE', '/api/budgets/Lazer')).status, 401);
});

test('CSRF: salvar ou remover orçamento sem token, ou de outra origem, é barrado', async () => {
  const c = await app.newUser('csrf-orc@teste.com');
  const good = c.csrf;
  c.csrf = null;
  assert.equal((await put(c, 'Lazer', '100,00')).status, 403);
  assert.equal((await c.req('DELETE', '/api/budgets/Lazer')).status, 403);
  c.csrf = good;
  assert.equal((await c.req('PUT', '/api/budgets', { category: 'Lazer', limit: '100,00' }, { headers: { Origin: 'https://site-malicioso.com' } })).status, 403);
  assert.equal((await put(c, 'Lazer', '100,00')).status, 200); // o legítimo funciona
});

/* ===================== CRUD ===================== */
test('criar, listar, atualizar (upsert) e remover um orçamento', async () => {
  const c = await app.newUser('crud-orc@teste.com');
  assert.deepEqual((await c.req('GET', '/api/budgets')).json, []);

  const created = await put(c, 'Alimentação', '800,00');
  assert.equal(created.status, 200);
  assert.deepEqual(created.json, { category: 'Alimentação', limitCents: 80000 });
  await put(c, 'Lazer', '150,50');

  // mesma categoria de novo = atualiza, não duplica
  const upd = await put(c, 'Alimentação', '950,00');
  assert.equal(upd.json.limitCents, 95000);
  const list = (await c.req('GET', '/api/budgets')).json;
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((b) => b.category), ['Alimentação', 'Lazer']);
  assert.equal(list[0].limitCents, 95000);
  assert.equal(list[1].limitCents, 15050);

  assert.equal((await c.req('DELETE', `/api/budgets/${encodeURIComponent('Alimentação')}`)).status, 204);
  assert.equal((await c.req('DELETE', `/api/budgets/${encodeURIComponent('Alimentação')}`)).status, 404); // já removido
  assert.equal((await c.req('GET', '/api/budgets')).json.length, 1);
});

/* ===================== Validação ===================== */
test('categoria de entrada, inexistente ou vazia é recusada', async () => {
  const c = await app.newUser('cat-orc@teste.com');
  for (const category of ['Salário', 'Inexistente', '', 'x'.repeat(41), "Lazer'; DROP TABLE budgets;--"]) {
    const r = await put(c, category, '100,00');
    assert.equal(r.status, 400, `categoria=${category.slice(0, 20)}`);
    assert.ok(r.json.fields.category);
  }
  assert.equal((await c.req('GET', '/api/budgets')).json.length, 0);
});

test('limites inválidos são recusados', async () => {
  const c = await app.newUser('lim-orc@teste.com');
  for (const limit of ['0', '-10', '10,999', 'abc', '', ' ', '1e9', '9999999999', 'NaN']) {
    const r = await put(c, 'Lazer', limit);
    assert.equal(r.status, 400, `limite=${limit}`);
    assert.ok(r.json.fields.limit);
  }
  assert.equal((await put(c, 'Lazer', 100)).status, 400); // só string, como nos lançamentos
  assert.equal((await c.req('GET', '/api/budgets')).json.length, 0);
});

test('mass assignment: campos extras no orçamento são rejeitados', async () => {
  const c = await app.newUser('mass-orc@teste.com');
  const r = await c.req('PUT', '/api/budgets', { category: 'Lazer', limit: '100,00', user_id: '00000000-0000-0000-0000-000000000000' });
  assert.equal(r.status, 400);
  assert.equal((await c.req('PUT', '/api/budgets', { category: 'Lazer', limit: '100,00', id: '1' })).status, 400);
});

test('remover categoria que não existe na lista de saídas devolve 404', async () => {
  const c = await app.newUser('del-orc@teste.com');
  for (const cat of ['Salário', 'Nada', '1', "' OR '1'='1"]) {
    assert.equal((await c.req('DELETE', `/api/budgets/${encodeURIComponent(cat)}`)).status, 404, cat);
  }
});

/* ===================== Autorização (IDOR) ===================== */
test('IDOR: um usuário não vê nem remove o orçamento de outro', async () => {
  const a = await app.newUser('a-orc@teste.com');
  const b = await app.newUser('b-orc@teste.com');
  await put(a, 'Moradia', '2000,00');
  assert.deepEqual((await b.req('GET', '/api/budgets')).json, []);
  assert.equal((await b.req('DELETE', '/api/budgets/Moradia')).status, 404);
  assert.equal((await a.req('GET', '/api/budgets')).json.length, 1); // o da Ana segue intacto

  // cada um tem o seu limite para a mesma categoria, sem interferir
  await put(b, 'Moradia', '500,00');
  assert.equal((await a.req('GET', '/api/budgets')).json[0].limitCents, 200000);
  assert.equal((await b.req('GET', '/api/budgets')).json[0].limitCents, 50000);
  assert.deepEqual((await b.req('GET', '/api/dashboard?month=2026-11')).json.budgets.map((x) => x.limitCents), [50000]);
});

test('excluir a conta apaga também os orçamentos', async () => {
  const c = await app.newUser('conta-orc@teste.com');
  await put(c, 'Lazer', '100,00');
  const antes = (await query("SELECT count(*)::int AS n FROM budgets b JOIN users u ON u.id = b.user_id WHERE u.email = 'conta-orc@teste.com'")).rows[0].n;
  assert.equal(antes, 1);
  assert.equal((await c.req('POST', '/api/auth/delete-account', { password: require('./helpers').PASS })).status, 200);
  assert.equal((await query('SELECT count(*)::int AS n FROM budgets b LEFT JOIN users u ON u.id = b.user_id WHERE u.id IS NULL')).rows[0].n, 0);
  assert.equal((await query("SELECT count(*)::int AS n FROM users WHERE email = 'conta-orc@teste.com'")).rows[0].n, 0);
});

/* ===================== Painel: gasto x limite ===================== */
test('painel calcula gasto, percentual e status de cada orçamento (mais críticos primeiro)', async () => {
  const c = await app.newUser('painel-orc@teste.com');
  await put(c, 'Lazer', '100,00');        // vai gastar 50  -> 50%  ok
  await put(c, 'Alimentação', '200,00');  // vai gastar 170 -> 85%  warning
  await put(c, 'Transporte', '100,00');   // vai gastar 130 -> 130% over
  await put(c, 'Moradia', '500,00');      // sem gasto      -> 0%   ok

  const post = (body) => c.req('POST', '/api/transactions', tx(body));
  await post({ category: 'Lazer', description: 'Cinema', amount: '50,00', date: '2026-11-05' });
  await post({ category: 'Alimentação', description: 'Mercado', amount: '100,00', date: '2026-11-06' });
  await post({ category: 'Alimentação', description: 'Padaria', amount: '70,00', date: '2026-11-20' });
  await post({ category: 'Transporte', description: 'Uber', amount: '130,00', date: '2026-11-21' });
  // não podem contar no orçamento de novembro:
  await post({ category: 'Lazer', description: 'Show de outubro', amount: '999,00', date: '2026-10-31' });
  await post({ category: 'Moradia', description: 'Aluguel de dezembro', amount: '999,00', date: '2026-12-01' });
  await post({ type: 'income', category: 'Salário', description: 'Salário', amount: '5000,00', date: '2026-11-05' });

  const d = (await c.req('GET', '/api/dashboard?month=2026-11')).json;
  assert.deepEqual(d.budgets, [
    { category: 'Transporte', limitCents: 10000, spentCents: 13000, percent: 130, status: 'over' },
    { category: 'Alimentação', limitCents: 20000, spentCents: 17000, percent: 85, status: 'warning' },
    { category: 'Lazer', limitCents: 10000, spentCents: 5000, percent: 50, status: 'ok' },
    { category: 'Moradia', limitCents: 50000, spentCents: 0, percent: 0, status: 'ok' },
  ]);
});

test('o mesmo limite vale em cada mês: outubro mostra o gasto de outubro', async () => {
  const c = await app.newUser('meses-orc@teste.com');
  await put(c, 'Lazer', '1000,00');
  await c.req('POST', '/api/transactions', tx({ category: 'Lazer', amount: '900,00', date: '2026-10-31' }));
  const out = (await c.req('GET', '/api/dashboard?month=2026-10')).json.budgets[0];
  assert.deepEqual([out.spentCents, out.percent, out.status], [90000, 90, 'warning']);
  const nov = (await c.req('GET', '/api/dashboard?month=2026-11')).json.budgets[0];
  assert.deepEqual([nov.spentCents, nov.percent, nov.status], [0, 0, 'ok']);
});

test('gastar exatamente o limite ainda não é "estourado"; um centavo a mais é', async () => {
  const c = await app.newUser('exato-orc@teste.com');
  await put(c, 'Lazer', '100,00');
  await c.req('POST', '/api/transactions', tx({ category: 'Lazer', amount: '100,00', date: '2026-11-05' }));
  assert.equal((await c.req('GET', '/api/dashboard?month=2026-11')).json.budgets[0].status, 'warning');
  await c.req('POST', '/api/transactions', tx({ category: 'Lazer', description: 'Pipoca', amount: '0,01', date: '2026-11-06' }));
  const b = (await c.req('GET', '/api/dashboard?month=2026-11')).json.budgets[0];
  assert.deepEqual([b.spentCents, b.status], [10001, 'over']);
});

test('remover o orçamento tira a categoria do painel', async () => {
  const c = await app.newUser('rem-orc@teste.com');
  await put(c, 'Lazer', '100,00');
  assert.equal((await c.req('GET', '/api/dashboard?month=2026-11')).json.budgets.length, 1);
  await c.req('DELETE', '/api/budgets/Lazer');
  assert.deepEqual((await c.req('GET', '/api/dashboard?month=2026-11')).json.budgets, []);
});
