import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createAutonomousSubmissionOutboxRepository,
} from '../../paper-adapters/automation/autonomous-submission-outbox-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
} from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {
  resolveAutonomousSubmissionHandoffStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  createExternallyFencedSqliteMutationTransaction,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_PLANS,
} from '../../paper-adapters/persistence/autonomous-submission-handoff-mutation-plan.mjs';
import {
  autonomousSubmissionHandoffDatabasePath,
  openAutonomousSubmissionHandoffStore,
  provisionAutonomousSubmissionHandoffStore,
} from '../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs';
import {
  issueAutonomousSubmissionHandoffWriter,
} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createSqliteReceiptLedger }
  from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createDefaultPaperStore }
  from '../../paper-adapters/persistence/store-provider.mjs';
import {
  createAutonomousSubmissionDispatchAuthority,
} from '../../paper-composition/automation/autonomous-submission-dispatch-authority-composition.mjs';
import {
  convergeAutonomousSubmissionHandoff,
} from '../../paper-composition/bootstrap/autonomous-submission-handoff-migration-composition.mjs';
import {
  bootstrapAutonomousSubmissionHandoffContext,
} from '../../paper-composition/bootstrap/autonomous-submission-handoff-context-bootstrap.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { fileSha256HashSync }
  from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildAutonomousLiveSubmissionAuthorizationSubject,
} from '../../paper-domain/submission/autonomous-live-submission-authorization-contract.mjs';

const NOW = new Date('2026-07-21T08:00:00.000Z');
const H = (label) => hashRecord('AutonomousSubmissionHandoffStorageTest', { label });
const WORKSPACE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function roots(t, label) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  fs.chmodSync(parent, 0o700);
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return Object.freeze({ parent, runtimeRoot, databasePath: path.join(runtimeRoot, 'hepta-paper.sqlite') });
}

function legacyEnvelope({ label, status = 'responded', valid = true }) {
  const nonce = H(`nonce:${label}`);
  const messageId = `autonomous-submission:${nonce}`;
  const paperId = `paper:${label}`;
  const requestHash = H(`request:${label}`);
  const portalHash = H(`portal:${label}`);
  const portalId = 'portal:test';
  const payload = valid ? {
    version: 1,
    kind: 'AutonomousSubmissionOutboxEnvelope',
    request: {
      paperId,
      requestHash,
      portalConfigurationHash: portalHash,
      idempotencyKey: nonce,
    },
    portalId,
    stateReceipt: { messageId, portalId },
  } : {};
  return Object.freeze({
    messageId,
    paperId,
    requestHash,
    portalHash,
    portalId,
    nonce,
    status,
    payload,
  });
}

function insertLegacy(store, row) {
  const values = [
    row.messageId, row.paperId, row.requestHash, row.portalId, row.portalHash,
    row.nonce, row.status, JSON.stringify(row.payload), NOW.toISOString(), NOW.toISOString(),
  ];
  const result = store.run(`INSERT INTO submission_outbox(
    message_id,paper_id,dispatch_hash,provider,account_id,nonce,status,payload_json,
    created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`, values);
  assert.equal(result.ok, true, result.error);
}

function migrateLegacyFixture(fixture, rows) {
  const legacy = createDefaultPaperStore({
    root: fixture.parent,
    dbPath: fixture.databasePath,
    targetVersion: 23,
  });
  for (const row of rows) insertLegacy(legacy, row);
  legacy.checkpoint({ mode: 'TRUNCATE' });
  legacy.close();
  return createDefaultPaperStore({
    root: fixture.parent,
    dbPath: fixture.databasePath,
    targetVersion: 25,
  });
}

function requestVerifier() {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionRequestVerifier',
    verify(request) {
      const { requestHash, ...payload } = request || {};
      return requestHash === hashRecord('AutonomousSubmissionRequest', payload);
    },
    verifyHumanAuthorization() { return true; },
  });
}

