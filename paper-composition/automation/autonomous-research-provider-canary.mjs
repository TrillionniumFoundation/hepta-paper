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

export function runAutonomousResearchProviderCanaryPair({
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
  beforeCanaryAction = null,
  afterCanaryAction = null,
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
  const notify = (callback, value) => {
    if (callback === null) return;
    if (typeof callback !== 'function') {
      throw new Error('autonomous_research_provider_canary_action_journal_invalid');
    }
    const result = callback(value);
    if (typeof result?.then === 'function') {
      throw new Error('autonomous_research_provider_canary_action_journal_must_be_synchronous');
    }
  };
  try {
    if (signal?.aborted) throw new Error(String(signal.reason || 'provider_canary_aborted'));
    const author = preflightAuthor({
      ...authorConfiguration,
      environment,
      spawnSyncImpl,
    });
    const reviewer = preflightReviewer({
      ...reviewerConfiguration,
      authorProvider: authorConfiguration.provider,
      authorCodexHome: author.codexHome,
      environment,
      spawnSyncImpl,
    });
    let authorCanary;
    failurePhase = 'research_author_canary';
    notify(beforeCanaryAction, { role: 'research_author', failurePhase });
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
      notify(afterCanaryAction, { action, failurePhase });
      throw error;
    }
    const authorAction = providerCanaryAction({ role: 'research_author', receipt: authorCanary });
    actions.push(authorAction);
    notify(afterCanaryAction, { action: authorAction, failurePhase });
    failurePhase = 'between_role_fence';
    betweenCanaryChecks?.({ phase: 'author_canary_verified', authorCanary });
    if (signal?.aborted) throw new Error(String(signal.reason || 'provider_canary_aborted'));
    let reviewerCanary;
    failurePhase = 'formal_reviewer_canary';
    notify(beforeCanaryAction, { role: 'formal_reviewer', failurePhase });
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
      notify(afterCanaryAction, { action, failurePhase });
      throw error;
    }
    const reviewerAction = providerCanaryAction({
      role: 'formal_reviewer',
      receipt: reviewerCanary,
    });
    actions.push(reviewerAction);
    notify(afterCanaryAction, { action: reviewerAction, failurePhase });
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
