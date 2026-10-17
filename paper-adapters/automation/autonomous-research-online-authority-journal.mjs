import onlineMutationMarkerSchemaStatements from '../../store/schema/autonomous-research-online-mutation-marker.v1.json' with { type: 'json' };
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

// Shared with the explicit Rust installed-schema recognizer. These exact string
// bytes and their order remain the protocol schema-contract hash input.
if (!Array.isArray(onlineMutationMarkerSchemaStatements)
  || onlineMutationMarkerSchemaStatements.length !== 11
  || onlineMutationMarkerSchemaStatements.some((statement) => (
    typeof statement !== 'string' || statement.length === 0 || Buffer.byteLength(statement) > 16 * 1024
  ))
  || Buffer.byteLength(JSON.stringify(onlineMutationMarkerSchemaStatements)) > 64 * 1024) {
  throw new Error('autonomous_research_online_mutation_marker_schema_source_invalid');
}
export const AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS =
  Object.freeze(onlineMutationMarkerSchemaStatements);


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
