import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createFullResearchQualificationReceiptPointerRepository,
} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_ROLE,
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_MUTATION_PLANS,
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS,
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_ID,
  FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_PLAN_HASH,
  createOfflineFullResearchQualificationPublicationMutationCoordinator,
} from '../../paper-adapters/automation/full-research-qualification-publication-mutation-plan.mjs';
import {
  externallyFencedSqliteWriterPlanHash,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import {
  composeAutonomousResearchQualificationRenewal,
} from '../../paper-composition/automation/autonomous-research-qualification-composition.mjs';
import {
  createAutonomousResearchQualificationRenewal,
} from '../../paper-application/automation/autonomous-research-qualification-renewal.mjs';
import {
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord(
  'FullResearchQualificationPublicationOnlineMutationTest',
  { label },
);
const NOW = new Date('2026-07-18T08:00:00.000Z');

function qualificationReceipt(label) {
  const payload = Object.freeze({
    version: 1,
    kind: 'FullResearchGoldenMicroCampaignQualificationReceipt',
    status: 'full_research_golden_micro_campaign_qualified',
    campaignId: `campaign-${label}`,
    paperId: `paper-${label}`,
    campaignReleaseBundleHash: H(`release:${label}`),
    runtimeImageReproducibilityReceiptHash: H(`runtime:${label}`),
    runtimeImageReproducibilityRequiredProfiles:
      REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
    runtimeImageReproducibilityDefinitionManifestHashes: Object.freeze(
      Object.fromEntries(REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES.map((profile) => (
        [profile, H(`${profile}:${label}`)]
      ))),
    ),
    empiricalFamilyPluginPackageHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginStartupInspectionHash,
    activeEmpiricalProductionProfileHashes:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.activeProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .runtimeImageReproducibilityActivePluginScopeHash,
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60 * 60 * 1_000).toISOString(),
    externalActionPerformed: true,
  });
  return Object.freeze({
    ...payload,
    fullResearchQualificationReceiptHash: hashRecord(
      'FullResearchGoldenMicroCampaignQualificationReceipt',
      payload,
    ),
  });
}

function activeCoordinator({ publishMode = 'finalized', calls = [] } = {}) {
  const local = createOfflineFullResearchQualificationPublicationMutationCoordinator();
  let pendingPublishCall = null;
  const coveredDatabaseRoles = Object.freeze([
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_ROLE,
  ]);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation(input) {
      calls.push(Object.freeze({
        databaseRole: input.databaseRole,
        databaseInstanceId: input.databaseInstanceId,
        schemaContractId: input.schemaContractId,
        writerId: input.writerId,
        operationId: input.operationId,
        authorizationReceiptHashes: Object.freeze([
          ...input.authorizationReceiptHashes,
        ]),
        sideEffectReservationHashes: Object.freeze([
          ...input.sideEffectReservationHashes,
        ]),
      }));
      const committed = local.executeMutation(input);
      if (input.operationId === FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish
        && publishMode === 'finalization-pending') {
        pendingPublishCall = calls.at(-1);
        const error = new Error(
          'externally_fenced_sqlite_mutation_committed_finalization_pending',
        );
        error.committed = true;
        error.reservationId = 'reservation:full-qualification-publication:test';
        throw error;
      }
      return Object.freeze({
        ...committed,
        kind: 'ExternallyFencedSqliteMutationReceipt',
        status: 'externally_fenced_sqlite_mutation_finalized',
        reservationId: `reservation:full-qualification-publication:${input.operationId}`,
        sideEffectPermitHash:
          input.operationId === FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish
            && publishMode !== 'no-permit'
            ? H('side-effect-permit') : null,
      });
    },
    recoverPendingMutations({ database } = {}) {
      const recoveredReservationIds = [];
      if (pendingPublishCall) {
        installFinalizedMirrorPermit(database, pendingPublishCall);
        pendingPublishCall = null;
        recoveredReservationIds.push(
          'reservation:full-qualification-publication:test',
        );
      }
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationRecoveryReceipt',
        status: 'externally_fenced_sqlite_mutation_recovery_complete',
        recoveredReservationIds: Object.freeze(recoveredReservationIds),
      });
    },
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status: 'externally_fenced_sqlite_mutation_coordinator_ready',
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([]),
      });
    },
  });
}

