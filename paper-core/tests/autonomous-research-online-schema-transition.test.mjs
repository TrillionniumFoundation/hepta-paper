import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  executeAutonomousResearchOnlineSchemaTransition,
  inspectAutonomousResearchOnlineSchemaTransitionReadiness,
  planAutonomousResearchOnlineSchemaTransition,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';
import {
  executeAutonomousResearchOnlineSchemaTransitionJournalNormalization,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-journal-normalization.mjs';
import {
  applySchemaTransitionStatements,
  assertSchemaTransitionNoSidecars,
  assertSchemaTransitionTargetObjects,
  schemaTransitionDatabasePath,
  schemaTransitionFileIdentity,
  schemaTransitionJournalPreimageHash,
  schemaTransitionNormalizedProjectionMatches,
  schemaTransitionNow,
  schemaTransitionSameIdentity,
  schemaTransitionStableFileIdentity,
  schemaTransitionTargetSchema,
  validateAutonomousResearchOnlineSchemaTransitionInventory,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs';
import {
  autonomousResearchOnlineSchemaTransitionControlPaths,
  readAutonomousResearchOnlineSchemaTransitionJson,
  writeAutonomousResearchOnlineSchemaTransitionJson,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-state-repository.mjs';
import {
  buildAutonomousResearchOnlineSchemaTransitionReserveRequest,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-state.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS,
} from '../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs';
import { fileSha256HashSync } from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import {
  assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest,
  assertAutonomousResearchOnlineSchemaTransitionObserveRequest,
  assertAutonomousResearchOnlineSchemaTransitionReserveRequest,
  buildAutonomousResearchPristineSchemaRebindGenesis,
  autonomousResearchOnlineSchemaTransitionReceiptHash,
  verifyAutonomousResearchOnlineSchemaTransitionFinalization,
  verifyAutonomousResearchOnlineSchemaTransitionObservation,
  verifyAutonomousResearchOnlineSchemaTransitionReservation,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  parseAutonomousResearchOnlineSchemaTransitionArguments,
  runAutonomousResearchOnlineSchemaTransition,
} from '../bin/autonomous-research-online-schema-transition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const stateDatabaseManifest = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot,
  'paper-core',
  'config',
  'autonomous-research-state-databases.v1.json',
), 'utf8'));
const H = (label) => hashRecord('AutonomousResearchOnlineSchemaTransitionTest', { label });

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function isTransitionSchemaObject(name) {
  return name.includes('autonomous_research_online_')
    || name === 'idx_autonomous_research_online_mutation_marker_head'
    || name === 'submission_authorization_consumptions';
}

function createBusinessDatabase(candidate, definition) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(candidate);
  try {
    database.exec(`
PRAGMA journal_mode=DELETE;
PRAGMA foreign_keys=ON;
CREATE TABLE fixture_anchor(id TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO fixture_anchor(id,value) VALUES('fixture','ready');
`);
    if (definition.role === 'submission-handoff') {
      const migration = AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS[0];
      const appliedAt = '2026-07-19T03:00:00.000Z';
      database.exec(migration.sql);
      database.prepare(`INSERT INTO handoff_schema_migrations(
        version,name,migration_sha256,applied_at
      ) VALUES(?,?,?,?);`).run(
        migration.version,
        migration.name,
        migration.migrationHash,
        appliedAt,
      );
      database.prepare(`INSERT INTO handoff_instance(
        singleton,instance_nonce,provisioned_at
      ) VALUES(1,?,?);`).run('00000000-0000-4000-8000-000000000001', appliedAt);
      database.prepare(`INSERT INTO handoff_cutover(
        singleton,cutover_id,native_cutover_identity_hash,status,prepared_at,activated_at
      ) VALUES(1,?,?,?,?,?);`).run(
        'autonomous-submission-handoff-cutover-v1',
        H('fixture-handoff-cutover'),
        'active',
        appliedAt,
        appliedAt,
      );
    }
    for (const schemaObject of definition.requiredSchemaObjects) {
      const [type, name] = schemaObject.split(':');
      if (isTransitionSchemaObject(name)) continue;
      if (database.prepare('SELECT 1 FROM sqlite_schema WHERE type=? AND name=?;')
        .get(type, name)) continue;
      const identifier = sqlIdentifier(name);
      if (type === 'table') {
        database.exec(`CREATE TABLE ${identifier}(id TEXT PRIMARY KEY);`);
      } else if (type === 'index') {
        database.exec(`CREATE INDEX ${identifier} ON fixture_anchor(value);`);
      } else if (type === 'trigger') {
        database.exec(`CREATE TRIGGER ${identifier} BEFORE UPDATE ON fixture_anchor
          BEGIN SELECT 1; END;`);
      } else if (type === 'view') {
        database.exec(`CREATE VIEW ${identifier} AS SELECT id,value FROM fixture_anchor;`);
      } else {
        throw new Error(`unsupported_schema_transition_fixture_object:${schemaObject}`);
      }
    }
    database.exec('PRAGMA user_version=1;');
  } finally {
    database.close();
  }
  fs.chmodSync(candidate, 0o600);
}

function fixture(context) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-schema-transition-'));
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const databasePaths = stateDatabaseManifest.databases.map((definition) => {
    const relativePath = definition.cardinality === 'per-paper'
      ? definition.relativePathPattern.replace('{paperId}', 'paper-alpha')
      : definition.relativePath;
    const candidate = path.join(runtimeRoot, relativePath);
    createBusinessDatabase(candidate, definition);
    return candidate;
  });
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, runtimeRoot, databasePaths };
}

function controlledClock() {
  let current = new Date('2026-07-19T04:00:00.000Z');
  return Object.freeze({
    now: () => new Date(current),
    advance(milliseconds) { current = new Date(current.getTime() + milliseconds); },
  });
}

function exactFileSnapshot(candidate) {
  if (!fs.existsSync(candidate)) return Object.freeze({ presence: 'absent' });
  const stat = fs.lstatSync(candidate, { bigint: true });
  return Object.freeze({
    presence: 'present',
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    bytes: String(stat.size),
    modifiedNs: String(stat.mtimeNs),
    sha256: fileSha256HashSync(candidate),
  });
}

