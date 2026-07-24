#!/usr/bin/env node
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  composeAutonomousResearchSupervisor,
} from '../../paper-composition/automation/autonomous-research-supervisor-composition.mjs';
import {
  autonomousResearchResidentExitCode,
} from '../../paper-application/automation/autonomous-research-resident-reactivation-required.mjs';
import {
  publishStrictMachineIntakeReconciliation,
  publishResidentCycleIntent,
  queryResidentCycleReceipt,
} from '../../paper-composition/automation/autonomous-research-supervisor-state-composition.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: [
    'help', 'once', 'publish-strict-machine-intake-reconciliation',
    'request-resident-cycle', 'require-fully-autonomous',
  ],
  valueFlags: [
    'root', 'runtime-root', 'poll-ms', 'maximum-campaigns-per-cycle',
    'external-qualification-config', 'concurrency', 'agent-slots', 'cpu-slots',
    'gpu-slots', 'memory-mib', 'agent-provider', 'model', 'formal-review-provider',
    'formal-review-model', 'formal-review-codex-binary', 'formal-review-codex-home',
    'codex-home', 'codex-binary', 'machine-intake-config',
    'topic-producer-profile',
    'maximum-dispatches', 'maximum-provider-canaries', 'maximum-consecutive-failures',
    'maximum-lifecycle-cost-usd', 'maximum-lifetime-ms', 'lease-ms',
    'resident-instance-lease-ms', 'resident-instance-heartbeat-ms',
    'base-cooldown-ms', 'maximum-cooldown-ms', 'provider-canary-interval-ms',
    'provider-canary-reservation-cost-usd', 'qualification-maximum-total-attempts',
    'qualification-maximum-total-cost-usd', 'qualification-attempt-reservation-cost-usd',
    'qualification-renewal-lead-ms', 'qualification-maximum-attempts',
    'qualification-action-safety-margin-ms',
    'runtime-reproducibility-maximum-attempts-per-epoch',
    'runtime-reproducibility-maximum-cost-usd-per-epoch',
    'runtime-reproducibility-budget-epoch-ms', 'runtime-reproducibility-lease-ms',
    'runtime-reproducibility-base-backoff-ms',
    'runtime-reproducibility-maximum-backoff-ms',
    'runtime-reproducibility-renewal-lead-ms',
    'runtime-reproducibility-action-safety-margin-ms',
    'qualification-maximum-epochs', 'qualification-initial-backoff-ms',
    'qualification-maximum-backoff-ms', 'qualification-deadline-ms',
    'qualification-epoch-cooldown-ms', 'qualification-exhausted-cooldown-ms',
    'qualification-attempt-lease-ms',
    'resident-cycle-wait-ms', 'resident-cycle-poll-ms',
  ],
  positional: false,
});

function selected(mapping) {
  return Object.fromEntries(mapping
    .filter(([, option]) => args[option] !== undefined)
    .map(([field, option]) => [field, Number(args[option])]));
}

function lifecyclePolicy() {
  return selected([
    ['maximumDispatches', 'maximum-dispatches'],
    ['maximumProviderCanaries', 'maximum-provider-canaries'],
    ['maximumConsecutiveFailures', 'maximum-consecutive-failures'],
    ['maximumLifecycleCostUsd', 'maximum-lifecycle-cost-usd'],
    ['maximumLifetimeMs', 'maximum-lifetime-ms'],
    ['leaseMs', 'lease-ms'],
    ['baseCooldownMs', 'base-cooldown-ms'],
    ['maximumCooldownMs', 'maximum-cooldown-ms'],
    ['providerCanaryIntervalMs', 'provider-canary-interval-ms'],
    ['providerCanaryReservationCostUsd', 'provider-canary-reservation-cost-usd'],
    ['qualificationMaximumTotalAttempts', 'qualification-maximum-total-attempts'],
    ['qualificationMaximumTotalCostUsd', 'qualification-maximum-total-cost-usd'],
    ['qualificationAttemptReservationCostUsd', 'qualification-attempt-reservation-cost-usd'],
    ['qualificationRenewalLeadMs', 'qualification-renewal-lead-ms'],
    ['qualificationActionSafetyMarginMs', 'qualification-action-safety-margin-ms'],
  ]);
}

