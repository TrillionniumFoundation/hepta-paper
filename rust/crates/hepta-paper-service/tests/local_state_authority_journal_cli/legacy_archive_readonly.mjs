// Reopen only a detached CLI archive using the actual Node SQLite runtime.
// This is neither a replacement authority process nor a migration probe.
import { DatabaseSync } from 'node:sqlite';

const tables = [
  'authority_metadata',
  'authority_database_head',
  'authority_schema_transition',
  'authority_schema_rebind',
  'authority_mutation',
  'authority_backup_reservation',
];
const database = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const rows = tables.map(table => database
    .prepare(`SELECT rowid AS __source_rowid,* FROM main.${table} ORDER BY rowid`)
    .all().map(row => Object.values(row)));
  const catalog = database.prepare(
    'SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name',
  ).all().map(row => Object.values(row));
  const userVersion = Object.values(database.prepare('PRAGMA user_version').get())[0];
  const integrityCheck = Object.values(database.prepare('PRAGMA integrity_check').get())[0];
  process.stdout.write(JSON.stringify({ rows, catalog, userVersion, integrityCheck }));
} finally {
  database.close();
}
