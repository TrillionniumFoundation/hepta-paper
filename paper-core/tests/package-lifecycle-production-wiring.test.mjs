import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPackageLifecycleAuthorityService } from '../../paper-application/automation/package-lifecycle-authority-service.mjs';
import { createPackageLifecycleMaterializationInspector } from '../../paper-adapters/automation/package-lifecycle-materialization-inspector.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from '../../paper-adapters/automation/package-recovery-tree-inventory-repository.mjs';
import {
  createPackageRetentionRecoveryLockRepository,
  PACKAGE_RETENTION_RECOVERY_READINESS_PROBE_HASH,
} from '../../paper-adapters/automation/package-retention-recovery-lock-repository.mjs';
import { packageLifecycleDeclaration } from '../../paper-adapters/automation/runtime-retention-package-lifecycle-authority.mjs';
import { campaignReleasePackageRootFor } from '../../paper-adapters/automation/campaign-release-materialization.mjs';
import {
  retentionMemberHash,
  retentionMemberIdentity,
} from '../../paper-adapters/automation/runtime-retention-scope-repository.mjs';
import { issuePackageLifecycleWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { receiptIssuerPolicies } from '../../paper-adapters/persistence/receipt-issuer-policy.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createPackageRetentionLegalHoldReceipt } from '../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import { createPackageLifecycleRecordingIntent } from '../../paper-domain/automation/package-lifecycle-recording-intent.mjs';
import {
  createPackageRecoveryAuthorityReadinessInspection,
  packageRecoveryAuthorityReadinessAttestationSubject,
} from '../../paper-domain/automation/package-recovery-authority-readiness-contract.mjs';
import { createPackageRecoveryDeletionLeaseAcquireRequest }
  from '../../paper-domain/automation/package-recovery-deletion-lease-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createPackageRecoveryDeletionLeaseFixture }
  from './support/package-recovery-deletion-lease-fixture.mjs';

const h = (value) => hashRecord('PackageLifecycleProductionWiringTest', value);

function testRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-package-lifecycle-production-'));
  t.after(() => {
    const restore = (candidate) => {
      if (!fs.existsSync(candidate)) return;
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      fs.chmodSync(candidate, 0o700);
      for (const name of fs.readdirSync(candidate)) {
        restore(path.join(candidate, name));
      }
    };
    restore(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function packageFixture(root, name, content = name) {
  const packagePath = path.join(root, 'packages', name);
  fs.mkdirSync(packagePath, { recursive: true });
  fs.writeFileSync(path.join(packagePath, 'PACKAGE_RECORD.json'), `${content}\n`);
  return packagePath;
}

function campaignFixture({ campaignId, paperId = 'paper', predecessor = null } = {}) {
  return {
    campaignId,
    paperId,
    status: 'running',
    effectiveStatus: 'running',
    parentCampaignId: null,
    supersedesCampaignId: predecessor,
    recoveryOfCampaignId: null,
    spec: { campaignPlanHash: h(`${campaignId}:plan`) },
  };
}

function releaseFixture({ campaign, packagePath, promotedAt, attempt = 'attempt-1' }) {
  const packageRecordPath = path.join(packagePath, 'PACKAGE_RECORD.json');
  const packageRecord = fs.readFileSync(packageRecordPath);
  fs.chmodSync(packageRecordPath, 0o444);
  fs.chmodSync(packagePath, 0o500);
  const packageOutputPayload = {
    version: 1,
    kind: 'ImmutableCampaignPackageOutput',
    immutable: true,
    releaseRoot: path.join(
      path.dirname(path.dirname(packagePath)),
      'campaign-releases',
      campaign.campaignId,
    ),
    packageDir: packagePath,
    files: [{
      role: 'package_record',
      path: packageRecordPath,
      hash: hashBytes(packageRecord),
      bytes: packageRecord.length,
    }],
    fileCount: 1,
  };
  const packageOutput = Object.freeze({
    ...packageOutputPayload,
    immutableCampaignPackageOutputHash: hashRecord(
      'ImmutableCampaignPackageOutput',
      packageOutputPayload,
    ),
  });
  const releaseBundle = Object.freeze({
    version: 1,
    kind: 'CampaignReleaseBundle',
    campaignReleaseBundleHash: h(`${campaign.campaignId}:bundle`),
    immutableCampaignPackageOutputHash:
      packageOutput.immutableCampaignPackageOutputHash,
    packageOutput,
  });
  const materializationReceiptHash = h(`${campaign.campaignId}:materialization`);
  const packageResult = Object.freeze({
    releaseBundle,
    campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
    materializationReceipt: Object.freeze({
      campaignReleaseBundleMaterializationReceiptHash: materializationReceiptHash,
    }),
    campaignReleaseBundleMaterializationReceiptHash: materializationReceiptHash,
  });
  const node = {
    nodeId: `${campaign.campaignId}:package`,
    campaignId: campaign.campaignId,
    kind: 'package',
    status: 'running',
    leaseOwner: 'worker-1',
    leaseExpiresAt: '2026-07-21T09:00:00.000Z',
    attemptId: attempt,
    leaseGeneration: 1,
    preparedResult: packageResult,
    preparedResultHash: hashRecord('PaperCampaignNodeResult', packageResult),
    preparedIntegrationStatus: 'integrated',
    preparedIntegrationKey: h(`${campaign.campaignId}:descriptor`),
    preparedIntegrationReceiptHash: h(`${campaign.campaignId}:integration`),
    preparedIntegratedAt: '2026-07-21T08:04:00.000Z',
    resultSha256: null,
    updatedAt: '2026-07-21T08:00:00.000Z',
  };
  const release = Object.freeze({
    version: 1,
    kind: 'CurrentCampaignReleaseAuthority',
    status: 'current_completed_release',
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    packageNodeId: node.nodeId,
    packageAttemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    packageResultHash: node.preparedResultHash,
    integrationDescriptorHash: node.preparedIntegrationKey,
    integrationReceiptHash: node.preparedIntegrationReceiptHash,
    campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
    materializationReceiptHash,
    packagePath,
    immutableCampaignPackageOutputHash:
      packageOutput.immutableCampaignPackageOutputHash,
    packageNodeStatus: 'completed',
    campaignStatus: 'completed',
    promotedAt,
    releaseBundle,
  });
  return { node, release, packageResult };
}

function authorityFixture(t) {
  const root = testRoot(t);
  let milliseconds = Date.parse('2026-07-21T08:10:00.000Z');
  const clock = {
    now: () => new Date(milliseconds),
    nowIso: () => new Date(milliseconds += 1).toISOString(),
  };
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  t.after(() => store.close?.());
  const receiptLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issuePackageLifecycleWriter(),
  });
  const campaigns = new Map();
  const nodes = new Map();
  const releases = new Map();
  const campaignStore = {
    getCampaign: (campaignId) => campaigns.get(campaignId) || null,
    listCampaigns: ({ limit, offset }) => [...campaigns.values()]
      .sort((left, right) => left.campaignId.localeCompare(right.campaignId))
      .slice(offset, offset + limit),
    listNodes: (campaignId) => nodes.get(campaignId) || [],
  };
  const campaignReleaseQuery = {
    getCurrentRelease: ({ campaignId }) => releases.get(campaignId) || null,
  };
  const policy = receiptIssuerPolicies()['package-lifecycle-authority'];
  const createService = ({
    ledger = receiptLedger,
    authorityClock = clock,
    packageRecoveryAuthority = null,
    packageRecoveryAuthorityReadinessVerifier = null,
    packageRecoveryDeletionLeasePort = null,
    packageRetentionRecoveryLockRepository = null,
  } = {}) => createPackageLifecycleAuthorityService({
    runtimeRoot: root,
    campaignStore,
    campaignReleaseQuery,
    materializationInspector:
      createPackageLifecycleMaterializationInspector({ runtimeRoot: root }),
    packageRecoveryAuthority,
    packageRecoveryAuthorityReadinessVerifier,
    packageRecoveryDeletionLeasePort,
    packageRetentionRecoveryLockRepository,
    receiptLedger: ledger,
    receiptWriterAuthority: {
      ...policy,
      policyId: 'package-lifecycle-authority',
    },
    clock: authorityClock,
  });
  const complete = ({ campaign, node, release }) => {
    campaign.status = 'completed';
    campaign.effectiveStatus = campaign.supersedesCampaignId
      ? 'completed' : campaign.effectiveStatus;
    node.status = 'completed';
    node.resultSha256 = node.preparedResultHash;
    releases.set(campaign.campaignId, release);
  };
  return {
    root, clock, campaigns, nodes, releases, receiptLedger, createService, complete,
  };
}

function rows(ledger, stream) {
  return ledger.list({
    stream,
    environment: 'administrative',
    includeQualified: false,
    limit: 1000,
  });
}

test('retention recovery readiness is explicit and fail-closed without an authority', (t) => {
  const fixture = authorityFixture(t);
  const unavailable = fixture.createService().retentionRecoveryReadiness();
  assert.equal(unavailable.status, 'package_retention_recovery_authority_unavailable');
  assert.equal(unavailable.recoveryAuthorityConfigured, false);
  assert.equal(unavailable.lifecycleLockConfigured, false);
  assert.equal(unavailable.deletionFailClosedWhenUnavailable, true);
  assert.deepEqual(unavailable.blockers, [
    'package_retention_recovery_authority_unavailable',
    'package_retention_recovery_deletion_lease_unavailable',
    'package_retention_recovery_lifecycle_lock_unavailable',
  ]);
  assert.match(unavailable.packageRetentionRecoveryReadinessHash, /^sha256:[a-f0-9]{64}$/);

  const interfacesOnlyAuthority = Object.freeze({
    version: 1,
    kind: 'PackageRecoveryAuthority',
    createRecoveryEvidence() {},
    inspectLiveRecoverySource() {},
    verifyStorageAuthorityProof() { return false; },
    verifyRestoreExecutionProof() { return false; },
  });
  const interfacesOnlyLock = Object.freeze({
    version: 1,
    kind: 'PackageRetentionRecoveryLockRepository',
    withLifecycleLock() {},
  });
  const rejected = fixture.createService({
    packageRecoveryAuthority: interfacesOnlyAuthority,
    packageRetentionRecoveryLockRepository: interfacesOnlyLock,
  }).retentionRecoveryReadiness();
  assert.equal(rejected.status, 'package_retention_recovery_authority_unavailable');
  assert.equal(rejected.recoveryAuthorityConfigured, true);
  assert.equal(rejected.recoveryAuthorityAuthenticated, false);
  assert.equal(rejected.lifecycleLockConfigured, true);
  assert.equal(rejected.lifecycleLockOperational, false);
  assert.deepEqual(rejected.blockers, [
    'package_retention_recovery_readiness_verifier_unavailable',
    'package_retention_recovery_deletion_lease_unavailable',
    'package_retention_recovery_lifecycle_lock_self_check_failed',
  ]);

  const baseCanaries = Object.freeze({
    storageAuthorityCanary: Object.freeze({
      proof: Object.freeze({ kind: 'storage-canary' }),
      lifecycleReceipt: Object.freeze({ kind: 'lifecycle-canary' }),
    }),
    restoreAuthorityCanary: Object.freeze({
      proof: Object.freeze({ kind: 'restore-canary' }),
      recoverySourceAuthority: Object.freeze({ kind: 'recovery-source-canary' }),
    }),
  });
  const deletionLeaseFixture = createPackageRecoveryDeletionLeaseFixture({
    clock: fixture.clock,
  });
  const canariesFor = ({ challengeHash, requestedAt, authoritySnapshotHash }) => ({
    ...baseCanaries,
    deletionLeaseAuthorityCanary: Object.freeze({
      acquireRequest: createPackageRecoveryDeletionLeaseAcquireRequest({
        challengeHash,
        operationId: 'readiness:package-recovery-deletion-lease-canary',
        deletionOperationHash: h({ challengeHash, kind: 'readiness-deletion-canary' }),
        packageLifecycleReceiptHash: h('readiness-canary-lifecycle'),
        packageRetentionRecoveryReceiptHash: h('readiness-canary-recovery'),
        authoritySnapshotHash,
        storageAuthorityId: 'worm-provider:readiness-canary',
        storageObjectId: 'readiness-canary/package.archive',
        storageObjectVersion: 'readiness-canary-object-version-0001',
        storageObjectBytesHash: h('readiness-canary-object-bytes'),
        retentionLockVersion: 'readiness-canary-lock-version-0001',
        retentionLockIdentityHash: h('readiness-canary-retention-lock'),
        retainUntil: '2027-08-20T00:00:00.000Z',
        storageLedgerReceiptId: 'readiness-canary-ledger:receipt:0001',
        storageLedgerReceiptHash: h('readiness-canary-ledger-receipt'),
        trustStoreHash: h('readiness-canary-trust-store'),
        requestedAt,
        minimumRemainingHorizonMs: 60_000,
      }),
    }),
  });
  const readinessKey = crypto.generateKeyPairSync('ed25519');
  const readinessAttestations = new Map();
  const issueReadinessAttestation = (subject) => {
    const subjectHash = hashRecord('PackageRecoveryReadinessAttestationSubject', subject);
    const attestation = Object.freeze({
      ...subject,
      subjectHash,
      signature: crypto.sign(
        null,
        Buffer.from(subjectHash, 'utf8'),
        readinessKey.privateKey,
      ).toString('base64'),
    });
    const attestationHash = hashRecord(
      'PackageRecoveryReadinessAttestation',
      attestation,
    );
    readinessAttestations.set(attestationHash, attestation);
    return attestationHash;
  };
  const readinessVerifier = Object.freeze({
    verifyAuthenticatedInspection(inspection, { challengeHash, requestedAt }) {
      const attestation = readinessAttestations.get(
        inspection.authenticatedAuthorityAttestationHash,
      );
      const {
        subjectHash = null,
        signature = null,
        ...attestationSubject
      } = attestation || {};
      if (!attestation
        || hashRecord('PackageRecoveryReadinessAttestationSubject', attestationSubject)
          !== subjectHash
        || JSON.stringify(attestationSubject) !== JSON.stringify(
          packageRecoveryAuthorityReadinessAttestationSubject(inspection),
        )
        || attestation.challengeHash !== challengeHash
        || attestation.requestedAt !== requestedAt
        || attestation.checkedAt !== inspection.checkedAt
        || attestation.expiresAt !== inspection.expiresAt
        || attestation.authoritySnapshotHash !== inspection.authoritySnapshotHash) return false;
      return crypto.verify(
        null,
        Buffer.from(subjectHash, 'utf8'),
        readinessKey.publicKey,
        Buffer.from(signature, 'base64'),
      );
    },
  });
  const operationalLock = createPackageRetentionRecoveryLockRepository({
    runtimeRoot: fixture.root,
  });
  operationalLock.withLifecycleLock(
    PACKAGE_RETENTION_RECOVERY_READINESS_PROBE_HASH,
    () => true,
  );
  const selfReportingButRejectingAuthority = Object.freeze({
    ...interfacesOnlyAuthority,
    inspectAuthenticatedReadiness({ challengeHash, requestedAt }) {
      const authoritySnapshotHash = h('unverified-authority-snapshot');
      return createPackageRecoveryAuthorityReadinessInspection({
        challengeHash,
        requestedAt,
        checkedAt: requestedAt,
        expiresAt: new Date(Date.parse(requestedAt) + 60_000).toISOString(),
        ...canariesFor({ challengeHash, requestedAt, authoritySnapshotHash }),
        authoritySnapshotHash,
        deploymentIdentityHash: h('unverified-deployment'),
        readinessTrustStoreHash: h('unverified-readiness-trust-store'),
        authenticatedAuthorityAttestationHash: h('unverified-attestation'),
      });
    },
  });
  const selfReported = fixture.createService({
    packageRecoveryAuthority: selfReportingButRejectingAuthority,
    packageRecoveryAuthorityReadinessVerifier: readinessVerifier,
    packageRecoveryDeletionLeasePort: deletionLeaseFixture.port,
    packageRetentionRecoveryLockRepository: operationalLock,
  }).retentionRecoveryReadiness();
  assert.equal(selfReported.status, 'package_retention_recovery_authority_unavailable');
  assert.equal(selfReported.recoveryAuthorityAuthenticated, false);
  assert.deepEqual(selfReported.blockers, [
    'package_retention_recovery_authority_self_check_failed',
  ]);

  const authority = Object.freeze({
    ...interfacesOnlyAuthority,
    verifyStorageAuthorityProof() { return true; },
    verifyRestoreExecutionProof() { return true; },
    inspectAuthenticatedReadiness({ challengeHash, requestedAt }) {
      const checkedAt = requestedAt;
      const expiresAt = new Date(Date.parse(requestedAt) + 60_000).toISOString();
      const authoritySnapshotHash = h('recovery-authority-snapshot');
      const inspectionInput = {
        challengeHash,
        requestedAt,
        checkedAt,
        expiresAt,
        ...canariesFor({ challengeHash, requestedAt, authoritySnapshotHash }),
        authoritySnapshotHash,
        deploymentIdentityHash: h('qualified-recovery-deployment'),
        readinessTrustStoreHash: h('independent-readiness-trust-store'),
      };
      const unsigned = createPackageRecoveryAuthorityReadinessInspection({
        ...inspectionInput,
        authenticatedAuthorityAttestationHash: h('pending-attestation'),
      });
      return createPackageRecoveryAuthorityReadinessInspection({
        ...inspectionInput,
        authenticatedAuthorityAttestationHash: issueReadinessAttestation(
          packageRecoveryAuthorityReadinessAttestationSubject(unsigned),
        ),
      });
    },
  });
  const ready = fixture.createService({
    packageRecoveryAuthority: authority,
    packageRecoveryAuthorityReadinessVerifier: readinessVerifier,
    packageRecoveryDeletionLeasePort: deletionLeaseFixture.port,
    packageRetentionRecoveryLockRepository: operationalLock,
  }).retentionRecoveryReadiness();
  assert.equal(ready.status, 'package_retention_recovery_authority_ready');
  assert.equal(ready.recoveryAuthorityConfigured, true);
  assert.equal(ready.recoveryAuthorityAuthenticated, true);
  assert.equal(ready.lifecycleLockConfigured, true);
  assert.equal(ready.lifecycleLockOperational, true);
  assert.equal(ready.deletionLeasePortConfigured, true);
  assert.equal(ready.deletionLeasePortOperational, true);
  assert.deepEqual(ready.blockers, []);
  assert.deepEqual(deletionLeaseFixture.calls, {
    acquire: 1,
    lookupTerminal: 1,
    assert: 1,
    renew: 0,
    commit: 0,
    abortRelease: 1,
  });
  deletionLeaseFixture.setAvailable(false);
  const leaseUnavailable = fixture.createService({
    packageRecoveryAuthority: authority,
    packageRecoveryAuthorityReadinessVerifier: readinessVerifier,
    packageRecoveryDeletionLeasePort: deletionLeaseFixture.port,
    packageRetentionRecoveryLockRepository: operationalLock,
  }).retentionRecoveryReadiness();
  assert.equal(leaseUnavailable.status,
    'package_retention_recovery_authority_unavailable');
  assert.deepEqual(leaseUnavailable.blockers, [
    'package_retention_recovery_authority_self_check_failed',
  ]);
  assert.equal(deletionLeaseFixture.calls.acquire, 2);
  assert.equal(deletionLeaseFixture.calls.abortRelease, 1);
  deletionLeaseFixture.setAvailable(true);

  const substitutedCanaryAuthority = Object.freeze({
    ...authority,
    inspectAuthenticatedReadiness(request) {
      const valid = authority.inspectAuthenticatedReadiness(request);
      return createPackageRecoveryAuthorityReadinessInspection({
        challengeHash: valid.challengeHash,
        requestedAt: valid.requestedAt,
        checkedAt: valid.checkedAt,
        expiresAt: valid.expiresAt,
        storageAuthorityCanary: {
          ...valid.storageAuthorityCanary,
          proof: { kind: 'substituted-storage-canary' },
        },
        restoreAuthorityCanary: valid.restoreAuthorityCanary,
        deletionLeaseAuthorityCanary: valid.deletionLeaseAuthorityCanary,
        authoritySnapshotHash: valid.authoritySnapshotHash,
        deploymentIdentityHash: valid.deploymentIdentityHash,
        readinessTrustStoreHash: valid.readinessTrustStoreHash,
        authenticatedAuthorityAttestationHash:
          valid.authenticatedAuthorityAttestationHash,
      });
    },
  });
  assert.equal(fixture.createService({
    packageRecoveryAuthority: substitutedCanaryAuthority,
    packageRecoveryAuthorityReadinessVerifier: readinessVerifier,
    packageRecoveryDeletionLeasePort: deletionLeaseFixture.port,
    packageRetentionRecoveryLockRepository: operationalLock,
  }).retentionRecoveryReadiness().status,
  'package_retention_recovery_authority_unavailable');

  const futureDatedAuthority = Object.freeze({
    ...authority,
    inspectAuthenticatedReadiness({ challengeHash, requestedAt }) {
      const authoritySnapshotHash = h('future-authority-snapshot');
      return createPackageRecoveryAuthorityReadinessInspection({
        challengeHash,
        requestedAt,
        checkedAt: '2099-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:01:00.000Z',
        ...canariesFor({ challengeHash, requestedAt, authoritySnapshotHash }),
        authoritySnapshotHash,
        deploymentIdentityHash: h('future-deployment'),
        readinessTrustStoreHash: h('future-readiness-trust-store'),
        authenticatedAuthorityAttestationHash: h('future-attestation'),
      });
    },
  });
  assert.equal(fixture.createService({
    packageRecoveryAuthority: futureDatedAuthority,
    packageRecoveryAuthorityReadinessVerifier: readinessVerifier,
    packageRecoveryDeletionLeasePort: deletionLeaseFixture.port,
    packageRetentionRecoveryLockRepository: operationalLock,
  }).retentionRecoveryReadiness().status,
  'package_retention_recovery_authority_unavailable');

  let slowClockCalls = 0;
  const slowClock = Object.freeze({
    nowIso() {
      slowClockCalls += 1;
      return slowClockCalls === 1
        ? '2026-07-21T08:30:00.000Z'
        : '2026-07-21T08:30:31.000Z';
    },
  });
  assert.equal(fixture.createService({
    authorityClock: slowClock,
    packageRecoveryAuthority: authority,
    packageRecoveryAuthorityReadinessVerifier: readinessVerifier,
    packageRecoveryDeletionLeasePort: deletionLeaseFixture.port,
    packageRetentionRecoveryLockRepository: operationalLock,
  }).retentionRecoveryReadiness().status,
  'package_retention_recovery_authority_unavailable');
});

test('intent survives a crash, reconciles the current release once, and never backfills legacy releases', (t) => {
  const fixture = authorityFixture(t);
  const campaign = campaignFixture({ campaignId: 'new-generation' });
  const packagePath = packageFixture(fixture.root, 'new-generation');
  const built = releaseFixture({
    campaign,
    packagePath,
    promotedAt: '2026-07-21T08:05:00.000Z',
  });
  fixture.campaigns.set(campaign.campaignId, campaign);
  fixture.nodes.set(campaign.campaignId, [built.node]);
  const firstProcess = fixture.createService();
  const firstIntent = firstProcess.prepareCurrentReleaseRecording({
    campaignId: campaign.campaignId,
    nodeId: built.node.nodeId,
    workerId: built.node.leaseOwner,
    attemptId: built.node.attemptId,
    leaseGeneration: built.node.leaseGeneration,
    preparedResultHash: built.node.preparedResultHash,
  });
  const replayedIntent = fixture.createService().prepareCurrentReleaseRecording({
    campaignId: campaign.campaignId,
    nodeId: built.node.nodeId,
    workerId: built.node.leaseOwner,
    attemptId: built.node.attemptId,
    leaseGeneration: built.node.leaseGeneration,
    preparedResultHash: built.node.preparedResultHash,
  });
  assert.equal(
    replayedIntent.packageLifecycleRecordingIntentReceiptHash,
    firstIntent.packageLifecycleRecordingIntentReceiptHash,
  );
  assert.equal(rows(fixture.receiptLedger, 'package-lifecycle-intents').length, 1);
  fixture.complete({ campaign, node: built.node, release: built.release });

  const legacy = campaignFixture({ campaignId: 'legacy-generation' });
  const legacyPath = packageFixture(fixture.root, 'legacy-generation');
  const legacyBuilt = releaseFixture({
    campaign: legacy,
    packagePath: legacyPath,
    promotedAt: '2026-07-21T08:05:00.000Z',
  });
  fixture.campaigns.set(legacy.campaignId, legacy);
  fixture.nodes.set(legacy.campaignId, [legacyBuilt.node]);
  fixture.complete({ campaign: legacy, node: legacyBuilt.node, release: legacyBuilt.release });

  const recoveredProcess = fixture.createService();
  assert.equal(recoveredProcess.reconcile().reconciledCount, 1);
  assert.equal(recoveredProcess.reconcile().reconciledCount, 1);
  assert.equal(rows(fixture.receiptLedger, 'package-lifecycle-intents').length, 1);
  const lifecycle = rows(fixture.receiptLedger, 'package-lifecycle');
  assert.equal(lifecycle.filter((row) => row.kind === 'PackageLifecycleReceipt').length, 1);
  const recordedLifecycle = JSON.parse(lifecycle.find(
    (row) => row.kind === 'PackageLifecycleReceipt',
  ).receipt_json);
  assert.equal(recordedLifecycle.version, 2);
  assert.equal(
    recordedLifecycle.packageRecoveryTreeInventoryHash,
    inspectPackageRecoveryTreeInventorySync({ packagePath })
      .inventory.packageRecoveryTreeInventoryHash,
  );
  assert.equal(lifecycle.some((row) => JSON.parse(row.receipt_json)
    .releaseIdentity.campaignId === legacy.campaignId), false);
});

test('successor recording emits one supersession receipt and duplicate reconciliation is idempotent', (t) => {
  const fixture = authorityFixture(t);
  const oldCampaign = campaignFixture({ campaignId: 'old', paperId: 'paper-a' });
  const oldBuilt = releaseFixture({
    campaign: oldCampaign,
    packagePath: packageFixture(fixture.root, 'old', 'old'),
    promotedAt: '2026-07-21T08:01:00.000Z',
  });
  fixture.campaigns.set(oldCampaign.campaignId, oldCampaign);
  fixture.nodes.set(oldCampaign.campaignId, [oldBuilt.node]);
  const service = fixture.createService();
  service.prepareCurrentReleaseRecording({
    campaignId: oldCampaign.campaignId,
    nodeId: oldBuilt.node.nodeId,
    workerId: oldBuilt.node.leaseOwner,
    attemptId: oldBuilt.node.attemptId,
    leaseGeneration: 1,
    preparedResultHash: oldBuilt.node.preparedResultHash,
  });
  fixture.complete({ campaign: oldCampaign, node: oldBuilt.node, release: oldBuilt.release });
  service.reconcileCampaign({ campaignId: oldCampaign.campaignId });

  const successor = campaignFixture({
    campaignId: 'successor',
    paperId: 'paper-a',
    predecessor: oldCampaign.campaignId,
  });
  oldCampaign.effectiveStatus = 'superseded';
  const successorBuilt = releaseFixture({
    campaign: successor,
    packagePath: packageFixture(fixture.root, 'successor', 'successor'),
    promotedAt: '2026-07-21T08:06:00.000Z',
  });
  fixture.campaigns.set(successor.campaignId, successor);
  fixture.nodes.set(successor.campaignId, [successorBuilt.node]);
  service.prepareCurrentReleaseRecording({
    campaignId: successor.campaignId,
    nodeId: successorBuilt.node.nodeId,
    workerId: successorBuilt.node.leaseOwner,
    attemptId: successorBuilt.node.attemptId,
    leaseGeneration: 1,
    preparedResultHash: successorBuilt.node.preparedResultHash,
  });
  fixture.complete({
    campaign: successor,
    node: successorBuilt.node,
    release: successorBuilt.release,
  });
  service.reconcileCampaign({ campaignId: successor.campaignId });
  service.reconcileCampaign({ campaignId: successor.campaignId });

  const lifecycle = rows(fixture.receiptLedger, 'package-lifecycle');
  assert.equal(lifecycle.filter((row) => row.kind === 'PackageLifecycleReceipt').length, 2);
  assert.equal(lifecycle.filter((row) => row.kind === 'PackageSupersessionReceipt').length, 1);
});

test('post-intent package mutation and non-current releases fail closed without lifecycle authority', (t) => {
  const fixture = authorityFixture(t);
  const campaign = campaignFixture({ campaignId: 'tampered' });
  const packagePath = packageFixture(fixture.root, 'tampered', 'before');
  const built = releaseFixture({
    campaign,
    packagePath,
    promotedAt: '2026-07-21T08:05:00.000Z',
  });
  fixture.campaigns.set(campaign.campaignId, campaign);
  fixture.nodes.set(campaign.campaignId, [built.node]);
  const service = fixture.createService();
  service.prepareCurrentReleaseRecording({
    campaignId: campaign.campaignId,
    nodeId: built.node.nodeId,
    workerId: built.node.leaseOwner,
    attemptId: built.node.attemptId,
    leaseGeneration: 1,
    preparedResultHash: built.node.preparedResultHash,
  });
  fixture.releases.set(campaign.campaignId, built.release);
  assert.equal(service.reconcileCampaign({ campaignId: campaign.campaignId }).reconciledCount, 0);
  fixture.complete({ campaign, node: built.node, release: built.release });
  const packageRecordPath = path.join(packagePath, 'PACKAGE_RECORD.json');
  fs.chmodSync(packageRecordPath, 0o644);
  fs.writeFileSync(packageRecordPath, 'after\n');
  fs.chmodSync(packageRecordPath, 0o444);
  assert.throws(
    () => service.reconcileCampaign({ campaignId: campaign.campaignId }),
    /campaign_release_package_output_file_invalid/,
  );
  assert.equal(rows(fixture.receiptLedger, 'package-lifecycle').length, 0);
});

test('campaign package generation is a direct packages member and traversal or symlink layouts fail closed', (t) => {
  const root = testRoot(t);
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  const candidate = campaignReleasePackageRootFor(
    root,
    { campaignId: '../../escape/../campaign' },
    { nodeId: '../../../node', attemptId: '../../../../attempt' },
  );
  assert.equal(path.dirname(candidate), path.join(root, 'packages'));
  assert.equal(candidate.includes('..'), false);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-package-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'PACKAGE_RECORD.json'), 'outside\n');
  const linked = path.join(root, 'packages', 'linked-generation');
  fs.symlinkSync(outside, linked, 'dir');
  const outputHash = h('linked-output');
  const inspector = createPackageLifecycleMaterializationInspector({ runtimeRoot: root });
  assert.throws(() => inspector.inspectRelease({
    releaseBundle: {
      immutableCampaignPackageOutputHash: outputHash,
      packageOutput: {
        immutable: true,
        packageDir: linked,
        immutableCampaignPackageOutputHash: outputHash,
      },
    },
  }), /package_lifecycle_release_package_binding_invalid|package_lifecycle_package_directory_invalid/);
});

