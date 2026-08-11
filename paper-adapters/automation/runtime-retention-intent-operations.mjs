import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { verifyWorkspaceRetentionEvidence } from './workspace-retention-evidence.mjs';
import {
  verifyBackupDeletionMinimum,
  verifyBackupRetentionEvidence,
} from './runtime-retention-evidence-policy.mjs';
import {
  assertPinnedRetentionCategoryLive,
  DEFAULT_RETENTION_POLICIES,
  REACHABILITY_GOVERNED_RETENTION_CATEGORIES,
  openPinnedRetentionCategory,
  pinnedRetentionMemberPath,
  retentionEntryHash,
  retentionMemberHash,
  retentionMemberPaths,
  retentionPathExists,
  retentionRemovalMembers,
  runtimeRetentionCategoryRoot,
  verifyRuntimeRetentionDeletionEvidence,
} from './runtime-retention-scope-repository.mjs';
import {
  withRuntimeRetentionCategoryLock,
} from './runtime-retention-category-lock-repository.mjs';
import { freshReachabilityManifestForIntent } from './runtime-retention-live-authority.mjs';
import {
  bindRetentionQuarantineMembers,
  removeRetentionEntryThroughQuarantine,
  verifyRetentionQuarantineMemberBinding,
} from './runtime-retention-quarantine-repository.mjs';
import {
  findUniqueTrustedRetentionTombstone,
  recordTrustedRetentionReceipt,
} from './runtime-retention-trusted-receipt-repository.mjs';
import { buildRuntimeRetentionReceipt } from './runtime-retention-receipt-builder.mjs';

export const REACHABILITY_GOVERNED = new Set(REACHABILITY_GOVERNED_RETENTION_CATEGORIES);

function currentWorkspaceRetentionRecord(entry, workspaceRegistry) {
  const records = workspaceRegistry?.retentionRecords?.() || [];
  return records.find((record) => path.resolve(record.workspacePath || record.workspace_path || '') === path.resolve(entry.path))
    || entry.workspaceRecord
    || null;
}
function verifyCurrentWorkspaceRemoval(entry, receiptLedger, workspaceRegistry) {
  const record = currentWorkspaceRetentionRecord(entry, workspaceRegistry);
  const verification = record ? verifyWorkspaceRetentionEvidence(record, receiptLedger) : null;
  const blockers = [];
  if (!record || String(record.retentionState || record.retention_state || 'protected') !== 'eligible') blockers.push('workspace_retention_state_not_eligible');
  if (verification?.verified !== true) blockers.push(...(verification?.blockers || ['workspace_retention_evidence_missing']));
  if (entry.workspaceEvidence?.workspaceRetentionEvidenceHash
    && verification?.workspaceRetentionEvidenceHash !== entry.workspaceEvidence.workspaceRetentionEvidenceHash) {
    blockers.push('workspace_retention_evidence_changed_after_plan');
  }
  return Object.freeze({ record, verification, blockers: [...new Set(blockers)] });
}

function currentReachabilityRemoval(plan, entry, reachabilityManifest) {
  const verification = verifyRuntimeRetentionDeletionEvidence({
    runtimeRoot: plan.runtimeRoot,
    category: entry.category,
    entryPath: entry.path,
    contentHash: entry.contentHash,
    reachabilityManifest,
  });
  const blockers = [...verification.blockers];
  if (verification.reachabilityManifestHash !== entry.reachabilityManifestHash
    || verification.reachabilityManifestHash !== plan.reachabilityManifestHash) {
    blockers.push('retention_reachability_manifest_changed_after_plan');
  }
  if (verification.evidence?.runtimeRetentionDeletionEvidenceHash
    !== entry.retentionDeletionEvidence?.runtimeRetentionDeletionEvidenceHash) {
    blockers.push('retention_deletion_evidence_changed_after_plan');
  }
  return Object.freeze({ verification, blockers: [...new Set(blockers)] });
}

