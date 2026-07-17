import crypto from 'node:crypto';

import {
  inspectExternalResearchQualificationProcessConfiguration,
} from '../../paper-adapters/automation/external-research-qualification-process-adapter.mjs';
import {
  readExternalResearchQualificationProcessConfiguration,
} from '../../paper-adapters/automation/external-research-qualification-process-identity.mjs';
import {
  createFullResearchQualificationReceiptPointerRepository,
} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {
  createAutonomousResearchQualificationStateRepository,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { HEPTA_WORKSPACE_ROOT } from '../../paper-adapters/runtime/workspace-layout.mjs';
import {
  fullResearchQualificationSigningPayloadHash,
  FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  externalQualificationProcessConfigurationInspectionReady,
} from './autonomous-research-readiness-inspections.mjs';
import {
  composeRuntimeImageReproducibilityStatus,
} from './runtime-image-reproducibility-composition.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const REQUIRED_RUNTIME_PROFILES = Object.freeze(['python', 'pythonGpu', 'r']);

function canonicalTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed : null;
}

function qualificationReceiptHashValid(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.version !== 1
    || receipt.kind !== 'FullResearchGoldenMicroCampaignQualificationReceipt'
    || receipt.status !== 'full_research_golden_micro_campaign_qualified'
    || receipt.externalActionPerformed !== true
    || !SHA256.test(String(receipt.fullResearchQualificationReceiptHash || ''))
    || !SHA256.test(String(receipt.runtimeImageReproducibilityReceiptHash || ''))
    || JSON.stringify(receipt.runtimeImageReproducibilityRequiredProfiles)
      !== JSON.stringify(REQUIRED_RUNTIME_PROFILES)
    || JSON.stringify(Object.keys(
      receipt.runtimeImageReproducibilityDefinitionManifestHashes || {},
    )) !== JSON.stringify(REQUIRED_RUNTIME_PROFILES)
    || Object.values(receipt.runtimeImageReproducibilityDefinitionManifestHashes || {})
      .some((value) => !SHA256.test(String(value || '')))) return false;
  const { fullResearchQualificationReceiptHash, ...payload } = receipt;
  return hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', payload)
    === fullResearchQualificationReceiptHash;
}

function codeIdentityMatches(receipt, current) {
  const fields = [
    'version', 'packageVersion', 'commit', 'commitTree', 'treeDirty', 'indexStateHash',
    'repositoryEntryCount', 'repositoryContentHash', 'worktreeStateHash',
  ];
  return receipt?.version === 2 && current?.version === 2
    && fields.every((field) => (receipt[field] ?? null) === (current[field] ?? null));
}

function signerMatches(configuration, receipt, nowMs) {
  const trusted = configuration?.trustedSigner;
  const signer = receipt?.signer;
  const signedAt = canonicalTimestamp(receipt?.issuedAt);
  const effectiveFrom = canonicalTimestamp(trusted?.effectiveFrom);
  const expiresAt = canonicalTimestamp(trusted?.expiresAt);
  return trusted && signer
    && trusted.status === 'active' && trusted.revokedAt === null
    && signer.keyId === trusted.keyId
    && signer.keyVersion === trusted.keyVersion
    && signer.subjectId === trusted.subjectId
    && (signer.organization || null) === (trusted.organization || null)
    && signer.role === trusted.role && signer.algorithm === trusted.algorithm
    && signedAt !== null && effectiveFrom !== null && expiresAt !== null
    && signedAt >= effectiveFrom && signedAt < expiresAt
    && nowMs >= effectiveFrom && nowMs < expiresAt;
}

function qualificationSignatureValid(configuration, receipt) {
  const signingPayloadHash = fullResearchQualificationSigningPayloadHash(receipt);
  if (!SHA256.test(String(signingPayloadHash || ''))
    || typeof receipt?.signature !== 'string' || !receipt.signature
    || !configuration?.publicKey) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(signingPayloadHash, 'utf8'),
      configuration.publicKey,
      Buffer.from(receipt.signature, 'base64'),
    );
  } catch { return false; }
}

