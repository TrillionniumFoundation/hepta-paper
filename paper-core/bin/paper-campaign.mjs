#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePaperCampaignCommand } from '../../paper-composition/automation/paper-campaign-command-composition.mjs';
import { composeProductionPackageRecoveryAuthorities }
  from '../../paper-composition/automation/package-recovery-production-composition.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const modulePath = fileURLToPath(import.meta.url);

function args(argv) {
  const parsed = parseStrictCliArguments(argv, {
    booleanFlags: [
      'execute',
      'inline',
      'json',
      'help',
      'gpu',
      'gpu-scientific',
      'effective',
      'details',
      'retain-failed-workspaces',
      'apply',
      'apply-manuscript',
      'local-only',
    ],
    valueFlags: [
      'root',
      'runtime-root',
      'mode',
      'agent-provider',
      'openclaw-agent',
      'model',
      'formal-review-provider',
      'formal-review-model',
      'formal-review-codex-binary',
      'formal-review-codex-home',
      'codex-home',
      'codex-binary',
      'ollama-model',
      'concurrency',
      'agent-slots',
      'cpu-slots',
      'gpu-slots',
      'gpu-device-selector',
      'gpu-scientific-deadline-ms',
      'memory-mib',
      'max-wall-ms',
      'max-agent-calls',
      'max-cpu-jobs',
      'max-gpu-jobs',
      'max-tokens',
      'max-cost-usd',
      'action',
      'campaign-id',
      'run-id',
      'node-id',
      'rounds',
      'referees',
      'minimum-revision-rounds',
      'quality-profile',
      'languages',
      'metric-schema',
      'benchmark-id',
      'status',
      'limit',
      'before',
      'kind',
      'reason',
      'parent-campaign-id',
      'supersedes-campaign-id',
      'recovery-of-campaign-id',
      'worker-memory-mib',
      'worker-cpu-seconds',
      'package-lifecycle-receipt-hash',
    ],
    repeatableValueFlags: ['paper', 'dataset', 'dataset-license', 'dataset-authorization', 'dataset-harness'],
    positional: false,
  });
  return {
    ...parsed,
    paper: parsed.paper || [],
    dataset: parsed.dataset || [],
    'dataset-license': parsed['dataset-license'] || [],
    'dataset-authorization': parsed['dataset-authorization'] || [],
    'dataset-harness': parsed['dataset-harness'] || [],
  };
}

