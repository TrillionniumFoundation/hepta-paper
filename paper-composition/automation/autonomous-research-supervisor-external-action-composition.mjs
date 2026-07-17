import {
  verifyAutonomousResearchSupervisorReadinessAuthorization,
} from './autonomous-research-readiness-composition.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';
export {
  createGoldenCampaignQualificationController,
} from '../../paper-application/automation/golden-campaign-qualification-controller.mjs';

export function autonomousResearchCampaignRuntimeOptions(options) {
  return {
    concurrency: Math.max(1, Number(options.concurrency || 8)),
    resourceGovernor: options.resourceGovernor,
    clock: options.clock,
    scheduler: options.scheduler,
    idGenerator: options.idGenerator,
    signal: options.signal || null,
  };
}

export function autonomousResearchReadinessInspectionTime(createdAt) {
  const timestamp = Date.parse(String(createdAt || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
}

export function trustedAutonomousResearchReadinessInspectionTime(clock) {
  const observed = typeof clock?.now === 'function' ? clock.now() : new Date();
  const timestamp = observed instanceof Date ? observed.getTime() : Date.parse(String(observed));
  if (!Number.isFinite(timestamp)) {
    throw new Error('autonomous_research_production_readiness_clock_invalid');
  }
  return new Date(timestamp);
}

export function prepareAutonomousResearchSupervisorReadinessAction({
  dispatchMutation,
  productionMutation,
  supervisorDispatchAuthorization,
  campaign,
  campaignId,
  launchMode,
  action,
  providerConfigurationHash,
  supervisorExternalActionJournal,
  now,
} = {}) {
  const authorized = dispatchMutation
    ? verifyAutonomousResearchSupervisorReadinessAuthorization({
      authorization: supervisorDispatchAuthorization,
      campaign,
      launchMode,
      action,
      providerConfigurationHash,
      now,
      reserveReadiness: dispatchMutation && Boolean(supervisorDispatchAuthorization),
    }) : false;
  if (productionMutation && authorized !== true) {
    throw new Error('autonomous_research_production_readiness_authorization_required');
  }
  const actionKind = productionMutation
    ? AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PRODUCTION_READINESS
    : launchMode === 'golden-bootstrap' && dispatchMutation && authorized
      ? AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.GOLDEN_RELEASE_ATTESTOR
      : null;
  let attempt = null;
  let finalized = false;
  const receipts = [];
  if (actionKind) {
    if (typeof supervisorExternalActionJournal?.begin !== 'function'
      || typeof supervisorExternalActionJournal?.finish !== 'function') {
      throw new Error('autonomous_research_supervisor_external_action_journal_required');
    }
    attempt = supervisorExternalActionJournal.begin({
      actionKind,
      reservation: Object.freeze({
        version: 1,
        kind: 'AutonomousResearchSupervisorReadinessActionReservation',
        campaignId,
        action,
        launchMode,
        dispatchCount: Number(supervisorDispatchAuthorization.dispatchCount),
        dispatchAuthorizationHash:
          supervisorDispatchAuthorization.autonomousResearchSupervisorDispatchAuthorizationHash,
        providerConfigurationHash,
      }),
      now,
    });
  }
  return Object.freeze({
    authorized,
    actionKind,
    finalizeSuccess({ evidence, now: completedAt }) {
      if (!attempt || finalized) return null;
      const result = supervisorExternalActionJournal.finish({
        attempt,
        successful: true,
        evidence,
        actionAccountingComplete: true,
        externalActionPerformed: evidence?.externalActionPerformed === true,
        blocker: null,
        now: completedAt,
      });
      finalized = true;
      receipts.push(result.receipt);
      return result;
    },
    finalizeFailure({ evidence = null, blocker, now: completedAt }) {
      if (!attempt || finalized) return null;
      const result = supervisorExternalActionJournal.finish({
        attempt,
        successful: false,
        evidence,
        actionAccountingComplete: Boolean(evidence),
        externalActionPerformed: evidence?.externalActionPerformed === true,
        blocker,
        now: completedAt,
      });
      finalized = true;
      return result;
    },
    attachReceipts(report) {
      return receipts.length ? Object.freeze({
        ...report,
        supervisorExternalActionReceipts: Object.freeze([...receipts]),
      }) : report;
    },
  });
}
