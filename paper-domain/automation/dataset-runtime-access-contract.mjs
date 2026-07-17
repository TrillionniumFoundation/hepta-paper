import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifySystemDatasetAccessSupervisorEvidence } from './dataset-access-supervisor-policy.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const POSITIVE_READ_OBSERVATION_ASSURANCE = 'positive-return-byte-observation-not-computational-use-proof-v1';

function validDatasetReadObservation(item) {
  if (item?.readObserved !== true) return item?.positiveReadObservationEventCount === 0
    && item?.positiveReadBytesObserved === 0 && item?.positiveReadObservationHash === null;
  return Number.isSafeInteger(item.positiveReadObservationEventCount) && item.positiveReadObservationEventCount > 0
    && Number.isSafeInteger(item.positiveReadBytesObserved)
    && item.positiveReadBytesObserved >= item.positiveReadObservationEventCount
    && SHA256.test(String(item.positiveReadObservationHash || ''));
}

export function verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt(datasetAccess, workerReceipt) {
  if (!datasetAccess || datasetAccess.status !== 'dataset_runtime_access_verified'
    || !SHA256.test(String(datasetAccess.traceSha256 || ''))) return false;
  if (datasetAccess.version === 2) {
    return workerReceipt?.backend !== 'docker'
      && [undefined, null, 'bubblewrap'].includes(datasetAccess.executionBackend)
      && datasetAccess.tracer === 'host-supervisor-strace-open-read-v2'
      && datasetAccess.traceAuthority === 'host-supervisor-outside-child-mount-namespace-v1'
      && datasetAccess.readObservationAssurance === POSITIVE_READ_OBSERVATION_ASSURANCE
      && (datasetAccess.datasets || []).every((item) => validDatasetReadObservation(item));
  }
  const supervisor = datasetAccess.supervisor;
  const supervisorEvidence = supervisor ? [
    'version=1', `protocol=${supervisor.protocol}`, `supervisor_sha256=${supervisor.supervisorSha256}`,
    `tracer_sha256=${supervisor.tracerSha256}`, `setpriv_sha256=${supervisor.setprivSha256}`,
    `trace_sha256=${datasetAccess.traceSha256}`, `trace_bytes=${datasetAccess.traceBytes}`,
    `trace_owner_uid=${supervisor.traceOwnerUid}`, `trace_owner_gid=${supervisor.traceOwnerGid}`,
    `workload_uid=${supervisor.workloadUid}`, `workload_gid=${supervisor.workloadGid}`,
    `workload_exit_code=${supervisor.workloadExitCode}`, '',
  ].join('\n') : '';
  return datasetAccess.version === 3
    && workerReceipt?.backend === 'docker'
    && datasetAccess.executionBackend === 'docker'
    && datasetAccess.tracer === 'container-supervisor-strace-open-read-v1'
    && datasetAccess.traceAuthority === 'trusted-container-supervisor-outside-unprivileged-workload-v1'
    && datasetAccess.readObservationAssurance === POSITIVE_READ_OBSERVATION_ASSURANCE
    && (datasetAccess.datasets || []).every((item) => validDatasetReadObservation(item))
    && Number.isSafeInteger(datasetAccess.traceBytes) && datasetAccess.traceBytes > 0
    && datasetAccess.runtimeIdentityHash === workerReceipt.runtimeIdentityHash
    && datasetAccess.environmentBindingHash === workerReceipt.environmentBindingHash
    && datasetAccess.containerImageDigest === workerReceipt.containerImageDigest
    && supervisor?.protocol === 'hepta-container-dataset-supervisor-v1'
    && String(supervisor.path || '').startsWith('/')
    && ['supervisorSha256', 'tracerSha256', 'setprivSha256', 'identityHash', 'evidenceSha256']
      .every((field) => SHA256.test(String(supervisor[field] || '')))
    && supervisor.evidenceSha256 === hashBytes(supervisorEvidence)
    && verifySystemDatasetAccessSupervisorEvidence({ containerImageDigest: datasetAccess.containerImageDigest, supervisor })
    && supervisor.identityHash === hashRecord('ContainerDatasetAccessSupervisorIdentity', {
      protocol: supervisor.protocol,
      path: supervisor.path,
      supervisorSha256: supervisor.supervisorSha256,
      tracerSha256: supervisor.tracerSha256,
      setprivSha256: supervisor.setprivSha256,
      containerImageDigest: datasetAccess.containerImageDigest,
      workloadUid: supervisor.workloadUid,
    })
    && workerReceipt.datasetAccessSupervisorIdentityHash === supervisor.identityHash
    && Number.isSafeInteger(supervisor.traceOwnerUid)
    && Number.isSafeInteger(supervisor.traceOwnerGid)
    && Number.isSafeInteger(supervisor.workloadUid) && supervisor.workloadUid > 0
    && supervisor.workloadUid !== supervisor.traceOwnerUid
    && supervisor.workloadGid === supervisor.traceOwnerGid
    && supervisor.workloadExitCode === workerReceipt.exitCode
    && workerReceipt.isolation?.datasetAccessSupervisorVerified === true;
}

export function verifyWorkerDatasetRuntimeAccessBinding(workerReceipt) {
  const datasetAccess = workerReceipt?.datasetAccessReceipt;
  const mounts = new Map((workerReceipt?.datasetMounts || []).map((item) => [item.name, item]));
  if (!datasetAccess) return mounts.size === 0;
  const { datasetRuntimeAccessReceiptHash, ...payload } = datasetAccess;
  if (!SHA256.test(String(datasetRuntimeAccessReceiptHash || ''))
    || hashRecord('DatasetRuntimeAccessReceipt', payload) !== datasetRuntimeAccessReceiptHash
    || (mounts.size > 0 && (datasetAccess.status !== 'dataset_runtime_access_verified'
      || !verifyDatasetRuntimeAccessReceiptAgainstWorkerReceipt(datasetAccess, workerReceipt)))
    || (mounts.size === 0 && datasetAccess.status === 'dataset_runtime_access_verified')) return false;
  return (datasetAccess.datasets || []).length === mounts.size
    && !(datasetAccess.datasets || []).some((item) => {
      const mount = mounts.get(item.name);
      return !mount || item.target !== `/datasets/${item.name}` || item.manifestHash !== mount.manifestHash
        || (item.operatorAuthorizationHash || null) !== (mount.operatorAuthorizationHash || null)
        || (item.workerExposureManifestHash || null) !== (mount.splitManifestHash || null)
        || item.hostOnlyHarnessMounted !== false || item.forbiddenReadObserved !== false
        || !validDatasetReadObservation(item);
    });
}