async function stopWalHolder(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

async function startWalHolder(databasePaths) {
  const program = `
import { DatabaseSync } from 'node:sqlite';
const databases = ${JSON.stringify(databasePaths)}.map((candidate, index) => {
  const database = new DatabaseSync(candidate);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  database.prepare('UPDATE fixture_anchor SET value=? WHERE id=?;')
    .run('durable-wal-' + index, 'fixture');
  return database;
});
process.stdout.write('ready\\n');
setInterval(() => databases.length, 1000);
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('ready\n')) resolve();
    });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.once('exit', (code, signal) => reject(new Error(
      `durable_wal_holder_exited:${code}:${signal}:${errors}`,
    )));
    child.once('error', reject);
  });
  return child;
}

function createAuthority(runtimeRoot) {
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  if (inventory.instances.length !== stateDatabaseManifest.databases.length) {
    throw new Error(`schema_transition_fixture_inventory:${JSON.stringify(inventory)}`);
  }
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: 'schema-transition-test-authority',
    keyId: 'schema-transition-test-key',
    scopeId: 'schema-transition-test-scope',
    databaseScopeHash: inventory.databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    ),
    maximumReservationLeaseMs: 300000,
    maximumObservationAgeMs: 60000,
  });
  const calls = { reserve: 0, finalize: 0, observe: 0 };
  const verifySignature = () => true;
  const client = Object.freeze({
    trust,
    reserveSchemaTransition({ request, now }) {
      calls.reserve += 1;
      assertAutonomousResearchOnlineSchemaTransitionReserveRequest(request, { trust });
      const issuedAt = now.toISOString();
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineSchemaTransitionReservationReceipt',
        status: 'autonomous_research_online_schema_transition_reserved',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchOnlineSchemaTransitionReserveRequest', request),
        reservationId: 'schema-transition-reservation-1',
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        stateDatabaseManifestHash: request.stateDatabaseManifestHash,
        transitionInventoryHash: request.transitionInventoryHash,
        schemaBundleHash: request.schemaBundleHash,
        authorityJournalSchemaContractId: request.authorityJournalSchemaContractId,
        authorityJournalSchemaHash: request.authorityJournalSchemaHash,
        markerSchemaHash: request.markerSchemaHash,
        transitionId: request.transitionId,
        instances: request.instances,
        databaseGenesis: Object.freeze(request.instances.map((instance, index) => Object.freeze({
          databaseRole: instance.databaseRole,
          databaseInstanceId: instance.databaseInstanceId,
          schemaContractId: instance.schemaContractId,
          schemaHash: instance.expectedPostSchemaHash,
          globalSequence: 0,
          globalHash: H('genesis-global'),
          databaseSequence: 0,
          databaseHash: H(`genesis-database:${index}`),
          stateHash: H(`genesis-state:${index}`),
        }))),
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + request.requestedLeaseMs).toISOString(),
        allRegisteredMutationsFenced: true,
        quiescenceMode: 'scope-wide-no-new-reservations-until-finalize-or-expiry',
        signature: 'test-signature',
      });
    },
    verifyStoredReservation({ receipt, request, now }) {
      return verifyAutonomousResearchOnlineSchemaTransitionReservation({
        receipt, request, trust, now, verifySignature,
      });
    },
    verifyHistoricalReservation({ receipt, request }) {
      return verifyAutonomousResearchOnlineSchemaTransitionReservation({
        receipt, request, trust, now: new Date(receipt.issuedAt), verifySignature,
      });
    },
    finalizeSchemaTransition({ request, reservation, now }) {
      calls.finalize += 1;
      assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest(request, reservation);
      const receipt = Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineSchemaTransitionFinalizationReceipt',
        status: 'autonomous_research_online_schema_transition_finalized',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchOnlineSchemaTransitionFinalizeRequest', request),
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        transitionId: request.transitionId,
        transitionInventoryHash: request.transitionInventoryHash,
        schemaBundleHash: request.schemaBundleHash,
        reservationId: request.reservationId,
        reservationReceiptHash: request.reservationReceiptHash,
        postInventoryHash: request.postInventoryHash,
        postPristineRuntimeStateHash: request.postPristineRuntimeStateHash,
        installations: request.installations,
        globalSequence: 1,
        globalHash: H('final-global'),
        finalizedAt: now.toISOString(),
        allRegisteredMutationsFencedThroughFinalize: true,
        signature: 'test-signature',
      });
      assert.equal(verifyAutonomousResearchOnlineSchemaTransitionFinalization({
        receipt, request, reservation, trust, now, verifySignature,
      }), true);
      return receipt;
    },
    verifyHistoricalFinalization({ receipt, request, reservation }) {
      return verifyAutonomousResearchOnlineSchemaTransitionFinalization({
        receipt, request, reservation, trust,
        now: new Date(receipt.finalizedAt), verifySignature,
      });
    },
    observeSchemaTransition({ request, now }) {
      calls.observe += 1;
      assertAutonomousResearchOnlineSchemaTransitionObserveRequest(request, { trust });
      const observedAt = now.toISOString();
      const receipt = Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineSchemaTransitionObservationReceipt',
        status: 'autonomous_research_online_schema_transition_observed_finalized',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchOnlineSchemaTransitionObserveRequest', request),
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        transitionId: request.transitionId,
        transitionInventoryHash: request.transitionInventoryHash,
        schemaBundleHash: request.schemaBundleHash,
        finalizationReceiptHash: request.finalizationReceiptHash,
        postInventoryHash: request.postInventoryHash,
        postPristineRuntimeStateHash: request.postPristineRuntimeStateHash,
        transitionState: 'finalized',
        globalSequence: 1,
        globalHash: H('final-global'),
        observedAt,
        expiresAt: new Date(Date.parse(observedAt) + 60000).toISOString(),
        signature: 'test-signature',
      });
      assert.equal(verifyAutonomousResearchOnlineSchemaTransitionObservation({
        receipt, request, trust, now, verifySignature,
      }), true);
      return receipt;
    },
    verifyHistoricalObservation({ receipt, request }) {
      return verifyAutonomousResearchOnlineSchemaTransitionObservation({
        receipt, request, trust,
        now: new Date(receipt.observedAt), verifySignature,
      });
    },
  });
  return Object.freeze({ client, calls });
}

function transitionInput(setup, clock, authority) {
  return Object.freeze({
    runtimeRoot: setup.runtimeRoot,
    stateDatabaseManifest,
    writerManifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    authorityProcessConfigurationPath: '/pinned/test-authority-process.json',
    clock,
    createAuthorityClient: () => authority.client,
  });
}

function mutated(value, mutate) {
  const candidate = structuredClone(value);
  mutate(candidate);
  return candidate;
}

function assertSchemaTransitionContractsFailClosed({ audit, trust, now }) {
  const invalidTrust = [
    ['version', (value) => { value.version = 2; }],
    ['kind', (value) => { value.kind = 'WrongTrust'; }],
    ['authority id', (value) => { value.authorityId = 'x'; }],
    ['authority id missing', (value) => { value.authorityId = null; }],
    ['key id', (value) => { value.keyId = 'x'; }],
    ['key id missing', (value) => { value.keyId = null; }],
    ['scope id', (value) => { value.scopeId = 'x'; }],
    ['scope id missing', (value) => { value.scopeId = null; }],
    ['database scope hash', (value) => { value.databaseScopeHash = 'invalid'; }],
    ['database scope hash missing', (value) => { value.databaseScopeHash = null; }],
    ['writer manifest hash', (value) => { value.writerManifestHash = 'invalid'; }],
    ['writer manifest hash missing', (value) => { value.writerManifestHash = null; }],
    ['reservation lease type', (value) => { value.maximumReservationLeaseMs = 1.5; }],
    ['reservation lease floor', (value) => { value.maximumReservationLeaseMs = 999; }],
    ['observation age type', (value) => { value.maximumObservationAgeMs = 1.5; }],
    ['observation age floor', (value) => { value.maximumObservationAgeMs = 999; }],
  ];
  for (const [name, mutate] of invalidTrust) {
    assert.throws(() => assertAutonomousResearchOnlineSchemaTransitionReserveRequest(
      audit.reserveRequest,
      { trust: mutated(trust, mutate) },
    ), /authority_trust_invalid/, name);
  }

  const invalidReserveRequests = [
    ['keys', (value) => { value.unexpected = true; }],
    ['version', (value) => { value.version = 2; }],
    ['kind', (value) => { value.kind = 'WrongReserveRequest'; }],
    ['protocol', (value) => { value.protocol = 'wrong'; }],
    ['scope', (value) => { value.scopeId = 'wrong-scope'; }],
    ['database scope', (value) => { value.databaseScopeHash = H('wrong-scope'); }],
    ['writer manifest', (value) => { value.writerManifestHash = H('wrong-writer'); }],
    ['state manifest', (value) => { value.stateDatabaseManifestHash = 'invalid'; }],
    ['inventory hash', (value) => { value.transitionInventoryHash = 'invalid'; }],
    ['schema bundle', (value) => { value.schemaBundleHash = 'invalid'; }],
    ['journal contract', (value) => { value.authorityJournalSchemaContractId = 'x'; }],
    ['journal schema', (value) => { value.authorityJournalSchemaHash = 'invalid'; }],
    ['marker schema', (value) => { value.markerSchemaHash = 'invalid'; }],
    ['transition id', (value) => { value.transitionId = 'invalid'; }],
    ['instances type', (value) => { value.instances = null; }],
    ['instances too short', (value) => { value.instances = value.instances.slice(0, -1); }],
    ['instance keys', (value) => { value.instances[0].unexpected = true; }],
    ['instance role', (value) => { value.instances[0].databaseRole = 'wrong-role'; }],
    ['instance id', (value) => { value.instances[0].databaseInstanceId = 'x'; }],
    ['duplicate instance id', (value) => {
      value.instances[1].databaseInstanceId = value.instances[0].databaseInstanceId;
    }],
    ['instance path', (value) => { value.instances[0].sourceRelativePath = '/absolute'; }],
    ['instance path backslash', (value) => {
      value.instances[0].sourceRelativePath = 'autonomous\\research\\state.sqlite';
    }],
    ['instance path dot segment', (value) => {
      value.instances[0].sourceRelativePath = 'autonomous-research/./state.sqlite';
    }],
    ['instance path parent segment', (value) => {
      value.instances[0].sourceRelativePath = 'autonomous-research/../state.sqlite';
    }],
    ['instance contract', (value) => { value.instances[0].schemaContractId = 'x'; }],
    ['instance contract missing', (value) => { value.instances[0].schemaContractId = null; }],
    ['instance pre-schema', (value) => { value.instances[0].preSchemaHash = 'invalid'; }],
    ['instance pre-schema missing', (value) => { value.instances[0].preSchemaHash = null; }],
    ['instance post-schema', (value) => {
      value.instances[0].expectedPostSchemaHash = 'invalid';
    }],
    ['instance post-schema missing', (value) => {
      value.instances[0].expectedPostSchemaHash = null;
    }],
    ['instance source hash', (value) => { value.instances[0].sourceSha256 = 'invalid'; }],
    ['instance source hash missing', (value) => { value.instances[0].sourceSha256 = null; }],
    ['instance identity', (value) => {
      value.instances[0].sourceFileIdentityHash = 'invalid';
    }],
    ['instance identity missing', (value) => {
      value.instances[0].sourceFileIdentityHash = null;
    }],
    ['instance journal preimage', (value) => {
      value.instances[0].journalPreimageHash = 'invalid';
    }],
    ['instance journal preimage missing', (value) => {
      value.instances[0].journalPreimageHash = null;
    }],
    ['instance normalized source', (value) => {
      value.instances[0].expectedNormalizedSourceSha256 = 'invalid';
    }],
    ['instance normalized source missing', (value) => {
      value.instances[0].expectedNormalizedSourceSha256 = null;
    }],
    ['instance pristine state', (value) => {
      value.instances[0].prePristineStateHash = 'invalid';
    }],
    ['instance pristine state missing', (value) => {
      value.instances[0].prePristineStateHash = null;
    }],
    ['instance ordering', (value) => {
      [value.instances[0], value.instances[1]] = [value.instances[1], value.instances[0]];
    }],
    ['role closure', (value) => {
      value.instances[0].databaseRole = value.instances[1].databaseRole;
    }],
    ['requested at', (value) => { value.requestedAt = 'invalid'; }],
    ['requested at missing', (value) => { value.requestedAt = null; }],
    ['lease integer', (value) => { value.requestedLeaseMs = 1.5; }],
    ['lease floor', (value) => { value.requestedLeaseMs = 999; }],
    ['lease ceiling', (value) => {
      value.requestedLeaseMs = trust.maximumReservationLeaseMs + 1;
    }],
    ['window integer', (value) => { value.requiredExecutionWindowMs = 1.5; }],
    ['window floor', (value) => { value.requiredExecutionWindowMs = 999; }],
    ['window ceiling', (value) => {
      value.requiredExecutionWindowMs = value.requestedLeaseMs + 1;
    }],
  ];
  for (const [name, mutate] of invalidReserveRequests) {
    assert.throws(() => assertAutonomousResearchOnlineSchemaTransitionReserveRequest(
      mutated(audit.reserveRequest, mutate),
      { trust },
    ), /reserve_request_invalid/, name);
  }

  const invalidReservations = [
    ['keys', (value) => { value.unexpected = true; }],
    ['version', (value) => { value.version = 2; }],
    ['kind', (value) => { value.kind = 'WrongReservation'; }],
    ['status', (value) => { value.status = 'wrong'; }],
    ['reservation id', (value) => { value.reservationId = 'x'; }],
    ['request hash', (value) => { value.requestHash = H('wrong-request'); }],
    ['mirrored field', (value) => { value.schemaBundleHash = H('wrong-schema'); }],
    ['instances', (value) => { value.instances = []; }],
    ['genesis length', (value) => { value.databaseGenesis = []; }],
    ['genesis keys', (value) => { value.databaseGenesis[0].unexpected = true; }],
    ['genesis role', (value) => { value.databaseGenesis[0].databaseRole = 'wrong'; }],
    ['genesis instance', (value) => { value.databaseGenesis[0].databaseInstanceId = 'wrong'; }],
    ['genesis contract', (value) => { value.databaseGenesis[0].schemaContractId = 'wrong'; }],
    ['genesis schema', (value) => { value.databaseGenesis[0].schemaHash = H('wrong'); }],
    ['genesis global sequence', (value) => { value.databaseGenesis[0].globalSequence = 1; }],
    ['genesis global hash', (value) => { value.databaseGenesis[0].globalHash = 'invalid'; }],
    ['genesis database sequence', (value) => {
      value.databaseGenesis[0].databaseSequence = 1;
    }],
    ['genesis database hash', (value) => {
      value.databaseGenesis[0].databaseHash = 'invalid';
    }],
    ['genesis state hash', (value) => { value.databaseGenesis[0].stateHash = 'invalid'; }],
    ['fence', (value) => { value.allRegisteredMutationsFenced = false; }],
    ['quiescence', (value) => { value.quiescenceMode = 'wrong'; }],
    ['issued at', (value) => { value.issuedAt = 'invalid'; }],
    ['expires at', (value) => { value.expiresAt = 'invalid'; }],
    ['future issue', (value) => {
      value.issuedAt = new Date(now.getTime() + 6000).toISOString();
    }],
    ['expired', (value) => { value.expiresAt = now.toISOString(); }],
    ['nonpositive lifetime', (value) => { value.expiresAt = value.issuedAt; }],
    ['excess lifetime', (value) => {
      value.expiresAt = new Date(
        Date.parse(value.issuedAt) + audit.reserveRequest.requestedLeaseMs + 1,
      ).toISOString();
    }],
    ['authority', (value) => { value.authorityId = 'wrong-authority'; }],
    ['key', (value) => { value.keyId = 'wrong-key'; }],
  ];
  for (const [name, mutate] of invalidReservations) {
    assert.equal(verifyAutonomousResearchOnlineSchemaTransitionReservation({
      receipt: mutated(audit.reservation, mutate),
      request: audit.reserveRequest,
      trust,
      now,
      verifySignature: () => true,
    }), false, name);
  }
  assert.equal(verifyAutonomousResearchOnlineSchemaTransitionReservation({
    receipt: audit.reservation,
    request: audit.reserveRequest,
    trust,
    now,
    verifySignature: () => false,
  }), false, 'reservation signature');

  const invalidFinalizeRequests = [
    ['keys', (value) => { value.unexpected = true; }],
    ['version', (value) => { value.version = 2; }],
    ['kind', (value) => { value.kind = 'WrongFinalizeRequest'; }],
    ['protocol', (value) => { value.protocol = 'wrong'; }],
    ['scope', (value) => { value.scopeId = 'wrong'; }],
    ['database scope', (value) => { value.databaseScopeHash = H('wrong'); }],
    ['writer manifest', (value) => { value.writerManifestHash = H('wrong'); }],
    ['transition', (value) => { value.transitionId = H('wrong'); }],
    ['inventory', (value) => { value.transitionInventoryHash = H('wrong'); }],
    ['schema bundle', (value) => { value.schemaBundleHash = H('wrong'); }],
    ['reservation', (value) => { value.reservationId = 'wrong'; }],
    ['reservation hash', (value) => { value.reservationReceiptHash = H('wrong'); }],
    ['post inventory', (value) => { value.postInventoryHash = 'invalid'; }],
    ['installations length', (value) => { value.installations = []; }],
    ['installation keys', (value) => { value.installations[0].unexpected = true; }],
    ['installation role', (value) => { value.installations[0].databaseRole = 'wrong'; }],
    ['installation instance', (value) => {
      value.installations[0].databaseInstanceId = 'wrong';
    }],
    ['installation contract', (value) => {
      value.installations[0].schemaContractId = 'wrong';
    }],
    ['installation pre-schema', (value) => {
      value.installations[0].preSchemaHash = H('wrong');
    }],
    ['installation post-schema', (value) => {
      value.installations[0].postSchemaHash = H('wrong');
    }],
    ['installation hash', (value) => { value.installations[0].installationHash = H('wrong'); }],
    ['completed at', (value) => { value.completedAt = 'invalid'; }],
  ];
  for (const [name, mutate] of invalidFinalizeRequests) {
    assert.throws(() => assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest(
      mutated(audit.finalizeRequest, mutate),
      audit.reservation,
    ), /finalize_request_invalid/, name);
  }

  const invalidObserveRequests = [
    ['keys', (value) => { value.unexpected = true; }],
    ['version', (value) => { value.version = 2; }],
    ['kind', (value) => { value.kind = 'WrongObserveRequest'; }],
    ['protocol', (value) => { value.protocol = 'wrong'; }],
    ['scope', (value) => { value.scopeId = 'wrong'; }],
    ['database scope', (value) => { value.databaseScopeHash = H('wrong'); }],
    ['writer manifest', (value) => { value.writerManifestHash = H('wrong'); }],
    ['transition', (value) => { value.transitionId = 'invalid'; }],
    ['inventory', (value) => { value.transitionInventoryHash = 'invalid'; }],
    ['schema bundle', (value) => { value.schemaBundleHash = 'invalid'; }],
    ['finalization', (value) => { value.finalizationReceiptHash = 'invalid'; }],
    ['post inventory', (value) => { value.postInventoryHash = 'invalid'; }],
    ['nonce', (value) => { value.nonce = 'x'; }],
    ['requested at', (value) => { value.requestedAt = 'invalid'; }],
  ];
  for (const [name, mutate] of invalidObserveRequests) {
    assert.throws(() => assertAutonomousResearchOnlineSchemaTransitionObserveRequest(
      mutated(audit.observeRequest, mutate),
      { trust },
    ), /observe_request_invalid/, name);
  }
  assert.equal(verifyAutonomousResearchOnlineSchemaTransitionReservation({
    receipt: audit.reservation,
    request: audit.reserveRequest,
    trust,
    now: now.toISOString(),
    verifySignature: () => true,
  }), true);
  assert.throws(() => verifyAutonomousResearchOnlineSchemaTransitionReservation({
    receipt: audit.reservation,
    request: audit.reserveRequest,
    trust,
    now: 'invalid',
    verifySignature: () => true,
  }), /schema_transition_now_required/);
}

test('maintenance CLI defaults to plan and double-gates every execute path', (context) => {
  const setup = fixture(context);
  const authorityPath = path.join(setup.parent, 'authority-process.json');
  const parsed = parseAutonomousResearchOnlineSchemaTransitionArguments([
    '--runtime-root', setup.runtimeRoot,
    '--authority-process-config', authorityPath,
  ]);
  assert.equal(parsed.action, 'plan');
  assert.equal(parsed.execute, false);
  assert.throws(() => parseAutonomousResearchOnlineSchemaTransitionArguments([
    '--action', 'execute', '--authority-process-config', authorityPath,
    '--transition-id', H('cli-transition'),
  ]), /execute_confirmation_required/);
  assert.throws(() => parseAutonomousResearchOnlineSchemaTransitionArguments([
    '--action', 'plan', '--execute', '--authority-process-config', authorityPath,
  ]), /execute_action_required/);
  assert.throws(() => parseAutonomousResearchOnlineSchemaTransitionArguments([
    '--action', 'execute', '--execute', '--authority-process-config', authorityPath,
  ]), /transition_id_required/);

  const calls = [];
  const report = runAutonomousResearchOnlineSchemaTransition({
    argv: ['--runtime-root', setup.runtimeRoot, '--authority-process-config', authorityPath],
    root: repositoryRoot,
    composeService() {
      return Object.freeze({
        plan() { calls.push('plan'); return Object.freeze({ ready: true, mode: 'plan' }); },
        execute() { calls.push('execute'); return Object.freeze({ ready: true, mode: 'execute' }); },
      });
    },
  });
  assert.deepEqual(report, { ready: true, mode: 'plan' });
  assert.deepEqual(calls, ['plan']);

  const blocked = spawnSync(process.execPath, [
    'paper-core/bin/autonomous-research-online-schema-transition.mjs',
    '--action', 'execute', '--runtime-root', setup.runtimeRoot,
    '--authority-process-config', authorityPath,
    '--transition-id', H('cli-transition'),
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /execute_confirmation_required/);
  assert.equal(fs.existsSync(path.join(
    setup.runtimeRoot, 'autonomous-research', 'online-schema-transition',
  )), false);
});

test('schema transition plan simulates the complete closed inventory without writes', (context) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  const before = setup.databasePaths.map(fileSha256HashSync);
  const report = planAutonomousResearchOnlineSchemaTransition(
    transitionInput(setup, clock, authority),
  );
  assert.equal(report.status, 'autonomous_research_online_schema_transition_plan_ready');
  assert.equal(report.ready, true);
  assert.equal(report.plan.instances.length, stateDatabaseManifest.databases.length);
  assert.match(report.plan.transitionId, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(setup.databasePaths.map(fileSha256HashSync), before);
  assert.deepEqual(authority.calls, { reserve: 0, finalize: 0, observe: 0 });
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(setup.runtimeRoot, {
    create: false,
  });
  assert.equal(fs.existsSync(paths.controlRoot), false);
});

test('temporary-copy projections leave live main, WAL, and SHM unchanged under runtime TMPDIR', (
  context,
) => {
  const setup = fixture(context);
  const handoffIndex = stateDatabaseManifest.databases.findIndex((entry) => (
    entry.role === 'submission-handoff'
  ));
  const databasePath = setup.databasePaths[handoffIndex];
  fs.chmodSync(databasePath, 0o660);
  const live = new DatabaseSync(databasePath);
  const temporaryRoot = path.join(setup.runtimeRoot, 'transition-temporary');
  fs.mkdirSync(temporaryRoot, { mode: 0o700 });
  const previousTmpdir = process.env.TMPDIR;
  try {
    live.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    live.prepare("UPDATE fixture_anchor SET value='wal-live' WHERE id='fixture';").run();
    assert.equal(fs.existsSync(`${databasePath}-wal`), true);
    assert.equal(fs.existsSync(`${databasePath}-shm`), true);
    fs.chmodSync(`${databasePath}-wal`, 0o660);
    fs.chmodSync(`${databasePath}-shm`, 0o660);
    const clock = controlledClock();
    const authority = createAuthority(setup.runtimeRoot);
    const warmed = planAutonomousResearchOnlineSchemaTransition(
      transitionInput(setup, clock, authority),
    );
    assert.equal(warmed.ready, true);
    const before = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
      .map(exactFileSnapshot);
    process.env.TMPDIR = temporaryRoot;
    const report = planAutonomousResearchOnlineSchemaTransition(
      transitionInput(setup, clock, authority),
    );
    assert.equal(report.ready, true);
    assert.deepEqual(
      [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(exactFileSnapshot),
      before,
    );
    assert.deepEqual(fs.readdirSync(temporaryRoot), []);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    live.close();
  }
});

test('journal normalization facade requires a current signed quiescence reservation', (context) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  const input = transitionInput(setup, clock, authority);
  const planned = planAutonomousResearchOnlineSchemaTransition(input);
  const reserveRequest = buildAutonomousResearchOnlineSchemaTransitionReserveRequest(
    planned.plan,
    clock.now().toISOString(),
  );
  const reservation = authority.client.reserveSchemaTransition({
    request: reserveRequest,
    now: clock.now(),
  });
  const currentInventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const before = setup.databasePaths.map(fileSha256HashSync);
  assert.throws(() => (
    executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({
      runtimeRoot: setup.runtimeRoot,
      currentInventory,
      plan: planned.plan,
      reserveRequest,
      reservation,
      authorityClient: Object.freeze({
        ...authority.client,
        verifyStoredReservation: () => false,
      }),
      clock,
    })
  ), /quiescence_capability_invalid/);
  assert.deepEqual(setup.databasePaths.map(fileSha256HashSync), before);
  clock.advance(120001);
  assert.throws(() => (
    executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({
      runtimeRoot: setup.runtimeRoot,
      currentInventory,
      plan: planned.plan,
      reserveRequest,
      reservation,
      authorityClient: authority.client,
      clock,
    })
  ), /quiescence_capability_invalid/);
  assert.deepEqual(setup.databasePaths.map(fileSha256HashSync), before);

  const alwaysTrueAuthority = Object.freeze({
    ...authority.client,
    verifyStoredReservation: () => true,
  });
  const structuralClock = Object.freeze({
    now: () => new Date(reservation.issuedAt),
  });
  for (const [label, changes] of [
    ['unfenced', { reservation: { ...reservation, allRegisteredMutationsFenced: false } }],
    ['wrong-mode', { reservation: { ...reservation, quiescenceMode: 'wrong' } }],
    ['missing-role', { plan: { ...planned.plan, instances: planned.plan.instances.slice(1) } }],
    ['mirrored-hash', {
      plan: { ...planned.plan, transitionInventoryHash: H('wrong-transition-inventory') },
    }],
    ['inventory-scope', {
      currentInventory: { ...currentInventory, databaseScopeHash: H('wrong-scope') },
    }],
  ]) {
    assert.throws(() => (
      executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({
        runtimeRoot: setup.runtimeRoot,
        currentInventory: changes.currentInventory || currentInventory,
        plan: changes.plan || planned.plan,
        reserveRequest,
        reservation: changes.reservation || reservation,
        authorityClient: alwaysTrueAuthority,
        clock: structuralClock,
      })
    ), /quiescence_capability_invalid/, label);
  }
  assert.deepEqual(setup.databasePaths.map(fileSha256HashSync), before);

  const fakeRuntimeRoot = path.join(setup.parent, 'fake-runtime');
  fs.cpSync(setup.runtimeRoot, fakeRuntimeRoot, { recursive: true });
  fs.chmodSync(fakeRuntimeRoot, 0o700);
  const fakeInventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: fakeRuntimeRoot,
    manifest: stateDatabaseManifest,
  });
  const fakePaths = fakeInventory.instances.map((instance) => (
    path.join(fakeRuntimeRoot, instance.sourceRelativePath)
  ));
  const fakeBefore = fakePaths.map(fileSha256HashSync);
  assert.throws(() => (
    executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({
      runtimeRoot: fakeRuntimeRoot,
      currentInventory: fakeInventory,
      plan: planned.plan,
      reserveRequest,
      reservation,
      authorityClient: alwaysTrueAuthority,
      clock: structuralClock,
    })
  ), /quiescence_capability_invalid/);
  assert.deepEqual(fakePaths.map(fileSha256HashSync), fakeBefore);

  const replaced = setup.databasePaths[0];
  const original = `${replaced}.original`;
  const replacement = `${replaced}.replacement`;
  fs.copyFileSync(replaced, replacement, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(replacement, 0o600);
  fs.renameSync(replaced, original);
  fs.renameSync(replacement, replaced);
  try {
    assert.throws(() => (
      executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({
        runtimeRoot: setup.runtimeRoot,
        currentInventory,
        plan: planned.plan,
        reserveRequest,
        reservation,
        authorityClient: alwaysTrueAuthority,
        clock: structuralClock,
      })
    ), /quiescence_capability_invalid/);
  } finally {
    fs.rmSync(replaced, { force: true });
    fs.renameSync(original, replaced);
  }

});

test('journal normalization cleans a safe lone SHM when source is already normalized', (
  context,
) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  const baselineInventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const targetInstance = baselineInventory.instances[0];
  const candidate = path.resolve(setup.runtimeRoot, targetInstance.sourceRelativePath);
  fs.writeFileSync(`${candidate}-shm`, Buffer.alloc(0), { mode: 0o600 });
  const planned = planAutonomousResearchOnlineSchemaTransition(
    transitionInput(setup, clock, authority),
  );
  const planInstance = planned.plan.instances.find((entry) => (
    entry.databaseInstanceId === targetInstance.instanceId
  ));
  assert.equal(planInstance.sourceSha256, planInstance.expectedNormalizedSourceSha256);
  assert.equal(fs.existsSync(`${candidate}-shm`), true);
  const reserveRequest = buildAutonomousResearchOnlineSchemaTransitionReserveRequest(
    planned.plan,
    clock.now().toISOString(),
  );
  const reservation = authority.client.reserveSchemaTransition({
    request: reserveRequest,
    now: clock.now(),
  });
  const currentInventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.equal(fs.existsSync(`${candidate}-shm`), true);
  const records = executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({
    runtimeRoot: setup.runtimeRoot,
    currentInventory,
    plan: planned.plan,
    reserveRequest,
    reservation,
    authorityClient: authority.client,
    clock,
  });
  const record = records.find((entry) => entry.databaseInstanceId === targetInstance.instanceId);
  assert.equal(record.normalizedSha256, planInstance.expectedNormalizedSourceSha256);
  assert.equal(Object.hasOwn(record, 'alreadyNormalized'), false);
  assert.equal(fs.existsSync(`${candidate}-wal`), false);
  assert.equal(fs.existsSync(`${candidate}-shm`), false);
});

test('journal preimages reject unsafe SHM aliases and permissions', (context) => {
  const setup = fixture(context);
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const instance = inventory.instances[0];
  const candidate = path.resolve(setup.runtimeRoot, instance.sourceRelativePath);
  const shmPath = `${candidate}-shm`;
  fs.symlinkSync(candidate, shmPath);
  assert.throws(() => schemaTransitionJournalPreimageHash(candidate, {
    databaseRole: instance.role,
  }), /unsafe_shm/);
  fs.rmSync(shmPath);
  fs.writeFileSync(shmPath, Buffer.alloc(0), { mode: 0o666 });
  fs.chmodSync(shmPath, 0o666);
  assert.throws(() => schemaTransitionJournalPreimageHash(candidate, {
    databaseRole: instance.role,
  }), /unsafe_shm/);
  fs.rmSync(shmPath);
  const witness = `${shmPath}.hardlink`;
  fs.writeFileSync(shmPath, Buffer.alloc(0), { mode: 0o600 });
  fs.linkSync(shmPath, witness);
  assert.throws(() => schemaTransitionJournalPreimageHash(candidate, {
    databaseRole: instance.role,
  }), /unsafe_shm/);
  fs.rmSync(shmPath);
  fs.rmSync(witness);
});

test('schema transition helper boundaries fail closed and preserve projections', (context) => {
  const setup = fixture(context);
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const instance = inventory.instances.find((entry) => entry.role === 'resident-instance')
    || inventory.instances[0];
  const candidate = path.resolve(setup.runtimeRoot, instance.sourceRelativePath);

  assert.equal(schemaTransitionNow({ now: () => '2026-07-19T04:00:00.000Z' }).toISOString(),
    '2026-07-19T04:00:00.000Z');
  assert.throws(() => schemaTransitionNow({ now: () => 'not-a-date' }), /clock_invalid/);
  const identity = schemaTransitionFileIdentity(candidate, { databaseRole: instance.role });
  assert.deepEqual(schemaTransitionStableFileIdentity(identity), {
    device: identity.device,
    inode: identity.inode,
    mode: identity.mode,
    links: identity.links,
  });
  assert.equal(schemaTransitionSameIdentity(identity, { ...identity }), true);
  assert.equal(schemaTransitionSameIdentity(identity, { ...identity, inode: 'changed' }), false);
  assert.equal(schemaTransitionDatabasePath(setup.runtimeRoot, instance), candidate);
  for (const bad of [
    {},
    { ...instance, sourceRelativePath: '../outside.sqlite' },
    { ...instance, sourceRelativePath: 'missing.sqlite' },
  ]) {
    assert.throws(() => schemaTransitionDatabasePath(setup.runtimeRoot, bad), /database_path_invalid/);
  }

  const unsafe = path.join(setup.parent, 'unsafe.sqlite');
  fs.writeFileSync(unsafe, 'unsafe', { mode: 0o600 });
  fs.chmodSync(unsafe, 0o602);
  assert.throws(() => schemaTransitionFileIdentity(unsafe), /database_unsafe/);
  fs.chmodSync(unsafe, 0o600);
  const link = path.join(setup.parent, 'unsafe-link.sqlite');
  fs.symlinkSync(unsafe, link);
  assert.throws(() => schemaTransitionFileIdentity(link), /database_unsafe/);
  fs.rmSync(link);

  const walPath = `${candidate}-wal`;
  const shmPath = `${candidate}-shm`;
  fs.writeFileSync(walPath, Buffer.from('wal'), { mode: 0o600 });
  fs.writeFileSync(shmPath, Buffer.from('shm'), { mode: 0o600 });
  assert.throws(() => assertSchemaTransitionNoSidecars(candidate), /wal_or_shm_present/);
  fs.rmSync(walPath);
  fs.rmSync(shmPath);
  assert.doesNotThrow(() => assertSchemaTransitionNoSidecars(candidate));
  assert.equal(schemaTransitionNormalizedProjectionMatches(candidate, 'invalid'), false);

  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE fixture_anchor(id TEXT PRIMARY KEY,value TEXT NOT NULL);');
    const target = schemaTransitionTargetSchema({ role: 'external-qualification' });
    database.exec('BEGIN IMMEDIATE;');
    applySchemaTransitionStatements(database, target);
    database.exec('COMMIT;');
    assert.doesNotThrow(() => assertSchemaTransitionTargetObjects(database, target));
    const conflicting = [...target.objects.entries()].find(([, row]) => row.type === 'table')[0];
    database.exec(`DROP TABLE "${conflicting.replaceAll('"', '""')}";`);
    database.exec(`CREATE TABLE "${conflicting.replaceAll('"', '""')}"(wrong TEXT);`);
    assert.throws(() => assertSchemaTransitionTargetObjects(database, target), /target_schema_conflict/);
  } finally {
    database.close();
  }
  assert.doesNotThrow(() => validateAutonomousResearchOnlineSchemaTransitionInventory({
    runtimeRoot: setup.runtimeRoot,
    inventory,
    stateDatabaseManifest,
  }));
});

