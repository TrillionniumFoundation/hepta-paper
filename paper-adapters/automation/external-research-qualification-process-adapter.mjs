import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyFullResearchQualificationReceiptEnvelope,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import {
  campaignReleaseExecutionAttestationSigningPayloadHash,
  verifyCampaignReleaseExecutionAttestationStructure,
} from '../../paper-domain/automation/campaign-release-execution-attestation-contract.mjs';
import { EXTERNAL_QUALIFICATION_FAILURE_CODES as FAILURE } from '../../paper-domain/automation/external-research-qualification-failure-policy.mjs';
import { runBoundedChildProcess } from './bounded-child-process.mjs';
import {
  invokeExternalResearchQualificationProcess,
  readExternalResearchQualificationProcessConfiguration,
} from './external-research-qualification-process-identity.mjs';
import {
  canonicalExternalQualificationTimestamp as canonicalTimestamp,
  verifyExternalQualificationReleaseSignerAuthority,
} from './external-qualification-release-signer-authority.mjs';
import {
  verifyExternalResearchQualificationLocally,
} from './external-research-qualification-local-verifier.mjs';

export { verifyExternalQualificationReleaseSignerAuthority };

function envelopeFailureCodes(blockers) {
  const mapping = new Map([
    ['external_qualification_verification_time_invalid', FAILURE.VERIFICATION_TIME_INVALID],
    ['external_qualification_receipt_shape_invalid', FAILURE.RECEIPT_SHAPE_INVALID],
    ['external_qualification_receipt_hash_invalid', FAILURE.RECEIPT_HASH_INVALID],
    ['external_qualification_receipt_outside_time_window', FAILURE.RECEIPT_TIME_WINDOW_INVALID],
    ['external_qualification_current_release_pointer_mismatch', FAILURE.RELEASE_POINTER_MISMATCH],
    ['external_qualification_autonomous_preparation_binding_mismatch', FAILURE.PREPARATION_BINDING_MISMATCH],
    ['external_qualification_independent_hypothesis_prior_art_qualification_invalid',
      FAILURE.PRIOR_ART_QUALIFICATION_INVALID],
    ['external_qualification_runtime_image_reproducibility_binding_invalid', FAILURE.RUNTIME_REPRODUCIBILITY_BINDING_INVALID],
    ['external_qualification_signature_invalid', FAILURE.RECEIPT_SIGNATURE_INVALID],
  ]);
  return [...new Set((blockers || []).map((blocker) => mapping.get(blocker)).filter(Boolean))];
}
function publicKeySpkiHash(publicKey) {
  return hashBytes(publicKey.export({ type: 'spki', format: 'der' }));
}
function commandInspectionHash(command) {
  return hashRecord('ExternalResearchQualificationProcessCommandInspection', {
    serviceId: command?.serviceId || null,
    principalId: command?.principalId || null,
    commandIdentityHash: command?.commandIdentityHash || null,
    executableContentHash: command?.executableContentHash || null,
    credentialRootIdentityHash: command?.credentialRootIdentityHash || null,
    credentialRootContentsIdentityHash: command?.credentialRootContentsIdentityHash || null,
    childEnvironmentIdentityHash: command?.childEnvironmentIdentityHash || null,
    interpreterIdentityHash: command?.interpreterIdentityHash || null,
    credentialUid: command?.credentialUid ?? null,
  });
}

