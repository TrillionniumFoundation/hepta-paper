#!/usr/bin/env node
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  composeAutonomousResearchSupervisor,
} from '../../paper-composition/automation/autonomous-research-supervisor-composition.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['help', 'once', 'require-fully-autonomous'],
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
    usage: 'hepta-paper operator autonomous-supervisor -- [--once] [--require-fully-autonomous] [--machine-intake-config PATH] [--topic-producer-profile PATH] [bounded lifecycle/provider/qualification options]',
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

async function main() {
  if (args.help) {
    process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
    return;
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
    process.stdout.write(`${JSON.stringify(result, null, args.once ? 2 : 0)}\n`);
  } finally {
    composition.close();
    process.removeListener('SIGINT', stopOnSigint);
    process.removeListener('SIGTERM', stopOnSigterm);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
