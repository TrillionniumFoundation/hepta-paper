import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES,
  SYSTEM_DATASET_ACCESS_SUPERVISOR,
} from './dataset-access-supervisor-policy.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const RUNTIME_CAPABILITY_INSPECTION_KEYS = Object.freeze([
  'assuranceScope',
  'autonomousEmpiricalRuntimeCapabilityInspectionHash',
  'kind',
  'languages',
  'runtimeFallbackAllowed',
  'status',
  'unavailableLanguages',
  'version',
].sort());
const LANGUAGE_CAPABILITY_KEYS = Object.freeze([
  'available',
  'datasetAccessSupervisor',
  'exactDigestVerified',
  'expectedDigest',
  'image',
  'language',
  'observedDigest',
  'runtimeType',
  'trustedDatasetSupervisorConfigured',
].sort());

const FAMILY_PROFILE_ENTRIES = Object.freeze([
  Object.freeze(['econometrics_panel_benchmark', 'r']),
  Object.freeze(['finance_asset_pricing_benchmark', 'r']),
  Object.freeze(['ml_algorithm_benchmark', 'python']),
  Object.freeze(['operations_optimization_benchmark', 'python']),
  Object.freeze(['rl_stochastic_control_benchmark', 'python']),
]);

const FAMILY_PROFILES = Object.freeze(Object.fromEntries(FAMILY_PROFILE_ENTRIES.map(
  ([protocolFamily, language]) => [protocolFamily, Object.freeze({
    label: language,
    language,
    requiresGpu: false,
  })],
)));

const RUNTIME_PINS = Object.freeze(Object.fromEntries(['python', 'r'].map((language) => {
  const runtime = SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES[language];
  return [language, Object.freeze({
    language,
    runtimeType: 'container',
    image: runtime.image,
    expectedDigest: runtime.imageDigest,
    datasetAccessSupervisor: Object.freeze({
      protocol: SYSTEM_DATASET_ACCESS_SUPERVISOR.protocol,
      path: SYSTEM_DATASET_ACCESS_SUPERVISOR.path,
      sha256: SYSTEM_DATASET_ACCESS_SUPERVISOR.sha256,
      workloadUid: SYSTEM_DATASET_ACCESS_SUPERVISOR.workloadUid,
    }),
  })];
})));

const POLICY_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'AutonomousEmpiricalExecutionProfilePolicy',
  status: 'autonomous_empirical_execution_profile_policy_active',
  selector: 'exact-protocol-family-static-profile-v1',
  familyProfiles: FAMILY_PROFILES,
  runtimePins: RUNTIME_PINS,
  exactlyOneExecutionProfileRequired: true,
  runtimeFallbackAllowed: false,
  callerOverrideAllowed: false,
});

export const AUTONOMOUS_EMPIRICAL_EXECUTION_PROFILE_POLICY = Object.freeze({
  ...POLICY_PAYLOAD,
  autonomousEmpiricalExecutionProfilePolicyHash:
    hashRecord('AutonomousEmpiricalExecutionProfilePolicy', POLICY_PAYLOAD),
});

export const AUTONOMOUS_EMPIRICAL_PROTOCOL_FAMILIES = Object.freeze(
  FAMILY_PROFILE_ENTRIES.map(([protocolFamily]) => protocolFamily),
);

function recordHashValid(record, kind, hashField) {
  if (!record || typeof record !== 'object' || !SHA256.test(String(record[hashField] || ''))) {
    return false;
  }
  const { [hashField]: claimedHash, ...payload } = record;
  return hashRecord(kind, payload) === claimedHash;
}

function hasExactKeys(value, expectedKeys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expectedKeys);
}

export function verifyAutonomousEmpiricalRuntimeCapabilityInspection(value) {
  if (!hasExactKeys(value, RUNTIME_CAPABILITY_INSPECTION_KEYS)
    || !recordHashValid(
    value,
    'AutonomousEmpiricalRuntimeCapabilityInspection',
    'autonomousEmpiricalRuntimeCapabilityInspectionHash',
  ) || value?.version !== 1 || value?.kind !== 'AutonomousEmpiricalRuntimeCapabilityInspection'
    || value?.assuranceScope !== 'local-pinned-container-runtime-preflight-v1'
    || value?.runtimeFallbackAllowed !== false
    || !value?.languages || typeof value.languages !== 'object' || Array.isArray(value.languages)
    || JSON.stringify(Object.keys(value.languages).sort()) !== JSON.stringify(['python', 'r'])
    || !Array.isArray(value?.unavailableLanguages)) {
    return false;
  }
  const capabilitiesValid = ['python', 'r'].every((language) => {
    const capability = value.languages[language];
    const pin = RUNTIME_PINS[language];
    return hasExactKeys(capability, LANGUAGE_CAPABILITY_KEYS)
      && capability?.language === language
      && capability?.runtimeType === pin.runtimeType
      && capability?.image === pin.image
      && capability?.expectedDigest === pin.expectedDigest
      && (capability.observedDigest === null || SHA256.test(String(capability.observedDigest)))
      && typeof capability?.exactDigestVerified === 'boolean'
      && capability.exactDigestVerified === (capability.observedDigest === pin.expectedDigest)
      && JSON.stringify(capability?.datasetAccessSupervisor)
        === JSON.stringify(pin.datasetAccessSupervisor)
      && capability?.trustedDatasetSupervisorConfigured === true
      && typeof capability?.available === 'boolean'
      && capability.available === (
        capability.exactDigestVerified && capability.trustedDatasetSupervisorConfigured
      );
  });
  if (!capabilitiesValid) return false;
  const expectedUnavailableLanguages = ['python', 'r']
    .filter((language) => value.languages[language].available !== true);
  return JSON.stringify(value.unavailableLanguages) === JSON.stringify(expectedUnavailableLanguages)
    && value.status === (expectedUnavailableLanguages.length
      ? 'autonomous_empirical_runtime_capability_partial_or_blocked'
      : 'autonomous_empirical_runtime_capability_ready');
}