function configurationInspectionPayload(configuration, blockers = []) {
  const ready = Boolean(configuration) && blockers.length === 0;
  return {
    version: 1,
    kind: 'ExternalResearchQualificationProcessConfigurationInspection',
    status: ready
      ? 'external_research_qualification_process_configuration_ready'
      : 'external_research_qualification_process_configuration_blocked',
    ready,
    qualifierServiceId: configuration?.qualifier?.serviceId || null,
    verifierServiceId: configuration?.verifier?.serviceId || null,
    qualifierPrincipalId: configuration?.qualifier?.principalId || null,
    verifierPrincipalId: configuration?.verifier?.principalId || null,
    qualifierCommandIdentityHash: configuration?.qualifier?.commandIdentityHash || null,
    verifierCommandIdentityHash: configuration?.verifier?.commandIdentityHash || null,
    qualifierCommandInspectionHash: configuration
      ? commandInspectionHash(configuration.qualifier) : null,
    verifierCommandInspectionHash: configuration
      ? commandInspectionHash(configuration.verifier) : null,
    qualifierExecutableContentHash: configuration?.qualifier?.executableContentHash || null,
    verifierExecutableContentHash: configuration?.verifier?.executableContentHash || null,
    qualifierCredentialRootIdentityHash:
      configuration?.qualifier?.credentialRootIdentityHash || null,
    verifierCredentialRootIdentityHash:
      configuration?.verifier?.credentialRootIdentityHash || null,
    qualifierCredentialRootContentsIdentityHash:
      configuration?.qualifier?.credentialRootContentsIdentityHash || null,
    verifierCredentialRootContentsIdentityHash:
      configuration?.verifier?.credentialRootContentsIdentityHash || null,
    qualifierChildEnvironmentIdentityHash:
      configuration?.qualifier?.childEnvironmentIdentityHash || null,
    verifierChildEnvironmentIdentityHash:
      configuration?.verifier?.childEnvironmentIdentityHash || null,
    qualifierInterpreterIdentityHash:
      configuration?.qualifier?.interpreterIdentityHash || null,
    verifierInterpreterIdentityHash:
      configuration?.verifier?.interpreterIdentityHash || null,
    qualifierCredentialUid: configuration?.qualifier?.credentialUid ?? null,
    verifierCredentialUid: configuration?.verifier?.credentialUid ?? null,
    maximumQualificationCostUsd: configuration?.maximumQualificationCostUsd ?? null,
    qualificationCostAuthority: configuration?.qualificationCostAuthority || null,
    configurationIdentityHash: configuration?.configurationIdentityHash || null,
    trustIdentityHash: configuration?.trustIdentityHash || null,
    clientServiceIdentityHash: configuration?.clientServiceIdentityHash || null,
    verifierServiceIdentityHash: configuration?.verifierServiceIdentityHash || null,
    independentVerifierConfigured: ready,
    independentVerifierResponseAttestationRequired: true,
    trustedSignerTrustSetVersion: configuration?.trustedSignerTrustSetVersion || null,
    trustedSignerTrustSetHash: configuration?.trustedSignerTrustSetHash || null,
    trustedSigners: configuration?.trustedSigners || Object.freeze([]),
    trustedSignerKeyId: configuration?.trustedSigner?.keyId || null,
    trustedSignerKeyVersion: configuration?.trustedSigner?.keyVersion || null,
    trustedSignerSubjectId: configuration?.trustedSigner?.subjectId || null,
    trustedSignerOrganization: configuration?.trustedSigner?.organization || null,
    trustedSignerRole: configuration?.trustedSigner?.role || null,
    trustedSignerAlgorithm: configuration?.trustedSigner?.algorithm || null,
    trustedSignerStatus: configuration?.trustedSigner?.status || null,
    trustedSignerEffectiveFrom: configuration?.trustedSigner?.effectiveFrom || null,
    trustedSignerExpiresAt: configuration?.trustedSigner?.expiresAt || null,
    trustedSignerRevokedAt: configuration?.trustedSigner?.revokedAt ?? null,
    trustedSignerPublicKeySpkiHash: configuration
      ? publicKeySpkiHash(configuration.publicKey) : null,
    verifierAttestorKeyId: configuration?.verifierAttestor?.keyId || null,
    verifierAttestorKeyVersion: configuration?.verifierAttestor?.keyVersion || null,
    verifierAttestorSubjectId: configuration?.verifierAttestor?.subjectId || null,
    verifierAttestorOrganization: configuration?.verifierAttestor?.organization || null,
    verifierAttestorRole: configuration?.verifierAttestor?.role || null,
    verifierAttestorAlgorithm: configuration?.verifierAttestor?.algorithm || null,
    verifierAttestorStatus: configuration?.verifierAttestor?.status || null,
    verifierAttestorEffectiveFrom: configuration?.verifierAttestor?.effectiveFrom || null,
    verifierAttestorExpiresAt: configuration?.verifierAttestor?.expiresAt || null,
    verifierAttestorRevokedAt: configuration?.verifierAttestor?.revokedAt ?? null,
    verifierAttestorPublicKeySpkiHash: configuration
      ? publicKeySpkiHash(configuration.verifierPublicKey) : null,
    privateSigningKeyLoaded: false,
    blockers: Object.freeze([...new Set(blockers.filter(Boolean))]),
  };
}