test('retention authorizes only a journal-fenced stale package staging generation', (t) => {
  const root = testRoot(t);
  const stalePath = path.join(root, 'packages', '.package-prepared-stale');
  const abortedPath = path.join(root, 'packages', '.package-aborted-stale');
  fs.mkdirSync(stalePath, { recursive: true });
  fs.mkdirSync(abortedPath, { recursive: true });
  fs.writeFileSync(path.join(stalePath, 'partial.bin'), 'partial\n');
  fs.writeFileSync(path.join(abortedPath, 'partial.bin'), 'aborted\n');
  const entry = Object.freeze({
    path: stalePath,
    contentHash: retentionMemberHash(stalePath),
    symbolicLink: false,
  });
  const abortedEntry = Object.freeze({
    path: abortedPath,
    contentHash: retentionMemberHash(abortedPath),
    symbolicLink: false,
  });
  const campaign = campaignFixture({ campaignId: 'fenced-staging' });
  const currentNode = Object.freeze({
    campaignId: campaign.campaignId,
    nodeId: 'fenced-staging:package',
    kind: 'package',
    status: 'running',
    attemptId: 'attempt-current',
    leaseGeneration: 2,
  });
  const campaigns = Object.freeze({
    rows: Object.freeze([campaign]),
    nodes: Object.freeze([currentNode]),
    hash: h('fenced-staging-campaign-inventory'),
  });
  const releases = Object.freeze({
    rows: Object.freeze([]),
    hash: h('fenced-staging-release-inventory'),
  });
  const transaction = Object.freeze({
    campaignId: campaign.campaignId,
    packageNodeId: currentNode.nodeId,
    packageAttemptId: 'attempt-stale',
    leaseGeneration: 1,
    packageDir: path.join(root, 'packages', 'stale-final'),
    preparedParent: stalePath,
    abortedParent: abortedPath,
    campaignReleasePackageBuildingTransactionHash: h('building-transaction'),
    campaignReleasePackageBuildingFenceHash: h('building-fence'),
    supersedingPackageAttemptId: currentNode.attemptId,
    supersedingLeaseGeneration: currentNode.leaseGeneration,
    campaignReleasePackagePreparedTransactionHash: null,
    stagingEntries: Object.freeze([
      Object.freeze({
        path: stalePath,
        contentHash: entry.contentHash,
        identity: retentionMemberIdentity(stalePath),
        campaignReleasePackageFencedStagingTreeIdentityHash:
          h('prepared-staging-tree-identity'),
        campaignReleasePackageFencedStagingIdentityHash: hashRecord(
          'CampaignReleasePackageFencedStagingIdentity',
          {
            path: stalePath,
            contentHash: entry.contentHash,
            identity: retentionMemberIdentity(stalePath),
            treeIdentityHash: h('prepared-staging-tree-identity'),
          },
        ),
        campaignReleasePackageBuildingMarkerHash: h('prepared-building-marker'),
      }),
      Object.freeze({
        path: abortedPath,
        contentHash: abortedEntry.contentHash,
        identity: retentionMemberIdentity(abortedPath),
        campaignReleasePackageFencedStagingTreeIdentityHash:
          h('aborted-staging-tree-identity'),
        campaignReleasePackageFencedStagingIdentityHash: hashRecord(
          'CampaignReleasePackageFencedStagingIdentity',
          {
            path: abortedPath,
            contentHash: abortedEntry.contentHash,
            identity: retentionMemberIdentity(abortedPath),
            treeIdentityHash: h('aborted-staging-tree-identity'),
          },
        ),
        campaignReleasePackageBuildingMarkerHash: h('aborted-building-marker'),
      }),
    ]),
  });
  const fencedTransactions = Object.freeze({
    rows: Object.freeze([transaction]),
    hash: h('fenced-transaction-inventory'),
  });
  const authority = (node = currentNode) => packageLifecycleDeclaration({
    runtimeRoot: root,
    entries: [entry, abortedEntry],
    campaigns: Object.freeze({ ...campaigns, nodes: Object.freeze([node]) }),
    releases,
    receiptLedger: { list: () => [] },
    casInventory: Object.freeze({ rows: Object.freeze([]), hash: h('cas') }),
    fencedTransactions,
  }).declaration;

  const stale = authority();
  assert.deepEqual(
    stale.deletionEvidence.map((evidence) => evidence.path),
    [stalePath, abortedPath],
  );
  assert.ok(stale.deletionEvidence.every((evidence) => (
    evidence.sourceEvidenceHashes.includes(
      transaction.campaignReleasePackageBuildingFenceHash,
    )
  )));

  const active = packageLifecycleDeclaration({
    runtimeRoot: root,
    entries: [entry, abortedEntry],
    campaigns,
    releases,
    receiptLedger: { list: () => [] },
    casInventory: Object.freeze({ rows: Object.freeze([]), hash: h('cas') }),
    activeNodeIds: [currentNode.nodeId],
    fencedTransactions,
  }).declaration;
  assert.deepEqual(active.activePaths, [stalePath, abortedPath]);
  assert.equal(active.deletionEvidence.length, 0);

  const referenced = packageLifecycleDeclaration({
    runtimeRoot: root,
    entries: [entry, abortedEntry],
    campaigns,
    releases,
    receiptLedger: { list: () => [] },
    casInventory: Object.freeze({
      rows: Object.freeze([
        { logicalPath: path.relative(root, stalePath), contentHash: h('other') },
        {
          logicalPath: path.relative(root, abortedPath),
          contentHash: h('other-aborted'),
        },
      ]),
      hash: h('cas-referenced'),
    }),
    fencedTransactions,
  }).declaration;
  assert.deepEqual(referenced.referencedPaths, [stalePath, abortedPath]);
  assert.equal(referenced.deletionEvidence.length, 0);

  const unfencedGeneration = authority(Object.freeze({
    ...currentNode,
    attemptId: transaction.packageAttemptId,
    leaseGeneration: transaction.leaseGeneration,
  }));
  assert.equal(unfencedGeneration.deletionEvidence.length, 0);
  assert.deepEqual(
    unfencedGeneration.recoveryProtectedPaths,
    [stalePath, abortedPath],
  );
});

