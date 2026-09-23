import {
  compileExternallyFencedSqliteMutationOperation as operation,
  defineExternallyFencedSqliteMutationStatement,
  externallyFencedSqliteWriterPlanHash,
} from './externally-fenced-sqlite-mutation-plan.mjs';
import {
  createOfflineExternallyFencedSqliteMutationCoordinator,
} from './offline-externally-fenced-sqlite-mutation-coordinator.mjs';

export const AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_DATABASE_ROLE = 'supervisor-state';
export const AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_DATABASE_INSTANCE_ID = 'supervisor-state';
export const AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_SCHEMA_CONTRACT_ID =
  'supervisor-state-schema-v1';
export const AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID =
  'writer:supervisor-state:supervisor-state-repository:v1';

const statement = (statementId, mode, sql) => (
  defineExternallyFencedSqliteMutationStatement(statementId, sql, mode)
);
const S = Object.freeze({
  campaignGet: statement(
    'supervisor-state.campaign.get.v1',
    'get',
    'SELECT * FROM autonomous_research_supervisor_campaign WHERE campaign_id=?',
  ),
  externalActiveGet: statement(
    'supervisor-state.external-active.get.v1',
    'get',
    `SELECT * FROM autonomous_research_supervisor_external_action_journal
      WHERE campaign_id=? AND status='in_progress'`,
  ),
  externalAttemptGet: statement(
    'supervisor-state.external-attempt.get.v1',
    'get',
    `SELECT * FROM autonomous_research_supervisor_external_action_journal
      WHERE attempt_id=?`,
  ),
  externalIdempotencyGet: statement(
    'supervisor-state.external-idempotency.get.v1',
    'get',
    `SELECT * FROM autonomous_research_supervisor_external_action_journal
      WHERE idempotency_key=?`,
  ),
  externalStaleAll: statement(
    'supervisor-state.external-stale.all.v1',
    'all',
    `SELECT journal.* FROM autonomous_research_supervisor_external_action_journal AS journal
      JOIN autonomous_research_supervisor_campaign AS campaign
        ON campaign.campaign_id=journal.campaign_id
      WHERE journal.status='in_progress' AND (
        campaign.lease_expires_at IS NULL
        OR campaign.lease_generation<>journal.lease_generation
        OR julianday(campaign.lease_expires_at)<=julianday(?)
      ) ORDER BY journal.started_at,journal.attempt_id`,
  ),
  dispatchStaleAll: statement(
    'supervisor-state.dispatch-stale.all.v1',
    'all',
    `SELECT * FROM autonomous_research_supervisor_campaign
      WHERE active_dispatch_phase IS NOT NULL AND (
        lease_expires_at IS NULL
        OR lease_generation<>active_dispatch_lease_generation
        OR julianday(lease_expires_at)<=julianday(?)
      ) ORDER BY updated_at,campaign_id`,
  ),
  campaignRegister: statement(
    'supervisor-state.campaign-register.apply.v1',
    'run',
    `INSERT INTO autonomous_research_supervisor_campaign(
      campaign_id,paper_id,disposition,policy_json,policy_hash,lifecycle_started_at,
      absolute_deadline_at,next_dispatch_at,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ),
  campaignReconcile: statement(
    'supervisor-state.campaign-reconcile.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign
      SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        recovered_lease_count=recovered_lease_count+1,updated_at=?
      WHERE lease_expires_at IS NOT NULL AND julianday(lease_expires_at)<=julianday(?)`,
  ),
  campaignRecovered: statement(
    'supervisor-state.campaign-recovered.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      recovered_lease_count=recovered_lease_count+1 WHERE campaign_id=?`,
  ),
  campaignDeadlineBlock: statement(
    'supervisor-state.campaign-deadline-block.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      disposition='blocked',terminal_reason='supervisor_lifecycle_deadline_exhausted',
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
      WHERE campaign_id=?`,
  ),
  campaignLeaseAcquire: statement(
    'supervisor-state.campaign-lease-acquire.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      lease_owner=?,lease_token=?,lease_generation=?,lease_expires_at=?,updated_at=?
      WHERE campaign_id=? AND lease_generation=?`,
  ),
  campaignLeaseRenew: statement(
    'supervisor-state.campaign-lease-renew.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      lease_expires_at=?,updated_at=? WHERE campaign_id=? AND lease_owner=?
      AND lease_token=? AND lease_generation=?
      AND julianday(lease_expires_at)>julianday(?)`,
  ),
  campaignBlock: statement(
    'supervisor-state.campaign-block.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      disposition='blocked',terminal_reason=?,lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,updated_at=? WHERE campaign_id=?`,
  ),
  campaignDispatchBegin: statement(
    'supervisor-state.campaign-dispatch-begin.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      dispatch_count=dispatch_count+1,active_dispatch_phase='reserved',
      active_dispatch_count=dispatch_count+1,active_dispatch_lease_generation=?,
      active_dispatch_reservation_hash=?,updated_at=?
      WHERE campaign_id=? AND active_dispatch_phase IS NULL`,
  ),
  campaignDispatchResume: statement(
    'supervisor-state.campaign-dispatch-resume.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      active_dispatch_phase='started',active_dispatch_lease_generation=?,updated_at=?
      WHERE campaign_id=? AND active_dispatch_phase='resumable'
      AND active_dispatch_count=dispatch_count`,
  ),
  campaignDispatchStarted: statement(
    'supervisor-state.campaign-dispatch-started.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      active_dispatch_phase='started',updated_at=?
      WHERE campaign_id=? AND active_dispatch_count=?
      AND active_dispatch_lease_generation=? AND active_dispatch_phase='reserved'`,
  ),
  campaignDispatchRecoveryPending: statement(
    'supervisor-state.campaign-dispatch-recovery-pending.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      active_dispatch_phase='recovery_pending',updated_at=?
      WHERE campaign_id=? AND active_dispatch_count=?
      AND active_dispatch_lease_generation=?
      AND active_dispatch_phase IN ('started','recovery_pending')`,
  ),
  campaignDispatchRecoveryResolved: statement(
    'supervisor-state.campaign-dispatch-recovery-resolved.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      active_dispatch_phase='resumable',updated_at=?
      WHERE campaign_id=? AND active_dispatch_count=?
      AND active_dispatch_phase='recovery_pending'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL`,
  ),
  campaignDispatchRecoveryFailed: statement(
    'supervisor-state.campaign-dispatch-recovery-failed.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      active_dispatch_phase=NULL,active_dispatch_count=NULL,
      active_dispatch_lease_generation=NULL,active_dispatch_reservation_hash=NULL,
      next_dispatch_at=?,last_error=?,updated_at=?
      WHERE campaign_id=? AND active_dispatch_count=?
      AND active_dispatch_phase='recovery_pending'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL`,
  ),
  campaignCanaryRecoveryFinish: statement(
    'supervisor-state.campaign-canary-recovery-finish.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      last_provider_canary_status=?,last_provider_canary_receipt_hash=?,last_error=?,
      updated_at=? WHERE campaign_id=? AND active_dispatch_count=?
      AND active_dispatch_phase='recovery_pending'
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL`,
  ),
  campaignDispatchInfrastructureCancel: statement(
    'supervisor-state.campaign-dispatch-infrastructure-cancel.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      dispatch_count=dispatch_count-1,active_dispatch_phase=NULL,
      active_dispatch_count=NULL,active_dispatch_lease_generation=NULL,
      active_dispatch_reservation_hash=NULL,updated_at=?
      WHERE campaign_id=? AND lease_owner=? AND lease_token=?
      AND lease_generation=? AND dispatch_count=? AND dispatch_count>0
      AND active_dispatch_phase='reserved' AND active_dispatch_count=?
      AND active_dispatch_lease_generation=?
      AND NOT EXISTS(
        SELECT 1 FROM autonomous_research_supervisor_external_action_journal
        WHERE campaign_id=? AND dispatch_count=?
      )`,
  ),
  campaignExternalInfrastructureCancel: statement(
    'supervisor-state.campaign-external-infrastructure-cancel.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      dispatch_count=dispatch_count-1,active_dispatch_phase=NULL,
      active_dispatch_count=NULL,active_dispatch_lease_generation=NULL,
      active_dispatch_reservation_hash=NULL,updated_at=?
      WHERE campaign_id=? AND lease_owner=? AND lease_token=?
      AND lease_generation=? AND dispatch_count=? AND dispatch_count>0
      AND active_dispatch_phase='reserved' AND active_dispatch_count=?
      AND active_dispatch_lease_generation=?
      AND NOT EXISTS(
        SELECT 1 FROM autonomous_research_supervisor_external_action_journal
        WHERE campaign_id=? AND dispatch_count=? AND attempt_id<>?
      )`,
  ),
  campaignDispatchFinish: statement(
    'supervisor-state.campaign-dispatch-finish.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      disposition=?,observed_campaign_cost_usd=max(observed_campaign_cost_usd,?),
      observed_qualification_reserved_cost_usd=max(observed_qualification_reserved_cost_usd,?),
      cost_known=?,consecutive_failures=?,next_dispatch_at=?,last_outcome_json=?,
      last_error=?,terminal_reason=?,lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,active_dispatch_phase=NULL,active_dispatch_count=NULL,
      active_dispatch_lease_generation=NULL,active_dispatch_reservation_hash=NULL,
      updated_at=? WHERE campaign_id=? AND lease_owner=?
      AND lease_token=? AND lease_generation=?`,
  ),
  campaignDispatchFallback: statement(
    'supervisor-state.campaign-dispatch-fallback.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      disposition=?,cost_known=0,consecutive_failures=?,next_dispatch_at=?,last_outcome_json=?,
      last_error=?,terminal_reason=?,lease_owner=NULL,lease_token=NULL,
      lease_expires_at=NULL,active_dispatch_phase=NULL,active_dispatch_count=NULL,
      active_dispatch_lease_generation=NULL,active_dispatch_reservation_hash=NULL,
      updated_at=? WHERE campaign_id=? AND lease_owner=?
      AND lease_token=? AND lease_generation=?`,
  ),
  campaignLeaseRelease: statement(
    'supervisor-state.campaign-lease-release.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
      WHERE campaign_id=? AND lease_owner=? AND lease_token=? AND lease_generation=?`,
  ),
  campaignCanaryReserve: statement(
    'supervisor-state.campaign-canary-reserve.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      provider_canary_count=provider_canary_count+1,
      provider_canary_reserved_cost_usd=?,last_provider_canary_at=?,
      last_provider_canary_status='in_progress',last_provider_canary_receipt_hash=NULL,
      updated_at=? WHERE campaign_id=?`,
  ),
  campaignCanaryFinish: statement(
    'supervisor-state.campaign-canary-finish.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      last_provider_canary_status=?,last_provider_canary_receipt_hash=?,last_error=?,
      updated_at=? WHERE campaign_id=? AND lease_owner=? AND lease_token=?
      AND lease_generation=?`,
  ),
  campaignCanaryInfrastructureCancel: statement(
    'supervisor-state.campaign-canary-infrastructure-cancel.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      dispatch_count=dispatch_count-1,active_dispatch_phase=NULL,
      active_dispatch_count=NULL,active_dispatch_lease_generation=NULL,
      active_dispatch_reservation_hash=NULL,provider_canary_count=?,
      provider_canary_reserved_cost_usd=?,last_provider_canary_at=?,
      last_provider_canary_status=?,last_provider_canary_receipt_hash=?,updated_at=?
      WHERE campaign_id=? AND lease_owner=? AND lease_token=? AND lease_generation=?
      AND dispatch_count=? AND provider_canary_count=? AND dispatch_count>0
      AND active_dispatch_phase='reserved' AND active_dispatch_count=dispatch_count
      AND active_dispatch_lease_generation=lease_generation`,
  ),
  campaignStaleDispatchCancel: statement(
    'supervisor-state.campaign-stale-dispatch-cancel.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      dispatch_count=dispatch_count-1,active_dispatch_phase=NULL,
      active_dispatch_count=NULL,active_dispatch_lease_generation=NULL,
      active_dispatch_reservation_hash=NULL,updated_at=?
      WHERE campaign_id=? AND dispatch_count=? AND dispatch_count>0
      AND active_dispatch_count=? AND active_dispatch_lease_generation=?
      AND active_dispatch_phase='reserved'`,
  ),
  campaignStaleProviderCancel: statement(
    'supervisor-state.campaign-stale-provider-cancel.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      dispatch_count=dispatch_count-1,active_dispatch_phase=NULL,
      active_dispatch_count=NULL,active_dispatch_lease_generation=NULL,
      active_dispatch_reservation_hash=NULL,provider_canary_count=?,
      provider_canary_reserved_cost_usd=?,last_provider_canary_at=?,
      last_provider_canary_status=?,last_provider_canary_receipt_hash=?,updated_at=?
      WHERE campaign_id=? AND dispatch_count=? AND provider_canary_count=?
      AND active_dispatch_count=? AND active_dispatch_lease_generation=?
      AND active_dispatch_phase='reserved' AND dispatch_count>0`,
  ),
  campaignCanaryInterrupted: statement(
    'supervisor-state.campaign-canary-interrupted.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_campaign SET
      last_provider_canary_status='failed_unattributed',
      last_provider_canary_receipt_hash=NULL,last_error=?
      WHERE campaign_id=? AND last_provider_canary_status='in_progress'`,
  ),
  externalStart: statement(
    'supervisor-state.external-start.apply.v1',
    'run',
    `INSERT INTO autonomous_research_supervisor_external_action_journal(
      attempt_id,campaign_id,action_kind,reservation_hash,idempotency_key,
      lease_generation,dispatch_count,
      provider_canary_count,status,marker_json,marker_hash,started_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ),
  externalProgress: statement(
    'supervisor-state.external-progress.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_external_action_journal SET
      progress_json=?,progress_hash=? WHERE attempt_id=? AND status='in_progress'`,
  ),
  externalFinish: statement(
    'supervisor-state.external-finish.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_external_action_journal SET
      status=?,receipt_json=?,receipt_hash=?,completed_at=?
      WHERE attempt_id=? AND status='in_progress'`,
  ),
  externalRecoveryResult: statement(
    'supervisor-state.external-recovery-result.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_external_action_journal SET
      recovery_result_json=?,recovery_result_hash=?
      WHERE attempt_id=? AND status IN ('completed','failed')`,
  ),
  externalRecover: statement(
    'supervisor-state.external-recover.apply.v1',
    'run',
    `UPDATE autonomous_research_supervisor_external_action_journal SET
      status='recovered_incomplete',receipt_json=?,receipt_hash=?,completed_at=?
      WHERE attempt_id=? AND status='in_progress'`,
  ),
});

