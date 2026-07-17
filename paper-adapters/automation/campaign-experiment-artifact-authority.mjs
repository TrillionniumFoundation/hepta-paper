import path from 'node:path';
import { verifyArtifactWriteReceiptSource } from '../artifacts/artifact-write-receipt-verifier.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { ensureScopedDirectorySync } from '../runtime/scoped-file-materialization-repository.mjs';
import { campaignExperimentArtifactIdentity, campaignExperimentArtifactRole } from '../../paper-domain/research/campaign-experiment-artifact-identity.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
export function campaignExperimentRawArtifactRole({ paperId, campaignId, nodeId, attemptId, executionRole } = {}) {
  return campaignExperimentArtifactRole({ paperId, campaignId, nodeId, attemptId, executionRole });
}

export async function persistCampaignExperimentRawArtifact({
  artifactRepositoryFactory,
  runtimeRoot,
  outputDirectory,
  paperId,
  campaignId,
  nodeId,
  attemptId,
  executionRole,
  expectedHash,
  expectedBytes,
} = {}) {
  if (typeof artifactRepositoryFactory !== 'function') throw new Error('campaign_experiment_artifact_repository_factory_required');
  if (!runtimeRoot || !outputDirectory) throw new Error('campaign_experiment_raw_artifact_roots_required');
  if (!SHA256.test(String(expectedHash || '')) || !Number.isSafeInteger(Number(expectedBytes)) || Number(expectedBytes) < 1) {
    throw new Error('campaign_experiment_raw_artifact_descriptor_invalid');
  }
  const read = readScopedFileSync({
    scopeRoot: outputDirectory,
    candidate: path.join(outputDirectory, 'raw-events.ndjson'),
    maximumBytes: 16 * 1024 * 1024,
  });
  if (read.status !== 'scoped_file_read_verified') throw new Error(`campaign_experiment_raw_artifact_source_invalid:${(read.blockers || []).join(',')}`);
  if (hashBytes(read.content) !== expectedHash || Number(read.bytes) !== Number(expectedBytes)) {
    throw new Error('campaign_experiment_raw_artifact_execution_binding_invalid');
  }
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const [, canonicalCampaignId, canonicalNodeId, canonicalAttemptId] = campaignExperimentArtifactIdentity({
    paperId, campaignId, nodeId, attemptId,
  });
  const evidenceRoot = path.join(
    resolvedRuntimeRoot,
    'campaign-experiment-evidence',
    canonicalCampaignId,
    canonicalNodeId,
    canonicalAttemptId,
  );
  if (!isPathWithin(resolvedRuntimeRoot, evidenceRoot)) throw new Error('campaign_experiment_raw_artifact_runtime_scope_invalid');
  ensureScopedDirectorySync({
    scopeRoot: resolvedRuntimeRoot,
    relative: path.relative(resolvedRuntimeRoot, evidenceRoot).replace(/\\/g, '/'),
  });
  const target = path.join(evidenceRoot, `raw-events-${String(expectedHash).slice('sha256:'.length)}.ndjson`);
  const role = campaignExperimentRawArtifactRole({ paperId, campaignId, nodeId, attemptId, executionRole });
  const repository = artifactRepositoryFactory(evidenceRoot);
  const receipt = await repository.writeBytes(target, read.content, { role });
  const sourceVerification = verifyArtifactWriteReceiptSource({ receipt });
  if (sourceVerification.status !== 'artifact_write_receipt_source_verified'
    || receipt?.version !== 2 || receipt?.kind !== 'ArtifactWriteReceipt'
    || receipt?.role !== role || receipt?.hash !== expectedHash || Number(receipt?.bytes) !== Number(expectedBytes)
    || !receipt?.writeReceiptHash || !receipt?.ledgerReceiptId) {
    throw new Error(`campaign_experiment_raw_artifact_persistence_invalid:${(sourceVerification.blockers || []).join(',')}`);
  }
  return Object.freeze(receipt);
}
