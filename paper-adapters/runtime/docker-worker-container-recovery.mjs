import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { restrictedChildEnvironment } from '../automation/bounded-child-process.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const GPU_SELECTOR = /^GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LOCAL_DOCKER_HOST = 'unix:///var/run/docker.sock';
const WORKER_CONTAINER_PREFIX = 'hepta-os-worker-';
const WORKER_CONTAINER_KIND = 'os-sandbox-worker-v4';
const CLEANUP_TIMEOUT_MS = 5_000;
const CLEANUP_RETRY_DELAYS_MS = Object.freeze([0, 100, 250, 500, 1_000]);

function ownershipHash(kind, value) {
  return value ? hashRecord(kind, { value: String(value) }) : null;
}

function expectedOwnershipLabels(payload, ownershipHashValue) {
  return {
    'io.hepta.worker.kind': WORKER_CONTAINER_KIND,
    'io.hepta.worker.id': payload.containerName,
    'io.hepta.worker.invocation-id': payload.processInvocationId,
    'io.hepta.worker.ownership-hash': ownershipHashValue,
    'io.hepta.worker.experiment-run-hash':
      payload.experimentRunIdHash || 'unbound',
    'io.hepta.worker.experiment-attempt-hash':
      payload.experimentAttemptIdHash || 'unbound',
    ...(payload.gpuDeviceSelector ? {
      'io.hepta.worker.gpu-selector': payload.gpuDeviceSelector,
      'io.hepta.worker.gpu-lease-id': payload.gpuSelectorExecutionLeaseId,
      'io.hepta.worker.gpu-fencing-token':
        payload.gpuSelectorExecutionFencingToken,
    } : {}),
  };
}

function controlledDockerEnvironment(environment) {
  if (environment?.DOCKER_CONTEXT
    || (environment?.DOCKER_HOST && environment.DOCKER_HOST !== LOCAL_DOCKER_HOST)) {
    throw new Error('worker_container_recovery_remote_docker_endpoint_forbidden');
  }
  return restrictedChildEnvironment({
    source: environment,
    overrides: { DOCKER_HOST: LOCAL_DOCKER_HOST },
  });
}

function parseDockerInspection(result) {
  try {
    const documents = JSON.parse(String(result?.stdout || ''));
    return Array.isArray(documents) && documents.length === 1 ? documents[0] : null;
  } catch {
    return null;
  }
}

function confirmedAbsent(result) {
  return result?.status === 1
    && !result.error
    && !result.signal
    && /no such (?:object|container)/i.test(String(result.stderr || ''));
}

function receipt(payload) {
  return Object.freeze({
    ...payload,
    dockerWorkerContainerRecoveryReceiptHash: hashRecord(
      'DockerWorkerContainerRecoveryReceipt',
      payload,
    ),
  });
}

export function buildDockerWorkerContainerOwnership({
  processInvocationId,
  experimentRunId = null,
  experimentAttemptId = null,
  containerIdPath,
  gpuSelectorExecutionLease = null,
} = {}) {
  if (!SHA256.test(String(processInvocationId || '')) || !containerIdPath) {
    throw new Error('docker_worker_container_ownership_invalid');
  }
  const token = processInvocationId.slice('sha256:'.length, 'sha256:'.length + 32);
  const containerName = `${WORKER_CONTAINER_PREFIX}${token}`;
  const experimentRunIdHash = ownershipHash(
    'DockerWorkerExperimentRunOwnership',
    experimentRunId,
  );
  const experimentAttemptIdHash = ownershipHash(
    'DockerWorkerExperimentAttemptOwnership',
    experimentAttemptId,
  );
  const gpuLeaseBinding = gpuSelectorExecutionLease ? {
    gpuDeviceSelector: String(
      gpuSelectorExecutionLease.gpuDeviceSelector || '',
    ),
    gpuSelectorExecutionLeaseId: String(
      gpuSelectorExecutionLease.leaseId || '',
    ),
    gpuSelectorExecutionFencingToken: String(
      gpuSelectorExecutionLease.fencingToken || '',
    ),
  } : null;
  if (gpuLeaseBinding && (!GPU_SELECTOR.test(
    gpuLeaseBinding.gpuDeviceSelector,
  ) || !SHA256.test(gpuLeaseBinding.gpuSelectorExecutionLeaseId)
    || !SHA256.test(gpuLeaseBinding.gpuSelectorExecutionFencingToken))) {
    throw new Error('docker_worker_container_ownership_invalid');
  }
  const ownershipPayload = Object.freeze({
    version: 1,
    kind: 'DockerWorkerContainerOwnership',
    containerName,
    processInvocationId,
    experimentRunIdHash,
    experimentAttemptIdHash,
    ...(gpuLeaseBinding || {}),
  });
  const dockerWorkerContainerOwnershipHash = hashRecord(
    'DockerWorkerContainerOwnership',
    ownershipPayload,
  );
  const labels = Object.freeze(expectedOwnershipLabels(
    ownershipPayload,
    dockerWorkerContainerOwnershipHash,
  ));
  return Object.freeze({
    ...ownershipPayload,
    dockerWorkerContainerOwnershipHash,
    containerIdPath,
    labels,
  });
}