function qualificationRetry() {
  return selected([
    ['maximumAttempts', 'qualification-maximum-attempts'],
    ['maximumEpochs', 'qualification-maximum-epochs'],
    ['initialBackoffMs', 'qualification-initial-backoff-ms'],
    ['maximumBackoffMs', 'qualification-maximum-backoff-ms'],
    ['deadlineMs', 'qualification-deadline-ms'],
    ['epochCooldownMs', 'qualification-epoch-cooldown-ms'],
    ['exhaustedCooldownMs', 'qualification-exhausted-cooldown-ms'],
    ['attemptLeaseMs', 'qualification-attempt-lease-ms'],
  ]);
}

function runtimeReproducibilityPolicy() {
  return selected([
    ['maximumAttemptsPerEpoch', 'runtime-reproducibility-maximum-attempts-per-epoch'],
    ['maximumCostUsdPerEpoch', 'runtime-reproducibility-maximum-cost-usd-per-epoch'],
    ['budgetEpochMs', 'runtime-reproducibility-budget-epoch-ms'],
    ['leaseMs', 'runtime-reproducibility-lease-ms'],
    ['baseBackoffMs', 'runtime-reproducibility-base-backoff-ms'],
    ['maximumBackoffMs', 'runtime-reproducibility-maximum-backoff-ms'],
    ['renewalLeadMs', 'runtime-reproducibility-renewal-lead-ms'],
    ['actionSafetyMarginMs', 'runtime-reproducibility-action-safety-margin-ms'],
  ]);
}

function usage() {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorUsage',
    usage: 'hepta-paper operator autonomous-supervisor -- [--once | --request-resident-cycle] [--require-fully-autonomous] [--machine-intake-config PATH] [--topic-producer-profile PATH] [bounded lifecycle/provider/qualification options]',
    runtime: 'foreground resident process suitable for systemd Restart=always and a Kubernetes Deployment/StatefulSet',
    startup: 'atomically reconciles expired campaign/resource/supervisor/qualification leases before dispatch',
    recovery: 'resumes running, paused, and supervisor-stopped autonomous campaigns without expanding persisted campaign budgets',
    safety: Object.freeze({
      lifecycleAttemptBudgetRequired: true,
      lifecycleCostBudgetRequired: true,
      lifecycleDeadlineRequired: true,
      providerCanaryRequired: true,
      qualificationRenewalEnabled: true,
      machineIntakeEnqueueEnabled: true,
      coldStartAutonomyRequiresConfiguredIntake: true,
      runtimeReproducibilityRefreshFencedAndBudgeted: true,
      unknownProviderCostFailsClosed: true,
      externalSubmissionPerformed: false,
      automaticBudgetExpansionPerformed: false,
    }),
  });
}

function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export async function requestAutonomousResearchResidentCycle({
  runtimeRoot,
  acceptancePlanHash,
  acceptanceStepIdempotencyKey,
  purpose = 'production-campaign-qualification',
  waitMs = 10 * 60 * 1000,
  pollMs = 1000,
  signal = null,
  now = () => new Date(),
} = {}) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 60 * 60 * 1000
    || !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 60_000) {
    throw new Error('autonomous_research_resident_cycle_wait_policy_invalid');
  }
  publishResidentCycleIntent({
    runtimeRoot,
    acceptancePlanHash,
    acceptanceStepIdempotencyKey,
    purpose,
    now: now(),
  });
  const deadline = Date.now() + waitMs;
  do {
    const inspection = queryResidentCycleReceipt({
      runtimeRoot,
      acceptancePlanHash,
      acceptanceStepIdempotencyKey,
      purpose,
      now: now(),
    });
    if (inspection.ready === true) return inspection.receipt;
    if (signal?.aborted) {
      throw new Error('autonomous_research_resident_cycle_wait_aborted');
    }
    if (Date.now() >= deadline) {
      throw new Error('autonomous_research_resident_cycle_wait_timed_out');
    }
    await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
  } while (true);
}

