import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS,
  researchExecutionReleaseSignerBackendProductionAssuranceReady,
} from '../../paper-ports/research-execution-release-signer-backend-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  activeSignerChallenge,
  configurationAuthorizesExternalKmsAction,
  inspectKmsHardwareAuthority,
  probeAttestationCurrentAt,
  releaseAttestorInspectionPayload,
  revalidateLiveAuthority,
} from './research-execution-release-attestor-inspection-support.mjs';
import {
  readProvisionedReleaseAttestorConfiguration,
} from './research-execution-release-attestor-configuration.mjs';

function reportSynchronousProgress(onProgress, stage) {
  if (onProgress === null || onProgress === undefined) return;
  if (typeof onProgress !== 'function') {
    throw new Error('research_execution_release_attestor_progress_callback_invalid');
  }
  const result = onProgress(Object.freeze({ stage }));
  if (result && typeof result.then === 'function') {
    throw new Error(
      'research_execution_release_attestor_progress_callback_must_be_synchronous',
    );
  }
}

async function reportProgress(onProgress, stage) {
  if (onProgress === null || onProgress === undefined) return;
  if (typeof onProgress !== 'function') {
    throw new Error('research_execution_release_attestor_progress_callback_invalid');
  }
  await onProgress(Object.freeze({ stage }));
}

function failedChallenge(attempted) {
  return Object.freeze({
    attempted,
    verified: false,
    signingPayloadHash: null,
    verificationHash: null,
  });
}

function adoptLiveState(current, candidate) {
  return {
    read: candidate.read || current.read,
    descriptor: candidate.descriptor || current.descriptor,
    kmsHardwareAuthority:
      candidate.kmsHardwareAuthority || current.kmsHardwareAuthority,
    completionTimestamp:
      candidate.timestamp ?? current.completionTimestamp,
  };
}

