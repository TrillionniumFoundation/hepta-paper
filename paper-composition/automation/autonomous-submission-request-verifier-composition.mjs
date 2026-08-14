import {
  createAutonomousSubmissionRequestVerifier,
} from '../../paper-domain/automation/autonomous-submission-contract.mjs';
import {
  verifyFullResearchQualificationReceiptEnvelope,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import {
  externalResearchQualificationPreparationBindingFromReleaseAuthority,
} from '../../paper-domain/automation/external-research-qualification-verification-evidence-contract.mjs';
import {
  createAutonomousResearchQualificationStateRepository,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {
  readExternalResearchQualificationProcessConfiguration,
} from '../../paper-adapters/automation/external-research-qualification-process-identity.mjs';
import {
  verifyIndependentExternalResearchQualificationVerificationEvidence,
} from '../../paper-adapters/automation/external-research-qualification-verifier-attestation.mjs';
import {
  createFullResearchQualificationReceiptPointerRepository,
} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {
  createLocalAutonomousVenueComplianceInspector,
} from '../../paper-adapters/automation/local-autonomous-venue-compliance-inspector.mjs';
import {
  createResearchExecutionReleaseAttestor,
} from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import {
  readConfiguredAutonomousSubmissionPortalDescriptorConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-portal-descriptor-reader.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  readAutonomousVenueProfileRegistry,
} from '../../paper-adapters/automation/autonomous-venue-profile-registry-reader.mjs';
import {
  readAutonomousSubmissionMetadataProfile,
} from '../../paper-adapters/automation/autonomous-submission-metadata-profile-reader.mjs';
import {
  verifyAutonomousVenueProfileSelection,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  verifyAutonomousSubmissionMetadataReceipt,
} from '../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';
import {
  bootstrapSubmissionHandoffContext,
} from '../bootstrap/submission-handoff-context-bootstrap.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousLiveSubmissionAuthorizationReceiptAuthority,
} from '../../paper-adapters/automation/autonomous-live-submission-authorization-verifier.mjs';
import {
  readCurrentLiveAuthorizationTrustStore,
} from './autonomous-submission-live-authorization-trust-store.mjs';
import {
  createPinnedAutonomousSubmissionGpuScientificAuthorityVerifier,
} from './autonomous-submission-gpu-scientific-authority-verifier.mjs';

function observedNow(clock) {
  const value = typeof clock?.now === 'function' ? clock.now() : new Date();
  const now = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(now.getTime())) {
    throw new Error('autonomous_submission_request_verifier_clock_invalid');
  }
  return now;
}

function sameRecord(left, right) {
  try {
    return hashRecord('AutonomousSubmissionTrustedSnapshot', left)
      === hashRecord('AutonomousSubmissionTrustedSnapshot', right);
  } catch { return false; }
}

function currentRelease({ root, runtimeRoot, campaignId, clock, environment }) {
  const context = bootstrapSubmissionHandoffContext({
    root,
    runtimeRoot,
    environment,
    serviceOverrides: { clock },
  });
  try {
    return context.services.campaignReleaseQuery.getCurrentRelease({ campaignId });
  } finally {
    context.services.persistenceSession.close();
  }
}

function releaseAuthoritySignatureValid(authority, releaseAttestor) {
  const bundle = authority?.releaseBundle || null;
  return releaseAttestor.verifyAttestation({
    attestation: bundle?.researchExecutionReleaseAttestation || null,
    manifest: bundle?.researchEvidenceCapsuleManifest || null,
    manifestFileHash:
      bundle?.packageOutput?.researchEvidenceCapsuleManifestFileHash || null,
  }) === true;
}