test('a published lifecycle path can never inherit fenced-staging deletion authority', (t) => {
  const fixture = authorityFixture(t);
  const campaign = campaignFixture({ campaignId: 'published-fenced-overlap' });
  const packagePath = packageFixture(fixture.root, 'published-fenced-overlap');
  const built = releaseFixture({
    campaign,
    packagePath,
    promotedAt: '2026-07-21T08:05:00.000Z',
  });
  fixture.campaigns.set(campaign.campaignId, campaign);
  fixture.nodes.set(campaign.campaignId, [built.node]);
  const service = fixture.createService();
  service.prepareCurrentReleaseRecording({
    campaignId: campaign.campaignId,
    nodeId: built.node.nodeId,
    workerId: built.node.leaseOwner,
    attemptId: built.node.attemptId,
    leaseGeneration: built.node.leaseGeneration,
    preparedResultHash: built.node.preparedResultHash,
  });
  fixture.complete({ campaign, node: built.node, release: built.release });
  service.reconcileCampaign({ campaignId: campaign.campaignId });
  campaign.effectiveStatus = 'superseded';
  const inspected = createPackageLifecycleMaterializationInspector({
    runtimeRoot: fixture.root,
  }).inspectRelease({ releaseBundle: built.release.releaseBundle });
  const entry = Object.freeze({
    path: packagePath,
    contentHash: inspected.packageContentHash,
    symbolicLink: false,
  });
  const currentNode = Object.freeze({
    campaignId: campaign.campaignId,
    nodeId: built.node.nodeId,
    kind: 'package',
    status: 'running',
    attemptId: 'later-attempt',
    leaseGeneration: 2,
  });
  const transaction = Object.freeze({
    campaignId: campaign.campaignId,
    packageNodeId: currentNode.nodeId,
    packageAttemptId: built.node.attemptId,
    leaseGeneration: 1,
    packageDir: packagePath,
    preparedParent: packagePath,
    abortedParent: path.join(fixture.root, 'packages', '.unused-aborted'),
    campaignReleasePackageBuildingTransactionHash: h('published-building-transaction'),
    campaignReleasePackageBuildingFenceHash: h('published-building-fence'),
    supersedingPackageAttemptId: currentNode.attemptId,
    supersedingLeaseGeneration: currentNode.leaseGeneration,
    campaignReleasePackagePreparedTransactionHash: null,
    stagingEntries: Object.freeze([Object.freeze({
      path: packagePath,
      contentHash: entry.contentHash,
      campaignReleasePackageBuildingMarkerHash: h('forged-overlap-marker'),
    })]),
  });
  const declaration = packageLifecycleDeclaration({
    runtimeRoot: fixture.root,
    entries: [entry],
    campaigns: Object.freeze({
      rows: Object.freeze([campaign]),
      nodes: Object.freeze([currentNode]),
      hash: h('published-overlap-campaigns'),
    }),
    // Simulate a concurrently incomplete release inventory: the immutable
    // lifecycle row must still dominate the staging journal.
    releases: Object.freeze({ rows: Object.freeze([]), hash: h('empty-releases') }),
    receiptLedger: fixture.receiptLedger,
    casInventory: Object.freeze({ rows: Object.freeze([]), hash: h('empty-cas') }),
    fencedTransactions: Object.freeze({
      rows: Object.freeze([transaction]),
      hash: h('published-overlap-fenced-inventory'),
    }),
  }).declaration;
  assert.equal(declaration.deletionEvidence.length, 0);
  assert.deepEqual(declaration.recoveryProtectedPaths, [packagePath]);
});

