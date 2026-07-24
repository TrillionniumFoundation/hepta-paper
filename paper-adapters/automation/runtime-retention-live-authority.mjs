import {
  REACHABILITY_GOVERNED_RETENTION_CATEGORIES,
  verifyRuntimeRetentionDeletionEvidence,
} from './runtime-retention-scope-repository.mjs';

const GOVERNED = new Set(REACHABILITY_GOVERNED_RETENTION_CATEGORIES);

function governedEntries(intent, selectedEntries = null) {
  const selected = selectedEntries ? new Set(selectedEntries) : null;
  return intent.entries.filter((entry) => entry.authorized
    && GOVERNED.has(entry.category)
    && (!selected || selected.has(entry)));
}

export function assertIntentReachabilityManifest(intent, originalManifest) {
  const entries = governedEntries(intent || { entries: [] });
  for (const entry of entries) {
    const original = verifyRuntimeRetentionDeletionEvidence({
      runtimeRoot: intent.runtimeRoot,
      category: entry.category,
      entryPath: entry.path,
      contentHash: entry.contentHash,
      reachabilityManifest: originalManifest,
    });
    if (!original.authorized
      || original.evidence?.runtimeRetentionDeletionEvidenceHash
        !== entry.retentionDeletionEvidence?.runtimeRetentionDeletionEvidenceHash) {
      throw new Error(`runtime_retention_reachability_recovery_blocked:${entry.category}:${entry.path}`);
    }
  }
  return entries;
}

export function freshReachabilityManifestForIntent({
  intent,
  originalManifest,
  provider,
  activeNodeIds = [],
  entries: selectedEntries = null,
} = {}) {
  assertIntentReachabilityManifest(intent, originalManifest);
  const entries = governedEntries(intent || { entries: [] }, selectedEntries);
  if (!entries.length) return originalManifest || null;
  if (typeof provider?.createManifest !== 'function'
    || !Number.isFinite(Date.parse(originalManifest?.createdAt || ''))) {
    throw new Error('runtime_retention_live_reachability_authority_required');
  }
  let freshManifest;
  try {
    freshManifest = provider.createManifest({
      activeNodeIds,
      persist: false,
      createdAt: originalManifest.createdAt,
    });
  } catch (error) {
    throw new Error(`runtime_retention_live_reachability_authority_unavailable:${String(
      error?.message || error,
    )}`);
  }
  for (const entry of entries) {
    const current = verifyRuntimeRetentionDeletionEvidence({
      runtimeRoot: intent.runtimeRoot,
      category: entry.category,
      entryPath: entry.path,
      contentHash: entry.contentHash,
      reachabilityManifest: freshManifest,
    });
    if (!current.authorized
      || current.evidence?.runtimeRetentionDeletionEvidenceHash
        !== entry.retentionDeletionEvidence?.runtimeRetentionDeletionEvidenceHash) {
      throw new Error(`runtime_retention_live_reachability_authority_changed:${entry.category}:${entry.path}`);
    }
  }
  return freshManifest;
}
