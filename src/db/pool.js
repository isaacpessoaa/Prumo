'use strict';
const { Pool, types } = require('pg');
const env = require('../config/env');

// DATE vem do banco como string 'YYYY-MM-DD' (evita bugs de fuso horário).
types.setTypeParser(1082, (v) => v);

const ssl =
  env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: true }
    : env.DATABASE_SSL === 'no-verify'
      ? { rejectUnauthorized: false }
      : false;

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
});

pool.on('error', (err) => console.error('Erro inesperado no pool do PostgreSQL:', err.message));

// Única porta de entrada para o banco: SEMPRE consultas parametrizadas ($1, $2...).
const query = (text, params) => pool.query(text, params);

module.exports = { pool, query };
