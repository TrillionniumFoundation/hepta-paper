import path from 'node:path';
import {
  createPackageReleaseIdentity,
  verifyPackageLifecycleReceipt,
  verifyPackageRetentionLegalHoldReceipt,
  verifyPackageSupersessionReceipt,
} from '../../paper-domain/automation/package-lifecycle-authority-contract.mjs';
import {
  inspectTrustedLivePackageRecoverySource,
  verifyTrustedPackageRecoveryReceipt,
} from '../../paper-ports/package-recovery-authority-port.mjs';
import { PACKAGE_LIFECYCLE_LEGACY_ISSUER_POLICY_HASHES }
  from '../../paper-domain/evidence/receipt-issuer-policy-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys }
  from '../../workflow-kernel/exact-object-keys.mjs';
import { receiptIssuerPolicies } from '../persistence/receipt-issuer-policy.mjs';
import { inspectPackageRecoveryTreeInventorySync }
  from './package-recovery-tree-inventory-repository.mjs';

const STREAM = 'package-lifecycle';
const POLICY_ID = 'package-lifecycle-authority';
const POLICY = receiptIssuerPolicies()[POLICY_ID];
const TERMINAL_CAMPAIGN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_NODE_STATUSES = new Set(['completed', 'skipped', 'failed_terminal']);
const KINDS = new Set([
  'PackageLifecycleReceipt',
  'PackageSupersessionReceipt',
  'PackageRetentionRecoveryReceipt',
  'PackageRetentionLegalHoldReceipt',
]);
const EVIDENCE_CLASS = Object.freeze({
  PackageLifecycleReceipt: 'package_lifecycle',
  PackageSupersessionReceipt: 'package_supersession',
  PackageRetentionRecoveryReceipt: 'package_recovery',
  PackageRetentionLegalHoldReceipt: 'package_legal_hold',
});
const HASH_FIELD = Object.freeze({
  PackageLifecycleReceipt: 'packageLifecycleReceiptHash',
  PackageSupersessionReceipt: 'packageSupersessionReceiptHash',
  PackageRetentionRecoveryReceipt: 'packageRetentionRecoveryReceiptHash',
  PackageRetentionLegalHoldReceipt: 'packageRetentionLegalHoldReceiptHash',
});
const LEDGER_PAGE_SIZE = 1000;
const LEDGER_MAX_OFFSET = 9_999_000;
const LEGACY_POLICY_KINDS = new Set([
  'PackageLifecycleReceipt',
  'PackageSupersessionReceipt',
  'PackageRetentionLegalHoldReceipt',
]);

function acceptedPolicyHash(row) {
  return row.issuer_policy_hash === POLICY.issuerPolicyHash
    || (LEGACY_POLICY_KINDS.has(row.kind)
      && PACKAGE_LIFECYCLE_LEGACY_ISSUER_POLICY_HASHES.includes(row.issuer_policy_hash));
}

function emptyDeclaration() {
  return {
    inventoryComplete: true,
    activePaths: [],
    referencedPaths: [],
    releaseDependentPaths: [],
    recoveryProtectedPaths: [],
    deletionEvidence: [],
  };
}

function receiptJson(row) {
  try { return JSON.parse(row?.receipt_json || ''); } catch { return null; }
}

function receiptValid(receipt, receipts, packageRecoveryAuthority) {
  if (receipt?.kind === 'PackageLifecycleReceipt') {
    return verifyPackageLifecycleReceipt(receipt).valid;
  }
  if (receipt?.kind === 'PackageSupersessionReceipt') {
    return verifyPackageSupersessionReceipt(receipt).valid;
  }
  if (receipt?.kind === 'PackageRetentionLegalHoldReceipt') {
    return verifyPackageRetentionLegalHoldReceipt(receipt).valid;
  }
  if (receipt?.kind === 'PackageRetentionRecoveryReceipt') {
    const lifecycles = receipts.filter((candidate) =>
      candidate?.kind === 'PackageLifecycleReceipt'
        && candidate.packageLifecycleReceiptHash === receipt.packageLifecycleReceiptHash
        && verifyPackageLifecycleReceipt(candidate).valid);
    return Boolean(lifecycles.length === 1
      && verifyTrustedPackageRecoveryReceipt({
        packageRecoveryAuthority,
        recoveryReceipt: receipt,
        lifecycleReceipt: lifecycles[0],
      }));
  }
  return false;
}

