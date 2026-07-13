import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluateExperimentAcceptance } from './experiment-acceptance-policy.mjs';
import { buildExperimentAcceptanceContract, experimentAcceptanceProfile } from './experiment-profiles.mjs';
import { buildExperimentEvidenceBinding } from './experiment-evidence-binding.mjs';

export function buildExperimentRegistry({ paperTask, artifacts = [], receiptLedger = null, artifactVerifier = null } = {}) {
  const experiments = artifacts.filter((artifact) => artifact && typeof artifact === 'object' && (
    artifact.kind === 'experiment' || artifact.experimentId || artifact.experiment_id || artifact.acceptanceContract
    || artifact.datasetHash || artifact.codeHash || artifact.resultHash
  )).map((artifact, index) => {
    const acceptanceProfileId = artifact.acceptanceProfileId || artifact.experimentProfile || artifact.allowlistedExperimentId || artifact.allowlisted_experiment_id || null;
    const registeredProfile = acceptanceProfileId ? experimentAcceptanceProfile(acceptanceProfileId) : null;
    const contract = registeredProfile
      ? buildExperimentAcceptanceContract({ profileId: acceptanceProfileId, overrides: artifact.acceptanceContract || {} })
      : artifact.acceptanceContract || {};
    const requiredOutputs = (contract.requiredOutputs?.length ? contract.requiredOutputs : artifact.requiredOutputs || []).map(String);
    const record = {
      experimentId: String(artifact.experimentId || artifact.experiment_id || artifact.id || `experiment-${index + 1}`),
      claimIds: (Array.isArray(artifact.claimIds) ? artifact.claimIds : Array.isArray(artifact.claim_ids) ? artifact.claim_ids : []).map(String),
      runId: String(artifact.runId || artifact.run_id || ''),
      datasetHash: artifact.datasetHash || null,
      metric: artifact.metric || null,
      metrics: artifact.metrics || artifact.metricValues || artifact.metricRows || null,
      seed: artifact.seed ?? null,
      datasetManifestHash: artifact.datasetManifestHash || null,
      datasetLicenseId: artifact.datasetLicenseId || null,
      datasetReadOnly: artifact.datasetReadOnly === true,
      datasetMounts: artifact.datasetMounts || [],
      networkPolicy: artifact.networkPolicy || null,
      secretsAllowed: artifact.secretsAllowed === true,
      externalActionsAllowed: artifact.externalActionsAllowed === true,
      providerCallsAllowed: artifact.providerCallsAllowed === true,
      sourceMutationAllowed: artifact.sourceMutationAllowed === true,
      sourceReadOnlyRequired: artifact.sourceReadOnlyRequired === true,
      ephemeralWorkRootRequired: artifact.ephemeralWorkRootRequired === true,
      separateOutputRootRequired: artifact.separateOutputRootRequired === true,
      metricPredicates: contract.metricPredicates || artifact.metricPredicates || [],
      codeHash: artifact.codeHash || null,
      resultHash: artifact.resultHash || artifact.hash || null,
      resultPath: artifact.resultPath || artifact.path || null,
      observedMetric: artifact.observedMetric ?? artifact.metricValue ?? null,
      resultClass: artifact.resultClass || null,
      availableOutputs: [],
      promotionRequested: artifact.promotionRequested === true,
      acceptanceProfileId,
    };
    record.evidenceBinding = buildExperimentEvidenceBinding({
      experiment: record,
      workerReceipt: artifact.workerReceipt,
      resultArtifact: artifact.resultArtifact,
      reproducibilityReceipt: artifact.reproducibilityReceipt,
      receiptLedger,
      requiredOutputs,
      artifactVerifier,
      expectedOutputRoles: Object.fromEntries(requiredOutputs.map((name) => [name, `experiment-output:${record.experimentId}:${record.runId}:${name}`])),
      expectedOutputPaths: Object.fromEntries(requiredOutputs.map((name) => [name, name])),
    });
    record.availableOutputs = record.evidenceBinding.outputArtifacts?.map((item) => item.name) || [];
    const missing = ['runId', 'datasetHash', 'seed', 'codeHash', 'resultHash', 'resultPath']
      .filter((key) => record[key] === null || record[key] === '');
    if (record.metric === null && record.metrics === null) missing.push('metric');
    if (record.acceptanceProfileId && !registeredProfile) missing.push('acceptanceProfile');
    if (record.evidenceBinding.status !== 'experiment_evidence_binding_verified') missing.push('evidenceBinding');
    const acceptancePolicy = evaluateExperimentAcceptance({ experiment: record, contract });
    return { ...record, status: missing.length ? 'experiment_incomplete' : acceptancePolicy.blockers.length ? 'experiment_acceptance_blocked' : 'experiment_reproducible', missing, acceptancePolicy };
  });
  const incompleteExperimentIds = experiments.filter((experiment) => experiment.status !== 'experiment_reproducible').map((experiment) => experiment.experimentId);
  const record = { version: 3, kind: 'ExperimentRegistry', paperId: paperTask?.paperId || null, status: incompleteExperimentIds.length ? 'experiment_registry_blocked' : 'experiment_registry_ready', experiments, incompleteExperimentIds };
  return { ...record, experimentRegistryHash: hashRecord('ExperimentRegistry', record) };
}
