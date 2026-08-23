import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLedgerBackedRuntimeRetentionReachabilityProvider } from '../../paper-adapters/automation/runtime-retention-reachability-provider-repository.mjs';
import { beginCampaignReleasePackageBuildTransactionSync }
  from '../../paper-adapters/automation/campaign-release-package-build-transaction-repository.mjs';
import { listRuntimeRetentionEntries } from '../../paper-adapters/automation/runtime-retention-scope-repository.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from '../../paper-adapters/automation/package-recovery-tree-inventory-repository.mjs';
import {
  buildRuntimeRetentionPlan,
  executeRuntimeRetentionPlan,
  reconcileRuntimeRetentionIntents,
} from '../../paper-adapters/automation/runtime-retention.mjs';
import { createWorkspaceRegistry } from '../../paper-adapters/automation/workspace-registry.mjs';
import { exportWorkspaceSnapshot, restoreWorkspaceSnapshot } from '../../paper-adapters/automation/workspace-snapshot-exporter.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import {
  issuePackageLifecycleWriter,
  issueRuntimeRetentionWriter,
  issueWorkspaceSnapshotVerifierWriter,
} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  createPackageLifecycleReceipt,
  createPackageRetentionLegalHoldReceipt,
  createPackageSupersessionReceipt,
  verifyPackageSupersessionReceipt,
} from '../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import { PACKAGE_LIFECYCLE_LEGACY_ISSUER_POLICY_HASHES }
  from '../../paper-domain/evidence/receipt-issuer-policy-registry.mjs';
import { verifyTrustedPackageRecoveryReceipt }
  from '../../paper-ports/package-recovery-authority-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createTrustedPackageRecoveryAuthorityFixture }
  from './support/package-recovery-authority-fixture.mjs';

const CLOCK = Object.freeze({
  nowIso: () => '2026-07-21T06:00:00.000Z',
  now: () => new Date('2026-07-21T06:00:00.000Z'),
});

function h(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function allGovernedPolicies() {
  return Object.fromEntries([
    'workspace-snapshots',
    'automation-artifacts',
    'packages',
    'artifact-cas',
  ].map((category) => [category, { maxBytes: 0, maxAgeMs: 0, keepNewest: 0 }]));
}

function emptyCampaignStore(campaigns = []) {
  return Object.freeze({
    listCampaigns({ offset = 0, limit = 1000 } = {}) {
      return campaigns.slice(offset, offset + limit);
    },
    listNodes(campaignId) {
      const campaign = campaigns.find((entry) => entry.campaignId === campaignId);
      return campaign ? [{
        campaignId,
        nodeId: `${campaignId}:node`,
        kind: 'writer',
        status: campaign.status === 'running' ? 'running' : 'completed',
        attemptId: campaign.status === 'running' ? `${campaignId}:attempt` : null,
        leaseGeneration: campaign.status === 'running' ? 1 : 0,
        resultSha256: campaign.status === 'running' ? null : h(`${campaignId}:node-result`),
        failureSha256: null,
        updatedAt: campaign.updatedAt,
      }] : [];
    },
  });
}

function releaseQuery(releases = new Map()) {
  return Object.freeze({
    getCurrentRelease({ campaignId }) { return releases.get(campaignId) || null; },
  });
}

function testRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createStoreFixture(t, root) {
  let tick = 0;
  const clock = Object.freeze({
    nowIso: () => new Date(Date.parse('2026-07-21T04:00:00.000Z') + tick++ * 1000).toISOString(),
    now: () => new Date(Date.parse('2026-07-21T04:00:00.000Z') + tick * 1000),
  });
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'ledger.sqlite') });
  t.after(() => store.close());
  const snapshotLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issueWorkspaceSnapshotVerifierWriter(),
  });
  const retentionLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issueRuntimeRetentionWriter(),
  });
  return { store, snapshotLedger, retentionLedger, clock };
}

function createTwoVerifiedSnapshots({ root, store, snapshotLedger, clock }) {
  const suffix = crypto.randomUUID();
  const paperId = `paper-${suffix}`;
  const campaignId = `campaign-${suffix}`;
  const nodeId = `node-${suffix}`;
  assert.equal(store.execute(`INSERT INTO papers(slug,title,canonical_dir,source_dir) VALUES('${paperId}','Paper','.','.');`).ok, true);
  createSqliteCampaignStore({ store, clock }).createCampaign({
    campaignId,
    paperId,
    maxRounds: 1,
    nodes: [{ nodeId, kind: 'draft', dependencies: [] }],
  });
  const registry = createWorkspaceRegistry({ store, clock, receiptLedger: snapshotLedger });
  const workspaceId = `workspace-${suffix}`;
  const workspacePath = path.join(root, 'automation-workspaces', workspaceId);
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'payload'), 'generation-one\n');
  registry.register({ workspaceId, campaignId, nodeId, sourcePath: '/source', workspacePath });
  const first = exportWorkspaceSnapshot({
    registry,
    workspaceId,
    workspacePath,
    exportRoot: path.join(root, 'workspace-snapshots'),
  });
  restoreWorkspaceSnapshot({
    receipt: first,
    restoreRoot: path.join(root, 'restore-checks', 'one'),
    registry,
    restoreReceiptLedger: snapshotLedger,
    workspaceId,
    verifiedAt: '2026-07-21T05:00:00.000Z',
  });
  fs.writeFileSync(path.join(workspacePath, 'payload'), 'generation-two\n');
  const second = exportWorkspaceSnapshot({
    registry,
    workspaceId,
    workspacePath,
    exportRoot: path.join(root, 'workspace-snapshots'),
  });
  restoreWorkspaceSnapshot({
    receipt: second,
    restoreRoot: path.join(root, 'restore-checks', 'two'),
    registry,
    restoreReceiptLedger: snapshotLedger,
    workspaceId,
    verifiedAt: '2026-07-21T05:30:00.000Z',
  });
  return { registry, first, second };
}

function createCasFixture(root) {
  const casRoot = path.join(root, 'artifact-cas');
  const manifestRoot = path.join(casRoot, 'manifests');
  const objectsRoot = path.join(casRoot, 'objects', 'sha256');
  fs.mkdirSync(manifestRoot, { recursive: true });
  const referencedBytes = Buffer.from('referenced-object\n');
  const referencedHash = h(referencedBytes);
  const referencedDigest = referencedHash.slice(7);
  const referencedObject = path.join(objectsRoot, referencedDigest.slice(0, 2), referencedDigest.slice(2));
  fs.mkdirSync(path.dirname(referencedObject), { recursive: true });
  fs.writeFileSync(referencedObject, referencedBytes);
  const manifestPayload = {
    version: 1,
    kind: 'ImmutableArtifactManifest',
    repositoryId: 'test-cas',
    role: 'result',
    contentType: 'application/json',
    logicalPath: 'result.json',
    contentHash: referencedHash,
    bytes: referencedBytes.length,
    objectPath: `objects/sha256/${referencedDigest.slice(0, 2)}/${referencedDigest.slice(2)}`,
    createdAt: '2026-07-21T05:00:00.000Z',
  };
  const manifestHash = hashRecord('ImmutableArtifactManifest', manifestPayload);
  fs.writeFileSync(path.join(manifestRoot, `${manifestHash.slice(7)}.json`), `${JSON.stringify({
    ...manifestPayload,
    manifestHash,
  })}\n`);
  const orphanBytes = Buffer.from('orphan-object\n');
  let orphanHash = h(orphanBytes);
  while (orphanHash.slice(7, 9) === referencedDigest.slice(0, 2)) {
    orphanHash = h(`${orphanBytes.toString()}${orphanHash}`);
  }
  const orphanDigest = orphanHash.slice(7);
  const orphanObject = path.join(objectsRoot, orphanDigest.slice(0, 2), orphanDigest.slice(2));
  fs.mkdirSync(path.dirname(orphanObject), { recursive: true });
  fs.writeFileSync(orphanObject, orphanBytes);
  return {
    referencedPrefix: path.dirname(referencedObject),
    orphanPrefix: path.dirname(orphanObject),
  };
}

