import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { readRegularJsonFileSync } from '../runtime/pinned-file-reader.mjs';
import { verifyWorkspaceRetentionEvidence } from './workspace-retention-evidence.mjs';
import { verifyBackupDeletionMinimum, verifyBackupRetentionEvidence } from './runtime-retention-evidence-policy.mjs';
import {
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
import { assertIntentReachabilityManifest, freshReachabilityManifestForIntent } from './runtime-retention-live-authority.mjs';
import {
  bindRetentionQuarantineMembers,
  removeRetentionEntryThroughQuarantine,
  restoreRetentionQuarantines,
  verifyRetentionQuarantineMemberBinding,
} from './runtime-retention-quarantine-repository.mjs';
import {
  assertRuntimeRetentionTrustedLedger,
  assertTrustedRetentionReceipt,
  findUniqueTrustedRetentionTombstone,
  recordTrustedRetentionReceipt,
} from './runtime-retention-trusted-receipt-repository.mjs';
import { buildRuntimeRetentionReceipt } from './runtime-retention-receipt-builder.mjs';

const REACHABILITY_GOVERNED = new Set(REACHABILITY_GOVERNED_RETENTION_CATEGORIES);

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

function preflightRemoval(plan, entry, receiptLedger, workspaceRegistry, reachabilityManifest) {
  const blockers = [];
  const categoryRoot = runtimeRetentionCategoryRoot(plan.runtimeRoot, entry.category);
  let pinned = null;
  let members = retentionMemberPaths(entry).map((candidate) => ({ path: candidate, contentHash: null }));
  try {
    pinned = openPinnedRetentionCategory(plan.runtimeRoot, entry.category, entry.categoryScope);
    members = retentionRemovalMembers(entry, pinned, plan.runtimeRoot);
  } catch (error) {
    blockers.push(String(error?.message || error));
  }
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
    const evidence = verifyBackupRetentionEvidence(entry, receiptLedger);
    if (!evidence.verified) blockers.push(...evidence.blockers);
    if (evidence.backupReceiptId !== entry.backupEvidence?.backupReceiptId
      || evidence.restoreDrillReceiptId !== entry.backupEvidence?.restoreDrillReceiptId) {
      blockers.push('backup_retention_evidence_changed_after_plan');
    }
    blockers.push(...verifyBackupDeletionMinimum(
      plan.runtimeRoot,
      entry,
      receiptLedger,
      entry.minimumRecoverableGenerations,
    ).blockers);
  }
  let retentionDeletionEvidence = entry.retentionDeletionEvidence || null;
  let reachabilityManifestHash = entry.reachabilityManifestHash || null;
  if (!blockers.length && REACHABILITY_GOVERNED.has(entry.category)) {
    const current = currentReachabilityRemoval(plan, entry, reachabilityManifest);
    retentionDeletionEvidence = current.verification.evidence;
    reachabilityManifestHash = current.verification.reachabilityManifestHash;
    blockers.push(...current.blockers);
  }
  const result = Object.freeze({
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
  if (pinned) pinned.close();
  return result;
}

function buildRetentionIntent(plan, entries, { operationId, createdAt }) {
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

function verifyRetentionIntent(intent, runtimeRoot) {
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
} = {}) {
  const blockers = [...(entry.blockers || [])];
  let pinned = null;
  let existingMembers = [];
  try {
    pinned = openPinnedRetentionCategory(intent.runtimeRoot, entry.category, entry.categoryScope);
    existingMembers = entry.members.map((member) => ({
      member,
      descriptorPath: pinnedRetentionMemberPath(pinned, intent.runtimeRoot, entry.category, member.path),
    })).filter(({ descriptorPath }) => retentionPathExists(descriptorPath));
    if (entry.authorized && !blockers.length) {
      for (const { member, descriptorPath } of existingMembers) {
        if (retentionMemberHash(descriptorPath) !== member.contentHash) blockers.push('retention_entry_hash_changed_after_intent');
      }
      if (!blockers.length && entry.category === 'backups' && existingMembers.length === entry.members.length) {
        const evidence = verifyBackupRetentionEvidence({ path: entry.path, companionPaths: entry.companionPaths }, receiptLedger);
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
        ).blockers);
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

function reachabilityManifestForIntent(intent, suppliedManifest, provider) {
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
    const inspection = inspectRetentionIntentEntry(intent, entry, {
      workspaceRegistry,
      receiptLedger,
      reachabilityManifest,
      freshReachabilityManifest,
    });
    const { blockers } = inspection;
    try {
      if (entry.authorized && !blockers.length) {
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
          },
        );
      }
    } finally {
      inspection.pinned?.close();
    }
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

function assertRetentionReceiptDerivedFromIntent(intent, receipt, intentPath, {
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

function tombstonePathForIntent(intentPath) {
  return String(intentPath).replace(/\.intent\.json$/, '.tombstone.json');
}
function completeRetentionIntent(intent, intentPath, {
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

export function reconcileRuntimeRetentionIntents({
  runtimeRoot,
  workspaceRegistry = null,
  receiptLedger = null,
  reachabilityManifest = null,
  reachabilityManifestProvider = null,
  activeNodeIds = [],
  retentionReceiptLedger,
  faultInjector = null,
} = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const receiptRoot = path.join(root, 'retention');
  if (!fs.existsSync(receiptRoot)) return Object.freeze({ status: 'runtime_retention_recovery_complete', recovered: [], blockers: [] });
  const recovered = [];
  const blockers = [];
  for (const name of fs.readdirSync(receiptRoot).filter((entry) => entry.endsWith('.intent.json')).sort()) {
    const intentPath = path.join(receiptRoot, name);
    try {
      const rawIntent = readRegularJsonFileSync(intentPath);
      const receiptPath = tombstonePathForIntent(intentPath);
      if (rawIntent?.version === 1) {
        const legacyReceipt = readRegularJsonFileSync(receiptPath);
        const { runtimeRetentionReceiptHash = null, ...legacyPayload } = legacyReceipt || {};
        if (!legacyReceipt
          || legacyReceipt.kind !== 'RuntimeRetentionReceipt'
          || hashRecord('RuntimeRetentionReceipt', legacyPayload) !== runtimeRetentionReceiptHash) {
          throw new Error('runtime_retention_legacy_intent_requires_operator_review');
        }
        recovered.push(Object.freeze({ intentPath, receiptPath, status: 'runtime_retention_legacy_already_converged' }));
        continue;
      }
      const intent = verifyRetentionIntent(rawIntent, root);
      const intentReachabilityManifest = reachabilityManifestForIntent(
        intent,
        reachabilityManifest,
        reachabilityManifestProvider,
      );
      assertIntentReachabilityManifest(intent, intentReachabilityManifest);
      const intentIdentity = assertTrustedRetentionReceipt(retentionReceiptLedger, intent, 'retention_intent');
      if (intentIdentity.receiptHash !== intent.runtimeRetentionIntentReceiptHash) throw new Error('runtime_retention_intent_ledger_hash_mismatch');
      const existingReceipt = readRegularJsonFileSync(receiptPath);
      const committedReceipt = findUniqueTrustedRetentionTombstone(retentionReceiptLedger, intent);
      if (existingReceipt) {
        assertRetentionReceiptDerivedFromIntent(intent, existingReceipt, intentPath, {
          workspaceRegistry,
          receiptLedger,
          reachabilityManifest: intentReachabilityManifest,
          freshReachabilityManifest: intentReachabilityManifest,
        });
        assertTrustedRetentionReceipt(retentionReceiptLedger, existingReceipt, 'retention_tombstone');
        if (committedReceipt?.runtimeRetentionReceiptHash !== existingReceipt.runtimeRetentionReceiptHash) {
          throw new Error('runtime_retention_tombstone_ledger_identity_conflict');
        }
        recovered.push(Object.freeze({ intentPath, receiptPath, status: 'runtime_retention_already_converged' }));
        continue;
      }
      if (committedReceipt) {
        assertRetentionReceiptDerivedFromIntent(intent, committedReceipt, intentPath, {
          workspaceRegistry,
          receiptLedger,
          reachabilityManifest: intentReachabilityManifest,
          freshReachabilityManifest: intentReachabilityManifest,
        });
        writeDurableJsonSync(receiptPath, committedReceipt);
        recovered.push(Object.freeze({
          intentPath,
          receiptPath,
          status: 'runtime_retention_already_converged',
        }));
        continue;
      }
      restoreRetentionQuarantines(intent, { faultInjector });
      const governedDeletionPending = intent.entries.some((entry) => entry.authorized
        && REACHABILITY_GOVERNED.has(entry.category)
        && entry.members.some((member) => retentionPathExists(member.path)));
      const freshReachabilityManifest = governedDeletionPending
        ? freshReachabilityManifestForIntent({
          intent,
          originalManifest: intentReachabilityManifest,
          provider: reachabilityManifestProvider,
          activeNodeIds,
        })
        : intentReachabilityManifest;
      const receipt = completeRetentionIntent(intent, intentPath, {
        workspaceRegistry,
        receiptLedger,
        reachabilityManifest: intentReachabilityManifest,
        freshReachabilityManifest,
        reachabilityManifestProvider,
        activeNodeIds,
        retentionReceiptLedger,
        faultInjector,
      });
      recovered.push(Object.freeze({ intentPath, receiptPath: receipt.receiptPath, status: receipt.status }));
    } catch (error) {
      blockers.push(Object.freeze({ intentPath, blocker: String(error?.message || error) }));
    }
  }
  return Object.freeze({
    status: blockers.length ? 'runtime_retention_recovery_blocked' : 'runtime_retention_recovery_complete',
    recovered,
    blockers,
  });
}

export function executeRuntimeRetentionPlan(plan, {
  apply = false,
  workspaceRegistry = null,
  receiptLedger = null,
  reachabilityManifest = null,
  reachabilityManifestProvider = null,
  activeNodeIds = [],
  retentionReceiptLedger = null,
  faultInjector = null,
} = {}) {
  const { runtimeRetentionPlanHash, ...planPayload } = plan || {};
  if (!runtimeRetentionPlanHash || hashRecord('RuntimeRetentionPlan', planPayload) !== runtimeRetentionPlanHash) throw new Error('runtime_retention_plan_hash_invalid');
  if (!apply) {
    const removed = (plan.removals || []).map((entry) => ({
      category: entry.category,
      path: entry.path,
      companionPaths: entry.companionPaths || [],
      bytes: entry.bytes,
      contentHash: entry.contentHash,
      reason: entry.reason,
      removed: false,
      blockers: [],
    }));
    const payload = {
      version: 2,
      kind: 'RuntimeRetentionReceipt',
      status: 'runtime_retention_dry_run',
      planHash: runtimeRetentionPlanHash,
      removed,
      bytesEligible: removed.reduce((total, entry) => total + entry.bytes, 0),
      bytesRemoved: 0,
      applied: false,
      externalActionPerformed: false,
      intentPath: null,
      createdAt: new Date().toISOString(),
    };
    return Object.freeze({ ...payload, runtimeRetentionReceiptHash: hashRecord('RuntimeRetentionReceipt', payload), receiptPath: null });
  }
  assertRuntimeRetentionTrustedLedger(retentionReceiptLedger);
  const createdAt = new Date().toISOString();
  const operationId = crypto.randomUUID();
  const receiptRoot = path.join(plan.runtimeRoot, 'retention');
  const intentPath = path.join(receiptRoot, `runtime-retention-${createdAt.replace(/[:.]/g, '-')}-${operationId}.intent.json`);
  const entries = (plan.removals || []).map((entry) => preflightRemoval(
    plan,
    entry,
    receiptLedger,
    workspaceRegistry,
    reachabilityManifest,
  ));
  const intent = buildRetentionIntent(plan, entries, { operationId, createdAt });
  writeDurableJsonSync(intentPath, intent);
  const recordedIntent = recordTrustedRetentionReceipt(retentionReceiptLedger, intent, 'retention_intent');
  if (recordedIntent.receiptHash !== intent.runtimeRetentionIntentReceiptHash) throw new Error('runtime_retention_intent_ledger_hash_mismatch');
  faultInjector?.({ stage: 'after_intent_recorded', intent, intentPath });
  const freshReachabilityManifest = freshReachabilityManifestForIntent({
    intent,
    originalManifest: reachabilityManifest,
    provider: reachabilityManifestProvider,
    activeNodeIds,
  });
  return completeRetentionIntent(intent, intentPath, {
    workspaceRegistry,
    receiptLedger,
    reachabilityManifest,
    freshReachabilityManifest,
    reachabilityManifestProvider,
    activeNodeIds,
    retentionReceiptLedger,
    faultInjector,
  });
}