export function evaluateAutonomousResearchResidentPrerequisites({
  configurationInspection = null,
  configuration = null,
  qualificationPointer = null,
  qualificationState = null,
  runtimeReproducibilityStatus = null,
  codeProvenance = null,
  now = new Date(),
  inputBlockers = [],
  infrastructureInputBlockers = [],
  globalQualificationInputBlockers = [],
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const infrastructureBlockers = [...inputBlockers, ...infrastructureInputBlockers];
  const globalQualificationBlockers = [...globalQualificationInputBlockers];
  if (!Number.isFinite(nowMs)) {
    infrastructureBlockers.push('autonomous_research_resident_clock_invalid');
  }
  const configurationReady =
    externalQualificationProcessConfigurationInspectionReady(configurationInspection)
    && configuration?.configurationIdentityHash === configurationInspection?.configurationIdentityHash
    && configuration?.trustIdentityHash === configurationInspection?.trustIdentityHash
    && configuration?.maximumQualificationCostUsd
      === configurationInspection?.maximumQualificationCostUsd
    && configuration?.qualificationCostAuthority
      === configurationInspection?.qualificationCostAuthority;
  if (!configurationReady) {
    infrastructureBlockers.push(
      'autonomous_research_external_qualification_v3_configuration_not_ready',
    );
  }
  const receipt = qualificationPointer?.receipt || null;
  if (!qualificationReceiptHashValid(receipt)
    || !SHA256.test(String(qualificationPointer?.qualificationStateHash || ''))
    || !Number.isSafeInteger(Number(qualificationPointer?.qualificationStateGeneration))
    || Number(qualificationPointer?.qualificationStateGeneration) < 1) {
    globalQualificationBlockers.push('autonomous_research_full_qualification_pointer_not_ready');
  }
  const expectedRecoveryConfigurationIdentityHash = hashRecord(
    'AutonomousExternalQualificationRecoveryConfigurationIdentity',
    {
      configurationIdentityHash: configuration?.configurationIdentityHash || null,
      trustIdentityHash: configuration?.trustIdentityHash || null,
      clientServiceIdentityHash: configuration?.clientServiceIdentityHash || null,
      verifierServiceIdentityHash: configuration?.verifierServiceIdentityHash || null,
      maximumQualificationCostUsd: configuration?.maximumQualificationCostUsd ?? null,
      qualificationCostAuthority: configuration?.qualificationCostAuthority || null,
    },
  );
  if (qualificationState?.autonomousExternalQualificationStateHash
      !== qualificationPointer?.qualificationStateHash
    || qualificationState?.generation !== qualificationPointer?.qualificationStateGeneration
    || qualificationState?.campaignId !== receipt?.campaignId
    || qualificationState?.paperId !== receipt?.paperId
    || qualificationState?.campaignReleaseBundleHash
      !== receipt?.campaignReleaseBundleHash
    || qualificationState?.receipt?.fullResearchQualificationReceiptHash
      !== receipt?.fullResearchQualificationReceiptHash
    || qualificationState?.recovery?.status !== 'qualification_verified'
    || qualificationState?.recovery?.configurationIdentityHash
      !== configuration?.configurationIdentityHash
    || qualificationState?.recovery?.trustIdentityHash !== configuration?.trustIdentityHash
    || qualificationState?.recovery?.clientServiceIdentityHash
      !== configuration?.clientServiceIdentityHash
    || qualificationState?.recovery?.verifierServiceIdentityHash
      !== configuration?.verifierServiceIdentityHash
    || qualificationState?.recovery?.recoveryConfigurationIdentityHash
      !== expectedRecoveryConfigurationIdentityHash) {
    globalQualificationBlockers.push(
      'autonomous_research_full_qualification_state_configuration_drift',
    );
  }
  const issuedAt = canonicalTimestamp(receipt?.issuedAt);
  const expiresAt = canonicalTimestamp(receipt?.expiresAt);
  if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt
    || expiresAt - issuedAt > FULL_RESEARCH_QUALIFICATION_MAXIMUM_AGE_MS
    || !Number.isFinite(nowMs) || nowMs < issuedAt || nowMs >= expiresAt) {
    globalQualificationBlockers.push(
      'autonomous_research_full_qualification_receipt_not_current',
    );
  }
  if (!codeIdentityMatches(receipt?.codeProvenance, codeProvenance)) {
    globalQualificationBlockers.push(
      'autonomous_research_full_qualification_code_identity_mismatch',
    );
  }
  if (!signerMatches(configuration, receipt, nowMs)
    || !qualificationSignatureValid(configuration, receipt)) {
    globalQualificationBlockers.push(
      'autonomous_research_full_qualification_signature_or_trust_mismatch',
    );
  }
  const runtimeInspection = runtimeReproducibilityStatus?.inspection;
  const runtimeConfiguration = runtimeReproducibilityStatus?.configuration;
  const runtimeExpiresAt = canonicalTimestamp(runtimeInspection?.expiresAt);
  if (runtimeConfiguration?.ready !== true
    || !SHA256.test(String(runtimeConfiguration?.configurationIdentityHash || ''))
    || !SHA256.test(String(runtimeConfiguration?.trustIdentityHash || ''))
    || !Number.isFinite(Number(runtimeConfiguration?.maximumVerificationCostUsd))
    || Number(runtimeConfiguration?.maximumVerificationCostUsd) < 0
    || typeof runtimeConfiguration?.verificationCostAuthority !== 'string'
    || !runtimeConfiguration.verificationCostAuthority) {
    infrastructureBlockers.push(
      'autonomous_research_runtime_reproducibility_configuration_not_ready',
    );
  }
  if (runtimeReproducibilityStatus?.ready !== true
    || runtimeInspection?.ready !== true || runtimeInspection?.receiptAccepted !== true
    || !SHA256.test(String(runtimeInspection?.receiptHash || ''))
    || runtimeInspection.receiptHash !== receipt?.runtimeImageReproducibilityReceiptHash
    || runtimeExpiresAt === null || !Number.isFinite(nowMs) || nowMs >= runtimeExpiresAt) {
    globalQualificationBlockers.push(
      'autonomous_research_runtime_reproducibility_receipt_not_current',
    );
  }
  if (codeProvenance?.version !== 2
    || !SHA256.test(String(codeProvenance?.worktreeStateHash || ''))) {
    infrastructureBlockers.push('autonomous_research_current_code_identity_unavailable');
  }
  const uniqueInfrastructureBlockers = Object.freeze([
    ...new Set(infrastructureBlockers.filter(
      (value) => typeof value === 'string' && value,
    )),
  ]);
  const uniqueGlobalQualificationBlockers = Object.freeze([
    ...new Set(globalQualificationBlockers.filter(
      (value) => typeof value === 'string' && value,
    )),
  ]);
  const uniqueBlockers = Object.freeze([...new Set([
    ...uniqueInfrastructureBlockers,
    ...uniqueGlobalQualificationBlockers,
  ])]);
  const prerequisiteIdentity = Object.freeze({
    externalQualificationConfigurationInspectionHash: configurationInspection
      ?.externalResearchQualificationProcessConfigurationInspectionHash || null,
    externalQualificationConfigurationIdentityHash:
      configurationInspection?.configurationIdentityHash || null,
    externalQualificationTrustIdentityHash:
      configurationInspection?.trustIdentityHash || null,
    externalQualificationMaximumCostUsd:
      configurationInspection?.maximumQualificationCostUsd ?? null,
    externalQualificationCostAuthority:
      configurationInspection?.qualificationCostAuthority || null,
    runtimeImageReproducibilityConfigurationIdentityHash:
      runtimeReproducibilityStatus?.configuration?.configurationIdentityHash || null,
    runtimeImageReproducibilityTrustIdentityHash:
      runtimeReproducibilityStatus?.configuration?.trustIdentityHash || null,
    codeWorktreeStateHash: codeProvenance?.worktreeStateHash || null,
  });
  const infrastructureReady = uniqueInfrastructureBlockers.length === 0;
  const globalQualificationReady = uniqueGlobalQualificationBlockers.length === 0;
  const operationMode = !infrastructureReady ? 'blocked'
    : globalQualificationReady ? 'full' : 'bootstrap-only';
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentPrerequisiteReceipt',
    status: !infrastructureReady
      ? 'autonomous_research_resident_infrastructure_blocked'
      : globalQualificationReady
        ? 'autonomous_research_resident_prerequisites_ready'
        : 'autonomous_research_resident_bootstrap_only',
    ready: infrastructureReady && globalQualificationReady,
    infrastructureReady,
    globalQualificationReady,
    operationMode,
    inspectedAt: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null,
    ...prerequisiteIdentity,
    autonomousResearchResidentPrerequisiteIdentityHash: hashRecord(
      'AutonomousResearchResidentPrerequisiteIdentity',
      prerequisiteIdentity,
    ),
    zeroCostAuthorityEvidenceScope:
      configurationInspection?.qualificationCostAuthority === 'externally_operated_zero_cost'
        ? 'trusted_operator_assertion_not_external_billing_proof' : null,
    fullResearchQualificationExpiresAt:
      canonicalTimestamp(receipt?.expiresAt) === null ? null : receipt.expiresAt,
    runtimeImageReproducibilityExpiresAt:
      canonicalTimestamp(runtimeInspection?.expiresAt) === null
        ? null : runtimeInspection.expiresAt,
    externalActionPerformed: false,
    networkActionPerformed: false,
    providerCanaryPerformed: false,
    releaseSignerChallengePerformed: false,
    infrastructureBlockers: uniqueInfrastructureBlockers,
    globalQualificationBlockers: uniqueGlobalQualificationBlockers,
    blockers: uniqueBlockers,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchResidentPrerequisiteReceiptHash: hashRecord(
      'AutonomousResearchResidentPrerequisiteReceipt',
      payload,
    ),
  });
}