test('lifecycle materialization rejects post-release physical package tree tampering', (t) => {
  const root = testRoot(t);
  const inspector = createPackageLifecycleMaterializationInspector({
    runtimeRoot: root,
  });
  const createRelease = (label) => {
    const campaign = campaignFixture({ campaignId: `physical-${label}` });
    const packagePath = packageFixture(root, `physical-${label}`);
    const built = releaseFixture({
      campaign,
      packagePath,
      promotedAt: '2026-07-21T08:05:00.000Z',
    });
    assert.doesNotThrow(() => inspector.inspectRelease({
      releaseBundle: built.release.releaseBundle,
    }));
    return { built, packagePath };
  };

  const extra = createRelease('extra');
  fs.chmodSync(extra.packagePath, 0o700);
  fs.writeFileSync(path.join(extra.packagePath, 'UNBOUND.bin'), 'unbound', {
    mode: 0o444,
  });
  fs.chmodSync(extra.packagePath, 0o500);
  assert.throws(() => inspector.inspectRelease({
    releaseBundle: extra.built.release.releaseBundle,
  }), /campaign_release_package_output_exact_tree_invalid/);

  const symlink = createRelease('symlink');
  const symlinkRecord = path.join(symlink.packagePath, 'PACKAGE_RECORD.json');
  fs.chmodSync(symlink.packagePath, 0o700);
  fs.unlinkSync(symlinkRecord);
  fs.symlinkSync('/dev/null', symlinkRecord);
  fs.chmodSync(symlink.packagePath, 0o500);
  assert.throws(() => inspector.inspectRelease({
    releaseBundle: symlink.built.release.releaseBundle,
  }), /campaign_release_package_output_(?:file_invalid|entry_unsafe)/);

  const hardlink = createRelease('hardlink');
  fs.linkSync(
    path.join(hardlink.packagePath, 'PACKAGE_RECORD.json'),
    path.join(root, 'hardlink-alias.json'),
  );
  assert.throws(() => inspector.inspectRelease({
    releaseBundle: hardlink.built.release.releaseBundle,
  }), /campaign_release_package_output_(?:file_invalid|entry_unsafe)/);

  const content = createRelease('content');
  const contentRecord = path.join(content.packagePath, 'PACKAGE_RECORD.json');
  fs.chmodSync(contentRecord, 0o644);
  fs.writeFileSync(contentRecord, 'tampered\n');
  fs.chmodSync(contentRecord, 0o444);
  assert.throws(() => inspector.inspectRelease({
    releaseBundle: content.built.release.releaseBundle,
  }), /campaign_release_package_output_file_invalid/);
});