function unactivatedCoordinator(calls = []) {
  const configured = activeCoordinator({ calls });
  return Object.freeze({
    ...configured,
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status: 'externally_fenced_sqlite_mutation_coordinator_configured',
        implemented: true,
        coveredDatabaseRoles: configured.coveredDatabaseRoles,
        blockers: Object.freeze([
          'autonomous_research_online_mutation_runtime_activation_required',
        ]),
      });
    },
  });
}

function fixture(t, { publishMode = 'finalized', afterAuthorityCommit = null } = {}) {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hepta-full-qualification-publish-online-'),
  );
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const provisioner = createFullResearchQualificationReceiptPointerRepository({
    runtimeRoot,
  });
  provisioner.provision();
  const calls = [];
  const repository = createFullResearchQualificationReceiptPointerRepository({
    runtimeRoot,
    afterAuthorityCommit,
    offlineProvision: false,
    mutationCoordinator: activeCoordinator({ publishMode, calls }),
    requireExternallyFencedMutations: true,
  });
  return { calls, repository, runtimeRoot };
}

function publicationInput(repository, label) {
  const receipt = qualificationReceipt(label);
  const lease = repository.tryAcquirePublicationLease({
    ownerId: `publisher-${label}`,
    now: NOW,
  });
  return Object.freeze({
    lease,
    receipt,
    qualificationStateHash: H(`qualification-state:${label}`),
    qualificationStateGeneration: 1,
    expectedRuntimeReceiptHash: receipt.runtimeImageReproducibilityReceiptHash,
    publisherFence: Object.freeze({
      scope: `qualification-publication-${label}`,
      ownerId: lease.ownerId,
      leaseGeneration: lease.leaseGeneration,
    }),
    now: NOW,
  });
}

