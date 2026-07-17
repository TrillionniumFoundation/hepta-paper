import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const INSPECTION_KEYS = Object.freeze([
  'actions', 'automationReadinessSideEffectInspectionHash', 'blockers',
  'controlledChildEnvironment', 'credentialStatusActionCount',
  'dockerContainerActionCount', 'dockerDaemonActionCount', 'endpointLocality',
  'externalActionPerformed', 'externalActionScope', 'externalEndpointActionCount',
  'externalEndpointActionPerformed', 'failedProcessActionCount', 'kind',
  'localDaemonActionPerformed', 'localProcessActionPerformed', 'operationCounts',
  'processActionCount', 'providerCanaryActionCount',
  'releaseAttestorBackendProbeActionCount', 'releaseAttestorInspectionHash',
  'releaseAttestorProcessActionCount', 'releaseAttestorSignerChallengeActionCount',
  'status', 'successfulProcessActionCount', 'version',
].sort());
const ACTION_KEYS = Object.freeze([
  'endpointLocality', 'errorCode', 'executable', 'exitCode', 'operation', 'scope',
  'sequence', 'signal', 'succeeded',
].sort());
const ENDPOINTS = new Set([
  'local_process', 'local_unix_daemon', 'local_endpoint', 'remote_endpoint',
  'external_provider', 'external_release_backend',
]);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function localityValid(value) {
  const docker = value?.docker;
  const endpoint = (candidate) => candidate
    && typeof candidate === 'object' && !Array.isArray(candidate)
    && Object.keys(candidate).length === 3
    && typeof candidate.configured === 'boolean'
    && (candidate.local === null || typeof candidate.local === 'boolean')
    && (candidate.remote === null || typeof candidate.remote === 'boolean')
    && (candidate.configured
      ? candidate.local !== candidate.remote
      : candidate.local === null && candidate.remote === null);
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify(['docker', 'ollama', 'openclaw'])
    && docker && typeof docker === 'object'
    && JSON.stringify(Object.keys(docker).sort()) === JSON.stringify([
      'configuredHostPresent', 'contextConfigured', 'effectiveHostKind', 'local', 'remote',
    ])
    && typeof docker.configuredHostPresent === 'boolean'
    && typeof docker.contextConfigured === 'boolean'
    && docker.effectiveHostKind === 'local_unix_socket'
    && typeof docker.local === 'boolean' && docker.remote === !docker.local
    && endpoint(value.openclaw) && endpoint(value.ollama);
}

export function verifyAutomationReadinessSideEffectInspection(value) {
  if (!exactKeys(value, INSPECTION_KEYS) || value.version !== 1
    || value.kind !== 'AutomationReadinessSideEffectInspection'
    || !['automation_readiness_side_effect_inspection_recorded',
      'automation_readiness_side_effect_inspection_failed'].includes(value.status)
    || value.controlledChildEnvironment !== true
    || !localityValid(value.endpointLocality)
    || !Array.isArray(value.actions) || value.actions.length > 128
    || !Array.isArray(value.blockers) || value.blockers.length > 64
    || !value.blockers.every((item) => typeof item === 'string' && item.length <= 768)
    || !value.operationCounts || typeof value.operationCounts !== 'object'
    || Array.isArray(value.operationCounts)) return false;
  const actions = value.actions;
  if (actions.some((action, index) => !exactKeys(action, ACTION_KEYS)
    || action.sequence !== index + 1
    || typeof action.scope !== 'string' || action.scope.length > 160
    || typeof action.executable !== 'string' || action.executable.length > 512
    || typeof action.operation !== 'string' || action.operation.length > 160
    || !ENDPOINTS.has(action.endpointLocality)
    || typeof action.succeeded !== 'boolean'
    || (action.exitCode !== null && !Number.isInteger(action.exitCode))
    || (action.signal !== null && typeof action.signal !== 'string')
    || (action.errorCode !== null && typeof action.errorCode !== 'string'))) return false;
  const operations = [...new Set(actions.map((action) => action.operation))].sort();
  const expectedCounts = Object.fromEntries(operations.map((operation) => [
    operation,
    actions.filter((action) => action.operation === operation).length,
  ]));
  const externalEndpointActionCount = actions.filter((action) => [
    'external_provider', 'external_release_backend', 'remote_endpoint',
  ].includes(action.endpointLocality)).length;
  const dockerDaemonActionCount = actions.filter((action) =>
    action.operation.startsWith('docker_')).length;
  if (JSON.stringify(value.operationCounts) !== JSON.stringify(expectedCounts)
    || value.processActionCount !== actions.length
    || value.successfulProcessActionCount
      !== actions.filter((action) => action.succeeded).length
    || value.failedProcessActionCount !== actions.filter((action) => !action.succeeded).length
    || value.credentialStatusActionCount !== (expectedCounts.credential_status || 0)
    || value.dockerDaemonActionCount !== dockerDaemonActionCount
    || value.dockerContainerActionCount !== (expectedCounts.docker_container_probe || 0)
    || value.providerCanaryActionCount !== (expectedCounts.provider_model_canary || 0)
    || value.releaseAttestorProcessActionCount
      !== (expectedCounts.release_attestor_backend_process || 0)
    || ![value.releaseAttestorBackendProbeActionCount,
      value.releaseAttestorSignerChallengeActionCount].every((item) => item === 0 || item === 1)
    || (value.releaseAttestorInspectionHash !== null
      && !SHA256.test(String(value.releaseAttestorInspectionHash || '')))
    || value.localProcessActionPerformed
      !== actions.some((action) => action.endpointLocality === 'local_process')
    || value.localDaemonActionPerformed !== (dockerDaemonActionCount > 0)
    || value.externalEndpointActionCount !== externalEndpointActionCount
    || value.externalEndpointActionPerformed !== (externalEndpointActionCount > 0)
    || value.externalActionPerformed !== (actions.length > 0)
    || value.externalActionScope !== (actions.length ? operations.join(',') : 'none')
    || value.status !== (value.blockers.length
      ? 'automation_readiness_side_effect_inspection_failed'
      : 'automation_readiness_side_effect_inspection_recorded')
    || ![value.processActionCount, value.successfulProcessActionCount,
      value.failedProcessActionCount, value.credentialStatusActionCount,
      value.dockerDaemonActionCount, value.dockerContainerActionCount,
      value.providerCanaryActionCount, value.releaseAttestorProcessActionCount,
      value.externalEndpointActionCount].every(nonnegativeInteger)) return false;
  const {
    automationReadinessSideEffectInspectionHash: claimedHash,
    ...payload
  } = value;
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutomationReadinessSideEffectInspection', payload) === claimedHash;
}
