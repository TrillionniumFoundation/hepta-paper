import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,191}$/;
const POD_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const PLACEHOLDER = /(?:REPLACE_WITH|PLACEHOLDER|CHANGEME|INSERT_|TODO)/i;
const CONTRACT = 'hepta-nested-container-runtime-v1';

export const NESTED_RUNTIME_PLATFORM_QUALIFIER_ROLE =
  'nested_runtime_platform_independent_qualifier';
export const NESTED_RUNTIME_STARTUP_CONFORMANCE_ROLE =
  'nested_runtime_startup_conformance_independent_attestor';

function canonicalInstant(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function safeId(value) {
  return SAFE_ID.test(String(value || '')) && !PLACEHOLDER.test(String(value));
}

function safeAbsolutePath(value) {
  const selected = String(value || '');
  const parts = selected.split('/').slice(1);
  const hasControlCharacter = [...selected].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
  return selected.startsWith('/') && selected !== '/'
    && selected === selected.trim() && selected.normalize('NFC') === selected
    && !hasControlCharacter && !selected.includes('\\')
    && parts.length > 0 && parts.every((part) => (
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)
    ))
    && !PLACEHOLDER.test(selected);
}

function canonicalGpu(value) {
  if (!exactKeys(value, [
    'declared', 'devicePluginId', 'driverVersion', 'toolkitVersion',
  ]) || typeof value.declared !== 'boolean') {
    throw new Error('nested_runtime_platform_gpu_profile_invalid');
  }
  const fields = ['devicePluginId', 'driverVersion', 'toolkitVersion'];
  if (value.declared
    ? fields.some((field) => !safeId(value[field]))
    : fields.some((field) => value[field] !== null)) {
    throw new Error('nested_runtime_platform_gpu_profile_invalid');
  }
  return Object.freeze({
    declared: value.declared,
    devicePluginId: value.devicePluginId,
    driverVersion: value.driverVersion,
    toolkitVersion: value.toolkitVersion,
  });
}

