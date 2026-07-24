function nowDate(clock) {
  const value = clock?.now ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_supervisor_clock_invalid');
  }
  return date;
}

function outcome({
  campaign,
  final,
  reason,
  recovery,
  scientificDispositionReceipt = null,
  compactOutcome = null,
}) {
  return Object.freeze({
    campaignId: campaign.campaignId,
    status: final.disposition,
    reason,
    externalSubmissionPerformed: recovery.externalActionPerformed === true,
    ...(scientificDispositionReceipt ? { scientificDispositionReceipt } : {}),
    ...(compactOutcome ? { outcome: compactOutcome } : {}),
  });
}

export async function executeAutonomousResearchSupervisorSubmissionRecovery({
  recoverAutonomousSubmission,
  publishCampaignProgress,
  autonomyFence,
  campaign,
  machineRecord,
  stateRepository,
  lease,
  clock,
  pollMs,
  signal,
  reconcileStateRecoverability = null,
  assertStateRecoverabilityCurrent = null,
} = {}) {
  if (typeof recoverAutonomousSubmission !== 'function') {
    return Object.freeze({ recovery: null, finalizedOutcome: null });
  }
  let residentLeaseContext = await publishCampaignProgress(
    'before_submission_recovery',
  );
  await reconcileStateRecoverability?.({
    residentLeaseContext,
    action: 'submission_recovery_entry',
  });
  assertStateRecoverabilityCurrent?.('submission_recovery_entry');
  autonomyFence.assertCurrent({ campaign, record: machineRecord, residentLeaseContext });
  const recovery = await recoverAutonomousSubmission({
    campaign,
    signal,
    async assertExternalSideEffectReady({ action } = {}) {
      residentLeaseContext = publishCampaignProgress(
        `submission:${action || 'external_side_effect'}`,
      ) || residentLeaseContext;
      await reconcileStateRecoverability?.({
        residentLeaseContext,
        action: `submission:${action || 'external_side_effect'}`,
      });
      assertStateRecoverabilityCurrent?.(
        `submission:${action || 'external_side_effect'}:final`,
      );
      return true;
    },
  });
  residentLeaseContext = await publishCampaignProgress(
    'after_submission_recovery',
  ) || residentLeaseContext;
  if (recovery?.required === true && recovery.explicitFailure === true) {
    const scientificDispositionReceipt =
      resolveAutonomousResearchScientificDisposition({
        campaign,
        submissionRequired: true,
        submissionDelivery: recovery.delivery,
        now: nowDate(clock),
      });
    if (!scientificDispositionReceipt) {
      throw new Error(
        'autonomous_research_submission_rejection_disposition_evidence_invalid',
      );
    }
    assertStateRecoverabilityCurrent?.(
      'submission_rejection_scientific_disposition_settlement',
    );
    const compactOutcome = compactAutonomousResearchSupervisorOutcome({
      status: scientificDispositionReceipt.status,
      campaign: { status: campaign.status },
      autonomousSubmission: { delivery: recovery.delivery },
      scientificDispositionReceipt,
    });
    const final = stateRepository.finishDispatch({
      lease,
      successful: true,
      settled: true,
      observedCampaignCostUsd: campaign.costKnown ? Number(campaign.costUsd || 0) : 0,
      observedQualificationReservedCostUsd: 0,
      costKnown: campaign.costKnown,
      outcome: compactOutcome,
      now: nowDate(clock),
    });
    return Object.freeze({
      recovery,
      finalizedOutcome: outcome({
        campaign,
        final,
        reason: scientificDispositionReceipt.settlementReason,
        recovery,
        scientificDispositionReceipt,
        compactOutcome,
      }),
    });
  }
  if (recovery?.required === true && recovery.stateCount > 0
    && recovery.ready !== true && recovery.terminal !== true) {
    const now = nowDate(clock);
    const final = stateRepository.finishDispatch({
      lease,
      successful: true,
      nextDispatchAt: new Date(now.getTime() + pollMs),
      observedCampaignCostUsd: campaign.costKnown ? Number(campaign.costUsd || 0) : 0,
      observedQualificationReservedCostUsd: 0,
      costKnown: campaign.costKnown,
      outcome: {
        status: recovery.status,
        autonomousSubmissionDeliveryStatus: recovery.delivery?.status || null,
        lookupRequired: recovery.lookupRequired === true,
      },
      now,
    });
    return Object.freeze({
      recovery,
      finalizedOutcome: outcome({
        campaign,
        final,
        reason: 'autonomous_submission_recovery_scheduled',
        recovery,
      }),
    });
  }
  return Object.freeze({ recovery, finalizedOutcome: null });
}
import {
  resolveAutonomousResearchScientificDisposition,
} from '../../paper-domain/automation/autonomous-research-scientific-disposition-contract.mjs';
import {
  compactAutonomousResearchSupervisorOutcome,
} from './autonomous-research-supervisor-progress.mjs';