function buildPreflightRemovalResult(
  plan,
  entry,
  receiptLedger,
  workspaceRegistry,
  reachabilityManifest,
  { blockers, categoryRoot, members, pinned },
) {
  if (!DEFAULT_RETENTION_POLICIES[entry.category]
    || !entry.categoryScope
    || !pathWithin(categoryRoot, entry.path)
    || members.some((member) => !pathWithin(categoryRoot, member.path))) {
    blockers.push('retention_entry_scope_invalid');
  }
  if (members[0]?.contentHash === null) blockers.push('retention_entry_missing_before_apply');
  if (members.some((member) => member.contentHash === null)) blockers.push('retention_entry_member_missing_before_apply');
  if (!blockers.length) {
    const pinnedEntry = {
      path: pinnedRetentionMemberPath(pinned, plan.runtimeRoot, entry.category, entry.path),
      companionPaths: (entry.companionPaths || []).map((candidate) => pinnedRetentionMemberPath(pinned, plan.runtimeRoot, entry.category, candidate)),
    };
    if (retentionEntryHash(pinnedEntry) !== entry.contentHash) blockers.push('retention_entry_hash_changed_after_plan');
  }
  let workspaceEvidence = entry.workspaceEvidence || null;
  if (!blockers.length && entry.category === 'automation-workspaces') {
    const current = verifyCurrentWorkspaceRemoval(entry, receiptLedger, workspaceRegistry);
    workspaceEvidence = current.verification;
    blockers.push(...current.blockers);
  }
  if (!blockers.length && entry.category === 'backups') {
    const evidence = verifyBackupRetentionEvidence(entry, receiptLedger, {
      pinned,
      runtimeRoot: plan.runtimeRoot,
    });
    if (!evidence.verified) blockers.push(...evidence.blockers);
    if (evidence.backupReceiptId !== entry.backupEvidence?.backupReceiptId
      || evidence.restoreDrillReceiptId !== entry.backupEvidence?.restoreDrillReceiptId
      || evidence.generationIdentity !== entry.backupEvidence?.generationIdentity) {
      blockers.push('backup_retention_evidence_changed_after_plan');
    }
    blockers.push(...verifyBackupDeletionMinimum(
      plan.runtimeRoot,
      entry,
      receiptLedger,
      entry.minimumRecoverableGenerations,
      { pinned },
    ).blockers);
    try {
      assertPinnedRetentionCategoryLive(
        pinned, plan.runtimeRoot, entry.category, entry.categoryScope,
      );
    } catch (error) {
      blockers.push(String(error?.message || error));
    }
  }
  let retentionDeletionEvidence = entry.retentionDeletionEvidence || null;
  let reachabilityManifestHash = entry.reachabilityManifestHash || null;
  if (!blockers.length && REACHABILITY_GOVERNED.has(entry.category)) {
    const current = currentReachabilityRemoval(plan, entry, reachabilityManifest);
    retentionDeletionEvidence = current.verification.evidence;
    reachabilityManifestHash = current.verification.reachabilityManifestHash;
    blockers.push(...current.blockers);
  }
  return Object.freeze({
    category: entry.category,
    path: path.resolve(entry.path),
    companionPaths: (entry.companionPaths || []).map((candidate) => path.resolve(candidate)),
    bytes: Number(entry.bytes || 0),
    contentHash: entry.contentHash,
    reason: entry.reason,
    backupEvidence: entry.backupEvidence || null,
    workspaceRecord: entry.workspaceRecord || null,
    workspaceEvidence,
    retentionDeletionEvidence,
    reachabilityManifestHash,
    minimumRecoverableGenerations: Number(entry.minimumRecoverableGenerations || 0),
    categoryScope: entry.categoryScope || null,
    authorized: blockers.length === 0,
    blockers,
    members,
  });
}

export function preflightRemoval(plan, entry, receiptLedger, workspaceRegistry, reachabilityManifest) {
  const blockers = [];
  const categoryRoot = runtimeRetentionCategoryRoot(plan.runtimeRoot, entry.category);
  let pinned = null;
  let members = retentionMemberPaths(entry).map(
    (candidate) => ({ path: candidate, contentHash: null }),
  );
  try {
    try {
      pinned = openPinnedRetentionCategory(
        plan.runtimeRoot,
        entry.category,
        entry.categoryScope,
      );
      members = retentionRemovalMembers(entry, pinned, plan.runtimeRoot);
    } catch (error) {
      blockers.push(String(error?.message || error));
    }
    return buildPreflightRemovalResult(
      plan,
      entry,
      receiptLedger,
      workspaceRegistry,
      reachabilityManifest,
      { blockers, categoryRoot, members, pinned },
    );
  } finally {
    pinned?.close();
  }
}