function finalizeConfigurationInspection(payload) {
  return Object.freeze({
    ...payload,
    externalResearchQualificationProcessConfigurationInspectionHash: hashRecord(
      'ExternalResearchQualificationProcessConfigurationInspection',
      payload,
    ),
  });
}

function stableConfigurationInspectionBlocker(error) {
  const candidate = String(error?.message || '');
  return /^external_qualification_[a-z0-9_:-]{1,240}$/.test(candidate)
    ? candidate
    : 'external_qualification_configuration_inspection_failed';
}

function loadConfigurationAndInspection({ configPath, environment }) {
  try {
    const configuration = readExternalResearchQualificationProcessConfiguration({
      configPath,
      environment,
    });
    return Object.freeze({
      configuration,
      inspection: finalizeConfigurationInspection(
        configurationInspectionPayload(configuration),
      ),
      error: null,
    });
  } catch (error) {
    const blocker = stableConfigurationInspectionBlocker(error);
    return Object.freeze({
      configuration: null,
      inspection: finalizeConfigurationInspection(
        configurationInspectionPayload(null, [blocker]),
      ),
      error,
    });
  }
}

export function inspectExternalResearchQualificationProcessConfiguration({
  configPath = null,
  environment = process.env,
} = {}) {
  return loadConfigurationAndInspection({ configPath, environment }).inspection;
}

function blockedInspection(
  blockers,
  envelope = null,
  verifierId = null,
  failureCodes = [],
  configuration = null,
) {
  return Object.freeze({
    version: 1,
    kind: 'FullResearchQualificationInspection',
    status: 'full_research_qualification_blocked',
    ready: false,
    receiptAccepted: false,
    campaignId: null,
    paperId: null,
    campaignReleaseBundleHash: null,
    qualificationReceiptHash: null,
    qualificationSignatureVerified: envelope?.signatureVerified === true,
    qualificationTimeWindowVerified: envelope?.timeWindowVerified === true,
    releasePointerVerified: envelope?.releasePointerVerified === true,
    independentVerifierVerified: false,
    externalVerifierId: verifierId,
    externalVerificationRequestHash: null,
    configurationIdentityHash: configuration?.configurationIdentityHash || null,
    trustIdentityHash: configuration?.trustIdentityHash || null,
    clientServiceIdentityHash: configuration?.clientServiceIdentityHash || null,
    verifierServiceIdentityHash: configuration?.verifierServiceIdentityHash || null,
    failureCodes: Object.freeze([...new Set(failureCodes.filter(Boolean))]),
    blockers: Object.freeze([...new Set(blockers.filter(Boolean))]),
  });
}

function matchingTrustedSigner({ signer, signedAt, verificationTime },
  configuration) {
  const signedAtMs = canonicalTimestamp(signedAt);
  const verificationMs = verificationTime instanceof Date
    ? verificationTime.getTime() : canonicalTimestamp(verificationTime);
  if (signedAtMs === null || !Number.isFinite(verificationMs)) return null;
  return configuration.trustedSignerKeys.find((candidate) => {
    const trusted = candidate.signer;
    const effectiveFrom = Date.parse(trusted.effectiveFrom);
    const expiresAt = Date.parse(trusted.expiresAt);
    const revokedAt = trusted.revokedAt === null
      ? Number.POSITIVE_INFINITY : Date.parse(trusted.revokedAt);
    return signer?.keyId === trusted.keyId && signer?.keyVersion === trusted.keyVersion
      && signer?.subjectId === trusted.subjectId
      && (signer?.organization || null) === trusted.organization
      && signer?.role === trusted.role && signer?.algorithm === trusted.algorithm
      && ['active', 'retiring'].includes(trusted.status)
      && signedAtMs >= effectiveFrom && signedAtMs < expiresAt && signedAtMs < revokedAt
      && verificationMs >= effectiveFrom && verificationMs < expiresAt
      && verificationMs < revokedAt;
  }) || null;
}

