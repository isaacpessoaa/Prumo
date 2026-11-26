'use strict';
const express = require('express');
const { query } = require('../db/pool');
const env = require('../config/env');
const dates = require('../utils/dates');
const { budgetStatus } = require('../utils/budget');
const { transactionSchema, listQuerySchema, month: monthSchema, uuid, CATEGORIES } = require('../utils/validation');

const PAGE_SIZE = 30;

const toDto = (r) => ({
  id: r.id, type: r.type, category: r.category, description: r.description,
  amountCents: Number(r.amount_cents), date: r.occurred_on,
});

const fieldErrors = (zodError) => {
  const fields = {};
  for (const i of zodError.issues) { const k = i.path[0] || 'form'; if (!fields[k]) fields[k] = i.message; }
  return fields;
};

// Helpers de mês trabalham com strings 'YYYY-MM'. O "mês atual" usa o fuso do app (APP_TIMEZONE), não UTC:
// com UTC, o painel virava para o mês seguinte às 21h do último dia do mês no Brasil.
const currentMonth = () => dates.currentMonth(new Date(), env.APP_TIMEZONE);
const { shiftMonth, firstDay } = dates;

module.exports = function transactionRoutes() {
  const router = express.Router();

  // Listagem — SEMPRE filtrada pelo usuário logado (impede acesso a dados de terceiros).
  router.get('/transactions', async (req, res, next) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: 'Filtros inválidos.' });
      const { month, type, page } = parsed.data;
      const params = [req.auth.user.id];
      let where = 'user_id = $1';
      if (month) {
        params.push(firstDay(month), firstDay(shiftMonth(month, 1)));
        where += ` AND occurred_on >= $${params.length - 1} AND occurred_on < $${params.length}`;
      }
      if (type) { params.push(type); where += ` AND type = $${params.length}`; }
      params.push(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);
      const { rows } = await query(
        `SELECT id, type, category, description, amount_cents, occurred_on
           FROM transactions WHERE ${where}
          ORDER BY occurred_on DESC, created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      res.json({ items: rows.slice(0, PAGE_SIZE).map(toDto), hasMore: rows.length > PAGE_SIZE });
    } catch (err) { next(err); }
  });

  router.post('/transactions', async (req, res, next) => {
    try {
      const parsed = transactionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Corrija os campos destacados.', fields: fieldErrors(parsed.error) });
      const t = parsed.data;
      const { rows } = await query(
        `INSERT INTO transactions (user_id, type, category, description, amount_cents, occurred_on)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, type, category, description, amount_cents, occurred_on`,
        [req.auth.user.id, t.type, t.category, t.description, t.amount, t.date],
      );
      res.status(201).json(toDto(rows[0]));
    } catch (err) { next(err); }
  });

  router.put('/transactions/:id', async (req, res, next) => {
    try {
      const id = uuid.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'Lançamento não encontrado.' });
      const parsed = transactionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Corrija os campos destacados.', fields: fieldErrors(parsed.error) });
      const t = parsed.data;
      const { rows } = await query(
        `UPDATE transactions
            SET type = $3, category = $4, description = $5, amount_cents = $6, occurred_on = $7, updated_at = now()
          WHERE id = $1 AND user_id = $2
      RETURNING id, type, category, description, amount_cents, occurred_on`,
        [id.data, req.auth.user.id, t.type, t.category, t.description, t.amount, t.date],
      );
      if (!rows[0]) return res.status(404).json({ error: 'Lançamento não encontrado.' });
      res.json(toDto(rows[0]));
    } catch (err) { next(err); }
  });

  router.delete('/transactions/:id', async (req, res, next) => {
    try {
      const id = uuid.safeParse(req.params.id);
      if (!id.success) return res.status(404).json({ error: 'Lançamento não encontrado.' });
      const { rowCount } = await query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [id.data, req.auth.user.id]);
      if (!rowCount) return res.status(404).json({ error: 'Lançamento não encontrado.' });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  router.get('/categories', (_req, res) => res.json(CATEGORIES));

  // Painel: tudo calculado no banco/servidor; o navegador só desenha.
  router.get('/dashboard', async (req, res, next) => {
    try {
      const m = monthSchema.safeParse(req.query.month ?? currentMonth());
      if (!m.success) return res.status(400).json({ error: 'Mês inválido.' });
      const month = m.data;
      const uid = req.auth.user.id;
      const start = firstDay(month);
      const end = firstDay(shiftMonth(month, 1));
      const seriesStart = firstDay(shiftMonth(month, -5));

      const [totals, balance, byCategory, series, budgetRows] = await Promise.all([
        query(
          `SELECT type, COALESCE(SUM(amount_cents), 0)::bigint AS total
             FROM transactions WHERE user_id = $1 AND occurred_on >= $2 AND occurred_on < $3 GROUP BY type`,
          [uid, start, end],
        ),
        query(
          `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount_cents ELSE -amount_cents END), 0)::bigint AS balance
             FROM transactions WHERE user_id = $1 AND occurred_on < $2`,
          [uid, end],
        ),
        query(
          `SELECT category, SUM(amount_cents)::bigint AS total
             FROM transactions WHERE user_id = $1 AND type = 'expense' AND occurred_on >= $2 AND occurred_on < $3
            GROUP BY category ORDER BY total DESC`,
          [uid, start, end],
        ),
        query(
          `SELECT to_char(occurred_on, 'YYYY-MM') AS month, type, SUM(amount_cents)::bigint AS total
             FROM transactions WHERE user_id = $1 AND occurred_on >= $2 AND occurred_on < $3 GROUP BY 1, 2`,
          [uid, seriesStart, end],
        ),
        query('SELECT category, limit_cents FROM budgets WHERE user_id = $1', [uid]),
      ]);

      const sum = (t) => Number((totals.rows.find((r) => r.type === t) || {}).total || 0);
      const months = Array.from({ length: 6 }, (_, i) => shiftMonth(month, i - 5));
      const pick = (mm, t) => Number((series.rows.find((r) => r.month === mm && r.type === t) || {}).total || 0);

      // Orçamento: gasto do mês por categoria x limite. Os mais críticos (maior %) vêm primeiro.
      const spentBy = new Map(byCategory.rows.map((r) => [r.category, Number(r.total)]));
      const budgets = budgetRows.rows
        .map((r) => {
          const limitCents = Number(r.limit_cents);
          const spentCents = spentBy.get(r.category) || 0;
          return { category: r.category, limitCents, spentCents, ...budgetStatus(limitCents, spentCents) };
        })
        .sort((a, b) => b.percent - a.percent || a.category.localeCompare(b.category, 'pt-BR'));

      res.json({
        month,
        incomeCents: sum('income'),
        expenseCents: sum('expense'),
        monthBalanceCents: sum('income') - sum('expense'),
        accumulatedBalanceCents: Number(balance.rows[0].balance),
        expensesByCategory: byCategory.rows.map((r) => ({ category: r.category, totalCents: Number(r.total) })),
        budgets,
        history: months.map((mm) => ({ month: mm, incomeCents: pick(mm, 'income'), expenseCents: pick(mm, 'expense') })),
      });
    } catch (err) { next(err); }
  });

  return router;
};