function request(label) {
  const bindings = {
    immutableCampaignPackageOutputHash: H(`package:${label}`),
    venueId: 'venue:autonomous',
    campaignReleaseBundleHash: H(`release:${label}`),
    venueProfileHash: H('venue-profile'),
    qualificationReceiptHash: H(`qualification:${label}`),
    submissionMetadataReceiptHash: H('metadata'),
    venueComplianceReceiptHash: H(`compliance:${label}`),
    researchClosureReceiptHash: H(`closure:${label}`),
    portalConfigurationHash: H('portal-configuration'),
  };
  const portal = Object.freeze({
    portalId: 'portal:test',
    portalDescriptorHash: H('portal-descriptor'),
    portalServiceIdentityHash: H('portal-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
  });
  const authorizationSubject = buildAutonomousLiveSubmissionAuthorizationSubject({
    campaignId: `campaign:${label}`,
    paperId: `paper:${label}`,
    immutableCampaignPackageOutputHash: bindings.immutableCampaignPackageOutputHash,
    campaignReleaseBundleHash: bindings.campaignReleaseBundleHash,
    qualificationReceiptHash: bindings.qualificationReceiptHash,
    researchClosureReceiptHash: bindings.researchClosureReceiptHash,
    venueComplianceReceiptHash: bindings.venueComplianceReceiptHash,
    submissionMetadataReceiptHash: bindings.submissionMetadataReceiptHash,
    venueProfileSelectionHash: H('venue-selection'),
    venueId: bindings.venueId,
    submissionPortalProfileId: 'autonomous-portal-v1',
    portalId: portal.portalId,
    portalConfigurationHash: bindings.portalConfigurationHash,
    portalDescriptorHash: portal.portalDescriptorHash,
    serviceIdentityHash: portal.portalServiceIdentityHash,
    portalAccountIdentityHash: portal.portalAccountIdentityHash,
    portalTrustDomainIdentityHash: portal.portalTrustDomainIdentityHash,
  });
  const authorizationDocument = {
    version: 1,
    kind: 'LiveSubmissionAuthorization',
    paperId: `paper:${label}`,
    taskKey: `campaign:${label}`,
    allowLiveExternalAction: true,
    environment: 'production',
    portalAction: 'submit_manuscript',
    singleUse: true,
    nonce: `handoff-human-permit-${label}`,
    provider: portal.portalId,
    accountId: portal.portalAccountIdentityHash,
    authorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    signedAt: '2026-07-21T07:59:00.000Z',
    validFrom: '2026-07-21T07:59:00.000Z',
    expiresAt: '2026-07-21T08:30:00.000Z',
    responseDueAt: '2026-07-21T08:20:00.000Z',
    signatures: [],
  };
  const signatureVerification = {
    status: 'authority_signatures_verified',
    cryptographicSignaturesVerified: true,
    requiredRoles: ['submission_operator', 'live_executor_authorizer'],
    requiredSignatureCount: 2,
    verifiedSignatures: [],
    verifiedRoles: ['live_executor_authorizer', 'submission_operator'],
    verifiedSubjectIds: ['handoff-executor', 'handoff-operator'],
    blockers: [],
  };
  const timeWindow = {
    valid: true,
    signedAt: authorizationDocument.signedAt,
    validFrom: authorizationDocument.validFrom,
    expiresAt: authorizationDocument.expiresAt,
    blockers: [],
  };
  const authorizationReport = {
    version: 2,
    kind: 'LiveSubmissionAuthorizationReceipt',
    authorizationMode: 'autonomous_submission_handoff',
    paperId: `paper:${label}`,
    taskKey: `campaign:${label}`,
    status: 'live_submission_authorization_verified',
    liveExternalActionAuthorized: true,
    cryptographicSignaturesVerified: true,
    authorizationPath: 'fixture/LIVE_SUBMISSION_AUTHORIZATION.json',
    authorizationSubject,
    authorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    authorizationDocument,
    authorizationDocumentHash: hashRecord(
      'LiveSubmissionAuthorizationDocument', authorizationDocument,
    ),
    provider: portal.portalId,
    accountId: portal.portalAccountIdentityHash,
    portalRoute: 'autonomous-portal-v1',
    portalAction: 'submit_manuscript',
    environment: 'production',
    nonce: authorizationDocument.nonce,
    singleUse: true,
    signedAt: authorizationDocument.signedAt,
    validFrom: authorizationDocument.validFrom,
    expiresAt: authorizationDocument.expiresAt,
    authorizerSubjectIds: signatureVerification.verifiedSubjectIds,
    signatureVerification,
    timeWindow,
    consumed: false,
    responseDueAt: authorizationDocument.responseDueAt,
    blockers: [],
    safety: {
      humanReviewRequired: true,
      dualControlRequired: true,
      singleUseAuthorization: true,
      authorizationLifetimeHoursMaximum: 24,
      separatedDutiesEnforced: true,
      grantsExecutionInsideOverlay: false,
      externalActionPerformed: false,
    },
  };
  const humanAuthorizationReceipt = {
    ...authorizationReport,
    liveSubmissionAuthorizationReceiptHash: hashRecord(
      'LiveSubmissionAuthorizationReceipt', authorizationReport,
    ),
  };
  Object.assign(bindings, {
    ...portal,
    humanAuthorizationReceiptHash:
      humanAuthorizationReceipt.liveSubmissionAuthorizationReceiptHash,
    humanAuthorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    humanAuthorizationNonce: humanAuthorizationReceipt.nonce,
    humanAuthorizationExpiresAt: humanAuthorizationReceipt.expiresAt,
  });
  const payload = {
    version: 7,
    kind: 'AutonomousSubmissionRequest',
    campaignId: `campaign:${label}`,
    paperId: `paper:${label}`,
    venueId: bindings.venueId,
    venueProfileHash: bindings.venueProfileHash,
    venueProfileSelectionHash: H('venue-selection'),
    submissionPortalProfileId: 'autonomous-portal-v1',
    campaignReleaseBundleHash: bindings.campaignReleaseBundleHash,
    immutableCampaignPackageOutputHash: bindings.immutableCampaignPackageOutputHash,
    sourceSnapshotHash: H(`source:${label}`),
    sourceTreeManifestHash: H(`tree:${label}`),
    researchEvidenceCapsuleManifestHash: H(`capsule:${label}`),
    researchClosureReceiptHash: bindings.researchClosureReceiptHash,
    qualificationReceiptHash: bindings.qualificationReceiptHash,
    venueComplianceReceiptHash: bindings.venueComplianceReceiptHash,
    submissionMetadataReceiptHash: bindings.submissionMetadataReceiptHash,
    renderedSourceHash: H(`rendered:${label}`),
    compiledPdfHash: H(`pdf:${label}`),
    independentRebuiltPdfHash: H(`independent-pdf:${label}`),
    pageCount: 8,
    portalConfigurationHash: bindings.portalConfigurationHash,
    ...portal,
    humanAuthorizationReceiptHash:
      humanAuthorizationReceipt.liveSubmissionAuthorizationReceiptHash,
    humanAuthorizationSubjectHash:
      authorizationSubject.liveSubmissionAuthorizationSubjectHash,
    humanAuthorizationNonce: humanAuthorizationReceipt.nonce,
    humanAuthorizationExpiresAt: humanAuthorizationReceipt.expiresAt,
    humanAuthorizationReceipt,
    idempotencyKey: hashRecord('AutonomousSubmissionIdempotencyKey', bindings),
    humanApprovalPerformed: true,
    requestedAt: NOW.toISOString(),
  };
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('AutonomousSubmissionRequest', payload),
  });
}

