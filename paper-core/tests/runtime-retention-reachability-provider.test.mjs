import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLedgerBackedRuntimeRetentionReachabilityProvider } from '../../paper-adapters/automation/runtime-retention-reachability-provider-repository.mjs';
import { listRuntimeRetentionEntries } from '../../paper-adapters/automation/runtime-retention-scope-repository.mjs';
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
} from '../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

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

function recordPackageAuthorityReceipt(ledger, receipt) {
  const evidenceClass = {
    PackageLifecycleReceipt: 'package_lifecycle',
    PackageSupersessionReceipt: 'package_supersession',
    PackageRetentionLegalHoldReceipt: 'package_legal_hold',
  }[receipt.kind];
  return ledger.record(receipt, {
    stream: 'package-lifecycle',
    paperId: receipt.paperId || receipt.releaseIdentity.paperId,
    environment: 'administrative',
    evidenceClass,
    strictInsert: true,
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
  const root = testRoot(t, 'hepta-retention-provider-package-lifecycle-');
  const { store, clock } = createStoreFixture(t, root);
  const lifecycleLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issuePackageLifecycleWriter(),
  });
  const predecessor = campaignRecord({
    campaignId: 'package-old',
    paperId: 'package-paper',
    effectiveStatus: 'superseded',
  });
  const successor = campaignRecord({
    campaignId: 'package-successor',
    paperId: 'package-paper',
    supersedesCampaignId: predecessor.campaignId,
  });
  const predecessorPath = packageDirectory(root, 'package-old-generation', 'old package');
  const successorPath = packageDirectory(root, 'package-successor-generation', 'successor package');
  const packageEntries = listRuntimeRetentionEntries(root, 'packages').entries;
  const predecessorEntry = packageEntries.find((entry) => entry.path === predecessorPath);
  const successorEntry = packageEntries.find((entry) => entry.path === successorPath);
  const predecessorRelease = lifecycleRelease(
    predecessor,
    predecessorPath,
    '2026-07-21T05:10:00.000Z',
  );
  const successorRelease = lifecycleRelease(
    successor,
    successorPath,
    '2026-07-21T05:20:00.000Z',
  );
  const predecessorLifecycle = createPackageLifecycleReceipt({
    runtimeRoot: root,
    packagePath: predecessorPath,
    packageContentHash: predecessorEntry.contentHash,
    release: predecessorRelease,
    recordedAt: '2026-07-21T05:30:00.000Z',
  });
  const successorLifecycle = createPackageLifecycleReceipt({
    runtimeRoot: root,
    packagePath: successorPath,
    packageContentHash: successorEntry.contentHash,
    release: successorRelease,
    recordedAt: '2026-07-21T05:35:00.000Z',
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
    recordedAt: '2026-07-21T05:40:00.000Z',
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
      clock: CLOCK,
    });
  const planFor = (provider) => buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest: provider.createManifest(),
    policies: allGovernedPolicies(),
    nowMs: Date.parse('2026-07-21T07:00:00.000Z'),
  });
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
    ? { ...row, receipt_json: row.receipt_json.replace('old-generation', 'other-generation') }
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
  fs.writeFileSync(predecessorRecordPath, 'hash changed after lifecycle receipt\n');
  const hashChanged = planFor(providerFor([predecessor, successor], {
    list: () => recordedRows,
  }));
  assert.equal(hashChanged.removals.some((entry) => entry.path === predecessorPath), false);
  fs.writeFileSync(predecessorRecordPath, originalPredecessorRecord);

  createPackageCasReference(root, predecessorPath);
  const casReferenced = planFor(providerFor([predecessor, successor], {
    list: () => recordedRows,
  }));
  assert.equal(casReferenced.removals.some((entry) => entry.path === predecessorPath), false);

  const legalHold = createPackageRetentionLegalHoldReceipt({
    lifecycleReceipt: predecessorLifecycle,
    reasonHash: h('litigation hold'),
    createdAt: '2026-07-21T05:50:00.000Z',
  });
  recordPackageAuthorityReceipt(lifecycleLedger, legalHold);
  const held = planFor(providerFor([predecessor, successor]));
  assert.equal(held.removals.some((entry) => entry.path === predecessorPath), false);
  assert.equal(fs.existsSync(predecessorPath), true, 'no retention apply was invoked');
});

