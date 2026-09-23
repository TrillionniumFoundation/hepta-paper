import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateExternallyFencedSqliteMutationCoordinatorConfiguration } from './externally-fenced-sqlite-mutation-coordinator-configuration.mjs';
import { createAutonomousResearchSupervisorExternalActionRepositorySupport } from './autonomous-research-supervisor-external-action-repository-support.mjs';
import {
  autonomousResearchStateMutationValue,
  buildAutonomousResearchStateMutationInput,
} from './autonomous-research-state-mutation-support.mjs';
import { createAutonomousResearchSupervisorDispatchStateOperations } from './autonomous-research-supervisor-dispatch-state-operations.mjs';
import { autonomousResearchSupervisorProviderCanaryProgressEvidenceValid, autonomousResearchSupervisorProviderCanarySuccessEvidenceValid, createAutonomousResearchSupervisorProviderCanaryStateOperations } from './autonomous-research-supervisor-provider-canary-state-operations.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID,
  createOfflineSupervisorStateMutationCoordinator,
} from './autonomous-research-supervisor-state-mutation-plan.mjs';
import { provisionAutonomousResearchSupervisorStateDatabase } from './autonomous-research-supervisor-state-provisioning.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';
import {
  autonomousResearchSupervisorLeaseIdentity as leaseIdentity,
  autonomousResearchSupervisorTimestamp as timestamp,
  boundedAutonomousResearchSupervisorInteger as integer,
  mapAutonomousResearchSupervisorStateRow as mapRow,
  normalizeAutonomousResearchSupervisorLifecyclePolicy,
} from './autonomous-research-supervisor-state-model.mjs';
import {
  reconcileAutonomousResearchSupervisorStaleDispatchesInTransaction,
} from './autonomous-research-supervisor-stale-dispatch-recovery.mjs';
export { normalizeAutonomousResearchSupervisorLifecyclePolicy };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const TERMINAL = new Set(['blocked', 'settled']);
export function createAutonomousResearchSupervisorStateRepository({
  runtimeRoot,
  busyTimeoutMs = 10_000,
  offlineProvision = true,
  mutationCoordinator = null,
  databaseInstanceId = AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_DATABASE_INSTANCE_ID,
  schemaContractId = AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_SCHEMA_CONTRACT_ID,
  writerId = AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_WRITER_ID,
  requireExternallyFencedMutations = false,
} = {}) {
  if (!runtimeRoot) throw new Error('autonomous_research_supervisor_runtime_root_required');
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000
    || typeof offlineProvision !== 'boolean'
    || typeof requireExternallyFencedMutations !== 'boolean'
    || !SAFE_ID.test(String(databaseInstanceId || ''))
    || !SAFE_ID.test(String(schemaContractId || ''))
    || !SAFE_ID.test(String(writerId || ''))) {
    throw new Error('autonomous_research_supervisor_state_repository_configuration_invalid');
  }
  let coordinator = validateExternallyFencedSqliteMutationCoordinatorConfiguration({
    mutationCoordinator,
    requireExternallyFencedMutations,
    offlineProvision,
    databaseRole: 'supervisor-state',
    requiredErrorCode:
      'autonomous_research_supervisor_state_external_mutation_coordinator_required',
  });
  coordinator ||= createOfflineSupervisorStateMutationCoordinator({
    databaseInstanceId, schemaContractId, writerId,
  });
  const stateRoot = path.join(path.resolve(runtimeRoot), 'autonomous-research', 'supervisor');
  const databasePath = path.join(stateRoot, 'supervisor-state.sqlite');
  if (offlineProvision) {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
  } else if (!fs.existsSync(databasePath)) {
    throw new Error('autonomous_research_supervisor_state_offline_provisioning_required');
  }
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
  if (offlineProvision) {
    provisionAutonomousResearchSupervisorStateDatabase({ database, databasePath });
  }
  let closed = false;

  function requireOpen() {
    if (closed) throw new Error('autonomous_research_supervisor_state_repository_closed');
  }

  let externalActionSupport = null;

  function row(campaignId, transaction = null) {
    requireOpen();
    const campaign = mapRow(transaction
      ? transaction.get('supervisor-state.campaign.get.v1', campaignId)
      : database.prepare(
        'SELECT * FROM autonomous_research_supervisor_campaign WHERE campaign_id=?',
      ).get(campaignId));
    if (!campaign) return null;
    const activeExternalAction = externalActionSupport?.activeAttemptForCampaign(
      campaignId, transaction,
    ) || null;
    if (activeExternalAction && (
      activeExternalAction.dispatchCount > campaign.dispatchCount
      || activeExternalAction.providerCanaryCount > campaign.providerCanaryCount
      || activeExternalAction.leaseGeneration > campaign.leaseGeneration
    )) throw new Error('autonomous_research_supervisor_external_action_journal_invalid');
    return Object.freeze({
      ...campaign,
      externalActionInProgress: Boolean(activeExternalAction),
      activeExternalActionAttempt: activeExternalAction,
    });
  }

  function fencedRow(identity, now, transaction = null) {
    const current = row(identity.campaignId, transaction);
    if (!current || current.leaseOwner !== identity.ownerId
      || current.leaseToken !== identity.leaseToken
      || current.leaseGeneration !== identity.leaseGeneration
      || Date.parse(current.leaseExpiresAt || '') <= now.getTime()) {
      throw new Error('autonomous_research_supervisor_lease_lost');
    }
    return current;
  }

  const mutationValue = autonomousResearchStateMutationValue;
  const mutationInput = buildAutonomousResearchStateMutationInput({
    database,
    databaseInstanceId,
    schemaContractId,
    writerId,
  });

  externalActionSupport = createAutonomousResearchSupervisorExternalActionRepositorySupport({
    database,
    mutationCoordinator: coordinator,
    databaseInstanceId,
    schemaContractId,
    writerId,
    requireOpen,
    fencedRow,
    leaseIdentity,
    timestamp,
    providerCanarySuccessEvidenceValid:
      autonomousResearchSupervisorProviderCanarySuccessEvidenceValid,
    providerCanaryProgressEvidenceValid:
      autonomousResearchSupervisorProviderCanaryProgressEvidenceValid,
    requireExternallyFencedMutations,
  });
  const providerCanaryOperations =
    createAutonomousResearchSupervisorProviderCanaryStateOperations({
      database,
      mutationCoordinator: coordinator,
      databaseInstanceId,
      schemaContractId,
      writerId,
      journalSupport: externalActionSupport,
      requireOpen,
      row,
      fencedRow,
      leaseIdentity,
      timestamp,
      requireExternallyFencedMutations,
    });
  const dispatchOperations = createAutonomousResearchSupervisorDispatchStateOperations({
    mutationCoordinator: coordinator,
    mutationInput,
    requireOpen,
    fencedRow,
    row,
    mutationValue,
    externalActionSupport,
  });

  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorStateRepository',
    durable: true,
    sqliteCompareAndSwap: true,
    offlineProvisioningPerformed: offlineProvision,
    externallyFencedMutations: coordinator.implemented === true,
    externallyFencedMutationsRequired: requireExternallyFencedMutations,
    databaseInstanceId,
    schemaContractId,
    writerId,
    databasePath,
    registerCampaign({ campaignId, paperId, policy: suppliedPolicy = {}, now = new Date() } = {}) {
      requireOpen();
      if (!SAFE_ID.test(String(campaignId || '')) || !SAFE_ID.test(String(paperId || ''))) {
        throw new Error('autonomous_research_supervisor_campaign_scope_invalid');
      }
      const policy = normalizeAutonomousResearchSupervisorLifecyclePolicy(suppliedPolicy);
      const observedAt = timestamp(now);
      return mutationValue(coordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId: 'supervisor-state.supervisor-state-repository.registerCampaign.v1',
        mutate(transaction) {
          const existing = row(campaignId, transaction);
          if (existing) {
            if (existing.paperId !== paperId
              || existing.policy.lifecyclePolicyHash !== policy.lifecyclePolicyHash) {
              throw new Error('autonomous_research_supervisor_lifecycle_policy_immutable');
            }
            return existing;
          }
          transaction.run(
            'supervisor-state.campaign-register.apply.v1',
            String(campaignId),
            String(paperId),
            'active',
            JSON.stringify(policy),
            policy.lifecyclePolicyHash,
            observedAt.toISOString(),
            new Date(observedAt.getTime() + policy.maximumLifetimeMs).toISOString(),
            observedAt.toISOString(),
            observedAt.toISOString(),
            observedAt.toISOString(),
          );
          return row(campaignId, transaction);
        },
      }));
    },
    getCampaign: row,
    listCampaigns({ disposition = null, limit = 1000 } = {}) {
      requireOpen();
      const bounded = Math.max(1, Math.min(10_000, Number(limit || 1000)));
      const rows = disposition
        ? database.prepare(`SELECT * FROM autonomous_research_supervisor_campaign
          WHERE disposition=? ORDER BY next_dispatch_at,campaign_id LIMIT ?`).all(disposition, bounded)
        : database.prepare(`SELECT * FROM autonomous_research_supervisor_campaign
          ORDER BY next_dispatch_at,campaign_id LIMIT ?`).all(bounded);
      return Object.freeze(rows.map((item) => row(item.campaign_id)));
    },
    reconcileStaleLeases({ now = new Date() } = {}) {
      requireOpen();
      const observed = timestamp(now);
      const observedAt = observed.toISOString();
      return mutationValue(coordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-state-repository.reconcileStaleLeases.v1',
        mutate(transaction) {
        const result = transaction.run(
          'supervisor-state.campaign-reconcile.apply.v1',
          observedAt,
          observedAt,
        );
        const dispatchRecovery =
          reconcileAutonomousResearchSupervisorStaleDispatchesInTransaction({
            transaction,
            observedAt: observed,
            row,
            journalSupport: externalActionSupport,
          });
        return Object.freeze({
          recoveredLeaseCount: Number(result.changes),
          recoveredExternalActionCount: dispatchRecovery.cancelledReceipts.length,
          recoveredExternalActionReceipts: dispatchRecovery.cancelledReceipts,
          cancelledInfrastructureDispatchCount:
            dispatchRecovery.cancelledDispatchCount,
          recoveryPendingExternalActionCount:
            dispatchRecovery.recoveryPendingAttempts.length,
          recoveryPendingExternalActionAttempts:
            dispatchRecovery.recoveryPendingAttempts,
          resumableDispatchCount: dispatchRecovery.resumableDispatchCount,
          reconciledAt: observedAt,
        });
        },
      }));
    },
    tryAcquireCampaignLease({ campaignId, ownerId, leaseMs, now = new Date() } = {}) {
      requireOpen();
      if (!SAFE_ID.test(String(campaignId || '')) || !SAFE_ID.test(String(ownerId || ''))) {
        throw new Error('autonomous_research_supervisor_lease_scope_invalid');
      }
      const observedAt = timestamp(now);
      const duration = integer(
        leaseMs,
        15 * 60 * 1000,
        15 * 60 * 1000,
        30 * 60 * 1000,
      );
      return mutationValue(coordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-state-repository.tryAcquireCampaignLease.v1',
        mutate(transaction) {
        let current = row(campaignId, transaction);
        const activeAttempt = current?.activeExternalActionAttempt;
        if (activeAttempt && (current.leaseGeneration !== activeAttempt.leaseGeneration
          || !current.leaseExpiresAt
          || Date.parse(current.leaseExpiresAt) <= observedAt.getTime())) {
          return null;
        }
        if (current && !TERMINAL.has(current.disposition)
          && Date.parse(current.absoluteDeadlineAt) <= observedAt.getTime()) {
          transaction.run(
            'supervisor-state.campaign-deadline-block.apply.v1',
            observedAt.toISOString(),
            campaignId,
          );
          return null;
        }
        if (!current || TERMINAL.has(current.disposition)
          || current.activeDispatchPhase === 'recovery_pending'
          || Date.parse(current.nextDispatchAt) > observedAt.getTime()
          || (current.leaseExpiresAt
            && Date.parse(current.leaseExpiresAt) > observedAt.getTime())) {
          return null;
        }
        const lease = Object.freeze({
          campaignId: current.campaignId,
          ownerId: String(ownerId),
          leaseToken: `lease:${crypto.randomUUID()}`,
          leaseGeneration: current.leaseGeneration + 1,
          expiresAt: new Date(observedAt.getTime() + duration).toISOString(),
        });
        const update = transaction.run(
          'supervisor-state.campaign-lease-acquire.apply.v1',
          lease.ownerId,
          lease.leaseToken,
          lease.leaseGeneration,
          lease.expiresAt,
          observedAt.toISOString(),
          campaignId,
          current.leaseGeneration,
        );
        if (Number(update.changes) !== 1) {
          throw new Error('autonomous_research_supervisor_lease_fence_conflict');
        }
        return lease;
        },
      }));
    },
    renewCampaignLease({ lease, leaseMs, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observedAt = timestamp(now);
      const expiresAt = new Date(observedAt.getTime()
        + integer(
          leaseMs,
          15 * 60 * 1000,
          15 * 60 * 1000,
          30 * 60 * 1000,
        )).toISOString();
      return mutationValue(coordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-state-repository.renewCampaignLease.v1',
        mutate(transaction) {
          const result = transaction.run(
            'supervisor-state.campaign-lease-renew.apply.v1',
            expiresAt,
            observedAt.toISOString(),
            identity.campaignId,
            identity.ownerId,
            identity.leaseToken,
            identity.leaseGeneration,
            observedAt.toISOString(),
          );
          return Number(result.changes) === 1
            ? Object.freeze({ ...identity, expiresAt }) : null;
        },
      }));
    },
    assertCampaignLease({ lease, now = new Date() } = {}) {
      requireOpen();
      fencedRow(leaseIdentity(lease), timestamp(now));
      return true;
    },
    beginExternalActionAttempt: externalActionSupport.beginExternalActionAttempt,
    cancelExternalActionInfrastructureDeferred:
      externalActionSupport.cancelInfrastructureDeferred,
    assertExternalActionSideEffectPermit:
      externalActionSupport.assertExternalActionSideEffectPermit,
    recordExternalActionProgress: externalActionSupport.recordExternalActionProgress,
    finishExternalActionAttempt: externalActionSupport.finishExternalActionAttempt,
    getExternalActionAttempt: externalActionSupport.getExternalActionAttempt,
    listExternalActionAttempts: externalActionSupport.listExternalActionAttempts,
    listPendingExternalActionRecoveries({ limit = 1000 } = {}) {
      requireOpen();
      const bounded = Math.max(1, Math.min(10_000, Number(limit || 1000)));
      return Object.freeze(database.prepare(`SELECT campaign_id FROM
        autonomous_research_supervisor_campaign
        WHERE active_dispatch_phase='recovery_pending'
        ORDER BY updated_at,campaign_id LIMIT ?`).all(bounded).map(({ campaign_id: id }) => {
        const current = row(id);
        const attempt = current?.activeExternalActionAttempt;
        if (!attempt?.progress || attempt.status !== 'in_progress'
          || attempt.dispatchCount !== current.activeDispatchCount) {
          throw new Error('autonomous_research_supervisor_external_action_recovery_invalid');
        }
        return Object.freeze({
          campaignId: current.campaignId,
          dispatchCount: current.activeDispatchCount,
          dispatchReservationHash: current.activeDispatchReservationHash,
          actionKind: attempt.actionKind,
          actionConfigurationIdentityHash:
            attempt.marker.reservation.externalActionConfigurationIdentityHash
              || attempt.marker.reservation.providerConfigurationHash,
          idempotencyKey: attempt.idempotencyKey,
          markerHash:
            attempt.marker.autonomousResearchSupervisorExternalActionAttemptMarkerHash,
          reservationHash: attempt.reservationHash,
          progressHash:
            attempt.progress.autonomousResearchSupervisorExternalActionProgressReceiptHash,
          marker: attempt.marker,
          progress: attempt.progress,
        });
      }));
    },
    resolveExternalActionRecovery({ resolution, now = new Date() } = {}) {
      requireOpen();
      const observedAt = timestamp(now);
      const pending = database.prepare(`SELECT campaign_id FROM
        autonomous_research_supervisor_campaign
        WHERE active_dispatch_phase='recovery_pending' ORDER BY campaign_id`).all()
        .map(({ campaign_id: id }) => row(id))
        .find((candidate) => candidate.activeExternalActionAttempt?.idempotencyKey
          === resolution?.idempotencyKey);
      if (!pending) {
        throw new Error('autonomous_research_supervisor_external_action_recovery_invalid');
      }
      return mutationValue(coordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-state-repository.resolveExternalActionRecovery.v1',
        mutate(transaction) {
          const current = row(pending.campaignId, transaction);
          const attempt = current?.activeExternalActionAttempt;
          if (current?.activeDispatchPhase !== 'recovery_pending'
            || current.leaseOwner !== null || current.leaseToken !== null
            || current.leaseExpiresAt !== null || !attempt?.progress
            || attempt.idempotencyKey !== resolution.idempotencyKey
            || current.activeDispatchCount !== attempt.dispatchCount) {
            throw new Error('autonomous_research_supervisor_external_action_recovery_invalid');
          }
          const completed = externalActionSupport.completeRecoveryInTransaction({
            transaction, attempt, resolution, observedAt,
          });
          if (attempt.actionKind
            === AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY) {
            const providerReceiptHash = completed.successful
              ? completed.evidence.providerCanaryPairReceiptHash : null;
            const provider = transaction.run(
              'supervisor-state.campaign-canary-recovery-finish.apply.v1',
              completed.successful ? 'verified' : 'failed',
              providerReceiptHash,
              completed.successful ? null
                : 'autonomous_research_supervisor_provider_canary_recovered_failure',
              observedAt.toISOString(), current.campaignId, current.activeDispatchCount,
            );
            if (Number(provider.changes) !== 1) {
              throw new Error(
                'autonomous_research_supervisor_external_action_recovery_conflict',
              );
            }
          }
          const dispatch = completed.successful
            ? transaction.run(
              'supervisor-state.campaign-dispatch-recovery-resolved.apply.v1',
              observedAt.toISOString(), current.campaignId, current.activeDispatchCount,
            )
            : transaction.run(
              'supervisor-state.campaign-dispatch-recovery-failed.apply.v1',
              observedAt.toISOString(),
              'autonomous_research_supervisor_external_action_recovered_failure',
              observedAt.toISOString(), current.campaignId, current.activeDispatchCount,
            );
          if (Number(dispatch.changes) !== 1) {
            throw new Error('autonomous_research_supervisor_external_action_recovery_conflict');
          }
          return Object.freeze({
            campaign: row(current.campaignId, transaction),
            attemptId: attempt.attemptId,
            receipt: completed.receipt,
            successful: completed.successful,
            recoveryResultHash: completed.recoveryResultHash,
          });
        },
      }));
    },
    ...dispatchOperations,
    beginProviderCanary: providerCanaryOperations.beginProviderCanary,
    assertProviderCanarySideEffectPermit:
      providerCanaryOperations.assertProviderCanarySideEffectPermit,
    finishProviderCanary: providerCanaryOperations.finishProviderCanary,
    cancelProviderCanaryInfrastructureDeferred:
      providerCanaryOperations.cancelProviderCanaryInfrastructureDeferred,
    releaseCampaignLease({ lease, now = new Date() } = {}) {
      requireOpen();
      const identity = leaseIdentity(lease);
      const observed = timestamp(now);
      return mutationValue(coordinator.executeMutation({
        ...mutationInput,
        databaseRole: 'supervisor-state',
        operationId:
          'supervisor-state.supervisor-state-repository.releaseCampaignLease.v1',
        mutate(transaction) {
        const current = fencedRow(identity, observed, transaction);
        if (current.activeExternalActionAttempt) {
          throw new Error('autonomous_research_supervisor_external_action_in_progress');
        }
        const result = transaction.run(
          'supervisor-state.campaign-lease-release.apply.v1',
          observed.toISOString(), identity.campaignId, identity.ownerId,
          identity.leaseToken, identity.leaseGeneration,
        );
        return Number(result.changes) === 1;
        },
      }));
    },
    close() {
      if (!closed) database.close();
      closed = true;
    },
  });
}
