import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  selectAutonomousVenueProfile,
  verifyAutonomousVenueProfileRegistry,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  buildVenueRequirementIr,
} from '../../paper-domain/automation/venue-requirement-ir.mjs';
import {
  verifyAutonomousVenueTemplateAssetBundle,
  verifyAutonomousVenueTemplateAssetRecord,
} from '../../paper-domain/automation/autonomous-venue-template-asset-contract.mjs';
import {
  buildAutonomousSubmissionMetadataReceipt,
  verifyAutonomousSubmissionMetadataProfile,
} from '../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';

function venueComplianceRuntimeReady(inspection) {
  const {
    localAutonomousVenueComplianceRuntimeInspectionHash: claimedHash,
    ...payload
  } = inspection || {};
  return inspection?.kind === 'LocalAutonomousVenueComplianceRuntimeInspection'
    && inspection?.status === 'local_autonomous_venue_compliance_runtime_ready'
    && inspection?.ready === true
    && inspection?.blockers?.length === 0
    && hashRecord('LocalAutonomousVenueComplianceRuntimeInspection', payload) === claimedHash;
}

export function prepareAutonomousResearchVenue({
  paperId,
  proposal,
  researchAgendaIr,
  productionRun,
  venueProfileRegistry,
  venueProfileRegistryAuthority,
  venueTemplateAssetBundle,
  submissionMetadataProfile,
  submissionMetadataAuthority,
  venueComplianceRuntimeInspection,
  createdAt,
} = {}) {
  if (venueProfileRegistry && !verifyAutonomousVenueProfileRegistry(venueProfileRegistry)) {
    throw new Error('autonomous_research_venue_profile_registry_invalid');
  }
  if (submissionMetadataProfile
    && !verifyAutonomousSubmissionMetadataProfile(submissionMetadataProfile)) {
    throw new Error('autonomous_research_submission_metadata_profile_invalid');
  }
  const venueProfileSelection = venueProfileRegistry
    ? selectAutonomousVenueProfile({
      registry: venueProfileRegistry,
      paperId,
      protocolFamily: proposal.protocolFamily,
      paperType: 'research_article',
      selectedAt: createdAt,
      ...(venueProfileRegistry.version >= 2 ? {
        objective: proposal.objective,
        submissionMetadataProfile,
        registryAuthorityProof: venueProfileRegistryAuthority?.authorityProof || null,
        submissionMetadataAuthorityProof:
          submissionMetadataAuthority?.authorityProof || null,
        ...(venueProfileRegistry.version === 3 ? { venueTemplateAssetBundle } : {}),
        requireExternalSubmission: productionRun,
        authorityObservedAt: createdAt,
      } : {}),
    })
    : null;
  const venueTemplateAsset = venueProfileSelection?.venueTemplateAsset || null;
  const venueTemplateAssetReady = venueProfileSelection?.profile?.version !== 3 || (
    verifyAutonomousVenueTemplateAssetRecord(venueTemplateAsset)
    && verifyAutonomousVenueTemplateAssetBundle(
      venueProfileSelection.venueTemplateAssetBundle,
      { registry: venueProfileRegistry },
    )
    && venueTemplateAsset.venueId === venueProfileSelection.venueId
    && venueTemplateAsset.templateAssetHash
      === venueProfileSelection.profile.requirementSpecification.templateAssetHash
    && venueProfileSelection.venueTemplateAssetBundleHash
      === venueProfileSelection.venueTemplateAssetBundle
        .autonomousVenueTemplateAssetBundleHash
  );
  if (venueProfileSelection?.profile?.version === 3
    && venueProfileSelection.profile.externalSubmissionEnabled
    && !venueTemplateAssetReady) {
    throw new Error('autonomous_research_venue_template_asset_required');
  }
  const submissionMetadataReceipt = venueProfileSelection && submissionMetadataProfile
    ? buildAutonomousSubmissionMetadataReceipt({
      paperId,
      protocolFamily: proposal.protocolFamily,
      profile: submissionMetadataProfile,
      ...(venueProfileSelection.version === 2 ? {
        profileAuthorityProof: submissionMetadataAuthority?.authorityProof || null,
        authorityObservedAt: createdAt,
      } : {}),
      selectedAt: createdAt,
    }) : null;
  const venueRequirementIr = researchAgendaIr && venueProfileSelection?.profile?.version === 3
    ? buildVenueRequirementIr({
      researchAgendaIr,
      venueProfileSelection,
    }) : null;
  const venueComplianceRuntimeVerified = venueComplianceRuntimeReady(
    venueComplianceRuntimeInspection,
  );
  return {
    venueProfileSelection,
    venueTemplateAsset,
    venueTemplateAssetReady,
    submissionMetadataReceipt,
    venueRequirementIr,
    venueComplianceRuntimeVerified,
  };
}
