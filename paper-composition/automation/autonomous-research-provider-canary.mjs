import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { preflightCodexResearchAuthor } from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import { probeCodexModelAvailability } from '../../paper-adapters/automation/codex-runtime-preflight.mjs';
import {
  requireAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';
import {
  attachAutonomousResearchProviderCanarySideEffectInspection,
  providerCanaryAction,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';
import {
  assertAutonomousResearchStateRecoverabilityReady,
} from '../../paper-application/automation/autonomous-research-state-recoverability-controller.mjs';
import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-journal.mjs';

export async function runAutonomousResearchProviderCanaryPair({
  providerConfiguration,
  expectedProviderConfigurationHash = null,
  environment = {},
  signal = null,
  clock = { now: () => new Date() },
  spawnSyncImpl = spawnSync,
  preflightAuthor = preflightCodexResearchAuthor,
  preflightReviewer = preflightCodexFormalReviewer,
  probeModelAvailability = probeCodexModelAvailability,
  betweenCanaryChecks = null,
  beforePreflightAction = null,
  beforeCanaryAction = null,
  afterCanaryAction = null,
  onExternalSideEffectStarted = null,
  providerCanaryReservation = null,
} = {}) {
  const configuration = requireAutonomousResearchProviderConfiguration(
    providerConfiguration,
    { expectedHash: expectedProviderConfigurationHash },
  );
  const authorConfiguration = configuration.researchAuthor;
  const reviewerConfiguration = configuration.formalReviewer;
  const actions = [];
  let failurePhase = 'provider_canary_preflight';
  const notify = async (callback, value) => {
    if (callback === null) return;
    if (typeof callback !== 'function') {
      throw new Error('autonomous_research_provider_canary_action_journal_invalid');
    }
    await callback(value);
  };
  const markExternalSideEffectStarted = async (value) => {
    if (onExternalSideEffectStarted === null) return;
    if (typeof onExternalSideEffectStarted !== 'function') {
      throw new Error('autonomous_research_provider_canary_side_effect_marker_invalid');
    }
    await onExternalSideEffectStarted(value);
  };
  try {
    if (signal?.aborted) throw new Error(String(signal.reason || 'provider_canary_aborted'));
    await notify(beforePreflightAction, {
      role: 'research_author_preflight',
      failurePhase: 'research_author_preflight',
    });
    await markExternalSideEffectStarted({ role: 'research_author_preflight' });
    const author = preflightAuthor({
      ...authorConfiguration,
      environment,
      spawnSyncImpl,
    });
    await notify(beforePreflightAction, {
      role: 'formal_reviewer_preflight',
      failurePhase: 'formal_reviewer_preflight',
    });
    await markExternalSideEffectStarted({ role: 'formal_reviewer_preflight' });
    const reviewer = preflightReviewer({
      ...reviewerConfiguration,
      authorProvider: authorConfiguration.provider,
      authorCodexHome: author.codexHome,
      environment,
      spawnSyncImpl,
    });
    let authorCanary;
    failurePhase = 'research_author_canary';
    await notify(beforeCanaryAction, { role: 'research_author', failurePhase });
    await markExternalSideEffectStarted({ role: 'research_author' });
    try {
      authorCanary = probeModelAvailability({
        ...authorConfiguration,
        errorPrefix: 'autonomous_research_supervisor_author_canary',
        environment,
        spawnSyncImpl,
        clock,
      });
    } catch (error) {
      const action = providerCanaryAction({ role: 'research_author', error });
      actions.push(action);
      await notify(afterCanaryAction, { action, failurePhase });
      throw error;
    }
    const authorAction = providerCanaryAction({ role: 'research_author', receipt: authorCanary });
    actions.push(authorAction);
    await notify(afterCanaryAction, { action: authorAction, failurePhase });
    failurePhase = 'between_role_fence';
    await betweenCanaryChecks?.({ phase: 'author_canary_verified', authorCanary });
    if (signal?.aborted) throw new Error(String(signal.reason || 'provider_canary_aborted'));
    let reviewerCanary;
    failurePhase = 'formal_reviewer_canary';
    await notify(beforeCanaryAction, { role: 'formal_reviewer', failurePhase });
    await markExternalSideEffectStarted({ role: 'formal_reviewer' });
    try {
      reviewerCanary = probeModelAvailability({
        ...reviewerConfiguration,
        errorPrefix: 'autonomous_research_supervisor_reviewer_canary',
        environment,
        spawnSyncImpl,
        clock,
      });
    } catch (error) {
      const action = providerCanaryAction({ role: 'formal_reviewer', error });
      actions.push(action);
      await notify(afterCanaryAction, { action, failurePhase });
      throw error;
    }
    const reviewerAction = providerCanaryAction({
      role: 'formal_reviewer',
      receipt: reviewerCanary,
    });
    actions.push(reviewerAction);
    await notify(afterCanaryAction, { action: reviewerAction, failurePhase });
    failurePhase = 'post_canary_signal_fence';
    if (signal?.aborted) throw new Error(String(signal.reason || 'provider_canary_aborted'));
    const observed = clock?.now ? clock.now() : new Date();
    const observedAt = observed instanceof Date ? observed : new Date(observed);
    if (!Number.isFinite(observedAt.getTime())) {
      throw new Error('autonomous_research_supervisor_provider_canary_clock_invalid');
    }
    const payload = Object.freeze({
      version: 1,
      kind: 'AutonomousResearchProviderCanaryPairReceipt',
      status: 'autonomous_research_provider_canary_pair_verified',
      verified: true,
      autonomousResearchProviderConfigurationHash:
        configuration.autonomousResearchProviderConfigurationHash,
      researchAuthorCapabilityReceiptHash:
        author.capabilityReceipt?.codexResearchAuthorCapabilityReceiptHash || null,
      formalReviewerCapabilityReceiptHash:
        reviewer.capabilityReceipt?.codexFormalReviewerCapabilityReceiptHash || null,
      researchAuthorProviderCanaryReceiptHash:
        authorCanary?.codexModelAvailabilityCanaryReceiptHash || null,
      formalReviewerProviderCanaryReceiptHash:
        reviewerCanary?.codexModelAvailabilityCanaryReceiptHash || null,
      researchAuthorProviderCanaryReceipt: authorCanary,
      formalReviewerProviderCanaryReceipt: reviewerCanary,
      observedAt: observedAt.toISOString(),
      freshnessIntervalMs: 15 * 60 * 1000,
      externalActionPerformed: true,
      externalActionScope: 'two_read_only_ephemeral_model_canaries',
    });
    return Object.freeze({
      ...payload,
      providerCanaryPairReceiptHash: hashRecord(
        'AutonomousResearchProviderCanaryPairReceipt',
        payload,
      ),
    });
  } catch (error) {
    if (!providerCanaryReservation) throw error;
    throw attachAutonomousResearchProviderCanarySideEffectInspection(error, {
      providerConfigurationHash: configuration.autonomousResearchProviderConfigurationHash,
      reservation: providerCanaryReservation,
      actions,
      failurePhase,
    });
  }
}

export function createFencedAutonomousResearchProviderCanary({
  stateRepository,
  providerConfiguration,
  environment,
  clock,
  providerCanaryRunner = runAutonomousResearchProviderCanaryPair,
  stateRecoverabilityController = null,
  onlineAuthorityEvidenceController = null,
} = {}) {
  if (typeof stateRepository?.assertCampaignLease !== 'function'
    || typeof stateRepository?.renewCampaignLease !== 'function'
    || typeof stateRepository?.recordExternalActionProgress !== 'function'
    || typeof providerCanaryRunner !== 'function'
    || typeof clock?.now !== 'function') {
    throw new Error('autonomous_research_supervisor_provider_canary_dependencies_invalid');
  }
  return async function fencedProviderCanary({
    campaign,
    supervisorLease,
    providerCanaryReservation,
    externalActionAttempt,
    residentLeaseContext = null,
    onExternalSideEffectStarted = null,
    signal: canarySignal,
  } = {}) {
    let durableExternalActionMayHaveStarted = false;
    const reconcileInfrastructure = async (action) => {
      if (onlineAuthorityEvidenceController) {
        const requiredValidityMs =
          onlineAuthorityEvidenceController.policy?.renewalLeadMs || 0;
        const reconciled = onlineAuthorityEvidenceController.reconcile({
          residentLeaseContext,
          requiredValidityMs,
        });
        if (reconciled?.ready !== true) {
          onlineAuthorityEvidenceController.assertCurrent({
            requiredValidityMs,
            action,
          });
        }
      }
      if (stateRecoverabilityController) {
        const recovery = await stateRecoverabilityController.reconcile({
          residentLeaseContext,
        });
        assertAutonomousResearchStateRecoverabilityReady(recovery, { action });
      }
    };
    const assertInfrastructureCurrent = (action) => {
      onlineAuthorityEvidenceController?.assertCurrent({
        requiredValidityMs: 0,
        action,
      });
      stateRecoverabilityController?.assertCurrent({ action });
    };
    const persistedHash = campaign?.spec?.autonomousResearchPreparation
      ?.autonomousResearchProviderConfigurationHash || null;
    if (!persistedHash
      || persistedHash !== providerConfiguration?.autonomousResearchProviderConfigurationHash) {
      throw new Error('autonomous_research_provider_configuration_hash_mismatch');
    }
    stateRepository.assertCampaignLease({ lease: supervisorLease, now: clock.now() });
    if (!stateRepository.renewCampaignLease({
      lease: supervisorLease,
      leaseMs: 15 * 60 * 1000,
      now: clock.now(),
    })) throw new Error('autonomous_research_supervisor_lease_lost');
    await reconcileInfrastructure('provider_canary_after_lease_renewal');
    assertInfrastructureCurrent('provider_canary_research_author_side_effect');
    const receipt = await providerCanaryRunner({
      providerConfiguration,
      expectedProviderConfigurationHash: persistedHash,
      environment,
      signal: canarySignal,
      clock,
      providerCanaryReservation,
      onExternalSideEffectStarted: async (value = {}) => {
        if (!durableExternalActionMayHaveStarted) {
          stateRepository.recordExternalActionProgress({
            lease: supervisorLease,
            attempt: externalActionAttempt,
            evidence: Object.freeze({
              version: 1,
              kind: 'AutonomousResearchSupervisorExternalActionMayHaveStarted',
              actionKind:
                AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_KINDS.PROVIDER_CANARY,
              attemptId: externalActionAttempt.attemptId,
              reservationHash: externalActionAttempt.reservationHash,
              externalActionMayHaveStarted: true,
            }),
            now: clock.now(),
          });
          durableExternalActionMayHaveStarted = true;
        }
        await onExternalSideEffectStarted?.({
          ...value,
          durableExternalActionMayHaveStarted: true,
        });
        await reconcileInfrastructure(
          `provider_canary_started:${value.role || 'unspecified'}`,
        );
        assertInfrastructureCurrent(
          `provider_canary_started:${value.role || 'unspecified'}`,
        );
      },
      beforePreflightAction: async ({ role = 'unspecified' } = {}) => {
        await reconcileInfrastructure(`provider_canary_before_${role}`);
        assertInfrastructureCurrent(`provider_canary_before_${role}`);
      },
      async beforeCanaryAction({ role = 'unspecified' } = {}) {
        await reconcileInfrastructure(`provider_canary_before_${role}`);
        assertInfrastructureCurrent(`provider_canary_before_${role}`);
      },
      async betweenCanaryChecks({ authorCanary } = {}) {
        stateRepository.assertCampaignLease({ lease: supervisorLease, now: clock.now() });
        if (!stateRepository.renewCampaignLease({
          lease: supervisorLease,
          leaseMs: 15 * 60 * 1000,
          now: clock.now(),
        })) throw new Error('autonomous_research_supervisor_lease_lost');
        stateRepository.recordExternalActionProgress({
          lease: supervisorLease,
          attempt: externalActionAttempt,
          evidence: Object.freeze({
            version: 1,
            kind: 'AutonomousResearchSupervisorProviderCanaryProgress',
            role: 'research_author',
            providerConfigurationHash: persistedHash,
            providerCanaryReceiptHash:
              authorCanary?.codexModelAvailabilityCanaryReceiptHash || null,
          }),
          now: clock.now(),
        });
        await reconcileInfrastructure('provider_canary_between_roles');
        assertInfrastructureCurrent('provider_canary_formal_reviewer_side_effect');
      },
    });
    stateRepository.assertCampaignLease({ lease: supervisorLease, now: clock.now() });
    return receipt;
  };
}
