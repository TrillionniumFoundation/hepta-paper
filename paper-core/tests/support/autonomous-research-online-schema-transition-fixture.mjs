import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS,
} from '../../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs';
import {
  assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest,
  assertAutonomousResearchOnlineSchemaTransitionObserveRequest,
  assertAutonomousResearchOnlineSchemaTransitionReserveRequest,
  verifyAutonomousResearchOnlineSchemaTransitionFinalization,
  verifyAutonomousResearchOnlineSchemaTransitionObservation,
  verifyAutonomousResearchOnlineSchemaTransitionReservation,
} from '../../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
export const stateDatabaseManifest = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot,
  'paper-core',
  'config',
  'autonomous-research-state-databases.v1.json',
), 'utf8'));
export const H = (label) => hashRecord('AutonomousResearchOnlineSchemaTransitionTest', { label });

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

export function fixture(context) {
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

export function controlledClock() {
  let current = new Date('2026-07-19T04:00:00.000Z');
  return Object.freeze({
    now: () => new Date(current),
    advance(milliseconds) { current = new Date(current.getTime() + milliseconds); },
  });
}

export function createAuthority(runtimeRoot) {
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

export function transitionInput(setup, clock, authority) {
  return Object.freeze({
    runtimeRoot: setup.runtimeRoot,
    stateDatabaseManifest,
    writerManifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    authorityProcessConfigurationPath: '/pinned/test-authority-process.json',
    clock,
    createAuthorityClient: () => authority.client,
  });
}