function* inspectReleaseAttestor({
  runtimeRoot,
  configPath,
  expectedConfigurationHash,
  requiredConfigurationVersion,
  requiredBackendKind,
  now,
  environment,
  spawnSyncImpl,
  randomBytesImpl,
  activeVerification,
  clock,
}) {
  yield 'release_attestor_before_configuration_read';
  const readConfiguration = () => readProvisionedReleaseAttestorConfiguration({
    runtimeRoot,
    configPath,
    expectedConfigurationHash,
    requiredConfigurationVersion,
    requiredBackendKind,
    environment,
    spawnSyncImpl,
    randomBytesImpl,
  });
  let read = readConfiguration();
  yield 'release_attestor_after_configuration_read';
  const blockers = read.blocker ? [read.blocker] : [];
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    blockers.push('research_execution_release_attestor_inspection_time_invalid');
  }
  const activeKey = read.configuration?.activeKey || null;
  if (activeKey && (timestamp < Date.parse(activeKey.effectiveFrom)
    || timestamp >= Date.parse(activeKey.expiresAt)
    || (activeKey.revokedAt && timestamp >= Date.parse(activeKey.revokedAt)))) {
    blockers.push('research_execution_release_attestor_key_not_currently_valid');
  }

  let probe = Object.freeze({ verified: false, attestation: null });
  let descriptor = read.configuration?.backendPort?.describeBackend() || null;
  let kmsHardwareAuthority = inspectKmsHardwareAuthority(
    read.configuration,
    descriptor,
    timestamp,
  );
  let liveVerificationAuthorized = configurationAuthorizesExternalKmsAction(
    read.configuration,
    descriptor,
    kmsHardwareAuthority,
  );
  const baselineConfigurationIdentityHash =
    read.configuration?.configurationIdentityHash || null;
  const baselineBackendDescriptorHash =
    descriptor?.researchExecutionReleaseSignerBackendDescriptorHash || null;
  let completionTimestamp = timestamp;
  let probeAttempted = false;
  const revalidate = () => revalidateLiveAuthority({
    readConfiguration,
    baselineConfigurationIdentityHash,
    baselineBackendDescriptorHash,
    previousTimestamp: completionTimestamp,
    clock,
  });
  const adopt = (candidate) => {
    ({
      read,
      descriptor,
      kmsHardwareAuthority,
      completionTimestamp,
    } = adoptLiveState({
      read,
      descriptor,
      kmsHardwareAuthority,
      completionTimestamp,
    }, candidate));
  };

  const probeRequested = activeVerification === true
    && descriptor?.productionEligible === true
    && Number.isFinite(timestamp)
    && liveVerificationAuthorized;
  if (probeRequested) {
    yield 'release_attestor_before_backend_probe';
    const beforeProbe = revalidate();
    adopt(beforeProbe);
    if (!beforeProbe.ready) {
      blockers.push(beforeProbe.blocker);
      liveVerificationAuthorized = false;
    } else {
      probeAttempted = true;
      try {
        probe = read.configuration.backendPort.probeBackend({
          inspectedAt: new Date(completionTimestamp),
        });
      } catch {
        probe = Object.freeze({ verified: false, attestation: null });
      }
    }
  }

  if (probeAttempted) {
    yield 'release_attestor_after_backend_probe_before_signer_challenge';
    const afterProbe = revalidate();
    adopt(afterProbe);
    if (!afterProbe.ready) {
      blockers.push(afterProbe.blocker);
      probe = Object.freeze({ verified: false, attestation: null });
      liveVerificationAuthorized = false;
    }
    if (!probeAttestationCurrentAt(probe, completionTimestamp)) {
      probe = Object.freeze({ verified: false, attestation: null });
      blockers.push('research_execution_release_attestor_backend_probe_not_verified');
    }
  }

  yield 'release_attestor_before_active_signer_challenge';
  if (activeVerification === true && liveVerificationAuthorized
    && probe.verified === true) {
    const beforeSignerChallenge = revalidate();
    adopt(beforeSignerChallenge);
    if (!beforeSignerChallenge.ready) {
      blockers.push(beforeSignerChallenge.blocker);
      liveVerificationAuthorized = false;
    }
    if (!probeAttestationCurrentAt(probe, completionTimestamp)) {
      probe = Object.freeze({ verified: false, attestation: null });
      blockers.push('research_execution_release_attestor_backend_probe_not_verified');
      liveVerificationAuthorized = false;
    }
  }

  let signerChallenge = activeVerification === true && liveVerificationAuthorized
    ? activeSignerChallenge({
      configuration: read.configuration,
      descriptor,
      timestamp: completionTimestamp,
      probe,
      randomBytesImpl,
    }) : failedChallenge(false);
  yield 'release_attestor_after_active_signer_challenge';
  if (signerChallenge.attempted === true) {
    const afterSignerChallenge = revalidate();
    adopt(afterSignerChallenge);
    if (!afterSignerChallenge.ready) {
      blockers.push(afterSignerChallenge.blocker);
      signerChallenge = failedChallenge(true);
      liveVerificationAuthorized = false;
    }
  }
  if (activeVerification === true && descriptor?.productionEligible === true
    && liveVerificationAuthorized
    && signerChallenge.verified !== true) {
    blockers.push(
      'research_execution_release_attestor_active_signer_challenge_not_verified',
    );
  }

  const productionBlockers = [];
  if (!researchExecutionReleaseSignerBackendProductionAssuranceReady(descriptor)) {
    productionBlockers.push(
      'research_execution_release_attestor_production_backend_required',
    );
  }
  if (descriptor?.backendKind
      === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
    && read.configuration?.configurationPinned !== true) {
    productionBlockers.push(
      'research_execution_release_attestor_config_pin_required',
    );
  }
  if (descriptor?.backendKind
      === RESEARCH_EXECUTION_RELEASE_SIGNER_BACKEND_KINDS.EXTERNAL_KMS_COMMAND
    && kmsHardwareAuthority?.hardwareAuthorityReady !== true) {
    productionBlockers.push(
      'research_execution_release_attestor_kms_hardware_authority_attestation_required',
    );
  }
  if (probe.verified !== true) {
    productionBlockers.push(
      'research_execution_release_attestor_independent_backend_probe_required',
    );
  }
  if (signerChallenge.verified !== true) {
    productionBlockers.push(
      'research_execution_release_attestor_active_signer_challenge_required',
    );
  }
  const payload = releaseAttestorInspectionPayload({
    read,
    timestamp,
    completionTimestamp,
    kmsHardwareAuthority,
    probe,
    probeAttempted,
    signerChallenge,
    blockers,
    productionBlockers,
  });
  return Object.freeze({
    ...payload,
    researchExecutionReleaseAttestorConfigurationInspectionHash: hashRecord(
      'ResearchExecutionReleaseAttestorConfigurationInspection',
      payload,
    ),
  });
}

function optionsWithDefaults(options) {
  return {
    runtimeRoot: options.runtimeRoot,
    configPath: options.configPath ?? null,
    expectedConfigurationHash: options.expectedConfigurationHash ?? null,
    requiredConfigurationVersion: options.requiredConfigurationVersion ?? null,
    requiredBackendKind: options.requiredBackendKind ?? null,
    now: options.now ?? new Date(),
    environment: options.environment ?? process.env,
    spawnSyncImpl: options.spawnSyncImpl ?? spawnSync,
    randomBytesImpl: options.randomBytesImpl ?? crypto.randomBytes,
    activeVerification: options.activeVerification ?? true,
    clock: options.clock ?? { now: () => new Date() },
  };
}

export function inspectResearchExecutionReleaseAttestorConfiguration(
  options = {},
) {
  const iterator = inspectReleaseAttestor(optionsWithDefaults(options));
  let step = iterator.next();
  while (!step.done) {
    reportSynchronousProgress(options.onSynchronousProgress, step.value);
    step = iterator.next();
  }
  return step.value;
}

export async function inspectResearchExecutionReleaseAttestorConfigurationAsync(
  options = {},
) {
  const iterator = inspectReleaseAttestor(optionsWithDefaults(options));
  let step = iterator.next();
  while (!step.done) {
    await reportProgress(options.onProgress, step.value);
    step = iterator.next();
  }
  return step.value;
}