const COMMON_ROW = Object.freeze([S.campaignGet, S.externalActiveGet]);
const EXTERNAL_FENCE = Object.freeze([
  ...COMMON_ROW, S.externalAttemptGet, S.externalIdempotencyGet,
]);
const RECOVERY = Object.freeze([
  S.externalRecover, S.campaignCanaryInterrupted,
]);

export const AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS = Object.freeze({
  'supervisor-state.supervisor-external-action-repository-support.beginExternalActionAttempt.v1': operation(
    'supervisor-state.supervisor-external-action-repository-support.beginExternalActionAttempt.v1',
    [...COMMON_ROW, S.externalStart, S.externalAttemptGet, S.externalIdempotencyGet],
  ),
  'supervisor-state.supervisor-external-action-repository-support.cancelInfrastructureDeferred.v1': operation(
    'supervisor-state.supervisor-external-action-repository-support.cancelInfrastructureDeferred.v1',
    [...EXTERNAL_FENCE,
      S.externalFinish, S.campaignExternalInfrastructureCancel],
  ),
  'supervisor-state.supervisor-external-action-repository-support.finishExternalActionAttempt.v1': operation(
    'supervisor-state.supervisor-external-action-repository-support.finishExternalActionAttempt.v1',
    [...EXTERNAL_FENCE, S.externalFinish],
  ),
  'supervisor-state.supervisor-external-action-repository-support.recordExternalActionProgress.v1': operation(
    'supervisor-state.supervisor-external-action-repository-support.recordExternalActionProgress.v1',
    [...EXTERNAL_FENCE, S.externalProgress, S.campaignDispatchStarted],
  ),
  'supervisor-state.supervisor-provider-canary-state-operations.beginProviderCanary.v1': operation(
    'supervisor-state.supervisor-provider-canary-state-operations.beginProviderCanary.v1',
    [...COMMON_ROW, S.campaignBlock, S.campaignCanaryReserve,
      S.externalStart, S.externalAttemptGet, S.externalIdempotencyGet],
  ),
  'supervisor-state.supervisor-provider-canary-state-operations.finishProviderCanary.v1': operation(
    'supervisor-state.supervisor-provider-canary-state-operations.finishProviderCanary.v1',
    [...EXTERNAL_FENCE, S.externalFinish, S.campaignCanaryFinish],
  ),
  'supervisor-state.supervisor-provider-canary-state-operations.cancelProviderCanaryInfrastructureDeferred.v1': operation(
    'supervisor-state.supervisor-provider-canary-state-operations.cancelProviderCanaryInfrastructureDeferred.v1',
    [...EXTERNAL_FENCE, S.externalFinish, S.campaignCanaryInfrastructureCancel],
  ),
  'supervisor-state.supervisor-state-repository.beginDispatch.v1': operation(
    'supervisor-state.supervisor-state-repository.beginDispatch.v1',
    [...COMMON_ROW, S.campaignBlock, S.campaignDispatchBegin, S.campaignDispatchResume],
  ),
  'supervisor-state.supervisor-state-repository.cancelDispatchInfrastructureDeferred.v1': operation(
    'supervisor-state.supervisor-state-repository.cancelDispatchInfrastructureDeferred.v1',
    [...COMMON_ROW, S.campaignDispatchInfrastructureCancel],
  ),
  'supervisor-state.supervisor-state-repository.finishDispatch.v1': operation(
    'supervisor-state.supervisor-state-repository.finishDispatch.v1',
    [...COMMON_ROW, S.campaignDispatchFinish],
  ),
  'supervisor-state.supervisor-state-repository.finishDispatchFailureFallback.v1': operation(
    'supervisor-state.supervisor-state-repository.finishDispatchFailureFallback.v1',
    [...COMMON_ROW, ...RECOVERY, S.campaignDispatchFallback],
  ),
  'supervisor-state.supervisor-state-repository.markDispatchStarted.v1': operation(
    'supervisor-state.supervisor-state-repository.markDispatchStarted.v1',
    [...COMMON_ROW, S.campaignDispatchStarted],
  ),
  'supervisor-state.supervisor-state-repository.reconcileStaleLeases.v1': operation(
    'supervisor-state.supervisor-state-repository.reconcileStaleLeases.v1',
    [...COMMON_ROW, S.dispatchStaleAll, S.externalStaleAll, S.externalFinish,
      S.campaignStaleDispatchCancel, S.campaignStaleProviderCancel,
      S.campaignDispatchRecoveryPending, S.campaignReconcile],
  ),
  'supervisor-state.supervisor-state-repository.resolveExternalActionRecovery.v1': operation(
    'supervisor-state.supervisor-state-repository.resolveExternalActionRecovery.v1',
    [...EXTERNAL_FENCE, S.externalFinish, S.externalRecoveryResult, S.campaignCanaryFinish,
      S.campaignCanaryRecoveryFinish, S.campaignDispatchRecoveryResolved,
      S.campaignDispatchRecoveryFailed],
  ),
  'supervisor-state.supervisor-state-repository.registerCampaign.v1': operation(
    'supervisor-state.supervisor-state-repository.registerCampaign.v1',
    [...COMMON_ROW, S.campaignRegister],
  ),
  'supervisor-state.supervisor-state-repository.releaseCampaignLease.v1': operation(
    'supervisor-state.supervisor-state-repository.releaseCampaignLease.v1',
    [...COMMON_ROW, S.campaignLeaseRelease],
  ),
  'supervisor-state.supervisor-state-repository.renewCampaignLease.v1': operation(
    'supervisor-state.supervisor-state-repository.renewCampaignLease.v1',
    [S.campaignLeaseRenew],
  ),
  'supervisor-state.supervisor-state-repository.tryAcquireCampaignLease.v1': operation(
    'supervisor-state.supervisor-state-repository.tryAcquireCampaignLease.v1',
    [...COMMON_ROW, ...RECOVERY, S.campaignRecovered, S.campaignDeadlineBlock,
      S.campaignLeaseAcquire],
  ),
});

export const AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID,
    operationPlans: Object.values(AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS),
  });

export function createOfflineSupervisorStateMutationCoordinator({
  operationPlans = AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_MUTATION_PLANS,
  databaseInstanceId = AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_DATABASE_INSTANCE_ID,
  schemaContractId = AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID,
} = {}) {
  return createOfflineExternallyFencedSqliteMutationCoordinator({
    operationPlans,
    databaseRole: AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_DATABASE_ROLE,
    databaseInstanceId,
    schemaContractId,
    writerId,
    inputInvalidError:
      'autonomous_research_supervisor_state_offline_mutation_input_invalid',
    asyncMutationError:
      'autonomous_research_supervisor_state_async_mutation_forbidden',
    recoveryUnavailableError:
      'autonomous_research_supervisor_state_offline_recovery_unavailable',
    statusBlocker:
      'autonomous_research_supervisor_state_external_mutation_coordinator_required',
    receiptKind: 'OfflineSupervisorStateMutationReceipt',
  });
}