export function composePinnedAutonomousSubmissionRequestVerifier({
  root,
  runtimeRoot,
  clock = null,
  environment = process.env,
  allowPortalCredential = false,
} = {}) {
  if (!root || !runtimeRoot) {
    throw new Error('autonomous_submission_request_verifier_scope_required');
  }
  const verifierClock = clock?.now
    ? clock
    : Object.freeze({ now: () => new Date() });
  const releaseAttestor = createResearchExecutionReleaseAttestor({
    runtimeRoot,
    clock: verifierClock,
    environment,
  });
  const verifyQualificationSignature = (input) =>
    releaseAttestor.verifyDetachedSignature(input);
  const gpuScientificPromotionAuthorityVerifier =
    createPinnedAutonomousSubmissionGpuScientificAuthorityVerifier({
      runtimeRoot,
      environment,
      clock: verifierClock,
    });
  const verifyIndependentQualificationEvidence = ({
    evidence,
    receipt,
    campaignReleaseAuthority,
  } = {}) => {
    try {
      const configuration =
        readExternalResearchQualificationProcessConfiguration({
          configPath:
            environment.HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG || null,
          environment,
        });
      const preparation =
        externalResearchQualificationPreparationBindingFromReleaseAuthority(
          campaignReleaseAuthority,
        );
      return verifyIndependentExternalResearchQualificationVerificationEvidence(
        evidence,
        {
          receipt,
          campaignReleaseAuthority,
          preparation,
          configuration,
          verificationTime: observedNow(verifierClock),
        },
      ).valid === true;
    } catch {
      return false;
    }
  };
  const venueComplianceInspector = createLocalAutonomousVenueComplianceInspector({
    runtimeRoot,
  });
  const trustedPortalConfiguration =
    readConfiguredAutonomousSubmissionPortalDescriptorConfiguration({
      environment,
      allowPrivateConfigurationFallback: allowPortalCredential,
      rejectPortalCredential: !allowPortalCredential,
    });
  const trustedPortalConfigurationHash =
    trustedPortalConfiguration?.configurationHash || null;
  const venueConfigurationPath = String(
    environment.HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG || '',
  ).trim();
  const venueConfigurationHash = String(
    environment.HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH || '',
  ).trim();
  const metadataConfigurationPath = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG || '',
  ).trim();
  const metadataConfigurationHash = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH || '',
  ).trim();
  const trustedVenue = venueConfigurationPath && venueConfigurationHash
    ? readAutonomousVenueProfileRegistry({
      configPath: venueConfigurationPath,
      expectedConfigurationHash: venueConfigurationHash,
      now: observedNow(verifierClock),
    }) : null;
  const trustedMetadata = metadataConfigurationPath && metadataConfigurationHash
    ? readAutonomousSubmissionMetadataProfile({
      configPath: metadataConfigurationPath,
      expectedConfigurationHash: metadataConfigurationHash,
      now: observedNow(verifierClock),
    }) : null;

  return createAutonomousSubmissionRequestVerifier({
    requireResearchClosure: true,
    requireHumanAuthorization: true,
    verifyQualificationSignature,
    verifyIndependentQualificationEvidence,
    gpuScientificPromotionAuthorityVerifier,
    gpuScientificAuthorityVerificationTimeProvider: () =>
      observedNow(verifierClock),
    verifyHumanAuthorization({ receipt, expectedSubject, observedAt } = {}) {
      if (receipt?.authorizationSubjectHash
          !== expectedSubject?.liveSubmissionAuthorizationSubjectHash) return false;
      return verifyAutonomousLiveSubmissionAuthorizationReceiptAuthority({
        document: receipt?.authorizationDocument,
        receipt,
        trustStore: readCurrentLiveAuthorizationTrustStore(runtimeRoot),
        observedAt,
      });
    },
    verifyPortalConfigurationAuthority({ portalConfigurationHash, request } = {}) {
      return trustedPortalConfigurationHash !== null
        && portalConfigurationHash === trustedPortalConfigurationHash
        && (request?.version !== 7 || (
          request?.portalId === trustedPortalConfiguration.portalId
          && request?.portalDescriptorHash
            === autonomousSubmissionPortalPublicDescriptorHash(
              trustedPortalConfiguration,
            )
          && request?.portalServiceIdentityHash
            === trustedPortalConfiguration.serviceIdentityHash
          && request?.portalAccountIdentityHash
            === trustedPortalConfiguration.portalAccountIdentityHash
          && request?.portalTrustDomainIdentityHash
            === trustedPortalConfiguration.portalTrustDomainIdentityHash
        ))
        && trustedVenue?.configurationPinned === true
        && trustedMetadata?.configurationPinned === true
        && request?.venueAuthorityConfigurationHash === trustedVenue.configurationHash
        && request?.submissionMetadataAuthorityConfigurationHash
          === trustedMetadata.configurationHash
        && request?.venueProfileSelection?.registryHash
          === trustedVenue.registry.autonomousVenueProfileRegistryHash
        && request?.venueProfileSelection?.submissionMetadataProfileHash
          === trustedMetadata.profile.profileHash
        && verifyAutonomousVenueProfileSelection(request?.venueProfileSelection, {
          registry: trustedVenue.registry,
          authorityObservedAt: observedNow(verifierClock).toISOString(),
          expectedVenueAuthorityConfigurationHash: trustedVenue.configurationHash,
          expectedSubmissionMetadataAuthorityConfigurationHash:
            trustedMetadata.configurationHash,
        })
        && verifyAutonomousSubmissionMetadataReceipt(
          request?.autonomousResearchReleaseBinding?.submissionMetadataReceipt,
          {
            paperId: request?.paperId,
            protocolFamily: request?.autonomousResearchReleaseBinding
              ?.proposalProtocolFamily,
            authorityObservedAt: observedNow(verifierClock).toISOString(),
          },
        );
    },
    verifyCurrentCampaignReleaseAuthority({ campaignReleaseAuthority, request } = {}) {
      try {
        const authority = currentRelease({
          root,
          runtimeRoot,
          campaignId: request?.campaignId,
          clock: verifierClock,
          environment,
        });
        return Boolean(authority
          && sameRecord(authority, campaignReleaseAuthority)
          && releaseAuthoritySignatureValid(authority, releaseAttestor));
      } catch { return false; }
    },
    verifyVenueComplianceAuthority({
      venueComplianceReceipt,
      venueProfileSelection,
      campaignReleaseAuthority,
      autonomousResearchReleaseBinding,
      request,
    } = {}) {
      try {
        const authority = currentRelease({
          root,
          runtimeRoot,
          campaignId: request?.campaignId,
          clock: verifierClock,
          environment,
        });
        const releaseBinding = authority?.releaseBundle
          ?.autonomousResearchReleaseBinding || null;
        if (!authority
          || !sameRecord(authority, campaignReleaseAuthority)
          || !releaseAuthoritySignatureValid(authority, releaseAttestor)
          || !sameRecord(releaseBinding, autonomousResearchReleaseBinding)
          || !sameRecord(releaseBinding?.venueProfileSelection, venueProfileSelection)) {
          return false;
        }
        const rebuilt = venueComplianceInspector.inspect({
          campaignReleaseAuthority: authority,
          venueProfileSelection,
        });
        return sameRecord(rebuilt, venueComplianceReceipt)
          && sameRecord(request?.venueComplianceReceipt, venueComplianceReceipt);
      } catch { return false; }
    },
    verifyQualificationAuthority({
      qualificationInspection,
      qualificationReceipt,
      campaignReleaseAuthority,
      autonomousResearchReleaseBinding,
      request,
    } = {}) {
      let stateRepository = null;
      try {
        const now = observedNow(verifierClock);
        const authority = currentRelease({
          root,
          runtimeRoot,
          campaignId: request?.campaignId,
          clock: verifierClock,
          environment,
        });
        if (!authority || !sameRecord(authority, campaignReleaseAuthority)
          || !releaseAuthoritySignatureValid(authority, releaseAttestor)) return false;

        stateRepository = createAutonomousResearchQualificationStateRepository({
          runtimeRoot,
          paperId: request?.paperId,
          create: false,
          offlineProvision: false,
        });
        const state = stateRepository.readExternalQualificationState();
        const pointer = createFullResearchQualificationReceiptPointerRepository({
          runtimeRoot,
          offlineProvision: false,
        }).read();
        if (state?.recovery?.status !== 'qualification_verified'
          || state.campaignId !== request?.campaignId
          || state.paperId !== request?.paperId
          || state.campaignReleaseBundleHash !== request?.campaignReleaseBundleHash
          || !sameRecord(state.receipt, qualificationReceipt)
          || !sameRecord(state.verifiedInspection, qualificationInspection)
          || !sameRecord(qualificationInspection?.qualificationReceipt, qualificationReceipt)
          || !pointer
          || pointer.qualificationStateHash
            !== state.autonomousExternalQualificationStateHash
          || pointer.qualificationStateGeneration !== state.generation
          || !sameRecord(pointer.receipt, qualificationReceipt)) return false;

        const releaseBinding = authority.releaseBundle
          ?.autonomousResearchReleaseBinding || null;
        if (!sameRecord(releaseBinding, autonomousResearchReleaseBinding)) return false;
        if (!verifyIndependentQualificationEvidence({
          evidence:
            qualificationInspection?.independentVerificationEvidence || null,
          receipt: qualificationReceipt,
          campaignReleaseAuthority: authority,
          verificationTime: now,
        })) return false;
        const envelope = verifyFullResearchQualificationReceiptEnvelope(
          qualificationReceipt,
          {
            now,
            campaignReleaseAuthority: authority,
            expectedPaperId: request.paperId,
            expectedProposalHash: releaseBinding?.proposalHash || null,
            expectedPolicyAuthorizationHash:
              releaseBinding?.policyAuthorizationHash || null,
            expectedSeedBindingHash: releaseBinding?.seedBindingHash || null,
            verifyQualificationSignature,
            allowBoundedGoldenCapability: false,
          },
        );
        return envelope.ready === true
          && envelope.signatureVerified === true
          && envelope.timeWindowVerified === true
          && envelope.releasePointerVerified === true
          && envelope.qualificationReceiptHash === request.qualificationReceiptHash;
      } catch { return false; }
      finally { stateRepository?.close?.(); }
    },
  });
}
