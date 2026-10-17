import { createHash, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { getDatabaseConfig } from '../server/db.js';

const DATABASE = 'dashboard_funding_daily_e2e';
const BASE_ROWS = 1_039_742;
const RESOLVED_ROWS = 1_038_051;
const config = getDatabaseConfig();
if (!['127.0.0.1', 'localhost'].includes(config.host.toLowerCase()) || config.port !== 3308
  || DATABASE === config.database) throw new Error('Target seed tidak terisolasi.');
const connection = await mysql.createConnection({ ...config, database: DATABASE });
const sha = value => createHash('sha256').update(value).digest('hex');

try {
  const [identity] = await connection.execute('SELECT DATABASE() AS database_name, @@port AS server_port');
  if (identity[0]?.database_name !== DATABASE || Number(identity[0]?.server_port) !== 3308) {
    throw new Error('Identitas MySQL seed tidak sesuai.');
  }
  const [tables] = await connection.execute(
    'SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()',
  );
  if (Number(tables[0]?.total) !== 33) throw new Error('Migration database sintetis belum lengkap.');
  const [[{ total: sourceCount }]] = await connection.execute('SELECT COUNT(*) AS total FROM dashboard_source_registry');
  const [[{ total: factCount }]] = await connection.execute('SELECT COUNT(*) AS total FROM dashboard_fact_position_daily');
  if (Number(factCount) !== 0 || ![0, 2].includes(Number(sourceCount))) {
    throw new Error('Database sintetis berisi data di luar kondisi seed yang aman.');
  }

  let baseObjectId; let baseBatchId; let officeId;
  if (Number(sourceCount) === 0) {
  await connection.beginTransaction();
  try {
    const addSource = async (sourceKey, objectKey, count, checksum) => {
      const [source] = await connection.execute(
        'INSERT INTO dashboard_source_registry (source_key,source_type,display_name,source_location) VALUES (?, ?, ?, ?)',
        [sourceKey, 'xlsx_file', 'Synthetic E2E', 'synthetic:e2e'],
      );
      const batchId = randomUUID();
      await connection.execute(
        `INSERT INTO dashboard_import_batch
         (batch_id,source_id,status,source_checksum,finished_at,rows_read,rows_staged)
         VALUES (?,?,'completed',?,CURRENT_TIMESTAMP(3),?,?)`,
        [batchId, source.insertId, checksum, count, count],
      );
      const [object] = await connection.execute(
        `INSERT INTO dashboard_import_object
         (batch_id,object_name,object_type,source_checksum,source_row_count,metadata)
         VALUES (?,?,'xlsx_sheet_snapshot',?,?,?)`,
        [batchId, objectKey, checksum, count, JSON.stringify({ synthetic: true })],
      );
      await connection.execute(
        'INSERT INTO dashboard_import_object_identity (object_id,batch_id,object_key) VALUES (?,?,?)',
        [object.insertId, batchId, objectKey],
      );
      return { batchId, objectId: object.insertId };
    };
    const base = await addSource('segmen_data_json', 'segmen_data.json', BASE_ROWS, sha('synthetic-base'));
    baseBatchId = base.batchId; baseObjectId = base.objectId;
    const office = await addSource('uker_list_json', 'uker_list.json', 1, sha('synthetic-office'));
    const [officeResult] = await connection.execute(
      'INSERT INTO dashboard_dim_office (source_system,source_code) VALUES (?,?)',
      ['uker_list_json', 'E2E001'],
    );
    officeId = officeResult.insertId;
    await connection.execute(
      `INSERT INTO dashboard_dim_office_version
       (office_id,office_type,office_name,area_name,observed_at,source_object_id)
       VALUES (?,?,?,?,'2026-10-15 00:00:00.000',?)`,
      [officeId, 'KC', 'KC E2E', 'AREA E2E', office.objectId],
    );
    await connection.execute(
      `INSERT INTO dashboard_domain_publication
       (domain_key,scope_key,batch_id,publication_version,published_at)
       VALUES ('office_master','default',?,1,CURRENT_TIMESTAMP(3))`, [office.batchId],
    );
    await connection.execute(
      `INSERT INTO dashboard_dim_date
       (calendar_date,calendar_year,calendar_month,calendar_day,month_start,month_end)
       VALUES ('2026-10-04',2026,10,4,'2026-10-01','2026-10-31')`,
    );
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  } else {
    const [sourceTypes] = await connection.execute(
      "SELECT source_id,source_type FROM dashboard_source_registry WHERE source_key='segmen_data_json'",
    );
    if (sourceTypes.length !== 1 || !['xlsx', 'xlsx_file'].includes(sourceTypes[0].source_type)) {
      throw new Error('Tipe sumber seed parsial tidak konsisten.');
    }
    if (sourceTypes[0].source_type === 'xlsx') await connection.execute(
      "UPDATE dashboard_source_registry SET source_type='xlsx_file' WHERE source_id=?", [sourceTypes[0].source_id],
    );
    const [base] = await connection.execute(
      `SELECT o.object_id,b.batch_id FROM dashboard_source_registry s
       JOIN dashboard_import_batch b ON b.source_id=s.source_id AND b.status='completed'
       JOIN dashboard_import_object_identity i ON i.batch_id=b.batch_id AND i.object_key='segmen_data.json'
       JOIN dashboard_import_object o ON o.object_id=i.object_id
       WHERE s.source_key='segmen_data_json' AND o.source_row_count=?`, [BASE_ROWS],
    );
    const [offices] = await connection.execute(
      "SELECT office_id FROM dashboard_dim_office WHERE source_system='uker_list_json' AND source_code='E2E001'",
    );
    if (base.length !== 1 || offices.length !== 1) throw new Error('Metadata seed parsial tidak konsisten.');
    baseObjectId = base[0].object_id; baseBatchId = base[0].batch_id; officeId = offices[0].office_id;
  }

  const digits = `(SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
    UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)`;
  const digitJoins = 'abcdefg'.split('').map(alias => `${digits} ${alias}`).join(' CROSS JOIN ');
  const sourceNumber = '(a.n+10*b.n+100*c.n+1000*d.n+10000*e.n+100000*f.n+1000000*g.n+1)';
  const started = Date.now();
  await connection.beginTransaction();
  try {
    await connection.query(
      `INSERT INTO dashboard_fact_position_daily
       (batch_id,object_id,source_row_number,position_date,office_id,
        source_segment_label,source_product_label,source_branch_label,source_office_label,
        source_account_count_text,account_count,source_balance_text,balance,amount_unit_code,
        parse_status,mapping_status)
       SELECT ?,?,${sourceNumber},'2026-10-04',
              IF(${sourceNumber}<=?, ?, NULL),
              'MIKRO','TABUNGAN','KC E2E',
              IF(${sourceNumber}<=?,'KC E2E','UNIT UNRESOLVED E2E'),
              '1',1,'100',100,NULL,'valid',
              IF(${sourceNumber}<=?,'resolved','unresolved')
       FROM ${digitJoins}
       WHERE g.n<=1 AND ${sourceNumber}<=?`,
      [baseBatchId, baseObjectId, RESOLVED_ROWS, officeId, RESOLVED_ROWS, RESOLVED_ROWS, BASE_ROWS],
    );
    const [[counts]] = await connection.execute(
      `SELECT COUNT(*) AS total,COUNT(DISTINCT source_row_number) AS identities,
              SUM(mapping_status='resolved') AS resolved,SUM(mapping_status='unresolved') AS unresolved
       FROM dashboard_fact_position_daily WHERE object_id=?`, [baseObjectId],
    );
    if (Number(counts.total) !== BASE_ROWS || Number(counts.identities) !== BASE_ROWS
      || Number(counts.resolved) !== RESOLVED_ROWS || Number(counts.unresolved) !== BASE_ROWS - RESOLVED_ROWS) {
      throw new Error('Seed fakta sintetis tidak cocok dengan kontrak API.');
    }
    await connection.commit();
    process.stdout.write(JSON.stringify({ target: DATABASE, baseRows: Number(counts.total),
      identities: Number(counts.identities), resolved: Number(counts.resolved),
      unresolved: Number(counts.unresolved), elapsedMs: Date.now() - started }) + '\n');
  } catch (error) { await connection.rollback(); throw error; }
} finally { await connection.end(); }
