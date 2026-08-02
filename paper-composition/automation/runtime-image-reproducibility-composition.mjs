import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { inspectRuntimeImageBuildInputClosures } from '../../paper-adapters/automation/runtime-image-build-input-closure.mjs';
import {
  observeLocalDockerRuntimeImageRootfsRepeatability,
} from '../../paper-adapters/automation/docker-runtime-image-bitwise-rebuild-verifier.mjs';
import {
  createRuntimeImageReproducibilityReceiptRepository,
} from '../../paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs';
import {
  invokeRuntimeImageReproducibilityVerifier,
  readRuntimeImageReproducibilityProcessConfiguration,
} from '../../paper-adapters/automation/runtime-image-reproducibility-process-identity.mjs';
import {
  AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS,
  RUNTIME_IMAGE_BUILD_REPRODUCIBILITY,
} from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { runBoundedChildProcess } from '../../paper-adapters/automation/bounded-child-process.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import {
  buildRuntimeImageReproducibilityReceipt,
  buildRuntimeImageReproducibilityRequest,
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  runtimeImageReproducibilityCodeProvenanceHash,
  runtimeImageReproducibilityReceiptExpiresAt,
  runtimeImageReproducibilityReleaseIdentityHash,
  verifyRuntimeImageReproducibilityReceipt,
} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export { createRuntimeImageReproducibilityReceiptRepository };

export const AUTOMATION_RUNTIME_IMAGE_PROFILES =
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES;

export function composeLocalRuntimeImageRootfsRepeatabilityDiagnostic(options = {}) {
  return observeLocalDockerRuntimeImageRootfsRepeatability(options);
}

function observedDate(clock) {
  const value = clock?.now ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('runtime_reproducibility_clock_invalid');
  return date;
}

function configurationInspection(configuration, blockers = []) {
  const boundedReady = Boolean(configuration) && blockers.length === 0;
  const uniqueBlockers = Object.freeze([...new Set([
    ...blockers,
    ...(configuration && configuration.configurationPinned !== true
      ? ['runtime_reproducibility_configuration_not_pinned'] : []),
  ].filter(Boolean))].sort());
  const fullProductionReady = boundedReady
    && configuration.configurationPinned === true
    && uniqueBlockers.length === 0;
  const payload = Object.freeze({
    version: 2,
    kind: 'RuntimeImageReproducibilityConfigurationInspection',
    status: fullProductionReady
      ? 'runtime_image_reproducibility_configuration_ready'
      : uniqueBlockers.length
      ? 'runtime_image_reproducibility_configuration_blocked'
      : 'runtime_image_reproducibility_configuration_bounded',
    ready: fullProductionReady,
    boundedReady,
    fullProductionReady,
    configured: Boolean(configuration),
    configurationPinned: configuration?.configurationPinned === true,
    configurationIdentityHash: configuration?.configurationIdentityHash || null,
    trustIdentityHash: configuration?.trustIdentityHash || null,
    verifierServiceIdentityHashes: configuration
      ? Object.freeze(configuration.verifierTrust.map((item) => item.serviceIdentityHash))
      : Object.freeze([]),
    verifierBackendIdentityHashes: configuration
      ? Object.freeze(configuration.verifierTrust.map((item) => item.backend.backendIdentityHash))
      : Object.freeze([]),
    independentVerifierCount: configuration?.verifierTrust?.length || 0,
    maximumReceiptAgeMs: configuration?.maximumReceiptAgeMs ?? null,
    maximumVerificationCostUsd: configuration?.maximumVerificationCostUsd ?? null,
    verificationCostAuthority: configuration?.verificationCostAuthority || null,
    maximumVerifierTimeoutMs: configuration?.maximumVerifierTimeoutMs ?? null,
    minimumRefreshLeadMs: configuration?.minimumRefreshLeadMs ?? null,
    privateSigningKeyLoaded: false,
    externalVerifierResponseAttestationRequired: true,
    blockers: uniqueBlockers,
  });
  return Object.freeze({
    ...payload,
    runtimeImageReproducibilityConfigurationInspectionHash: hashRecord(
      'RuntimeImageReproducibilityConfigurationInspection',
      payload,
    ),
  });
}

function stableConfigurationBlocker(error) {
  const message = String(error?.message || '');
  return /^runtime_reproducibility_[a-z0-9_:-]{1,240}$/.test(message)
    ? message : 'runtime_reproducibility_configuration_inspection_failed';
}

export function inspectRuntimeImageReproducibilityConfiguration({
  configPath = null,
  environment = process.env,
} = {}) {
  try {
    const configuration = readRuntimeImageReproducibilityProcessConfiguration({
      configPath,
      environment,
    });
    return configurationInspection(configuration);
  } catch (error) {
    return configurationInspection(null, [stableConfigurationBlocker(error)]);
  }
}