export function selectAutonomousEmpiricalExecutionProfile({
  protocolFamily,
  runtimeCapabilityInspection = null,
} = {}) {
  const family = String(protocolFamily || '');
  const profile = FAMILY_PROFILES[family];
  if (!profile) throw new Error('autonomous_empirical_execution_profile_family_unsupported');
  const capabilityReceiptValid = verifyAutonomousEmpiricalRuntimeCapabilityInspection(
    runtimeCapabilityInspection,
  );
  const runtimeCapability = capabilityReceiptValid
    ? runtimeCapabilityInspection.languages[profile.language] : null;
  const blockers = [];
  if (!capabilityReceiptValid) {
    blockers.push('autonomous_empirical_runtime_capability_inspection_invalid');
  } else if (runtimeCapability.available !== true) {
    blockers.push(`autonomous_empirical_runtime_language_unavailable:${profile.language}`);
  }
  const payload = {
    version: 1,
    kind: 'AutonomousEmpiricalExecutionProfileSelection',
    status: blockers.length
      ? 'autonomous_empirical_execution_profile_blocked'
      : 'autonomous_empirical_execution_profile_ready',
    protocolFamily: family,
    executionProfile: profile,
    profileCount: 1,
    policyHash:
      AUTONOMOUS_EMPIRICAL_EXECUTION_PROFILE_POLICY
        .autonomousEmpiricalExecutionProfilePolicyHash,
    runtimeCapabilityInspectionHash: capabilityReceiptValid
      ? runtimeCapabilityInspection.autonomousEmpiricalRuntimeCapabilityInspectionHash : null,
    selectedRuntimeImage: runtimeCapability?.image || null,
    selectedRuntimeExpectedDigest: runtimeCapability?.expectedDigest || null,
    selectedRuntimeImageDigest: runtimeCapability?.observedDigest || null,
    selectedRuntimeExactDigestVerified: runtimeCapability?.exactDigestVerified === true,
    runtimeFallbackAllowed: false,
    runtimeFallbackPerformed: false,
    callerOverrideAllowed: false,
    blockers: Object.freeze(blockers),
  };
  return Object.freeze({
    ...payload,
    autonomousEmpiricalExecutionProfileSelectionHash:
      hashRecord('AutonomousEmpiricalExecutionProfileSelection', payload),
  });
}

export function verifyAutonomousEmpiricalExecutionProfileSelection(value, {
  protocolFamily = null,
  requireReady = false,
  runtimeCapabilityInspection = null,
  requireRuntimeCapabilityInspection = false,
} = {}) {
  if (!recordHashValid(
    value,
    'AutonomousEmpiricalExecutionProfileSelection',
    'autonomousEmpiricalExecutionProfileSelectionHash',
  ) || value?.version !== 1 || value?.kind !== 'AutonomousEmpiricalExecutionProfileSelection'
    || !Object.hasOwn(FAMILY_PROFILES, value?.protocolFamily)
    || (protocolFamily && value.protocolFamily !== protocolFamily)
    || value?.profileCount !== 1
    || value?.policyHash !== AUTONOMOUS_EMPIRICAL_EXECUTION_PROFILE_POLICY
      .autonomousEmpiricalExecutionProfilePolicyHash
    || value?.runtimeFallbackAllowed !== false || value?.runtimeFallbackPerformed !== false
    || value?.callerOverrideAllowed !== false
    || JSON.stringify(value?.executionProfile) !== JSON.stringify(FAMILY_PROFILES[value.protocolFamily])
    || !Array.isArray(value?.blockers)
    || !['autonomous_empirical_execution_profile_ready', 'autonomous_empirical_execution_profile_blocked']
      .includes(value?.status)
    || (value.status === 'autonomous_empirical_execution_profile_ready'
      && (value.blockers.length !== 0
        || !SHA256.test(String(value?.runtimeCapabilityInspectionHash || ''))
        || value?.selectedRuntimeImage !== RUNTIME_PINS[value.protocolFamily
          ? FAMILY_PROFILES[value.protocolFamily].language : '']?.image
        || value?.selectedRuntimeExpectedDigest !== RUNTIME_PINS[value.protocolFamily
          ? FAMILY_PROFILES[value.protocolFamily].language : '']?.expectedDigest
        || value?.selectedRuntimeImageDigest !== value?.selectedRuntimeExpectedDigest
        || value?.selectedRuntimeExactDigestVerified !== true))
    || (requireReady && value?.status !== 'autonomous_empirical_execution_profile_ready')) {
    return false;
  }
  if (runtimeCapabilityInspection !== null) {
    if (!verifyAutonomousEmpiricalRuntimeCapabilityInspection(runtimeCapabilityInspection)) {
      return false;
    }
    const expected = selectAutonomousEmpiricalExecutionProfile({
      protocolFamily: value.protocolFamily,
      runtimeCapabilityInspection,
    });
    if (JSON.stringify(value) !== JSON.stringify(expected)) return false;
  } else if (requireRuntimeCapabilityInspection || requireReady) {
    return false;
  }
  return true;
}