test('ledger-backed provider authorizes only superseded verified snapshots and manifest-unreachable CAS prefixes', (t) => {
  const root = testRoot(t, 'hepta-retention-provider-roots-');
  const { store, snapshotLedger, clock } = createStoreFixture(t, root);
  const { registry, first, second } = createTwoVerifiedSnapshots({ root, store, snapshotLedger, clock });
  const cas = createCasFixture(root);
  const provider = createLedgerBackedRuntimeRetentionReachabilityProvider({
    runtimeRoot: root,
    campaignStore: emptyCampaignStore(),
    campaignReleaseQuery: releaseQuery(),
    workspaceRegistry: registry,
    receiptLedger: snapshotLedger,
    clock: CLOCK,
  });
  const manifest = provider.createManifest({ persist: true });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    workspaceRecords: registry.retentionRecords(),
    receiptLedger: snapshotLedger,
    reachabilityManifest: manifest,
    policies: allGovernedPolicies(),
    nowMs: Date.parse('2026-07-21T07:00:00.000Z'),
  });
  assert.equal(plan.removals.some((entry) => entry.path === first.archivePath), true);
  assert.equal(plan.removals.some((entry) => entry.path === second.archivePath), false);
  assert.equal(plan.removals.some((entry) => entry.path === cas.orphanPrefix), true);
  assert.equal(plan.removals.some((entry) => entry.path === cas.referencedPrefix), false);
  assert.equal(provider.loadManifest({ manifestHash: manifest.runtimeRetentionReachabilityManifestHash })
    ?.runtimeRetentionReachabilityManifestHash, manifest.runtimeRetentionReachabilityManifestHash);
});

function campaignRecord(overrides) {
  return Object.freeze({
    campaignId: 'campaign',
    paperId: 'paper',
    status: 'completed',
    effectiveStatus: 'completed',
    parentCampaignId: null,
    supersedesCampaignId: null,
    recoveryOfCampaignId: null,
    revision: 1,
    updatedAt: '2026-07-21T05:00:00.000Z',
    spec: { campaignPlanHash: h('plan') },
    ...overrides,
  });
}

function currentRelease(campaign) {
  return Object.freeze({
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    packageNodeId: `${campaign.campaignId}:package`,
    packageResultHash: h(`${campaign.campaignId}:result`),
    campaignReleaseBundleHash: h(`${campaign.campaignId}:bundle`),
    materializationReceiptHash: h(`${campaign.campaignId}:materialization`),
    status: 'current_completed_release',
    promotedAt: '2026-07-21T05:30:00.000Z',
  });
}

function artifactDirectory(root, name) {
  const candidate = path.join(root, 'automation-artifacts', name);
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, 'result.json'), `${name}\n`);
  return candidate;
}

test('campaign and release authority deletes only a superseded campaign root and protects package roots', (t) => {
  const root = testRoot(t, 'hepta-retention-provider-campaigns-');
  const old = campaignRecord({ campaignId: 'old', paperId: 'paper-a', effectiveStatus: 'superseded' });
  const successor = campaignRecord({ campaignId: 'successor', paperId: 'paper-a', supersedesCampaignId: 'old' });
  const active = campaignRecord({ campaignId: 'active', paperId: 'paper-b', status: 'running', effectiveStatus: 'running' });
  const oldPath = artifactDirectory(root, 'old');
  const successorPath = artifactDirectory(root, 'successor');
  const activePath = artifactDirectory(root, 'active');
  const unknownPath = artifactDirectory(root, 'unknown');
  for (const name of ['paper-a', 'orphan-package']) {
    const candidate = path.join(root, 'packages', name);
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(path.join(candidate, 'PACKAGE_RECORD.json'), '{}\n');
  }
  const releases = new Map([[successor.campaignId, currentRelease(successor)]]);
  const provider = createLedgerBackedRuntimeRetentionReachabilityProvider({
    runtimeRoot: root,
    campaignStore: emptyCampaignStore([old, successor, active]),
    campaignReleaseQuery: releaseQuery(releases),
    workspaceRegistry: { snapshotRetentionRecords: () => [] },
    receiptLedger: { get: () => null },
    clock: CLOCK,
  });
  const manifest = provider.createManifest();
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest: manifest,
    policies: allGovernedPolicies(),
    nowMs: Date.parse('2026-07-21T07:00:00.000Z'),
  });
  assert.equal(plan.removals.some((entry) => entry.path === oldPath), true);
  for (const protectedPath of [successorPath, activePath, unknownPath]) {
    assert.equal(plan.removals.some((entry) => entry.path === protectedPath), false);
  }
  assert.equal(plan.removals.some((entry) => entry.category === 'packages'), false);
  assert.equal(plan.categories.find((entry) => entry.category === 'automation-artifacts').activeReferenceProtectedCount, 1);
  assert.equal(plan.categories.find((entry) => entry.category === 'automation-artifacts').releaseDependencyProtectedCount, 1);
  assert.equal(plan.categories.find((entry) => entry.category === 'packages').releaseDependencyProtectedCount, 0);
  assert.equal(plan.categories.find((entry) => entry.category === 'packages').recoveryProtectedCount, 2);
});

function packageDirectory(root, name, content) {
  const candidate = path.join(root, 'packages', name);
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, 'PACKAGE_RECORD.json'), `${content}\n`);
  return candidate;
}

function lifecycleRelease(campaign, packagePath, promotedAt) {
  return Object.freeze({
    ...currentRelease(campaign),
    packagePath,
    immutableCampaignPackageOutputHash: h(`${campaign.campaignId}:immutable-package-output`),
    packageNodeStatus: 'completed',
    campaignStatus: 'completed',
    promotedAt,
  });
}

const PACKAGE_AUTHORITY_EVIDENCE_CLASS = Object.freeze({
  PackageLifecycleReceipt: 'package_lifecycle',
  PackageSupersessionReceipt: 'package_supersession',
  PackageRetentionRecoveryReceipt: 'package_recovery',
  PackageRetentionLegalHoldReceipt: 'package_legal_hold',
});

const PACKAGE_AUTHORITY_HASH_FIELD = Object.freeze({
  PackageLifecycleReceipt: 'packageLifecycleReceiptHash',
  PackageSupersessionReceipt: 'packageSupersessionReceiptHash',
  PackageRetentionRecoveryReceipt: 'packageRetentionRecoveryReceiptHash',
  PackageRetentionLegalHoldReceipt: 'packageRetentionLegalHoldReceiptHash',
});

function recordPackageAuthorityReceipt(ledger, receipt) {
  return ledger.record(receipt, {
    stream: 'package-lifecycle',
    paperId: receipt.paperId || receipt.releaseIdentity.paperId,
    environment: 'administrative',
    evidenceClass: PACKAGE_AUTHORITY_EVIDENCE_CLASS[receipt.kind],
    strictInsert: true,
  });
}

function packageAuthorityLedgerRow(template, receipt, overrides = {}) {
  const receiptHash = receipt[PACKAGE_AUTHORITY_HASH_FIELD[receipt.kind]];
  return Object.freeze({
    ...template,
    receipt_id: `package-lifecycle:${receiptHash}`,
    paper_id: receipt.paperId || receipt.releaseIdentity?.paperId,
    kind: receipt.kind,
    status: receipt.status,
    receipt_json: JSON.stringify(receipt),
    receipt_sha256: receiptHash,
    evidence_class: PACKAGE_AUTHORITY_EVIDENCE_CLASS[receipt.kind],
    ...overrides,
  });
}

