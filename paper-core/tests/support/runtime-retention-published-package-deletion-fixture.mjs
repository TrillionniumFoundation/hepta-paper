import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLedgerBackedRuntimeRetentionReachabilityProvider }
  from '../../../paper-adapters/automation/runtime-retention-reachability-provider-repository.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from '../../../paper-adapters/automation/package-recovery-tree-inventory-repository.mjs';
import { listRuntimeRetentionEntries }
  from '../../../paper-adapters/automation/runtime-retention-scope-repository.mjs';
import {
  buildRuntimeRetentionPlan,
  reconcileRuntimeRetentionIntents,
} from '../../../paper-adapters/automation/runtime-retention.mjs';
import { createSqliteReceiptLedger }
  from '../../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  issuePackageLifecycleWriter,
  issueRuntimeRetentionWriter,
}
  from '../../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createDefaultPaperStore }
  from '../../../paper-adapters/persistence/store-provider.mjs';
import {
  createPackageLifecycleReceipt,
  createPackageSupersessionReceipt,
} from '../../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import { createTrustedPackageRecoveryAuthorityFixture }
  from './package-recovery-authority-fixture.mjs';

export function hashTestValue(value) {
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

function emptyCampaignStore(campaigns) {
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
        resultSha256: campaign.status === 'running' ? null : hashTestValue(`${campaignId}:node-result`),
        failureSha256: null,
        updatedAt: campaign.updatedAt,
      }] : [];
    },
  });
}

function releaseQuery(releases) {
  return Object.freeze({
    getCurrentRelease({ campaignId }) { return releases.get(campaignId) || null; },
  });
}

function createStoreFixture(t, root) {
  let tick = 0;
  const clock = Object.freeze({
    nowIso: () => new Date(Date.parse('2026-07-21T04:00:00.000Z') + tick++ * 1000).toISOString(),
    now: () => new Date(Date.parse('2026-07-21T04:00:00.000Z') + tick * 1000),
  });
  const store = createDefaultPaperStore({
    root,
    runtimeRoot: root,
    dbPath: path.join(root, 'ledger.sqlite'),
  });
  t.after(() => store.close());
  const retentionLedger = createSqliteReceiptLedger({
    store,
    clock,
    issuerCapability: issueRuntimeRetentionWriter(),
  });
  return { store, clock, retentionLedger };
}

export function campaignRecord(overrides) {
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
    spec: { campaignPlanHash: hashTestValue('plan') },
    ...overrides,
  });
}

function currentRelease(campaign) {
  return Object.freeze({
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    packageNodeId: `${campaign.campaignId}:package`,
    packageResultHash: hashTestValue(`${campaign.campaignId}:result`),
    campaignReleaseBundleHash: hashTestValue(`${campaign.campaignId}:bundle`),
    materializationReceiptHash: hashTestValue(`${campaign.campaignId}:materialization`),
    status: 'current_completed_release',
    promotedAt: '2026-07-21T05:30:00.000Z',
  });
}

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
    immutableCampaignPackageOutputHash:
      hashTestValue(`${campaign.campaignId}:immutable-package-output`),
    packageNodeStatus: 'completed',
    campaignStatus: 'completed',
    promotedAt,
  });
}

export function recordPackageAuthorityReceipt(ledger, receipt) {
  const evidenceClass = {
    PackageLifecycleReceipt: 'package_lifecycle',
    PackageSupersessionReceipt: 'package_supersession',
    PackageRetentionRecoveryReceipt: 'package_recovery',
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

export function createPackageCasReference(root, packagePath) {
  const bytes = Buffer.from('package lifecycle reference\n');
  const contentHash = hashTestValue(bytes);
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

export function retentionTombstoneCount(ledger) {
  return ledger.listRawForAudit({
    stream: 'runtime-retention',
    evidenceClass: 'retention_tombstone',
  }).filter((row) => row.kind === 'RuntimeRetentionReceipt').length;
}

export function assertFailedPackageRemovalLeftNoTombstone(fixture) {
  assert.equal(fs.existsSync(fixture.predecessorPath), true);
  assert.equal(fs.lstatSync(fixture.predecessorPath).mode & 0o222, 0);
  assert.equal(fs.readdirSync(path.dirname(fixture.predecessorPath))
    .some((name) => name.endsWith('.quarantine')
      || name.startsWith('.hepta-retention-package-delete-')), false);
  assert.equal(retentionTombstoneCount(fixture.retentionLedger), 0);
}

export function createLivePackageRetentionFixture(t) {
  const recoveryFixture = createTrustedPackageRecoveryAuthorityFixture(t, {
    name: 'live-package-old-generation',
  });
  const root = recoveryFixture.runtimeRoot;
  const { store, clock, retentionLedger } = createStoreFixture(t, root);
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
    campaignId: 'live-package-successor',
    paperId: predecessor.paperId,
    supersedesCampaignId: predecessor.campaignId,
  });
  const predecessorPath = recoveryFixture.packagePath;
  const successorPath = packageDirectory(root, 'live-package-successor-generation', 'successor package');
  const entries = listRuntimeRetentionEntries(root, 'packages').entries;
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
    packageContentHash: entries.find((entry) => entry.path === successorPath).contentHash,
    packageRecoveryTreeInventoryHash: inspectPackageRecoveryTreeInventorySync({
      packagePath: successorPath,
    }).inventory.packageRecoveryTreeInventoryHash,
    release: successorRelease,
    recordedAt: '2026-08-18T00:10:00.000Z',
  });
  recordPackageAuthorityReceipt(lifecycleLedger, predecessorLifecycle);
  recordPackageAuthorityReceipt(lifecycleLedger, successorLifecycle);
  recordPackageAuthorityReceipt(lifecycleLedger, createPackageSupersessionReceipt({
    predecessorLifecycleReceipt: predecessorLifecycle,
    successorLifecycleReceipt: successorLifecycle,
    lineageKind: 'supersedes',
    referenceAuthority: {
      campaignInventoryHash: hashTestValue('live-package-campaign-inventory'),
      currentReleaseInventoryHash: hashTestValue('live-package-release-inventory'),
      casManifestInventoryHash: hashTestValue('live-package-cas-inventory'),
      receiptLedgerInventoryHash: hashTestValue('live-package-ledger-inventory'),
    },
    recordedAt: '2026-08-18T00:11:00.000Z',
  }));
  recordPackageAuthorityReceipt(
    lifecycleLedger,
    recoveryFixture.createRecoveryReceipt(),
  );
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
    packageRecoveryAuthority: recoveryFixture.authority,
    clock: Object.freeze({ nowIso: () => '2026-08-18T00:20:00.000Z' }),
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
    recoveryFixture,
    packageRecoveryDeletionLeasePort:
      recoveryFixture.packageRecoveryDeletionLeasePort,
  });
}

export function reconcileLivePackageRetention(
  fixture,
  packageRecoveryDeletionLeasePort = fixture.packageRecoveryDeletionLeasePort,
) {
  return reconcileRuntimeRetentionIntents({
    runtimeRoot: fixture.root,
    reachabilityManifest: fixture.manifest,
    reachabilityManifestProvider: fixture.provider,
    retentionReceiptLedger: fixture.retentionLedger,
    packageRecoveryDeletionLeasePort,
  });
}
