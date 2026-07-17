import path from 'node:path';
import { isDatasetLicenseId } from '../../paper-domain/automation/empirical-contract.mjs';
import {
  SYSTEM_DATASET_ACCESS_SUPERVISOR,
  trustedSystemDatasetAccessRuntimeImageByDigest,
} from '../../paper-domain/automation/dataset-access-supervisor-policy.mjs';

const normalizedDigest = (value) => /^sha256:[0-9a-f]{64}$/.test(String(value || '').toLowerCase())
  ? String(value).toLowerCase() : null;

export function normalizeTrustedDatasetSupervisorImage(value) {
  const image = String(value?.image || '');
  const imageDigest = normalizedDigest(value?.imageDigest);
  const containerExecutable = String(value?.containerExecutable || '');
  const supervisor = value?.supervisor || null;
  const systemImage = trustedSystemDatasetAccessRuntimeImageByDigest(imageDigest);
  if (!image || !imageDigest || !containerExecutable || !supervisor
    || !systemImage || image !== systemImage.image || containerExecutable !== systemImage.containerExecutable
    || supervisor.version !== 1 || supervisor.protocol !== SYSTEM_DATASET_ACCESS_SUPERVISOR.protocol
    || supervisor.path !== SYSTEM_DATASET_ACCESS_SUPERVISOR.path
    || supervisor.sha256 !== SYSTEM_DATASET_ACCESS_SUPERVISOR.sha256
    || supervisor.workloadUid !== SYSTEM_DATASET_ACCESS_SUPERVISOR.workloadUid) return null;
  return Object.freeze({
    image, imageDigest, containerExecutable,
    supervisor: Object.freeze({ ...SYSTEM_DATASET_ACCESS_SUPERVISOR }),
  });
}

export function explicitContainerRuntimeIdentityPayload({
  requestedImage, digest, containerExecutable, runnerId, allowedImages, trustedDatasetSupervisors,
} = {}) {
  const trusted = trustedDatasetSupervisors.get(requestedImage) || null;
  const supervisorTrusted = Boolean(trusted && digest === trusted.imageDigest
    && String(containerExecutable || '') === trusted.containerExecutable);
  return {
    version: 1, kind: 'WorkerExecutionRuntimeIdentity', runtimeType: 'container', executionClass: 'explicit-container',
    runnerId, backend: 'docker', requestedImage, digest, containerExecutable: String(containerExecutable || ''),
    available: Boolean(digest),
    allowlisted: (allowedImages.has(requestedImage) || Boolean(digest && allowedImages.has(digest)))
      && (!trusted || digest === trusted.imageDigest),
    cacheable: Boolean(digest && containerExecutable && !path.isAbsolute(String(containerExecutable))),
    expectedImageDigest: trusted?.imageDigest || null,
    datasetAccessSupervisorTrusted: supervisorTrusted,
    datasetAccessSupervisor: supervisorTrusted ? trusted.supervisor : null,
  };
}

export function datasetRuntimePreflightBlockers({
  datasets, environment, authorizationSetHash, requireProof, executionBackend, executionClass,
  executionIdentity, containerImageDigest, hostTracerAvailable,
} = {}) {
  const blockers = [];
  if (datasets.some((mount) => !mount.allowedDatasetRoot || !mount.sourceType || mount.boundaryBlockers.length || !mount.readOnly)) blockers.push('worker_dataset_mount_invalid_or_not_read_only');
  if (new Set(datasets.map((mount) => mount.name)).size !== datasets.length) blockers.push('worker_dataset_mount_name_collision');
  if (datasets.some((mount) => !isDatasetLicenseId(mount.licenseId))) blockers.push('worker_dataset_license_invalid');
  if (datasets.some((mount) => String(mount.licenseId || '').startsWith('LicenseRef-') && !/^sha256:[0-9a-f]{64}$/i.test(String(mount.operatorAuthorizationHash || '')))) blockers.push('worker_dataset_operator_authorization_missing');
  if (datasets.some((mount) => mount.splitManifestHash && !/^sha256:[0-9a-f]{64}$/i.test(String(mount.splitManifestHash)))) blockers.push('worker_dataset_split_manifest_hash_invalid');
  if (environment.HEPTA_DATASET_AUTHORIZATION_SET_HASH && environment.HEPTA_DATASET_AUTHORIZATION_SET_HASH !== authorizationSetHash) blockers.push('worker_dataset_authorization_set_mismatch');
  if (requireProof && !datasets.length) blockers.push('worker_dataset_access_proof_requires_dataset');
  if (requireProof && executionBackend === 'bubblewrap' && !hostTracerAvailable) blockers.push('worker_dataset_access_tracer_unavailable');
  if (requireProof && executionBackend === 'docker') {
    if (executionClass !== 'explicit-container') blockers.push('worker_dataset_access_requires_explicit_supervisor_container');
    if (executionIdentity?.datasetAccessSupervisorTrusted !== true || !executionIdentity?.datasetAccessSupervisor) blockers.push('worker_dataset_access_container_supervisor_untrusted');
    if (executionIdentity?.expectedImageDigest !== containerImageDigest) blockers.push('worker_dataset_access_container_image_digest_mismatch');
  }
  if (requireProof && !['bubblewrap', 'docker'].includes(executionBackend)) blockers.push('worker_dataset_access_trusted_supervisor_backend_unavailable');
  if (datasets.some((mount) => !mount.manifestHash || !mount.allowedDatasetRoot || !mount.sourceType || mount.boundaryBlockers.length || mount.manifestHashBefore !== mount.manifestHash)) blockers.push('worker_dataset_manifest_hash_mismatch');
  return blockers;
}