function testCoordinator() {
  let failAfterMutation = false;
  const coveredDatabaseRoles = Object.freeze(['submission-handoff']);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    setFailAfterMutation(value) { failAfterMutation = Boolean(value); },
    inspectStatus() {
      return Object.freeze({
        status: 'externally_fenced_sqlite_mutation_coordinator_ready',
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([]),
      });
    },
    recoverPendingMutations() { return Object.freeze([]); },
    executeMutation(input) {
      const plan = AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_PLANS[input.operationId];
      assert.ok(plan);
      input.database.exec('BEGIN IMMEDIATE;');
      let transaction;
      try {
        transaction = createExternallyFencedSqliteMutationTransaction(input.database, plan);
        const value = input.mutate(transaction.transaction);
        transaction.revoke();
        if (failAfterMutation) throw new Error('fixture_crash_after_candidate_write');
        input.database.exec('COMMIT;');
        return Object.freeze({
          status: 'externally_fenced_sqlite_mutation_finalized',
          value,
          sideEffectPermitHash: H(`permit:${input.operationId}`),
        });
      } catch (error) {
        transaction?.revoke?.();
        if (input.database.isTransaction) input.database.exec('ROLLBACK;');
        throw error;
      }
    },
  });
}

function configureHandoffMutationAuthority({ root, inventory }) {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(root, 'handoff-authority-public-key.json');
  const authorityConfigurationPath = path.join(root, 'handoff-authority.json');
  const commandPath = path.join(root, 'handoff-authority-broker.mjs');
  const processConfigurationPath = path.join(root, 'handoff-authority-process.json');
  fs.writeFileSync(publicKeyPath, JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityPublicKey',
    authorityId: 'authority:submission-handoff-test',
    keyId: 'key:submission-handoff-test',
    algorithm: 'ed25519',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  }), { mode: 0o600 });
  fs.writeFileSync(authorityConfigurationPath, JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityConfiguration',
    authorityId: 'authority:submission-handoff-test',
    keyId: 'key:submission-handoff-test',
    scopeId: 'scope:submission-handoff-test',
    databaseScopeHash: inventory.databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    ),
    publicKeyPath,
    publicKeySha256: fileSha256HashSync(publicKeyPath),
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  }), { mode: 0o600 });
  fs.writeFileSync(commandPath, '#!/usr/bin/env node\nprocess.exitCode = 70;\n', {
    mode: 0o700,
  });
  fs.writeFileSync(processConfigurationPath, JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',
    authorityConfigurationPath,
    authorityConfigurationSha256: fileSha256HashSync(authorityConfigurationPath),
    commandPath,
    commandSha256: fileSha256HashSync(commandPath),
    fixedArguments: [],
    timeoutMs: 10_000,
  }), { mode: 0o600 });
  return processConfigurationPath;
}