test('journal normalization rechecks the lease between durable WAL databases', async (context) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  const baselineInventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const walDatabasePaths = baselineInventory.instances.slice(0, 2).map((instance) => (
    path.resolve(setup.runtimeRoot, instance.sourceRelativePath)
  ));
  const holder = await startWalHolder(walDatabasePaths);
  context.after(() => stopWalHolder(holder));
  planAutonomousResearchOnlineSchemaTransition(transitionInput(setup, clock, authority));
  const currentInventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const planned = planAutonomousResearchOnlineSchemaTransition(
    transitionInput(setup, clock, authority),
  );
  const reserveRequest = buildAutonomousResearchOnlineSchemaTransitionReserveRequest(
    planned.plan,
    clock.now().toISOString(),
  );
  const reservation = authority.client.reserveSchemaTransition({
    request: reserveRequest,
    now: clock.now(),
  });
  const walEntries = walDatabasePaths.map((candidate) => planned.plan.instances.find((entry) => (
    path.resolve(setup.runtimeRoot, entry.sourceRelativePath) === candidate
  )));
  assert.equal(walEntries.every(Boolean), true);
  assert.equal(walEntries.every((entry) => (
    entry.sourceSha256 !== entry.expectedNormalizedSourceSha256
  )), true);
  const before = walDatabasePaths.map((candidate) => Object.freeze({
    main: exactFileSnapshot(candidate),
    wal: exactFileSnapshot(`${candidate}-wal`),
    shm: exactFileSnapshot(`${candidate}-shm`),
  }));
  assert.equal(before.every((entry) => (
    entry.wal.presence === 'present' && Number(entry.wal.bytes) > 32
      && entry.shm.presence === 'present'
  )), true);
  await stopWalHolder(holder);
  assert.deepEqual(walDatabasePaths.map((candidate) => Object.freeze({
    main: exactFileSnapshot(candidate),
    wal: exactFileSnapshot(`${candidate}-wal`),
    shm: exactFileSnapshot(`${candidate}-shm`),
  })), before);
  for (const [index, candidate] of walDatabasePaths.entries()) {
    assert.equal(
      schemaTransitionJournalPreimageHash(candidate),
      walEntries[index].journalPreimageHash,
    );
  }

  let tick = 0;
  const tickingClock = Object.freeze({
    now() {
      tick += 1;
      return new Date(Date.parse(reservation.issuedAt) + (tick <= 4 ? 0 : 100001));
    },
  });
  assert.throws(() => executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({
    runtimeRoot: setup.runtimeRoot,
    currentInventory,
    plan: planned.plan,
    reserveRequest,
    reservation,
    authorityClient: Object.freeze({
      ...authority.client,
      verifyStoredReservation: () => true,
    }),
    clock: tickingClock,
  }), /quiescence_lease_insufficient/);
  assert.equal(tick >= 5, true);
  assert.equal(fileSha256HashSync(walDatabasePaths[0]),
    walEntries[0].expectedNormalizedSourceSha256);
  assert.notEqual(fileSha256HashSync(walDatabasePaths[0]), before[0].main.sha256);
  assert.equal(fs.existsSync(`${walDatabasePaths[0]}-wal`), false);
  assert.equal(fs.existsSync(`${walDatabasePaths[0]}-shm`), false);
  assert.deepEqual(Object.freeze({
    main: exactFileSnapshot(walDatabasePaths[1]),
    wal: exactFileSnapshot(`${walDatabasePaths[1]}-wal`),
    shm: exactFileSnapshot(`${walDatabasePaths[1]}-shm`),
  }), before[1]);
  const resumed = executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({
    runtimeRoot: setup.runtimeRoot,
    currentInventory,
    plan: planned.plan,
    reserveRequest,
    reservation,
    authorityClient: authority.client,
    clock,
  });
  assert.equal(resumed.length, planned.plan.instances.length);
  const plannedById = new Map(planned.plan.instances.map((entry) => [
    entry.databaseInstanceId,
    entry,
  ]));
  assert.equal(resumed.every((record) => (
    record.normalizedSha256
      === plannedById.get(record.databaseInstanceId)?.expectedNormalizedSourceSha256
  )), true);
  assert.equal(resumed[0].alreadyNormalized, true);
  assert.equal(fileSha256HashSync(walDatabasePaths[1]),
    walEntries[1].expectedNormalizedSourceSha256);
  assert.notEqual(fileSha256HashSync(walDatabasePaths[1]), before[1].main.sha256);
  assert.equal(fs.existsSync(`${walDatabasePaths[1]}-wal`), false);
  assert.equal(fs.existsSync(`${walDatabasePaths[1]}-shm`), false);
  assert.equal(planned.plan.instances.every((entry) => {
    const candidate = path.resolve(setup.runtimeRoot, entry.sourceRelativePath);
    return !fs.existsSync(`${candidate}-wal`) && !fs.existsSync(`${candidate}-shm`);
  }), true);
});