function verifyDetachedSignature({ signingPayloadHash, signature, signer, signedAt },
  configuration, verificationTime) {
  const trusted = matchingTrustedSigner({
    signer, signedAt, verificationTime,
  }, configuration);
  if (!trusted || typeof signature !== 'string' || !signature) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(signingPayloadHash, 'utf8'),
      trusted.publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch { return false; }
}

function verifyReleaseAttestation(input, configuration, verificationTime) {
  const { attestation, manifest, manifestFileHash } = input || {};
  const structure = verifyCampaignReleaseExecutionAttestationStructure(attestation, {
    manifest,
    researchEvidenceCapsuleManifestHash: manifest?.researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash: manifestFileHash,
  });
  const trusted = matchingTrustedSigner({
    signer: attestation,
    signedAt: attestation?.signedAt,
    verificationTime,
  }, configuration);
  if (!structure.valid || !trusted) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(campaignReleaseExecutionAttestationSigningPayloadHash(attestation), 'utf8'),
      trusted.publicKey,
      Buffer.from(String(attestation.signature || ''), 'base64'),
    );
  } catch { return false; }
}

function externalVerifierResponseAttested(response, configuration) {
  if (!response || typeof response !== 'object') return false;
  const {
    signature,
    responseHash,
    ...payload
  } = response;
  const signer = response.signer;
  const trusted = configuration.verifierAttestor;
  if (signer?.keyId !== trusted.keyId || signer?.subjectId !== trusted.subjectId
    || signer?.keyVersion !== trusted.keyVersion
    || (signer?.organization || null) !== trusted.organization
    || signer?.role !== trusted.role || signer?.algorithm !== trusted.algorithm
    || hashRecord('IndependentExternalResearchQualificationVerificationResponse', payload)
      !== responseHash) return false;
  const signingPayloadHash = hashRecord(
    'IndependentExternalResearchQualificationVerificationResponseSigningPayload',
    payload,
  );
  try {
    return crypto.verify(
      null,
      Buffer.from(signingPayloadHash, 'utf8'),
      configuration.verifierPublicKey,
      Buffer.from(String(signature || ''), 'base64'),
    );
  } catch { return false; }
}