test('cutover is zero-copy, resumable, and permanently fences native autonomous rows', (t) => {
  const fixture = roots(t, 'hepta-handoff-cutover');
  const terminal = legacyEnvelope({ label: 'terminal' });
  const quarantined = legacyEnvelope({ label: 'ambiguous', valid: false });
  const nativeStore = migrateLegacyFixture(fixture, [terminal, quarantined]);
  t.after(() => nativeStore.close());
  const first = convergeAutonomousSubmissionHandoff({
    nativeStore,
    runtimeRoot: fixture.runtimeRoot,
    now: NOW,
  });
  const repeated = convergeAutonomousSubmissionHandoff({
    nativeStore,
    runtimeRoot: fixture.runtimeRoot,
    now: NOW,
  });
  assert.equal(first.ready, true);
  assert.equal(first.copiedRowCount, 0);
  assert.equal(first.dualWriteEnabled, false);
  assert.equal(first.legacyAutonomousRowCount, 1);
  assert.equal(first.legacyQuarantinedRowCount, 1);
  assert.equal(repeated.databaseProvisioned, false);
  assert.match(first.handoffInstanceNonce,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(repeated.handoffInstanceNonce, first.handoffInstanceNonce);
  const handoff = openAutonomousSubmissionHandoffStore({
    runtimeRoot: fixture.runtimeRoot,
    readOnly: true,
  });
  assert.equal(handoff.query('SELECT count(*) AS count FROM submission_outbox;').rows[0].count, 0);
  assert.equal(handoff.query('SELECT instance_nonce FROM handoff_instance;').rows[0]
    .instance_nonce, first.handoffInstanceNonce);
  handoff.close();
  for (const sql of [
    "UPDATE submission_outbox SET status='dead_letter' WHERE delivery_kind='autonomous'",
    "DELETE FROM submission_outbox WHERE delivery_kind='autonomous'",
  ]) {
    const result = nativeStore.execute(sql);
    assert.equal(result.ok, false);
    assert.match(result.error, /autonomous_submission_outbox_externalized/);
  }
});

test('nonterminal native autonomous rows block cutover before the handoff database exists', (t) => {
  const fixture = roots(t, 'hepta-handoff-drain');
  const nativeStore = migrateLegacyFixture(fixture, [legacyEnvelope({
    label: 'active',
    status: 'pending',
  })]);
  t.after(() => nativeStore.close());
  assert.throws(() => convergeAutonomousSubmissionHandoff({
    nativeStore,
    runtimeRoot: fixture.runtimeRoot,
    now: NOW,
  }), /cutover_drain_required/);
  assert.equal(fs.existsSync(autonomousSubmissionHandoffDatabasePath({
    runtimeRoot: fixture.runtimeRoot,
  })), false);
});

test('repository-owned store migrate closes the cold-start dependency and verifies both stores', (t) => {
  const fixture = roots(t, 'hepta-handoff-cold-start');
  const assetRoot = path.join(fixture.parent, 'assets');
  const legacyRoot = path.join(fixture.parent, 'legacy');
  fs.mkdirSync(assetRoot);
  fs.mkdirSync(legacyRoot);
  const environment = {
    ...process.env,
    HEPTA_PAPER_ASSET_ROOT: assetRoot,
    HEPTA_PAPER_RUNTIME_ROOT: fixture.runtimeRoot,
    PAPER_FACTORY_LEGACY_ROOT: legacyRoot,
  };
  const migrate = spawnSync(process.execPath, [
    'paper-core/bin/hepta-store.mjs', 'migrate',
  ], { cwd: WORKSPACE_ROOT, env: environment, encoding: 'utf8' });
  assert.equal(migrate.status, 0, migrate.stderr);
  const report = JSON.parse(migrate.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.schemaVersion, 25);
  assert.equal(report.autonomousSubmissionHandoff.ready, true);
  const status = spawnSync(process.execPath, [
    'paper-core/bin/hepta-store.mjs', 'status', '--require-trust-clean',
  ], { cwd: WORKSPACE_ROOT, env: environment, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).autonomousSubmissionHandoff.ready, true);
});

test('dispatcher opens from the scoped one-database inventory and dedicated authority only', (t) => {
  const fixture = roots(t, 'hepta-handoff-scoped-inventory');
  const nativeStore = createDefaultPaperStore({
    root: fixture.parent,
    dbPath: fixture.databasePath,
  });
  t.after(() => nativeStore.close());
  convergeAutonomousSubmissionHandoff({
    nativeStore,
    runtimeRoot: fixture.runtimeRoot,
    now: NOW,
  });
  const handoff = openAutonomousSubmissionHandoffStore({
    runtimeRoot: fixture.runtimeRoot,
  });
  for (const statement of AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS) {
    const result = handoff.execute(statement);
    assert.equal(result.ok, true, result.error);
  }
  handoff.checkpoint({ mode: 'TRUNCATE' });
  handoff.close();
  fs.writeFileSync(path.join(fixture.runtimeRoot, 'unrelated-native.sqlite'), 'not sqlite', {
    mode: 0o600,
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(
    WORKSPACE_ROOT,
    'paper-core',
    'config',
    'autonomous-research-state-databases.v1.json',
  ), 'utf8'));
  const inventory = resolveAutonomousSubmissionHandoffStateDatabaseInventory({
    runtimeRoot: fixture.runtimeRoot,
    manifest,
  });
  assert.equal(inventory.status, 'autonomous_research_state_database_inventory_ready',
    JSON.stringify(inventory.blockers));
  assert.equal(inventory.instances.length, 1);
  assert.equal(inventory.instances[0].role, 'submission-handoff');
  assert.doesNotMatch(JSON.stringify(inventory), /unrelated-native/);
  const processConfigurationPath = configureHandoffMutationAuthority({
    root: fixture.parent,
    inventory,
  });
  assert.throws(() => bootstrapAutonomousSubmissionHandoffContext({
    root: fixture.parent,
    runtimeRoot: fixture.runtimeRoot,
    environment: {
      HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG:
        processConfigurationPath,
    },
  }), /autonomous_submission_handoff_external_mutation_coordinator_required/);
  const context = bootstrapAutonomousSubmissionHandoffContext({
    root: fixture.parent,
    runtimeRoot: fixture.runtimeRoot,
    environment: {
      HEPTA_AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_AUTHORITY_PROCESS_CONFIG:
        processConfigurationPath,
    },
  });
  assert.equal(context.kind, 'AutonomousSubmissionHandoffContext');
  assert.equal(context.services.autonomousSubmissionOutbox.externallyFencedMutations, true);
  context.services.persistenceSession.close();

  const localContext = bootstrapAutonomousSubmissionHandoffContext({
    root: fixture.parent,
    runtimeRoot: fixture.runtimeRoot,
    environment: {},
    requireExternallyFenced: false,
  });
  assert.equal(localContext.kind, 'AutonomousSubmissionHandoffContext');
  assert.equal(
    localContext.services.autonomousSubmissionOutbox.externallyFencedMutations,
    false,
  );
  localContext.services.persistenceSession.close();
});

test('handoff path resolution rejects root, parent, and database symlink substitution', (t) => {
  const fixture = roots(t, 'hepta-handoff-path');
  const outside = path.join(fixture.parent, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(fixture.runtimeRoot, 'autonomous-research'));
  assert.throws(() => provisionAutonomousSubmissionHandoffStore({
    runtimeRoot: fixture.runtimeRoot,
  }), /directory_unsafe/);
  fs.rmSync(path.join(fixture.runtimeRoot, 'autonomous-research'));
  provisionAutonomousSubmissionHandoffStore({ runtimeRoot: fixture.runtimeRoot });
  const databasePath = autonomousSubmissionHandoffDatabasePath({
    runtimeRoot: fixture.runtimeRoot,
  });
  const moved = `${databasePath}.moved`;
  fs.renameSync(databasePath, moved);
  fs.symlinkSync(moved, databasePath);
  assert.throws(() => openAutonomousSubmissionHandoffStore({
    runtimeRoot: fixture.runtimeRoot,
    readOnly: true,
  }), /database_file_unsafe/);
  const linkedRoot = path.join(fixture.parent, 'runtime-link');
  fs.symlinkSync(fixture.runtimeRoot, linkedRoot);
  assert.throws(() => openAutonomousSubmissionHandoffStore({
    runtimeRoot: linkedRoot,
    readOnly: true,
  }), /runtime_root_unsafe/);
});

test('dedicated ledger accepts only the registered trusted state-machine issuer', (t) => {
  const fixture = roots(t, 'hepta-handoff-ledger');
  const nativeStore = createDefaultPaperStore({
    root: fixture.parent,
    dbPath: fixture.databasePath,
  });
  t.after(() => nativeStore.close());
  convergeAutonomousSubmissionHandoff({ nativeStore, runtimeRoot: fixture.runtimeRoot, now: NOW });
  const store = openAutonomousSubmissionHandoffStore({ runtimeRoot: fixture.runtimeRoot });
  t.after(() => store.close());
  const clock = { nowIso: () => NOW.toISOString() };
  const ledger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issueAutonomousSubmissionHandoffWriter(),
  });
  const receipt = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDeliveryStateReceipt',
    status: 'autonomous_submission_delivery_prepared',
    createdAt: NOW.toISOString(),
  });
  const recorded = ledger.record(receipt, {
    stream: 'autonomous-submission-delivery',
    paperId: 'paper:trusted-ledger',
  });
  const row = ledger.get(recorded.receiptId);
  assert.equal(Number(row.writer_trusted), 1);
  assert.equal(row.issuer_policy_id, 'autonomous-submission-handoff');
  assert.equal(row.writer_id, 'autonomous-submission-handoff-state-writer');
  assert.throws(() => ledger.prepare({ ...receipt, kind: 'OtherReceipt' }, {
    stream: 'autonomous-submission-delivery',
  }), /issuer kind forbidden/);
  assert.throws(() => ledger.prepare(receipt, { stream: 'other-stream' }),
    /issuer stream forbidden/);
  assert.throws(() => createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: Object.freeze({ policyId: 'autonomous-submission-handoff' }),
  }), /issuer_capability_invalid/);
  const tamper = store.execute(`UPDATE receipt_ledger SET writer_trusted=0
    WHERE receipt_id='${recorded.receiptId}'`);
  assert.equal(tamper.ok, false);
  assert.match(tamper.error, /append_only/);
});