function createLegacyPackageSupersessionReceipt({
  predecessorLifecycleReceipt,
  successorLifecycleReceipt,
  recordedAt,
}) {
  const recoveryPayload = {
    version: 1,
    kind: 'PackageRecoveryVerification',
    status: 'successor_package_recovery_verified',
    recoveryMode: 'current_successor_package_materialization',
    predecessorPackageContentHash: predecessorLifecycleReceipt.packageContentHash,
    successorPackageContentHash: successorLifecycleReceipt.packageContentHash,
    successorLifecycleReceiptHash:
      successorLifecycleReceipt.packageLifecycleReceiptHash,
    successorReleaseIdentityHash:
      successorLifecycleReceipt.packageReleaseIdentityHash,
    successorPackagePresent: true,
    successorPackageHashVerified: true,
    successorReleaseCurrent: true,
    restoreSourceAvailable: true,
    productionPackageMutated: false,
    externalActionPerformed: false,
    verifiedAt: recordedAt,
  };
  const recoveryVerification = Object.freeze({
    ...recoveryPayload,
    packageRecoveryVerificationHash:
      hashRecord('PackageRecoveryVerification', recoveryPayload),
  });
  const referencePayload = {
    version: 1,
    kind: 'PackageRetentionReferenceSnapshot',
    status: 'package_retention_reference_inventory_complete',
    inventoryComplete: true,
    campaignInventoryHash: h('legacy-package-campaign-inventory'),
    currentReleaseInventoryHash: h('legacy-package-release-inventory'),
    casManifestInventoryHash: h('legacy-package-cas-inventory'),
    receiptLedgerInventoryHash: h('legacy-package-ledger-inventory'),
    activeReferenceCampaignIds: [],
    recoveryReferenceCampaignIds: [],
    legalHoldReceiptHashes: [],
    casReferenceManifestHashes: [],
    scannedAt: recordedAt,
  };
  const referenceSnapshot = Object.freeze({
    ...referencePayload,
    packageRetentionReferenceSnapshotHash:
      hashRecord('PackageRetentionReferenceSnapshot', referencePayload),
  });
  const payload = {
    version: 1,
    kind: 'PackageSupersessionReceipt',
    status: 'package_supersession_recovery_verified',
    runtimeRoot: predecessorLifecycleReceipt.runtimeRoot,
    paperId: predecessorLifecycleReceipt.releaseIdentity.paperId,
    lineageKind: 'supersedes',
    predecessorLifecycleReceiptHash:
      predecessorLifecycleReceipt.packageLifecycleReceiptHash,
    successorLifecycleReceiptHash:
      successorLifecycleReceipt.packageLifecycleReceiptHash,
    predecessorReleaseIdentityHash:
      predecessorLifecycleReceipt.packageReleaseIdentityHash,
    successorReleaseIdentityHash:
      successorLifecycleReceipt.packageReleaseIdentityHash,
    predecessorPackagePath: predecessorLifecycleReceipt.packagePath,
    predecessorPackageContentHash: predecessorLifecycleReceipt.packageContentHash,
    successorPackagePath: successorLifecycleReceipt.packagePath,
    successorPackageContentHash: successorLifecycleReceipt.packageContentHash,
    recoveryVerification,
    packageRecoveryVerificationHash:
      recoveryVerification.packageRecoveryVerificationHash,
    referenceSnapshot,
    packageRetentionReferenceSnapshotHash:
      referenceSnapshot.packageRetentionReferenceSnapshotHash,
    recordedAt,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    packageSupersessionReceiptHash:
      hashRecord('PackageSupersessionReceipt', payload),
  });
}

function createPackageCasReference(root, packagePath) {
  const bytes = Buffer.from('package lifecycle reference\n');
  const contentHash = h(bytes);
  const digest = contentHash.slice(7);
  const casRoot = path.join(root, 'artifact-cas');
  const objectPath = path.join(casRoot, 'objects', 'sha256', digest.slice(0, 2), digest.slice(2));
  fs.mkdirSync(path.dirname(objectPath), { recursive: true });
  fs.writeFileSync(objectPath, bytes);
  const payload = {
    version: 1,
    kind: 'ImmutableArtifactManifest',
    repositoryId: 'package-lifecycle-test-cas',
    role: 'package_reference',
    contentType: 'application/json',
    logicalPath: path.relative(root, packagePath),
    contentHash,
    bytes: bytes.length,
    objectPath: `objects/sha256/${digest.slice(0, 2)}/${digest.slice(2)}`,
    createdAt: '2026-07-21T05:55:00.000Z',
  };
  const manifestHash = hashRecord('ImmutableArtifactManifest', payload);
  const manifestRoot = path.join(casRoot, 'manifests');
  fs.mkdirSync(manifestRoot, { recursive: true });
  fs.writeFileSync(path.join(manifestRoot, `${manifestHash.slice(7)}.json`), `${JSON.stringify({
    ...payload,
    manifestHash,
  })}\n`);
}

