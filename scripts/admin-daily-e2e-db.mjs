import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import { getDatabaseConfig } from '../server/db.js';

const TEST_DATABASE = 'dashboard_funding_daily_e2e';
const action = process.argv[2] ?? 'inspect';
if (!['inspect', 'create', 'migrate'].includes(action)) throw new Error('Aksi database pengujian tidak dikenal.');

const config = getDatabaseConfig();
if (!['127.0.0.1', 'localhost'].includes(config.host.toLowerCase()) || config.port !== 3308
  || [config.database, 'dashboard_funding', 'dashboard_funding_test'].includes(TEST_DATABASE)) {
  throw new Error('Target database pengujian terisolasi tidak aman.');
}
const connection = await mysql.createConnection({ ...config, database: undefined });
try {
  const [identity] = await connection.execute('SELECT DATABASE() AS database_name, @@port AS server_port');
  if (identity[0]?.database_name !== null || Number(identity[0]?.server_port) !== 3308) {
    throw new Error('Koneksi pembuatan database tidak terisolasi.');
  }
  const [found] = await connection.execute(
    'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [TEST_DATABASE],
  );
  if (action === 'create') {
    if (found.length) throw new Error('Database pengujian sudah ada; tidak akan menimpa isinya.');
    await connection.execute(`CREATE DATABASE \`${TEST_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  }
  if (action === 'migrate') {
    if (!found.length) throw new Error('Database pengujian belum dibuat.');
    const isolated = await mysql.createConnection({ ...config, database: TEST_DATABASE });
    try {
      const [target] = await isolated.execute('SELECT DATABASE() AS database_name, @@port AS server_port');
      const [tables] = await isolated.execute(
        'SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()',
      );
      if (target[0]?.database_name !== TEST_DATABASE || Number(target[0]?.server_port) !== 3308
        || Number(tables[0]?.total) !== 0) throw new Error('Migrasi hanya boleh pada database pengujian yang kosong.');
    } finally { await isolated.end(); }
    const result = spawnSync(process.execPath, ['server/migrate.js', '--apply'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true,
      env: { ...process.env, MYSQL_DATABASE: TEST_DATABASE, DASHBOARD_RUNTIME_ENV: 'production',
        DASHBOARD_PRODUCTION_DB_HOST: config.host, DASHBOARD_PRODUCTION_DB_PORT: String(config.port),
        DASHBOARD_PRODUCTION_DB_NAME: TEST_DATABASE },
    });
    if (result.status !== 0) throw new Error(`Migrasi database terisolasi gagal (exit ${result.status}).`);
  }
  let tableCount = null;
  let finalState = null;
  if (action === 'inspect' && found.length) {
    const [tables] = await connection.execute(
      'SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=?', [TEST_DATABASE],
    );
    tableCount = Number(tables[0]?.total);
    const isolated = await mysql.createConnection({ ...config, database: TEST_DATABASE });
    try {
      const [target] = await isolated.execute('SELECT DATABASE() AS database_name, @@port AS server_port');
      if (target[0]?.database_name !== TEST_DATABASE || Number(target[0]?.server_port) !== 3308) {
        throw new Error('Identitas database pengujian tidak sesuai.');
      }
      const [[facts]] = await isolated.execute('SELECT COUNT(*) AS total FROM dashboard_fact_position_daily');
      const [publications] = await isolated.execute(
        "SELECT scope_key,publication_version FROM dashboard_domain_publication WHERE domain_key='position_daily' AND scope_key REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ORDER BY scope_key",
      );
      finalState = { factRows: Number(facts.total), publications: Object.fromEntries(
        publications.map(row => [row.scope_key, Number(row.publication_version)]),
      ) };
    } finally { await isolated.end(); }
  }
  process.stdout.write(JSON.stringify({ target: TEST_DATABASE, port: 3308,
    existsBefore: Boolean(found.length), created: action === 'create', migrated: action === 'migrate',
    tableCount, finalState }) + '\n');
} finally { await connection.end(); }
