import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;
const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FORBIDDEN_SQL = /(?:;|--|\/\*|\*\/|\b(?:ATTACH|DETACH|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|CREATE|ALTER|DROP|VACUUM|REINDEX|ANALYZE)\b|^\s*END\b)/i;
const SYSTEM_TABLES = new Set([
  'autonomous_research_online_mutation_authority_metadata',
  'autonomous_research_online_mutation_authority_marker',
  'autonomous_research_online_mutation_finalization_receipt',
]);

function fail(code) { throw new Error(code); }

function writeTable(sql) {
  const normalized = String(sql || '').trim();
  for (const pattern of [
    /^INSERT\s+(?:OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)\s+)?INTO\s+([A-Za-z_][A-Za-z0-9_]*)\b/i,
    /^REPLACE\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\b/i,
    /^UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)\s+SET\b/i,
    /^DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)\b/i,
  ]) {
    const match = normalized.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function canonicalStatement(statement) {
  if (!hasExactObjectKeys(statement, ['statementId', 'mode', 'sql'])
    || !SAFE_ID.test(String(statement.statementId || ''))
    || !['get', 'all', 'run'].includes(statement.mode)
    || typeof statement.sql !== 'string'
    || statement.sql.length === 0
    || statement.sql.length > 64 * 1024
    || FORBIDDEN_SQL.test(statement.sql)) {
    fail('externally_fenced_sqlite_mutation_statement_plan_invalid');
  }
  const table = writeTable(statement.sql);
  if ((statement.mode === 'run') !== Boolean(table)
    || (statement.mode !== 'run' && !/^\s*SELECT\b/i.test(statement.sql))
    || (table && (SYSTEM_TABLES.has(table) || !SAFE_TABLE.test(table)))) {
    fail('externally_fenced_sqlite_mutation_statement_plan_invalid');
  }
  return Object.freeze({
    statementId: statement.statementId,
    mode: statement.mode,
    sql: statement.sql,
    writeTable: table,
  });
}

function canonicalOperationPlan(plan) {
  if (!hasExactObjectKeys(plan, ['version', 'operationId', 'statements'])
    || plan.version !== 1
    || !SAFE_ID.test(String(plan.operationId || ''))
    || !Array.isArray(plan.statements)
    || plan.statements.length === 0) {
    fail('externally_fenced_sqlite_mutation_operation_plan_invalid');
  }
  const statements = plan.statements.map(canonicalStatement);
  const ids = statements.map((entry) => entry.statementId);
  if (new Set(ids).size !== ids.length
    || ids.join('\0') !== [...ids].sort().join('\0')
    || statements.every((entry) => entry.mode !== 'run')) {
    fail('externally_fenced_sqlite_mutation_operation_plan_invalid');
  }
  return Object.freeze({
    version: 1,
    operationId: plan.operationId,
    statements: Object.freeze(statements),
  });
}

export function defineExternallyFencedSqliteMutationStatement(
  statementId,
  sql,
  mode = 'run',
) {
  return Object.freeze({ statementId, mode, sql });
}

export function compileExternallyFencedSqliteMutationOperation(
  operationId,
  statements,
  { sharedStatements = [] } = {},
) {
  return Object.freeze({
    version: 1,
    operationId,
    statements: Object.freeze([...sharedStatements, ...statements]
      .map((statement) => Object.freeze({ ...statement }))
      .sort((left, right) => left.statementId.localeCompare(right.statementId))),
  });
}

export function externallyFencedSqliteWriterPlanHash({ writerId, operationPlans } = {}) {
  if (!SAFE_ID.test(String(writerId || ''))
    || !Array.isArray(operationPlans) || operationPlans.length === 0) {
    fail('externally_fenced_sqlite_mutation_writer_plan_invalid');
  }
  const plans = operationPlans.map(canonicalOperationPlan)
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
  if (new Set(plans.map((plan) => plan.operationId)).size !== plans.length) {
    fail('externally_fenced_sqlite_mutation_writer_plan_invalid');
  }
  return hashRecord('ExternallyFencedSqliteWriterPlan', {
    version: 1,
    writerId,
    operationPlans: plans,
  });
}

export function validateExternallyFencedSqliteMutationPlans({
  manifest,
  operationPlans = {},
} = {}) {
  const integrated = manifest.operations.filter((operation) => operation.coordinatorIntegrated);
  const suppliedIds = Object.keys(operationPlans).sort();
  const integratedIds = integrated.map((operation) => operation.operationId).sort();
  if (suppliedIds.join('\0') !== integratedIds.join('\0')) {
    fail('externally_fenced_sqlite_mutation_operation_plans_incomplete');
  }
  const checked = new Map(suppliedIds.map((operationId) => {
    const plan = canonicalOperationPlan(operationPlans[operationId]);
    if (plan.operationId !== operationId) {
      fail('externally_fenced_sqlite_mutation_operation_plan_identity_mismatch');
    }
    return [operationId, plan];
  }));
  for (const writer of manifest.writers) {
    const plans = writer.operationIds.map((operationId) => operationPlans[operationId]);
    if (plans.some((plan) => !plan)
      || externallyFencedSqliteWriterPlanHash({
        writerId: writer.writerId,
        operationPlans: plans,
      }) !== writer.implementationHash) {
      fail('externally_fenced_sqlite_mutation_writer_plan_hash_mismatch');
    }
  }
  return Object.freeze({
    manifestHash: autonomousResearchOnlineWriterOperationManifestHash(manifest),
    byOperationId: checked,
  });
}

function quotedIdentifier(value) {
  if (!SAFE_TABLE.test(value)) fail('externally_fenced_sqlite_mutation_table_invalid');
  return `"${value}"`;
}

function writeEvents(statement) {
  const sql = String(statement?.sql || '').trim();
  if (/^REPLACE\s+INTO\b/i.test(sql)
    || /^INSERT\s+OR\s+REPLACE\s+INTO\b/i.test(sql)) {
    return new Set(['DELETE', 'INSERT']);
  }
  if (/^INSERT\s+(?:OR\s+(?:ABORT|FAIL|IGNORE|ROLLBACK)\s+)?INTO\b/i.test(sql)) {
    return new Set(/\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i.test(sql)
      ? ['INSERT', 'UPDATE'] : ['INSERT']);
  }
  if (/^UPDATE\s+/i.test(sql)) return new Set(['UPDATE']);
  if (/^DELETE\s+FROM\b/i.test(sql)) return new Set(['DELETE']);
  // Tests and compatibility callers may pass only the canonical writeTable
  // projection. Treat that incomplete projection as maximally effectful.
  return new Set(['DELETE', 'INSERT', 'UPDATE']);
}

function triggerEvent(sql) {
  return String(sql || '').match(
    /\b(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(INSERT|UPDATE|DELETE)\b/i,
  )?.[1]?.toUpperCase() || null;
}

function isReadOnlyRaiseTrigger(sql) {
  const body = String(sql || '').match(/\bBEGIN\b([\s\S]*)\bEND\s*$/i)?.[1];
  if (!body || /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(body)) return false;
  const statements = body.split(';').map((entry) => entry.trim()).filter(Boolean);
  return statements.length > 0 && statements.every((statement) => (
    /^SELECT\b/i.test(statement) && /\bRAISE\s*\(/i.test(statement)
  ));
}

export function assertExternallyFencedSqliteMutationDatabaseSurface(database, plan) {
  const databases = database.prepare('PRAGMA database_list').all()
    .map((entry) => String(entry.name));
  if (databases.some((name) => !['main', 'temp'].includes(name))) {
    fail('externally_fenced_sqlite_mutation_attached_database_forbidden');
  }
  const tempObjectCount = Number(database.prepare(`
SELECT count(*) AS count FROM sqlite_temp_schema
WHERE type IN ('table','trigger','view');
`).get().count);
  if (tempObjectCount !== 0) {
    fail('externally_fenced_sqlite_mutation_temp_schema_forbidden');
  }
  const businessTables = database.prepare(`
SELECT name FROM sqlite_schema
WHERE type='table' AND name NOT LIKE 'sqlite_%'
ORDER BY name;
`).all().map((entry) => String(entry.name))
    .filter((name) => !SYSTEM_TABLES.has(name));
  const plannedTables = new Set(plan.statements
    .filter((entry) => entry.writeTable)
    .map((entry) => entry.writeTable));
  if ([...plannedTables].some((table) => !businessTables.includes(table))) {
    fail('externally_fenced_sqlite_mutation_planned_table_missing');
  }
  const writeStatements = plan.statements.filter((entry) => entry.writeTable);
  // Only tables in the pinned plan can be changed directly. We validate those
  // targets plus reverse foreign-key actions and matching triggers below;
  // unrelated tables therefore cannot block a safe bounded operation merely
  // because they belong to the same native database.
  const plannedEvents = new Map([...plannedTables].map((table) => [table, new Set()]));
  for (const statement of writeStatements) {
    for (const event of writeEvents(statement)) plannedEvents.get(statement.writeTable).add(event);
  }
  for (const table of plannedTables) {
    const columns = database.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`).all();
    if (!columns.some((column) => Number(column.pk) > 0)) {
      fail(`externally_fenced_sqlite_mutation_explicit_primary_key_required:${table}`);
    }
    const columnNames = new Set(columns.map((column) => String(column.name)));
    const foreignKeys = database.prepare(
      `PRAGMA foreign_key_list(${quotedIdentifier(table)})`,
    ).all();
    for (const foreignKey of foreignKeys) {
      const targetTable = String(foreignKey.table || '');
      const targetColumns = businessTables.includes(targetTable)
        ? database.prepare(`PRAGMA table_info(${quotedIdentifier(targetTable)})`).all()
        : [];
      const target = targetColumns.find(
        (column) => String(column.name) === String(foreignKey.to || ''),
      );
      if (!columnNames.has(String(foreignKey.from || ''))
        || !target || Number(target.pk) < 1
        || String(foreignKey.match || 'NONE') !== 'NONE') {
        fail(`externally_fenced_sqlite_mutation_foreign_key_forbidden:${table}`);
      }
    }
  }
  for (const childTable of businessTables) {
    for (const foreignKey of database.prepare(
      `PRAGMA foreign_key_list(${quotedIdentifier(childTable)})`,
    ).all()) {
      const parentTable = String(foreignKey.table || '');
      const events = plannedEvents.get(parentTable);
      if (!events) continue;
      const safeAction = (value) => ['NO ACTION', 'RESTRICT'].includes(String(value));
      if ((events.has('UPDATE') && !safeAction(foreignKey.on_update))
        || (events.has('DELETE') && !safeAction(foreignKey.on_delete))) {
        fail(`externally_fenced_sqlite_mutation_foreign_key_forbidden:${childTable}`);
      }
    }
  }
  const triggers = database.prepare(`
SELECT name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_schema
WHERE type='trigger' AND tbl_name NOT LIKE 'autonomous_research_online_mutation_%'
ORDER BY name;
`).all();
  for (const trigger of triggers) {
    const events = plannedEvents.get(String(trigger.tbl_name));
    const event = triggerEvent(trigger.sql);
    if (!events || (event && !events.has(event))) continue;
    if (!event || !isReadOnlyRaiseTrigger(trigger.sql)) {
      fail('externally_fenced_sqlite_mutation_business_trigger_forbidden');
    }
  }
}

export function createExternallyFencedSqliteMutationTransaction(database, plan) {
  const statements = new Map(plan.statements.map((entry) => [
    entry.statementId,
    Object.freeze({ definition: entry, statement: database.prepare(entry.sql) }),
  ]));
  let active = true;
  const invoke = (mode, statementId, parameters) => {
    if (!active) fail('externally_fenced_sqlite_mutation_transaction_revoked');
    const entry = statements.get(statementId);
    if (!entry || entry.definition.mode !== mode) {
      fail('externally_fenced_sqlite_mutation_statement_not_authorized');
    }
    return entry.statement[mode](...parameters);
  };
  return Object.freeze({
    transaction: Object.freeze({
      get: (statementId, ...parameters) => invoke('get', statementId, parameters),
      all: (statementId, ...parameters) => invoke('all', statementId, parameters),
      run: (statementId, ...parameters) => invoke('run', statementId, parameters),
    }),
    revoke() { active = false; },
  });
}
