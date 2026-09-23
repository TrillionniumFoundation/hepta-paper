import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_PHASES,
  verifyAutonomousResearchOneShotCampaignAttemptReservation,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import {
  autonomousResearchOneShotCampaignAttemptFailureOutcome as failureOutcome,
  autonomousResearchOneShotCampaignAttemptMonitorReport as monitorReport,
} from './autonomous-research-one-shot-campaign-attempt-failure.mjs';

const PHASES = new Set(AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_PHASES);

function requireFunction(value, code) {
  if (typeof value !== 'function') throw new Error(code);
  return value;
}

function evidenceFromResult(result, code) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Object.hasOwn(result, 'evidence')) throw new Error(code);
  return result.evidence;
}

function terminalResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !['completed', 'failed_terminal'].includes(result.terminalStatus)) {
    throw new Error('autonomous_research_one_shot_campaign_launch_result_invalid');
  }
  return Object.freeze({
    terminalStatus: result.terminalStatus,
    outcome: Object.hasOwn(result, 'outcome') ? result.outcome : null,
  });
}

function currentHead(inspection) {
  const head = inspection?.events?.at(-1);
  if (!head || !PHASES.has(head.phase)) {
    throw new Error('autonomous_research_one_shot_campaign_attempt_head_invalid');
  }
  return head;
}

function append(repository, inspection, phase, evidence) {
  const head = currentHead(inspection);
  return repository.appendEvent({
    attemptId: inspection.reservation.attemptId,
    phase,
    evidence,
    expectedSequence: head.sequence + 1,
    expectedPhase: head.phase,
    expectedPreviousEventHash:
      head.autonomousResearchOneShotCampaignAttemptEventHash,
  });
}

function finalize(repository, inspection, terminalStatus, outcome) {
  const head = currentHead(inspection);
  return repository.finalizeAttempt({
    attemptId: inspection.reservation.attemptId,
    terminalStatus,
    outcome,
    expectedSequence: head.sequence + 1,
    expectedPhase: head.phase,
    expectedPreviousEventHash:
      head.autonomousResearchOneShotCampaignAttemptEventHash,
  });
}

function terminalStatusForFailure(phase) {
  if (['attempt_reserved', 'preconditions_verified', 'prepare_verified'].includes(phase)) {
    return 'blocked_pre_provider';
  }
  if (phase === 'provider_completed') return 'blocked_post_provider';
  if (['provider_started', 'launch_started'].includes(phase)) {
    return 'recovered_incomplete';
  }
  throw new Error('autonomous_research_one_shot_campaign_failure_phase_invalid');
}

function terminalReport(inspection) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptCompositionReport',
    status: 'autonomous_research_one_shot_campaign_attempt_terminal',
    inspection,
    terminalReceipt: inspection.terminalReceipt,
  });
}