export function verifyDockerWorkerContainerOwnership(value) {
  if (!value || value.version !== 1
    || value.kind !== 'DockerWorkerContainerOwnership'
    || !SHA256.test(String(value.processInvocationId || ''))
    || value.containerName !== `${WORKER_CONTAINER_PREFIX}${String(
      value.processInvocationId,
    ).slice('sha256:'.length, 'sha256:'.length + 32)}`
    || (value.experimentRunIdHash !== null
      && !SHA256.test(String(value.experimentRunIdHash || '')))
    || (value.experimentAttemptIdHash !== null
      && !SHA256.test(String(value.experimentAttemptIdHash || '')))
    || !SHA256.test(String(value.dockerWorkerContainerOwnershipHash || ''))
    || !path.isAbsolute(String(value.containerIdPath || ''))
    || !value.labels || typeof value.labels !== 'object') return false;
  const gpuFields = [
    value.gpuDeviceSelector,
    value.gpuSelectorExecutionLeaseId,
    value.gpuSelectorExecutionFencingToken,
  ];
  const gpuBound = gpuFields.every((item) => item !== undefined);
  if (gpuFields.some((item) => item !== undefined) !== gpuBound
    || (gpuBound && (!GPU_SELECTOR.test(String(value.gpuDeviceSelector || ''))
      || !SHA256.test(String(value.gpuSelectorExecutionLeaseId || ''))
      || !SHA256.test(String(value.gpuSelectorExecutionFencingToken || ''))))) {
    return false;
  }
  const payload = {
    version: 1,
    kind: 'DockerWorkerContainerOwnership',
    containerName: value.containerName,
    processInvocationId: value.processInvocationId,
    experimentRunIdHash: value.experimentRunIdHash,
    experimentAttemptIdHash: value.experimentAttemptIdHash,
    ...(gpuBound ? {
      gpuDeviceSelector: value.gpuDeviceSelector,
      gpuSelectorExecutionLeaseId: value.gpuSelectorExecutionLeaseId,
      gpuSelectorExecutionFencingToken:
        value.gpuSelectorExecutionFencingToken,
    } : {}),
  };
  const expectedHash = hashRecord('DockerWorkerContainerOwnership', payload);
  const expectedLabels = expectedOwnershipLabels(payload, expectedHash);
  const expectedKeys = [
    ...Object.keys(payload),
    'dockerWorkerContainerOwnershipHash',
    'containerIdPath',
    'labels',
  ].sort();
  return expectedHash === value.dockerWorkerContainerOwnershipHash
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expectedKeys)
    && JSON.stringify(Object.entries(value.labels).sort())
      === JSON.stringify(Object.entries(expectedLabels).sort());
}

export function buildDockerWorkerContainerOwnershipForEnvironment({
  executionBackend,
  processInvocationId,
  permittedEnvironment,
  sandboxRoot,
  gpuSelectorExecutionLease = null,
} = {}) {
  if (executionBackend !== 'docker') return null;
  const environment = Object.fromEntries(permittedEnvironment || []);
  return buildDockerWorkerContainerOwnership({
    processInvocationId,
    experimentRunId: environment.HEPTA_EXPERIMENT_RUN_ID || null,
    experimentAttemptId: environment.HEPTA_EXPERIMENT_ATTEMPT_ID || null,
    containerIdPath: path.join(sandboxRoot, 'docker-container.cid'),
    gpuSelectorExecutionLease,
  });
}

