import {
  assertAutonomousResearchStateRecoverabilityReady,
} from '../../paper-application/automation/autonomous-research-state-recoverability-controller.mjs';

export function createAutonomousResearchStateRecoverabilityReconciler({
  onlineAuthorityEvidenceController,
  stateRecoverabilityController,
} = {}) {
  return async function reconcileStateRecoverability({
    residentLeaseContext,
    action,
  } = {}) {
    if (onlineAuthorityEvidenceController) {
      const requiredValidityMs =
        onlineAuthorityEvidenceController.policy?.renewalLeadMs || 0;
      const authority = onlineAuthorityEvidenceController.reconcile({
        residentLeaseContext,
        requiredValidityMs,
      });
      if (authority?.ready !== true) {
        onlineAuthorityEvidenceController.assertCurrent({
          requiredValidityMs,
          action,
        });
      }
    }
    if (!stateRecoverabilityController) return null;
    const recovery = await stateRecoverabilityController.reconcile({
      residentLeaseContext,
    });
    assertAutonomousResearchStateRecoverabilityReady(recovery, { action });
    stateRecoverabilityController.assertCurrent({ action });
    return recovery;
  };
}

export function composeAutonomousResearchCampaignExternalSideEffectControl({
  stateRepository,
  supervisorDispatchEvidence,
  supervisorDispatchAuthorization,
  onlineAuthorityEvidenceController,
  stateRecoverabilityController,
  reconcileStateRecoverability,
  clock,
  boundedQualificationRetry,
  externalActionRecoveryPort = null,
} = {}) {
  const reconcileCampaignExternalInfrastructure = async ({
    action: externalAction,
  } = {}) => reconcileStateRecoverability({
    residentLeaseContext: supervisorDispatchEvidence.residentLeaseContext,
    action: `campaign_external_side_effect:${externalAction || 'unspecified'}`,
  });
  reconcileCampaignExternalInfrastructure.assertCurrent = ({
    action: externalAction,
  } = {}) => {
    onlineAuthorityEvidenceController?.assertCurrent({
      requiredValidityMs: 0,
      action: `campaign_external_side_effect:${externalAction || 'unspecified'}`,
    });
    return stateRecoverabilityController?.assertCurrent({
      action: `campaign_external_side_effect:${externalAction || 'unspecified'}`,
    });
  };
  const supervisorExternalActionJournal = supervisorDispatchAuthorization
    ? Object.freeze({
      actionConfigurationIdentityHashes: externalActionRecoveryPort
        ?.inspectCapabilities({ now: clock.now() })
        ?.actionConfigurationIdentityHashes || null,
      sideEffectPermitRequired:
        stateRepository.externallyFencedMutationsRequired === true,
      recoverabilityEpochFenceRequired: Boolean(stateRecoverabilityController),
      async preBegin({ actionKind }) {
        return reconcileCampaignExternalInfrastructure({
          action: `supervisor_external_action_pre_begin:${actionKind}`,
        });
      },
      begin({ actionKind, reservation, now }) {
        reconcileCampaignExternalInfrastructure.assertCurrent({
          action: `supervisor_external_action_begin:${actionKind}`,
        });
        return stateRepository.beginExternalActionAttempt({
          lease: supervisorDispatchEvidence.campaignLease,
          actionKind,
          reservation,
          now,
        });
      },
      async reconcileAfterBegin({ actionKind }) {
        await reconcileCampaignExternalInfrastructure({
          action: `supervisor_external_action_after_begin:${actionKind}`,
        });
        return true;
      },
      async markStarted({ attempt, actionKind }) {
        let progressPersisted = false;
        try {
          stateRepository.recordExternalActionProgress({
            lease: supervisorDispatchEvidence.campaignLease,
            attempt,
            evidence: Object.freeze({
              version: 1,
              kind: 'AutonomousResearchSupervisorExternalActionMayHaveStarted',
              actionKind,
              attemptId: attempt.attemptId,
              reservationHash: attempt.reservationHash,
              externalActionMayHaveStarted: true,
            }),
            now: clock.now(),
          });
          progressPersisted = true;
          await reconcileCampaignExternalInfrastructure({
            action: `supervisor_external_action_started:${actionKind}`,
          });
          reconcileCampaignExternalInfrastructure.assertCurrent({
            action: `supervisor_external_action_started:${actionKind}`,
          });
          return true;
        } catch (error) {
          if (progressPersisted || error?.committed === true) {
            error.externalActionMayHaveStarted = true;
          }
          throw error;
        }
      },
      cancelInfrastructureDeferred({ attempt = null }) {
        return stateRepository.cancelExternalActionInfrastructureDeferred({
          lease: supervisorDispatchEvidence.campaignLease,
          attempt,
          now: clock.now(),
        });
      },
      assertSideEffectPermit({ attempt }) {
        onlineAuthorityEvidenceController?.assertCurrent({
          requiredValidityMs: 0,
          action: 'supervisor_external_action_side_effect_permit',
        });
        stateRecoverabilityController?.assertCurrent({
          action: 'supervisor_external_action_side_effect_permit',
        });
        return stateRepository.assertExternalActionSideEffectPermit({ attempt });
      },
      finish({
        attempt, successful, evidence, actionAccountingComplete,
        externalActionPerformed, blocker, now,
      }) {
        return stateRepository.finishExternalActionAttempt({
          lease: supervisorDispatchEvidence.campaignLease,
          attempt,
          successful,
          evidence,
          actionAccountingComplete,
          externalActionPerformed,
          blocker,
          now,
        });
      },
    }) : null;
  const assertCampaignExternalSideEffectReady =
    reconcileCampaignExternalInfrastructure;
  assertCampaignExternalSideEffectReady.markStarted = ({
    action: externalAction,
  } = {}) => boundedQualificationRetry?.onExternalSideEffectStarted?.({
    action: externalAction || 'campaign_external_side_effect',
  });
  return Object.freeze({
    assertCampaignExternalSideEffectReady,
    supervisorExternalActionJournal,
  });
}
