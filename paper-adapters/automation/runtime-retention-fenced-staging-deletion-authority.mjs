import path from 'node:path';

import {
  inspectFencedCampaignReleasePackageTransactionsSync,
} from './campaign-release-package-fenced-transaction-inventory.mjs';
import {
  withCampaignReleasePackageGenerationLockSync,
} from './campaign-release-package-transaction-repository.mjs';

const FENCED_KIND = 'package_fenced_staging_generation_verified';

function exactFencedTransaction({ runtimeRoot, authorization }) {
  const sourcePath = path.resolve(String(authorization?.sourcePath || ''));
  const packageRoot = path.join(path.resolve(runtimeRoot), 'packages');
  const sourceHashes = authorization?.retentionDeletionEvidence
    ?.sourceEvidenceHashes;
  if (path.dirname(sourcePath) !== packageRoot
    || !Array.isArray(sourceHashes)) {
    throw new Error('runtime_retention_fenced_staging_authority_invalid');
  }
  const matches = inspectFencedCampaignReleasePackageTransactionsSync({
    runtimeRoot,
  }).rows.filter((row) => (
    [row.preparedParent, row.abortedParent]
      .map((candidate) => path.resolve(candidate)).includes(sourcePath)
      && sourceHashes.includes(
        row.campaignReleasePackageBuildingTransactionHash,
      )
      && sourceHashes.includes(row.campaignReleasePackageBuildingFenceHash)
  ));
  if (matches.length !== 1) {
    throw new Error('runtime_retention_fenced_staging_authority_changed');
  }
  return matches[0];
}

export function withFencedStagingDeletionAuthority({
  authorization,
  operation,
} = {}) {
  if (typeof operation !== 'function') {
    throw new Error('runtime_retention_fenced_staging_operation_invalid');
  }
  if (authorization?.retentionDeletionEvidence?.evidenceKind !== FENCED_KIND) {
    return operation({ assertHeld: () => {} });
  }
  const sourcePath = path.resolve(String(authorization.sourcePath || ''));
  const runtimeRoot = path.dirname(path.dirname(sourcePath));
  const transaction = exactFencedTransaction({ runtimeRoot, authorization });
  return withCampaignReleasePackageGenerationLockSync({
    runtimeRoot,
    releaseRoot: transaction.releaseRoot,
  }, ({ assertHeld }) => {
    assertHeld();
    const current = exactFencedTransaction({ runtimeRoot, authorization });
    if (current.campaignReleasePackageBuildingTransactionHash
        !== transaction.campaignReleasePackageBuildingTransactionHash
      || current.campaignReleasePackageBuildingFenceHash
        !== transaction.campaignReleasePackageBuildingFenceHash) {
      throw new Error('runtime_retention_fenced_staging_authority_changed');
    }
    const result = operation({ assertHeld });
    if (result && typeof result.then === 'function') {
      throw new Error('runtime_retention_fenced_staging_operation_invalid');
    }
    assertHeld();
    return result;
  });
}
