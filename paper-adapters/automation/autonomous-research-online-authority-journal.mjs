import { DatabaseSync } from 'node:sqlite';

import {
  assertAutonomousResearchOnlineAuthorityJournalInstallerPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_VERSION = 1;
export const AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID =
  'autonomous-research-online-authority-journal-v1';

export const AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE autonomous_research_online_authority_journal_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  schema_contract_id TEXT NOT NULL,
  schema_contract_hash TEXT NOT NULL
) STRICT;`,
  `CREATE TABLE autonomous_research_online_authority_receipt_journal (
  journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_role TEXT NOT NULL CHECK (receipt_role IN ('current-head','active-challenge','broker-scope')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=71 AND substr(request_hash,1,7)='sha256:' AND substr(request_hash,8) NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  receipt_hash TEXT NOT NULL UNIQUE CHECK(length(receipt_hash)=71 AND substr(receipt_hash,1,7)='sha256:' AND substr(receipt_hash,8) NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  global_sequence INTEGER NOT NULL CHECK (global_sequence >= 0),
  global_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;`,
  `CREATE INDEX idx_autonomous_research_online_authority_receipt_latest
ON autonomous_research_online_authority_receipt_journal(
  receipt_role, global_sequence DESC, journal_id DESC
);`,
  `CREATE TRIGGER autonomous_research_online_authority_journal_no_update
BEFORE UPDATE ON autonomous_research_online_authority_receipt_journal
BEGIN SELECT RAISE(ABORT, 'autonomous_research_online_authority_journal_immutable'); END;`,
  `CREATE TRIGGER autonomous_research_online_authority_journal_no_delete
BEFORE DELETE ON autonomous_research_online_authority_receipt_journal
BEGIN SELECT RAISE(ABORT, 'autonomous_research_online_authority_journal_immutable'); END;`,
]);

export const AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE autonomous_research_online_mutation_authority_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  protocol TEXT NOT NULL,
  database_role TEXT NOT NULL,
  database_instance_id TEXT NOT NULL UNIQUE,
  schema_contract_id TEXT NOT NULL,
  schema_hash TEXT NOT NULL CHECK(length(schema_hash)=71 AND substr(schema_hash,1,7)='sha256:' AND substr(schema_hash,8) NOT GLOB '*[^0-9a-f]*'),
  database_scope_hash TEXT NOT NULL CHECK(length(database_scope_hash)=71 AND substr(database_scope_hash,1,7)='sha256:' AND substr(database_scope_hash,8) NOT GLOB '*[^0-9a-f]*'),
  writer_manifest_hash TEXT NOT NULL CHECK(length(writer_manifest_hash)=71 AND substr(writer_manifest_hash,1,7)='sha256:' AND substr(writer_manifest_hash,8) NOT GLOB '*[^0-9a-f]*'),
  genesis_global_sequence INTEGER NOT NULL CHECK (genesis_global_sequence >= 0),
  genesis_global_hash TEXT NOT NULL,
  genesis_database_sequence INTEGER NOT NULL CHECK (genesis_database_sequence >= 0),
  genesis_database_hash TEXT NOT NULL,
  genesis_state_hash TEXT NOT NULL,
  provisioned_at TEXT NOT NULL
) STRICT;`,
  `CREATE TABLE autonomous_research_online_mutation_authority_marker (
  reservation_id TEXT PRIMARY KEY,
  database_role TEXT NOT NULL,
  database_instance_id TEXT NOT NULL,
  writer_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  global_sequence INTEGER NOT NULL CHECK (global_sequence >= 0),
  global_hash TEXT NOT NULL,
  database_sequence INTEGER NOT NULL CHECK (database_sequence >= 0),
  database_hash TEXT NOT NULL,
  schema_hash TEXT NOT NULL,
  pre_state_hash TEXT NOT NULL,
  post_state_hash TEXT NOT NULL,
  changeset_hash TEXT NOT NULL,
  reserve_request_hash TEXT NOT NULL UNIQUE CHECK(length(reserve_request_hash)=71 AND substr(reserve_request_hash,1,7)='sha256:' AND substr(reserve_request_hash,8) NOT GLOB '*[^0-9a-f]*'),
  reserve_request_json TEXT NOT NULL CHECK(json_valid(reserve_request_json)),
  reservation_receipt_hash TEXT NOT NULL UNIQUE CHECK(length(reservation_receipt_hash)=71 AND substr(reservation_receipt_hash,1,7)='sha256:' AND substr(reservation_receipt_hash,8) NOT GLOB '*[^0-9a-f]*'),
  reservation_receipt_json TEXT NOT NULL CHECK(json_valid(reservation_receipt_json)),
  local_marker_hash TEXT NOT NULL UNIQUE CHECK(length(local_marker_hash)=71 AND substr(local_marker_hash,1,7)='sha256:' AND substr(local_marker_hash,8) NOT GLOB '*[^0-9a-f]*'),
  committed_at TEXT NOT NULL,
  CHECK(json_type(reserve_request_json,'$.kind')='text' AND json_extract(reserve_request_json,'$.kind')='AutonomousResearchOnlineMutationReserveRequest'),
  CHECK(json_type(reservation_receipt_json,'$.reservationId')='text' AND json_extract(reservation_receipt_json,'$.reservationId')=reservation_id),
  CHECK(json_type(reservation_receipt_json,'$.requestHash')='text' AND json_extract(reservation_receipt_json,'$.requestHash')=reserve_request_hash),
  CHECK(json_type(reservation_receipt_json,'$.databaseRole')='text' AND json_extract(reservation_receipt_json,'$.databaseRole')=database_role),
  CHECK(json_type(reservation_receipt_json,'$.databaseInstanceId')='text' AND json_extract(reservation_receipt_json,'$.databaseInstanceId')=database_instance_id),
  CHECK(json_type(reservation_receipt_json,'$.writerId')='text' AND json_extract(reservation_receipt_json,'$.writerId')=writer_id),
  CHECK(json_type(reservation_receipt_json,'$.operationId')='text' AND json_extract(reservation_receipt_json,'$.operationId')=operation_id),
  CHECK(json_type(reservation_receipt_json,'$.globalSequence')='integer' AND json_extract(reservation_receipt_json,'$.globalSequence')=global_sequence),
  CHECK(json_type(reservation_receipt_json,'$.databaseSequence')='integer' AND json_extract(reservation_receipt_json,'$.databaseSequence')=database_sequence),
  CHECK(json_type(reservation_receipt_json,'$.postStateHash')='text' AND json_extract(reservation_receipt_json,'$.postStateHash')=post_state_hash),
  UNIQUE(database_instance_id,database_sequence),
  UNIQUE(global_sequence)
) STRICT;`,
  `CREATE INDEX idx_autonomous_research_online_mutation_marker_head
ON autonomous_research_online_mutation_authority_marker(
  database_instance_id,database_sequence DESC
);`,
  `CREATE TABLE autonomous_research_online_mutation_finalization_receipt (
  reservation_id TEXT PRIMARY KEY,
  finalization_receipt_hash TEXT NOT NULL UNIQUE CHECK(length(finalization_receipt_hash)=71 AND substr(finalization_receipt_hash,1,7)='sha256:' AND substr(finalization_receipt_hash,8) NOT GLOB '*[^0-9a-f]*'),
  finalization_receipt_json TEXT NOT NULL CHECK(json_valid(finalization_receipt_json)),
  side_effect_permit_hash TEXT NOT NULL CHECK(length(side_effect_permit_hash)=71 AND substr(side_effect_permit_hash,1,7)='sha256:' AND substr(side_effect_permit_hash,8) NOT GLOB '*[^0-9a-f]*'),
  finalized_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  CHECK(json_type(finalization_receipt_json,'$.reservationId')='text' AND json_extract(finalization_receipt_json,'$.reservationId')=reservation_id),
  CHECK(json_type(finalization_receipt_json,'$.sideEffectPermitHash')='text' AND json_extract(finalization_receipt_json,'$.sideEffectPermitHash')=side_effect_permit_hash),
  FOREIGN KEY(reservation_id)
    REFERENCES autonomous_research_online_mutation_authority_marker(reservation_id)
) STRICT;`,
  `CREATE TRIGGER autonomous_research_online_mutation_marker_no_update
BEFORE UPDATE ON autonomous_research_online_mutation_authority_marker
BEGIN SELECT RAISE(ABORT, 'autonomous_research_online_mutation_marker_immutable'); END;`,
  `CREATE TRIGGER autonomous_research_online_mutation_marker_no_delete
BEFORE DELETE ON autonomous_research_online_mutation_authority_marker
BEGIN SELECT RAISE(ABORT, 'autonomous_research_online_mutation_marker_immutable'); END;`,
  `CREATE TRIGGER autonomous_research_online_mutation_metadata_no_update
BEFORE UPDATE ON autonomous_research_online_mutation_authority_metadata
BEGIN SELECT RAISE(ABORT, 'autonomous_research_online_mutation_metadata_immutable'); END;`,
  `CREATE TRIGGER autonomous_research_online_mutation_metadata_no_delete
BEFORE DELETE ON autonomous_research_online_mutation_authority_metadata
BEGIN SELECT RAISE(ABORT, 'autonomous_research_online_mutation_metadata_immutable'); END;`,
  `CREATE TRIGGER autonomous_research_online_mutation_finalization_no_update
BEFORE UPDATE ON autonomous_research_online_mutation_finalization_receipt
BEGIN SELECT RAISE(ABORT, 'autonomous_research_online_mutation_finalization_immutable'); END;`,
  `CREATE TRIGGER autonomous_research_online_mutation_finalization_no_delete
BEFORE DELETE ON autonomous_research_online_mutation_finalization_receipt
BEGIN SELECT RAISE(ABORT, 'autonomous_research_online_mutation_finalization_immutable'); END;`,
  `CREATE TRIGGER autonomous_research_online_mutation_finalization_marker_required
BEFORE INSERT ON autonomous_research_online_mutation_finalization_receipt
WHEN NOT EXISTS (
  SELECT 1 FROM autonomous_research_online_mutation_authority_marker
  WHERE reservation_id=NEW.reservation_id
)
BEGIN SELECT RAISE(ABORT, 'autonomous_research_online_mutation_finalization_marker_required'); END;`,
]);

export const AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH = hashRecord(
  'AutonomousResearchOnlineAuthorityJournalSchema',
  {
    version: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_VERSION,
    contractId: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
    statements: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS,
  },
);
export const AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_HASH = hashRecord(
  'AutonomousResearchOnlineMutationMarkerSchema',
  {
    version: 1,
    protocol: 'external-linearizable-reserve-apply-finalize-v1',
    statements: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
  },
);

const REQUIRED_SCHEMA_OBJECTS = Object.freeze([
  'index:idx_autonomous_research_online_authority_receipt_latest',
  'table:autonomous_research_online_authority_journal_metadata',
  'table:autonomous_research_online_authority_receipt_journal',
  'trigger:autonomous_research_online_authority_journal_no_delete',
  'trigger:autonomous_research_online_authority_journal_no_update',
]);

const REQUIRED_SCHEMA_OBJECT_NAMES = Object.freeze(REQUIRED_SCHEMA_OBJECTS.map((entry) => (
  entry.slice(entry.indexOf(':') + 1)
)).sort());

function sqliteSchemaIdentity(database) {
  const rows = database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name,sql;
`).all()
    .filter((row) => REQUIRED_SCHEMA_OBJECT_NAMES.includes(row.name))
    .map((row) => ({ ...row }));
  return hashRecord('AutonomousResearchOnlineAuthorityJournalSqliteSchema', rows);
}

function expectedAuthorityJournalSqliteSchemaIdentity() {
  const database = new DatabaseSync(':memory:');
  try {
    for (const statement of AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS) {
      database.exec(statement);
    }
    return sqliteSchemaIdentity(database);
  } finally { database.close(); }
}

export const AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SQLITE_SCHEMA_HASH =
  expectedAuthorityJournalSqliteSchemaIdentity();

function unavailable() {
  throw new Error('autonomous_research_online_authority_journal_schema_installer_unavailable');
}

export function createUnavailableAutonomousResearchOnlineAuthorityJournalInstaller() {
  return assertAutonomousResearchOnlineAuthorityJournalInstallerPort(Object.freeze({
    available: false,
    protocolStatus: 'unavailable-not-integrated',
    schemaContractId: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
    schemaContractHash: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
    installAuthorityJournalSchema: unavailable,
  }));
}

export function autonomousResearchOnlineAuthorityJournalProvisioningPlan() {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineAuthorityJournalProvisioningPlan',
    status: 'external_quiesced_provisioning_available',
    schemaContractId: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
    schemaContractHash: AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
    residentAuthorityJournalStatements:
      AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS,
    perDatabaseMarkerSchemaHash:
      AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_HASH,
    perDatabaseMarkerStatements:
      AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
    onlineInstallerAvailable: false,
    quiescedOfflineInstallerAvailable: true,
    quiescedOfflineInstallerProtocol:
      'external-authority-quiesced-offline-schema-transition-v1',
    quiescedOfflineInstallerModule:
      'paper-adapters/automation/autonomous-research-online-schema-transition.mjs',
    quiescedOfflineInstallerCommand:
      'paper-core/bin/autonomous-research-online-schema-transition.mjs',
    blockers: Object.freeze([]),
  });
}