test('attempt fence and forged intent ledger metadata are rejected', (t) => {
  const fixture = authorityFixture(t);
  const campaign = campaignFixture({ campaignId: 'fenced' });
  const built = releaseFixture({
    campaign,
    packagePath: packageFixture(fixture.root, 'fenced'),
    promotedAt: '2026-07-21T08:05:00.000Z',
  });
  fixture.campaigns.set(campaign.campaignId, campaign);
  fixture.nodes.set(campaign.campaignId, [built.node]);
  const service = fixture.createService();
  assert.throws(() => service.prepareCurrentReleaseRecording({
    campaignId: campaign.campaignId,
    nodeId: built.node.nodeId,
    workerId: 'wrong-worker',
    attemptId: built.node.attemptId,
    leaseGeneration: 1,
    preparedResultHash: built.node.preparedResultHash,
  }), /package_lifecycle_recording_intent_attempt_fence_invalid/);
  assert.equal(rows(fixture.receiptLedger, 'package-lifecycle-intents').length, 0);
  const inspection = createPackageLifecycleMaterializationInspector({
    runtimeRoot: fixture.root,
  }).inspectRelease({ releaseBundle: built.release.releaseBundle });
  const conflict = createPackageLifecycleRecordingIntent({
    runtimeRoot: fixture.root,
    campaign,
    packageNode: built.node,
    packageResult: built.packageResult,
    packagePath: inspection.packagePath,
    packageContentHash: inspection.packageContentHash,
    preparedAt: '2026-07-21T08:04:00.001Z',
  });
  fixture.receiptLedger.record(conflict, {
    stream: 'package-lifecycle-intents',
    paperId: campaign.paperId,
    environment: 'administrative',
    evidenceClass: 'package_lifecycle_intent',
  });
  assert.throws(() => service.prepareCurrentReleaseRecording({
    campaignId: campaign.campaignId,
    nodeId: built.node.nodeId,
    workerId: built.node.leaseOwner,
    attemptId: built.node.attemptId,
    leaseGeneration: 1,
    preparedResultHash: built.node.preparedResultHash,
  }), /package_lifecycle_recording_intent_conflict/);
  assert.equal(rows(fixture.receiptLedger, 'package-lifecycle-intents').length, 1);
});