test('externally fenced handoff rolls back candidate crashes and preserves CAS lineage', (t) => {
  const fixture = roots(t, 'hepta-handoff-cas');
  const nativeStore = createDefaultPaperStore({
    root: fixture.parent,
    dbPath: fixture.databasePath,
  });
  t.after(() => nativeStore.close());
  convergeAutonomousSubmissionHandoff({ nativeStore, runtimeRoot: fixture.runtimeRoot, now: NOW });
  const coordinator = testCoordinator();
  const store = openAutonomousSubmissionHandoffStore({
    runtimeRoot: fixture.runtimeRoot,
    mutationCoordinator: coordinator,
    requireExternallyFenced: true,
  });
  t.after(() => store.close());
  const clock = { nowIso: () => NOW.toISOString() };
  const ledger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issueAutonomousSubmissionHandoffWriter(),
  });
  const verifier = requestVerifier();
  const authority = createAutonomousSubmissionDispatchAuthority();
  const outbox = createAutonomousSubmissionOutboxRepository({
    store,
    receiptLedger: ledger,
    clock,
    submissionRequestVerifier: verifier,
    dispatchCapability: authority.outbox,
    dedicatedHandoffRequired: true,
  });
  const input = request('cas');
  const prepared = outbox.prepareAutonomousSubmission({ request: input, portalId: 'portal:test' });
  assert.equal(prepared.stateReceipt.state, 'prepared');
  assert.equal(prepared.externallyFencedMutations, true);
  coordinator.setFailAfterMutation(true);
  assert.throws(() => outbox.beginAutonomousSubmissionAttempt({
    request: input,
    portalId: 'portal:test',
  }), /fixture_crash_after_candidate_write/);
  assert.equal(outbox.getAutonomousSubmission({
    request: input,
    portalId: 'portal:test',
  }).stateReceipt.state, 'prepared');
  coordinator.setFailAfterMutation(false);
  const dispatching = outbox.beginAutonomousSubmissionAttempt({
    request: input,
    portalId: 'portal:test',
  });
  assert.equal(dispatching.stateReceipt.state, 'dispatching');
  assert.match(dispatching.sideEffectPermitHash, /^sha256:/);
  const uncertain = outbox.recordAutonomousSubmissionOutcome({
    request: input,
    portalId: 'portal:test',
    state: 'uncertain',
    resolution: 'remote-outcome-uncertain',
    failure: { code: 'fixture_timeout', httpStatus: null },
  });
  assert.equal(uncertain.stateReceipt.state, 'uncertain');
  assert.equal(uncertain.stateReceipt.previousStateReceiptHash,
    dispatching.stateReceipt.autonomousSubmissionDeliveryStateReceiptHash);
  const rows = store.query(`SELECT writer_trusted,issuer_policy_id
    FROM receipt_ledger ORDER BY created_at,receipt_id;`).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => Number(row.writer_trusted) === 1
    && row.issuer_policy_id === 'autonomous-submission-handoff'));
});

