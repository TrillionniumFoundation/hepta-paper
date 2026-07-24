import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  fsyncDirectorySync,
  writeDurableJsonSync,
} from '../runtime/durable-json-repository.mjs';
import {
  fileSha256HashSync,
  readRegularJsonFileSync,
} from '../runtime/pinned-file-reader.mjs';
import {
  autonomousResearchStateBackupAuthorityReceiptHash,
  verifyAutonomousResearchStateBackupAuthorityCurrentHead,
  verifyAutonomousResearchStateBackupAuthorityFinalization,
  verifyAutonomousResearchStateBackupAuthorityReservation,
} from './autonomous-research-state-backup-authority.mjs';
import {
  auditSkippedAutonomousResearchStateBackupCandidate,
  buildAutonomousResearchStateBackupSourcesReadyInspection,
} from './autonomous-research-state-backup-source-inspection.mjs';
import {
  validateStoredAutonomousResearchStateRestoreDrillReceipt,
} from './autonomous-research-state-restore-receipt-validation.mjs';

export function createAutonomousResearchStateBackupSourceOperations({
  safeBundlePath,
  validateBundle,
  observedNow,
  currentHeadRequest,
} = {}) {
  if ([safeBundlePath, validateBundle, observedNow, currentHeadRequest]
    .some((value) => typeof value !== 'function')) {
    throw new Error('autonomous_research_state_backup_source_operations_invalid');
  }

  async function observeCurrentHead({
    bundlePath,
    backupRoot = path.dirname(bundlePath || ''),
    stateDatabaseManifest,
    authorityClient,
    authorityTrust,
    clock = null,
  } = {}) {
    let bundle = null;
    let currentHead = null;
    try {
      if (!authorityClient?.observeCurrentHead || !authorityTrust) {
        throw new Error('autonomous_research_state_restore_external_authority_required');
      }
      const bundleRoot = safeBundlePath(backupRoot, bundlePath);
      bundle = readRegularJsonFileSync(path.join(
        bundleRoot,
        'AUTONOMOUS_RESEARCH_STATE_BACKUP.json',
      ));
      const blockers = validateBundle({ bundle, stateDatabaseManifest });
      if (!verifyAutonomousResearchStateBackupAuthorityReservation({
        receipt: bundle.authorityReservation,
        request: bundle.authorityReserveRequest,
        trust: authorityTrust,
        now: bundle.authorityReservation.issuedAt,
      })) blockers.push('autonomous_research_state_restore_authority_reservation_invalid');
      if (!verifyAutonomousResearchStateBackupAuthorityFinalization({
        receipt: bundle.authorityFinalization,
        request: bundle.authorityFinalizeRequest,
        reservation: bundle.authorityReservation,
        trust: authorityTrust,
        now: bundle.authorityFinalization.finalizedAt,
      })) blockers.push('autonomous_research_state_restore_authority_finalization_invalid');
      if (blockers.length) throw new Error(blockers[0]);
      const request = currentHeadRequest(
        bundle,
        observedNow(clock).toISOString(),
        authorityTrust.maximumReservationLeaseMs,
      );
      currentHead = await authorityClient.observeCurrentHead(request);
      if (!verifyAutonomousResearchStateBackupAuthorityCurrentHead({
        receipt: currentHead,
        request,
        trust: authorityTrust,
        now: observedNow(clock),
      })) throw new Error('autonomous_research_state_restore_current_authority_head_invalid');
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchStateBackupCurrentHeadInspection',
        status: 'autonomous_research_state_backup_current_head_observed',
        bundlePath: bundleRoot,
        bundleManifestHash: bundle.bundleManifestHash,
        snapshotContentHash: bundle.snapshotContentHash,
        snapshotHeadSequence: bundle.authorityFinalization.headSequence,
        snapshotHeadHash: bundle.authorityFinalization.headHash,
        authorityCurrentHeadRequest: request,
        authorityCurrentHeadReceipt: currentHead,
        authorityCurrentHeadReceiptHash:
          autonomousResearchStateBackupAuthorityReceiptHash(currentHead),
        observedAt: observedNow(clock).toISOString(),
        externalActionPerformed: true,
        productionStateMutated: false,
        blockers: Object.freeze([]),
      });
    } catch (error) {
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchStateBackupCurrentHeadInspection',
        status: 'autonomous_research_state_backup_current_head_blocked',
        bundlePath: bundlePath || null,
        bundleManifestHash: bundle?.bundleManifestHash || null,
        authorityCurrentHeadReceiptHash: currentHead
          ? autonomousResearchStateBackupAuthorityReceiptHash(currentHead)
          : null,
        externalActionPerformed: true,
        productionStateMutated: false,
        blockers: Object.freeze([
          error?.message
            || 'autonomous_research_state_backup_current_head_observation_failed',
        ]),
      });
    }
  }

  function publishRenewalReceipt({ backupRoot, bundlePath, receipt } = {}) {
    const bundleRoot = safeBundlePath(backupRoot, bundlePath);
    if (receipt?.version !== 1
      || receipt?.kind !== 'AutonomousResearchStateBackupRenewalReceipt'
      || receipt?.status !== 'autonomous_research_state_backup_renewal_complete'
      || receipt?.bundlePath !== bundleRoot
      || receipt?.productionStateMutated !== false
      || !Array.isArray(receipt?.blockers)
      || receipt.blockers.length !== 0) {
      throw new Error('autonomous_research_state_backup_renewal_receipt_invalid');
    }
    const { renewalReceiptHash, ...payload } = receipt;
    if (renewalReceiptHash
      !== hashRecord('AutonomousResearchStateBackupRenewalReceipt', payload)) {
      throw new Error('autonomous_research_state_backup_renewal_receipt_hash_invalid');
    }
    const storedRestoreReceipt = readRegularJsonFileSync(path.join(
      bundleRoot,
      'RESTORE_DRILL_RECEIPT.json',
    ));
    if (storedRestoreReceipt.restoreDrillReceiptHash !== receipt.restoreDrillReceiptHash
      || storedRestoreReceipt.recoverabilityBindingHash
        !== receipt.recoverabilityBindingHash) {
      throw new Error('autonomous_research_state_backup_renewal_restore_binding_invalid');
    }
    writeDurableJsonSync(path.join(bundleRoot, 'RENEWAL_RECEIPT.json'), receipt);
    fsyncDirectorySync(bundleRoot);
    return receipt;
  }

  function resolveLatestSources({
    runtimeRoot,
    backupRoot = path.join(runtimeRoot, 'backups', 'autonomous-research-state'),
    stateDatabaseManifest,
    authorityTrust,
    onlineMutationVerifier = null,
  } = {}) {
    const resolvedBackupRoot = path.resolve(backupRoot);
    if (!authorityTrust) {
      return Object.freeze({
        status: 'autonomous_research_state_backup_sources_blocked',
        bundlePath: null,
        sources: Object.freeze([]),
        skippedCandidates: Object.freeze([]),
        blockers: Object.freeze([
          'autonomous_research_state_backup_source_authority_trust_required',
        ]),
      });
    }
    if (!fs.existsSync(resolvedBackupRoot)) {
      return Object.freeze({
        status: 'autonomous_research_state_backup_sources_blocked',
        bundlePath: null,
        sources: Object.freeze([]),
        blockers: Object.freeze(['autonomous_research_state_backup_bundle_missing']),
      });
    }
    const candidates = fs.readdirSync(resolvedBackupRoot, { withFileTypes: true })
      .filter((entry) => (
        entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')
      ))
      .map((entry) => {
        const bundlePath = path.join(resolvedBackupRoot, entry.name);
        return { bundlePath, modifiedAtMs: fs.statSync(bundlePath).mtimeMs };
      })
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs
        || right.bundlePath.localeCompare(left.bundlePath));
    if (!candidates.length) {
      return Object.freeze({
        status: 'autonomous_research_state_backup_sources_blocked',
        bundlePath: null,
        sources: Object.freeze([]),
        blockers: Object.freeze(['autonomous_research_state_backup_bundle_missing']),
      });
    }
    const skippedCandidates = [];
    for (const candidate of candidates) {
      const { bundlePath } = candidate;
      const blockers = [];
      let bundle = null;
      try {
        safeBundlePath(resolvedBackupRoot, bundlePath);
        const manifestPath = path.join(
          bundlePath,
          'AUTONOMOUS_RESEARCH_STATE_BACKUP.json',
        );
        const restoreReceiptPath = path.join(bundlePath, 'RESTORE_DRILL_RECEIPT.json');
        bundle = readRegularJsonFileSync(manifestPath);
        blockers.push(...validateBundle({ bundle, stateDatabaseManifest }));
        if (blockers.length) {
          throw new Error('autonomous_research_state_backup_candidate_invalid');
        }
        const restoreReceipt = readRegularJsonFileSync(restoreReceiptPath);
        blockers.push(...validateStoredAutonomousResearchStateRestoreDrillReceipt({
          receipt: restoreReceipt,
          bundle,
          bundlePath,
          authorityTrust,
          onlineMutationVerifier,
        }));
        const expectedDatabasePaths = new Set(
          bundle.content.databases.map((entry) => entry.backupRelativePath),
        );
        const databaseRoot = path.join(bundlePath, 'databases');
        const presentDatabasePaths = fs.existsSync(databaseRoot)
          ? fs.readdirSync(databaseRoot).filter((name) => name.endsWith('.sqlite'))
            .map((name) => `databases/${name}`)
          : [];
        if (presentDatabasePaths.length !== expectedDatabasePaths.size
          || presentDatabasePaths.some((entry) => !expectedDatabasePaths.has(entry))) {
          blockers.push('autonomous_research_state_backup_source_database_set_invalid');
        }
        for (const entry of bundle?.content?.databases || []) {
          const candidatePath = path.resolve(bundlePath, entry.backupRelativePath);
          if (!pathWithin(bundlePath, candidatePath)
            || !fs.existsSync(candidatePath)
            || !fs.lstatSync(candidatePath).isFile()
            || fs.lstatSync(candidatePath).isSymbolicLink()
            || !pathWithin(fs.realpathSync(bundlePath), fs.realpathSync(candidatePath))
            || fs.statSync(candidatePath).size !== entry.bytes
            || fileSha256HashSync(candidatePath) !== entry.backupSha256) {
            blockers.push('autonomous_research_state_backup_source_database_invalid');
          }
        }
        if (blockers.length) {
          throw new Error('autonomous_research_state_backup_sources_invalid');
        }
        const sources = [
          Object.freeze({ role: 'autonomous_state_backup_manifest', path: manifestPath }),
          Object.freeze({
            role: 'autonomous_state_restore_drill_receipt',
            path: restoreReceiptPath,
          }),
          ...bundle.content.databases.map((entry) => Object.freeze({
            role: `autonomous_state_database:${entry.instanceId}`,
            path: path.join(bundlePath, entry.backupRelativePath),
          })),
        ];
        return buildAutonomousResearchStateBackupSourcesReadyInspection({
          bundlePath,
          bundle,
          restoreReceipt,
          sources,
          skippedCandidates,
        });
      } catch {
        if (!blockers.length) {
          blockers.push('autonomous_research_state_backup_candidate_invalid');
        }
        skippedCandidates.push(auditSkippedAutonomousResearchStateBackupCandidate(
          candidate,
          blockers,
        ));
      }
    }
    return Object.freeze({
      status: 'autonomous_research_state_backup_sources_blocked',
      bundlePath: null,
      sources: Object.freeze([]),
      skippedCandidates: Object.freeze(skippedCandidates),
      blockers: Object.freeze([
        'autonomous_research_state_backup_no_valid_restore_drill_bundle',
      ]),
    });
  }

  return Object.freeze({ observeCurrentHead, publishRenewalReceipt, resolveLatestSources });
}
