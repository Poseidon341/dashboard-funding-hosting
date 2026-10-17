import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { getDatabaseConfig } from '../server/db.js';
import { createShadowServer } from '../server/shadow-master-api.mjs';
import { materializePositionWorkbook } from '../server/imports/position-xlsx-adapter.mjs';
import { scanPositionFile } from '../server/imports/position-importer.mjs';

const DATABASE = 'dashboard_funding_daily_e2e';
const ORIGIN = 'https://funding-e2e.invalid';
const PORT = 8799;
const BASE_ROWS = 1_039_742;
const config = getDatabaseConfig();
if (!['127.0.0.1', 'localhost'].includes(config.host.toLowerCase()) || config.port !== 3308
  || DATABASE === config.database) throw new Error('Target E2E tidak terisolasi.');
const isolatedConfig = { ...config, database: DATABASE, connectionLimit: 4 };
const salt = randomBytes(16);
const password = randomBytes(18).toString('hex');
const env = { ...process.env, DASHBOARD_RUNTIME_ENV: 'production',
  DASHBOARD_PRODUCTION_DB_HOST: config.host, DASHBOARD_PRODUCTION_DB_PORT: '3308',
  DASHBOARD_PRODUCTION_DB_NAME: DATABASE, DASHBOARD_PUBLIC_ORIGIN: ORIGIN,
  DASHBOARD_ADMIN_USER: 'synthetic-admin',
  DASHBOARD_ADMIN_PASSWORD_SCRYPT: `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}` };
const pool = mysql.createPool(isolatedConfig);
const connection = await pool.getConnection();
let server;
let directory;
const report = [];

