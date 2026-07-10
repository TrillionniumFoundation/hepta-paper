import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function buildExperimentRegistry({ paperTask, artifacts = [] } = {}) {
  const experiments = artifacts.filter((artifact) => /experiment|result|benchmark|dataset/i.test(`${artifact.path || ''} ${artifact.role || ''} ${artifact.kind || ''}`)).map((artifact, index) => {
    const record = {
      experimentId: String(artifact.experimentId || artifact.id || `experiment-${index + 1}`),
      datasetHash: artifact.datasetHash || null,
      metric: artifact.metric || null,
      seed: artifact.seed ?? null,
      codeHash: artifact.codeHash || null,
      resultHash: artifact.resultHash || artifact.hash || null,
      resultPath: artifact.resultPath || artifact.path || null,
    };
    const missing = Object.entries(record)
      .filter(([key, value]) => key !== 'experimentId' && (value === null || value === ''))
      .map(([key]) => key);
    return { ...record, status: missing.length ? 'experiment_incomplete' : 'experiment_reproducible', missing };
  });
  const incompleteExperimentIds = experiments.filter((experiment) => experiment.status !== 'experiment_reproducible').map((experiment) => experiment.experimentId);
  const record = { version: 2, kind: 'ExperimentRegistry', paperId: paperTask?.paperId || null, status: incompleteExperimentIds.length ? 'experiment_registry_blocked' : 'experiment_registry_ready', experiments, incompleteExperimentIds };
  return { ...record, experimentRegistryHash: hashRecord('ExperimentRegistry', record) };
}