function trustedRow(row, receipts, packageRecoveryAuthority) {
  const receipt = receiptJson(row);
  const field = HASH_FIELD[receipt?.kind];
  const receiptHash = field ? receipt?.[field] : null;
  const paperId = receipt?.paperId || receipt?.releaseIdentity?.paperId || null;
  return Boolean(receipt
    && KINDS.has(receipt.kind)
    && receiptValid(receipt, receipts, packageRecoveryAuthority)
    && row.receipt_id === `${STREAM}:${receiptHash}`
    && row.receipt_sha256 === receiptHash
    && row.stream === STREAM
    && row.paper_id === paperId
    && row.kind === receipt.kind
    && row.status === receipt.status
    && row.environment === 'administrative'
    && row.evidence_class === EVIDENCE_CLASS[receipt.kind]
    && Number(row.effective_receipt_usable) === 1
    && Number(row.writer_trusted) === 1
    && row.writer_id === POLICY.writerId
    && row.writer_kind === POLICY.writerKind
    && row.issuer_policy_id === POLICY_ID
    && acceptedPolicyHash(row)
    && row.issuer_assurance === POLICY.assurance);
}

function scanLedger(receiptLedger) {
  const rows = [];
  const receiptIds = new Set();
  for (let offset = 0; ; offset += LEDGER_PAGE_SIZE) {
    const page = receiptLedger.list({
      stream: STREAM,
      environment: 'administrative',
      includeQualified: false,
      limit: LEDGER_PAGE_SIZE,
      offset,
    });
    if (!Array.isArray(page) || page.length > LEDGER_PAGE_SIZE) {
      throw new Error('package_lifecycle_ledger_scan_invalid');
    }
    for (const row of page) {
      if (!row?.receipt_id || receiptIds.has(row.receipt_id)) {
        throw new Error('package_lifecycle_ledger_scan_unstable');
      }
      receiptIds.add(row.receipt_id);
      rows.push(row);
    }
    if (page.length < LEDGER_PAGE_SIZE) break;
    if (offset >= LEDGER_MAX_OFFSET) {
      throw new Error('package_lifecycle_ledger_scan_bound_exceeded');
    }
  }
  return rows;
}

function loadLedgerAuthority(receiptLedger, packageRecoveryAuthority) {
  if (typeof receiptLedger?.list !== 'function') {
    return Object.freeze({ complete: false, blockers: ['package_lifecycle_ledger_unavailable'] });
  }
  let rows;
  try {
    rows = scanLedger(receiptLedger);
    const firstHash = hashRecord('PackageLifecycleStableLedgerScan', rows);
    const second = scanLedger(receiptLedger);
    if (firstHash !== hashRecord('PackageLifecycleStableLedgerScan', second)) {
      throw new Error('package_lifecycle_ledger_scan_changed');
    }
  } catch {
    return Object.freeze({ complete: false, blockers: ['package_lifecycle_ledger_scan_failed'] });
  }
  const receipts = rows.map(receiptJson);
  if (rows.some((row) => !trustedRow(row, receipts, packageRecoveryAuthority))) {
    return Object.freeze({ complete: false, blockers: ['package_lifecycle_ledger_incomplete_or_invalid'] });
  }
  const records = rows.map((row) => Object.freeze({
    receiptId: row.receipt_id,
    receiptHash: row.receipt_sha256,
    ledgerCreatedAt: row.created_at,
    receipt: receiptJson(row),
  })).sort((left, right) => left.receiptId.localeCompare(right.receiptId));
  const inventoryRows = records.map((record) => ({
    receiptId: record.receiptId,
    receiptHash: record.receiptHash,
    kind: record.receipt.kind,
    status: record.receipt.status,
    ledgerCreatedAt: record.ledgerCreatedAt,
  }));
  return Object.freeze({
    complete: true,
    blockers: [],
    records,
    inventoryHash: hashRecord('PackageLifecycleLedgerInventory', inventoryRows),
  });
}

function packagePathInRoot(runtimeRoot, candidate) {
  const resolved = path.resolve(String(candidate || ''));
  return path.dirname(resolved) === path.join(path.resolve(runtimeRoot), 'packages')
    ? resolved
    : null;
}

