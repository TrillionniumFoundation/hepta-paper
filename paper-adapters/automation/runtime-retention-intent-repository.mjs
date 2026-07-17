import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { receiptIssuerPolicies } from '../persistence/receipt-issuer-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { readRegularJsonFileSync } from '../runtime/pinned-file-reader.mjs';
import { verifyWorkspaceRetentionEvidence } from './workspace-retention-evidence.mjs';
import {
  trustedRetentionIssuerRow,
  verifyBackupDeletionMinimum,
  verifyBackupRetentionEvidence,
} from './runtime-retention-evidence-policy.mjs';
import {
  DEFAULT_RETENTION_POLICIES,
  openPinnedRetentionCategory,
  pinnedRetentionMemberPath,
  retentionEntryHash,
  retentionMemberHash,
  retentionMemberPaths,
  retentionPathExists,
  retentionRemovalMembers,
} from './runtime-retention-scope-repository.mjs';

const RUNTIME_RETENTION_POLICY = receiptIssuerPolicies()['runtime-retention'];

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

function preflightRemoval(plan, entry, receiptLedger, workspaceRegistry) {
  const blockers = [];
  const categoryRoot = path.join(plan.runtimeRoot, entry.category);
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
    minimumRecoverableGenerations: Number(entry.minimumRecoverableGenerations || 0),
    categoryScope: entry.categoryScope || null,
    authorized: blockers.length === 0,
    blockers,
    members,
  });
  if (pinned) pinned.close();
  return result;
}

function retentionLedgerIdentity(retentionReceiptLedger, receipt, evidenceClass) {
  if (!retentionReceiptLedger || typeof retentionReceiptLedger.prepare !== 'function') throw new Error('runtime_retention_trusted_ledger_required');
  const prepared = retentionReceiptLedger.prepare(receipt, {
    stream: 'runtime-retention',
    environment: 'administrative',
    evidenceClass,
  });
  if (prepared.writerTrusted !== true
    || prepared.issuerPolicyId !== 'runtime-retention'
    || prepared.issuerPolicyHash !== RUNTIME_RETENTION_POLICY.issuerPolicyHash) {
    throw new Error('runtime_retention_trusted_ledger_required');
  }
  return prepared;
}

function assertTrustedRetentionReceipt(retentionReceiptLedger, receipt, evidenceClass) {
  const identity = retentionLedgerIdentity(retentionReceiptLedger, receipt, evidenceClass);
  const row = retentionReceiptLedger.get(identity.receiptId);
  const trusted = trustedRetentionIssuerRow(row, {
    policyId: 'runtime-retention',
    policy: RUNTIME_RETENTION_POLICY,
    stream: 'runtime-retention',
    evidenceClass,
    kind: receipt.kind,
    receiptId: identity.receiptId,
    receiptHash: identity.receiptHash,
    status: receipt.status,
  });
  if (!trusted) throw new Error('runtime_retention_trusted_receipt_missing_or_invalid');
  return Object.freeze({ receiptId: identity.receiptId, receiptHash: identity.receiptHash });
}

function recordTrustedRetentionReceipt(retentionReceiptLedger, receipt, evidenceClass) {
  retentionLedgerIdentity(retentionReceiptLedger, receipt, evidenceClass);
  retentionReceiptLedger.record(receipt, {
    stream: 'runtime-retention',
    environment: 'administrative',
    evidenceClass,
  });
  return assertTrustedRetentionReceipt(retentionReceiptLedger, receipt, evidenceClass);
}

function buildRetentionIntent(plan, entries, { operationId, createdAt }) {
  const payload = {
    version: 2,
    kind: 'RuntimeRetentionIntent',
    status: 'runtime_retention_intent_recorded',
    operationId,
    runtimeRoot: path.resolve(plan.runtimeRoot),
    planHash: plan.runtimeRetentionPlanHash,
    entries,
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
  for (const entry of intent.entries) {
    const categoryRoot = path.join(runtimeRoot, entry.category || '');
    if (!DEFAULT_RETENTION_POLICIES[entry.category]
      || !entry.categoryScope?.runtimeRoot
      || !entry.categoryScope?.categoryRoot
      || !pathWithin(categoryRoot, entry.path)
      || !Array.isArray(entry.members)
      || entry.members.some((member) => !member?.path
        || (entry.authorized && !member.contentHash)
        || path.dirname(path.resolve(member.path)) !== path.resolve(categoryRoot))) {
      throw new Error('runtime_retention_intent_scope_invalid');
    }
  }
  return intent;
}

function inspectRetentionIntentEntry(intent, entry, { workspaceRegistry = null, receiptLedger = null } = {}) {
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
    }
  } catch (error) {
    blockers.push(String(error?.message || error));
  }
  return { pinned, existingMembers, blockers: [...new Set(blockers)] };
}

