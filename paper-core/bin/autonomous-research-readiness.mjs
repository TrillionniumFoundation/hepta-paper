#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { composeAutonomousResearchCampaignAction } from '../../paper-composition/automation/autonomous-research-campaign-composition.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import {
  autonomousResearchCommandExitCode,
  isLocalAutonomousResearchCliLaunchMode,
  LOCAL_AUTONOMOUS_RESEARCH_LAUNCH_MODE,
  normalizeAutonomousResearchCliLaunchMode,
  resolveAutonomousResearchDirectLocalRunBudgetWaiver,
} from '../../paper-application/automation/autonomous-research-cli-policy.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: [
    'help', 'human-subjects', 'private-data', 'require-launch-ready', 'require-full-ready',
    'require-bounded-golden-ready', 'unlimited-tokens', 'unlimited-cost',
  ],
  valueFlags: [
    'action', 'launch-mode', 'paper-id', 'campaign-id', 'objective', 'protocol-family', 'revision-rounds',
    'referee-count', 'root', 'runtime-root', 'dataset-mount-file', 'concurrency', 'agent-slots',
    'cpu-slots', 'gpu-slots', 'memory-mib', 'max-wall-ms', 'max-agent-calls', 'max-cpu-jobs',
    'max-gpu-jobs', 'max-tokens', 'max-cost-usd', 'agent-provider', 'model',
    'formal-review-provider', 'formal-review-model', 'formal-review-codex-binary',
    'formal-review-codex-home', 'codex-home', 'codex-binary',
    'external-qualification-config',
    'qualification-maximum-attempts', 'qualification-maximum-epochs',
    'qualification-maximum-total-attempts', 'qualification-initial-backoff-ms',
    'qualification-maximum-backoff-ms', 'qualification-deadline-ms',
    'qualification-epoch-cooldown-ms', 'qualification-global-deadline-ms',
    'qualification-exhausted-cooldown-ms', 'qualification-attempt-lease-ms',
    'qualification-maximum-total-cost-usd', 'qualification-attempt-reservation-cost-usd',
    'qualification-renewal-lead-ms',
  ],
  positional: false,
});

function numericOptions() {
  return Object.fromEntries([
    ['maxWallTimeMs', 'max-wall-ms'],
    ['maxAgentCalls', 'max-agent-calls'],
    ['maxCpuJobs', 'max-cpu-jobs'],
    ['maxGpuJobs', 'max-gpu-jobs'],
    ['maxTokenCount', 'max-tokens'],
    ['maxCostUsd', 'max-cost-usd'],
    ['maxMemoryMiB', 'memory-mib'],
  ].filter(([, option]) => args[option] !== undefined)
    .map(([field, option]) => [field, Number(args[option])]));
}

function qualificationRetryOptions() {
  return Object.fromEntries([
    ['maximumAttempts', 'qualification-maximum-attempts'],
    ['maximumEpochs', 'qualification-maximum-epochs'],
    ['maximumTotalAttempts', 'qualification-maximum-total-attempts'],
    ['initialBackoffMs', 'qualification-initial-backoff-ms'],
    ['maximumBackoffMs', 'qualification-maximum-backoff-ms'],
    ['deadlineMs', 'qualification-deadline-ms'],
    ['epochCooldownMs', 'qualification-epoch-cooldown-ms'],
    ['globalDeadlineMs', 'qualification-global-deadline-ms'],
    ['exhaustedCooldownMs', 'qualification-exhausted-cooldown-ms'],
    ['attemptLeaseMs', 'qualification-attempt-lease-ms'],
    ['maximumTotalCostUsd', 'qualification-maximum-total-cost-usd'],
    ['attemptReservationCostUsd', 'qualification-attempt-reservation-cost-usd'],
    ['renewalLeadMs', 'qualification-renewal-lead-ms'],
  ].filter(([, option]) => args[option] !== undefined)
    .map(([field, option]) => [field, Number(args[option])]));
}

function loadDatasetMounts(candidate) {
  if (!candidate) return [];
  const parsed = JSON.parse(fs.readFileSync(path.resolve(candidate), 'utf8'));
  return Array.isArray(parsed) ? parsed : [parsed];
}

