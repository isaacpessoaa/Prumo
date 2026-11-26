'use strict';
// Carrega e VALIDA as variáveis de ambiente. Se algo estiver faltando ou fraco,
// a aplicação nem sobe (fail-fast). Os valores nunca são impressos no log.
require('dotenv').config({ quiet: true });
const { z } = require('zod');
const { isValidTimeZone, DEFAULT_TIMEZONE } = require('../utils/dates');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  DATABASE_SSL: z.enum(['false', 'true', 'no-verify']).default('false'),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET precisa ter pelo menos 32 caracteres (use: npm run gen-secret)'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  SESSION_TTL_HOURS: z.coerce.number().min(0.1).max(168).default(8),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  // Fuso usado para saber qual é o "mês atual" (ex.: America/Recife). Padrão: horário de Brasília/Recife.
  APP_TIMEZONE: z.string().default(DEFAULT_TIMEZONE).refine(isValidTimeZone, 'APP_TIMEZONE inválido (ex.: America/Recife)'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Configuração inválida (.env):');
  for (const issue of parsed.error.issues) {
    console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
if (/troque|change.?me|example/i.test(parsed.data.SESSION_SECRET)) {
  console.error('Configuração inválida (.env): SESSION_SECRET ainda é um valor de exemplo.');
  process.exit(1);
}

module.exports = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
});