function loadContext({
  repositoryRoot,
  configPath,
  environment,
  codeProvenance,
} = {}) {
  const configuration = readRuntimeImageReproducibilityProcessConfiguration({
    configPath,
    environment,
  });
  const inputs = inspectRuntimeImageBuildInputClosures({
    repositoryRoot,
    definitions: AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS,
    profiles: AUTOMATION_RUNTIME_IMAGE_PROFILES,
    platform: configuration.platform,
    buildArgs: configuration.buildArgs,
    sourceDateEpoch: configuration.sourceDateEpoch,
  });
  const provenance = codeProvenance || currentCodeProvenance({ workspaceRoot: repositoryRoot });
  const codeProvenanceHash = runtimeImageReproducibilityCodeProvenanceHash(provenance);
  const releaseIdentityHash = runtimeImageReproducibilityReleaseIdentityHash(provenance);
  return Object.freeze({
    configuration,
    inputs,
    codeProvenanceHash,
    releaseIdentityHash,
    configurationInspection: configurationInspection(configuration),
  });
}

function publicVerifier(configuration, index) {
  return Object.freeze({
    ...configuration.verifierTrust[index],
    signer: configuration.verifierTrust[index].signer,
  });
}

function verifySignature(configuration) {
  return ({ signingPayloadHash, signature, verifier }) => {
    const index = configuration.verifierTrust.findIndex(
      (candidate) => candidate.serviceIdentityHash === verifier?.serviceIdentityHash,
    );
    if (index < 0) return false;
    try {
      return crypto.verify(
        null,
        Buffer.from(signingPayloadHash, 'utf8'),
        configuration.verifiers[index].signer.publicKey,
        Buffer.from(String(signature || ''), 'base64'),
      );
    } catch { return false; }
  };
}

function currentVerificationContext(context, now) {
  return Object.freeze({
    now,
    currentCodeProvenanceHash: context.codeProvenanceHash,
    currentReleaseIdentityHash: context.releaseIdentityHash,
    currentInputs: context.inputs,
    configuration: Object.freeze({
      configurationIdentityHash: context.configuration.configurationIdentityHash,
      trustIdentityHash: context.configuration.trustIdentityHash,
      maximumReceiptAgeMs: context.configuration.maximumReceiptAgeMs,
      verifiers: Object.freeze(context.configuration.verifierTrust.map((_, index) => (
        publicVerifier(context.configuration, index)
      ))),
    }),
    profilePolicies: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY,
    verifySignature: verifySignature(context.configuration),
  });
}

export function composeRuntimeImageReproducibilityRequest({
  repositoryRoot = process.cwd(),
  configPath = null,
  environment = process.env,
  codeProvenance = null,
  clock = null,
  randomUUID = crypto.randomUUID,
} = {}) {
  const context = loadContext({
    repositoryRoot: fs.realpathSync(path.resolve(repositoryRoot)),
    configPath,
    environment,
    codeProvenance,
  });
  if (context.configurationInspection.fullProductionReady !== true) {
    throw new Error(
      context.configurationInspection.blockers[0]
      || 'runtime_reproducibility_configuration_not_ready',
    );
  }
  const requestedAt = observedDate(clock);
  const maximumCommandMs = Math.max(
    ...context.configuration.verifiers.map((item) => item.command.timeoutMs),
  );
  const requestWindowMs = Math.min(
    context.configuration.maximumReceiptAgeMs,
    maximumCommandMs + 60_000,
  );
  const request = buildRuntimeImageReproducibilityRequest({
    nonce: `runtime-repro:${randomUUID()}`,
    requestedAt: requestedAt.toISOString(),
    expiresAt: new Date(requestedAt.getTime() + requestWindowMs).toISOString(),
    configurationIdentityHash: context.configuration.configurationIdentityHash,
    trustIdentityHash: context.configuration.trustIdentityHash,
    codeProvenanceHash: context.codeProvenanceHash,
    releaseIdentityHash: context.releaseIdentityHash,
    inputs: context.inputs,
  });
  return Object.freeze({ context, request });
}

function blockedReport(blockers, configuration = null, inspection = null) {
  return Object.freeze({
    version: 2,
    kind: 'RuntimeImageReproducibilityVerificationReport',
    status: 'runtime_image_reproducibility_blocked',
    ready: false,
    configuration: configuration || configurationInspection(null, blockers),
    inspection,
    receipt: null,
    publication: null,
    externalActionPerformed: false,
    blockers: Object.freeze([...new Set(blockers.filter(Boolean))].sort()),
  });
}

