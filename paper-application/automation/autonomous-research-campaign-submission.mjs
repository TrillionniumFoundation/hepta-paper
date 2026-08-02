import {
  buildAutonomousSubmissionRequest,
} from '../../paper-domain/automation/autonomous-submission-contract.mjs';
import {
  assertAutonomousVenueComplianceInspectorPort,
} from '../../paper-ports/autonomous-venue-compliance-inspector-port.mjs';
import {
  autonomousSubmissionAwareCampaignStatus,
  evaluateAutonomousSubmissionDeliveryReadiness,
  inspectPersistedAutonomousSubmissionDelivery,
  prepareAutonomousSubmissionHandoff,
} from './autonomous-submission-delivery.mjs';

function requirePortalDescriptor(value) {
  if (value?.kind !== 'AutonomousSubmissionPortalDescriptor'
    || !value.portalId || !value.configurationHash) {
    throw new Error('autonomous_submission_portal_descriptor_required');
  }
  return value;
}

export async function resolveAutonomousResearchCampaignSubmission({
  action,
  campaign,
  campaignId,
  preparation,
  campaignReleaseAuthority,
  qualificationEligibility,
  qualificationInspection,
  autonomousSubmissionPortal,
  autonomousSubmissionOutbox,
  autonomousVenueComplianceInspector,
  autonomousSubmissionRequestVerifier,
  requestedAt = null,
  localOnly = false,
} = {}) {
  const venueProfileSelection = preparation?.venueProfileSelection || null;
  const submissionRequired = localOnly !== true &&
    venueProfileSelection?.requireExternalSubmission === true;
  let autonomousSubmission = null;
  if (action === 'status' && submissionRequired) {
    const persisted = inspectPersistedAutonomousSubmissionDelivery({
      outbox: autonomousSubmissionOutbox,
      campaignId,
      paperId: campaign.paperId,
      portalConfigurationHash:
        preparation.autonomousSubmissionPortalConfigurationHash,
      portalId: autonomousSubmissionPortal?.portalId || null,
      submissionRequestVerifier: autonomousSubmissionRequestVerifier,
    });
    if (persisted) autonomousSubmission = Object.freeze({
      venueComplianceReceipt: null,
      ...persisted,
    });
  }
  const researchQualificationReady =
    qualificationEligibility?.campaignFullyQualified === true;
  const localResearchWritingReady = localOnly === true
    && campaign?.status === 'completed'
    && Boolean(campaignReleaseAuthority);
  if (action !== 'status' && researchQualificationReady && submissionRequired) {
    const portal = requirePortalDescriptor(autonomousSubmissionPortal);
    if (portal.configurationHash
      !== preparation.autonomousSubmissionPortalConfigurationHash) {
      throw new Error('autonomous_submission_portal_configuration_binding_invalid');
    }
    const complianceInspector = assertAutonomousVenueComplianceInspectorPort(
      autonomousVenueComplianceInspector,
    );
    const venueComplianceReceipt = await complianceInspector.inspect({
      campaignReleaseAuthority,
      venueProfileSelection,
    });
    if (venueComplianceReceipt?.submissionMetadataReceiptHash
      !== preparation.submissionMetadataReceipt
        ?.autonomousSubmissionMetadataReceiptHash) {
      throw new Error('autonomous_submission_metadata_release_binding_invalid');
    }
    const request = buildAutonomousSubmissionRequest({
      campaignId,
      paperId: campaign.paperId,
      venueProfileSelection,
      campaignReleaseAuthority,
      qualificationInspection,
      venueComplianceReceipt,
      portalConfigurationHash: portal.configurationHash,
      requestedAt,
      requireResearchClosure: true,
      verifyQualificationSignature:
        autonomousSubmissionRequestVerifier?.verifyQualificationSignature,
      verifyIndependentQualificationEvidence:
        autonomousSubmissionRequestVerifier
          ?.verifyIndependentQualificationEvidence,
    });
    const delivery = prepareAutonomousSubmissionHandoff({
      outbox: autonomousSubmissionOutbox,
      request,
      portalId: portal.portalId,
      submissionRequestVerifier: autonomousSubmissionRequestVerifier,
    });
    autonomousSubmission = Object.freeze({
      venueComplianceReceipt,
      request,
      delivery,
      receipt: delivery.receipt,
    });
  }
  const submissionReadiness = evaluateAutonomousSubmissionDeliveryReadiness({
    required: submissionRequired,
    autonomousSubmission,
    submissionRequestVerifier: autonomousSubmissionRequestVerifier,
    completedReceiptVerifier:
      autonomousSubmissionPortal?.completedReceiptVerifier || null,
    requireCryptographicAuthority:
      autonomousSubmissionPortal?.signedCompletedReceiptSupported === true,
  });
  return Object.freeze({
    autonomousSubmission,
    researchQualificationReady,
    submissionRequired,
    submissionReady: submissionReadiness.ready,
    submissionTerminalFailure: submissionReadiness.terminalFailure,
    fullAutomaticResearchWritingReady:
      researchQualificationReady && submissionReadiness.ready,
    localResearchWritingReady,
    campaignExecutionStatus: localOnly === true
      ? localResearchWritingReady
        ? 'autonomous_research_campaign_completed_local'
        : campaign?.status === 'completed'
          ? 'autonomous_research_campaign_completed_local_release_pending'
          : `autonomous_research_campaign_${campaign?.status || 'unavailable'}`
      : autonomousSubmissionAwareCampaignStatus({
        campaignStatus: campaign?.status,
        qualificationEligibility,
        submissionReadiness,
      }),
  });
}