function releaseIdentity(release) {
  try { return createPackageReleaseIdentity(release); } catch { return null; }
}

function releaseMatchesLifecycle(release, lifecycle) {
  const identity = releaseIdentity(release);
  return Boolean(identity
    && identity.packageReleaseIdentityHash === lifecycle.packageReleaseIdentityHash
    && identity.packagePath === lifecycle.packagePath);
}

function terminalCampaign(campaign, nodesByCampaign) {
  return Boolean(campaign
    && TERMINAL_CAMPAIGN_STATUSES.has(campaign.status)
    && (nodesByCampaign.get(campaign.campaignId) || [])
      .every((node) => TERMINAL_NODE_STATUSES.has(node.status)));
}

function lineageMatches(predecessor, successor, kind) {
  if (kind === 'supersedes') return successor?.supersedesCampaignId === predecessor?.campaignId;
  if (kind === 'recovery') return successor?.recoveryOfCampaignId === predecessor?.campaignId;
  return false;
}

function sameEntry(entry, lifecycle, runtimeRoot) {
  let inventoryHash = entry.packageRecoveryTreeInventoryHash || null;
  if (!inventoryHash) {
    try {
      inventoryHash = inspectPackageRecoveryTreeInventorySync({
        packagePath: entry.path,
      }).inventory.packageRecoveryTreeInventoryHash;
    } catch { inventoryHash = null; }
  }
  return Boolean(lifecycle?.version === 2
    && !entry.symbolicLink
    && packagePathInRoot(runtimeRoot, lifecycle.packagePath) === path.resolve(entry.path)
    && lifecycle.packageContentHash === entry.contentHash
    && lifecycle.packageRecoveryTreeInventoryHash === inventoryHash
    && path.resolve(lifecycle.runtimeRoot) === path.resolve(runtimeRoot));
}

function casReferences(entry, casInventory, runtimeRoot) {
  if (!casInventory?.rows || !casInventory.hash) return null;
  return casInventory.rows.filter((row) => row.contentHash === entry.contentHash
    || (row.logicalPath
      && path.resolve(runtimeRoot, String(row.logicalPath)) === path.resolve(entry.path)));
}

function campaignReferences({ campaigns, nodesByCampaign, predecessor, successor }) {
  const active = campaigns.rows.filter((campaign) => campaign.paperId === predecessor.paperId
    && ![predecessor.campaignId, successor.campaignId].includes(campaign.campaignId)
    && !terminalCampaign(campaign, nodesByCampaign));
  const recovery = campaigns.rows.filter((campaign) => campaign.campaignId !== successor.campaignId
    && (campaign.recoveryOfCampaignId === predecessor.campaignId
      || campaign.supersedesCampaignId === predecessor.campaignId
      || campaign.parentCampaignId === predecessor.campaignId));
  return Object.freeze({ active, recovery });
}

function recoveryDeletionLeaseBindingHash({ lifecycle, recovery, liveRecovery }) {
  const proof = recovery?.recoverySourceAuthority?.storageAuthorityProof;
  const policy = proof?.retentionPolicy;
  return hashRecord('PackageRecoveryDeletionLeaseBinding', {
    version: 1,
    kind: 'PackageRecoveryDeletionLeaseBinding',
    packageLifecycleReceiptHash: lifecycle.packageLifecycleReceiptHash,
    packageRecoveryTreeInventoryHash:
      lifecycle.packageRecoveryTreeInventoryHash,
    packageRetentionRecoveryReceiptHash:
      recovery.packageRetentionRecoveryReceiptHash,
    packageRecoveryStorageAuthorityProofHash:
      proof.packageRecoveryStorageAuthorityProofHash,
    authoritySnapshotHash: liveRecovery.authoritySnapshotHash,
    storageAuthorityId: proof.storageAuthorityId,
    storageObjectId: proof.storageObjectId,
    storageObjectVersion: proof.storageObjectVersion,
    storageObjectBytesHash: proof.storageObjectBytesHash,
    retentionLockAuthorityId: policy.retentionLockAuthorityId,
    retentionLockId: policy.retentionLockId,
    retentionLockVersion: policy.retentionLockVersion,
    retentionLockIdentityHash: policy.retentionLockIdentityHash,
    retainUntil: policy.retainUntil,
    storageLedgerReceiptId: proof.ledgerIdentity.receiptId,
    storageLedgerReceiptHash: proof.ledgerIdentity.receiptHash,
    trustStoreHash: proof.trustStoreHash,
    verificationEpoch: proof.verificationEpoch,
  });
}

