// Test-only differential corpus; every SQLite database is in memory.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { externallyFencedSqliteWriterPlanHash, validateExternallyFencedSqliteMutationPlans, assertExternallyFencedSqliteMutationDatabaseSurface, createExternallyFencedSqliteMutationTransaction } from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import { AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES as roles } from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
assert.equal(process.version, 'v22.23.1');
const capture = (fn) => { try { return { ok: fn() }; } catch (error) { return { error: error.message }; } };
const protocol = 'external-linearizable-reserve-apply-finalize-v1';
const plan = { version: 1, operationId: 'resident-instance.commit.v1', statements: [
  { statementId: 'aa-read', mode: 'all', sql: 'SELECT * FROM planned_rows ORDER BY id' },
  { statementId: 'bb-select', mode: 'get', sql: 'SELECT * FROM planned_rows WHERE id=?' },
  { statementId: 'cc-update', mode: 'run', sql: 'UPDATE planned_rows SET value=? WHERE id=?' },
] };
const writerId = 'writer:resident-instance';
const hash = (plans) => externallyFencedSqliteWriterPlanHash({ writerId, operationPlans: plans });
const manifest = { version: 1, kind: 'AutonomousResearchOnlineWriterCoverageManifest', manifestId: 'plan-fixture-v1', protocol,
  requiredDatabaseRoles: [...roles].sort(),
  writers: [{ writerId, databaseRoles: ['resident-instance'], operationIds: [plan.operationId], implementationHash: hash([plan]), protocol }],
  operations: roles.map((role) => ({ operationId: `${role}.commit.v1`, databaseRole: role, sourceFile: `paper-adapters/automation/${role}-writer.mjs`, entrypoint: `${role}.commit`, mutationClass: 'business-dml', protocolStatus: role === 'resident-instance' ? 'coordinator-integrated-reserve-apply-finalize-v1' : 'uncovered-no-coordinator-integration', coordinatorIntegrated: role === 'resident-instance' })),
  coverage: { requiredRoleCount: roles.length, coveredRoleCount: 1, coveredDatabaseRoles: ['resident-instance'], percent: Number((100 / roles.length).toFixed(2)) },
};
const plans = [];
function add(name, value = plan) { plans.push({ name, value, result: capture(() => hash([value])) }); }
add('base');
for (const sql of ['UPDATE planned_rows SET value=?', 'UPDATE PLANNED_ROWS SET value=?', 'INSERT INTO planned_rows VALUES(?,?)', 'INSERT OR REPLACE INTO planned_rows VALUES(?,?)', 'REPLACE INTO planned_rows VALUES(?,?)', 'DELETE FROM planned_rows WHERE id=?', 'INSERT INTO planned_rows VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', 'SELECT 1', 'WITH x AS (SELECT 1) UPDATE planned_rows SET value=1', 'UPDATE "planned_rows" SET value=1', 'UPDATE main.planned_rows SET value=1', 'UPDATE planned_rows SET value=1;', "UPDATE planned_rows SET value='COMMIT'", "UPDATE planned_rows SET value='ROLLBACK'", 'UPDATE planned_rows SET value=? -- comment', 'UPDATE planned_rows SET value=? /*comment*/', 'UPDATE autonomous_research_online_mutation_authority_marker SET reservation_id=?', '\ufeffUPDATE planned_rows SET value=?', '\u0085UPDATE planned_rows SET value=?', 'UPDATE\u2003planned_rows SET value=?', 'UPDate planned_rows sEt value=?', 'UPDATE K SET value=?', 'UPDATE planned_rows SET value=? RETURNING value']) {
  const next = structuredClone(plan); next.statements[2].sql = sql; add(sql, next);
}
for (const [name, mutate] of [
  ['unknown-plan-field', (p) => { p.extra = true; }], ['bad-version', (p) => { p.version = '1'; }],
  ['duplicate-statement-id', (p) => { p.statements[1].statementId = p.statements[0].statementId; }],
  ['unsorted-statements', (p) => { p.statements.reverse(); }], ['read-only', (p) => { p.statements.pop(); }],
  ['unknown-mode', (p) => { p.statements[2].mode = 'execute'; }], ['unknown-statement-field', (p) => { p.statements[2].writeTable = 'planned_rows'; }],
  ['short-id', (p) => { p.operationId = 'x'; }], ['numeric-id', (p) => { p.operationId = 12; }],
  ['boolean-id', (p) => { p.operationId = true; }], ['array-id', (p) => { p.operationId = ['one-id']; }],
  ['numeric-statement-id', (p) => { p.statements[0].statementId = 12; }],
  ['numeric-and-string-statement-ids', (p) => { p.statements[0].statementId = 12; p.statements[1].statementId = '12'; }],
  ['mode-mismatch', (p) => { p.statements[0].mode = 'run'; }],
  ['sql-utf16-limit', (p) => { p.statements[2].sql = `UPDATE planned_rows SET value='${'🌍'.repeat(32768)}'`; }],
]) { const next = structuredClone(plan); mutate(next); add(name,next); }
const mapping = { [plan.operationId]: plan };
const checked = validateExternallyFencedSqliteMutationPlans({ manifest, operationPlans: mapping });
const registry = { manifest, mapping, result: { manifestHash: checked.manifestHash, byOperationId: Object.fromEntries(checked.byOperationId) } };
const baseSql = "CREATE TABLE planned_rows(id INTEGER PRIMARY KEY,value TEXT); CREATE TABLE other_rows(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO planned_rows VALUES(1,'before'); INSERT INTO other_rows VALUES(1,'untouched');";
const surfaces = [];
for (const [name, sql] of [
  ['valid', baseSql], ['attached', `${baseSql} ATTACH DATABASE ':memory:' AS extra`], ['temp', `${baseSql} CREATE TEMP TABLE temp_rows(id INTEGER)`],
  ['missing', 'CREATE TABLE other_rows(id INTEGER PRIMARY KEY)'], ['no-primary-key', 'CREATE TABLE planned_rows(id INTEGER,value TEXT)'],
  ['same-operation-trigger', `${baseSql} CREATE TRIGGER same_effect AFTER UPDATE ON planned_rows BEGIN UPDATE planned_rows SET value=value WHERE id=new.id; END;`],
  ['side-effect-trigger', `${baseSql} CREATE TRIGGER other_effect AFTER UPDATE ON planned_rows BEGIN INSERT INTO other_rows VALUES(2,new.value); END;`],
  ['foreign-key-cascade', `${baseSql} CREATE TABLE child(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES planned_rows(id) ON UPDATE CASCADE)`],
  ['foreign-key-restrict', `${baseSql} CREATE TABLE child(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES planned_rows(id) ON UPDATE RESTRICT)`],
  ['implicit-foreign-key-target', 'CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE planned_rows(id INTEGER PRIMARY KEY,value TEXT,parent INTEGER REFERENCES parent)'],
]) {
  const db = new DatabaseSync(':memory:');
  try { db.exec(sql); surfaces.push({ name, sql, result: capture(() => { assertExternallyFencedSqliteMutationDatabaseSurface(db,checked.byOperationId.get(plan.operationId)); return true; }) }); } finally { db.close(); }
}
const transactionCases = [];
for (const [name, sql, invocations] of [
  ['update-read',baseSql,[['run','cc-update',['after',1]],['get','bb-select',[1]],['get','bb-select',[9]],['all','aa-read',[]]]],
  ['unauthorized-id',baseSql,[['run','missing',[]]]], ['wrong-mode',baseSql,[['all','cc-update',[]]]],
  ['blocked-trigger',surfaces.find((v) => v.name === 'side-effect-trigger').sql,[['run','cc-update',['bad',1]]]],
  ['unchanged',baseSql,[['run','cc-update',['before',1]]]],
]) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`${sql}; BEGIN IMMEDIATE;`);
    const surface = createExternallyFencedSqliteMutationTransaction(db,checked.byOperationId.get(plan.operationId));
    let values = [];
    const result = capture(() => { try { values = invocations.map(([mode,id,args]) => surface.transaction[mode](id,...args) ?? null); } finally { surface.revoke(); } return values; });
    const cleanup = db.prepare("SELECT count(*) AS n FROM sqlite_temp_schema WHERE type='trigger'").get().n;
    db.exec('ROLLBACK');
    transactionCases.push({ name,sql,invocations,result,cleanup });
  } finally { db.close(); }
}
process.stdout.write(JSON.stringify({ plans,registry,surfaces,transactionCases }));
