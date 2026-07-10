import { digest } from './hash-utils.mjs';

export const PROVIDER_EXPERIMENT_CONTRACT_VERSION = 1;

export const PROVIDER_EXPERIMENT_SAFETY = Object.freeze({
  localContractOnly: true,
  readsFiles: false,
  writesFiles: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  grantsExecutionPermission: false,
});

export const PROVIDER_BENCHMARK_METRICS = Object.freeze([
  'qaPassRate',
  'packageReviewPassRate',
  'semanticFailRate',
  'textErrorRate',
  'nearDuplicateRate',
  'redoRate',
  'costUsdPerAcceptedArtifact',
  'durationMsPerAcceptedArtifact',
]);

export const PROVIDER_BENCHMARK_POLICY = Object.freeze({
  defaultMode: 'plan-only',
  realProviderCallsRequire: ['--execute', '--budget-usd', '--policy spend-allowed'],
  livePageCalls: false,
  realSubmit: false,
});

function text(value) {
  const str = String(value ?? '').trim();
  return str || null;
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function parseProviderList(raw, fallback = []) {
  if (Array.isArray(raw)) return raw.map(text).filter(Boolean);
  const source = raw == null || raw === '' ? fallback : String(raw).split(',');
  return source.map(text).filter(Boolean);
}

export function estimateProviderExperimentCost(providers = [], providerInfo = {}) {
  return parseProviderList(providers).reduce((sum, providerId) => {
    const info = providerInfo?.[providerId] || {};
    const value = info.estimatedCostUsdPerImage ?? info.costProfile?.estimatedCostUsdPerImage ?? 0;
    return sum + Number(value || 0);
  }, 0);
}

export function scoreProviderProbeResult(probe = {}) {
  if (!probe?.ok || probe.parsed?.ok === false) return -1000;
  const parsed = probe.parsed || {};
  const semanticOk = parsed.autoQaPass ? 25 : 0;
  const costPenalty = Number(parsed.estimatedCostUsd || 0) * 20;
  const durationPenalty = Number(parsed.durationMs || probe.durationMs || 0) / 120000;
  return Math.round((100 + semanticOk - costPenalty - durationPenalty) * 10) / 10;
}

export function rankProviderExperimentCandidates({
  providers = [],
  providerInfo = {},
  results = {},
  execute = false,
} = {}) {
  const ranked = parseProviderList(providers).map((providerId) => {
    const info = providerInfo?.[providerId] || {};
    const result = results?.[providerId] || null;
    return {
      version: PROVIDER_EXPERIMENT_CONTRACT_VERSION,
      provider: providerId,
      score: execute ? scoreProviderProbeResult(result) : Number(info.score || 0),
      quality: info.quality || null,
      estimatedCostUsdPerImage: Number(info.estimatedCostUsdPerImage || info.costProfile?.estimatedCostUsdPerImage || 0),
      ok: execute ? !!result?.ok && result?.parsed?.ok !== false : null,
      result,
      safety: PROVIDER_EXPERIMENT_SAFETY,
    };
  }).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  return {
    version: PROVIDER_EXPERIMENT_CONTRACT_VERSION,
    execute: !!execute,
    ranked,
    recommendedProvider: ranked[0]?.provider || null,
    experimentHash: digest({
      version: PROVIDER_EXPERIMENT_CONTRACT_VERSION,
      execute: !!execute,
      ranked: ranked.map((item) => ({
        provider: item.provider,
        score: item.score,
        ok: item.ok,
        estimatedCostUsdPerImage: item.estimatedCostUsdPerImage,
      })),
    }),
    safety: PROVIDER_EXPERIMENT_SAFETY,
  };
}

export function normalizeProviderBenchmarkCase(item = {}) {
  return {
    id: text(item.id),
    category: text(item.category || item.workflowId),
    taskId: text(item.taskId),
    industryId: text(item.industryId),
    prompt: text(item.prompt),
    negativePatterns: Array.isArray(item.negativePatterns) ? item.negativePatterns.map(text).filter(Boolean) : [],
    acceptance: Array.isArray(item.acceptance) ? item.acceptance.map(text).filter(Boolean) : [],
  };
}

export function buildProviderBenchmarkDatasetContract(dataset = {}) {
  const cases = (Array.isArray(dataset.cases) ? dataset.cases : []).map(normalizeProviderBenchmarkCase);
  const blockers = [];
  if (!cases.length) blockers.push('provider_benchmark_cases_required');
  for (const item of cases) {
    if (!item.id) blockers.push('provider_benchmark_case_id_required');
    if (!item.category) blockers.push(`provider_benchmark_case_category_required:${item.id || 'unknown'}`);
    if (!item.prompt) blockers.push(`provider_benchmark_case_prompt_required:${item.id || 'unknown'}`);
    if (!item.acceptance.length) blockers.push(`provider_benchmark_case_acceptance_required:${item.id || 'unknown'}`);
  }
  const contract = {
    version: PROVIDER_EXPERIMENT_CONTRACT_VERSION,
    datasetVersion: Number(dataset.version || PROVIDER_EXPERIMENT_CONTRACT_VERSION),
    createdAt: text(dataset.createdAt),
    updatedAt: text(dataset.updatedAt),
    policy: { ...PROVIDER_BENCHMARK_POLICY, ...(dataset.policy || {}) },
    metrics: Array.isArray(dataset.metrics) && dataset.metrics.length
      ? dataset.metrics.map(text).filter(Boolean)
      : [...PROVIDER_BENCHMARK_METRICS],
    cases,
    caseCount: cases.length,
    blockers: [...new Set(blockers)],
    safety: PROVIDER_EXPERIMENT_SAFETY,
  };
  return {
    ...contract,
    ok: contract.blockers.length === 0,
    datasetHash: digest(contract),
  };
}

export function buildProviderBenchmarkPlanContract(dataset = {}, args = {}) {
  const datasetContract = buildProviderBenchmarkDatasetContract(dataset);
  const providerList = parseProviderList(args.providers || args.provider, ['openclaw-image', 'vertex-web']);
  const budgetUsd = args['budget-usd'] !== undefined ? numberOrNull(args['budget-usd']) : null;
  const limit = Math.max(1, Number(args.limit || 1));
  const plan = {
    version: PROVIDER_EXPERIMENT_CONTRACT_VERSION,
    ok: datasetContract.ok,
    execute: !!args.execute,
    providerList,
    budgetUsd,
    limit,
    benchmarkCount: datasetContract.caseCount,
    metrics: [...datasetContract.metrics],
    cases: datasetContract.cases.map((item) => ({
      benchmarkId: item.id,
      category: item.category,
      taskId: item.taskId,
      industryId: item.industryId,
    })),
    blockers: [...datasetContract.blockers],
    datasetHash: datasetContract.datasetHash,
    safety: PROVIDER_EXPERIMENT_SAFETY,
    next: 'plan-only benchmark dataset is ready; real provider execution still requires explicit spend approval and fresh evidence',
  };
  return { ...plan, planHash: digest(plan) };
}

export function buildProviderBenchmarkScheduleContract(dataset = {}, args = {}) {
  const datasetContract = buildProviderBenchmarkDatasetContract(dataset);
  const cadence = text(args.cadence || args.schedule || 'weekly');
  const cron = text(args.cron || (cadence === 'daily' ? '17 9 * * *' : '17 9 * * 1'));
  const maxBudgetUsd = numberOrNull(args['budget-usd']) ?? 0.75;
  const schedule = {
    version: PROVIDER_EXPERIMENT_CONTRACT_VERSION,
    ok: datasetContract.ok,
    execute: false,
    schedulePlanOnly: true,
    cadence,
    cron,
    providerList: parseProviderList(args.providers || args.provider, ['openclaw-image', 'vertex-web']),
    maxBudgetUsd,
    datasetHash: datasetContract.datasetHash,
    guardrails: [
      'do not execute provider calls from cron by default',
      'benchmark execute still requires --execute, --policy spend-allowed, and an approval packet',
      'write only a next-action plan unless a human explicitly starts the spend run',
    ],
    blockers: [...datasetContract.blockers],
    safety: PROVIDER_EXPERIMENT_SAFETY,
    next: 'create a schedule only for plan refresh; provider spend remains manually approved',
  };
  return { ...schedule, scheduleHash: digest(schedule) };
}

export function providerExperimentContractsSelftest() {
  const providerInfo = {
    a: { score: 2, estimatedCostUsdPerImage: 0.05 },
    b: { score: 1, estimatedCostUsdPerImage: 0.1 },
  };
  const rankedPlan = rankProviderExperimentCandidates({ providers: ['a', 'b'], providerInfo });
  const rankedExec = rankProviderExperimentCandidates({
    providers: ['a', 'b'],
    providerInfo,
    execute: true,
    results: {
      a: { ok: true, durationMs: 1000, parsed: { ok: true, estimatedCostUsd: 0.1, autoQaPass: true } },
      b: { ok: false, parsed: { ok: false } },
    },
  });
  const dataset = {
    version: 1,
    cases: [{
      id: 'bench-test',
      category: 'logo_brand',
      taskId: '1',
      industryId: 'industrial',
      prompt: 'test prompt',
      acceptance: ['brand fit'],
    }],
  };
  const plan = buildProviderBenchmarkPlanContract(dataset, { providers: 'a,b', 'budget-usd': 0.25 });
  const schedule = buildProviderBenchmarkScheduleContract(dataset, { cadence: 'daily' });
  const ok = rankedPlan.recommendedProvider === 'a'
    && rankedExec.recommendedProvider === 'a'
    && rankedExec.ranked[1].score === -1000
    && Math.abs(estimateProviderExperimentCost(['a', 'b'], providerInfo) - 0.15) < 1e-9
    && plan.ok === true
    && plan.providerList.length === 2
    && schedule.cron === '17 9 * * *'
    && schedule.safety.callsProviderOrModel === false;
  return { ok, rankedPlan, rankedExec, plan, schedule, safety: PROVIDER_EXPERIMENT_SAFETY };
}