function uniqueRecord(records, predicate) {
  const matches = records.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

function protect(declaration, field, entry) {
  declaration[field].push(entry.path);
}

const FENCED_STAGING_IDENTITY_KEYS = Object.freeze([
  'dev', 'ino', 'mode', 'size', 'mtimeNs', 'nlink', 'realPath', 'entryKind',
]);

function exactFencedStagingIdentity(stagingEntry) {
  const identity = stagingEntry?.identity;
  return Boolean(hasExactPlainObjectKeys(identity, FENCED_STAGING_IDENTITY_KEYS)
    && FENCED_STAGING_IDENTITY_KEYS.every((field) =>
      typeof identity[field] === 'string' && identity[field].length > 0)
    && identity.entryKind === 'directory'
    && path.resolve(identity.realPath) === path.resolve(stagingEntry.path)
    && /^sha256:[a-f0-9]{64}$/.test(String(
      stagingEntry.campaignReleasePackageFencedStagingTreeIdentityHash || '',
    ))
    && stagingEntry.campaignReleasePackageFencedStagingIdentityHash
      === hashRecord('CampaignReleasePackageFencedStagingIdentity', {
        path: path.resolve(stagingEntry.path),
        contentHash: stagingEntry.contentHash,
        identity,
        treeIdentityHash:
          stagingEntry.campaignReleasePackageFencedStagingTreeIdentityHash,
      }));
}

function fencedTransactionForEntry({
  entry,
  fencedTransactions,
  campaigns,
  releases,
  runtimeRoot,
}) {
  const matches = (fencedTransactions?.rows || []).map((row) => ({
    transaction: row,
    stagingEntry: (row.stagingEntries || []).find((candidate) =>
      path.resolve(String(candidate?.path || '')) === path.resolve(entry.path)),
  })).filter(({ stagingEntry }) => stagingEntry);
  if (matches.length !== 1 || entry.symbolicLink) return null;
  const { transaction, stagingEntry } = matches[0];
  if (stagingEntry.contentHash !== entry.contentHash
    || !exactFencedStagingIdentity(stagingEntry)
    || !/^sha256:[a-f0-9]{64}$/.test(
      String(stagingEntry.campaignReleasePackageBuildingMarkerHash || ''),
    )) return null;
  if (packagePathInRoot(runtimeRoot, entry.path) !== path.resolve(entry.path)) {
    return null;
  }
  const currentNode = campaigns.nodes.find((node) => (
    node.campaignId === transaction.campaignId
      && node.nodeId === transaction.packageNodeId
  ));
  if (!currentNode
    || Number(currentNode.leaseGeneration) <= transaction.leaseGeneration
    || Number(currentNode.leaseGeneration)
      < transaction.supersedingLeaseGeneration
    || currentNode.attemptId === transaction.packageAttemptId
    || releases.rows.some((release) => (
      path.resolve(String(release.packagePath || '')) === path.resolve(entry.path)
    ))) {
    return null;
  }
  return Object.freeze({ transaction, stagingEntry });
}

export function packageLifecycleDeclaration({
  runtimeRoot,
  entries,
  campaigns,
  releases,
  receiptLedger,
  casInventory,
  activeNodeIds = [],
  fencedTransactions = null,
  packageRecoveryAuthority = null,
  now = new Date().toISOString(),
} = {}) {
  const declaration = emptyDeclaration();
  const ledger = loadLedgerAuthority(receiptLedger, packageRecoveryAuthority);
  const fencedInventory = fencedTransactions || Object.freeze({
    rows: Object.freeze([]),
    hash: hashRecord('FencedCampaignReleasePackageTransactionInventory', []),
  });
  const authority = {
    complete: Boolean(ledger.complete && campaigns?.hash && releases?.hash
      && casInventory?.hash && fencedInventory.hash),
    blockers: [...(ledger.blockers || [])],
    ledgerInventoryHash: ledger.inventoryHash || null,
    recoveryAuthoritySnapshotHashes: [],
    recoverySourceInventoryHashes: [],
  };
  if (!authority.complete) {
    for (const entry of entries) protect(declaration, 'recoveryProtectedPaths', entry);
    return Object.freeze({ declaration, authority: Object.freeze(authority) });
  }

  const records = ledger.records.filter((record) =>
    path.resolve(String(record.receipt.runtimeRoot || '')) === path.resolve(runtimeRoot));
  const lifecycleRecords = records.filter((record) => record.receipt.kind === 'PackageLifecycleReceipt');
  const supersessionRecords = records.filter((record) => record.receipt.kind === 'PackageSupersessionReceipt');
  const recoveryRecords = records.filter((record) =>
    record.receipt.kind === 'PackageRetentionRecoveryReceipt');
  const holdRecords = records.filter((record) => record.receipt.kind === 'PackageRetentionLegalHoldReceipt');
  const campaignById = new Map(campaigns.rows.map((campaign) => [campaign.campaignId, campaign]));
  const releaseByCampaign = new Map(releases.rows.map((release) => [release.campaignId, release]));
  const nodesByCampaign = new Map();
  for (const node of campaigns.nodes) {
    if (!nodesByCampaign.has(node.campaignId)) nodesByCampaign.set(node.campaignId, []);
    nodesByCampaign.get(node.campaignId).push(node);
  }
  const entryByIdentity = new Map(entries.map((entry) => [
    `${path.resolve(entry.path)}\0${entry.contentHash}`,
    entry,
  ]));
  const externallyActiveNodes = new Set(activeNodeIds.map(String));

  for (const entry of entries) {
    const lifecyclePathRepresented = lifecycleRecords.some((record) =>
      path.resolve(String(record.receipt.packagePath || '')) === path.resolve(entry.path));
    const fenced = lifecyclePathRepresented ? null : fencedTransactionForEntry({
      entry,
      fencedTransactions: fencedInventory,
      campaigns,
      releases,
      runtimeRoot,
    });
    if (fenced) {
      const { transaction: fencedTransaction, stagingEntry } = fenced;
      if (externallyActiveNodes.has(fencedTransaction.packageNodeId)) {
        protect(declaration, 'activePaths', entry);
        continue;
      }
      const fencedCasReferences = casReferences(entry, casInventory, runtimeRoot);
      if (fencedCasReferences === null) {
        protect(declaration, 'recoveryProtectedPaths', entry);
        continue;
      }
      if (fencedCasReferences.length) {
        protect(declaration, 'referencedPaths', entry);
        continue;
      }
      declaration.deletionEvidence.push({
        path: entry.path,
        contentHash: entry.contentHash,
        evidenceKind: 'package_fenced_staging_generation_verified',
        sourceEvidenceHashes: [
          campaigns.hash,
          releases.hash,
          casInventory.hash,
          fencedInventory.hash,
          fencedTransaction.campaignReleasePackageBuildingTransactionHash,
          fencedTransaction.campaignReleasePackageBuildingFenceHash,
          stagingEntry.campaignReleasePackageBuildingMarkerHash,
          stagingEntry.campaignReleasePackageFencedStagingIdentityHash,
          stagingEntry.campaignReleasePackageFencedStagingTreeIdentityHash,
          stagingEntry.contentHash,
          ...[fencedTransaction
            .campaignReleasePackagePreparedTransactionHash].filter(Boolean),
        ],
      });
      continue;
    }
    const lifecycleRecord = uniqueRecord(lifecycleRecords, (record) =>
      sameEntry(entry, record.receipt, runtimeRoot));
    if (!lifecycleRecord) {
      const currentReleasePath = releases.rows.some((release) => {
        const identity = releaseIdentity(release);
        return identity?.packagePath === path.resolve(entry.path);
      });
      protect(declaration, currentReleasePath ? 'releaseDependentPaths' : 'recoveryProtectedPaths', entry);
      continue;
    }
    const lifecycle = lifecycleRecord.receipt;
    const predecessor = campaignById.get(lifecycle.releaseIdentity.campaignId);
    const predecessorRelease = releaseByCampaign.get(lifecycle.releaseIdentity.campaignId);
    if (!terminalCampaign(predecessor, nodesByCampaign)
      || !releaseMatchesLifecycle(predecessorRelease, lifecycle)) {
      protect(declaration, 'recoveryProtectedPaths', entry);
      continue;
    }
    if ((nodesByCampaign.get(predecessor.campaignId) || [])
      .some((node) => externallyActiveNodes.has(node.nodeId))) {
      protect(declaration, 'activePaths', entry);
      continue;
    }
    const supersessionRecord = uniqueRecord(supersessionRecords, (record) =>
      record.receipt.predecessorLifecycleReceiptHash
        === lifecycle.packageLifecycleReceiptHash);
    if (!supersessionRecord) {
      protect(declaration, 'releaseDependentPaths', entry);
      continue;
    }
    const supersession = supersessionRecord.receipt;
    const successorLifecycleRecord = uniqueRecord(lifecycleRecords, (record) =>
      record.receipt.packageLifecycleReceiptHash
        === supersession.successorLifecycleReceiptHash);
    const successorLifecycle = successorLifecycleRecord?.receipt || null;
    const supersessionVerification = verifyPackageSupersessionReceipt(supersession, {
      predecessorLifecycleReceipt: lifecycle,
      successorLifecycleReceipt: successorLifecycle,
    });
    const successor = campaignById.get(successorLifecycle?.releaseIdentity?.campaignId);
    const successorRelease = releaseByCampaign.get(successorLifecycle?.releaseIdentity?.campaignId);
    const successorEntry = successorLifecycle ? entryByIdentity.get(
      `${path.resolve(successorLifecycle.packagePath)}\0${successorLifecycle.packageContentHash}`,
    ) : null;
    const ledgerOrderValid = Number.isFinite(Date.parse(supersessionRecord.ledgerCreatedAt || ''))
      && Number.isFinite(Date.parse(lifecycleRecord.ledgerCreatedAt || ''))
      && Number.isFinite(Date.parse(successorLifecycleRecord?.ledgerCreatedAt || ''))
      && Date.parse(supersessionRecord.ledgerCreatedAt) >= Date.parse(lifecycleRecord.ledgerCreatedAt)
      && Date.parse(supersessionRecord.ledgerCreatedAt)
        >= Date.parse(successorLifecycleRecord.ledgerCreatedAt);
    if (!supersessionVerification.valid
      || supersessionVerification.version !== 2
      || supersessionVerification.legacy !== false
      || supersessionVerification.deletionAuthorized !== false
      || !successorEntry
      || !sameEntry(successorEntry, successorLifecycle, runtimeRoot)
      || predecessor.effectiveStatus !== 'superseded'
      || !terminalCampaign(successor, nodesByCampaign)
      || !lineageMatches(predecessor, successor, supersession.lineageKind)
      || !releaseMatchesLifecycle(successorRelease, successorLifecycle)
      || !ledgerOrderValid) {
      protect(declaration, 'recoveryProtectedPaths', entry);
      continue;
    }
    const references = campaignReferences({ campaigns, nodesByCampaign, predecessor, successor });
    if (references.active.length || (nodesByCampaign.get(successor.campaignId) || [])
      .some((node) => externallyActiveNodes.has(node.nodeId))) {
      protect(declaration, 'activePaths', entry);
      continue;
    }
    if (references.recovery.length) {
      protect(declaration, 'recoveryProtectedPaths', entry);
      continue;
    }
    const holds = holdRecords.filter((record) => {
      const hold = record.receipt;
      return hold.packageLifecycleReceiptHash === lifecycle.packageLifecycleReceiptHash
        && hold.packagePath === lifecycle.packagePath
        && hold.packageContentHash === lifecycle.packageContentHash
        && verifyPackageRetentionLegalHoldReceipt(hold, { lifecycleReceipt: lifecycle }).valid;
    });
    if (holds.length) {
      protect(declaration, 'recoveryProtectedPaths', entry);
      continue;
    }
    const casReferencesForEntry = casReferences(entry, casInventory, runtimeRoot);
    if (casReferencesForEntry === null) {
      protect(declaration, 'recoveryProtectedPaths', entry);
      continue;
    }
    if (casReferencesForEntry.length) {
      protect(declaration, 'referencedPaths', entry);
      continue;
    }
    const recoveryRecord = uniqueRecord(recoveryRecords, (record) =>
      record.receipt.version === 2
        && record.receipt.packageLifecycleReceiptHash
          === lifecycle.packageLifecycleReceiptHash);
    const recovery = recoveryRecord?.receipt || null;
    const recoveryVerified = recovery
      ? verifyTrustedPackageRecoveryReceipt({
        packageRecoveryAuthority,
        recoveryReceipt: recovery,
        lifecycleReceipt: lifecycle,
      }) : false;
    const liveRecovery = recoveryVerified
      ? inspectTrustedLivePackageRecoverySource({
        packageRecoveryAuthority,
        recoveryReceipt: recovery,
        lifecycleReceipt: lifecycle,
        now,
      }) : null;
    const recoveryLedgerOrderValid = Number.isFinite(
      Date.parse(recoveryRecord?.ledgerCreatedAt || ''),
    ) && Date.parse(recoveryRecord.ledgerCreatedAt)
      >= Date.parse(lifecycleRecord.ledgerCreatedAt);
    if (!recoveryVerified || !liveRecovery || !recoveryLedgerOrderValid) {
      protect(declaration, 'recoveryProtectedPaths', entry);
      continue;
    }
    authority.recoveryAuthoritySnapshotHashes.push(liveRecovery.authoritySnapshotHash);
    authority.recoverySourceInventoryHashes.push(recovery.sourceInventoryHash);
    const deletionLeaseBindingHash = recoveryDeletionLeaseBindingHash({
      lifecycle,
      recovery,
      liveRecovery,
    });
    declaration.deletionEvidence.push({
      path: entry.path,
      contentHash: entry.contentHash,
      evidenceKind: 'package_superseded_recovery_verified',
      packageLifecycleReceiptHash: lifecycle.packageLifecycleReceiptHash,
      packageRetentionRecoveryReceiptHash:
        recovery.packageRetentionRecoveryReceiptHash,
      packageRecoveryDeletionLeaseBindingHash: deletionLeaseBindingHash,
      packageRecoveryTreeInventoryHash:
        lifecycle.packageRecoveryTreeInventoryHash,
      packageRecoveryAuthoritySnapshotHash: liveRecovery.authoritySnapshotHash,
      storageAuthorityId: recovery.storageAuthorityId,
      storageObjectId: recovery.storageObjectId,
      storageObjectVersion: recovery.storageObjectVersion,
      storageObjectBytesHash: recovery.storageObjectBytesHash,
      retentionLockVersion: recovery.retentionLockVersion,
      retentionLockIdentityHash: recovery.retentionLockIdentityHash,
      retainUntil: recovery.retainUntil,
      storageLedgerReceiptId: recovery.storageLedgerReceiptId,
      storageLedgerReceiptHash: recovery.storageLedgerReceiptHash,
      trustStoreHash: recovery.trustStoreHash,
      sourceEvidenceHashes: [
        campaigns.hash,
        releases.hash,
        casInventory.hash,
        ledger.inventoryHash,
        lifecycle.packageLifecycleReceiptHash,
        supersession.packageSupersessionReceiptHash,
        successorLifecycle.packageLifecycleReceiptHash,
        recovery.packageRetentionRecoveryReceiptHash,
        recovery.packageImmutableRecoverySourceAuthorityHash,
        recovery.packageExactRestoreDrillReceiptHash,
        recovery.storageObjectBytesHash,
        recovery.packageRecoveryStorageAuthorityProofHash,
        recovery.packageRecoveryRetentionPolicyHash,
        recovery.sourceInventoryHash,
        liveRecovery.authoritySnapshotHash,
        deletionLeaseBindingHash,
        liveRecovery.retentionLockIdentityHash,
        hashRecord('RuntimeRetentionPackageCampaignAuthority', { predecessor, successor }),
        hashRecord('RuntimeRetentionPackageReleaseAuthority', {
          predecessor: predecessorRelease,
          successor: successorRelease,
        }),
      ],
    });
  }
  authority.recoveryAuthoritySnapshotHashes = Object.freeze([
    ...new Set(authority.recoveryAuthoritySnapshotHashes),
  ].sort());
  authority.recoverySourceInventoryHashes = Object.freeze([
    ...new Set(authority.recoverySourceInventoryHashes),
  ].sort());
  return Object.freeze({ declaration, authority: Object.freeze(authority) });
}