export function buildRetentionIntent(plan, entries, { operationId, createdAt }) {
  const quarantineBoundEntries = bindRetentionQuarantineMembers(entries, operationId);
  const payload = {
    version: 2,
    kind: 'RuntimeRetentionIntent',
    status: 'runtime_retention_intent_recorded',
    operationId,
    runtimeRoot: path.resolve(plan.runtimeRoot),
    planHash: plan.runtimeRetentionPlanHash,
    entries: quarantineBoundEntries,
    createdAt,
  };
  return Object.freeze({ ...payload, runtimeRetentionIntentReceiptHash: hashRecord('RuntimeRetentionIntent', payload) });
}

export function verifyRetentionIntent(intent, runtimeRoot) {
  const { runtimeRetentionIntentReceiptHash = null, ...payload } = intent || {};
  if (intent?.version !== 2
    || intent.kind !== 'RuntimeRetentionIntent'
    || intent.status !== 'runtime_retention_intent_recorded'
    || !Array.isArray(intent.entries)
    || path.resolve(String(intent.runtimeRoot || '')) !== path.resolve(runtimeRoot)
    || hashRecord('RuntimeRetentionIntent', payload) !== runtimeRetentionIntentReceiptHash) {
    throw new Error('runtime_retention_intent_invalid');
  }
  for (let entryIndex = 0; entryIndex < intent.entries.length; entryIndex += 1) {
    const entry = intent.entries[entryIndex];
    const categoryRoot = runtimeRetentionCategoryRoot(runtimeRoot, entry.category || '');
    if (!DEFAULT_RETENTION_POLICIES[entry.category]
      || !entry.categoryScope?.runtimeRoot
      || !entry.categoryScope?.categoryRoot
      || !pathWithin(categoryRoot, entry.path)
      || !Array.isArray(entry.members)
      || entry.members.some((member, memberIndex) => !member?.path
        || (entry.authorized && !member.contentHash)
        || (entry.authorized && !verifyRetentionQuarantineMemberBinding(
          intent.operationId,
          member,
          entryIndex,
          memberIndex,
        ))
        || path.dirname(path.resolve(member.path)) !== path.resolve(categoryRoot))) {
      throw new Error('runtime_retention_intent_scope_invalid');
    }
  }
  return intent;
}

function inspectRetentionIntentEntry(intent, entry, {
  workspaceRegistry = null,
  receiptLedger = null,
  reachabilityManifest = null,
  freshReachabilityManifest = null,
  pinnedCategory = null,
} = {}) {
  const blockers = [...(entry.blockers || [])];
  let pinned = pinnedCategory;
  let existingMembers = [];
  try {
    if (!pinned) {
      pinned = openPinnedRetentionCategory(
        intent.runtimeRoot, entry.category, entry.categoryScope,
      );
    } else {
      assertPinnedRetentionCategoryLive(
        pinned, intent.runtimeRoot, entry.category, entry.categoryScope,
      );
    }
    existingMembers = entry.members.map((member) => ({
      member,
      descriptorPath: pinnedRetentionMemberPath(pinned, intent.runtimeRoot, entry.category, member.path),
    })).filter(({ descriptorPath }) => retentionPathExists(descriptorPath));
    if (entry.authorized && !blockers.length) {
      for (const { member, descriptorPath } of existingMembers) {
        if (retentionMemberHash(descriptorPath) !== member.contentHash) blockers.push('retention_entry_hash_changed_after_intent');
      }
      if (!blockers.length && entry.category === 'backups' && existingMembers.length === entry.members.length) {
        const evidence = verifyBackupRetentionEvidence({
          path: entry.path,
          companionPaths: entry.companionPaths,
        }, receiptLedger, { pinned, runtimeRoot: intent.runtimeRoot });
        if (!evidence.verified) blockers.push(...evidence.blockers);
        if (evidence.backupReceiptId !== entry.backupEvidence?.backupReceiptId
          || evidence.restoreDrillReceiptId !== entry.backupEvidence?.restoreDrillReceiptId) {
          blockers.push('backup_retention_evidence_changed_after_intent');
        }
        blockers.push(...verifyBackupDeletionMinimum(
          intent.runtimeRoot,
          entry,
          receiptLedger,
          entry.minimumRecoverableGenerations,
          { pinned },
        ).blockers);
        assertPinnedRetentionCategoryLive(
          pinned, intent.runtimeRoot, entry.category, entry.categoryScope,
        );
      }
      if (!blockers.length && entry.category === 'automation-workspaces' && existingMembers.length === entry.members.length) {
        const current = verifyCurrentWorkspaceRemoval(entry, receiptLedger, workspaceRegistry);
        blockers.push(...current.blockers);
        if (entry.workspaceEvidence?.workspaceRetentionEvidenceHash
          && current.verification?.workspaceRetentionEvidenceHash !== entry.workspaceEvidence.workspaceRetentionEvidenceHash) {
          blockers.push('workspace_retention_evidence_changed_after_intent');
        }
      }
      if (!blockers.length && REACHABILITY_GOVERNED.has(entry.category)) {
        const current = verifyRuntimeRetentionDeletionEvidence({
          runtimeRoot: intent.runtimeRoot,
          category: entry.category,
          entryPath: entry.path,
          contentHash: entry.contentHash,
          reachabilityManifest,
        });
        blockers.push(...current.blockers);
        if (current.reachabilityManifestHash !== entry.reachabilityManifestHash
          || current.evidence?.runtimeRetentionDeletionEvidenceHash
            !== entry.retentionDeletionEvidence?.runtimeRetentionDeletionEvidenceHash) {
          blockers.push('retention_reachability_evidence_changed_after_intent');
        }
        const fresh = verifyRuntimeRetentionDeletionEvidence({
          runtimeRoot: intent.runtimeRoot,
          category: entry.category,
          entryPath: entry.path,
          contentHash: entry.contentHash,
          reachabilityManifest: freshReachabilityManifest,
        });
        blockers.push(...fresh.blockers);
        if (fresh.evidence?.runtimeRetentionDeletionEvidenceHash
          !== entry.retentionDeletionEvidence?.runtimeRetentionDeletionEvidenceHash) {
          blockers.push('retention_live_reachability_authority_changed');
        }
      }
    }
  } catch (error) {
    blockers.push(String(error?.message || error));
  }
  return { pinned, existingMembers, blockers: [...new Set(blockers)] };
}

