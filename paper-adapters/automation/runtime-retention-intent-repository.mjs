import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { readRegularJsonFileSync } from '../runtime/pinned-file-reader.mjs';
import {
  assertIntentReachabilityManifest,
  freshReachabilityManifestForIntent,
} from './runtime-retention-live-authority.mjs';
import {
  finalizeRetentionRemovalRecoveries,
  restoreRetentionQuarantines,
} from './runtime-retention-quarantine-repository.mjs';
import { reconcilePublishedPackageDeletionFencesSync }
  from './runtime-retention-published-package-deletion-lease.mjs';
import {
  assertRuntimeRetentionTrustedLedger,
  assertTrustedRetentionReceipt,
  findUniqueTrustedRetentionTombstone,
  recordTrustedRetentionReceipt,
} from './runtime-retention-trusted-receipt-repository.mjs';
import {
  retentionMemberIdentity,
  retentionPathExists,
} from './runtime-retention-scope-repository.mjs';
import {
  REACHABILITY_GOVERNED,
  assertRetentionReceiptDerivedFromIntent,
  buildRetentionIntent,
  completeRetentionIntent,
  preflightRemoval,
  reachabilityManifestForIntent,
  tombstonePathForIntent,
  verifyRetentionIntent,
} from './runtime-retention-intent-operations.mjs';

export function reconcileRuntimeRetentionIntents({
  runtimeRoot,
  workspaceRegistry = null,
  receiptLedger = null,
  reachabilityManifest = null,
  reachabilityManifestProvider = null,
  activeNodeIds = [],
  retentionReceiptLedger,
  packageRecoveryDeletionLeasePort = null,
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
        finalizeRetentionRemovalRecoveries(intent, {
          tombstone: committedReceipt,
          retentionReceiptLedger,
        });
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
        finalizeRetentionRemovalRecoveries(intent, {
          tombstone: committedReceipt,
          retentionReceiptLedger,
        });
        recovered.push(Object.freeze({
          intentPath,
          receiptPath,
          status: 'runtime_retention_already_converged',
        }));
        continue;
      }
      const fenceReconciliation =
        reconcilePublishedPackageDeletionFencesSync({
          intent,
          packageRecoveryDeletionLeasePort,
          phase: 'before_restore',
          faultInjector,
        });
      restoreRetentionQuarantines(intent, {
        faultInjector,
        ...fenceReconciliation,
      });
      reconcilePublishedPackageDeletionFencesSync({
        intent,
        packageRecoveryDeletionLeasePort,
        phase: 'after_restore',
        faultInjector,
      });
      const governedDeletionPending = intent.entries.some((entry) => entry.authorized
        && REACHABILITY_GOVERNED.has(entry.category)
        && entry.members.some((member) => {
          if (!retentionPathExists(member.path)) return false;
          const current = retentionMemberIdentity(member.path);
          return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'nlink', 'entryKind', 'realPath']
            .every((field) => String(current[field]) === String(member.identity?.[field]));
        }));
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
        packageRecoveryDeletionLeasePort,
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
  packageRecoveryDeletionLeasePort = null,
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
    packageRecoveryDeletionLeasePort,
    faultInjector,
  });
}
