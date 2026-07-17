#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { composeAutonomousResearchCampaignAction } from '../../paper-composition/automation/autonomous-research-campaign-composition.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import {
  autonomousResearchCommandExitCode,
} from '../../paper-application/automation/autonomous-research-cli-policy.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: [
    'help', 'human-subjects', 'private-data', 'require-launch-ready', 'require-full-ready',
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
    version: 3,
    kind: 'AutonomousResearchCampaignUsage',
    usage: 'hepta-paper operator autonomous-research -- --launch-mode golden-bootstrap|production-run [--action prepare|launch|status|resume|converge] --paper-id ID',
    behavior: {
      prepare: 'default dry action; machine-selects a bounded agenda when objective/protocol are omitted',
      launch: 'explicitly materializes the source and executes the persisted full campaign DAG',
      status: 'reads persisted campaign/node state without local mutation and validates cached qualification state locally',
      resume: 'resumes a paused/stopped persisted campaign and executes only unfinished nodes',
      converge: 'idempotently prepares or continues one campaign and requests bounded external machine qualification; paused/stopped campaigns require explicit budget flags',
    },
    launchRequirements: [
      'explicit golden-bootstrap or production-run launch mode',
      'independent author/reviewer principals',
      'one externally authorized academic dataset mount JSON',
      'explicit --action launch or --action converge',
      'an external qualifier plus distinct verifier process configuration before full-ready',
    ],
    launchModes: {
      'golden-bootstrap': 'runs only under system-clamped call, configured-price cost, wall-time and compute limits; provider token count is advisory, and a fresh qualification pointer is published only after local re-verification',
      'production-run': 'fails before provider execution or workspace/store mutation unless full readiness, provider maximum prices, and a cost ceiling are known',
    },
    providerPricing: {
      researchAuthorMaximumCostPerCallEnvironment:
        'HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD',
      formalReviewerMaximumCostPerCallEnvironment:
        'HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD',
      unknownProductionPricingFailsClosed: true,
      providerTokenBudgetAssurance: 'prompt_only_not_a_hard_provider_limit',
    },
    providerConfiguration: {
      researchAuthor: '--agent-provider auto|codex (auto resolves to codex)',
      formalReviewer: '--formal-review-provider auto|codex (auto resolves to codex)',
      supportedProvider: 'codex',
      unsupportedProvidersFailClosed: true,
    },
    externalQualification: {
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
  const launchMode = args['launch-mode'] || 'production-run';
  if (!['prepare', 'launch', 'status', 'resume', 'converge'].includes(action)) {
    throw new Error(`autonomous_research_campaign_action_invalid:${action}`);
  }
  if (!args['paper-id'] && !args['campaign-id']) {
    throw new Error('autonomous_research_paper_or_campaign_id_required');
  }
  const report = await composeAutonomousResearchCampaignAction({
    action,
    launchMode,
    paperId: args['paper-id'] || null,
    campaignId: args['campaign-id'] || null,
    objective: args.objective || null,
    protocolFamily: args['protocol-family'] || null,
    root: path.resolve(args.root || defaultPaperAssetRoot()),
    runtimeRoot: path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot()),
    datasetMounts: loadDatasetMounts(args['dataset-mount-file']),
    revisionRounds: Number(args['revision-rounds'] || 3),
    refereeCount: Number(args['referee-count'] || 3),
    budgets: numericOptions(),
    humanSubjects: Boolean(args['human-subjects']),
    privateData: Boolean(args['private-data']),
    createdAt: new Date().toISOString(),
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
    report,
    requireFullReady: Boolean(args['require-full-ready']),
    requireLaunchReady: Boolean(args['require-launch-ready']),
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