export async function composeAutonomousResearchOneShotCampaignAttempt({
  repository,
  reservation,
  inspectPreconditions,
  prepareCampaign,
  assertProviderActionReady,
  executeProviderAction,
  assertLaunchActionReady,
  launchCampaign,
  inspectLaunchOutcome,
} = {}) {
  if (!repository || repository.kind !== 'CampaignOneShotAttemptJournalRepository'
    || !verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation)) {
    throw new Error('autonomous_research_one_shot_campaign_attempt_composition_invalid');
  }
  requireFunction(inspectPreconditions,
    'autonomous_research_one_shot_campaign_preconditions_inspector_required');
  requireFunction(prepareCampaign,
    'autonomous_research_one_shot_campaign_prepare_action_required');
  requireFunction(assertProviderActionReady,
    'autonomous_research_one_shot_campaign_provider_fence_required');
  requireFunction(executeProviderAction,
    'autonomous_research_one_shot_campaign_provider_action_required');
  requireFunction(assertLaunchActionReady,
    'autonomous_research_one_shot_campaign_launch_fence_required');
  requireFunction(launchCampaign,
    'autonomous_research_one_shot_campaign_launch_action_required');
  requireFunction(inspectLaunchOutcome,
    'autonomous_research_one_shot_campaign_launch_inspector_required');

  let inspection = repository.reserveAttempt({ reservation });
  if (inspection.terminalReceipt) return terminalReport(inspection);
  if (inspection.headPhase === 'provider_completed') {
    throw new Error(
      'autonomous_research_one_shot_existing_provider_completion_not_launch_authority',
    );
  }
  let providerCompletedByThisInvocation = false;
  let ownedExternalActionPhase = null;

  while (!inspection.terminalReceipt) {
    const phase = inspection.headPhase;
    try {
      if (phase === 'attempt_reserved') {
        const result = await inspectPreconditions({ reservation, inspection });
        inspection = append(repository, inspection, 'preconditions_verified',
          evidenceFromResult(result,
            'autonomous_research_one_shot_campaign_preconditions_result_invalid'));
        continue;
      }
      if (phase === 'preconditions_verified') {
        const result = await prepareCampaign({ reservation, inspection });
        inspection = append(repository, inspection, 'prepare_verified',
          evidenceFromResult(result,
            'autonomous_research_one_shot_campaign_prepare_result_invalid'));
        continue;
      }
      if (phase === 'prepare_verified') {
        await assertProviderActionReady({ reservation, inspection });
        const transition = append(repository, inspection, 'provider_started', {
          action: 'provider',
          status: 'external_action_marker_committed',
        });
        if (await repository.assertExternalActionSideEffectPermit({ transition }) !== true) {
          throw new Error('autonomous_research_one_shot_provider_permit_denied');
        }
        ownedExternalActionPhase = 'provider_started';
        inspection = transition;
        const result = await executeProviderAction({ reservation, inspection });
        const providerCompletion = append(repository, inspection, 'provider_completed',
          evidenceFromResult(result,
            'autonomous_research_one_shot_campaign_provider_result_invalid'));
        providerCompletedByThisInvocation =
          providerCompletion.mutationDisposition?.phase === 'provider_completed'
          && providerCompletion.mutationDisposition?.commitAcknowledged === true
          && providerCompletion.mutationDisposition?.markerRemainsCurrent === true
          && providerCompletion.mutationDisposition?.status
            === 'appended_by_this_call';
        ownedExternalActionPhase = null;
        inspection = providerCompletion;
        continue;
      }
      if (phase === 'provider_started') return monitorReport(inspection);
      if (phase === 'provider_completed') {
        if (!providerCompletedByThisInvocation) {
          throw new Error(
            'autonomous_research_one_shot_provider_completion_not_invocation_authority',
          );
        }
        await assertLaunchActionReady({ reservation, inspection });
        const transition = append(repository, inspection, 'launch_started', {
          action: 'launch',
          status: 'external_action_marker_committed',
        });
        if (await repository.assertExternalActionSideEffectPermit({ transition }) !== true) {
          throw new Error('autonomous_research_one_shot_launch_permit_denied');
        }
        ownedExternalActionPhase = 'launch_started';
        inspection = transition;
        const result = terminalResult(await launchCampaign({ reservation, inspection }));
        inspection = finalize(repository, inspection, result.terminalStatus, result.outcome);
        continue;
      }
      if (phase === 'launch_started') {
        await inspectLaunchOutcome({ reservation, inspection });
        return monitorReport(inspection);
      }
      throw new Error(`autonomous_research_one_shot_campaign_phase_unsupported:${phase}`);
    } catch (error) {
      const latest = repository.inspectAttempt({
        attemptId: inspection.reservation.attemptId,
      });
      if (latest?.terminalReceipt) return terminalReport(latest);
      if (['provider_started', 'launch_started'].includes(latest?.headPhase)
        && ownedExternalActionPhase !== latest.headPhase) return monitorReport(latest);
      const failurePhase = latest?.headPhase || phase;
      const terminalStatus = terminalStatusForFailure(failurePhase);
      const terminal = finalize(repository, latest, terminalStatus,
        failureOutcome(error, failurePhase));
      return terminalReport(terminal);
    }
  }
  return terminalReport(inspection);
}