export function reachabilityManifestForIntent(intent, suppliedManifest, provider) {
  const hashes = [...new Set(intent.entries
    .filter((entry) => entry.authorized && REACHABILITY_GOVERNED.has(entry.category))
    .map((entry) => entry.reachabilityManifestHash)
    .filter(Boolean))];
  if (!hashes.length) return suppliedManifest;
  if (hashes.length !== 1) throw new Error('runtime_retention_intent_reachability_manifest_ambiguous');
  if (suppliedManifest?.runtimeRetentionReachabilityManifestHash === hashes[0]) return suppliedManifest;
  return provider?.loadManifest?.({ manifestHash: hashes[0] }) || suppliedManifest;
}

function applyRetentionIntent(intent, {
  workspaceRegistry = null,
  receiptLedger = null,
  reachabilityManifest = null,
  freshReachabilityManifest = null,
  reachabilityManifestProvider = null,
  activeNodeIds = [],
  faultInjector = null,
} = {}) {
  const removed = [];
  for (let entryIndex = 0; entryIndex < intent.entries.length; entryIndex += 1) {
    const entry = intent.entries[entryIndex];
    let inspection = null;
    let pinnedCategory = null;
    const inspectAndApply = (pinnedCategory = null, categoryLock = null) => {
      inspection = inspectRetentionIntentEntry(intent, entry, {
        workspaceRegistry,
        receiptLedger,
        reachabilityManifest,
        freshReachabilityManifest,
        pinnedCategory,
      });
      const { blockers } = inspection;
      if (!entry.authorized || blockers.length) return;

      const validateBackupMinimum = entry.category === 'backups'
        ? ({ requireCurrentMinimum }) => {
          categoryLock?.assertHeld();
          assertPinnedRetentionCategoryLive(
            inspection.pinned,
            intent.runtimeRoot,
            entry.category,
            entry.categoryScope,
          );
          const minimum = verifyBackupDeletionMinimum(
            intent.runtimeRoot,
            entry,
            receiptLedger,
            entry.minimumRecoverableGenerations,
            {
              pinned: inspection.pinned,
              requireCurrentMinimum,
            },
          );
          if (!minimum.allowed) {
            throw new Error(
              minimum.blockers[0]
                || 'backup_minimum_recoverable_generations_would_be_violated',
            );
          }
          assertPinnedRetentionCategoryLive(
            inspection.pinned,
            intent.runtimeRoot,
            entry.category,
            entry.categoryScope,
          );
          categoryLock?.assertHeld();
        } : null;

      removeRetentionEntryThroughQuarantine(
        intent,
        entry,
        entryIndex,
        inspection.pinned,
        {
          faultInjector,
          revalidateAuthority: REACHABILITY_GOVERNED.has(entry.category)
            ? () => freshReachabilityManifestForIntent({
              intent,
              originalManifest: reachabilityManifest,
              provider: reachabilityManifestProvider,
              activeNodeIds,
              entries: [entry],
            })
            : null,
          validateQuarantinedState: validateBackupMinimum
            ? () => validateBackupMinimum({ requireCurrentMinimum: true }) : null,
          validateRemovedState: validateBackupMinimum
            ? () => validateBackupMinimum({ requireCurrentMinimum: true }) : null,
          assertCategoryLock: categoryLock?.assertHeld || null,
        },
      );
    };

    try {
      if (entry.category !== 'backups') {
        inspectAndApply();
      } else {
        try {
          pinnedCategory = openPinnedRetentionCategory(
            intent.runtimeRoot,
            entry.category,
            entry.categoryScope,
          );
        } catch (error) {
          inspection = {
            pinned: null,
            existingMembers: [],
            blockers: [...new Set([
              ...(entry.blockers || []),
              String(error?.message || error),
            ])],
          };
        }
        if (pinnedCategory) {
          withRuntimeRetentionCategoryLock(
            pinnedCategory,
            entry.category,
            (categoryLock) => {
              inspectAndApply(pinnedCategory, categoryLock);
            },
          );
        }
      }
    } finally {
      (inspection?.pinned || pinnedCategory)?.close();
    }
    const blockers = inspection?.blockers || ['runtime_retention_entry_inspection_failed'];
    removed.push({
      category: entry.category,
      path: entry.path,
      companionPaths: entry.companionPaths,
      bytes: entry.bytes,
      contentHash: entry.contentHash,
      reason: entry.reason,
      removed: Boolean(entry.authorized && blockers.length === 0),
      alreadyAbsent: false,
      blockers,
    });
  }
  return removed;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertRetentionReceiptDerivedFromIntent(intent, receipt, intentPath, {
  workspaceRegistry = null,
  receiptLedger = null,
  reachabilityManifest = null,
  freshReachabilityManifest = reachabilityManifest,
} = {}) {
  const { runtimeRetentionReceiptHash = null, ...payload } = receipt || {};
  const exactReceiptKeys = [
    'applied', 'bytesEligible', 'bytesRemoved', 'createdAt', 'externalActionPerformed', 'intentHash',
    'intentPath', 'intentReceiptId', 'kind', 'planHash', 'removed', 'runtimeRetentionReceiptHash',
    'status', 'version',
  ].sort();
  if (receipt?.version !== 2
    || receipt.kind !== 'RuntimeRetentionReceipt'
    || !sameJson(Object.keys(receipt).sort(), exactReceiptKeys)
    || !Array.isArray(receipt.removed)
    || receipt.removed.length !== intent.entries.length
    || receipt.planHash !== intent.planHash
    || receipt.intentHash !== intent.runtimeRetentionIntentReceiptHash
    || receipt.intentReceiptId !== `runtime-retention:${intent.runtimeRetentionIntentReceiptHash}`
    || path.resolve(String(receipt.intentPath || '')) !== path.resolve(intentPath)
    || receipt.applied !== true
    || receipt.externalActionPerformed !== false
    || !Number.isFinite(Date.parse(receipt.createdAt || ''))
    || Date.parse(receipt.createdAt) < Date.parse(intent.createdAt || '')
    || hashRecord('RuntimeRetentionReceipt', payload) !== runtimeRetentionReceiptHash) {
    throw new Error('runtime_retention_tombstone_invalid');
  }

  let expectedBytesEligible = 0;
  let expectedBytesRemoved = 0;
  let hasBlockers = false;
  const exactResultKeys = ['alreadyAbsent', 'blockers', 'bytes', 'category', 'companionPaths', 'contentHash', 'path', 'reason', 'removed'].sort();
  for (let index = 0; index < intent.entries.length; index += 1) {
    const entry = intent.entries[index];
    const result = receipt.removed[index];
    const inspection = inspectRetentionIntentEntry(intent, entry, {
      workspaceRegistry,
      receiptLedger,
      reachabilityManifest,
      freshReachabilityManifest,
    });
    try {
      const expectedMetadata = {
        category: entry.category,
        path: entry.path,
        companionPaths: entry.companionPaths,
        bytes: entry.bytes,
        contentHash: entry.contentHash,
        reason: entry.reason,
      };
      const actualMetadata = {
        category: result?.category,
        path: result?.path,
        companionPaths: result?.companionPaths,
        bytes: result?.bytes,
        contentHash: result?.contentHash,
        reason: result?.reason,
      };
      const shouldBeRemoved = Boolean(entry.authorized && inspection.blockers.length === 0);
      if (!result
        || !sameJson(Object.keys(result).sort(), exactResultKeys)
        || !sameJson(actualMetadata, expectedMetadata)
        || typeof result.removed !== 'boolean'
        || typeof result.alreadyAbsent !== 'boolean'
        || !Array.isArray(result.blockers)
        || result.blockers.some((blocker) => typeof blocker !== 'string')
        || result.removed !== shouldBeRemoved
        || (result.alreadyAbsent && !result.removed)
        || !sameJson(result.blockers, inspection.blockers)
        || (shouldBeRemoved && inspection.existingMembers.length !== 0)) {
        throw new Error('runtime_retention_tombstone_not_derived_from_intent');
      }
      expectedBytesEligible += Number(entry.bytes || 0);
      if (shouldBeRemoved) expectedBytesRemoved += Number(entry.bytes || 0);
      if (inspection.blockers.length) hasBlockers = true;
    } finally {
      inspection.pinned?.close();
    }
  }
  const expectedStatus = hasBlockers ? 'runtime_retention_partially_blocked' : 'runtime_retention_applied';
  if (receipt.status !== expectedStatus
    || Number(receipt.bytesEligible) !== expectedBytesEligible
    || Number(receipt.bytesRemoved) !== expectedBytesRemoved) {
    throw new Error('runtime_retention_tombstone_not_derived_from_intent');
  }
  return receipt;
}

export function tombstonePathForIntent(intentPath) {
  return String(intentPath).replace(/\.intent\.json$/, '.tombstone.json');
}
export function completeRetentionIntent(intent, intentPath, {
  workspaceRegistry = null,
  receiptLedger = null,
  reachabilityManifest = null,
  freshReachabilityManifest = reachabilityManifest,
  reachabilityManifestProvider = null,
  activeNodeIds = [],
  retentionReceiptLedger,
  faultInjector = null,
} = {}) {
  const receiptPath = tombstonePathForIntent(intentPath);
  const alreadyCommitted = findUniqueTrustedRetentionTombstone(retentionReceiptLedger, intent);
  if (alreadyCommitted) {
    assertRetentionReceiptDerivedFromIntent(intent, alreadyCommitted, intentPath, {
      workspaceRegistry,
      receiptLedger,
      reachabilityManifest,
      freshReachabilityManifest,
    });
    writeDurableJsonSync(receiptPath, alreadyCommitted);
    return Object.freeze({ ...alreadyCommitted, receiptPath });
  }
  const removed = applyRetentionIntent(intent, {
    workspaceRegistry,
    receiptLedger,
    reachabilityManifest,
    freshReachabilityManifest,
    reachabilityManifestProvider,
    activeNodeIds,
    faultInjector,
  });
  if (removed.some((entry) => entry.removed && entry.category === 'automation-workspaces')) workspaceRegistry?.reconcileMissingEligible?.();
  faultInjector?.({ stage: 'before_tombstone', intent, removed });
  const committedDuringApply = findUniqueTrustedRetentionTombstone(retentionReceiptLedger, intent);
  const receipt = committedDuringApply
    || buildRuntimeRetentionReceipt(intent, removed, { intentPath, createdAt: intent.createdAt });
  assertRetentionReceiptDerivedFromIntent(intent, receipt, intentPath, {
    workspaceRegistry,
    receiptLedger,
    reachabilityManifest,
    freshReachabilityManifest,
  });
  if (!committedDuringApply) recordTrustedRetentionReceipt(retentionReceiptLedger, receipt, 'retention_tombstone');
  const uniqueCommitted = findUniqueTrustedRetentionTombstone(retentionReceiptLedger, intent);
  if (uniqueCommitted?.runtimeRetentionReceiptHash !== receipt.runtimeRetentionReceiptHash) {
    throw new Error('runtime_retention_tombstone_ledger_identity_conflict');
  }
  faultInjector?.({ stage: 'after_trusted_tombstone_recorded', intent, receipt });
  writeDurableJsonSync(receiptPath, receipt);
  return Object.freeze({ ...receipt, receiptPath });
}