function applyRetentionIntent(intent, { workspaceRegistry = null, receiptLedger = null, faultInjector = null } = {}) {
  const removed = [];
  for (let entryIndex = 0; entryIndex < intent.entries.length; entryIndex += 1) {
    const entry = intent.entries[entryIndex];
    const inspection = inspectRetentionIntentEntry(intent, entry, { workspaceRegistry, receiptLedger });
    const { existingMembers, blockers } = inspection;
    try {
      if (entry.authorized && !blockers.length) {
        for (let memberIndex = 0; memberIndex < entry.members.length; memberIndex += 1) {
          const member = entry.members[memberIndex];
          const descriptorPath = pinnedRetentionMemberPath(inspection.pinned, intent.runtimeRoot, entry.category, member.path);
          if (retentionPathExists(descriptorPath)) fs.rmSync(descriptorPath, { recursive: true, force: true });
          faultInjector?.({ stage: 'after_member_removed', intent, entry, entryIndex, member, memberIndex });
        }
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
      alreadyAbsent: Boolean(entry.authorized && blockers.length === 0 && existingMembers.length === 0),
      blockers,
    });
  }
  return removed;
}

function buildRetentionReceipt(intent, removed, { intentPath, createdAt }) {
  const payload = {
    version: 2,
    kind: 'RuntimeRetentionReceipt',
    status: removed.some((entry) => entry.blockers.length) ? 'runtime_retention_partially_blocked' : 'runtime_retention_applied',
    planHash: intent.planHash,
    intentHash: intent.runtimeRetentionIntentReceiptHash,
    intentReceiptId: `runtime-retention:${intent.runtimeRetentionIntentReceiptHash}`,
    removed,
    bytesEligible: removed.reduce((total, entry) => total + entry.bytes, 0),
    bytesRemoved: removed.filter((entry) => entry.removed).reduce((total, entry) => total + entry.bytes, 0),
    applied: true,
    externalActionPerformed: false,
    intentPath,
    createdAt,
  };
  return Object.freeze({ ...payload, runtimeRetentionReceiptHash: hashRecord('RuntimeRetentionReceipt', payload) });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRetentionReceiptDerivedFromIntent(intent, receipt, intentPath, { workspaceRegistry = null, receiptLedger = null } = {}) {
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
    const inspection = inspectRetentionIntentEntry(intent, entry, { workspaceRegistry, receiptLedger });
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
  retentionReceiptLedger,
  faultInjector = null,
} = {}) {
  const removed = applyRetentionIntent(intent, { workspaceRegistry, receiptLedger, faultInjector });
  if (removed.some((entry) => entry.removed && entry.category === 'automation-workspaces')) workspaceRegistry?.reconcileMissingEligible?.();
  faultInjector?.({ stage: 'before_tombstone', intent, removed });
  const receipt = buildRetentionReceipt(intent, removed, { intentPath, createdAt: new Date().toISOString() });
  const receiptPath = tombstonePathForIntent(intentPath);
  assertRetentionReceiptDerivedFromIntent(intent, receipt, intentPath, { workspaceRegistry, receiptLedger });
  recordTrustedRetentionReceipt(retentionReceiptLedger, receipt, 'retention_tombstone');
  faultInjector?.({ stage: 'after_trusted_tombstone_recorded', intent, receipt });
  writeDurableJsonSync(receiptPath, receipt);
  return Object.freeze({ ...receipt, receiptPath });
}

export function reconcileRuntimeRetentionIntents({
  runtimeRoot,
  workspaceRegistry = null,
  receiptLedger = null,
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
      const intentIdentity = assertTrustedRetentionReceipt(retentionReceiptLedger, intent, 'retention_intent');
      if (intentIdentity.receiptHash !== intent.runtimeRetentionIntentReceiptHash) throw new Error('runtime_retention_intent_ledger_hash_mismatch');
      const existingReceipt = readRegularJsonFileSync(receiptPath);
      if (existingReceipt) {
        assertRetentionReceiptDerivedFromIntent(intent, existingReceipt, intentPath, { workspaceRegistry, receiptLedger });
        assertTrustedRetentionReceipt(retentionReceiptLedger, existingReceipt, 'retention_tombstone');
        recovered.push(Object.freeze({ intentPath, receiptPath, status: 'runtime_retention_already_converged' }));
        continue;
      }
      const receipt = completeRetentionIntent(intent, intentPath, {
        workspaceRegistry,
        receiptLedger,
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
  retentionLedgerIdentity(retentionReceiptLedger, { kind: 'RuntimeRetentionIntent' }, 'retention_intent');
  const createdAt = new Date().toISOString();
  const operationId = crypto.randomUUID();
  const receiptRoot = path.join(plan.runtimeRoot, 'retention');
  const intentPath = path.join(receiptRoot, `runtime-retention-${createdAt.replace(/[:.]/g, '-')}-${operationId}.intent.json`);
  const entries = (plan.removals || []).map((entry) => preflightRemoval(plan, entry, receiptLedger, workspaceRegistry));
  const intent = buildRetentionIntent(plan, entries, { operationId, createdAt });
  writeDurableJsonSync(intentPath, intent);
  const recordedIntent = recordTrustedRetentionReceipt(retentionReceiptLedger, intent, 'retention_intent');
  if (recordedIntent.receiptHash !== intent.runtimeRetentionIntentReceiptHash) throw new Error('runtime_retention_intent_ledger_hash_mismatch');
  faultInjector?.({ stage: 'after_intent_recorded', intent, intentPath });
  return completeRetentionIntent(intent, intentPath, {
    workspaceRegistry,
    receiptLedger,
    retentionReceiptLedger,
    faultInjector,
  });
}