test('execute resumes a checkpoint-only journal crash and rejects tampered recovery input', async (
  context,
) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  const input = transitionInput(setup, clock, authority);
  const baselineInventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const target = baselineInventory.instances[0];
  const candidate = path.resolve(setup.runtimeRoot, target.sourceRelativePath);
  const holder = await startWalHolder([candidate]);
  context.after(() => stopWalHolder(holder));

  assert.equal(fs.existsSync(`${candidate}-wal`), true);
  assert.equal(fs.existsSync(`${candidate}-shm`), true);
  await stopWalHolder(holder);
  const killedWalTriplet = [candidate, `${candidate}-wal`, `${candidate}-shm`]
    .map(exactFileSnapshot);
  const planned = planAutonomousResearchOnlineSchemaTransition(input);
  assert.deepEqual(
    [candidate, `${candidate}-wal`, `${candidate}-shm`].map(exactFileSnapshot),
    killedWalTriplet,
  );
  const planInstance = planned.plan.instances.find((entry) => (
    entry.databaseInstanceId === target.instanceId
  ));
  assert.ok(planInstance);
  assert.notEqual(planInstance.sourceSha256, planInstance.expectedNormalizedSourceSha256);
  assert.equal(
    schemaTransitionJournalPreimageHash(candidate),
    planInstance.journalPreimageHash,
  );

  let checkpointFaultObserved = false;
  assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: planned.plan.transitionId,
    faultInjector(event) {
      if (event.point === 'after_journal_checkpoint'
        && event.databaseInstanceId === planInstance.databaseInstanceId) {
        checkpointFaultObserved = true;
        throw new Error('fixture_after_journal_checkpoint_crash');
      }
    },
  }), /fixture_after_journal_checkpoint_crash/);
  assert.equal(checkpointFaultObserved, true);

  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(setup.runtimeRoot, {
    create: false,
  });
  const interrupted = readAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath);
  assert.equal(interrupted.phase, 'reserved');
  assert.equal(interrupted.reservation.reservationId, 'schema-transition-reservation-1');
  const intermediate = [candidate, `${candidate}-wal`, `${candidate}-shm`]
    .map(exactFileSnapshot);
  assert.notEqual(intermediate[0].sha256, planInstance.sourceSha256);
  assert.notEqual(intermediate[0].sha256, planInstance.expectedNormalizedSourceSha256);
  assert.equal(intermediate[1].presence, 'absent');
  assert.equal(intermediate[2].presence, 'absent');

  const checkpointOnlyBytes = fs.readFileSync(candidate);
  const tamperedBytes = Buffer.from(checkpointOnlyBytes);
  tamperedBytes[tamperedBytes.length - 1] ^= 0xff;
  fs.writeFileSync(candidate, tamperedBytes);
  const tampered = [candidate, `${candidate}-wal`, `${candidate}-shm`]
    .map(exactFileSnapshot);
  assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: planned.plan.transitionId,
  }), /schema_transition/);
  assert.deepEqual(
    [candidate, `${candidate}-wal`, `${candidate}-shm`].map(exactFileSnapshot),
    tampered,
  );

  fs.writeFileSync(candidate, checkpointOnlyBytes);
  assert.equal(fileSha256HashSync(candidate), intermediate[0].sha256);
  const resumed = executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: planned.plan.transitionId,
  });
  assert.equal(resumed.status, 'autonomous_research_online_schema_transition_ready');
  const installedTarget = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  }).instances.find((entry) => entry.instanceId === target.instanceId);
  assert.equal(installedTarget.schemaHash, planInstance.expectedPostSchemaHash);
  assert.equal(fs.existsSync(`${candidate}-wal`), false);
  assert.equal(fs.existsSync(`${candidate}-shm`), false);
  assert.deepEqual(authority.calls, { reserve: 1, finalize: 1, observe: 1 });
});