function canonicalPlatform(value) {
  if (!exactKeys(value, [
    'architecture', 'cgroup', 'cri', 'gpu', 'kernel', 'nodeImage', 'os',
    'runtime', 'runtimeClass', 'security',
  ]) || !safeId(value.os) || !safeId(value.architecture)
    || !exactKeys(value.cri, ['endpointIdentityHash', 'name', 'version'])
    || !safeId(value.cri.name) || !safeId(value.cri.version)
    || !SHA256.test(String(value.cri.endpointIdentityHash || ''))
    || !exactKeys(value.runtimeClass, ['handler', 'name'])
    || !safeId(value.runtimeClass.name) || !safeId(value.runtimeClass.handler)
    || !exactKeys(value.runtime, ['configurationHash', 'name', 'version'])
    || !safeId(value.runtime.name) || !safeId(value.runtime.version)
    || !SHA256.test(String(value.runtime.configurationHash || ''))
    || !exactKeys(value.kernel, ['release', 'securityPolicyHash'])
    || !safeId(value.kernel.release)
    || !SHA256.test(String(value.kernel.securityPolicyHash || ''))
    || !exactKeys(value.nodeImage, ['contentHash', 'id'])
    || !safeId(value.nodeImage.id)
    || !SHA256.test(String(value.nodeImage.contentHash || ''))
    || !exactKeys(value.cgroup, ['delegationPolicyHash', 'driver', 'mode'])
    || value.cgroup.mode !== 'v2' || !safeId(value.cgroup.driver)
    || !SHA256.test(String(value.cgroup.delegationPolicyHash || ''))
    || !exactKeys(value.security, [
      'allowPrivilegeEscalation', 'appArmorProfile', 'privileged',
      'seccompProfile', 'selinuxType', 'userNamespaceMode',
    ])
    || value.security.privileged !== false
    || value.security.allowPrivilegeEscalation !== false
    || !safeId(value.security.seccompProfile)
    || !safeId(value.security.appArmorProfile)
    || !safeId(value.security.selinuxType)
    || !safeId(value.security.userNamespaceMode)) {
    throw new Error('nested_runtime_platform_profile_invalid');
  }
  return Object.freeze({
    os: String(value.os),
    architecture: String(value.architecture),
    cri: Object.freeze({ ...value.cri }),
    runtimeClass: Object.freeze({ ...value.runtimeClass }),
    runtime: Object.freeze({ ...value.runtime }),
    kernel: Object.freeze({ ...value.kernel }),
    nodeImage: Object.freeze({ ...value.nodeImage }),
    cgroup: Object.freeze({ ...value.cgroup }),
    security: Object.freeze({ ...value.security }),
    gpu: canonicalGpu(value.gpu),
  });
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalProfile(value) {
  if (!exactKeys(value, [
    'fixedDigestWorkerImage', 'parentPodResourceCeiling', 'platform',
    'sharedScratchRoot', 'workerIdentity',
  ]) || !IMAGE.test(String(value.fixedDigestWorkerImage || ''))
    || PLACEHOLDER.test(String(value.fixedDigestWorkerImage))
    || !safeAbsolutePath(value.sharedScratchRoot)
    || !exactKeys(value.workerIdentity, ['gid', 'uid'])
    || !positiveInteger(value.workerIdentity.uid)
    || !positiveInteger(value.workerIdentity.gid)
    || !exactKeys(value.parentPodResourceCeiling, [
      'cpuMillis', 'memoryBytes', 'pids',
    ])
    || !positiveInteger(value.parentPodResourceCeiling.cpuMillis)
    || !positiveInteger(value.parentPodResourceCeiling.memoryBytes)
    || !positiveInteger(value.parentPodResourceCeiling.pids)) {
    throw new Error('nested_runtime_platform_execution_profile_invalid');
  }
  return Object.freeze({
    platform: canonicalPlatform(value.platform),
    fixedDigestWorkerImage: String(value.fixedDigestWorkerImage),
    sharedScratchRoot: String(value.sharedScratchRoot),
    workerIdentity: Object.freeze({ ...value.workerIdentity }),
    parentPodResourceCeiling: Object.freeze({ ...value.parentPodResourceCeiling }),
  });
}

function timeWindow({
  issuedAt,
  validFrom,
  expiresAt,
  now,
  maximumLifetimeMs,
  prefix,
}) {
  const issued = canonicalInstant(issuedAt);
  const valid = canonicalInstant(validFrom);
  const expires = canonicalInstant(expiresAt);
  const observed = now instanceof Date ? now : new Date(String(now || ''));
  const blockers = [];
  if (!issued || !valid || !expires || !Number.isFinite(observed.getTime())) {
    blockers.push(`${prefix}_time_window_invalid`);
  } else {
    const issuedMs = Date.parse(issued);
    const validMs = Date.parse(valid);
    const expiresMs = Date.parse(expires);
    if (validMs < issuedMs || expiresMs <= validMs) {
      blockers.push(`${prefix}_time_window_invalid`);
    }
    if (observed.getTime() < validMs) blockers.push(`${prefix}_not_yet_valid`);
    if (observed.getTime() >= expiresMs) blockers.push(`${prefix}_expired`);
    if (!Number.isSafeInteger(maximumLifetimeMs) || maximumLifetimeMs < 1
      || expiresMs - issuedMs > maximumLifetimeMs) {
      blockers.push(`${prefix}_lifetime_exceeds_policy`);
    }
  }
  return Object.freeze(blockers);
}

export function buildNestedRuntimePlatformProfile(value) {
  return canonicalProfile(value);
}

export function buildNestedRuntimePlatformQualificationSubject(value) {
  if (!exactKeys(value, [
    'contractVersion', 'expiresAt', 'issuedAt', 'kind', 'profile', 'profileHash',
    'profileId', 'validFrom', 'version',
  ]) || value.version !== 1 || value.kind !== 'NestedRuntimePlatformQualification'
    || value.contractVersion !== CONTRACT || !safeId(value.profileId)) {
    throw new Error('nested_runtime_platform_qualification_subject_invalid');
  }
  const profile = canonicalProfile(value.profile);
  const profileHash = hashRecord('NestedRuntimePlatformProfile', profile);
  if (value.profileHash !== profileHash
    || !canonicalInstant(value.issuedAt)
    || !canonicalInstant(value.validFrom)
    || !canonicalInstant(value.expiresAt)) {
    throw new Error('nested_runtime_platform_qualification_subject_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'NestedRuntimePlatformQualification',
    contractVersion: CONTRACT,
    profileId: String(value.profileId),
    profile,
    profileHash,
    issuedAt: value.issuedAt,
    validFrom: value.validFrom,
    expiresAt: value.expiresAt,
  });
}

export function inspectNestedRuntimePlatformQualificationSubject(subject, {
  now = null,
  maximumLifetimeMs = 30 * 24 * 60 * 60 * 1000,
} = {}) {
  const blockers = [];
  let canonical = null;
  try { canonical = buildNestedRuntimePlatformQualificationSubject(subject); }
  catch (error) {
    blockers.push(error?.message || 'nested_runtime_platform_qualification_subject_invalid');
  }
  if (canonical) {
    blockers.push(...timeWindow({
      ...canonical,
      now,
      maximumLifetimeMs,
      prefix: 'nested_runtime_platform_qualification',
    }));
  }
  return Object.freeze({
    ready: blockers.length === 0,
    canonical,
    profileHash: canonical?.profileHash || null,
    subjectHash: canonical
      ? hashRecord('NestedRuntimePlatformQualification', canonical) : null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function canonicalGpuProof(value, profile) {
  const declared = profile.platform.gpu.declared;
  if (!exactKeys(value, [
    'declared', 'deviceCount', 'devicePluginId', 'driverVersion', 'toolkitVersion',
  ]) || value.declared !== declared) {
    throw new Error('nested_runtime_startup_conformance_gpu_proof_invalid');
  }
  if (!declared) {
    if (value.deviceCount !== 0 || value.devicePluginId !== null
      || value.driverVersion !== null || value.toolkitVersion !== null) {
      throw new Error('nested_runtime_startup_conformance_gpu_proof_invalid');
    }
  } else if (!positiveInteger(value.deviceCount)
    || value.devicePluginId !== profile.platform.gpu.devicePluginId
    || value.driverVersion !== profile.platform.gpu.driverVersion
    || value.toolkitVersion !== profile.platform.gpu.toolkitVersion) {
    throw new Error('nested_runtime_startup_conformance_gpu_proof_invalid');
  }
  return Object.freeze({ ...value });
}

function canonicalConformanceProofs(value, profile) {
  const ceiling = profile.parentPodResourceCeiling;
  if (!exactKeys(value, [
    'bindReadWrite', 'fixedDigestWorker', 'gpu', 'network', 'resources',
  ])
    || !exactKeys(value.fixedDigestWorker, ['image', 'launched'])
    || value.fixedDigestWorker.launched !== true
    || value.fixedDigestWorker.image !== profile.fixedDigestWorkerImage
    || !exactKeys(value.bindReadWrite, [
      'readBackHash', 'resultGid', 'resultPath', 'resultPathWithinSharedScratch',
      'resultUid', 'sourcePath', 'writable',
    ])
    || value.bindReadWrite.writable !== true
    || value.bindReadWrite.resultPathWithinSharedScratch !== true
    || value.bindReadWrite.resultUid !== profile.workerIdentity.uid
    || value.bindReadWrite.resultGid !== profile.workerIdentity.gid
    || !safeAbsolutePath(value.bindReadWrite.sourcePath)
    || !safeAbsolutePath(value.bindReadWrite.resultPath)
    || !value.bindReadWrite.sourcePath.startsWith(`${profile.sharedScratchRoot}/`)
    || !value.bindReadWrite.resultPath.startsWith(`${profile.sharedScratchRoot}/`)
    || !SHA256.test(String(value.bindReadWrite.readBackHash || ''))
    || !exactKeys(value.network, ['dnsBlocked', 'mode', 'outboundBlocked'])
    || value.network.mode !== 'none'
    || value.network.outboundBlocked !== true || value.network.dnsBlocked !== true
    || !exactKeys(value.resources, [
      'cpuLimitEnforced', 'cpuMillis', 'memoryBytes', 'memoryLimitEnforced',
      'parentPodCeilingEnforced', 'parentPodCpuMillis', 'parentPodMemoryBytes',
      'parentPodPids', 'pids', 'pidsLimitEnforced',
    ])
    || value.resources.memoryLimitEnforced !== true
    || value.resources.cpuLimitEnforced !== true
    || value.resources.pidsLimitEnforced !== true
    || value.resources.parentPodCeilingEnforced !== true
    || !positiveInteger(value.resources.memoryBytes)
    || !positiveInteger(value.resources.cpuMillis)
    || !positiveInteger(value.resources.pids)
    || value.resources.memoryBytes > ceiling.memoryBytes
    || value.resources.cpuMillis > ceiling.cpuMillis
    || value.resources.pids > ceiling.pids
    || value.resources.parentPodMemoryBytes !== ceiling.memoryBytes
    || value.resources.parentPodCpuMillis !== ceiling.cpuMillis
    || value.resources.parentPodPids !== ceiling.pids) {
    throw new Error('nested_runtime_startup_conformance_proofs_invalid');
  }
  return Object.freeze({
    fixedDigestWorker: Object.freeze({ ...value.fixedDigestWorker }),
    bindReadWrite: Object.freeze({ ...value.bindReadWrite }),
    network: Object.freeze({ ...value.network }),
    resources: Object.freeze({ ...value.resources }),
    gpu: canonicalGpuProof(value.gpu, profile),
  });
}

export function buildNestedRuntimeStartupConformanceSubject(value, {
  qualification,
} = {}) {
  if (!qualification || !exactKeys(value, [
    'contractVersion', 'expiresAt', 'issuedAt', 'kind', 'observedAt', 'planHash',
    'podUid', 'profileHash', 'profileId', 'proofs', 'qualificationSubjectHash',
    'validFrom', 'version',
  ]) || value.version !== 1 || value.kind !== 'NestedRuntimeStartupConformance'
    || value.contractVersion !== CONTRACT
    || value.profileId !== qualification.canonical.profileId
    || value.profileHash !== qualification.profileHash
    || value.qualificationSubjectHash !== qualification.subjectHash
    || !POD_UID.test(String(value.podUid || ''))
    || !SHA256.test(String(value.planHash || ''))
    || !canonicalInstant(value.observedAt)
    || !canonicalInstant(value.issuedAt)
    || !canonicalInstant(value.validFrom)
    || !canonicalInstant(value.expiresAt)) {
    throw new Error('nested_runtime_startup_conformance_subject_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'NestedRuntimeStartupConformance',
    contractVersion: CONTRACT,
    profileId: qualification.canonical.profileId,
    profileHash: qualification.profileHash,
    qualificationSubjectHash: qualification.subjectHash,
    podUid: String(value.podUid),
    planHash: String(value.planHash),
    observedAt: value.observedAt,
    proofs: canonicalConformanceProofs(value.proofs, qualification.canonical.profile),
    issuedAt: value.issuedAt,
    validFrom: value.validFrom,
    expiresAt: value.expiresAt,
  });
}

export function inspectNestedRuntimeStartupConformanceSubject(subject, {
  qualification,
  expectedPodUid,
  expectedPlanHash,
  expectedProfileId,
  expectedRuntimeClassName,
  now = null,
  maximumLifetimeMs = 60 * 60 * 1000,
  maximumObservationAgeMs = 10 * 60 * 1000,
} = {}) {
  const blockers = [];
  let canonical = null;
  if (!qualification?.ready) {
    blockers.push('nested_runtime_platform_qualification_required');
  } else {
    try {
      canonical = buildNestedRuntimeStartupConformanceSubject(subject, { qualification });
    } catch (error) {
      blockers.push(error?.message || 'nested_runtime_startup_conformance_subject_invalid');
    }
  }
  if (canonical) {
    blockers.push(...timeWindow({
      ...canonical,
      now,
      maximumLifetimeMs,
      prefix: 'nested_runtime_startup_conformance',
    }));
    const observedAtMs = Date.parse(canonical.observedAt);
    const nowMs = (now instanceof Date ? now : new Date(String(now || ''))).getTime();
    if (observedAtMs > Date.parse(canonical.issuedAt)
      || !Number.isSafeInteger(maximumObservationAgeMs)
      || maximumObservationAgeMs < 1
      || nowMs - observedAtMs > maximumObservationAgeMs
      || observedAtMs > nowMs) {
      blockers.push('nested_runtime_startup_conformance_observation_stale_or_invalid');
    }
    if (observedAtMs < Date.parse(qualification.canonical.validFrom)
      || Date.parse(canonical.issuedAt) < Date.parse(qualification.canonical.validFrom)
      || Date.parse(canonical.validFrom) < Date.parse(qualification.canonical.validFrom)
      || Date.parse(canonical.expiresAt) > Date.parse(qualification.canonical.expiresAt)) {
      blockers.push('nested_runtime_startup_conformance_outside_qualification_window');
    }
    if (canonical.podUid !== expectedPodUid) {
      blockers.push('nested_runtime_startup_conformance_pod_uid_mismatch');
    }
    if (canonical.planHash !== expectedPlanHash) {
      blockers.push('nested_runtime_startup_conformance_plan_hash_mismatch');
    }
    if (canonical.profileId !== expectedProfileId) {
      blockers.push('nested_runtime_startup_conformance_profile_id_mismatch');
    }
    if (qualification.canonical.profile.platform.runtimeClass.name
      !== expectedRuntimeClassName) {
      blockers.push('nested_runtime_startup_conformance_runtime_class_mismatch');
    }
  }
  return Object.freeze({
    ready: blockers.length === 0,
    canonical,
    subjectHash: canonical
      ? hashRecord('NestedRuntimeStartupConformance', canonical) : null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function nestedRuntimePlatformContractVersion() {
  return CONTRACT;
}