test('package lifecycle ledger authorizes only the recorded superseded generation and rechecks holds, active recovery, CAS, tamper, and order', (t) => {
  const recoveryFixture = createTrustedPackageRecoveryAuthorityFixture(t, {
    name: 'provider-package-old-generation',
  });
  const root = recoveryFixture.runtimeRoot;
  const { store, clock } = createStoreFixture(t, root);
  const lifecycleLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issuePackageLifecycleWriter(),
  });
  const predecessor = campaignRecord({
    campaignId: recoveryFixture.release.campaignId,
    paperId: recoveryFixture.release.paperId,
    effectiveStatus: 'superseded',
  });
  const successor = campaignRecord({
    campaignId: 'package-successor',
    paperId: predecessor.paperId,
    supersedesCampaignId: predecessor.campaignId,
  });
  const predecessorPath = recoveryFixture.packagePath;
  const successorPath = packageDirectory(root, 'package-successor-generation', 'successor package');
  const packageEntries = listRuntimeRetentionEntries(root, 'packages').entries;
  const successorEntry = packageEntries.find((entry) => entry.path === successorPath);
  const predecessorRelease = recoveryFixture.release;
  const successorRelease = lifecycleRelease(
    successor,
    successorPath,
    '2026-08-18T00:09:00.000Z',
  );
  const predecessorLifecycle = recoveryFixture.lifecycleReceipt;
  const successorLifecycle = createPackageLifecycleReceipt({
    runtimeRoot: root,
    packagePath: successorPath,
    packageContentHash: successorEntry.contentHash,
    packageRecoveryTreeInventoryHash: inspectPackageRecoveryTreeInventorySync({
      packagePath: successorPath,
    }).inventory.packageRecoveryTreeInventoryHash,
    release: successorRelease,
    recordedAt: '2026-08-18T00:10:00.000Z',
  });
  recordPackageAuthorityReceipt(lifecycleLedger, predecessorLifecycle);
  recordPackageAuthorityReceipt(lifecycleLedger, successorLifecycle);
  const supersession = createPackageSupersessionReceipt({
    predecessorLifecycleReceipt: predecessorLifecycle,
    successorLifecycleReceipt: successorLifecycle,
    lineageKind: 'supersedes',
    referenceAuthority: {
      campaignInventoryHash: h('package-campaign-inventory-at-supersession'),
      currentReleaseInventoryHash: h('package-release-inventory-at-supersession'),
      casManifestInventoryHash: h('package-cas-inventory-at-supersession'),
      receiptLedgerInventoryHash: h('package-ledger-inventory-at-supersession'),
    },
    recordedAt: '2026-08-18T00:11:00.000Z',
  });
  recordPackageAuthorityReceipt(lifecycleLedger, supersession);

  const releases = new Map([
    [predecessor.campaignId, predecessorRelease],
    [successor.campaignId, successorRelease],
  ]);
  const providerFor = (
    campaigns,
    receiptLedger = lifecycleLedger,
    releaseAuthority = releases,
  ) =>
    createLedgerBackedRuntimeRetentionReachabilityProvider({
      runtimeRoot: root,
      campaignStore: emptyCampaignStore(campaigns),
      campaignReleaseQuery: releaseQuery(releaseAuthority),
      workspaceRegistry: { snapshotRetentionRecords: () => [] },
      receiptLedger,
      packageRecoveryAuthority: recoveryFixture.authority,
      clock: Object.freeze({
        nowIso: () => '2026-08-18T00:20:00.000Z',
      }),
    });
  const planFor = (provider) => buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest: provider.createManifest(),
    policies: allGovernedPolicies(),
    nowMs: Date.parse('2026-07-21T07:00:00.000Z'),
  });
  const supersessionOnly = planFor(providerFor([predecessor, successor]));
  assert.equal(
    supersessionOnly.removals.some((entry) => entry.path === predecessorPath),
    false,
    'supersession lineage is audit-only without independent recovery authority',
  );
  recordPackageAuthorityReceipt(
    lifecycleLedger,
    recoveryFixture.createRecoveryReceipt(),
  );
  const recordedRows = lifecycleLedger.list({
    stream: 'package-lifecycle',
    environment: 'administrative',
    includeQualified: false,
    limit: 1000,
  });

  const authorized = planFor(providerFor([predecessor, successor]));
  assert.equal(authorized.removals.some((entry) => entry.path === predecessorPath), true);
  assert.equal(authorized.removals.some((entry) => entry.path === successorPath), false);
  assert.equal(fs.existsSync(predecessorPath), true, 'test remains dry-run only');

  const activeRecovery = campaignRecord({
    campaignId: 'package-active-recovery',
    paperId: predecessor.paperId,
    status: 'running',
    effectiveStatus: 'running',
    recoveryOfCampaignId: predecessor.campaignId,
  });
  const activePlan = planFor(providerFor([predecessor, successor, activeRecovery]));
  assert.equal(activePlan.removals.some((entry) => entry.path === predecessorPath), false);

  const reorderedRows = recordedRows.map((row) => row.kind === 'PackageSupersessionReceipt'
    ? { ...row, created_at: '2026-07-21T03:00:00.000Z' }
    : row);
  const reorderedPlan = planFor(providerFor([predecessor, successor], {
    list: () => reorderedRows,
  }));
  assert.equal(reorderedPlan.removals.some((entry) => entry.path === predecessorPath), false);

  const tamperedRows = recordedRows.map((row) => row.kind === 'PackageLifecycleReceipt'
    && JSON.parse(row.receipt_json).packagePath === predecessorPath
    ? { ...row, receipt_json: row.receipt_json.replace(
      'provider-package-old-generation',
      'other-generation',
    ) }
    : row);
  const tamperedPlan = planFor(providerFor([predecessor, successor], {
    list: () => tamperedRows,
  }));
  assert.equal(tamperedPlan.removals.some((entry) => entry.path === predecessorPath), false);

  const missingCurrentSuccessor = planFor(providerFor(
    [predecessor, successor],
    { list: () => recordedRows },
    new Map([[predecessor.campaignId, predecessorRelease]]),
  ));
  assert.equal(missingCurrentSuccessor.removals.some((entry) => entry.path === predecessorPath), false);

  const predecessorRecordPath = path.join(predecessorPath, 'PACKAGE_RECORD.json');
  const originalPredecessorRecord = fs.readFileSync(predecessorRecordPath, 'utf8');
  fs.chmodSync(predecessorRecordPath, 0o644);
  fs.writeFileSync(predecessorRecordPath, 'hash changed after lifecycle receipt\n');
  fs.chmodSync(predecessorRecordPath, 0o444);
  const hashChanged = planFor(providerFor([predecessor, successor], {
    list: () => recordedRows,
  }));
  assert.equal(hashChanged.removals.some((entry) => entry.path === predecessorPath), false);
  fs.chmodSync(predecessorRecordPath, 0o644);
  fs.writeFileSync(predecessorRecordPath, originalPredecessorRecord);
  fs.chmodSync(predecessorRecordPath, 0o444);

  createPackageCasReference(root, predecessorPath);
  const casReferenced = planFor(providerFor([predecessor, successor], {
    list: () => recordedRows,
  }));
  assert.equal(casReferenced.removals.some((entry) => entry.path === predecessorPath), false);

  const legalHold = createPackageRetentionLegalHoldReceipt({
    lifecycleReceipt: predecessorLifecycle,
    reasonHash: h('litigation hold'),
    createdAt: '2026-08-18T00:12:00.000Z',
  });
  recordPackageAuthorityReceipt(lifecycleLedger, legalHold);
  const held = planFor(providerFor([predecessor, successor]));
  assert.equal(held.removals.some((entry) => entry.path === predecessorPath), false);
  assert.equal(fs.existsSync(predecessorPath), true, 'no retention apply was invoked');
});