test('execute installs all schemas and emits a live-verifiable audit receipt', (context) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  const input = transitionInput(setup, clock, authority);
  const planned = planAutonomousResearchOnlineSchemaTransition(input);
  assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: H('wrong-transition'),
  }), /expected_transition_id_mismatch/);
  assert.equal(fs.existsSync(path.join(
    setup.runtimeRoot, 'autonomous-research', 'online-schema-transition',
  )), false);
  const report = executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: planned.plan.transitionId,
  });
  assert.equal(report.status, 'autonomous_research_online_schema_transition_ready');
  assert.equal(report.installedDatabaseCount, stateDatabaseManifest.databases.length);
  assert.equal(report.receipt.transitionId, planned.plan.transitionId);
  assert.match(report.receipt.schemaTransitionReceiptHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(authority.calls, { reserve: 1, finalize: 1, observe: 1 });
  assertSchemaTransitionContractsFailClosed({
    audit: report.receipt,
    trust: authority.client.trust,
    now: clock.now(),
  });

  const rebindProtocol = 'external-authority-pristine-finalized-schema-rebind-v2';
  const rebindSourceWriterManifestHash = H('rebind-source-writer-manifest');
  const rebindPrePristineRuntimeStateHash = H('rebind-pre-pristine-runtime-state');
  const rebindRequest = structuredClone(report.receipt.reserveRequest);
  rebindRequest.version = 2;
  rebindRequest.protocol = rebindProtocol;
  rebindRequest.transitionMode = 'pristine-finalized-writer-manifest-rebind';
  rebindRequest.sourceWriterManifestHash = rebindSourceWriterManifestHash;
  rebindRequest.prePristineRuntimeStateHash = rebindPrePristineRuntimeStateHash;
  rebindRequest.transitionInventoryHash = hashRecord(
    'AutonomousResearchOnlineSchemaTransitionInventory',
    {
      stateDatabaseManifestHash: rebindRequest.stateDatabaseManifestHash,
      databaseScopeHash: rebindRequest.databaseScopeHash,
      instances: rebindRequest.instances,
    },
  );
  const rebindIdentity = {
    scopeId: rebindRequest.scopeId,
    databaseScopeHash: rebindRequest.databaseScopeHash,
    writerManifestHash: rebindRequest.writerManifestHash,
    stateDatabaseManifestHash: rebindRequest.stateDatabaseManifestHash,
    schemaBundleHash: rebindRequest.schemaBundleHash,
    instances: rebindRequest.instances.map((entry) => ({
      databaseRole: entry.databaseRole,
      databaseInstanceId: entry.databaseInstanceId,
      sourceRelativePath: entry.sourceRelativePath,
      preSchemaContractId: entry.preSchemaContractId,
      schemaContractId: entry.schemaContractId,
      prePristineStateHash: entry.prePristineStateHash,
      expectedPostSchemaHash: entry.expectedPostSchemaHash,
    })),
    transitionMode: rebindRequest.transitionMode,
    sourceWriterManifestHash: rebindRequest.sourceWriterManifestHash,
    prePristineRuntimeStateHash: rebindRequest.prePristineRuntimeStateHash,
  };
  rebindRequest.transitionId = hashRecord(
    'AutonomousResearchOnlineSchemaTransitionIdentity', rebindIdentity,
  );
  assert.throws(() => buildAutonomousResearchPristineSchemaRebindGenesis({
    request: rebindRequest,
    previousGlobalHash: 'invalid',
    previousDatabaseHeads: [],
  }), /genesis_input_invalid/);
  const previousGlobalHash = H('rebind-previous-global');
  const previousDatabaseHeads = rebindRequest.instances.map((instance, index) => ({
    databaseRole: instance.databaseRole,
    databaseInstanceId: instance.databaseInstanceId,
    sequence: 0,
    hash: H(`rebind-previous-database:${index}`),
    schemaHash: instance.preSchemaHash,
    stateHash: H(`rebind-previous-state:${index}`),
  }));
  const databaseGenesis = buildAutonomousResearchPristineSchemaRebindGenesis({
    request: rebindRequest,
    previousGlobalHash,
    previousDatabaseHeads,
  });
  const rebindReservation = {
    ...structuredClone(report.receipt.reservation),
    version: 2,
    protocol: rebindProtocol,
    transitionMode: rebindRequest.transitionMode,
    sourceWriterManifestHash: rebindSourceWriterManifestHash,
    prePristineRuntimeStateHash: rebindPrePristineRuntimeStateHash,
    transitionId: rebindRequest.transitionId,
    transitionInventoryHash: rebindRequest.transitionInventoryHash,
    requestHash: hashRecord('AutonomousResearchOnlineSchemaTransitionReserveRequest',
      rebindRequest),
    databaseGenesis,
    previousGlobalSequence: 0,
    previousGlobalHash,
    previousDatabaseHeads,
    targetAuthorityConfigurationHash: H('rebind-target-authority-configuration'),
    authorityRestartRequired: true,
    quiescenceMode: 'pristine-scope-held-through-target-configuration-restart',
  };
  assert.equal(verifyAutonomousResearchOnlineSchemaTransitionReservation({
    receipt: rebindReservation,
    request: rebindRequest,
    trust: authority.client.trust,
    now: clock.now(),
    verifySignature: () => true,
  }), true);
  const rebindFinalizeRequest = {
    ...structuredClone(report.receipt.finalizeRequest),
    version: 2,
    protocol: rebindProtocol,
    transitionId: rebindRequest.transitionId,
    transitionInventoryHash: rebindRequest.transitionInventoryHash,
    reservationId: rebindReservation.reservationId,
    reservationReceiptHash: autonomousResearchOnlineSchemaTransitionReceiptHash(
      rebindReservation,
    ),
  };
  rebindFinalizeRequest.installations = rebindFinalizeRequest.installations.map((entry) => ({
    ...entry,
    installationHash: hashRecord('AutonomousResearchOnlineSchemaTransitionDatabaseInstallation', {
      transitionId: rebindReservation.transitionId,
      reservationReceiptHash: rebindFinalizeRequest.reservationReceiptHash,
      databaseRole: entry.databaseRole,
      databaseInstanceId: entry.databaseInstanceId,
      schemaContractId: entry.schemaContractId,
      preSchemaHash: entry.preSchemaHash,
      postSchemaHash: entry.postSchemaHash,
      prePristineStateHash: entry.prePristineStateHash,
      postPristineStateHash: entry.postPristineStateHash,
    }),
  }));
  const rebindFinalization = {
    ...structuredClone(report.receipt.finalization),
    version: 2,
    protocol: rebindProtocol,
    transitionId: rebindRequest.transitionId,
    transitionInventoryHash: rebindRequest.transitionInventoryHash,
    reservationId: rebindReservation.reservationId,
    reservationReceiptHash: rebindFinalizeRequest.reservationReceiptHash,
    installations: rebindFinalizeRequest.installations,
    requestHash: hashRecord(
      'AutonomousResearchOnlineSchemaTransitionFinalizeRequest', rebindFinalizeRequest,
    ),
    transitionMode: rebindRequest.transitionMode,
    sourceWriterManifestHash: rebindSourceWriterManifestHash,
    targetAuthorityConfigurationHash: rebindReservation.targetAuthorityConfigurationHash,
    authorityRestartRequired: true,
  };
  assert.equal(verifyAutonomousResearchOnlineSchemaTransitionFinalization({
    receipt: rebindFinalization,
    request: rebindFinalizeRequest,
    reservation: rebindReservation,
    trust: authority.client.trust,
    now: clock.now(),
    verifySignature: () => true,
  }), true);
  const rebindObserveRequest = {
    ...structuredClone(report.receipt.observeRequest),
    version: 2,
    protocol: rebindProtocol,
    transitionId: rebindRequest.transitionId,
    transitionInventoryHash: rebindRequest.transitionInventoryHash,
    transitionMode: rebindRequest.transitionMode,
    sourceWriterManifestHash: rebindSourceWriterManifestHash,
  };
  const rebindObservation = {
    ...structuredClone(report.receipt.observation),
    version: 2,
    protocol: rebindProtocol,
    transitionId: rebindRequest.transitionId,
    transitionInventoryHash: rebindRequest.transitionInventoryHash,
    requestHash: hashRecord(
      'AutonomousResearchOnlineSchemaTransitionObserveRequest', rebindObserveRequest,
    ),
    transitionMode: rebindRequest.transitionMode,
    sourceWriterManifestHash: rebindSourceWriterManifestHash,
    authorityConfigurationActivated: true,
  };
  assert.equal(verifyAutonomousResearchOnlineSchemaTransitionObservation({
    receipt: rebindObservation,
    request: rebindObserveRequest,
    trust: authority.client.trust,
    now: clock.now(),
    verifySignature: () => true,
  }), true);
  assert.match(autonomousResearchOnlineSchemaTransitionReceiptHash({}), /^sha256:/);

  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.equal(inventory.status, 'autonomous_research_state_database_inventory_ready');
  assert.deepEqual(inventory.blockers, []);

  const readiness = inspectAutonomousResearchOnlineSchemaTransitionReadiness(input);
  assert.equal(readiness.status, 'autonomous_research_online_schema_transition_ready');
  assert.equal(readiness.schemaTransitionReceiptHash, report.receipt.schemaTransitionReceiptHash);
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(setup.runtimeRoot, {
    create: false,
  });
  assert.deepEqual(readAutonomousResearchOnlineSchemaTransitionJson(paths.finalReceiptPath),
    report.receipt);
  writeAutonomousResearchOnlineSchemaTransitionJson(paths.finalReceiptPath, {
    ...report.receipt,
    schemaTransitionReceiptHash: H('tampered-receipt'),
  });
  assert.throws(
    () => inspectAutonomousResearchOnlineSchemaTransitionReadiness(input),
    /audit_receipt_invalid/,
  );
});