export function dockerWorkerContainerOwnershipArguments(ownership) {
  if (!ownership?.containerName || !ownership?.containerIdPath
    || !SHA256.test(String(ownership.dockerWorkerContainerOwnershipHash || ''))) {
    throw new Error('docker_worker_container_ownership_invalid');
  }
  return Object.freeze([
    '--name', ownership.containerName,
    '--cidfile', ownership.containerIdPath,
    ...Object.entries(ownership.labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, value]) => ['--label', `${key}=${value}`]),
  ]);
}

function inspectOwnedContainer(document, ownership) {
  const containerId = String(document?.Id || '');
  const containerName = String(document?.Name || '').replace(/^\//, '');
  const labels = document?.Config?.Labels || {};
  const labelsMatch = Object.entries(ownership.labels)
    .every(([key, value]) => labels[key] === value);
  return Object.freeze({
    owned: CONTAINER_ID.test(containerId)
      && containerName === ownership.containerName
      && labelsMatch,
    containerId: CONTAINER_ID.test(containerId) ? containerId : null,
    containerName,
  });
}

export function recoverAbandonedDockerWorkerContainer({
  docker = 'docker',
  ownership,
  trigger,
  spawnSyncImpl = spawnSync,
  environment = process.env,
  retryDelaysMs = CLEANUP_RETRY_DELAYS_MS,
} = {}) {
  const basePayload = {
    version: 1,
    kind: 'DockerWorkerContainerRecoveryReceipt',
    trigger: String(trigger || 'launcher_abnormal'),
    containerName: ownership?.containerName || null,
    processInvocationId: ownership?.processInvocationId || null,
    dockerWorkerContainerOwnershipHash:
      ownership?.dockerWorkerContainerOwnershipHash || null,
  };
  if (!ownership?.containerName || !ownership?.containerIdPath
    || !SHA256.test(String(ownership?.dockerWorkerContainerOwnershipHash || ''))) {
    return receipt({
      ...basePayload,
      status: 'docker_worker_container_recovery_blocked',
      containerId: null,
      inspectionAttemptCount: 0,
      removalAttemptCount: 0,
      removalConfirmed: false,
      externalActionPerformed: false,
      blockers: Object.freeze(['worker_container_recovery_ownership_invalid']),
    });
  }
  let childEnvironment;
  try {
    childEnvironment = controlledDockerEnvironment(environment);
  } catch (error) {
    return receipt({
      ...basePayload,
      status: 'docker_worker_container_recovery_blocked',
      containerId: null,
      inspectionAttemptCount: 0,
      removalAttemptCount: 0,
      removalConfirmed: false,
      externalActionPerformed: false,
      blockers: Object.freeze([String(error?.message || error)]),
    });
  }
  const options = {
    encoding: 'utf8',
    timeout: CLEANUP_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    env: { ...childEnvironment },
  };
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  let containerId = null;
  let inspectionAttemptCount = 0;
  let removalAttemptCount = 0;
  let confirmedAbsentCount = 0;
  let uncertainInspectionObserved = false;
  let externalActionPerformed = false;
  for (const delayMs of retryDelaysMs) {
    if (Number(delayMs) > 0) Atomics.wait(waitBuffer, 0, 0, Number(delayMs));
    let reference = ownership.containerName;
    try {
      const candidate = fs.readFileSync(ownership.containerIdPath, 'utf8').trim();
      if (CONTAINER_ID.test(candidate)) {
        containerId = candidate;
        reference = candidate;
      }
    } catch {
      // Docker may still be publishing the cidfile after its client was killed.
    }
    const inspection = spawnSyncImpl(
      docker,
      ['container', 'inspect', reference],
      options,
    );
    inspectionAttemptCount += 1;
    if (inspection.status !== 0) {
      if (confirmedAbsent(inspection)) confirmedAbsentCount += 1;
      else uncertainInspectionObserved = true;
      continue;
    }
    const identity = inspectOwnedContainer(parseDockerInspection(inspection), ownership);
    if (!identity.owned) {
      return receipt({
        ...basePayload,
        status: 'docker_worker_container_recovery_blocked',
        containerId: identity.containerId || containerId,
        inspectionAttemptCount,
        removalAttemptCount,
        removalConfirmed: false,
        externalActionPerformed,
        blockers: Object.freeze(['worker_container_recovery_ownership_mismatch']),
      });
    }
    containerId = identity.containerId;
    const removal = spawnSyncImpl(
      docker,
      ['rm', '--force', identity.containerId],
      options,
    );
    removalAttemptCount += 1;
    if (removal.status !== 0) {
      uncertainInspectionObserved = true;
      continue;
    }
    externalActionPerformed = true;
    const absence = spawnSyncImpl(
      docker,
      ['container', 'inspect', identity.containerId],
      options,
    );
    inspectionAttemptCount += 1;
    if (confirmedAbsent(absence)) {
      return receipt({
        ...basePayload,
        status: 'docker_worker_container_recovery_removed',
        containerId,
        inspectionAttemptCount,
        removalAttemptCount,
        removalConfirmed: true,
        externalActionPerformed: true,
        blockers: Object.freeze([]),
      });
    }
    uncertainInspectionObserved = true;
  }
  if (!uncertainInspectionObserved
    && confirmedAbsentCount === retryDelaysMs.length) {
    return receipt({
      ...basePayload,
      status: 'docker_worker_container_recovery_absent',
      containerId,
      inspectionAttemptCount,
      removalAttemptCount,
      removalConfirmed: true,
      externalActionPerformed: false,
      blockers: Object.freeze([]),
    });
  }
  return receipt({
    ...basePayload,
    status: 'docker_worker_container_recovery_blocked',
    containerId,
    inspectionAttemptCount,
    removalAttemptCount,
    removalConfirmed: false,
    externalActionPerformed,
    blockers: Object.freeze(['worker_container_recovery_unresolved']),
  });
}

export function recoverDockerWorkerContainerAfterLauncher({
  result,
  executionBackend,
  docker,
  ownership,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const abnormalLauncher = executionBackend === 'docker'
    && (Boolean(result?.error) || result?.timedOut === true
      || result?.aborted === true
      || (result?.status === null && Boolean(result?.signal)));
  if (!abnormalLauncher) return result;
  const trigger = result?.timedOut === true
    ? 'launcher_timeout'
    : result?.aborted === true
      ? 'launcher_aborted'
      : result?.error
        ? `launcher_error:${result.error.code || result.error.name || 'unknown'}`
        : `launcher_signal:${result.signal || 'unknown'}`;
  return {
    ...result,
    dockerWorkerContainerRecoveryReceipt:
      recoverAbandonedDockerWorkerContainer({
        docker,
        ownership,
        trigger,
        spawnSyncImpl,
        environment,
      }),
  };
}

export function verifyDockerWorkerContainerRecoveryReceipt(value) {
  if (!value || value.version !== 1
    || value.kind !== 'DockerWorkerContainerRecoveryReceipt'
    || !SHA256.test(String(value.dockerWorkerContainerRecoveryReceiptHash || ''))
    || !SHA256.test(String(value.dockerWorkerContainerOwnershipHash || ''))
    || !SHA256.test(String(value.processInvocationId || ''))
    || !String(value.containerName || '').startsWith(WORKER_CONTAINER_PREFIX)
    || !Array.isArray(value.blockers)
    || !Number.isSafeInteger(value.inspectionAttemptCount)
    || !Number.isSafeInteger(value.removalAttemptCount)) return false;
  const {
    dockerWorkerContainerRecoveryReceiptHash,
    ...payload
  } = value;
  if (hashRecord('DockerWorkerContainerRecoveryReceipt', payload)
    !== dockerWorkerContainerRecoveryReceiptHash) return false;
  if (value.status === 'docker_worker_container_recovery_removed') {
    return CONTAINER_ID.test(String(value.containerId || ''))
      && value.removalAttemptCount > 0
      && value.removalConfirmed === true
      && value.externalActionPerformed === true
      && value.blockers.length === 0;
  }
  if (value.status === 'docker_worker_container_recovery_absent') {
    return value.removalAttemptCount === 0
      && value.removalConfirmed === true
      && value.externalActionPerformed === false
      && value.blockers.length === 0;
  }
  return value.status === 'docker_worker_container_recovery_blocked'
    && value.removalConfirmed === false
    && value.blockers.length > 0;
}