function serial(date) {
  return Math.round((Date.parse(`${date}T00:00:00.000Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
}
function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function cell(column, number, value, kind = 'text') {
  const ref = `${column}${number}`;
  if (kind === 'date') return `<c r="${ref}" s="1"><v>${serial(value)}</v></c>`;
  if (kind === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
}
async function workbook(name, rows) {
  const root = join(directory, name);
  await mkdir(join(root, '_rels'), { recursive: true });
  await mkdir(join(root, 'xl', '_rels'), { recursive: true });
  await mkdir(join(root, 'xl', 'worksheets'), { recursive: true });
  const headers = ['Posisi', 'Segmentasi BPR', 'Produk', 'Nama Cabang', 'Nama Uker', 'Jumlah Rekening', 'Saldo'];
  const sheetRows = [`<row r="1">${headers.map((header, i) => cell('ABCDEFG'[i], 1, header)).join('')}</row>`];
  rows.forEach((row, index) => {
    const n = index + 2;
    sheetRows.push(`<row r="${n}">${cell('A', n, row.date, 'date')}${cell('B', n, row.segment)}${cell('C', n, row.product)}${cell('D', n, row.branch)}${cell('E', n, row.office)}${cell('F', n, row.accounts, 'number')}${cell('G', n, row.balance, 'number')}</row>`);
  });
  await writeFile(join(root, '[Content_Types].xml'),
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
  await writeFile(join(root, '_rels', '.rels'),
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  await writeFile(join(root, 'xl', 'workbook.xml'),
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><sheets><sheet name="segmen_data" sheetId="1" r:id="rId1"/></sheets></workbook>');
  await writeFile(join(root, 'xl', '_rels', 'workbook.xml.rels'),
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  await writeFile(join(root, 'xl', 'styles.xml'),
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>');
  await writeFile(join(root, 'xl', 'worksheets', 'sheet1.xml'),
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows.join('')}</sheetData></worksheet>`);
  const zipPath = join(directory, `${name}.zip`);
  const zipScript = String.raw`
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::Open($env:E2E_ZIP_PATH,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach($name in @('[Content_Types].xml','_rels/.rels','xl/workbook.xml','xl/_rels/workbook.xml.rels','xl/styles.xml','xl/worksheets/sheet1.xml')) {
    $path=Join-Path $env:E2E_XML_ROOT ($name.Replace('/',[IO.Path]::DirectorySeparatorChar))
    $null=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$path,$name)
  }
} finally { $zip.Dispose() }
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', zipScript],
  { windowsHide: true, encoding: 'utf8', env: { ...process.env, E2E_XML_ROOT: root, E2E_ZIP_PATH: zipPath } });
  if (result.status !== 0) throw new Error(`Pembuatan XLSX sintetis gagal: ${result.stderr.slice(0, 500)}`);
  const xlsxPath = join(directory, `${name}.xlsx`);
  await rename(zipPath, xlsxPath);
  const entries = spawnSync('tar.exe', ['-tf', xlsxPath], { encoding: 'utf8', windowsHide: true });
  if (entries.status !== 0 || !entries.stdout.includes('xl/workbook.xml')
    || !entries.stdout.includes('xl/_rels/workbook.xml.rels')) {
    throw new Error(`Struktur ZIP XLSX sintetis tidak sesuai: ${entries.stdout.trim().slice(0, 400)}`);
  }
  const materialized = await materializePositionWorkbook(xlsxPath);
  try {
    const summary = await scanPositionFile(materialized.path, { strictSnapshot: false, expectedRows: rows.length });
    assert.equal(summary.total, rows.length);
    assert.equal(summary.invalidRows, 0);
  } finally { await materialized.cleanup(); }
  return xlsxPath;
}

async function request(path, { method = 'GET', body = null, cookie = '', csrf = '', filename = '' } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-Admin-CSRF'] = csrf;
  if (filename) headers['X-Admin-Filename'] = encodeURIComponent(filename);
  if (Buffer.isBuffer(body)) headers['Content-Type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  else if (body !== null) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${data.error ?? data.message ?? 'unknown'}`);
  return { data, status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? null };
}

async function readDates() {
  const [rows] = await connection.execute(
    `SELECT DATE_FORMAT(f.position_date,'%Y-%m-%d') AS date_value,COUNT(*) AS row_count,
            CAST(SUM(f.balance) AS CHAR) AS total_balance
     FROM dashboard_domain_publication p
     JOIN dashboard_import_object_identity i ON i.batch_id=p.batch_id AND i.object_key='segmen_data.json'
     JOIN dashboard_fact_position_daily f ON f.object_id=i.object_id AND f.position_date=p.scope_key
     WHERE p.domain_key='position_daily' AND p.scope_key REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     GROUP BY f.position_date ORDER BY f.position_date`,
  );
  return Object.fromEntries(rows.map(row => [row.date_value, { rows: Number(row.row_count), balance: row.total_balance }]));
}
async function publishedScopes() {
  const [rows] = await connection.execute(
    "SELECT scope_key,publication_version FROM dashboard_domain_publication WHERE domain_key='position_daily' ORDER BY scope_key",
  );
  return Object.fromEntries(rows.map(row => [row.scope_key, Number(row.publication_version)]));
}
async function apiDates() {
  const { data } = await request('/api/funding/positions');
  assert.equal(data.status, 'ok');
  const totals = new Map();
  for (const row of data.records) {
    if (row.Posisi < '2026-11-01') continue;
    totals.set(row.Posisi, (totals.get(row.Posisi) ?? 0) + Number(row.Saldo));
  }
  return { recordCount: data.recordCount, dates: Object.fromEntries(totals) };
}

try {
  const [identity] = await connection.execute('SELECT DATABASE() AS database_name, @@port AS server_port');
  if (identity[0]?.database_name !== DATABASE || Number(identity[0]?.server_port) !== 3308) {
    throw new Error('Database API E2E berbeda dari target terisolasi.');
  }
  const [[base]] = await connection.execute(
    `SELECT COUNT(*) AS row_count,COUNT(DISTINCT source_row_number) AS identities,
            SUM(mapping_status='resolved') AS resolved,SUM(mapping_status='unresolved') AS unresolved
     FROM dashboard_fact_position_daily`,
  );
  assert.deepEqual([Number(base.row_count), Number(base.identities), Number(base.resolved), Number(base.unresolved)],
    [BASE_ROWS, BASE_ROWS, 1_038_051, 1_691]);
  assert.deepEqual(await readDates(), {});
  report.push({ step: 'before', baseRows: Number(base.row_count), activeDates: await readDates() });
  directory = await mkdtemp(join(tmpdir(), 'funding-daily-e2e-'));
  const common = { segment: 'MIKRO', product: 'TABUNGAN', branch: 'KC E2E', office: 'KC E2E', accounts: 1 };
  const first = await workbook('nov-multi-date', [
    { ...common, date: '2026-11-01', balance: 100 },
    { ...common, date: '2026-11-01', office: 'UNIT UNRESOLVED E2E', segment: 'RITEL', product: 'DEPOSITO', balance: 25 },
    { ...common, date: '2026-11-02', balance: 200 },
  ]);
  const second = await workbook('dec-new-month', [{ ...common, date: '2026-12-01', balance: 300 }]);
  const replacement = await workbook('nov-replacement', [{ ...common, date: '2026-11-01', balance: 150 }]);
  server = createShadowServer({ getConfig: () => isolatedConfig, getPool: () => pool, env });
  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));

  const login = await request('/api/admin/login', { method: 'POST', body: { username: 'synthetic-admin', password } });
  assert.equal(login.status, 200);
  const cookie = login.cookie; const csrf = login.data.csrf;
  assert.ok(cookie && csrf);
  const session = await request('/api/admin/session', { cookie });
  assert.equal(session.data.user, 'synthetic-admin');
  report.push({ step: 'admin-login-session', loginStatus: login.status, sessionStatus: session.status });

  async function publish(filePath, decisions, confirmation = '') {
    const upload = await request('/api/admin/preview?type=position', { method: 'POST', body: await readFile(filePath),
      cookie, csrf, filename: filePath.split(/[\\/]/).at(-1) });
    assert.equal(upload.data.invalidRows, 0);
    assert.equal(upload.data.validRows, upload.data.totalRows);
    assert.deepEqual(Object.keys(upload.data.dates).sort(), Object.keys(decisions).sort());
    const commit = await request('/api/admin/commit', { method: 'POST', cookie, csrf,
      body: { previewId: upload.data.previewId, decisions, confirmation, snapshotComplete: true } });
    assert.equal(commit.status, 202);
    let job;
    for (let i = 0; i < 90; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = (await request(`/api/admin/jobs/${commit.data.jobId}`, { cookie })).data;
      if (job.status !== 'processing') break;
    }
    if (job?.status !== 'completed') throw new Error(`Job upload gagal: ${job?.error ?? 'timeout'}`);
    return { preview: upload.data, result: job.result };
  }

  const initial = await publish(first, { '2026-11-01': 'add', '2026-11-02': 'add' });
  assert.deepEqual(initial.result.publishedDates, ['2026-11-01', '2026-11-02']);
  assert.deepEqual(await readDates(), {
    '2026-11-01': { rows: 2, balance: '125.000000000000000' },
    '2026-11-02': { rows: 1, balance: '200.000000000000000' },
  });
  report.push({ step: 'november-two-dates', previewRows: initial.preview.totalRows,
    activeDates: await readDates(), scopes: await publishedScopes(), api: await apiDates() });

  const december = await publish(second, { '2026-12-01': 'add' });
  assert.deepEqual(december.result.publishedDates, ['2026-12-01']);
  report.push({ step: 'new-month', activeDates: await readDates(), scopes: await publishedScopes(), api: await apiDates() });

  const identical = await publish(first, { '2026-11-01': 'replace', '2026-11-02': 'replace' }, 'GANTI SNAPSHOT TANGGAL');
  assert.equal(identical.preview.dates['2026-11-01'].identicalSource, true);
  assert.deepEqual(identical.result.publishedDates, []);
  assert.deepEqual(identical.result.alreadyPublishedDates, ['2026-11-01', '2026-11-02']);
  assert.deepEqual(await publishedScopes(), { '2026-11-01': 1, '2026-11-02': 1, '2026-12-01': 1 });
  report.push({ step: 'identical-retry', activeDates: await readDates(), scopes: await publishedScopes() });

  const replaced = await publish(replacement, { '2026-11-01': 'replace' }, 'GANTI SNAPSHOT TANGGAL');
  assert.deepEqual(replaced.result.publishedDates, ['2026-11-01']);
  assert.deepEqual(await publishedScopes(), { '2026-11-01': 2, '2026-11-02': 1, '2026-12-01': 1 });
  assert.deepEqual(await readDates(), {
    '2026-11-01': { rows: 1, balance: '150.000000000000000' },
    '2026-11-02': { rows: 1, balance: '200.000000000000000' },
    '2026-12-01': { rows: 1, balance: '300.000000000000000' },
  });
  const finalApi = await apiDates();
  assert.equal(finalApi.recordCount, BASE_ROWS + 3);
  assert.deepEqual(finalApi.dates, { '2026-11-01': 150, '2026-11-02': 200, '2026-12-01': 300 });
  const [oldFacts] = await connection.execute(
    `SELECT COUNT(*) AS total FROM dashboard_fact_position_daily
     WHERE position_date='2026-11-01' AND object_id NOT IN
       (SELECT i.object_id FROM dashboard_domain_publication p JOIN dashboard_import_object_identity i
        ON i.batch_id=p.batch_id AND i.object_key='segmen_data.json'
        WHERE p.domain_key='position_daily' AND p.scope_key='2026-11-01')`,
  );
  assert.equal(Number(oldFacts[0].total), 2);
  report.push({ step: 'replace-one-day', activeDates: await readDates(), scopes: await publishedScopes(),
    api: finalApi, preservedOldFactRows: Number(oldFacts[0].total) });
  const logout = await request('/api/admin/logout', { method: 'POST', cookie });
  assert.equal(logout.status, 200);
  process.stdout.write(JSON.stringify({ database: DATABASE, steps: report }) + '\n');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  connection.release();
  await pool.end();
  if (directory) await rm(directory, { recursive: true, force: true });
}
