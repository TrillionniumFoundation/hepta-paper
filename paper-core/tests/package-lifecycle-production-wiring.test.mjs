import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPackageLifecycleAuthorityService } from '../../paper-application/automation/package-lifecycle-authority-service.mjs';
import { createPackageLifecycleMaterializationInspector } from '../../paper-adapters/automation/package-lifecycle-materialization-inspector.mjs';
import { packageLifecycleDeclaration } from '../../paper-adapters/automation/runtime-retention-package-lifecycle-authority.mjs';
import { campaignReleasePackageRootFor } from '../../paper-adapters/automation/campaign-release-materialization.mjs';
import { issuePackageLifecycleWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { receiptIssuerPolicies } from '../../paper-adapters/persistence/receipt-issuer-policy.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createPackageRetentionLegalHoldReceipt } from '../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import { createPackageLifecycleRecordingIntent } from '../../paper-domain/automation/package-lifecycle-recording-intent.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

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
  const createService = ({ ledger = receiptLedger } = {}) => createPackageLifecycleAuthorityService({
    runtimeRoot: root,
    campaignStore,
    campaignReleaseQuery,
    materializationInspector:
      createPackageLifecycleMaterializationInspector({ runtimeRoot: root }),
    receiptLedger: ledger,
    receiptWriterAuthority: {
      ...policy,
      policyId: 'package-lifecycle-authority',
    },
    clock,
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
    root, campaigns, nodes, releases, receiptLedger, createService, complete,
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