export function composeRuntimeImageReproducibilityStatus({
  runtimeRoot,
  repositoryRoot = process.cwd(),
  receiptPath = null,
  configPath = null,
  environment = process.env,
  now = new Date(),
  codeProvenance = null,
} = {}) {
  let context;
  try {
    context = loadContext({
      repositoryRoot: fs.realpathSync(path.resolve(repositoryRoot)),
      configPath,
      environment,
      codeProvenance,
    });
  } catch (error) {
    return blockedReport([stableConfigurationBlocker(error)]);
  }
  if (context.configurationInspection.fullProductionReady !== true) {
    return blockedReport(
      context.configurationInspection.blockers,
      context.configurationInspection,
    );
  }
  const repository = createRuntimeImageReproducibilityReceiptRepository({
    runtimeRoot,
    receiptPath: receiptPath || environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT || null,
  });
  let stored;
  try { stored = repository.read(); }
  catch (error) {
    return blockedReport([String(error?.message || error)], context.configurationInspection);
  }
  if (!stored) {
    return blockedReport(
      ['runtime_reproducibility_receipt_missing'],
      context.configurationInspection,
    );
  }
  const inspection = verifyRuntimeImageReproducibilityReceipt(
    stored.receipt,
    currentVerificationContext(context, now),
  );
  return Object.freeze({
    version: 2,
    kind: 'RuntimeImageReproducibilityVerificationReport',
    status: inspection.ready
      ? 'runtime_image_reproducibility_verified'
      : 'runtime_image_reproducibility_blocked',
    ready: inspection.ready,
    configuration: context.configurationInspection,
    inspection,
    receipt: null,
    receiptReference: Object.freeze({
      receiptPath: stored.receiptPath,
      receiptContentHash: stored.contentHash,
      receiptHash: stored.receipt.runtimeImageReproducibilityReceiptHash,
    }),
    publication: null,
    externalActionPerformed: false,
    blockers: inspection.blockers,
  });
}

export async function composeRuntimeImageReproducibilityVerification({
  action = 'verify',
  runtimeRoot,
  repositoryRoot = process.cwd(),
  receiptPath = null,
  configPath = null,
  environment = process.env,
  codeProvenance = null,
  clock = null,
  randomUUID = crypto.randomUUID,
  runProcess = runBoundedChildProcess,
  signal = null,
  publicationMutationCoordinator = null,
  publicationOfflineProvision = true,
  requireExternallyFencedPublication = false,
  publicationDatabaseInstanceId = undefined,
  publicationSchemaContractId = undefined,
  publicationWriterId = undefined,
} = {}) {
  if (!['verify', 'publish'].includes(action)) {
    throw new Error(`runtime_reproducibility_action_invalid:${action}`);
  }
  let context = null;
  const publicationRepository = action === 'publish'
    ? createRuntimeImageReproducibilityReceiptRepository({
      runtimeRoot,
      receiptPath: receiptPath || environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT || null,
      receiptVerifier: (candidate, verificationTime) => (
        verifyRuntimeImageReproducibilityReceipt(
          candidate,
          currentVerificationContext(context, verificationTime),
        )
      ),
      mutationCoordinator: publicationMutationCoordinator,
      offlineProvision: publicationOfflineProvision,
      requireExternallyFencedMutations: requireExternallyFencedPublication,
      databaseInstanceId: publicationDatabaseInstanceId,
      schemaContractId: publicationSchemaContractId,
      writerId: publicationWriterId,
    }) : null;
  const generated = composeRuntimeImageReproducibilityRequest({
    repositoryRoot,
    configPath,
    environment,
    codeProvenance,
    clock,
    randomUUID,
  });
  ({ context } = generated);
  const { request } = generated;
  const responses = await Promise.all(context.configuration.verifiers.map((verifier) => (
    invokeRuntimeImageReproducibilityVerifier(verifier.command, request, {
      cwd: fs.realpathSync(path.resolve(repositoryRoot)),
      environment,
      runProcess,
      signal,
    })
  )));
  const issuedAt = observedDate(clock);
  const expiresAt = runtimeImageReproducibilityReceiptExpiresAt({
    issuedAt: issuedAt.toISOString(),
    maximumReceiptAgeMs: context.configuration.maximumReceiptAgeMs,
  });
  const receipt = buildRuntimeImageReproducibilityReceipt({
    request,
    responses,
    issuedAt: issuedAt.toISOString(),
    expiresAt,
  });
  const inspection = verifyRuntimeImageReproducibilityReceipt(
    receipt,
    currentVerificationContext(context, issuedAt),
  );
  let publication = null;
  if (action === 'publish') {
    publication = publicationRepository.publish({ receipt, now: issuedAt });
  }
  return Object.freeze({
    version: 2,
    kind: 'RuntimeImageReproducibilityVerificationReport',
    status: inspection.ready
      ? 'runtime_image_reproducibility_verified'
      : 'runtime_image_reproducibility_blocked',
    ready: inspection.ready,
    configuration: context.configurationInspection,
    inspection,
    receipt: action === 'verify' ? receipt : null,
    publication,
    externalActionPerformed: true,
    blockers: inspection.blockers,
  });
}

export async function composeRuntimeImageReproducibilityReport(options = {}) {
  if ((options.action || 'status') === 'status') {
    return composeRuntimeImageReproducibilityStatus(options);
  }
  return composeRuntimeImageReproducibilityVerification(options);
}
