'use strict';
// Testes unitários (sem banco): datas no fuso certo e regra de status do orçamento.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { currentMonth, today, shiftMonth, firstDay, isValidTimeZone } = require('../src/utils/dates');
const { budgetStatus } = require('../src/utils/budget');

/* ===================== Datas / fuso ===================== */
test('REGRESSÃO: às 22h30 de 30/11 em Recife o mês ainda é novembro (em UTC já seria dezembro)', () => {
  const instant = new Date('2026-12-01T01:30:00Z'); // 22:30 de 30/11 em Recife (UTC-3)
  assert.equal(instant.toISOString().slice(0, 7), '2026-12'); // o jeito antigo (bugado)
  assert.equal(currentMonth(instant, 'America/Recife'), '2026-11'); // o jeito certo
  assert.equal(today(instant, 'America/Recife'), '2026-11-30');
});

test('virada de ano: 23h do dia 31/12 em Recife ainda é dezembro de 2026', () => {
  const instant = new Date('2027-01-01T02:00:00Z');
  assert.equal(currentMonth(instant, 'America/Recife'), '2026-12');
  assert.equal(today(instant, 'America/Recife'), '2026-12-31');
});

test('o fuso configurado manda: UTC e fusos à frente do UTC viram o mês antes', () => {
  assert.equal(currentMonth(new Date('2026-12-01T01:30:00Z'), 'UTC'), '2026-12');
  assert.equal(currentMonth(new Date('2026-11-30T16:00:00Z'), 'Asia/Tokyo'), '2026-12'); // 01:00 de 01/12 lá
  assert.equal(currentMonth(new Date('2026-11-30T12:00:00Z'), 'America/Recife'), '2026-11');
});

test('shiftMonth atravessa anos nos dois sentidos', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-03', -5), '2025-10');
  assert.equal(shiftMonth('2026-11', 0), '2026-11');
  assert.equal(firstDay('2026-11'), '2026-11-01');
});

test('isValidTimeZone aceita fusos reais e recusa inventados', () => {
  assert.equal(isValidTimeZone('America/Recife'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Marte/Olimpo'), false);
  assert.equal(isValidTimeZone(''), false);
});

/* ===================== Orçamento ===================== */
test('budgetStatus: abaixo de 80% é ok', () => {
  assert.deepEqual(budgetStatus(10000, 0), { percent: 0, status: 'ok' });
  assert.deepEqual(budgetStatus(10000, 5000), { percent: 50, status: 'ok' });
  assert.deepEqual(budgetStatus(10000, 7999), { percent: 80, status: 'ok' }); // arredonda p/ 80, mas ainda < 80%
});

test('budgetStatus: de 80% até o limite (inclusive) é warning', () => {
  assert.equal(budgetStatus(10000, 8000).status, 'warning');
  assert.equal(budgetStatus(10000, 9999).status, 'warning');
  assert.deepEqual(budgetStatus(10000, 10000), { percent: 100, status: 'warning' }); // gastou exatamente o limite: ainda não passou
});

test('budgetStatus: passou do limite é over e o percentual pode passar de 100', () => {
  assert.deepEqual(budgetStatus(10000, 10001), { percent: 100, status: 'over' });
  assert.deepEqual(budgetStatus(10000, 13000), { percent: 130, status: 'over' });
});

test('budgetStatus não quebra com valores grandes (limite máximo do banco)', () => {
  const max = 99999999999;
  assert.equal(budgetStatus(max, max).status, 'warning');
  assert.equal(budgetStatus(max, max + 1).status, 'over');
});
