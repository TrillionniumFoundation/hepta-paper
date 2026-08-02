import {
  readAutonomousResearchAuthorIdentityConfiguration,
} from '../../paper-adapters/automation/autonomous-research-author-identity-configuration.mjs';
import {
  verifyPinnedExternalEvidenceEnvelope,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  inspectResearchExecutionReleaseAttestorConfiguration,
} from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import {
  inspectProvisionedReleaseAttestorConfigurationHeader,
} from '../../paper-adapters/build-package/research-execution-release-attestor-configuration.mjs';
import {
  verifyExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const AUTHOR_CONFIG_ENV = 'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG';
const AUTHOR_CONFIG_HASH_ENV = 'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH';
const RELEASE_CONFIG_ENV = 'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG';
const RELEASE_CONFIG_HASH_ENV =
  'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH';

function selectedValue(explicit, fallback) {
  const value = explicit ?? fallback ?? null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedHash(value) {
  const selected = selectedValue(value, null);
  return selected === null ? null : selected.toLowerCase();
}

function stableBlocker(error, fallback) {
  const message = String(error?.message || '');
  return /^[a-z][a-z0-9_:-]{2,240}$/.test(message) ? message : fallback;
}

function unique(values) {
  return Object.freeze([...new Set(values.filter(Boolean))]);
}

function blockedAuthor(blocker) {
  return Object.freeze({
    status: 'production_external_author_identity_input_blocked',
    readyForRuntimeBinding: false,
    configured: false,
    configurationVersion: null,
    stablePolicyPinned: false,
    configurationPinned: false,
    observedConfigurationHash: null,
    authoritySubjectHash: null,
    authorityEnvelopeHash: null,
    authorityVerificationReceiptHash: null,
    attestationExpiresAt: null,
    cryptographicAuthorityReady: false,
    externalActionPerformed: false,
    blockers: Object.freeze([blocker]),
  });
}

function inspectAuthorInput({
  configPath,
  expectedConfigurationHash,
  now,
}) {
  if (!configPath) {
    return blockedAuthor('autonomous_research_author_identity_configuration_path_missing');
  }
  let configuration;
  try {
    configuration = readAutonomousResearchAuthorIdentityConfiguration({
      configPath,
    });
  } catch (error) {
    return blockedAuthor(stableBlocker(
      error,
      'autonomous_research_author_identity_configuration_file_invalid',
    ));
  }
  const expectedHash = normalizedHash(expectedConfigurationHash);
  const configurationPinned = SHA256.test(String(expectedHash || ''))
    && expectedHash === configuration.configurationHash;
  const stablePolicyPinned = configuration.version === 2;
  const pinBlockers = expectedHash === null
    ? ['autonomous_research_author_identity_configuration_pin_required']
    : configurationPinned
      ? []
      : ['autonomous_research_author_identity_configuration_pin_mismatch'];
  const policyBlockers = stablePolicyPinned
    ? []
    : ['autonomous_research_author_identity_stable_policy_v2_required'];
  const verificationReceipt = verifyPinnedExternalEvidenceEnvelope({
    envelope: configuration.authorityEnvelope,
    subjectKind: configuration.subject.kind,
    subjectHash:
      configuration.subject.externalPrincipalIdentityAttestationSubjectHash,
    trustStore: configuration.trustStore,
    requiredRole: configuration.signerRole,
    expectedKeyIds: configuration.signerKeyIds,
    now,
    maximumLifetimeMs: configuration.maximumLifetimeMs,
  });
  const subjectCurrent = verifyExternalPrincipalIdentityAttestationSubject(
    configuration.subject,
    {
      now,
      maximumLifetimeMs: configuration.maximumLifetimeMs,
      requirePlatformAttestation: true,
    },
  );
  const blockers = unique([
    ...pinBlockers,
    ...policyBlockers,
    ...(subjectCurrent
      ? []
      : ['autonomous_research_author_identity_subject_not_current']),
    ...verificationReceipt.blockers,
  ]);
  const cryptographicAuthorityReady =
    verificationReceipt.cryptographicAuthorityReady === true;
  const readyForRuntimeBinding = configurationPinned
    && stablePolicyPinned
    && subjectCurrent
    && cryptographicAuthorityReady;
  return Object.freeze({
    status: readyForRuntimeBinding
      ? 'production_external_author_identity_input_ready_for_runtime_binding'
      : 'production_external_author_identity_input_blocked',
    readyForRuntimeBinding,
    configured: true,
    configurationVersion: configuration.version,
    stablePolicyPinned,
    configurationPinned,
    observedConfigurationHash: configuration.configurationHash,
    authoritySubjectHash:
      configuration.subject.externalPrincipalIdentityAttestationSubjectHash,
    authorityEnvelopeHash: verificationReceipt.envelopeHash || null,
    authorityVerificationReceiptHash:
      verificationReceipt.pinnedExternalEvidenceVerificationReceiptHash || null,
    attestationExpiresAt: verificationReceipt.expiresAt || null,
    cryptographicAuthorityReady,
    externalActionPerformed: false,
    blockers,
  });
}

function blockedRelease(blocker, {
  configured = false,
  configurationVersion = null,
  configurationFileHash = null,
  backendKind = null,
} = {}) {
  return Object.freeze({
    status: 'production_external_release_attestor_input_blocked',
    readyForLiveVerification: false,
    configured,
    configurationVersion,
    configurationPinned: false,
    observedConfigurationFileHash: configurationFileHash,
    observedConfigurationIdentityHash: null,
    configurationIdentityProfile: null,
    backendKind,
    backendDescriptorHash: null,
    hardwareProtected: false,
    privateKeyExportable: null,
    externalSignerProcess: false,
    kmsHardwareAuthorityReady: false,
    kmsHardwareAuthorityIndependent: false,
    kmsHardwareAuthorityBundleHash: null,
    kmsHardwareAuthorityExpiresAt: null,
    liveProbeRequired: false,
    liveSignerChallengeRequired: false,
    externalActionPerformed: false,
    blockers: Object.freeze([blocker]),
  });
}

function inspectReleaseInput({
  configPath,
  expectedConfigurationHash,
  environment,
  now,
}) {
  if (!configPath) {
    return blockedRelease('research_execution_release_attestor_config_path_missing');
  }
  const header = inspectProvisionedReleaseAttestorConfigurationHeader({
    configPath,
    environment,
  });
  if (header.blocker) {
    return blockedRelease(header.blocker, {
      configurationFileHash: header.configurationFileHash,
      backendKind: header.backendKind,
    });
  }
  if (header.configurationVersion !== 3
    || header.backendKind !== 'external-kms-command') {
    return blockedRelease(
      'research_execution_release_attestor_external_kms_v3_configuration_required',
      {
        configured: true,
        configurationVersion: header.configurationVersion,
        configurationFileHash: header.configurationFileHash,
        backendKind: header.backendKind,
      },
    );
  }
  let inspection;
  try {
    const passiveEnvironment = { ...environment };
    delete passiveEnvironment[RELEASE_CONFIG_HASH_ENV];
    inspection = inspectResearchExecutionReleaseAttestorConfiguration({
      configPath,
      expectedConfigurationHash: null,
      requiredConfigurationVersion: 3,
      requiredBackendKind: 'external-kms-command',
      environment: passiveEnvironment,
      now,
      activeVerification: false,
      spawnSyncImpl() {
        throw new Error('production_external_authority_intake_external_process_forbidden');
      },
    });
  } catch (error) {
    return blockedRelease(stableBlocker(
      error,
      'research_execution_release_attestor_config_invalid',
    ));
  }
  const configured = SHA256.test(String(
    inspection.configurationIdentityHash || '',
  ));
  const expectedHash = normalizedHash(expectedConfigurationHash);
  const configurationPinned = configured
    && SHA256.test(String(expectedHash || ''))
    && expectedHash === inspection.configurationIdentityHash;
  const pinBlockers = expectedHash === null
    ? ['research_execution_release_attestor_config_pin_required']
    : configurationPinned
      ? []
      : ['research_execution_release_attestor_config_pin_mismatch'];
  const externalKmsV3Ready = inspection.backendKind === 'external-kms-command'
    && typeof inspection.kmsProvider === 'string'
    && inspection.kmsProvider.length > 0;
  const hardwareBoundaryReady = inspection.backendProductionEligible === true
    && inspection.hardwareProtected === true
    && inspection.privateKeyExportable === false
    && inspection.externalSignerProcess === true;
  const hardwareAuthorityReady =
    inspection.kmsHardwareAuthorityAttestationReady === true
    && inspection.kmsHardwareAuthorityIndependent === true;
  const staticBlockers = [
    ...inspection.blockers,
    ...inspection.kmsHardwareAuthorityBlockers,
    ...pinBlockers,
    ...(externalKmsV3Ready
      ? []
      : ['research_execution_release_attestor_external_kms_v3_configuration_required']),
    ...(hardwareBoundaryReady
      ? []
      : ['research_execution_release_attestor_full_production_hardware_kms_required']),
    ...(hardwareAuthorityReady
      ? []
      : [
        'research_execution_release_attestor_kms_hardware_authority_attestation_required',
      ]),
    ...(inspection.externalActionPerformed === false
      ? []
      : ['production_external_authority_intake_unexpected_external_action']),
  ];
  const blockers = unique(staticBlockers);
  const readyForLiveVerification = configured
    && configurationPinned
    && inspection.ready === true
    && externalKmsV3Ready
    && hardwareBoundaryReady
    && hardwareAuthorityReady
    && inspection.externalActionPerformed === false
    && blockers.length === 0;
  return Object.freeze({
    status: readyForLiveVerification
      ? 'production_external_release_attestor_input_ready_for_live_verification'
      : 'production_external_release_attestor_input_blocked',
    readyForLiveVerification,
    configured,
    configurationVersion: header.configurationVersion,
    configurationPinned,
    observedConfigurationFileHash:
      inspection.configurationFileHash || null,
    observedConfigurationIdentityHash:
      inspection.configurationIdentityHash || null,
    configurationIdentityProfile:
      inspection.configurationIdentityProfile || null,
    backendKind: inspection.backendKind || null,
    backendDescriptorHash: inspection.backendDescriptorHash || null,
    hardwareProtected: inspection.hardwareProtected === true,
    privateKeyExportable:
      inspection.privateKeyExportable === true
        ? true
        : inspection.privateKeyExportable === false ? false : null,
    externalSignerProcess: inspection.externalSignerProcess === true,
    kmsHardwareAuthorityReady:
      inspection.kmsHardwareAuthorityAttestationReady === true,
    kmsHardwareAuthorityIndependent:
      inspection.kmsHardwareAuthorityIndependent === true,
    kmsHardwareAuthorityBundleHash:
      inspection.kmsHardwareAuthorityAttestationBundleHash || null,
    kmsHardwareAuthorityExpiresAt:
      inspection.kmsHardwareAuthorityExpiresAt || null,
    liveProbeRequired: readyForLiveVerification,
    liveSignerChallengeRequired: readyForLiveVerification,
    externalActionPerformed: inspection.externalActionPerformed === true,
    blockers,
  });
}

export function composeProductionExternalAuthorityIntake({
  authorConfigPath = null,
  authorExpectedConfigurationHash = null,
  releaseAttestorConfigPath = null,
  releaseAttestorExpectedConfigurationHash = null,
  environment = process.env,
  now = new Date(),
} = {}) {
  const observedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error('production_external_authority_intake_clock_invalid');
  }
  const selectedAuthorConfigPath = selectedValue(
    authorConfigPath,
    environment[AUTHOR_CONFIG_ENV],
  );
  const selectedAuthorHash = selectedValue(
    authorExpectedConfigurationHash,
    environment[AUTHOR_CONFIG_HASH_ENV],
  );
  const selectedReleaseConfigPath = selectedValue(
    releaseAttestorConfigPath,
    environment[RELEASE_CONFIG_ENV],
  );
  const selectedReleaseHash = selectedValue(
    releaseAttestorExpectedConfigurationHash,
    environment[RELEASE_CONFIG_HASH_ENV],
  );
  const author = inspectAuthorInput({
    configPath: selectedAuthorConfigPath,
    expectedConfigurationHash: selectedAuthorHash,
    now: observedAt,
  });
  const releaseAttestor = inspectReleaseInput({
    configPath: selectedReleaseConfigPath,
    expectedConfigurationHash: selectedReleaseHash,
    environment,
    now: observedAt,
  });
  const blockers = unique([
    ...author.blockers,
    ...releaseAttestor.blockers,
  ]);
  const readyForLiveVerification = author.readyForRuntimeBinding === true
    && releaseAttestor.readyForLiveVerification === true
    && blockers.length === 0;
  const payload = {
    version: 1,
    kind: 'ProductionExternalAuthorityIntakeInspection',
    status: readyForLiveVerification
      ? 'production_external_authority_inputs_ready_for_live_verification'
      : 'production_external_authority_inputs_required',
    ready: readyForLiveVerification,
    readyForLiveVerification,
    fullProductionReady: false,
    observedAt: observedAt.toISOString(),
    externalActionPerformed: false,
    serviceStateChanged: false,
    requiredEnvironmentVariables: Object.freeze([
      AUTHOR_CONFIG_ENV,
      AUTHOR_CONFIG_HASH_ENV,
      RELEASE_CONFIG_ENV,
      RELEASE_CONFIG_HASH_ENV,
    ]),
    nextAction: readyForLiveVerification
      ? 'run_single_live_author_and_release_attestor_verification'
      : 'supply_or_correct_external_authority_inputs',
    author,
    releaseAttestor,
    deferredLiveChecks: Object.freeze([
      'bind_external_author_attestation_to_the_live_author_principal',
      'run_independent_release_attestor_backend_probe',
      'run_active_release_attestor_signing_challenge',
    ]),
    blockers,
  };
  return Object.freeze({
    ...payload,
    productionExternalAuthorityIntakeInspectionHash: hashRecord(
      'ProductionExternalAuthorityIntakeInspection',
      payload,
    ),
  });
}