function usage() {
  return {
    version: 4,
    kind: 'AutonomousResearchCampaignUsage',
    usage: 'hepta-paper operator autonomous-research -- [--launch-mode local-run|production-run|golden-bootstrap] [--action prepare|launch|status|resume|converge] --paper-id ID',
    defaultLaunchMode: LOCAL_AUTONOMOUS_RESEARCH_LAUNCH_MODE,
    behavior: {
      prepare: 'default dry action; machine-selects a bounded agenda when objective/protocol are omitted',
      launch: 'explicitly materializes the source and executes the persisted full campaign DAG',
      status: 'reads persisted campaign/node state without local mutation and validates cached qualification state locally',
      resume: 'resumes a paused/stopped persisted campaign and executes only unfinished nodes',
      converge: 'idempotently prepares or continues one local campaign through release; production-run may additionally request external qualification, and paused/stopped campaigns require explicit budget flags',
    },
    launchRequirements: [
      'independent author/reviewer principals',
      'a local dataset mount JSON when the selected protocol needs data',
      'explicit --action launch or --action converge',
      'external authorities only when production-run or --require-full-ready is explicitly requested',
    ],
    launchModes: {
      'local-run': 'default local-only mode; reuses the bounded golden execution path and does not require external identity, HSM/KMS, remote replay, portal or production qualification',
      'golden-bootstrap': 'runs only under configured provider-price, call, cost, wall-time and compute limits; provider token count is advisory, and a fresh qualification pointer is published only after local re-verification',
      'production-run': 'fails before provider execution or workspace/store mutation unless full readiness, provider maximum prices, and lifecycle hard budgets are present',
    },
    directLocalRunBudgetWaiver: {
      tokenFlag: '--unlimited-tokens',
      costFlag: '--unlimited-cost',
      scope: 'explicit direct local-run only',
      conflicts: ['--max-tokens', '--max-cost-usd'],
      persistence: 'hash-bound in the campaign plan and preserved across resume',
    },
    providerPricing: {
      perCallMaximumRequiredOutsideDirectLocalCostWaiver: true,
      unknownCostAllowedOnlyWithExplicitDirectLocalCostWaiver: true,
      lifecycleCostBudgetRequired: true,
      providerTokenBudgetAssurance: 'prompt_only_not_a_hard_provider_limit',
    },
    providerConfiguration: {
      researchAuthor: '--agent-provider auto|codex (auto resolves to codex)',
      formalReviewer: '--formal-review-provider auto|codex (auto resolves to codex)',
      supportedProvider: 'codex',
      unsupportedProvidersFailClosed: true,
    },
    externalQualification: {
      requiredForLocalRun: false,
      scope: 'optional production extension',
      configurationFlag: '--external-qualification-config PATH',
      configurationEnvironment: 'HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG',
      protocol: 'two distinct external-qualification-json-stdio-v1 process/service clients',
      cachePolicy: 'verified before caching; reused only for the same release while unexpired',
      convergeRetryPolicy: 'bounded durable recovery; caller values are normalized to hard limits and exhaustion fails closed',
    },
    safety: {
      operatorApprovalClaimed: false,
      selfSignedExternalTrustClaimed: false,
      externalSubmissionEnabled: false,
      universalResearchValidityClaimed: false,
      naturalLanguageToLeanEquivalenceMachineProven: false,
      automaticBudgetExpansionEnabled: false,
    },
  };
}

async function main() {
  if (args.help) {
    process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
    return;
  }
  const action = args.action || 'prepare';
  const requestedLaunchMode = args['launch-mode']
    || LOCAL_AUTONOMOUS_RESEARCH_LAUNCH_MODE;
  const localOnly = isLocalAutonomousResearchCliLaunchMode(requestedLaunchMode);
  const launchMode = normalizeAutonomousResearchCliLaunchMode(requestedLaunchMode);
  if (!['prepare', 'launch', 'status', 'resume', 'converge'].includes(action)) {
    throw new Error(`autonomous_research_campaign_action_invalid:${action}`);
  }
  if (!args['paper-id'] && !args['campaign-id']) {
    throw new Error('autonomous_research_paper_or_campaign_id_required');
  }
  const paperId = args['paper-id'] || null;
  const campaignId = args['campaign-id']
    || (paperId ? `autonomous-research:${paperId}` : null);
  const directLocalRunBudgetWaiver =
    resolveAutonomousResearchDirectLocalRunBudgetWaiver({
      launchMode: requestedLaunchMode,
      campaignId,
      paperId,
      unlimitedTokens: args['unlimited-tokens'] === true,
      unlimitedCost: args['unlimited-cost'] === true,
      maxTokensSpecified: args['max-tokens'] !== undefined,
      maxCostUsdSpecified: args['max-cost-usd'] !== undefined,
    });
  const createdAt = new Date().toISOString();
  const report = await composeAutonomousResearchCampaignAction({
    action,
    launchMode,
    localOnly,
    directLocalRunBudgetWaiver: directLocalRunBudgetWaiver.waiver,
    directLocalRunCliProvenance: directLocalRunBudgetWaiver.provenance,
    paperId,
    campaignId,
    objective: args.objective || null,
    protocolFamily: args['protocol-family'] || null,
    root: path.resolve(args.root || defaultPaperAssetRoot()),
    runtimeRoot: path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot()),
    datasetMounts: loadDatasetMounts(args['dataset-mount-file']),
    revisionRounds: Number(args['revision-rounds'] || 3),
    refereeCount: Number(args['referee-count'] || 3),
    budgets: { ...numericOptions(), ...directLocalRunBudgetWaiver.budgets },
    humanSubjects: Boolean(args['human-subjects']),
    privateData: Boolean(args['private-data']),
    createdAt,
    environment: process.env,
    externalQualificationConfigPath: args['external-qualification-config']
      ? path.resolve(args['external-qualification-config']) : null,
    qualificationRetry: qualificationRetryOptions(),
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
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const exitCode = autonomousResearchCommandExitCode({
    action,
    launchMode: requestedLaunchMode,
    report,
    requireFullReady: Boolean(args['require-full-ready']),
    requireLaunchReady: Boolean(args['require-launch-ready']),
    requireBoundedGoldenReady: Boolean(args['require-bounded-golden-ready']),
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
