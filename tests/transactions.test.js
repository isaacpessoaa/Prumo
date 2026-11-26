'use strict';
// Testes de listagem e painel: paginação, limites de mês, virada de ano, saldo acumulado e mês padrão.
// Rode com:  npm test   (usa o banco de TESTE — o nome precisa terminar com _test)
const { startServer, tx, userId, query } = require('./helpers'); // helpers primeiro: prepara o ambiente de teste
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../src/config/env');
const dates = require('../src/utils/dates');

let app;
before(async () => { app = await startServer(); });
after(async () => { await app.stop(); });

// Insere vários lançamentos direto no banco (muito mais rápido que pela API).
async function seed(email, rows) {
  const uid = await userId(email);
  for (const r of rows) {
    await query(
      `INSERT INTO transactions (user_id, type, category, description, amount_cents, occurred_on)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uid, r.type || 'expense', r.category || 'Lazer', r.description || 'Teste', r.cents, r.date],
    );
  }
}

/* ===================== Categorias ===================== */
test('GET /api/categories exige login e devolve entradas e saídas', async () => {
  assert.equal((await app.client().req('GET', '/api/categories')).status, 401);
  const c = await app.newUser('cats@teste.com');
  const r = await c.req('GET', '/api/categories');
  assert.equal(r.status, 200);
  assert.ok(r.json.income.includes('Salário'));
  assert.ok(r.json.expense.includes('Alimentação'));
  assert.ok(!r.json.expense.includes('Salário'));
});

/* ===================== Paginação e ordem ===================== */
test('listagem pagina de 30 em 30, com hasMore correto e ordem do mais novo para o mais antigo', async () => {
  const c = await app.newUser('pag@teste.com');
  const uid = await userId('pag@teste.com');
  await query(
    `INSERT INTO transactions (user_id, type, category, description, amount_cents, occurred_on)
     SELECT $1, 'expense', 'Lazer', 'Item ' || g, 1000 + g, DATE '2026-11-01' + (g % 28)
       FROM generate_series(1, 35) g`,
    [uid],
  );
  const p1 = (await c.req('GET', '/api/transactions?month=2026-11&page=1')).json;
  assert.equal(p1.items.length, 30);
  assert.equal(p1.hasMore, true);
  for (let i = 1; i < p1.items.length; i++) assert.ok(p1.items[i - 1].date >= p1.items[i].date, 'ordem decrescente por data');

  const p2 = (await c.req('GET', '/api/transactions?month=2026-11&page=2')).json;
  assert.equal(p2.items.length, 5);
  assert.equal(p2.hasMore, false);

  const p3 = (await c.req('GET', '/api/transactions?month=2026-11&page=3')).json;
  assert.equal(p3.items.length, 0);
  assert.equal(p3.hasMore, false);

  const ids = new Set([...p1.items, ...p2.items].map((i) => i.id));
  assert.equal(ids.size, 35, 'nenhum lançamento repetido entre as páginas');
});

test('exatamente 30 lançamentos: não há "próxima página"', async () => {
  const c = await app.newUser('trinta@teste.com');
  const rows = Array.from({ length: 30 }, (_, i) => ({ cents: 100 + i, date: '2026-09-15' }));
  await seed('trinta@teste.com', rows);
  const r = (await c.req('GET', '/api/transactions?month=2026-09')).json;
  assert.equal(r.items.length, 30);
  assert.equal(r.hasMore, false);
});

/* ===================== Filtros ===================== */
test('filtro de mês respeita as bordas (primeiro e último dia) e não vaza meses vizinhos', async () => {
  const c = await app.newUser('bordas@teste.com');
  await seed('bordas@teste.com', [
    { description: 'fim-out', cents: 100, date: '2026-10-31' },
    { description: 'ini-nov', cents: 200, date: '2026-11-01' },
    { description: 'fim-nov', cents: 300, date: '2026-11-30' },
    { description: 'ini-dez', cents: 400, date: '2026-12-01' },
  ]);
  const nov = (await c.req('GET', '/api/transactions?month=2026-11')).json.items.map((i) => i.description).sort();
  assert.deepEqual(nov, ['fim-nov', 'ini-nov']);
  const dez = (await c.req('GET', '/api/transactions?month=2026-12')).json.items.map((i) => i.description);
  assert.deepEqual(dez, ['ini-dez']);
  const all = (await c.req('GET', '/api/transactions')).json.items;
  assert.equal(all.length, 4, 'sem filtro de mês devolve todos');
});

test('filtro por tipo devolve só entradas ou só saídas', async () => {
  const c = await app.newUser('tipo@teste.com');
  await seed('tipo@teste.com', [
    { type: 'income', category: 'Salário', description: 'in1', cents: 1000, date: '2026-11-02' },
    { type: 'income', category: 'Freelance', description: 'in2', cents: 2000, date: '2026-11-03' },
    { type: 'expense', category: 'Lazer', description: 'out1', cents: 500, date: '2026-11-04' },
  ]);
  const ins = (await c.req('GET', '/api/transactions?month=2026-11&type=income')).json.items;
  assert.equal(ins.length, 2);
  assert.ok(ins.every((i) => i.type === 'income'));
  const outs = (await c.req('GET', '/api/transactions?month=2026-11&type=expense')).json.items;
  assert.deepEqual(outs.map((i) => i.description), ['out1']);
});

/* ===================== Edição ===================== */
test('editar trocando o tipo sem trocar a categoria é recusado e o original fica intacto', async () => {
  const c = await app.newUser('edit@teste.com');
  const created = (await c.req('POST', '/api/transactions', tx({ category: 'Lazer', description: 'Cinema' }))).json;
  // saída com categoria de saída -> virar entrada mantendo "Lazer" não pode
  const bad = await c.req('PUT', `/api/transactions/${created.id}`, tx({ type: 'income', category: 'Lazer', description: 'Cinema' }));
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.category);
  const list = (await c.req('GET', '/api/transactions?month=2026-11')).json.items;
  assert.equal(list[0].type, 'expense');
  // trocando tipo E categoria juntos funciona
  const ok = await c.req('PUT', `/api/transactions/${created.id}`, tx({ type: 'income', category: 'Presentes', description: 'Cinema' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.type, 'income');
});

/* ===================== Painel ===================== */
test('painel de um mês sem lançamentos: tudo zerado, 6 meses de histórico e listas vazias', async () => {
  const c = await app.newUser('vazio@teste.com');
  const d = (await c.req('GET', '/api/dashboard?month=2026-11')).json;
  assert.equal(d.incomeCents, 0);
  assert.equal(d.expenseCents, 0);
  assert.equal(d.monthBalanceCents, 0);
  assert.equal(d.accumulatedBalanceCents, 0);
  assert.deepEqual(d.expensesByCategory, []);
  assert.deepEqual(d.budgets, []);
  assert.deepEqual(d.history.map((h) => h.month), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  assert.ok(d.history.every((h) => h.incomeCents === 0 && h.expenseCents === 0));
});

test('histórico atravessa a virada de ano (janeiro mostra de agosto a janeiro)', async () => {
  const c = await app.newUser('ano@teste.com');
  await seed('ano@teste.com', [
    { type: 'income', category: 'Salário', cents: 100000, date: '2025-12-20' },
    { cents: 25000, date: '2026-01-10' },
  ]);
  const d = (await c.req('GET', '/api/dashboard?month=2026-01')).json;
  assert.deepEqual(d.history.map((h) => h.month), ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
  assert.equal(d.history[4].incomeCents, 100000);
  assert.equal(d.history[5].expenseCents, 25000);
  assert.equal(d.incomeCents, 0, 'a entrada de dezembro não conta no resultado de janeiro');
});

test('saldo acumulado inclui o mês consultado e os anteriores, e ignora os meses futuros', async () => {
  const c = await app.newUser('acum@teste.com');
  await seed('acum@teste.com', [
    { type: 'income', category: 'Salário', cents: 100000, date: '2026-09-05' },
    { cents: 30000, date: '2026-10-10' },
    { type: 'income', category: 'Freelance', cents: 50000, date: '2026-12-01' },
  ]);
  const out = (await c.req('GET', '/api/dashboard?month=2026-10')).json;
  assert.equal(out.accumulatedBalanceCents, 70000); // 1000 - 300 (dezembro de fora)
  const dez = (await c.req('GET', '/api/dashboard?month=2026-12')).json;
  assert.equal(dez.accumulatedBalanceCents, 120000);
  const set = (await c.req('GET', '/api/dashboard?month=2026-09')).json;
  assert.equal(set.accumulatedBalanceCents, 100000);
});

test('saldo negativo e categorias de saída ordenadas do maior gasto para o menor', async () => {
  const c = await app.newUser('neg@teste.com');
  await seed('neg@teste.com', [
    { category: 'Lazer', cents: 1000, date: '2026-11-03' },
    { category: 'Moradia', cents: 90000, date: '2026-11-04' },
    { category: 'Transporte', cents: 5000, date: '2026-11-05' },
    { category: 'Moradia', cents: 10000, date: '2026-11-06' },
  ]);
  const d = (await c.req('GET', '/api/dashboard?month=2026-11')).json;
  assert.equal(d.monthBalanceCents, -106000);
  assert.deepEqual(d.expensesByCategory.map((x) => [x.category, x.totalCents]), [['Moradia', 100000], ['Transporte', 5000], ['Lazer', 1000]]);
});

test('sem ?month o painel abre no mês atual do fuso do app (não o de UTC)', async () => {
  const c = await app.newUser('padrao@teste.com');
  const antes = dates.currentMonth(new Date(), env.APP_TIMEZONE);
  const d = (await c.req('GET', '/api/dashboard')).json;
  const depois = dates.currentMonth(new Date(), env.APP_TIMEZONE);
  assert.ok([antes, depois].includes(d.month), `esperava ${antes}, veio ${d.month}`);
});