test('authority and retention scans remain complete beyond one thousand immutable receipts', (t) => {
  const fixture = authorityFixture(t);
  const campaign = campaignFixture({ campaignId: 'paged-generation', paperId: 'paged-paper' });
  const built = releaseFixture({
    campaign,
    packagePath: packageFixture(fixture.root, 'paged-generation'),
    promotedAt: '2026-07-21T08:05:00.000Z',
  });
  fixture.campaigns.set(campaign.campaignId, campaign);
  fixture.nodes.set(campaign.campaignId, [built.node]);
  const inspection = createPackageLifecycleMaterializationInspector({
    runtimeRoot: fixture.root,
  }).inspectRelease({ releaseBundle: built.release.releaseBundle });
  const service = fixture.createService();
  service.prepareCurrentReleaseRecording({
    campaignId: campaign.campaignId,
    nodeId: built.node.nodeId,
    workerId: built.node.leaseOwner,
    attemptId: built.node.attemptId,
    leaseGeneration: built.node.leaseGeneration,
    preparedResultHash: built.node.preparedResultHash,
  });
  for (let index = 0; index < 1004; index += 1) {
    const dummyCampaign = {
      campaignId: `paged-dummy-${index}`,
      paperId: campaign.paperId,
      spec: { campaignPlanHash: h(`paged-dummy-plan:${index}`) },
    };
    const dummyNode = {
      ...built.node,
      nodeId: `paged-dummy-node-${index}`,
      attemptId: `paged-dummy-attempt-${index}`,
      leaseGeneration: index + 2,
      preparedIntegrationKey: h(`paged-dummy-descriptor:${index}`),
      preparedIntegrationReceiptHash: h(`paged-dummy-integration:${index}`),
    };
    const intent = createPackageLifecycleRecordingIntent({
      runtimeRoot: fixture.root,
      campaign: dummyCampaign,
      packageNode: dummyNode,
      packageResult: built.packageResult,
      packagePath: inspection.packagePath,
      packageContentHash: inspection.packageContentHash,
      preparedAt: new Date(Date.parse('2026-07-21T08:06:00.000Z') + index).toISOString(),
    });
    fixture.receiptLedger.record(intent, {
      stream: 'package-lifecycle-intents',
      paperId: campaign.paperId,
      environment: 'administrative',
      evidenceClass: 'package_lifecycle_intent',
    });
  }
  const offsetIgnoringLedger = {
    record: (...args) => fixture.receiptLedger.record(...args),
    list: (options) => fixture.receiptLedger.list({ ...options, offset: 0 }),
  };
  assert.throws(
    () => fixture.createService({ ledger: offsetIgnoringLedger }).reconcile(),
    /package_lifecycle_ledger_inventory_unstable/,
  );
  fixture.complete({ campaign, node: built.node, release: built.release });
  assert.equal(service.reconcileCampaign({ campaignId: campaign.campaignId }).reconciledCount, 1);
  const lifecycleRow = fixture.receiptLedger.list({
    stream: 'package-lifecycle',
    environment: 'administrative',
    includeQualified: false,
    limit: 1,
  })[0];
  const lifecycle = JSON.parse(lifecycleRow.receipt_json);
  for (let index = 0; index < 1005; index += 1) {
    const hold = createPackageRetentionLegalHoldReceipt({
      lifecycleReceipt: lifecycle,
      reasonHash: h(`paged-legal-hold:${index}`),
      createdAt: new Date(Date.parse('2026-07-21T08:30:00.000Z') + index).toISOString(),
    });
    fixture.receiptLedger.record(hold, {
      stream: 'package-lifecycle',
      paperId: campaign.paperId,
      environment: 'administrative',
      evidenceClass: 'package_legal_hold',
    });
  }
  assert.equal(fixture.receiptLedger.list({
    stream: 'package-lifecycle-intents',
    environment: 'administrative',
    includeQualified: false,
    limit: 1000,
    offset: 1000,
  }).length, 5);
  assert.equal(fixture.receiptLedger.list({
    stream: 'package-lifecycle',
    environment: 'administrative',
    includeQualified: false,
    limit: 1000,
    offset: 1000,
  }).length, 6);
  assert.equal(service.reconcileCampaign({ campaignId: campaign.campaignId }).reconciledCount, 1);
  const retention = packageLifecycleDeclaration({
    runtimeRoot: fixture.root,
    entries: [],
    campaigns: { hash: h('campaign-inventory'), rows: [], nodes: [] },
    releases: { hash: h('release-inventory'), rows: [] },
    receiptLedger: fixture.receiptLedger,
    casInventory: { hash: h('cas-inventory'), rows: [] },
  });
  assert.equal(retention.authority.complete, true);
});

