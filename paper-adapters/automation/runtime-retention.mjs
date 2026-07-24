import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyWorkspaceRetentionEvidence } from './workspace-retention-evidence.mjs';
import { verifyBackupRetentionEvidence } from './runtime-retention-evidence-policy.mjs';
import {
  DEFAULT_RETENTION_POLICIES,
  REACHABILITY_GOVERNED_RETENTION_CATEGORIES,
  listRuntimeRetentionEntries,
  safeRetentionNodeKey,
  verifyRuntimeRetentionDeletionEvidence,
} from './runtime-retention-scope-repository.mjs';

export {
  executeRuntimeRetentionPlan,
  reconcileRuntimeRetentionIntents,
} from './runtime-retention-intent-repository.mjs';
export { buildRuntimeRetentionReachabilityManifest } from './runtime-retention-scope-repository.mjs';

export function buildRuntimeRetentionPlan({
  runtimeRoot,
  activeNodeIds = [],
  workspaceRecords = [],
  receiptLedger = null,
  reachabilityManifest = null,
  nowMs = Date.now(),
  policies = {},
} = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const activeKeys = activeNodeIds.map(safeRetentionNodeKey).filter(Boolean);
  const workspaceByPath = new Map(workspaceRecords.map((record) => [
    path.resolve(record.workspacePath || record.workspace_path || ''),
    record,
  ]));
  const categories = [];
  const removals = [];
  const reachabilityGoverned = new Set(REACHABILITY_GOVERNED_RETENTION_CATEGORIES);

  for (const [category, defaults] of Object.entries(DEFAULT_RETENTION_POLICIES)) {
    const policy = { ...defaults, ...(policies[category] || {}) };
    const inspection = listRuntimeRetentionEntries(root, category);
    const { entries } = inspection;
    const protectedNames = new Set(entries
      .slice(0, Math.max(0, Number(policy.keepNewest || 0)))
      .map((entry) => entry.name));
    if (category === 'reports') {
      for (const entry of entries.filter((item) => item.name === 'details' || /-latest\.(?:json|md)$/.test(item.name))) {
        protectedNames.add(entry.name);
      }
    }
    if (category === 'backups') {
      for (const entry of entries.filter((item) => fs.lstatSync(item.path).isDirectory())) protectedNames.add(entry.name);
    }

    const active = (entry) => category === 'automation-workspaces' && activeKeys.some((key) => entry.name.includes(key));
    const workspaceEvidence = new Map(category === 'automation-workspaces' ? entries.map((entry) => {
      const record = workspaceByPath.get(path.resolve(entry.path));
      return [entry.path, record ? verifyWorkspaceRetentionEvidence(record, receiptLedger) : null];
    }) : []);
    const lineageProtected = (entry) => {
      if (category !== 'automation-workspaces') return false;
      const record = workspaceByPath.get(path.resolve(entry.path));
      return !record
        || String(record.retentionState || record.retention_state || 'protected') !== 'eligible'
        || workspaceEvidence.get(entry.path)?.verified !== true;
    };
    const evidence = new Map(category === 'backups'
      ? entries.map((entry) => [entry.path, verifyBackupRetentionEvidence(entry, receiptLedger)])
      : []);
    const recoverableBackups = category === 'backups'
      ? entries.filter((entry) => evidence.get(entry.path)?.verified === true)
      : [];
    const minimumRecoverableGenerations = category === 'backups'
      ? Math.max(0, Number(policy.minimumRecoverableGenerations || 0))
      : 0;
    if (category === 'backups') {
      for (const entry of recoverableBackups.slice(0, minimumRecoverableGenerations)) protectedNames.add(entry.name);
    }
    const evidenceProtected = (entry) => category === 'backups' && evidence.get(entry.path)?.verified !== true;
    const reachabilityEvidence = new Map(reachabilityGoverned.has(category)
      ? entries.map((entry) => [entry.path, verifyRuntimeRetentionDeletionEvidence({
        runtimeRoot: root,
        category,
        entryPath: entry.path,
        contentHash: entry.contentHash,
        reachabilityManifest,
      })])
      : []);
    const reachabilityProtected = (entry) => reachabilityGoverned.has(category)
      && reachabilityEvidence.get(entry.path)?.authorized !== true;
    const reachabilityBlockers = (entry) => reachabilityEvidence.get(entry.path)?.blockers || [];
    const explicitReachabilityBlockers = new Set([
      'retention_entry_active',
      'retention_entry_referenced',
      'retention_entry_release_dependent',
      'retention_entry_recovery_protected',
    ]);
    const unknownReachability = (entry) => {
      const blockers = reachabilityBlockers(entry);
      return blockers.some((blocker) => [
        'retention_reachability_manifest_invalid_or_missing',
        'retention_reachability_inventory_incomplete',
      ].includes(blocker))
        || (blockers.includes('retention_deletion_evidence_missing')
          && !blockers.some((blocker) => explicitReachabilityBlockers.has(blocker)));
    };
    let retainedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    const candidates = entries
      .filter((entry) => !entry.symbolicLink
        && !protectedNames.has(entry.name)
        && !active(entry)
        && !lineageProtected(entry)
        && !evidenceProtected(entry)
        && !reachabilityProtected(entry))
      .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs || left.name.localeCompare(right.name));
    const selected = new Set();
    let recoverableRemaining = recoverableBackups.length;

    const select = (entry, reason) => {
      selected.add(entry.path);
      retainedBytes -= entry.bytes;
      if (category === 'backups') recoverableRemaining -= 1;
      removals.push({
        category,
        ...entry,
        contentHash: entry.contentHash,
        categoryScope: entry.categoryScope,
        backupEvidence: evidence.get(entry.path) || null,
        workspaceRecord: category === 'automation-workspaces' ? workspaceByPath.get(path.resolve(entry.path)) || null : null,
        workspaceEvidence: workspaceEvidence.get(entry.path) || null,
        retentionDeletionEvidence: reachabilityEvidence.get(entry.path)?.evidence || null,
        reachabilityManifestHash: reachabilityEvidence.get(entry.path)?.reachabilityManifestHash || null,
        minimumRecoverableGenerations,
        reason,
      });
    };

    for (const entry of candidates) {
      if (nowMs - entry.modifiedAtMs <= Number(policy.maxAgeMs)) continue;
      if (category === 'backups' && recoverableRemaining <= minimumRecoverableGenerations) continue;
      select(entry, 'retention_age_exceeded');
    }
    for (const entry of candidates) {
      if (retainedBytes <= Number(policy.maxBytes) || selected.has(entry.path)) continue;
      if (category === 'backups' && recoverableRemaining <= minimumRecoverableGenerations) continue;
      select(entry, 'retention_quota_exceeded');
    }

    categories.push({
      category,
      scopeBlocker: inspection.blocker,
      categoryScope: inspection.scope,
      entryCount: entries.length,
      activeProtectedCount: entries.filter(active).length,
      lineageProtectedCount: entries.filter(lineageProtected).length,
      evidenceProtectedCount: entries.filter(evidenceProtected).length,
      reachabilityGoverned: reachabilityGoverned.has(category),
      reachabilityInventoryComplete: reachabilityGoverned.has(category)
        ? Boolean(reachabilityManifest?.categories?.find((entry) => entry.category === category)?.inventoryComplete)
          && entries.every((entry) => !reachabilityBlockers(entry).some((blocker) => [
            'retention_reachability_manifest_invalid_or_missing',
            'retention_reachability_inventory_incomplete',
          ].includes(blocker)))
        : null,
      reachabilityProtectedCount: entries.filter(reachabilityProtected).length,
      activeReferenceProtectedCount: reachabilityGoverned.has(category)
        ? entries.filter((entry) => reachabilityBlockers(entry).includes('retention_entry_active')).length
        : 0,
      referencedProtectedCount: reachabilityGoverned.has(category)
        ? entries.filter((entry) => reachabilityBlockers(entry).includes('retention_entry_referenced')).length
        : 0,
      releaseDependencyProtectedCount: reachabilityGoverned.has(category)
        ? entries.filter((entry) => reachabilityBlockers(entry).includes('retention_entry_release_dependent')).length
        : 0,
      recoveryProtectedCount: reachabilityGoverned.has(category)
        ? entries.filter((entry) => reachabilityBlockers(entry).includes('retention_entry_recovery_protected')).length
        : 0,
      unknownReferenceProtectedCount: reachabilityGoverned.has(category)
        ? entries.filter(unknownReachability).length
        : 0,
      recoverableGenerationCount: recoverableBackups.length,
      minimumRecoverableGenerationCount: minimumRecoverableGenerations,
      recoverableGenerationCountAfter: category === 'backups' ? recoverableRemaining : null,
      unregisteredProtectedCount: category === 'automation-workspaces'
        ? entries.filter((entry) => !workspaceByPath.has(path.resolve(entry.path))).length
        : 0,
      bytesBefore: entries.reduce((total, entry) => total + entry.bytes, 0),
      bytesAfter: retainedBytes,
      quotaPressureBytesBefore: Math.max(0, entries.reduce((total, entry) => total + entry.bytes, 0) - Number(policy.maxBytes)),
      quotaPressureBytesAfter: Math.max(0, retainedBytes - Number(policy.maxBytes)),
      removalCount: selected.size,
      policy,
    });
  }

  const payload = {
    version: 1,
    kind: 'RuntimeRetentionPlan',
    runtimeRoot: root,
    categories,
    removals,
    reachabilityManifestHash: reachabilityManifest?.runtimeRetentionReachabilityManifestHash || null,
    createdAt: new Date(nowMs).toISOString(),
  };
  return Object.freeze({ ...payload, runtimeRetentionPlanHash: hashRecord('RuntimeRetentionPlan', payload) });
}
