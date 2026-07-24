import {
  createPackageLifecycleReceipt,
  createPackageReleaseIdentity,
  createPackageSupersessionReceipt,
  verifyPackageLifecycleReceipt,
  verifyPackageRetentionLegalHoldReceipt,
  verifyPackageSupersessionReceipt,
} from '../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import {
  createPackageLifecycleRecordingIntent,
  verifyPackageLifecycleRecordingIntent,
} from '../../paper-domain/automation/package-lifecycle-recording-intent.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const INTENT_STREAM = 'package-lifecycle-intents';
const LIFECYCLE_STREAM = 'package-lifecycle';
const TERMINAL_CAMPAIGNS = new Set(['completed', 'failed', 'cancelled']);
const LEDGER_PAGE_SIZE = 1000;
const LEDGER_MAX_OFFSET = 9_999_000;

function parseReceipt(row) {
  try { return JSON.parse(row?.receipt_json || ''); } catch { return null; }
}

function scanLedger(receiptLedger, stream) {
  const rows = [];
  const receiptIds = new Set();
  for (let offset = 0; ; offset += LEDGER_PAGE_SIZE) {
    const page = receiptLedger.list({
      stream,
      environment: 'administrative',
      includeQualified: false,
      limit: LEDGER_PAGE_SIZE,
      offset,
    });
    if (!Array.isArray(page) || page.length > LEDGER_PAGE_SIZE) {
      throw new Error('package_lifecycle_ledger_inventory_incomplete');
    }
    for (const row of page) {
      if (!row?.receipt_id || receiptIds.has(row.receipt_id)) {
        throw new Error('package_lifecycle_ledger_inventory_unstable');
      }
      receiptIds.add(row.receipt_id);
      rows.push(row);
    }
    if (page.length < LEDGER_PAGE_SIZE) break;
    if (offset >= LEDGER_MAX_OFFSET) {
      throw new Error('package_lifecycle_ledger_inventory_bound_exceeded');
    }
  }
  return rows;
}

function listLedger(receiptLedger, stream, authority) {
  const first = scanLedger(receiptLedger, stream);
  const firstHash = hashRecord('PackageLifecycleStableLedgerScan', first);
  const second = scanLedger(receiptLedger, stream);
  if (firstHash !== hashRecord('PackageLifecycleStableLedgerScan', second)) {
    throw new Error('package_lifecycle_ledger_inventory_changed');
  }
  const rows = first;
  if (rows.some((row) => row.stream !== stream
    || row.environment !== 'administrative'
    || Number(row.writer_trusted) !== 1
    || row.writer_id !== authority.writerId
    || row.writer_kind !== authority.writerKind
    || row.issuer_policy_id !== authority.policyId
    || row.issuer_policy_hash !== authority.issuerPolicyHash
    || row.issuer_assurance !== authority.assurance)) {
    throw new Error('package_lifecycle_ledger_writer_authority_invalid');
  }
  return rows;
}

function record(receiptLedger, receipt, { stream, evidenceClass, paperId }) {
  return receiptLedger.record(receipt, {
    stream,
    paperId,
    environment: 'administrative',
    evidenceClass,
    strictInsert: false,
  });
}

function allCampaigns(campaignStore) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = campaignStore.listCampaigns({
      limit: 1000,
      offset,
      effectiveOnly: false,
    });
    if (!Array.isArray(page)) throw new Error('package_lifecycle_campaign_inventory_invalid');
    rows.push(...page);
    if (page.length < 1000) break;
    if (offset >= 9_999_000) throw new Error('package_lifecycle_campaign_inventory_bound_exceeded');
  }
  return rows;
}

function stableCampaignInventory(campaignStore) {
  const scan = () => allCampaigns(campaignStore).map((campaign) => Object.freeze({
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    status: campaign.status,
    effectiveStatus: campaign.effectiveStatus || campaign.status,
    parentCampaignId: campaign.parentCampaignId || null,
    supersedesCampaignId: campaign.supersedesCampaignId || null,
    recoveryOfCampaignId: campaign.recoveryOfCampaignId || null,
    campaignPlanHash: campaign.spec?.campaignPlanHash || null,
    nodes: campaignStore.listNodes(campaign.campaignId).map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      status: node.status,
      resultSha256: node.resultSha256 || null,
      updatedAt: node.updatedAt || null,
    })),
  })).sort((left, right) => left.campaignId.localeCompare(right.campaignId));
  const first = scan();
  const hash = hashRecord('PackageLifecycleCampaignInventory', first);
  if (hash !== hashRecord('PackageLifecycleCampaignInventory', scan())) {
    throw new Error('package_lifecycle_campaign_inventory_changed');
  }
  return Object.freeze({ rows: first, hash });
}

