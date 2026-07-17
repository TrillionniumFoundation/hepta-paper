import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyWorkspaceRetentionEvidence } from './workspace-retention-evidence.mjs';
import { verifyBackupRetentionEvidence } from './runtime-retention-evidence-policy.mjs';
import {
  DEFAULT_RETENTION_POLICIES,
  listRuntimeRetentionEntries,
  safeRetentionNodeKey,
} from './runtime-retention-scope-repository.mjs';

export {
  executeRuntimeRetentionPlan,
  reconcileRuntimeRetentionIntents,
} from './runtime-retention-intent-repository.mjs';

export function buildRuntimeRetentionPlan({
  runtimeRoot,
  activeNodeIds = [],
  workspaceRecords = [],
  receiptLedger = null,
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
    let retainedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    const candidates = entries
      .filter((entry) => !entry.symbolicLink
        && !protectedNames.has(entry.name)
        && !active(entry)
        && !lineageProtected(entry)
        && !evidenceProtected(entry))
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
      recoverableGenerationCount: recoverableBackups.length,
      minimumRecoverableGenerationCount: minimumRecoverableGenerations,
      recoverableGenerationCountAfter: category === 'backups' ? recoverableRemaining : null,
      unregisteredProtectedCount: category === 'automation-workspaces'
        ? entries.filter((entry) => !workspaceByPath.has(path.resolve(entry.path))).length
        : 0,
      bytesBefore: entries.reduce((total, entry) => total + entry.bytes, 0),
      bytesAfter: retainedBytes,
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
    createdAt: new Date(nowMs).toISOString(),
  };
  return Object.freeze({ ...payload, runtimeRetentionPlanHash: hashRecord('RuntimeRetentionPlan', payload) });
}
