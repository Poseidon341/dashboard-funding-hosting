import { randomBytes, scryptSync } from 'node:crypto';
import mysql from 'mysql2/promise';
import { getDatabaseConfig } from '../server/db.js';
import { createShadowServer } from '../server/shadow-master-api.mjs';

const database = 'dashboard_funding_daily_e2e';
const base = getDatabaseConfig();
if (!['127.0.0.1', 'localhost'].includes(base.host.toLowerCase()) || base.port !== 3308 || base.database === database) {
  throw new Error('Target browser E2E tidak terisolasi.');
}
const config = { ...base, database, connectionLimit: 4 };
const pool = mysql.createPool(config);
const salt = randomBytes(16);
const password = randomBytes(18).toString('hex');
const env = {
  ...process.env,
  DASHBOARD_RUNTIME_ENV: 'production',
  DASHBOARD_PRODUCTION_DB_HOST: config.host,
  DASHBOARD_PRODUCTION_DB_PORT: '3308',
  DASHBOARD_PRODUCTION_DB_NAME: database,
  DASHBOARD_PUBLIC_ORIGIN: 'https://funding-e2e.invalid',
  DASHBOARD_ADMIN_USER: 'synthetic-admin',
  DASHBOARD_ADMIN_PASSWORD_SCRYPT: `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`,
};
const server = createShadowServer({ getConfig: () => config, getPool: () => pool, env });
server.listen(8799, '127.0.0.1', () => console.log('Isolated E2E API listening on 127.0.0.1:8799'));
async function stop() {
  await new Promise(resolve => server.close(resolve));
  await pool.end();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
