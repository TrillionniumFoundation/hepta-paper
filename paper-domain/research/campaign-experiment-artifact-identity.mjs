const EXECUTION_ROLES = new Set(['original', 'independent-replay']);
const RESULT_ARTIFACT_NAMES = new Set(['results.json', 'results.csv']);

function segment(value) {
  const normalized = String(value || '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.length > 240 || /[\0/\\]/.test(normalized)) {
    throw new Error('campaign_experiment_artifact_identity_invalid');
  }
  return normalized;
}

export function campaignExperimentArtifactIdentity({ paperId, campaignId, nodeId, attemptId } = {}) {
  return Object.freeze([paperId, campaignId, nodeId, attemptId].map(segment));
}

export function campaignExperimentArtifactRole({ paperId, campaignId, nodeId, attemptId, executionRole, artifactName = 'raw-events.ndjson' } = {}) {
  const identity = campaignExperimentArtifactIdentity({ paperId, campaignId, nodeId, attemptId });
  if (!EXECUTION_ROLES.has(executionRole)) throw new Error('campaign_experiment_artifact_execution_role_invalid');
  if (artifactName === 'raw-events.ndjson') return `campaign-experiment-raw-events:${identity.join(':')}:${executionRole}`;
  if (!RESULT_ARTIFACT_NAMES.has(artifactName)) throw new Error('campaign_experiment_result_artifact_name_invalid');
  return `campaign-experiment-result:${identity.join(':')}:${executionRole}:${artifactName}`;
}
