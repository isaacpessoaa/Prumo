'use strict';
const express = require('express');
const { query } = require('../db/pool');
const { budgetSchema, CATEGORIES } = require('../utils/validation');

const toDto = (r) => ({ category: r.category, limitCents: Number(r.limit_cents) });

const fieldErrors = (zodError) => {
  const fields = {};
  for (const i of zodError.issues) { const k = i.path[0] || 'form'; if (!fields[k]) fields[k] = i.message; }
  return fields;
};

module.exports = function budgetRoutes() {
  const router = express.Router();

  // Lista os limites do usuário logado (sempre filtrado por user_id da sessão).
  router.get('/budgets', async (req, res, next) => {
    try {
      const { rows } = await query(
        'SELECT category, limit_cents FROM budgets WHERE user_id = $1 ORDER BY category',
        [req.auth.user.id],
      );
      res.json(rows.map(toDto));
    } catch (err) { next(err); }
  });

  // Cria ou atualiza o limite de uma categoria (upsert: no máximo 1 por usuário+categoria).
  router.put('/budgets', async (req, res, next) => {
    try {
      const parsed = budgetSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Corrija os campos destacados.', fields: fieldErrors(parsed.error) });
      const b = parsed.data;
      const { rows } = await query(
        `INSERT INTO budgets (user_id, category, limit_cents) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, category)
         DO UPDATE SET limit_cents = EXCLUDED.limit_cents, updated_at = now()
         RETURNING category, limit_cents`,
        [req.auth.user.id, b.category, b.limit],
      );
      res.json(toDto(rows[0]));
    } catch (err) { next(err); }
  });

  router.delete('/budgets/:category', async (req, res, next) => {
    try {
      const category = req.params.category;
      if (!CATEGORIES.expense.includes(category)) return res.status(404).json({ error: 'Orçamento não encontrado.' });
      const { rowCount } = await query('DELETE FROM budgets WHERE user_id = $1 AND category = $2', [req.auth.user.id, category]);
      if (!rowCount) return res.status(404).json({ error: 'Orçamento não encontrado.' });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return router;
};