function stableReleaseInventory(campaigns, campaignReleaseQuery) {
  const scan = () => campaigns.map((campaign) => {
    const release = campaignReleaseQuery.getCurrentRelease({ campaignId: campaign.campaignId });
    if (!release) return null;
    const identity = createPackageReleaseIdentity(release);
    return Object.freeze({
      campaignId: campaign.campaignId,
      packageReleaseIdentityHash: identity.packageReleaseIdentityHash,
      packagePath: identity.packagePath,
    });
  }).filter(Boolean).sort((left, right) => left.campaignId.localeCompare(right.campaignId));
  const first = scan();
  const hash = hashRecord('PackageLifecycleCurrentReleaseInventory', first);
  if (hash !== hashRecord('PackageLifecycleCurrentReleaseInventory', scan())) {
    throw new Error('package_lifecycle_release_inventory_changed');
  }
  return Object.freeze({ rows: first, hash });
}

function ledgerInventory(rows) {
  return hashRecord('PackageLifecycleReceiptLedgerInventory', rows.map((row) => ({
    receiptId: row.receipt_id,
    receiptHash: row.receipt_sha256,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
  })).sort((left, right) => left.receiptId.localeCompare(right.receiptId)));
}

function matchingLifecycle(rows, predicate) {
  const matches = rows.map(parseReceipt)
    .filter((receipt) => verifyPackageLifecycleReceipt(receipt).valid)
    .filter(predicate);
  if (matches.length > 1) throw new Error('package_lifecycle_receipt_ambiguous');
  return matches[0] || null;
}

function validatedLifecycleRows(rows) {
  const metadata = {
    PackageLifecycleReceipt: ['package_lifecycle', 'packageLifecycleReceiptHash'],
    PackageSupersessionReceipt: ['package_supersession', 'packageSupersessionReceiptHash'],
    PackageRetentionLegalHoldReceipt: [
      'package_legal_hold',
      'packageRetentionLegalHoldReceiptHash',
    ],
  };
  for (const row of rows) {
    const receipt = parseReceipt(row);
    const [evidenceClass, hashField] = metadata[receipt?.kind] || [];
    const valid = receipt?.kind === 'PackageLifecycleReceipt'
      ? verifyPackageLifecycleReceipt(receipt).valid
      : receipt?.kind === 'PackageSupersessionReceipt'
        ? verifyPackageSupersessionReceipt(receipt).valid
        : receipt?.kind === 'PackageRetentionLegalHoldReceipt'
          ? verifyPackageRetentionLegalHoldReceipt(receipt).valid : false;
    const paperId = receipt?.paperId || receipt?.releaseIdentity?.paperId || null;
    if (!valid || !hashField
      || row.kind !== receipt.kind || row.status !== receipt.status
      || row.evidence_class !== evidenceClass || row.paper_id !== paperId
      || row.receipt_sha256 !== receipt[hashField]
      || row.receipt_id !== `${LIFECYCLE_STREAM}:${receipt[hashField]}`) {
      throw new Error('package_lifecycle_receipt_ledger_invalid');
    }
  }
  return rows;
}

function intentMatchesRelease(intent, release) {
  const identity = createPackageReleaseIdentity(release);
  return intent.campaignId === release.campaignId
    && intent.paperId === release.paperId
    && intent.campaignPlanHash === release.campaignPlanHash
    && intent.packageNodeId === release.packageNodeId
    && intent.packageAttemptId === release.packageAttemptId
    && intent.leaseGeneration === Number(release.leaseGeneration)
    && intent.packageResultHash === release.packageResultHash
    && intent.integrationDescriptorHash === release.integrationDescriptorHash
    && intent.integrationReceiptHash === release.integrationReceiptHash
    && intent.campaignReleaseBundleHash === release.campaignReleaseBundleHash
    && intent.materializationReceiptHash === release.materializationReceiptHash
    && intent.packagePath === identity.packagePath
    && intent.immutableCampaignPackageOutputHash
      === identity.immutableCampaignPackageOutputHash;
}