test('malformed lifecycle ledger JSON fails closed before package deletion authority is derived', (t) => {
  const root = testRoot(t);
  const packagePath = packageFixture(root, 'malformed-ledger-generation');
  const entry = Object.freeze({
    path: packagePath,
    contentHash: retentionMemberHash(packagePath),
    symbolicLink: false,
  });
  const malformedRow = Object.freeze({
    receipt_id: 'package-lifecycle:malformed-ledger-row',
    receipt_json: '{not-json',
  });
  const declaration = packageLifecycleDeclaration({
    runtimeRoot: root,
    entries: [entry],
    campaigns: Object.freeze({ rows: [], nodes: [], hash: h('campaign-inventory') }),
    releases: Object.freeze({ rows: [], hash: h('release-inventory') }),
    receiptLedger: Object.freeze({ list: () => [malformedRow] }),
    casInventory: Object.freeze({ rows: [], hash: h('cas-inventory') }),
  });

  assert.equal(declaration.authority.complete, false);
  assert.deepEqual(
    declaration.authority.blockers,
    ['package_lifecycle_ledger_incomplete_or_invalid'],
  );
  assert.deepEqual(declaration.declaration.deletionEvidence, []);
  assert.deepEqual(declaration.declaration.recoveryProtectedPaths, [packagePath]);
});