function installFinalizedMirrorPermit(databaseOrPath, call) {
  const ownsDatabase = typeof databaseOrPath === 'string';
  const database = ownsDatabase ? new DatabaseSync(databaseOrPath) : databaseOrPath;
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS autonomous_research_online_mutation_authority_marker(
      reservation_id TEXT PRIMARY KEY,database_role TEXT NOT NULL,
      database_instance_id TEXT NOT NULL,operation_id TEXT NOT NULL,
      database_sequence INTEGER NOT NULL,reserve_request_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS autonomous_research_online_mutation_finalization_receipt(
      reservation_id TEXT PRIMARY KEY,side_effect_permit_hash TEXT NOT NULL,
      finalization_receipt_json TEXT NOT NULL
    ) STRICT;`);
    database.prepare(`INSERT OR IGNORE INTO autonomous_research_online_mutation_authority_marker(
      reservation_id,database_role,database_instance_id,operation_id,database_sequence,
      reserve_request_json
    ) VALUES(?,?,?,?,?,?)`).run(
      'reservation:full-qualification-publication:test',
      FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_ROLE,
      FULL_RESEARCH_QUALIFICATION_PUBLICATION_DATABASE_ROLE,
      FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish,
      1,
      JSON.stringify({
        sideEffectReservationHashes: call.sideEffectReservationHashes,
      }),
    );
    database.prepare(`INSERT OR IGNORE INTO
      autonomous_research_online_mutation_finalization_receipt(
        reservation_id,side_effect_permit_hash,finalization_receipt_json
      ) VALUES(?,?,?)`).run(
      'reservation:full-qualification-publication:test',
      H('side-effect-permit'),
      JSON.stringify({
        reservationId: 'reservation:full-qualification-publication:test',
        sideEffectPermitHash: H('side-effect-permit'),
      }),
    );
  } finally { if (ownsDatabase) database.close(); }
}

test('qualification publication strict mode rejects DDL and unactivated authority before I/O',
  async (t) => {
  const runtimeRoot = path.join(
    os.tmpdir(),
    `hepta-full-qualification-publish-missing-${process.pid}`,
  );
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const calls = [];
  assert.throws(() => createFullResearchQualificationReceiptPointerRepository({
    runtimeRoot,
    offlineProvision: true,
    mutationCoordinator: activeCoordinator({ calls }),
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.equal(fs.existsSync(runtimeRoot), false);
  const strictRepository = createFullResearchQualificationReceiptPointerRepository({
    runtimeRoot,
    offlineProvision: false,
    mutationCoordinator: activeCoordinator({ calls }),
    requireExternallyFencedMutations: true,
  });
  assert.throws(() => strictRepository.tryAcquirePublicationLease({
    ownerId: 'strict-publication-owner',
    now: NOW,
  }), /offline_provisioning_required/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(runtimeRoot), false);
  await assert.rejects(() => composeAutonomousResearchQualificationRenewal({
    campaign: {
      campaignId: 'strict-publication-campaign',
      paperId: 'strict-publication-paper',
      spec: {
        autonomousResearchPreparation: {
          proposal: { paperId: 'strict-publication-paper' },
        },
      },
    },
    root: path.join(runtimeRoot, 'missing-repository'),
    runtimeRoot,
    assertSupervisorLease() {},
    receiptPointerMutationCoordinator: unactivatedCoordinator(calls),
    requireExternallyFencedQualificationPublication: true,
  }), /external_mutation_coordinator_required/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(runtimeRoot), false);
  assert.throws(() => externallyFencedSqliteWriterPlanHash({
    writerId: FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_ID,
    operationPlans: [{
      version: 1,
      operationId: FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish,
      statements: [{
        statementId: 'qualification-publication.ddl.v1',
        mode: 'run',
        sql: 'CREATE TABLE forbidden(id INTEGER PRIMARY KEY)',
      }],
    }],
  }), /statement_plan_invalid/);
});

test('all qualification publication DML uses pinned plans and mirror waits for permit', (t) => {
  const { calls, repository } = fixture(t);
  const input = publicationInput(repository, 'finalized');
  const renewed = repository.renewPublicationLease({
    lease: input.lease,
    leaseMs: 6 * 60 * 1_000,
    now: new Date(NOW.getTime() + 1_000),
  });
  const publication = repository.publish({ ...input, lease: renewed });
  assert.equal(publication.mirrorSideEffectPermitHash, H('side-effect-permit'));
  assert.equal(repository.read().receipt.fullResearchQualificationReceiptHash,
    input.receipt.fullResearchQualificationReceiptHash);
  assert.equal(repository.releasePublicationLease({
    lease: renewed,
    now: new Date(NOW.getTime() + 2_000),
  }), true);
  assert.deepEqual(calls.map((call) => call.operationId), [
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.acquire,
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.renew,
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish,
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.release,
  ]);
  const publishCall = calls[2];
  assert.deepEqual(publishCall.authorizationReceiptHashes, [
    input.qualificationStateHash,
    input.receipt.fullResearchQualificationReceiptHash,
    input.receipt.runtimeImageReproducibilityReceiptHash,
  ].sort());
  assert.equal(publishCall.sideEffectReservationHashes.length, 1);
  assert.match(publishCall.sideEffectReservationHashes[0], /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(FULL_RESEARCH_QUALIFICATION_PUBLICATION_MUTATION_PLANS), [
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.acquire,
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish,
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.release,
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.renew,
  ]);
  assert.equal(
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_WRITER_PLAN_HASH,
    'sha256:70b6e23845aa8a365d85326236a082359e5f3059ed6f714b3224d021fa298db3',
  );
});

test('finalization pending and absent permits commit authority but never write mirror', (t) => {
  for (const publishMode of ['finalization-pending', 'no-permit']) {
    const { repository } = fixture(t, { publishMode });
    const input = publicationInput(repository, publishMode);
    let failure;
    try { repository.publish(input); }
    catch (error) { failure = error; }
    assert.equal(failure?.committed, true, publishMode);
    assert.equal(fs.existsSync(repository.qualificationReceiptPath), false, publishMode);
    const database = new DatabaseSync(repository.databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare(`SELECT receipt_hash
        FROM full_research_qualification_pointer_authority
        WHERE singleton_id=1`).get().receipt_hash,
      input.receipt.fullResearchQualificationReceiptHash);
    } finally { database.close(); }
  }
});

test('post-finalize mirror failure is durable side-effect-only restart recovery', (t) => {
  const { calls, repository, runtimeRoot } = fixture(t);
  fs.mkdirSync(repository.qualificationReceiptPath);
  const input = publicationInput(repository, 'mirror-restart');
  let failure;
  try { repository.publish(input); }
  catch (error) { failure = error; }
  assert.match(failure?.message || '', /committed_mirror_pending/);
  assert.equal(failure?.committed, true);
  assert.equal(failure?.retryableSideEffectOnly, true);
  assert.equal(failure?.sideEffectPermitHash, H('side-effect-permit'));
  assert.equal(calls.length, 2);
  const publishCall = calls[1];
  assert.equal(publishCall.operationId,
    FULL_RESEARCH_QUALIFICATION_PUBLICATION_OPERATION_IDS.publish);
  fs.rmSync(repository.qualificationReceiptPath, { recursive: true, force: true });
  installFinalizedMirrorPermit(repository.databasePath, publishCall);
  const restarted = createFullResearchQualificationReceiptPointerRepository({
    runtimeRoot,
    offlineProvision: false,
    mutationCoordinator: activeCoordinator(),
    requireExternallyFencedMutations: true,
  });
  const reconciliation = restarted.reconcileMirror();
  assert.equal(reconciliation.qualificationReceiptHash,
    input.receipt.fullResearchQualificationReceiptHash);
  assert.equal(reconciliation.sideEffectPermitHash, H('side-effect-permit'));
  assert.equal(calls.length, 2);
  assert.equal(restarted.read().receipt.fullResearchQualificationReceiptHash,
    input.receipt.fullResearchQualificationReceiptHash);
});

test('qualification renewal recovers pending publication in-process without replaying DML',
  async (t) => {
  const { calls, repository } = fixture(t, { publishMode: 'finalization-pending' });
  const input = publicationInput(repository, 'application-recovery');
  let failure;
  try { repository.publish(input); }
  catch (error) { failure = error; }
  assert.equal(failure?.committed, true);
  const publicationDmlCallCount = calls.length;
  let applicationRecoveries = 0;
  const pointerFacade = Object.freeze({
    kind: repository.kind,
    externallyFencedMutationsRequired: true,
    tryAcquirePublicationLease: repository.tryAcquirePublicationLease,
    publish: repository.publish,
    releasePublicationLease: repository.releasePublicationLease,
    recoverPendingPublication() {
      applicationRecoveries += 1;
      return repository.recoverPendingPublication();
    },
  });
  const renewal = createAutonomousResearchQualificationRenewal({
    externalQualificationClient: Object.freeze({
      kind: 'ExternalResearchQualificationClient',
    }),
    externalQualificationVerifier: Object.freeze({
      kind: 'IndependentExternalResearchQualificationVerifier',
      async verifyLocally() { return null; },
    }),
    qualificationStateStore: Object.freeze({
      kind: 'AutonomousResearchQualificationStateRepository',
      readExternalQualificationState() { return null; },
    }),
    receiptPointerRepository: pointerFacade,
    assertSupervisorLease() {},
    inspectGlobalReadiness() { return null; },
    clock: { now: () => new Date(NOW) },
  });
  const result = await renewal.renew({
    campaign: Object.freeze({
      campaignId: 'campaign-application-recovery',
      paperId: 'paper-application-recovery',
      spec: Object.freeze({ autonomousResearchPreparation: Object.freeze({}) }),
    }),
    campaignReleaseAuthority: Object.freeze({
      campaignId: 'campaign-application-recovery',
    }),
    runtimeReadiness: Object.freeze({ ready: true, receiptHash: H('runtime-ready') }),
    requiredQualificationValidityMs: 0,
    supervisorLease: Object.freeze({}),
  });
  assert.equal(result.ready, false);
  assert.equal(applicationRecoveries, 1);
  assert.equal(calls.length, publicationDmlCallCount);
  assert.equal(
    repository.read().receipt.fullResearchQualificationReceiptHash,
    input.receipt.fullResearchQualificationReceiptHash,
  );
});
