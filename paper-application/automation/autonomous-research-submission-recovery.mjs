import {
  assertAutonomousSubmissionOutboxPort,
} from '../../paper-ports/autonomous-submission-outbox-port.mjs';
import {
  assertAutonomousSubmissionPortalPort,
} from '../../paper-ports/autonomous-submission-portal-port.mjs';
import {
  deliverAutonomousSubmission,
  inspectPersistedAutonomousSubmissionDelivery,
} from './autonomous-submission-delivery.mjs';
import {
  autonomousResearchCampaignRequiresExternalSubmission,
} from './autonomous-research-supervisor-readiness-policy.mjs';

function report({ status, required, delivery = null, stateCount = 0 }) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSubmissionRecoveryReport',
    status,
    required,
    stateCount,
    delivery,
    ready: !required || delivery?.status === 'autonomous_submission_delivery_completed',
    terminal: !required || delivery?.terminal === true,
    explicitFailure:
      delivery?.status === 'autonomous_submission_delivery_explicit_failure',
    lookupRequired: delivery?.lookupRequired === true,
    networkActionPerformed: delivery?.networkActionPerformed === true,
    externalActionPerformed: delivery?.externalActionPerformed === true,
  });
}

export function inspectAutonomousResearchSubmissionHandoff({
  campaign,
  portalDescriptor,
  outbox,
  submissionRequestVerifier,
} = {}) {
  const required = autonomousResearchCampaignRequiresExternalSubmission(campaign);
  if (!required) {
    return report({
      status: 'autonomous_research_submission_handoff_not_required',
      required: false,
    });
  }
  if (portalDescriptor?.kind !== 'AutonomousSubmissionPortalDescriptor') {
    throw new Error('autonomous_submission_portal_descriptor_required');
  }
  const persisted = inspectPersistedAutonomousSubmissionDelivery({
    outbox,
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    portalConfigurationHash: portalDescriptor.configurationHash,
    portalId: portalDescriptor.portalId,
    submissionRequestVerifier,
  });
  if (!persisted) {
    return report({
      status: 'autonomous_research_submission_handoff_not_started',
      required: true,
    });
  }
  const delivery = persisted.delivery;
  return report({
    status: delivery.status === 'autonomous_submission_delivery_completed'
      ? 'autonomous_research_submission_handoff_completed'
      : delivery.status === 'autonomous_submission_delivery_explicit_failure'
        ? 'autonomous_research_submission_handoff_explicit_failure'
        : 'autonomous_research_submission_handoff_pending_dispatcher',
    required: true,
    stateCount: 1,
    delivery,
  });
}

export async function recoverAutonomousResearchSubmission({
  campaign,
  portal: suppliedPortal = null,
  outbox: suppliedOutbox,
  submissionRequestVerifier,
  signal = null,
  assertExternalSideEffectReady = null,
} = {}) {
  const required = autonomousResearchCampaignRequiresExternalSubmission(campaign);
  if (!required) {
    return report({
      status: 'autonomous_research_submission_recovery_not_required',
      required: false,
    });
  }
  if (submissionRequestVerifier?.kind !== 'AutonomousSubmissionRequestVerifier'
    || typeof submissionRequestVerifier.verify !== 'function') {
    throw new Error('autonomous_submission_request_verifier_required');
  }
  const preparation = campaign.spec.autonomousResearchPreparation;
  const portal = assertAutonomousSubmissionPortalPort(suppliedPortal, {
    requiredLocalOriginIdentitySubjectHashes: [preparation.runtimePrincipalBinding
      ?.authorIdentitySubjectHash].filter(Boolean),
  });
  const outbox = assertAutonomousSubmissionOutboxPort(suppliedOutbox);
  const expectedConfigurationHash = preparation.autonomousSubmissionPortalConfigurationHash;
  if (portal.configurationHash !== expectedConfigurationHash) {
    throw new Error('autonomous_submission_portal_configuration_binding_invalid');
  }
  const states = outbox.listAutonomousSubmissionsForCampaign({
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    portalId: portal.portalId,
  });
  if (states.length > 1) {
    throw new Error('autonomous_submission_recovery_ambiguous_requests');
  }
  if (states.length === 0) {
    return report({
      status: 'autonomous_research_submission_recovery_not_started',
      required: true,
    });
  }
  const delivery = await deliverAutonomousSubmission({
    portal,
    outbox,
    request: states[0].request,
    signal,
    submissionRequestVerifier,
    assertExternalSideEffectReady,
  });
  return report({
    status: delivery.terminal
      ? delivery.status === 'autonomous_submission_delivery_completed'
        ? 'autonomous_research_submission_recovery_completed'
        : 'autonomous_research_submission_recovery_explicit_failure'
      : 'autonomous_research_submission_recovery_pending',
    required: true,
    stateCount: 1,
    delivery,
  });
}