function livePackageRetentionFixture(t) {
  const root = testRoot(t, 'hepta-retention-live-package-authority-');
  const { store, clock, retentionLedger } = createStoreFixture(t, root);
  const lifecycleLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issuePackageLifecycleWriter(),
  });
  const predecessor = campaignRecord({
    campaignId: 'live-package-old',
    paperId: 'live-package-paper',
    effectiveStatus: 'superseded',
  });
  const successor = campaignRecord({
    campaignId: 'live-package-successor',
    paperId: predecessor.paperId,
    supersedesCampaignId: predecessor.campaignId,
  });
  const predecessorPath = packageDirectory(root, 'live-package-old-generation', 'old package');
  const successorPath = packageDirectory(root, 'live-package-successor-generation', 'successor package');
  const entries = listRuntimeRetentionEntries(root, 'packages').entries;
  const predecessorRelease = lifecycleRelease(
    predecessor,
    predecessorPath,
    '2026-07-21T05:10:00.000Z',
  );
  const successorRelease = lifecycleRelease(
    successor,
    successorPath,
    '2026-07-21T05:20:00.000Z',
  );
  const predecessorLifecycle = createPackageLifecycleReceipt({
    runtimeRoot: root,
    packagePath: predecessorPath,
    packageContentHash: entries.find((entry) => entry.path === predecessorPath).contentHash,
    release: predecessorRelease,
    recordedAt: '2026-07-21T05:30:00.000Z',
  });
  const successorLifecycle = createPackageLifecycleReceipt({
    runtimeRoot: root,
    packagePath: successorPath,
    packageContentHash: entries.find((entry) => entry.path === successorPath).contentHash,
    release: successorRelease,
    recordedAt: '2026-07-21T05:35:00.000Z',
  });
  recordPackageAuthorityReceipt(lifecycleLedger, predecessorLifecycle);
  recordPackageAuthorityReceipt(lifecycleLedger, successorLifecycle);
  recordPackageAuthorityReceipt(lifecycleLedger, createPackageSupersessionReceipt({
    predecessorLifecycleReceipt: predecessorLifecycle,
    successorLifecycleReceipt: successorLifecycle,
    lineageKind: 'supersedes',
    referenceAuthority: {
      campaignInventoryHash: h('live-package-campaign-inventory'),
      currentReleaseInventoryHash: h('live-package-release-inventory'),
      casManifestInventoryHash: h('live-package-cas-inventory'),
      receiptLedgerInventoryHash: h('live-package-ledger-inventory'),
    },
    recordedAt: '2026-07-21T05:40:00.000Z',
  }));
  const campaigns = [predecessor, successor];
  const releases = new Map([
    [predecessor.campaignId, predecessorRelease],
    [successor.campaignId, successorRelease],
  ]);
  const provider = createLedgerBackedRuntimeRetentionReachabilityProvider({
    runtimeRoot: root,
    campaignStore: emptyCampaignStore(campaigns),
    campaignReleaseQuery: releaseQuery(releases),
    workspaceRegistry: { snapshotRetentionRecords: () => [] },
    receiptLedger: lifecycleLedger,
    clock: CLOCK,
  });
  const manifest = provider.createManifest({ persist: true });
  const plan = buildRuntimeRetentionPlan({
    runtimeRoot: root,
    reachabilityManifest: manifest,
    policies: allGovernedPolicies(),
    nowMs: Date.parse('2026-07-21T07:00:00.000Z'),
  });
  assert.equal(plan.removals.some((entry) => entry.path === predecessorPath), true);
  return Object.freeze({
    root,
    predecessorPath,
    predecessor,
    predecessorLifecycle,
    campaigns,
    lifecycleLedger,
    retentionLedger,
    provider,
    manifest,
    plan,
  });
}

test('live package authority blocks a new active recovery after quarantine', (t) => {
  const fixture = livePackageRetentionFixture(t);
  let recoveryAdded = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    faultInjector(event) {
      if (recoveryAdded || event.stage !== 'after_entry_quarantined') return;
      recoveryAdded = true;
      fixture.campaigns.push(campaignRecord({
        campaignId: 'live-package-recovery',
        paperId: fixture.predecessor.paperId,
        status: 'running',
        effectiveStatus: 'running',
        recoveryOfCampaignId: fixture.predecessor.campaignId,
      }));
    },
  }), /runtime_retention_live_reachability_authority_changed/);
  assert.equal(recoveryAdded, true);
  assert.equal(fs.existsSync(fixture.predecessorPath), true);
});

test('live package authority blocks a new CAS reference before removal', (t) => {
  const fixture = livePackageRetentionFixture(t);
  let referenceAdded = false;
  assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
    apply: true,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    faultInjector(event) {
      if (referenceAdded || event.stage !== 'before_quarantined_member_removed') return;
      referenceAdded = true;
      createPackageCasReference(fixture.root, fixture.predecessorPath);
    },
  }), /runtime_retention_live_reachability_authority_changed/);
  assert.equal(referenceAdded, true);
  assert.equal(fs.existsSync(fixture.predecessorPath), true);
});

for (const stage of ['before_member_quarantined', 'before_quarantined_member_removed']) {
  test(`live package authority blocks a legal hold added at ${stage}`, (t) => {
    const fixture = livePackageRetentionFixture(t);
    let holdRecorded = false;
    assert.throws(() => executeRuntimeRetentionPlan(fixture.plan, {
      apply: true,
      reachabilityManifest: fixture.manifest,
      reachabilityManifestProvider: fixture.provider,
      retentionReceiptLedger: fixture.retentionLedger,
      faultInjector(event) {
        if (holdRecorded || event.stage !== stage
          || event.member?.path !== fixture.predecessorPath) return;
        holdRecorded = true;
        recordPackageAuthorityReceipt(
          fixture.lifecycleLedger,
          createPackageRetentionLegalHoldReceipt({
            lifecycleReceipt: fixture.predecessorLifecycle,
            reasonHash: h(`live hold:${stage}`),
            createdAt: '2026-07-21T06:30:00.000Z',
          }),
        );
      },
    }), /runtime_retention_live_reachability_authority_changed/);
    assert.equal(holdRecorded, true);
    assert.equal(fs.existsSync(fixture.predecessorPath), true);
    assert.equal(fs.readdirSync(path.dirname(fixture.predecessorPath))
      .some((name) => name.endsWith('.quarantine')), false);
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
