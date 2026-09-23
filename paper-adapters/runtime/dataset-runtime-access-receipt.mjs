import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { buildDatasetAuthorizationSet } from '../../paper-domain/automation/experiment-run-contract.mjs';

export const DATASET_ACCESS_SUPERVISOR_TRACER = '/usr/bin/strace';
export const buildRuntimeDatasetAuthorizationSet = buildDatasetAuthorizationSet;
const MAXIMUM_SUPERVISOR_TRACE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_SUPERVISOR_IDENTITY_BYTES = 4096;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const POSITIVE_READ_OBSERVATION_ASSURANCE = 'positive-return-byte-observation-not-computational-use-proof-v1';

function observePositiveDatasetReads(trace, target) {
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*(?:(?:\\[pid\\s+[0-9]+\\]|[0-9]+)\\s+)?read\\(\\s*[0-9]+<(${escapedTarget}(?:/[^>]*)?)>\\s*,[^\\n]*,\\s*([0-9]+)\\)\\s*=\\s*(-?[0-9]+)(?=\\s|$)`, 'gm');
  const events = [];
  for (const match of String(trace || '').matchAll(pattern)) {
    const requestedBytes = Number(match[2]);
    const returnedBytes = Number(match[3]);
    if (!Number.isSafeInteger(requestedBytes) || !Number.isSafeInteger(returnedBytes)
      || requestedBytes < 1 || returnedBytes < 1 || returnedBytes > requestedBytes) continue;
    events.push(Object.freeze({
      targetPathHash: hashBytes(match[1]),
      requestedBytes,
      returnedBytes,
    }));
  }
  const positiveReadBytesObserved = events.reduce((sum, event) => sum + event.returnedBytes, 0);
  const valid = events.length > 0 && Number.isSafeInteger(positiveReadBytesObserved) && positiveReadBytesObserved > 0;
  return Object.freeze({
    readObserved: valid,
    positiveReadObservationEventCount: valid ? events.length : 0,
    positiveReadBytesObserved: valid ? positiveReadBytesObserved : 0,
    positiveReadObservationHash: valid ? hashRecord('DatasetPositiveReadObservationEvidence', events) : null,
  });
}

function readSupervisorFile({ candidate, supervisorRoot, maximumBytes, unavailableBlocker }) {
  if (!candidate || !supervisorRoot || !isPathWithin(supervisorRoot, candidate)) {
    return { content: '', sha256: null, bytes: 0, blockers: ['worker_dataset_access_trace_not_supervisor_scoped'] };
  }
  let descriptor = null;
  try {
    const root = fs.lstatSync(supervisorRoot);
    const identity = fs.lstatSync(candidate);
    if (!root.isDirectory() || root.isSymbolicLink() || !identity.isFile()
      || identity.isSymbolicLink() || identity.nlink !== 1
      || (identity.mode & 0o777) !== 0o600
      || !isPathWithin(fs.realpathSync(supervisorRoot), fs.realpathSync(candidate))) {
      return { content: '', sha256: null, bytes: 0, blockers: ['worker_dataset_access_trace_identity_invalid'] };
    }
    if (identity.size > maximumBytes) {
      return { content: '', sha256: null, bytes: identity.size, blockers: ['worker_dataset_access_supervisor_trace_too_large'] };
    }
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== identity.dev || opened.ino !== identity.ino) {
      return { content: '', sha256: null, bytes: 0, blockers: ['worker_dataset_access_trace_replaced'] };
    }
    if (opened.size > maximumBytes) {
      return { content: '', sha256: null, bytes: opened.size, blockers: ['worker_dataset_access_supervisor_trace_too_large'] };
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    return { content, sha256: hashBytes(Buffer.from(content)), bytes: Buffer.byteLength(content), ownerUid: opened.uid, ownerGid: opened.gid, blockers: [] };
  } catch {
    return { content: '', sha256: null, bytes: 0, blockers: [unavailableBlocker] };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function readSupervisorTrace({ tracePath, supervisorRoot }) {
  const result = readSupervisorFile({
    candidate: tracePath,
    supervisorRoot,
    maximumBytes: MAXIMUM_SUPERVISOR_TRACE_BYTES,
    unavailableBlocker: 'worker_dataset_access_supervisor_trace_unavailable',
  });
  return { trace: result.content, traceSha256: result.sha256, traceBytes: result.bytes, ownerUid: result.ownerUid, ownerGid: result.ownerGid, blockers: result.blockers };
}

function readContainerSupervisorIdentity({ identityPath, supervisorRoot }) {
  const result = readSupervisorFile({
    candidate: identityPath,
    supervisorRoot,
    maximumBytes: MAXIMUM_SUPERVISOR_IDENTITY_BYTES,
    unavailableBlocker: 'worker_dataset_access_supervisor_identity_unavailable',
  });
  if (result.blockers.length) return { identity: null, identitySha256: result.sha256, blockers: result.blockers };
  const expectedKeys = ['version', 'protocol', 'supervisor_sha256', 'tracer_sha256', 'setpriv_sha256', 'trace_sha256', 'trace_bytes', 'trace_owner_uid', 'trace_owner_gid', 'workload_uid', 'workload_gid', 'workload_exit_code'];
  const entries = String(result.content).split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : null;
  });
  if (entries.some((entry) => !entry) || entries.length !== expectedKeys.length
    || entries.some((entry, index) => entry[0] !== expectedKeys[index])) {
    return { identity: null, identitySha256: result.sha256, blockers: ['worker_dataset_access_supervisor_identity_invalid'] };
  }
  const values = Object.fromEntries(entries);
  const numericKeys = ['version', 'trace_bytes', 'trace_owner_uid', 'trace_owner_gid', 'workload_uid', 'workload_gid', 'workload_exit_code'];
  if (numericKeys.some((key) => !/^(?:0|[1-9][0-9]*)$/.test(values[key]))
    || ['supervisor_sha256', 'tracer_sha256', 'setpriv_sha256', 'trace_sha256'].some((key) => !SHA256.test(values[key]))) {
    return { identity: null, identitySha256: result.sha256, blockers: ['worker_dataset_access_supervisor_identity_invalid'] };
  }
  return {
    identity: Object.freeze({
      version: Number(values.version),
      protocol: values.protocol,
      supervisorSha256: values.supervisor_sha256.toLowerCase(),
      tracerSha256: values.tracer_sha256.toLowerCase(),
      setprivSha256: values.setpriv_sha256.toLowerCase(),
      traceSha256: values.trace_sha256.toLowerCase(),
      traceBytes: Number(values.trace_bytes),
      traceOwnerUid: Number(values.trace_owner_uid),
      traceOwnerGid: Number(values.trace_owner_gid),
      workloadUid: Number(values.workload_uid),
      workloadGid: Number(values.workload_gid),
      workloadExitCode: Number(values.workload_exit_code),
    }),
    identitySha256: result.sha256,
    ownerUid: result.ownerUid,
    ownerGid: result.ownerGid,
    blockers: [],
  };
}

/* Kept as a narrow compatibility path for the bubblewrap host supervisor. */
function readLegacySupervisorTrace({ tracePath, supervisorRoot }) {
  if (!tracePath || !supervisorRoot || !isPathWithin(supervisorRoot, tracePath)) {
    return { trace: '', traceSha256: null, blockers: ['worker_dataset_access_trace_not_supervisor_scoped'] };
  }
  let descriptor = null;
  try {
    const root = fs.lstatSync(supervisorRoot);
    const traceIdentity = fs.lstatSync(tracePath);
    if (!root.isDirectory() || root.isSymbolicLink() || !traceIdentity.isFile()
      || traceIdentity.isSymbolicLink() || traceIdentity.nlink !== 1
      || !isPathWithin(fs.realpathSync(supervisorRoot), fs.realpathSync(tracePath))) {
      return { trace: '', traceSha256: null, blockers: ['worker_dataset_access_trace_identity_invalid'] };
    }
    if (traceIdentity.size > MAXIMUM_SUPERVISOR_TRACE_BYTES) {
      return { trace: '', traceSha256: null, blockers: ['worker_dataset_access_supervisor_trace_too_large'] };
    }
    descriptor = fs.openSync(tracePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== traceIdentity.dev || opened.ino !== traceIdentity.ino) {
      return { trace: '', traceSha256: null, blockers: ['worker_dataset_access_trace_replaced'] };
    }
    if (opened.size > MAXIMUM_SUPERVISOR_TRACE_BYTES) {
      return { trace: '', traceSha256: null, blockers: ['worker_dataset_access_supervisor_trace_too_large'] };
    }
    const trace = fs.readFileSync(descriptor, 'utf8');
    return { trace, traceSha256: hashBytes(Buffer.from(trace)), blockers: [] };
  } catch {
    return { trace: '', traceSha256: null, blockers: ['worker_dataset_access_supervisor_trace_unavailable'] };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function buildDatasetRuntimeAccessReceipt({
  tracePath = null,
  supervisorRoot = null,
  executionBackend = null,
  datasets = [],
  required = false,
  supervisorIdentityPath = null,
  expectedSupervisor = null,
  runtimeIdentityHash = null,
  environmentBindingHash = null,
  containerImageDigest = null,
  traceOwnerUid = null,
  traceOwnerGid = null,
  workloadExitCode = null,
} = {}) {
  const containerSupervised = required && executionBackend === 'docker';
  const traceEvidence = required
    ? (containerSupervised
      ? readSupervisorTrace({ tracePath: path.resolve(tracePath || '.'), supervisorRoot: path.resolve(supervisorRoot || '.') })
      : readLegacySupervisorTrace({ tracePath: path.resolve(tracePath || '.'), supervisorRoot: path.resolve(supervisorRoot || '.') }))
    : { trace: '', traceSha256: null, blockers: [] };
  const supervisorEvidence = containerSupervised
    ? readContainerSupervisorIdentity({ identityPath: path.resolve(supervisorIdentityPath || '.'), supervisorRoot: path.resolve(supervisorRoot || '.') })
    : { identity: null, identitySha256: null, blockers: [] };
  const trace = traceEvidence.trace;
  const accesses = datasets.map((dataset) => {
    const readObservation = observePositiveDatasetReads(trace, dataset.target);
    return {
      name: dataset.name,
      target: dataset.target,
      manifestHash: dataset.manifestHash,
      operatorAuthorizationHash: dataset.operatorAuthorizationHash || null,
      workerExposureManifestHash: dataset.splitManifestHash || null,
      hostOnlyHarnessMounted: false,
      forbiddenReadObserved: false,
      ...readObservation,
    };
  });
  const containerIdentity = supervisorEvidence.identity;
  const supervisorIdentityHash = containerIdentity ? hashRecord('ContainerDatasetAccessSupervisorIdentity', {
    protocol: containerIdentity.protocol,
    path: expectedSupervisor?.path || null,
    supervisorSha256: containerIdentity.supervisorSha256,
    tracerSha256: containerIdentity.tracerSha256,
    setprivSha256: containerIdentity.setprivSha256,
    containerImageDigest,
    workloadUid: containerIdentity.workloadUid,
  }) : null;
  const containerIdentityValid = containerSupervised
    && containerIdentity?.version === 1
    && containerIdentity.protocol === expectedSupervisor?.protocol
    && containerIdentity.supervisorSha256 === expectedSupervisor?.sha256
    && containerIdentity.traceSha256 === traceEvidence.traceSha256
    && containerIdentity.traceBytes === traceEvidence.traceBytes
    && containerIdentity.traceOwnerUid === Number(traceOwnerUid)
    && containerIdentity.traceOwnerGid === Number(traceOwnerGid)
    && containerIdentity.workloadUid === expectedSupervisor?.workloadUid
    && containerIdentity.workloadGid === Number(traceOwnerGid)
    && containerIdentity.workloadExitCode === Number(workloadExitCode)
    && supervisorEvidence.ownerUid === Number(traceOwnerUid)
    && supervisorEvidence.ownerGid === Number(traceOwnerGid)
    && traceEvidence.ownerUid === Number(traceOwnerUid)
    && traceEvidence.ownerGid === Number(traceOwnerGid)
    && SHA256.test(String(runtimeIdentityHash || ''))
    && SHA256.test(String(environmentBindingHash || ''))
    && SHA256.test(String(containerImageDigest || ''));
  const blockers = required ? [
    ...(['bubblewrap', 'docker'].includes(executionBackend) ? [] : ['worker_dataset_access_trusted_supervisor_backend_unavailable']),
    ...(containerSupervised && !expectedSupervisor ? ['worker_dataset_access_trusted_supervisor_backend_unavailable'] : []),
    ...traceEvidence.blockers,
    ...supervisorEvidence.blockers,
    ...(containerSupervised && !containerIdentityValid ? ['worker_dataset_access_container_supervisor_evidence_invalid'] : []),
    ...accesses.filter((item) => !item.readObserved).map((item) => `worker_dataset_access_not_observed:${item.name}`),
  ] : [];
  const payload = {
    version: containerSupervised ? 3 : 2,
    kind: 'DatasetRuntimeAccessReceipt',
    status: blockers.length
      ? 'dataset_runtime_access_blocked'
      : required ? 'dataset_runtime_access_verified' : 'dataset_runtime_access_not_required',
    tracer: required ? (containerSupervised ? 'container-supervisor-strace-open-read-v1' : 'host-supervisor-strace-open-read-v2') : null,
    traceAuthority: required ? (containerSupervised ? 'trusted-container-supervisor-outside-unprivileged-workload-v1' : 'host-supervisor-outside-child-mount-namespace-v1') : null,
    readObservationAssurance: required ? POSITIVE_READ_OBSERVATION_ASSURANCE : null,
    executionBackend: required ? executionBackend : null,
    traceSha256: traceEvidence.traceSha256,
    traceBytes: containerSupervised ? traceEvidence.traceBytes : null,
    runtimeIdentityHash: containerSupervised ? runtimeIdentityHash : null,
    environmentBindingHash: containerSupervised ? environmentBindingHash : null,
    containerImageDigest: containerSupervised ? containerImageDigest : null,
    supervisor: containerSupervised && containerIdentity ? Object.freeze({
      protocol: containerIdentity.protocol,
      path: expectedSupervisor.path,
      supervisorSha256: containerIdentity.supervisorSha256,
      tracerSha256: containerIdentity.tracerSha256,
      setprivSha256: containerIdentity.setprivSha256,
      identityHash: supervisorIdentityHash,
      evidenceSha256: supervisorEvidence.identitySha256,
      traceOwnerUid: containerIdentity.traceOwnerUid,
      traceOwnerGid: containerIdentity.traceOwnerGid,
      workloadUid: containerIdentity.workloadUid,
      workloadGid: containerIdentity.workloadGid,
      workloadExitCode: containerIdentity.workloadExitCode,
    }) : null,
    datasets: accesses,
    blockers,
  };
  return Object.freeze({
    receipt: Object.freeze({
      ...payload,
      datasetRuntimeAccessReceiptHash: hashRecord('DatasetRuntimeAccessReceipt', payload),
    }),
    blockers: Object.freeze(blockers),
  });
}