async function main() {
  if (args.help) {
    process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
    return;
  }
  if (args.once && args['request-resident-cycle']) {
    throw new Error('autonomous_research_supervisor_cycle_mode_conflict');
  }
  if (args['publish-strict-machine-intake-reconciliation']
    && !args.once && !args['request-resident-cycle']) {
    throw new Error(
      'autonomous_research_strict_machine_intake_reconciliation_once_required',
    );
  }
  const root = path.resolve(args.root || defaultPaperAssetRoot());
  const runtimeRoot = path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot());
  const controller = new AbortController();
  const stop = (signalName) => {
    if (!controller.signal.aborted) controller.abort(`supervisor_process_${signalName.toLowerCase()}`);
  };
  const stopOnSigint = () => stop('SIGINT');
  const stopOnSigterm = () => stop('SIGTERM');
  process.on('SIGINT', stopOnSigint);
  process.on('SIGTERM', stopOnSigterm);
  if (args['request-resident-cycle']) {
    if (args['require-fully-autonomous'] || args['machine-intake-config']
      || args['topic-producer-profile']) {
      throw new Error('autonomous_research_resident_cycle_request_override_forbidden');
    }
    try {
      const result = await requestAutonomousResearchResidentCycle({
        runtimeRoot,
        acceptancePlanHash:
          process.env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH,
        acceptanceStepIdempotencyKey:
          process.env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY,
        purpose: args['publish-strict-machine-intake-reconciliation']
          ? 'machine-intake' : 'production-campaign-qualification',
        waitMs: Number(args['resident-cycle-wait-ms'] || 10 * 60 * 1000),
        pollMs: Number(args['resident-cycle-poll-ms'] || 1000),
        signal: controller.signal,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    } finally {
      process.removeListener('SIGINT', stopOnSigint);
      process.removeListener('SIGTERM', stopOnSigterm);
    }
  }
  const ownerId = `supervisor:${os.hostname().replace(/[^A-Za-z0-9_.:-]/g, '_')}:${process.pid}:${crypto.randomUUID()}`;
  const composition = composeAutonomousResearchSupervisor({
    root,
    runtimeRoot,
    environment: process.env,
    externalQualificationConfigPath: args['external-qualification-config']
      ? path.resolve(args['external-qualification-config']) : null,
    machineIntakeConfigPath: args['machine-intake-config']
      ? path.resolve(args['machine-intake-config']) : null,
    topicProducerProfilePath: args['topic-producer-profile']
      ? path.resolve(args['topic-producer-profile']) : null,
    requireFullyAutonomous: args['require-fully-autonomous'] === true,
    qualificationRetry: qualificationRetry(),
    lifecyclePolicy: lifecyclePolicy(),
    runtimeReproducibilityPolicy: runtimeReproducibilityPolicy(),
    residentInstanceLeaseMs: Number(args['resident-instance-lease-ms'] || 15 * 60 * 1000),
    residentInstanceHeartbeatMs: Number(args['resident-instance-heartbeat-ms'] || 30_000),
    pollMs: Number(args['poll-ms'] || 5000),
    maximumCampaignsPerCycle: Number(args['maximum-campaigns-per-cycle'] || 100),
    signal: controller.signal,
    ownerId,
    worker: {
      concurrency: Number(args.concurrency || 8),
      agentSlots: Number(args['agent-slots'] || 4),
      cpuSlots: Number(args['cpu-slots'] || 4),
      gpuSlots: Number(args['gpu-slots'] || 1),
      memoryMiB: Number(args['memory-mib'] || 8192),
      agentProvider: args['agent-provider'],
      model: args.model,
      formalReviewProvider: args['formal-review-provider'],
      formalReviewModel: args['formal-review-model'],
      formalReviewCodexBinary: args['formal-review-codex-binary'],
      formalReviewCodexHome: args['formal-review-codex-home'],
      codexHome: args['codex-home'],
      codexBinary: args['codex-binary'],
    },
    onCycle: args.once ? null : (cycle) => {
      process.stdout.write(`${JSON.stringify(cycle)}\n`);
    },
  });
  try {
    const result = args.once
      ? await composition.supervisor.runCycle()
      : await composition.supervisor.run();
    const strictMachineIntakeReconciliation =
      args['publish-strict-machine-intake-reconciliation']
        ? publishStrictMachineIntakeReconciliation({
          runtimeRoot,
          acceptancePlanHash:
            process.env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH,
          acceptanceStepIdempotencyKey:
            process.env.HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY,
          cycleReceipt: result,
        }) : null;
    const report = strictMachineIntakeReconciliation
      ? Object.freeze({ ...result, strictMachineIntakeReconciliation }) : result;
    process.stdout.write(`${JSON.stringify(report, null, args.once ? 2 : 0)}\n`);
  } finally {
    composition.close();
    process.removeListener('SIGINT', stopOnSigint);
    process.removeListener('SIGTERM', stopOnSigterm);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = autonomousResearchResidentExitCode(error, 1);
});
