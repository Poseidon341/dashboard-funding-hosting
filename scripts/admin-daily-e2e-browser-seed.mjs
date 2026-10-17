import { createHash, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { getDatabaseConfig } from '../server/db.js';

const DATABASE = 'dashboard_funding_daily_e2e';
const config = getDatabaseConfig();
if (!['127.0.0.1', 'localhost'].includes(config.host.toLowerCase()) || config.port !== 3308
  || DATABASE === config.database) throw new Error('Browser seed harus memakai database terisolasi.');
const db = await mysql.createConnection({ ...config, database: DATABASE });
const checksum = value => createHash('sha256').update(value).digest('hex');
try {
  const [target] = await db.execute('SELECT DATABASE() AS database_name, @@port AS server_port');
  if (target[0]?.database_name !== DATABASE || Number(target[0]?.server_port) !== 3308) {
    throw new Error('Identitas database browser seed tidak sesuai.');
  }
  const [office] = await db.execute(
    `SELECT b.batch_id,o.object_id FROM dashboard_source_registry s
     JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed'
     JOIN dashboard_import_object_identity i ON i.batch_id=b.batch_id AND i.object_key='uker_list.json'
     JOIN dashboard_import_object o ON o.object_id=i.object_id
     WHERE s.source_key='uker_list_json'`,
  );
  if (office.length !== 1) throw new Error('Master kantor sintetis tidak tunggal.');
  const [existing] = await db.execute('SELECT COUNT(*) AS total FROM dashboard_stg_office_row');
  if (Number(existing[0].total) !== 0) throw new Error('Browser seed pernah dijalankan; tidak akan mengulang.');
  await db.beginTransaction();
  try {
    const officeRaw = { 'BRANCH CODE': 'E2E001', BRANCH: 'KC E2E', 'BRANCH TYPE': 'KC',
      'MAIN BRANCH CODE': 'E2E001', AREA: 'AREA E2E' };
    await db.execute(
      `INSERT INTO dashboard_stg_office_row
       (batch_id,object_id,source_row_number,raw_record,source_code_text,source_name,source_type,
        source_main_branch_code,source_area,parse_status,mapping_status)
       VALUES (?,?,?,?,?,?,?,?,?,'valid','resolved')`,
      [office[0].batch_id, office[0].object_id, 1, JSON.stringify(officeRaw),
        'E2E001', 'KC E2E', 'KC', 'E2E001', 'AREA E2E'],
    );
    const addSource = async (sourceKey, objectKey, raw) => {
      const hash = checksum(JSON.stringify(raw));
      const [source] = await db.execute(
        'INSERT INTO dashboard_source_registry (source_key,source_type,display_name,source_location) VALUES (?, ?, ?, ?)',
        [sourceKey, 'xlsx_file', 'Synthetic browser E2E', 'synthetic:e2e'],
      );
      const batchId = randomUUID();
      await db.execute(
        `INSERT INTO dashboard_import_batch
         (batch_id,source_id,status,source_checksum,finished_at,rows_read,rows_staged)
         VALUES (?,?,'completed',?,CURRENT_TIMESTAMP(3),1,1)`, [batchId, source.insertId, hash],
      );
      const [object] = await db.execute(
        `INSERT INTO dashboard_import_object
         (batch_id,object_name,object_type,source_checksum,source_row_count,metadata)
         VALUES (?,?,'xlsx_sheet_snapshot',?,1,?)`,
        [batchId, objectKey, hash, JSON.stringify({ synthetic: true })],
      );
      await db.execute(
        'INSERT INTO dashboard_import_object_identity (object_id,batch_id,object_key) VALUES (?,?,?)',
        [object.insertId, batchId, objectKey],
      );
      return { batchId, objectId: object.insertId };
    };
    const rmftRaw = { PN: 'E2E-PN', Nama: 'Synthetic RMFT', Jabatan: 'RMFT', 'Kode Uker': 'E2E001' };
    const rmft = await addSource('rmft_list_json', 'rmft_list.json', rmftRaw);
    await db.execute(
      `INSERT INTO dashboard_stg_rmft_row
       (batch_id,object_id,source_row_number,raw_record,source_pn,source_name,source_job_title,
        source_unit_code,parse_status,mapping_status)
       VALUES (?,?,1,?,?,?,?,?,'valid','resolved')`,
      [rmft.batchId, rmft.objectId, JSON.stringify(rmftRaw), 'E2E-PN', 'Synthetic RMFT', 'RMFT', 'E2E001'],
    );
    await db.execute(
      `INSERT INTO dashboard_domain_publication
       (domain_key,scope_key,batch_id,publication_version,published_at)
       VALUES ('rmft_master','default',?,1,CURRENT_TIMESTAMP(3))`, [rmft.batchId],
    );
    const rkaRaw = { 'NO URUT': 1, 'RKA KEY': 'E2E001|A Tabungan Retail Funding',
      'MATA ANGGARAN': 'A Tabungan Retail Funding', 'KODE UKER': 'E2E001',
      JAN: 100, FEB: 100, MAR: 100, APR: 100, MAY: 100, JUN: 100,
      JUL: 100, AUG: 100, SEP: 100, OCT: 100, NOV: 100, DEC: 100 };
    const rka = await addSource('tabel_rka_json', 'tabel_rka.json', rkaRaw);
    await db.execute(
      `INSERT INTO dashboard_stg_rka_row
       (batch_id,object_id,source_row_number,source_no_urut,source_rka_key,source_category,
        source_unit_code,raw_month_values,raw_record,parse_status,mapping_status)
       VALUES (?,?,1,?,?,?,?,?,?,'valid','resolved')`,
      [rka.batchId, rka.objectId, '1', rkaRaw['RKA KEY'], rkaRaw['MATA ANGGARAN'],
        'E2E001', JSON.stringify(Object.fromEntries(Object.entries(rkaRaw).filter(([key]) => /^[A-Z]{3}$/.test(key)))),
        JSON.stringify(rkaRaw)],
    );
    await db.commit();
    process.stdout.write(JSON.stringify({ target: DATABASE, officeRows: 1, rmftRows: 1, rkaRows: 1 }) + '\n');
  } catch (error) { await db.rollback(); throw error; }
} finally { await db.end(); }
