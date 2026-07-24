import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function observedExternallyFencedSqliteMutationNow(
  clock,
  invalidClockError = 'externally_fenced_sqlite_mutation_clock_invalid',
) {
  const value = clock?.now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(invalidClockError);
  return date;
}

export function externallyFencedSqliteMutationExactSchemaHash(database) {
  const rows = database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name,sql;
`).all().map((row) => ({ ...row }));
  return hashRecord('AutonomousResearchStateDatabaseSchema', rows);
}

export function readExternallyFencedSqliteMutationMetadata(database) {
  const rows = database.prepare(`
SELECT * FROM autonomous_research_online_mutation_authority_metadata
WHERE singleton=1;
`).all();
  if (rows.length !== 1) {
    throw new Error('externally_fenced_sqlite_mutation_metadata_required');
  }
  return rows[0];
}
