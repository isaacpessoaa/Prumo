'use strict';
const env = require('./src/config/env');
const { createApp } = require('./src/app');
const { pool, query } = require('./src/db/pool');

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`Servidor rodando em http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Limpa sessões expiradas de hora em hora.
const cleanup = setInterval(() => {
  query('DELETE FROM sessions WHERE expires_at <= now()').catch((e) => console.error('Limpeza de sessões falhou:', e.message));
}, 60 * 60 * 1000);
cleanup.unref();

function shutdown() {
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