test('legacy v1 recovery evidence stays protected and cannot splice into v2 deletion authority', (t) => {
  const recoveryFixture = createTrustedPackageRecoveryAuthorityFixture(t, {
    name: 'provider-legacy-recovery-matrix',
  });
  const root = recoveryFixture.runtimeRoot;
  const { store, clock } = createStoreFixture(t, root);
  const lifecycleLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issuePackageLifecycleWriter(),
  });
  const predecessor = campaignRecord({
    campaignId: recoveryFixture.release.campaignId,
    paperId: recoveryFixture.release.paperId,
    effectiveStatus: 'superseded',
  });
  const successor = campaignRecord({
    campaignId: 'legacy-matrix-successor',
    paperId: predecessor.paperId,
    supersedesCampaignId: predecessor.campaignId,
  });
  const predecessorPath = recoveryFixture.packagePath;
  const successorPath = packageDirectory(
    root,
    'legacy-matrix-successor-generation',
    'legacy matrix successor package',
  );
  const successorEntry = listRuntimeRetentionEntries(root, 'packages').entries
    .find((entry) => entry.path === successorPath);
  const predecessorLifecycle = recoveryFixture.lifecycleReceipt;
  const successorRelease = lifecycleRelease(
    successor,
    successorPath,
    '2026-08-18T00:09:00.000Z',
  );
  const successorLifecycle = createPackageLifecycleReceipt({
    runtimeRoot: root,
    packagePath: successorPath,
    packageContentHash: successorEntry.contentHash,
    packageRecoveryTreeInventoryHash: inspectPackageRecoveryTreeInventorySync({
      packagePath: successorPath,
    }).inventory.packageRecoveryTreeInventoryHash,
    release: successorRelease,
    recordedAt: '2026-08-18T00:10:00.000Z',
  });
  const referenceAuthority = {
    campaignInventoryHash: h('legacy-matrix-campaign-inventory'),
    currentReleaseInventoryHash: h('legacy-matrix-release-inventory'),
    casManifestInventoryHash: h('legacy-matrix-cas-inventory'),
    receiptLedgerInventoryHash: h('legacy-matrix-ledger-inventory'),
  };
  const currentSupersession = createPackageSupersessionReceipt({
    predecessorLifecycleReceipt: predecessorLifecycle,
    successorLifecycleReceipt: successorLifecycle,
    lineageKind: 'supersedes',
    referenceAuthority,
    recordedAt: '2026-08-18T00:11:00.000Z',
  });
  const recoveryReceipt = recoveryFixture.createRecoveryReceipt();
  for (const receipt of [
    predecessorLifecycle,
    successorLifecycle,
    currentSupersession,
    recoveryReceipt,
  ]) recordPackageAuthorityReceipt(lifecycleLedger, receipt);
  const recordedRows = lifecycleLedger.list({
    stream: 'package-lifecycle',
    environment: 'administrative',
    includeQualified: false,
    limit: 1000,
  });
  const lifecycleRows = recordedRows.filter((row) =>
    row.kind === 'PackageLifecycleReceipt');
  const supersessionRow = recordedRows.find((row) =>
    row.kind === 'PackageSupersessionReceipt');
  const recoveryRow = recordedRows.find((row) =>
    row.kind === 'PackageRetentionRecoveryReceipt');
  assert.equal(lifecycleRows.length, 2);
  assert.ok(supersessionRow);
  assert.ok(recoveryRow);

  const releases = new Map([
    [predecessor.campaignId, recoveryFixture.release],
    [successor.campaignId, successorRelease],
  ]);
  const declarationFor = (rows) => createLedgerBackedRuntimeRetentionReachabilityProvider({
    runtimeRoot: root,
    campaignStore: emptyCampaignStore([predecessor, successor]),
    campaignReleaseQuery: releaseQuery(releases),
    workspaceRegistry: { snapshotRetentionRecords: () => [] },
    receiptLedger: { list: () => rows },
    packageRecoveryAuthority: recoveryFixture.authority,
    clock: { nowIso: () => '2026-08-18T00:20:00.000Z' },
  }).createManifest().categories.find((entry) => entry.category === 'packages');
  const assertRecoveryProtected = (rows, message) => {
    const declaration = declarationFor(rows);
    assert.equal(
      declaration.deletionEvidence.some((entry) => entry.path === predecessorPath),
      false,
      message,
    );
    assert.equal(
      declaration.recoveryProtectedPaths.includes(predecessorPath),
      true,
      message,
    );
    return declaration;
  };

  const current = declarationFor(recordedRows);
  assert.equal(
    current.deletionEvidence.some((entry) => entry.path === predecessorPath),
    true,
    'the v2 control proves the matrix reaches deletion-authority evaluation',
  );

  const legacySupersession = createLegacyPackageSupersessionReceipt({
    predecessorLifecycleReceipt: predecessorLifecycle,
    successorLifecycleReceipt: successorLifecycle,
    recordedAt: '2026-08-18T00:11:00.000Z',
  });
  const legacyVerification = verifyPackageSupersessionReceipt(legacySupersession, {
    predecessorLifecycleReceipt: predecessorLifecycle,
    successorLifecycleReceipt: successorLifecycle,
  });
  assert.deepEqual({
    valid: legacyVerification.valid,
    version: legacyVerification.version,
    legacy: legacyVerification.legacy,
    deletionAuthorized: legacyVerification.deletionAuthorized,
  }, {
    valid: true,
    version: 1,
    legacy: true,
    deletionAuthorized: false,
  });
  const legacySupersessionRow = packageAuthorityLedgerRow(
    supersessionRow,
    legacySupersession,
    { issuer_policy_hash: PACKAGE_LIFECYCLE_LEGACY_ISSUER_POLICY_HASHES[0] },
  );
  const legacyOnlyRows = [...lifecycleRows, legacySupersessionRow];
  const legacyOnly = assertRecoveryProtected(
    legacyOnlyRows,
    'embedded v1 recovery verification is audit-only',
  );
  assert.equal(legacyOnly.releaseDependentPaths.includes(successorPath), true);
  assertRecoveryProtected(
    [...legacyOnlyRows, recoveryRow],
    'a v2 recovery receipt cannot complete a v1 supersession chain',
  );

  const duplicatePayload = structuredClone(recoveryReceipt);
  delete duplicatePayload.packageRetentionRecoveryReceiptHash;
  duplicatePayload.recordedAt = '2026-08-18T00:07:01.000Z';
  const duplicateRecovery = Object.freeze({
    ...duplicatePayload,
    packageRetentionRecoveryReceiptHash:
      hashRecord('PackageRetentionRecoveryReceipt', duplicatePayload),
  });
  assert.equal(verifyTrustedPackageRecoveryReceipt({
    packageRecoveryAuthority: recoveryFixture.authority,
    recoveryReceipt: duplicateRecovery,
    lifecycleReceipt: predecessorLifecycle,
  }), true, 'both conflicting recovery rows are independently valid');
  const duplicateRecoveryRow = packageAuthorityLedgerRow(
    recoveryRow,
    duplicateRecovery,
    { created_at: '2026-07-21T04:00:04.000Z' },
  );
  assertRecoveryProtected(
    [...recordedRows, duplicateRecoveryRow],
    'two valid recovery receipts for one lifecycle are ambiguous',
  );
  assertRecoveryProtected(
    [...recordedRows, recoveryRow],
    'a duplicate recovery receipt id makes the ledger scan unstable',
  );

  const wrongPolicyRecoveryRow = Object.freeze({
    ...recoveryRow,
    issuer_policy_hash: PACKAGE_LIFECYCLE_LEGACY_ISSUER_POLICY_HASHES[0],
  });
  assertRecoveryProtected(
    [...lifecycleRows, supersessionRow, wrongPolicyRecoveryRow],
    'the legacy issuer policy never qualifies a v2 recovery receipt',
  );

  const fakeRecoveryPayload = {
    version: 1,
    kind: 'PackageRetentionRecoveryReceipt',
    status: legacySupersession.recoveryVerification.status,
    runtimeRoot: root,
    paperId: predecessor.paperId,
    packagePath: predecessorPath,
    packageContentHash: predecessorLifecycle.packageContentHash,
    packageLifecycleReceiptHash:
      predecessorLifecycle.packageLifecycleReceiptHash,
    recoveryVerification: legacySupersession.recoveryVerification,
    packageRecoveryVerificationHash:
      legacySupersession.packageRecoveryVerificationHash,
    recordedAt: legacySupersession.recordedAt,
    externalActionPerformed: false,
  };
  const fakeRecoveryReceipt = Object.freeze({
    ...fakeRecoveryPayload,
    packageRetentionRecoveryReceiptHash:
      hashRecord('PackageRetentionRecoveryReceipt', fakeRecoveryPayload),
  });
  assert.equal(verifyTrustedPackageRecoveryReceipt({
    packageRecoveryAuthority: recoveryFixture.authority,
    recoveryReceipt: fakeRecoveryReceipt,
    lifecycleReceipt: predecessorLifecycle,
  }), false);
  const fakeRecoveryRow = packageAuthorityLedgerRow(recoveryRow, fakeRecoveryReceipt);
  assertRecoveryProtected(
    [...lifecycleRows, supersessionRow, fakeRecoveryRow],
    'a standalone v1-shaped recovery row cannot create deletion evidence',
  );
});

function restoreWritableTree(candidate) {
  if (!fs.existsSync(candidate)) return;
  const stat = fs.lstatSync(candidate);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.chmodSync(candidate, 0o700);
    for (const name of fs.readdirSync(candidate)) {
      restoreWritableTree(path.join(candidate, name));
    }
  } else if (stat.isFile()) fs.chmodSync(candidate, 0o600);
}

function writeFencedBuildingJournal(transaction, successor) {
  const payload = {
    version: 1,
    kind: 'CampaignReleasePackageBuildingFence',
    status: 'campaign_release_package_building_fenced',
    campaignId: transaction.record.campaignId,
    packageNodeId: transaction.record.packageNodeId,
    supersededPackageAttemptId: transaction.record.packageAttemptId,
    supersededLeaseGeneration: transaction.record.leaseGeneration,
    campaignReleasePackageBuildingTransactionHash:
      transaction.record.campaignReleasePackageBuildingTransactionHash,
    supersedingPackageAttemptId: successor.packageAttemptId,
    supersedingLeaseGeneration: successor.leaseGeneration,
    supersedingReleaseRoot: successor.releaseRoot,
    fencedAt: successor.createdAt,
  };
  const record = {
    ...payload,
    campaignReleasePackageBuildingFenceHash: hashRecord(
      'CampaignReleasePackageBuildingFence',
      payload,
    ),
  };
  fs.writeFileSync(
    path.join(
      transaction.record.releaseRoot,
      'CAMPAIGN_RELEASE_PACKAGE_BUILDING_FENCED.json',
    ),
    `${JSON.stringify(record, null, 2)}\n`,
    { flag: 'wx', mode: 0o444 },
  );
  return Object.freeze(record);
}

function fencedStagingRetentionFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-retention-fenced-staging-'));
  const { retentionLedger } = createStoreFixture(t, root);
  t.after(() => {
    restoreWritableTree(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const campaignId = `fenced-${crypto.randomUUID()}`;
  const packageNodeId = `${campaignId}:package`;
  const nodeRoot = path.join(root, 'campaign-releases', campaignId, packageNodeId);
  const releaseRoot = path.join(nodeRoot, 'attempt-stale');
  const successorReleaseRoot = path.join(nodeRoot, 'attempt-current');
  fs.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(successorReleaseRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true, mode: 0o700 });
  const campaignPlanHash = h(`${campaignId}:plan`);
  const transaction = beginCampaignReleasePackageBuildTransactionSync({
    runtimeRoot: root,
    releaseRoot,
    packageDir: path.join(root, 'packages', 'never-published'),
    binding: {
      campaignId,
      campaignPlanHash,
      packageNodeId,
      packageAttemptId: 'attempt-stale',
      leaseGeneration: 1,
      sourceSnapshotHash: h(`${campaignId}:snapshot`),
      sourceWorkspaceManifestHash: h(`${campaignId}:workspace`),
      createdAt: '2026-08-18T00:00:00.000Z',
    },
  });
  const partialPath = path.join(transaction.preparedPackageDir, 'partial.bin');
  fs.mkdirSync(transaction.preparedPackageDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(partialPath, 'partial package bytes\n', { mode: 0o444 });
  const successor = {
    packageAttemptId: 'attempt-current',
    leaseGeneration: 2,
    releaseRoot: successorReleaseRoot,
    createdAt: '2026-08-18T00:01:00.000Z',
  };
  writeFencedBuildingJournal(transaction, successor);
  const campaign = campaignRecord({
    campaignId,
    status: 'running',
    effectiveStatus: 'running',
    spec: { campaignPlanHash },
  });
  const nodeState = {
    campaignId,
    nodeId: packageNodeId,
    kind: 'package',
    status: 'running',
    attemptId: successor.packageAttemptId,
    leaseGeneration: successor.leaseGeneration,
    resultSha256: null,
    failureSha256: null,
    updatedAt: successor.createdAt,
  };
  const releases = new Map();
  const provider = createLedgerBackedRuntimeRetentionReachabilityProvider({
    runtimeRoot: root,
    campaignStore: {
      listCampaigns: ({ offset = 0, limit = 1000 } = {}) =>
        [campaign].slice(offset, offset + limit),
      listNodes: (selectedCampaignId) =>
        selectedCampaignId === campaignId ? [{ ...nodeState }] : [],
    },
    campaignReleaseQuery: releaseQuery(releases),
    workspaceRegistry: { snapshotRetentionRecords: () => [] },
    receiptLedger: { list: () => [] },
    clock: { nowIso: () => '2026-08-18T00:20:00.000Z' },
  });
  const manifest = provider.createManifest({ persist: true });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest: manifest,
    policies: allGovernedPolicies(),
    nowMs: Date.parse('2026-08-18T00:30:00.000Z'),
  });
  const removal = plan.removals.find((entry) =>
    entry.path === transaction.preparedParent);
  assert.equal(removal?.retentionDeletionEvidence?.evidenceKind,
    'package_fenced_staging_generation_verified');
  return {
    root,
    campaign,
    nodeState,
    releases,
    transaction,
    partialRelative: path.relative(transaction.preparedParent, partialPath),
    provider,
    manifest,
    plan,
    retentionLedger,
  };
}

function retentionTombstoneCount(ledger) {
  return ledger.listRawForAudit({
    stream: 'runtime-retention',
    evidenceClass: 'retention_tombstone',
  }).filter((row) => row.kind === 'RuntimeRetentionReceipt').length;
}

function assertSealedTree(candidate) {
  const stat = fs.lstatSync(candidate);
  assert.equal(stat.mode & 0o222, 0);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(candidate)) {
      assertSealedTree(path.join(candidate, name));
    }
  }
}

test('trusted apply deletes an exact never-published fenced staging generation', (t) => {
  const fixture = fencedStagingRetentionFixture(t);
  const receipt = executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
  });
  assert.equal(receipt.status, 'runtime_retention_applied');
  assert.equal(fs.existsSync(fixture.transaction.preparedParent), false);
  assert.equal(fs.existsSync(fixture.transaction.packageDir), false);
  assert.equal(retentionTombstoneCount(fixture.retentionLedger), 1);
});

