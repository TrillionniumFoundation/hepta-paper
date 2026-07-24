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
    assertExternalSideEffectReady:
      options.assertExternalSideEffectReady || null,
    packageLifecycleAuthority: options.packageLifecycleAuthority || null,
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

function infrastructureControlError(error) {
  return error?.committed === true
    || error?.stateRecoverabilityFatal === true
    || error?.stateRecoverabilityDeferred === true
    || error?.authorityEvidenceRenewalFatal === true
    || error?.authorityEvidenceRenewalDeferred === true
    || error?.residentReactivationRequired === true;
}

export async function prepareAutonomousResearchSupervisorReadinessAction({
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
  let externalActionMayHaveStarted = false;
  let recoveredResult = null;
  const receipts = [];
  const cancelInfrastructureDeferred = (error = null) => {
    if (!attempt || finalized || externalActionMayHaveStarted
      || typeof supervisorExternalActionJournal?.cancelInfrastructureDeferred
        !== 'function') {
      return Object.freeze({ cancelled: false, externalActionMayHaveStarted });
    }
    const cancelled = supervisorExternalActionJournal
      .cancelInfrastructureDeferred({ attempt });
    if (cancelled?.cancelled === true) {
      finalized = true;
      if (error) error.dispatchInfrastructureReservationCancelled = true;
    }
    return cancelled;
  };
  if (actionKind) {
    if (typeof supervisorExternalActionJournal?.begin !== 'function'
      || typeof supervisorExternalActionJournal?.finish !== 'function'
      || (supervisorExternalActionJournal?.sideEffectPermitRequired === true
        && typeof supervisorExternalActionJournal?.assertSideEffectPermit !== 'function')) {
      throw new Error('autonomous_research_supervisor_external_action_journal_required');
    }
    const reservation = Object.freeze({
      version: 1,
      kind: 'AutonomousResearchSupervisorReadinessActionReservation',
      campaignId,
      action,
      launchMode,
      dispatchCount: Number(supervisorDispatchAuthorization.dispatchCount),
      dispatchAuthorizationHash:
        supervisorDispatchAuthorization.autonomousResearchSupervisorDispatchAuthorizationHash,
      providerConfigurationHash,
      externalActionConfigurationIdentityHash:
        supervisorExternalActionJournal?.actionConfigurationIdentityHashes?.[actionKind]
          || providerConfigurationHash,
    });
    try {
      if (typeof supervisorExternalActionJournal.preBegin === 'function') {
        await supervisorExternalActionJournal.preBegin({
          actionKind,
          reservation,
        });
      }
      attempt = supervisorExternalActionJournal.begin({
        actionKind,
        reservation,
        now,
      });
      if (attempt?.status !== 'in_progress') {
        finalized = true;
        externalActionMayHaveStarted = true;
        recoveredResult = attempt?.recoveryResult || null;
        if (attempt?.status !== 'completed' || !recoveredResult) {
          const error = new Error(
            'autonomous_research_supervisor_external_action_recovered_failure',
          );
          error.autonomousResearchRecoveredExternalActionAttempt = attempt;
          throw error;
        }
        receipts.push(attempt.receipt);
      }
      if (!finalized && typeof supervisorExternalActionJournal.reconcileAfterBegin === 'function') {
        await supervisorExternalActionJournal.reconcileAfterBegin({
          attempt,
          actionKind,
          reservation,
        });
      } else if (!finalized
        && supervisorExternalActionJournal.recoverabilityEpochFenceRequired === true) {
        throw new Error(
          'autonomous_research_supervisor_external_action_recoverability_required',
        );
      }
      if (!finalized
        && typeof supervisorExternalActionJournal.assertSideEffectPermit === 'function') {
        const permitted = supervisorExternalActionJournal.assertSideEffectPermit({
          attempt,
          actionKind,
          reservation,
        });
        if (typeof permitted?.then === 'function' || permitted !== true) {
          throw new Error(
            'autonomous_research_supervisor_external_action_side_effect_permit_invalid',
          );
        }
      }
    } catch (error) {
      if (infrastructureControlError(error)) {
        try {
          cancelInfrastructureDeferred(error);
        } catch (cancelError) {
          const fatal = new Error(
            'autonomous_research_supervisor_external_action_infrastructure_cancel_failed',
            { cause: cancelError },
          );
          fatal.stateRecoverabilityFatal = true;
          fatal.originalInfrastructureControlError = error;
          throw fatal;
        }
      }
      throw error;
    }
  }
  return Object.freeze({
    authorized,
    actionKind,
    recoveredResult,
    recovered: recoveredResult !== null,
    async markStarted() {
      if (finalized || !attempt
        || typeof supervisorExternalActionJournal.markStarted !== 'function') {
        return null;
      }
      try {
        const result = await supervisorExternalActionJournal.markStarted({
          attempt,
          actionKind,
        });
        externalActionMayHaveStarted = true;
        return result;
      } catch (error) {
        if (error?.externalActionMayHaveStarted === true || error?.committed === true) {
          externalActionMayHaveStarted = true;
        }
        throw error;
      }
    },
    cancelInfrastructureDeferred({ error = null } = {}) {
      return cancelInfrastructureDeferred(error);
    },
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