export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  environment = process.env,
  executeCampaignCommand = executePaperCampaignCommand,
  packageRecoveryAuthorityFactory = null,
  packageRecoveryAuthorityReadinessVerifier = null,
  packageRecoveryDeletionLeaseAuthority = null,
  packageRecoveryRestoreRoot = null,
  packageRecoveryObserveNow = () => new Date().toISOString(),
} = {}) {
  const options = args(argv);
  if (options.help) {
    stdout.write([
      'Usage: hepta-paper operator campaign -- [options]',
      '',
      '  --paper <id>              select a paper; repeat for several papers',
      '  --execute                 persist campaigns for a worker (default is plan-only)',
      '  --inline                  execute in the submitting process; otherwise --execute only submits',
      '  --mode <name>             campaign mode (default full-campaign; local golden uses local-review-loop)',
      '  --local-only              bind execution to local-only evidence and disable release promotion',
      '  --apply-manuscript        integrate verified empirical outputs into the manuscript',
      '  --agent-provider <name>   auto|openclaw|ollama|codex (default auto)',
      '  --openclaw-agent <id>     OpenClaw agent id (default hepta-paper-worker)',
      '  --model <name>            primary agent model override',
      '  --formal-review-provider <name>  independent reviewer backend (codex; OpenClaw fails closed until per-turn workspace binding exists)',
      '  --formal-review-model <name>  independent reviewer model override',
      '  --formal-review-codex-binary <path>  pinned reviewer Codex executable (default codex)',
      '  --formal-review-codex-home <path>  dedicated reviewer CODEX_HOME; required for Codex review',
      '  --codex-home <path>      primary Codex author CODEX_HOME; must differ from reviewer home',
      '  --codex-binary <path>    pinned primary Codex author executable (default codex)',
      '  --ollama-model <name>     local fallback model',
      '  --concurrency <n>         total dependency-ready node concurrency (default 8)',
      '  --agent-slots <n>         global OpenClaw/model slots (default 4)',
      '  --cpu-slots <n>           global empirical CPU slots (default 4)',
      '  --gpu-slots <n>           global GPU slots (default 1)',
      '  --memory-mib <n>          global campaign memory budget (default 8192)',
      '  --max-wall-ms <n>         per-campaign wall-time budget',
      '  --max-agent-calls <n>     per-campaign agent-call budget',
      '  --max-cpu-jobs <n>        per-campaign CPU-job budget',
      '  --max-gpu-jobs <n>        per-campaign GPU-job budget',
      '  --max-tokens <n>          per-campaign model-token budget',
      '  --max-cost-usd <n>        per-campaign model-cost budget',
      '  --action <name>           list|status|events|logs|pause|resume|extend|cancel|cancel-node|retry|work|gc|slo|retention-recovery-readiness|provision-retention-recovery',
      '  --campaign-id <id>        campaign for an operational action',
      '  --run-id <id>             suffix new campaign ids so a paper can be rerun',
      '  --node-id <id>            failed node for retry',
      '  --rounds <n>              maximum referee/revise rounds (default 3)',
      '  --referees <n>            independent referees per round (default 3)',
      '  --minimum-revision-rounds <n>  require this many revise/re-review rounds before convergence',
      '  --quality-profile <names>  comma/+ separated quality requirements: formal_theorem_or_proof, empirical_or_experiment, or both; theorem_or_proof aliases formal when Lean is selected',
      '  --languages <csv>         empirical languages (default python,latex)',
      '  --gpu                     allow and require GPU access for empirical nodes',
      '  --gpu-scientific          add the canonical PDE + deep-learning GPU evidence node',
      '  --gpu-device-selector <UUID>  exact NVIDIA UUID for --gpu-scientific; one observed GPU may be auto-selected',
      '  --gpu-scientific-deadline-ms <n>  absolute execution window (60s to 24h; default max-wall-ms)',
      '  --dataset <name=path>     add a read-only dataset mount; repeat as needed',
      '  --dataset-license <name=SPDX>  required license id for each dataset mount',
      '  --dataset-authorization <name=sha256:...>  operator authorization for LicenseRef datasets',
      '  --dataset-harness <name=/host/path/envelope.json>  signed host-only academic harness envelope; repeat as needed',
      '  --metric-schema <path>    JSON metric paths and numeric tolerances',
      '  --benchmark-id <id>       bind the empirical selector; inferred only for one dataset mount',
      '  --details                 include full specs, nodes and receipts (default is concise)',
      '  --retain-failed-workspaces  keep failed COW trees (default; retained unless explicitly exported/eligible)',
      '  --apply                   apply a GC plan (GC is dry-run by default)',
      '  --package-lifecycle-receipt-hash <sha256:...>  lifecycle receipt to provision through an injected recovery authority',
      '  --root <path>             paper asset root',
      '  --runtime-root <path>     runtime and campaign store root',
      '',
      'Formal review environment:',
      '  HEPTA_FORMAL_REVIEW_MODEL',
      '  HEPTA_FORMAL_REVIEW_CODEX_BINARY',
      '  HEPTA_FORMAL_REVIEW_CODEX_HOME',
      '  (Codex reviewer home must contain private config.toml and be authenticated)',
      '  (OpenClaw reviewer remains fail-closed until dynamic workspace binding exists)',
      '  HEPTA_OPENCLAW_FORMAL_REVIEW_AGENT',
      '  HEPTA_OPENCLAW_FORMAL_REVIEW_AGENT_CAPABILITY_PROFILE',
      '  HEPTA_OPENCLAW_FORMAL_REVIEW_AGENT_CAPABILITY_PROFILE_HASH',
      '',
      'Research author environment:',
      '  HEPTA_RESEARCH_AUTHOR_MODEL',
      '  HEPTA_RESEARCH_AUTHOR_CODEX_BINARY',
      '  HEPTA_RESEARCH_AUTHOR_CODEX_HOME',
      '  (research-grade auto selection requires a private authenticated Codex home and explicit model)',
      '',
    ].join('\n'));
    return;
  }
  const root = path.resolve(options.root || defaultPaperAssetRoot());
  const runtimeRoot = path.resolve(options['runtime-root'] || defaultPaperRuntimeRoot());
  const packageRecovery = composeProductionPackageRecoveryAuthorities({
    runtimeRoot,
    restoreRoot: packageRecoveryRestoreRoot,
    packageRecoveryAuthorityFactory,
    packageRecoveryAuthorityReadinessVerifier,
    packageRecoveryDeletionLeaseAuthority,
    observeNow: packageRecoveryObserveNow,
  });
  const commandRequest = {
    options, root, runtimeRoot, environment,
    ...packageRecovery,
  };
  const response = executeCampaignCommand === executePaperCampaignCommand
    ? await executePaperCampaignCommand({ ...commandRequest })
    : await executeCampaignCommand(commandRequest);
  stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === modulePath;
if (invokedAsEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