function packageIntentRows(receiptLedger, authority) {
  return listLedger(receiptLedger, INTENT_STREAM, authority).map((row) => {
    const intent = parseReceipt(row);
    const verification = verifyPackageLifecycleRecordingIntent(intent);
    if (!verification.valid
      || row.kind !== intent.kind || row.status !== intent.status
      || row.evidence_class !== 'package_lifecycle_intent'
      || row.paper_id !== intent.paperId
      || row.receipt_sha256 !== intent.packageLifecycleRecordingIntentReceiptHash
      || row.receipt_id
        !== `${INTENT_STREAM}:${intent.packageLifecycleRecordingIntentReceiptHash}`) {
      throw new Error('package_lifecycle_recording_intent_ledger_invalid');
    }
    return Object.freeze({ row, intent });
  });
}

function sameIntentAttempt(left, right) {
  return left.campaignId === right.campaignId
    && left.packageNodeId === right.packageNodeId
    && left.packageAttemptId === right.packageAttemptId
    && left.leaseGeneration === right.leaseGeneration;
}

export function createPackageLifecycleAuthorityService({
  runtimeRoot,
  campaignStore,
  campaignReleaseQuery,
  materializationInspector,
  receiptLedger,
  receiptWriterAuthority,
  clock,
} = {}) {
  if (!runtimeRoot || typeof campaignStore?.getCampaign !== 'function'
    || typeof campaignStore?.listCampaigns !== 'function'
    || typeof campaignStore?.listNodes !== 'function'
    || typeof campaignReleaseQuery?.getCurrentRelease !== 'function'
    || typeof materializationInspector?.inspectRelease !== 'function'
    || typeof materializationInspector?.casReferenceAuthority !== 'function'
    || typeof receiptLedger?.record !== 'function'
    || typeof receiptLedger?.list !== 'function'
    || !receiptWriterAuthority?.policyId
    || !receiptWriterAuthority?.issuerPolicyHash
    || typeof clock?.nowIso !== 'function') {
    throw new Error('package_lifecycle_authority_service_dependencies_invalid');
  }

  function prepareCurrentReleaseRecording({
    campaignId,
    nodeId,
    workerId,
    attemptId,
    leaseGeneration,
    preparedResultHash,
  } = {}) {
    const campaign = campaignStore.getCampaign(campaignId);
    const node = campaignStore.listNodes(campaignId)
      .find((candidate) => candidate.nodeId === nodeId);
    const now = clock.nowIso();
    if (!campaign || campaign.status !== 'running'
      || !node || node.kind !== 'package' || node.status !== 'running'
      || node.leaseOwner !== workerId || node.attemptId !== attemptId
      || Number(node.leaseGeneration) !== Number(leaseGeneration)
      || Date.parse(node.leaseExpiresAt || '') < Date.parse(now)
      || node.preparedResultHash !== preparedResultHash
      || node.preparedIntegrationStatus !== 'integrated'
      || !node.preparedIntegrationKey || !node.preparedIntegrationReceiptHash
      || !Number.isFinite(Date.parse(node.preparedIntegratedAt || ''))) {
      throw new Error('package_lifecycle_recording_intent_attempt_fence_invalid');
    }
    const packageResult = node.preparedResult;
    if (!packageResult?.releaseBundle
      || hashRecord('PaperCampaignNodeResult', packageResult) !== preparedResultHash
      || packageResult.campaignReleaseBundleHash
        !== packageResult.releaseBundle.campaignReleaseBundleHash
      || packageResult.campaignReleaseBundleMaterializationReceiptHash
        !== packageResult.materializationReceipt
          ?.campaignReleaseBundleMaterializationReceiptHash) {
      throw new Error('package_lifecycle_recording_intent_result_invalid');
    }
    const inspected = materializationInspector.inspectRelease({
      releaseBundle: packageResult.releaseBundle,
    });
    const intent = createPackageLifecycleRecordingIntent({
      runtimeRoot,
      campaign,
      packageNode: node,
      packageResult,
      packagePath: inspected.packagePath,
      packageContentHash: inspected.packageContentHash,
      preparedAt: node.preparedIntegratedAt,
    });
    const existing = packageIntentRows(receiptLedger, receiptWriterAuthority)
      .map(({ intent: persisted }) => persisted)
      .filter((persisted) => sameIntentAttempt(persisted, intent));
    if (existing.length > 1) {
      throw new Error('package_lifecycle_recording_intent_ambiguous');
    }
    if (existing.length === 1) {
      if (existing[0].packageLifecycleRecordingIntentReceiptHash
        !== intent.packageLifecycleRecordingIntentReceiptHash) {
        throw new Error('package_lifecycle_recording_intent_conflict');
      }
      return existing[0];
    }
    record(receiptLedger, intent, {
      stream: INTENT_STREAM,
      evidenceClass: 'package_lifecycle_intent',
      paperId: campaign.paperId,
    });
    const persisted = packageIntentRows(receiptLedger, receiptWriterAuthority)
      .map(({ intent: candidate }) => candidate)
      .filter((candidate) => sameIntentAttempt(candidate, intent));
    if (persisted.length !== 1
      || persisted[0].packageLifecycleRecordingIntentReceiptHash
        !== intent.packageLifecycleRecordingIntentReceiptHash) {
      throw new Error('package_lifecycle_recording_intent_persist_conflict');
    }
    return persisted[0];
  }

  function referenceAuthority({ predecessor, successor, predecessorLifecycle, lifecycleRows }) {
    const campaigns = stableCampaignInventory(campaignStore);
    const releases = stableReleaseInventory(campaigns.rows, campaignReleaseQuery);
    const activeReferenceCampaignIds = campaigns.rows.filter((campaign) =>
      campaign.paperId === predecessor.paperId
        && ![predecessor.campaignId, successor.campaignId].includes(campaign.campaignId)
        && !TERMINAL_CAMPAIGNS.has(campaign.status))
      .map((campaign) => campaign.campaignId).sort();
    const recoveryReferenceCampaignIds = campaigns.rows.filter((campaign) =>
      campaign.campaignId !== successor.campaignId
        && (campaign.recoveryOfCampaignId === predecessor.campaignId
          || campaign.supersedesCampaignId === predecessor.campaignId
          || campaign.parentCampaignId === predecessor.campaignId))
      .map((campaign) => campaign.campaignId).sort();
    const legalHoldReceiptHashes = lifecycleRows.map(parseReceipt)
      .filter((receipt) => verifyPackageRetentionLegalHoldReceipt(
        receipt,
        { lifecycleReceipt: predecessorLifecycle },
      ).valid)
      .map((receipt) => receipt.packageRetentionLegalHoldReceiptHash).sort();
    const cas = materializationInspector.casReferenceAuthority({
      packagePath: predecessorLifecycle.packagePath,
      packageContentHash: predecessorLifecycle.packageContentHash,
    });
    return Object.freeze({
      campaignInventoryHash: campaigns.hash,
      currentReleaseInventoryHash: releases.hash,
      casManifestInventoryHash: cas.inventoryHash,
      receiptLedgerInventoryHash: ledgerInventory(lifecycleRows),
      activeReferenceCampaignIds,
      recoveryReferenceCampaignIds,
      legalHoldReceiptHashes,
      casReferenceManifestHashes: [...cas.referenceManifestHashes],
    });
  }

  function reconcileCampaign({ campaignId } = {}) {
    const intents = packageIntentRows(receiptLedger, receiptWriterAuthority)
      .filter(({ intent }) => !campaignId || intent.campaignId === campaignId);
    let lifecycleRows = validatedLifecycleRows(listLedger(
      receiptLedger,
      LIFECYCLE_STREAM,
      receiptWriterAuthority,
    ));
    const results = [];
    for (const { intent } of intents) {
      const release = campaignReleaseQuery.getCurrentRelease({
        campaignId: intent.campaignId,
      });
      if (!release || !intentMatchesRelease(intent, release)) continue;
      const currentCampaign = campaignStore.getCampaign(intent.campaignId);
      const currentPackageNode = campaignStore.listNodes(intent.campaignId)
        .find((node) => node.nodeId === intent.packageNodeId);
      if (currentCampaign?.status !== 'completed'
        || currentPackageNode?.kind !== 'package'
        || currentPackageNode?.status !== 'completed'
        || currentPackageNode?.attemptId !== intent.packageAttemptId
        || Number(currentPackageNode?.leaseGeneration) !== intent.leaseGeneration
        || currentPackageNode?.resultSha256 !== intent.packageResultHash) {
        continue;
      }
      const inspected = materializationInspector.inspectRelease({
        releaseBundle: release.releaseBundle,
      });
      if (inspected.packagePath !== intent.packagePath
        || inspected.packageContentHash !== intent.packageContentHash
        || inspected.immutableCampaignPackageOutputHash
          !== intent.immutableCampaignPackageOutputHash) {
        throw new Error('package_lifecycle_recording_intent_postimage_mismatch');
      }
      const identity = createPackageReleaseIdentity(release);
      let lifecycle = matchingLifecycle(lifecycleRows, (receipt) =>
        receipt.packageReleaseIdentityHash === identity.packageReleaseIdentityHash);
      if (!lifecycle) {
        lifecycle = createPackageLifecycleReceipt({
          runtimeRoot,
          packagePath: inspected.packagePath,
          packageContentHash: inspected.packageContentHash,
          release,
          recordedAt: clock.nowIso(),
        });
        record(receiptLedger, lifecycle, {
          stream: LIFECYCLE_STREAM,
          evidenceClass: 'package_lifecycle',
          paperId: release.paperId,
        });
        lifecycleRows = validatedLifecycleRows(listLedger(
          receiptLedger,
          LIFECYCLE_STREAM,
          receiptWriterAuthority,
        ));
      } else if (lifecycle.packagePath !== inspected.packagePath
        || lifecycle.packageContentHash !== inspected.packageContentHash) {
        throw new Error('package_lifecycle_existing_receipt_postimage_mismatch');
      }

      const successor = campaignStore.getCampaign(intent.campaignId);
      const predecessorId = successor?.recoveryOfCampaignId
        || successor?.supersedesCampaignId || null;
      const lineageKind = successor?.recoveryOfCampaignId ? 'recovery' : 'supersedes';
      let supersession = null;
      if (predecessorId) {
        const predecessor = campaignStore.getCampaign(predecessorId);
        const predecessorLifecycle = matchingLifecycle(lifecycleRows, (receipt) =>
          receipt.releaseIdentity.campaignId === predecessorId);
        const existing = predecessorLifecycle
          ? lifecycleRows.map(parseReceipt).find((receipt) =>
            verifyPackageSupersessionReceipt(receipt).valid
              && receipt.predecessorLifecycleReceiptHash
                === predecessorLifecycle.packageLifecycleReceiptHash
              && receipt.successorLifecycleReceiptHash
                === lifecycle.packageLifecycleReceiptHash) : null;
        if (predecessor && predecessorLifecycle && !existing) {
          const authority = referenceAuthority({
            predecessor,
            successor,
            predecessorLifecycle,
            lifecycleRows,
          });
          const referenced = [
            ...authority.activeReferenceCampaignIds,
            ...authority.recoveryReferenceCampaignIds,
            ...authority.legalHoldReceiptHashes,
            ...authority.casReferenceManifestHashes,
          ];
          if (!referenced.length) {
            supersession = createPackageSupersessionReceipt({
              predecessorLifecycleReceipt: predecessorLifecycle,
              successorLifecycleReceipt: lifecycle,
              lineageKind,
              referenceAuthority: authority,
              recordedAt: clock.nowIso(),
            });
            record(receiptLedger, supersession, {
              stream: LIFECYCLE_STREAM,
              evidenceClass: 'package_supersession',
              paperId: release.paperId,
            });
            lifecycleRows = validatedLifecycleRows(listLedger(
              receiptLedger,
              LIFECYCLE_STREAM,
              receiptWriterAuthority,
            ));
          }
        } else supersession = existing || null;
      }
      results.push(Object.freeze({
        campaignId: intent.campaignId,
        intentReceiptHash: intent.packageLifecycleRecordingIntentReceiptHash,
        lifecycleReceiptHash: lifecycle.packageLifecycleReceiptHash,
        supersessionReceiptHash:
          supersession?.packageSupersessionReceiptHash || null,
      }));
    }
    return Object.freeze({
      status: 'package_lifecycle_authority_reconciled',
      campaignId: campaignId || null,
      reconciledCount: results.length,
      results: Object.freeze(results),
      externalActionPerformed: false,
    });
  }

  return Object.freeze({
    version: 1,
    kind: 'PackageLifecycleAuthorityService',
    prepareCurrentReleaseRecording,
    reconcileCampaign,
    reconcile: () => reconcileCampaign({}),
  });
}