export function inspectAutonomousResearchResidentPrerequisites({
  runtimeRoot,
  repositoryRoot = HEPTA_WORKSPACE_ROOT,
  environment = process.env,
  externalQualificationConfigPath = null,
  now = new Date(),
} = {}) {
  if (!runtimeRoot) {
    throw new Error('autonomous_research_resident_prerequisite_runtime_root_required');
  }
  const infrastructureInputBlockers = [];
  const globalQualificationInputBlockers = [];
  const configurationInspection =
    inspectExternalResearchQualificationProcessConfiguration({
      configPath: externalQualificationConfigPath,
      environment,
    });
  let configuration = null;
  try {
    configuration = readExternalResearchQualificationProcessConfiguration({
      configPath: externalQualificationConfigPath,
      environment,
    });
  } catch (error) {
    infrastructureInputBlockers.push(String(error?.message
      || 'external_qualification_configuration_inspection_failed'));
  }
  let qualificationPointer = null;
  try {
    qualificationPointer = createFullResearchQualificationReceiptPointerRepository({
      runtimeRoot,
    }).read();
  } catch (error) {
    globalQualificationInputBlockers.push(String(error?.message
      || 'full_research_qualification_pointer_inspection_failed'));
  }
  let qualificationState = null;
  if (qualificationPointer?.receipt?.paperId) {
    let stateRepository = null;
    try {
      stateRepository = createAutonomousResearchQualificationStateRepository({
        runtimeRoot,
        paperId: qualificationPointer.receipt.paperId,
        create: false,
      });
      qualificationState = stateRepository.readExternalQualificationState();
    } catch (error) {
      globalQualificationInputBlockers.push(String(error?.message
        || 'autonomous_research_qualification_state_inspection_failed'));
    } finally { stateRepository?.close(); }
  }
  let runtimeReproducibilityStatus = null;
  try {
    runtimeReproducibilityStatus = composeRuntimeImageReproducibilityStatus({
      runtimeRoot,
      repositoryRoot,
      environment,
      now,
    });
  } catch (error) {
    infrastructureInputBlockers.push(String(error?.message
      || 'runtime_reproducibility_status_inspection_failed'));
  }
  let codeProvenance = null;
  try { codeProvenance = currentCodeProvenance({ workspaceRoot: repositoryRoot }); }
  catch {
    infrastructureInputBlockers.push('autonomous_research_current_code_identity_unavailable');
  }
  return evaluateAutonomousResearchResidentPrerequisites({
    configurationInspection,
    configuration,
    qualificationPointer,
    qualificationState,
    runtimeReproducibilityStatus,
    codeProvenance,
    now,
    infrastructureInputBlockers,
    globalQualificationInputBlockers,
  });
}