test('fenced staging holds the generation lock from final revalidation through irreversible deletion', (t) => {
  const fixture = fencedStagingRetentionFixture(t);
  const leaseModule = new URL(
    '../../paper-adapters/automation/campaign-release-package-generation-lease.mjs',
    import.meta.url,
  ).href;
  let probed = false;
  const receipt = executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
    faultInjector(event) {
      if (probed || event.stage !== 'before_package_tree_final_revalidation') return;
      probed = true;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { acquireCampaignReleasePackageGenerationLeaseSync } = await import(${JSON.stringify(leaseModule)});
        let lease;
        try {
          lease = acquireCampaignReleasePackageGenerationLeaseSync({
            runtimeRoot: process.env.HEPTA_RUNTIME_ROOT,
            releaseRoot: process.env.HEPTA_RELEASE_ROOT,
          });
          process.stdout.write(JSON.stringify({ acquired: true }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ acquired: false, code: error?.code }));
        } finally {
          lease?.release();
        }
      `], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HEPTA_RUNTIME_ROOT: fixture.root,
          HEPTA_RELEASE_ROOT: fixture.transaction.record.releaseRoot,
        },
        timeout: 10_000,
      });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), {
        acquired: false,
        code: 'campaign_release_package_generation_lock_unavailable',
      });
    },
  });
  assert.equal(probed, true);
  assert.equal(receipt.status, 'runtime_retention_applied');
  assert.equal(fs.existsSync(fixture.transaction.preparedParent), false);
  assert.equal(retentionTombstoneCount(fixture.retentionLedger), 1);
});

for (const mutation of ['tree-replacement', 'generation-drift', 'published']) {
  test(`fenced staging ${mutation} at the destructive boundary restores and seals without a tombstone`, (t) => {
    const fixture = fencedStagingRetentionFixture(t);
    let mutated = false;
    assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
      apply: true,
      reachabilityManifest: fixture.manifest,
      reachabilityManifestProvider: fixture.provider,
      retentionReceiptLedger: fixture.retentionLedger,
      packageRecoveryDeletionLeasePort: fixture.packageRecoveryDeletionLeasePort,
      faultInjector(event) {
        if (mutated || event.stage !== 'before_package_tree_irreversible_removal') return;
        mutated = true;
        if (mutation === 'tree-replacement') {
          const recoveryRoot = path.join(fixture.root, 'retention', 'removal-recovery');
          const deletionRoot = fs.readdirSync(recoveryRoot)
            .find((name) => name.startsWith('.hepta-retention-delete-'));
          const partial = path.join(
            recoveryRoot,
            deletionRoot,
            'package',
            fixture.partialRelative,
          );
          const displaced = path.join(fixture.root, 'displaced-partial.bin');
          fs.renameSync(partial, displaced);
          fs.writeFileSync(partial, 'partial package bytes\n', { mode: 0o444 });
        } else if (mutation === 'generation-drift') {
          fixture.nodeState.attemptId = 'attempt-newer';
          fixture.nodeState.leaseGeneration += 1;
        } else {
          fixture.releases.set(fixture.campaign.campaignId, {
            ...currentRelease(fixture.campaign),
            packagePath: fixture.transaction.preparedParent,
          });
        }
      },
    }), /runtime_retention_(?:live_reachability_authority|package_removal_live_authority|fenced_staging_authority)_changed/);
    assert.equal(mutated, true);
    assert.equal(fs.existsSync(fixture.transaction.preparedParent), true);
    assertSealedTree(fixture.transaction.preparedParent);
    assert.equal(fs.readdirSync(path.join(fixture.root, 'packages')).some((name) =>
      name.endsWith('.quarantine')
        || name.startsWith('.hepta-retention-package-delete-')), false);
    const recoveryRoot = path.join(fixture.root, 'retention', 'removal-recovery');
    const recoveryStages = fs.readdirSync(recoveryRoot)
      .filter((name) => name.startsWith('.hepta-retention-delete-'));
    assert.equal(recoveryStages.length, 0);
    assert.equal(retentionTombstoneCount(fixture.retentionLedger), 0);
  });
}


test('crash recovery loads the exact persisted authority and blocks a tampered envelope', (t) => {
  const root = testRoot(t, 'hepta-retention-provider-recovery-');
  const { store, snapshotLedger, retentionLedger, clock } = createStoreFixture(t, root);
  const { registry, first } = createTwoVerifiedSnapshots({ root, store, snapshotLedger, clock });
  const provider = createLedgerBackedRuntimeRetentionReachabilityProvider({
    runtimeRoot: root,
    campaignStore: emptyCampaignStore(),
    campaignReleaseQuery: releaseQuery(),
    workspaceRegistry: registry,
    receiptLedger: snapshotLedger,
    clock: CLOCK,
  });
  const manifest = provider.createManifest({ persist: true });
  const snapshotOnlyPolicies = {
    ...allGovernedPolicies(),
    'automation-artifacts': { maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER, keepNewest: 0 },
    packages: { maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER, keepNewest: 0 },
    'artifact-cas': { maxBytes: Number.MAX_SAFE_INTEGER, maxAgeMs: Number.MAX_SAFE_INTEGER, keepNewest: 0 },
  };
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    workspaceRecords: registry.retentionRecords(),
    receiptLedger: snapshotLedger,
    reachabilityManifest: manifest,
    policies: snapshotOnlyPolicies,
    nowMs: Date.parse('2026-07-21T07:00:00.000Z'),
  });
  assert.equal(plan.removals.length, 1);
  assert.equal(plan.removals[0].path, first.archivePath);
  assert.throws(() => executeRuntimeRetentionPlan(plan, {
    apply: true,
    workspaceRegistry: registry,
    receiptLedger: snapshotLedger,
    reachabilityManifest: manifest,
    reachabilityManifestProvider: provider,
    retentionReceiptLedger: retentionLedger,
    faultInjector(event) {
      if (event.stage === 'after_entry_quarantined') {
        throw new Error('simulated_authority_recovery_crash');
      }
    },
  }), /simulated_authority_recovery_crash/);
  const manifestPath = path.join(
    root,
    'retention-authority',
    'manifests',
    `${manifest.runtimeRetentionReachabilityManifestHash.slice(7)}.json`,
  );
  const originalEnvelope = fs.readFileSync(manifestPath, 'utf8');
  const tampered = JSON.parse(originalEnvelope);
  tampered.authoritySnapshot.blockers.push('tampered');
  fs.writeFileSync(manifestPath, `${JSON.stringify(tampered)}\n`);
  const blocked = reconcileRuntimeRetentionIntents({
    runtimeRoot: root,
    workspaceRegistry: registry,
    receiptLedger: snapshotLedger,
    reachabilityManifestProvider: provider,
    retentionReceiptLedger: retentionLedger,
  });
  assert.equal(blocked.status, 'runtime_retention_recovery_blocked');
  fs.writeFileSync(manifestPath, originalEnvelope);
  const recovered = reconcileRuntimeRetentionIntents({
    runtimeRoot: root,
    workspaceRegistry: registry,
    receiptLedger: snapshotLedger,
    reachabilityManifestProvider: provider,
    retentionReceiptLedger: retentionLedger,
  });
  assert.equal(recovered.status, 'runtime_retention_recovery_complete');
  assert.equal(recovered.recovered[0].status, 'runtime_retention_applied');
});

test('invalid CAS authority and absent ledger ports produce inventory-only protection', (t) => {
  const root = testRoot(t, 'hepta-retention-provider-fail-closed-');
  const invalidManifestRoot = path.join(root, 'artifact-cas', 'manifests');
  const prefix = path.join(root, 'artifact-cas', 'objects', 'sha256', 'aa');
  fs.mkdirSync(invalidManifestRoot, { recursive: true });
  fs.mkdirSync(prefix, { recursive: true });
  fs.writeFileSync(path.join(prefix, '0'.repeat(62)), 'object\n');
  fs.writeFileSync(path.join(invalidManifestRoot, `${'0'.repeat(64)}.json`), '{}\n');
  const artifact = artifactDirectory(root, 'unknown');
  const provider = createLedgerBackedRuntimeRetentionReachabilityProvider({ runtimeRoot: root, clock: CLOCK });
  const manifest = provider.createManifest();
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest: manifest,
    policies: allGovernedPolicies(),
    nowMs: Date.parse('2026-07-21T07:00:00.000Z'),
  });
  assert.equal(plan.removals.some((entry) => entry.path === prefix), false);
  assert.equal(plan.removals.some((entry) => entry.path === artifact), false);
  assert.equal(plan.categories.find((entry) => entry.category === 'artifact-cas').reachabilityInventoryComplete, false);
});

test('reachability provider rejects malformed replay, detached, and unstable authority inputs', (t) => {
  const createdAt = '2026-07-21T06:00:00.000Z';
  const providerFor = (root, overrides = {}) =>
    createLedgerBackedRuntimeRetentionReachabilityProvider({
      runtimeRoot: root,
      campaignStore: emptyCampaignStore(),
      campaignReleaseQuery: releaseQuery(),
      workspaceRegistry: { snapshotRetentionRecords: () => [] },
      receiptLedger: { get: () => null, list: () => [] },
      clock: CLOCK,
      ...overrides,
    });

  const validationRoot = testRoot(t, 'hepta-retention-provider-validation-');
  const validationProvider = providerFor(validationRoot);
  assert.throws(
    () => validationProvider.createManifest({ createdAt: 'not-a-date' }),
    /runtime_retention_authority_created_at_invalid/,
  );
  assert.throws(
    () => validationProvider.createManifest({ detachedPackageEntries: null }),
    /runtime_retention_detached_package_revalidation_invalid/,
  );
  assert.throws(
    () => validationProvider.createManifest({
      detachedPackageEntries: [{
        path: path.join(validationRoot, 'packages', 'detached'),
        contentHash: h('detached'),
      }],
    }),
    /runtime_retention_detached_package_revalidation_invalid/,
  );
  assert.throws(
    () => validationProvider.createManifest({
      createdAt,
      detachedPackageEntries: [{
        path: path.join(validationRoot, 'outside-packages'),
        contentHash: h('detached'),
      }],
    }),
    /runtime_retention_detached_package_revalidation_invalid/,
  );

  const packagePath = packageDirectory(validationRoot, 'conflicting-detached', 'original');
  const packageEntry = listRuntimeRetentionEntries(validationRoot, 'packages').entries
    .find((entry) => entry.path === packagePath);
  assert.ok(packageEntry);
  assert.throws(
    () => validationProvider.createManifest({
      createdAt,
      detachedPackageEntries: [{ path: packagePath, contentHash: h('replacement') }],
    }),
    /runtime_retention_detached_package_revalidation_invalid/,
  );

  assert.equal(validationProvider.loadManifest(), null);
  assert.equal(validationProvider.loadManifest({ manifestHash: h('missing-manifest') }), null);

  const replayRoot = testRoot(t, 'hepta-retention-provider-replay-');
  const replayProvider = providerFor(replayRoot);
  const persisted = replayProvider.createManifest({ persist: true, createdAt });
  assert.equal(
    replayProvider.createManifest({ persist: true, createdAt })
      .runtimeRetentionReachabilityManifestHash,
    persisted.runtimeRetentionReachabilityManifestHash,
  );
  const persistedPath = path.join(
    replayRoot,
    'retention-authority',
    'manifests',
    `${persisted.runtimeRetentionReachabilityManifestHash.slice(7)}.json`,
  );
  const collidedEnvelope = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
  collidedEnvelope.authoritySnapshot.blockers.push('collision');
  fs.writeFileSync(persistedPath, `${JSON.stringify(collidedEnvelope)}\n`);
  assert.throws(
    () => replayProvider.createManifest({ persist: true, createdAt }),
    /runtime_retention_authority_manifest_collision/,
  );
  fs.writeFileSync(persistedPath, '{not-json\n');
  assert.throws(
    () => replayProvider.createManifest({ persist: true, createdAt }),
    /runtime_retention_authority_json_invalid/,
  );

  const unstableCampaignRoot = testRoot(t, 'hepta-retention-provider-campaign-drift-');
  let campaignScan = 0;
  const campaign = campaignRecord({ campaignId: 'campaign-drift' });
  const campaignDriftProvider = providerFor(unstableCampaignRoot, {
    campaignStore: {
      listCampaigns: () => [{ ...campaign, updatedAt: new Date(
        Date.parse(createdAt) + campaignScan++ * 1000,
      ).toISOString() }],
      listNodes: () => [],
    },
  });
  const campaignDrift = campaignDriftProvider.createManifest({ createdAt });
  assert.equal(
    campaignDrift.categories.some((entry) => entry.category === 'automation-artifacts'),
    false,
  );

  const unstableReleaseRoot = testRoot(t, 'hepta-retention-provider-release-drift-');
  let releaseScan = 0;
  const releaseCampaign = campaignRecord({ campaignId: 'release-drift' });
  const releaseDriftProvider = providerFor(unstableReleaseRoot, {
    campaignStore: emptyCampaignStore([releaseCampaign]),
    campaignReleaseQuery: {
      getCurrentRelease: () => ({
        ...currentRelease(releaseCampaign),
        promotedAt: new Date(
          Date.parse(createdAt) + releaseScan++ * 1000,
        ).toISOString(),
      }),
    },
  });
  const releaseDrift = releaseDriftProvider.createManifest({ createdAt });
  assert.equal(
    releaseDrift.categories.some((entry) => entry.category === 'automation-artifacts'),
    false,
  );

  const unstableSnapshotRoot = testRoot(t, 'hepta-retention-provider-snapshot-drift-');
  let snapshotScan = 0;
  const snapshotDriftProvider = providerFor(unstableSnapshotRoot, {
    workspaceRegistry: {
      snapshotRetentionRecords: () => [{
        snapshotId: 'snapshot-drift',
        workspaceId: 'workspace-drift',
        createdAt: new Date(
          Date.parse(createdAt) + snapshotScan++ * 1000,
        ).toISOString(),
      }],
    },
  });
  const snapshotDrift = snapshotDriftProvider.createManifest({ createdAt });
  assert.equal(
    snapshotDrift.categories.some((entry) => entry.category === 'workspace-snapshots'),
    false,
  );

  const unsafeAuthorityRoot = testRoot(t, 'hepta-retention-provider-unsafe-authority-');
  const outsideAuthority = testRoot(t, 'hepta-retention-provider-outside-authority-');
  fs.symlinkSync(outsideAuthority, path.join(unsafeAuthorityRoot, 'retention-authority'));
  assert.equal(
    providerFor(unsafeAuthorityRoot).loadManifest({ manifestHash: h('unsafe-authority') }),
    null,
  );

  for (const [name, overrides] of [
    ['missing-campaign-port', { campaignStore: {} }],
    ['invalid-campaign-page', {
      campaignStore: { listCampaigns: () => ({}), listNodes: () => [] },
    }],
    ['missing-release-port', {
      campaignStore: emptyCampaignStore([campaignRecord({ campaignId: 'no-release-port' })]),
      campaignReleaseQuery: {},
    }],
  ]) {
    const invalidPortRoot = testRoot(t, `hepta-retention-provider-${name}-`);
    const invalidPortManifest = providerFor(invalidPortRoot, overrides)
      .createManifest({ createdAt });
    assert.equal(invalidPortManifest.categories.some(
      (entry) => entry.category === 'automation-artifacts'), false);
  }

  const stringFailureRoot = testRoot(t, 'hepta-retention-provider-string-failures-');
  const stringFailureManifest = providerFor(stringFailureRoot, {
    campaignStore: {
      listCampaigns() { throw 'campaign inventory rejected'; },
      listNodes: () => [],
    },
    workspaceRegistry: {
      snapshotRetentionRecords() { throw 'snapshot inventory rejected'; },
    },
  }).createManifest({ createdAt });
  assert.equal(stringFailureManifest.categories.some(
    (entry) => ['automation-artifacts', 'workspace-snapshots'].includes(entry.category)), false);

  const invalidCasNameRoot = testRoot(t, 'hepta-retention-provider-invalid-cas-name-');
  const invalidCasManifestRoot = path.join(invalidCasNameRoot, 'artifact-cas', 'manifests');
  fs.mkdirSync(invalidCasManifestRoot, { recursive: true });
  fs.writeFileSync(path.join(invalidCasManifestRoot, 'not-a-manifest.json'), '{}\n');
  const invalidCasNameManifest = providerFor(invalidCasNameRoot).createManifest({ createdAt });
  assert.equal(invalidCasNameManifest.categories.some(
    (entry) => entry.category === 'artifact-cas'), false);

  const invalidCasObjectRoot = testRoot(t, 'hepta-retention-provider-invalid-cas-object-');
  const invalidCasObject = createCasFixture(invalidCasObjectRoot);
  const referencedObject = path.join(
    invalidCasObject.referencedPrefix,
    fs.readdirSync(invalidCasObject.referencedPrefix)[0],
  );
  fs.writeFileSync(referencedObject, 'changed object bytes\n');
  const invalidCasObjectManifest = providerFor(invalidCasObjectRoot)
    .createManifest({ createdAt });
  assert.equal(invalidCasObjectManifest.categories.some(
    (entry) => entry.category === 'artifact-cas'), false);

  const invalidPrefixRoot = testRoot(t, 'hepta-retention-provider-invalid-prefix-');
  const invalidPrefix = path.join(invalidPrefixRoot, 'artifact-cas', 'objects', 'sha256', 'zz');
  fs.mkdirSync(invalidPrefix, { recursive: true });
  fs.writeFileSync(path.join(invalidPrefix, 'object'), 'invalid prefix\n');
  const invalidPrefixManifest = providerFor(invalidPrefixRoot).createManifest({ createdAt });
  assert.deepEqual(invalidPrefixManifest.categories.find(
    (entry) => entry.category === 'artifact-cas').recoveryProtectedPaths, [invalidPrefix]);

  const nestedReleaseRoot = testRoot(t, 'hepta-retention-provider-nested-release-');
  const nestedCampaign = campaignRecord({ campaignId: 'nested-release' });
  const nestedReleaseManifest = providerFor(nestedReleaseRoot, {
    campaignStore: emptyCampaignStore([nestedCampaign]),
    campaignReleaseQuery: { getCurrentRelease: () => ({
      ...currentRelease(nestedCampaign),
      releaseBundle: { packageOutput: {
        packageDir: path.join(nestedReleaseRoot, 'packages', 'nested'),
        immutableCampaignPackageOutputHash: h('nested-package-output'),
      } },
    }) },
  }).createManifest({ createdAt });
  assert.equal(nestedReleaseManifest.categories.some(
    (entry) => entry.category === 'automation-artifacts'), true);

  const symlinkContainer = testRoot(t, 'hepta-retention-provider-runtime-symlink-');
  const runtimeTarget = path.join(symlinkContainer, 'runtime-target');
  const runtimeLink = path.join(symlinkContainer, 'runtime-link');
  fs.mkdirSync(runtimeTarget);
  fs.symlinkSync(runtimeTarget, runtimeLink, 'dir');
  assert.throws(
    () => providerFor(runtimeLink).createManifest({ persist: true, createdAt }),
    /runtime_retention_authority_runtime_root_unsafe/,
  );
});