export function createExternalResearchQualificationProcessAdapter({
  configPath = null,
  cwd = process.cwd(),
  environment = process.env,
  clock = null,
  runProcess = runBoundedChildProcess,
  fullVerificationContextProvider = null,
} = {}) {
  const loaded = loadConfigurationAndInspection({
    configPath,
    environment,
  });
  if (loaded.error) throw loaded.error;
  const { configuration, inspection } = loaded;
  const workingDirectory = fs.realpathSync(path.resolve(cwd));
  const now = () => {
    const observed = clock?.now ? clock.now() : new Date();
    return observed instanceof Date ? observed : new Date(observed);
  };
  const freshlyIssuedReceipts = new WeakSet();
  const client = Object.freeze({
    version: 1,
    kind: 'ExternalResearchQualificationClient',
    configurationIdentityHash: configuration.configurationIdentityHash,
    trustIdentityHash: configuration.trustIdentityHash,
    serviceIdentityHash: configuration.clientServiceIdentityHash,
    maximumQualificationCostUsd: configuration.maximumQualificationCostUsd,
    qualificationCostAuthority: configuration.qualificationCostAuthority,
    abortable: true,
    async requestQualification(request, { signal = null, timeoutMs = null } = {}) {
      const payload = Object.freeze({
        version: 1,
        kind: 'ExternalResearchQualificationRequest',
        serviceId: configuration.qualifier.serviceId,
        request,
      });
      const requestHash = hashRecord('ExternalResearchQualificationRequest', payload);
      const response = await invokeExternalResearchQualificationProcess(
        configuration.qualifier,
        { ...payload, requestHash }, {
        cwd: workingDirectory, environment, runProcess, signal, timeoutMs,
        },
      );
      if (response?.version !== 1 || response?.kind !== 'ExternalResearchQualificationResponse'
        || response?.serviceId !== configuration.qualifier.serviceId
        || response?.requestHash !== requestHash
        || !response?.receipt || typeof response.receipt !== 'object') {
        throw new Error('external_qualification_response_binding_invalid');
      }
      freshlyIssuedReceipts.add(response.receipt);
      return response.receipt;
    },
  });
  const verifyLocallyAfterIndependentVerification = (input = {}) => (
    verifyExternalResearchQualificationLocally({
      ...input,
      observedAt: input.observedAt || now(),
      configuration,
      fullVerificationContextProvider,
      freshlyIssuedReceipts,
      now,
      blockedInspection,
      envelopeFailureCodes,
      verifyDetachedSignature,
      verifyReleaseAttestation,
    })
  );
  const verifier = Object.freeze({
    version: 1,
    kind: 'IndependentExternalResearchQualificationVerifier',
    configurationIdentityHash: configuration.configurationIdentityHash,
    trustIdentityHash: configuration.trustIdentityHash,
    serviceIdentityHash: configuration.verifierServiceIdentityHash,
    maximumQualificationCostUsd: configuration.maximumQualificationCostUsd,
    qualificationCostAuthority: configuration.qualificationCostAuthority,
    abortable: true,
    async verifyLocally({
      receipt,
      campaignReleaseAuthority,
      preparation,
      independentInspection,
    } = {}, { onSynchronousProgress = null } = {}) {
      return verifyLocallyAfterIndependentVerification({
        receipt,
        campaignReleaseAuthority,
        preparation,
        independentInspection,
        observedAt: now(),
        onSynchronousProgress,
      });
    },
    async verify({ receipt, campaignReleaseAuthority, preparation } = {}, {
      signal = null, timeoutMs = null, onSynchronousProgress = null,
    } = {}) {
      const observedAt = now();
      const envelope = verifyFullResearchQualificationReceiptEnvelope(receipt, {
        now: observedAt,
        campaignReleaseAuthority,
        expectedPaperId: preparation?.proposal?.paperId || null,
        expectedProposalHash:
          preparation?.proposal?.machineProposedScientificClaimSetHash || null,
        expectedPolicyAuthorizationHash:
          preparation?.policyAuthorization?.autonomousResearchPolicyAuthorizationHash || null,
        expectedSeedBindingHash:
          preparation?.seedBinding?.autonomousResearchSeedBindingHash || null,
        verifyQualificationSignature: (input) => verifyDetachedSignature(
          input, configuration, observedAt,
        ),
      });
      if (!envelope.ready) {
        return blockedInspection(
          envelope.blockers,
          envelope,
          configuration.verifier.serviceId,
          envelopeFailureCodes(envelope.blockers),
          configuration,
        );
      }
      const requestPayload = Object.freeze({
        version: 1,
        kind: 'IndependentExternalResearchQualificationVerificationRequest',
        verifierId: configuration.verifier.serviceId,
        verifiedAt: observedAt.toISOString(),
        receipt,
        campaignReleaseAuthority,
        expectedBindings: Object.freeze({
          paperId: preparation?.proposal?.paperId || null,
          proposalHash: preparation?.proposal?.machineProposedScientificClaimSetHash || null,
          policyAuthorizationHash:
            preparation?.policyAuthorization?.autonomousResearchPolicyAuthorizationHash || null,
          seedBindingHash: preparation?.seedBinding?.autonomousResearchSeedBindingHash || null,
        }),
      });
      const requestHash = hashRecord(
        'IndependentExternalResearchQualificationVerificationRequest',
        requestPayload,
      );
      let response;
      try {
        response = await invokeExternalResearchQualificationProcess(
          configuration.verifier,
          { ...requestPayload, requestHash }, {
          cwd: workingDirectory, environment, runProcess, signal, timeoutMs,
          },
        );
      } catch (error) {
        return blockedInspection([
          `external_qualification_independent_verifier_unavailable:${error?.message || 'unknown'}`,
        ], envelope, configuration.verifier.serviceId, [
          FAILURE.INDEPENDENT_VERIFIER_UNAVAILABLE,
        ], configuration);
      }
      const external = response?.inspection;
      const responseAttested = externalVerifierResponseAttested(response, configuration);
      const responseBound = response?.version === 1
        && response?.kind === 'IndependentExternalResearchQualificationVerificationResponse'
        && response?.verifierId === configuration.verifier.serviceId
        && response?.requestHash === requestHash
        && external?.kind === 'FullResearchQualificationInspection'
        && external?.status === 'full_research_qualification_verified'
        && external?.ready === true && external?.receiptAccepted === true
        && external?.campaignId === envelope.campaignId
        && external?.paperId === envelope.paperId
        && external?.campaignReleaseBundleHash === envelope.campaignReleaseBundleHash
        && external?.qualificationReceiptHash === envelope.qualificationReceiptHash
        && external?.runtimeImageReproducibilityReceiptHash === envelope.runtimeImageReproducibilityReceiptHash
        && JSON.stringify(external?.runtimeImageReproducibilityRequiredProfiles)
          === JSON.stringify(envelope.runtimeImageReproducibilityRequiredProfiles)
        && JSON.stringify(external?.runtimeImageReproducibilityDefinitionManifestHashes) === JSON.stringify(envelope.runtimeImageReproducibilityDefinitionManifestHashes)
        && external?.proposalHash === requestPayload.expectedBindings.proposalHash
        && external?.policyAuthorizationHash
          === requestPayload.expectedBindings.policyAuthorizationHash
        && external?.seedBindingHash === requestPayload.expectedBindings.seedBindingHash;
      const priorArtVerified = external?.independentHypothesisPriorArtReviewVerified === true
        && /^sha256:[0-9a-f]{64}$/i.test(String(
          external?.independentHypothesisPriorArtReceiptHash || '',
        ))
        && external.independentHypothesisPriorArtReceiptHash
          === receipt?.independentHypothesisPriorArtReceiptHash;
      if (!responseAttested || !responseBound || !priorArtVerified) {
        const failureCodes = [];
        if (!responseAttested) {
          failureCodes.push(FAILURE.INDEPENDENT_VERIFIER_ATTESTATION_INVALID);
        } else if (!responseBound) {
          failureCodes.push(FAILURE.INDEPENDENT_VERIFICATION_BINDING_INVALID);
        }
        if (responseAttested && responseBound && !priorArtVerified) {
          failureCodes.push(FAILURE.PRIOR_ART_QUALIFICATION_INVALID);
        }
        return blockedInspection([
          ...(Array.isArray(external?.blockers) ? external.blockers : []),
          'external_qualification_independent_verification_failed',
        ], envelope, configuration.verifier.serviceId, failureCodes, configuration);
      }
      return verifyLocallyAfterIndependentVerification({
        receipt,
        campaignReleaseAuthority,
        preparation,
        observedAt,
        independentInspection: Object.freeze({
          ...external,
          independentVerifierVerified: true,
          externalVerifierId: configuration.verifier.serviceId,
          externalVerificationRequestHash: requestHash,
          configurationIdentityHash: configuration.configurationIdentityHash,
          trustIdentityHash: configuration.trustIdentityHash,
          clientServiceIdentityHash: configuration.clientServiceIdentityHash,
          verifierServiceIdentityHash: configuration.verifierServiceIdentityHash,
        }),
        onSynchronousProgress,
      });
    },
  });
  return Object.freeze({ inspection, client, verifier });
}
