import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';

export function buildExperimentRegistry({ paperTask, artifacts = [] } = {}) {
  const experiments = artifacts.filter((artifact) => /experiment|result|benchmark|dataset/i.test(`${artifact.path || ''} ${artifact.role || ''}`)).map((artifact, index) => ({
    experimentId: `experiment-${index + 1}`,
    artifactPath: artifact.path || null,
    artifactHash: artifact.hash || null,
    reproducibilityStatus: artifact.hash ? 'artifact_hash_bound' : 'artifact_hash_missing',
  }));
  const record = { version: 1, kind: 'ExperimentRegistry', paperId: paperTask?.paperId || null, experiments };
  return { ...record, experimentRegistryHash: hashPaperRecord('ExperimentRegistry', record) };
}