function deploymentDocument(source, name) {
  return source.split(/^---\s*$/m).find((document) => (
    /^kind:\s*Deployment\s*$/m.test(document)
    && new RegExp(`^  name: ${name}$`, 'm').test(document)
  ));
}

test('deployment grants native writes only to research and exact handoff writes to dispatcher', () => {
  const source = fs.readFileSync(path.join(
    WORKSPACE_ROOT, 'paper-core', 'deploy',
    'autonomous-research-supervisor.k8s.yaml',
  ), 'utf8');
  const supervisor = deploymentDocument(source, 'hepta-autonomous-research-supervisor');
  const dispatcher = deploymentDocument(source, 'hepta-autonomous-submission-dispatcher');
  assert.ok(supervisor);
  assert.ok(dispatcher);
  assert.match(supervisor, /name: runtime\n\s+mountPath: \/hepta\/runtime\n(?!\s+readOnly: true)/);
  assert.match(supervisor, /test -w \/hepta\/runtime\/hepta-paper\.sqlite/);
  assert.match(supervisor, /name: submission-handoff\n\s+mountPath: \/hepta\/runtime\/autonomous-research\/submission-handoff/);
  assert.match(dispatcher, /name: runtime-base\n\s+mountPath: \/hepta\/runtime\n\s+readOnly: true/);
  assert.match(dispatcher, /name: submission-handoff\n\s+mountPath: \/hepta\/runtime\/autonomous-research\/submission-handoff/);
  assert.match(dispatcher, /test ! -e \/hepta\/runtime\/hepta-paper\.sqlite/);
  assert.doesNotMatch(dispatcher, /claimName: hepta-runtime/);
  assert.match(supervisor, /claimName: hepta-autonomous-submission-handoff/);
  assert.match(dispatcher, /claimName: hepta-autonomous-submission-handoff/);
  assert.doesNotMatch(supervisor,
    /HEPTA_SUBMISSION_DISPATCHER_CYCLE_SIGNING_CONFIG|submission-dispatcher-signer/);
  assert.match(dispatcher, /HEPTA_SUBMISSION_DISPATCHER_CYCLE_SIGNING_CONFIG/);
  assert.match(dispatcher,
    /HEPTA_AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_AUTHORITY_PROCESS_CONFIG/);
  assert.match(dispatcher,
    /name: submission-handoff-authority\n\s+mountPath: \/hepta\/submission-handoff-authority/);
  assert.doesNotMatch(dispatcher,
    /HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY|\/hepta\/online-mutation-authority/);
  assert.match(dispatcher, /name: submission-dispatcher-signer\n\s+mountPath: \/hepta\/submission-dispatcher-signer/);
  assert.match(supervisor, /submission-handoff\)" = "3770"/);
  assert.match(supervisor, /dispatcher-challenges\)" = "10001"/);
  assert.match(supervisor, /test ! -w \/hepta\/runtime\/autonomous-research\/submission-handoff\/dispatcher-cycles/);
  assert.match(dispatcher, /dispatcher-cycles\)" = "10002"/);
  assert.match(dispatcher, /test ! -w \/hepta\/runtime\/autonomous-research\/submission-handoff\/dispatcher-challenges/);
  const service = fs.readFileSync(path.join(
    WORKSPACE_ROOT, 'paper-core', 'deploy',
    'autonomous-submission-dispatcher.service',
  ), 'utf8');
  assert.match(service, /^ReadOnlyPaths=-\/var\/lib\/hepta-paper\/runtime$/m);
  assert.match(service, /^ReadWritePaths=-\/var\/lib\/hepta-paper\/runtime\/autonomous-research\/submission-handoff /m);
  assert.doesNotMatch(service, /^ReadWritePaths=\/var\/lib\/hepta-paper\/runtime(?:\s|$)/m);
  const supervisorService = fs.readFileSync(path.join(
    WORKSPACE_ROOT, 'paper-core', 'deploy',
    'autonomous-research-supervisor.service',
  ), 'utf8');
  assert.match(supervisorService,
    /^Requires=hepta-paper-host-bootstrap\.service autonomous-submission-handoff-layout-provision\.service hepta-paper-state-authority\.service$/m);
  assert.match(supervisorService,
    /^Wants=.*autonomous-submission-handoff-layout-provision\.path/m);
  assert.doesNotMatch(supervisorService, /^ExecStartPre=\+/m);
  assert.match(supervisorService,
    /^ExecStartPre=\/usr\/bin\/test ! -g \/var\/lib\/hepta-paper\/runtime$/m);
  assert.match(supervisorService,
    /^ExecStartPre=\/usr\/bin\/test -g \/var\/lib\/hepta-paper\/runtime\/autonomous-research\/submission-handoff$/m);
  assert.match(supervisorService,
    /^ExecStartPre=\/usr\/bin\/test ! -w \/var\/lib\/hepta-paper\/runtime\/autonomous-research\/submission-handoff\/dispatcher-cycles$/m);
  assert.match(supervisorService,
    /^InaccessiblePaths=\/etc\/hepta-paper\/submission-portal \/etc\/hepta-paper\/submission-dispatcher-signer$/m);
  assert.doesNotMatch(supervisorService, /^InaccessiblePaths=(?:-|.* -)/m);
  assert.match(service,
    /^ExecStartPre=\/usr\/bin\/test ! -w \/var\/lib\/hepta-paper\/runtime\/autonomous-research\/submission-handoff\/dispatcher-challenges$/m);
  assert.match(service, /\/etc\/hepta-paper\/submission-handoff-authority/);
  assert.doesNotMatch(service, /\/etc\/hepta-paper\/online-mutation-authority/);
  const dispatcherEnvironment = fs.readFileSync(path.join(
    WORKSPACE_ROOT, 'paper-core', 'deploy',
    'autonomous-submission-dispatcher.env.example',
  ), 'utf8');
  assert.match(dispatcherEnvironment,
    /^HEPTA_AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_AUTHORITY_PROCESS_CONFIG=/m);
  assert.doesNotMatch(dispatcherEnvironment,
    /^HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_/m);
});

test('dispatcher composition cannot reach the full campaign bootstrap', () => {
  const source = fs.readFileSync(path.join(
    WORKSPACE_ROOT, 'paper-composition', 'automation',
    'autonomous-submission-dispatcher-composition.mjs',
  ), 'utf8');
  assert.match(source, /bootstrapAutonomousSubmissionHandoffContext/);
  assert.doesNotMatch(source, /bootstrapCampaignExecutionContext|bootstrapAutomationContext|campaignStore/);
});
