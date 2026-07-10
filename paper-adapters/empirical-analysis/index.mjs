import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDir,
  dirExists,
  fileRecord,
  normalizeText,
  nowIso,
  pathWithin,
  readJsonIfExists,
  readTextIfExists,
  relativePath,
  sha256Text,
  uniqueStrings,
  walkFiles,
  writeJsonFile,
  writeTextFile,
} from '../../paper-core/src/utils.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contracts.mjs';
import { buildEmpiricalEvidenceGate } from './evidence-policy.mjs';

function repoPath(root, value) {
  const text = normalizeText(value);
  if (!text) return null;
  return path.isAbsolute(text) ? text : path.join(root, text);
}

function escapeTexText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

async function readSourceText(root, row) {
  const mainTex = repoPath(root, row?.task?.mainTex);
  const text = await readTextIfExists(mainTex);
  return normalizeText(text || '');
}

function countSignals(text, signals = []) {
  const lower = normalizeText(text).toLowerCase();
  let count = 0;
  for (const signal of signals) {
    if (lower.includes(signal)) count += 1;
  }
  return count;
}

function buildEmpiricalBenchmarkRegistry({ createdAt = null } = {}) {
  const profiles = [
    {
      id: 'rl_stochastic_control_benchmark',
      label: 'RL stochastic-control benchmark suite',
      domains: ['machine_learning', 'reinforcement_learning', 'control'],
      venueFamilies: ['jmlr', 'tmlr', 'neurips', 'icml', 'automatica', 'ieee_tac'],
      signals: ['reinforcement learning', 'q-learning', 'q learning', 'rl', 'stochastic control', 'control', 'policy', 'markov', 'bellman'],
      datasets: ['generated_stochastic_control_benchmark'],
      metrics: ['mean_return', 'tail_return', 'constraint_violation_rate', 'robustness_gap'],
      questions: [
        'Does the proposed robust policy improve lower-tail return under distribution shift?',
        'Does the proposed policy reduce constraint violations relative to nominal baselines?',
        'Are improvements reproducible across deterministic seeds?',
      ],
      defaultSeeds: [17, 23, 31, 43, 59],
      defaultRepetitions: 64,
      tableSpec: {
        id: 'policy_stress_test_summary_table',
        caption: 'Local policy stress-test summary',
        columns: ['policy', 'mean_return', 'tail_return', 'constraint_violation_rate', 'standard_error'],
      },
      figureSpec: {
        id: 'robustness_gap_bar_chart',
        caption: 'Robustness gap against nominal and simple baselines',
        source: 'results/empirical_summary.json',
      },
    },
    {
      id: 'ml_algorithm_benchmark',
      label: 'ML algorithm benchmark suite',
      domains: ['machine_learning', 'artificial_intelligence', 'optimization'],
      venueFamilies: ['jmlr', 'tmlr', 'neurips', 'icml', 'iclr'],
      signals: ['machine learning', 'classification', 'regression', 'optimization', 'algorithm', 'learning', 'benchmark'],
      datasets: ['generated_ml_benchmark'],
      metrics: ['mean_score', 'standard_error', 'baseline_gap', 'robustness_gap'],
      questions: [
        'Does the proposed method outperform a simple baseline on a controlled benchmark?',
        'Are reported gains stable across seeds and perturbation levels?',
      ],
      defaultSeeds: [17, 23, 31, 43, 59],
      defaultRepetitions: 64,
      tableSpec: {
        id: 'algorithm_baseline_summary_table',
        caption: 'Algorithm baseline comparison summary',
        columns: ['policy', 'mean_score', 'standard_error', 'robustness_gap'],
      },
      figureSpec: {
        id: 'baseline_gap_chart',
        caption: 'Baseline gap across controlled difficulty levels',
        source: 'results/empirical_summary.json',
      },
    },
    {
      id: 'econometrics_panel_benchmark',
      label: 'Econometrics panel robustness suite',
      domains: ['economics', 'econometrics', 'business'],
      venueFamilies: ['aer', 'qje', 'jpe', 'econometrica', 'restud', 'management_science'],
      signals: ['economics', 'econometric', 'panel', 'causal', 'market', 'policy', 'treatment', 'instrument'],
      datasets: ['authorized_or_generated_panel_dataset'],
      metrics: ['mean_effect', 'standard_error', 'placebo_gap', 'robustness_gap'],
      questions: [
        'Is the main estimated effect stable across controlled perturbations?',
        'Do placebo and sensitivity checks support the claimed direction?',
      ],
      defaultSeeds: [19, 29, 37, 47, 61],
      defaultRepetitions: 80,
      tableSpec: {
        id: 'econometric_robustness_table',
        caption: 'Robustness and placebo summary',
        columns: ['policy', 'mean_score', 'standard_error', 'robustness_gap'],
      },
      figureSpec: {
        id: 'effect_stability_chart',
        caption: 'Effect stability under perturbation levels',
        source: 'results/empirical_summary.json',
      },
    },
    {
      id: 'finance_asset_pricing_benchmark',
      label: 'Finance asset-pricing robustness suite',
      domains: ['finance', 'asset_pricing', 'corporate_finance'],
      venueFamilies: ['journal_finance', 'jfe', 'rfs', 'econometrica'],
      signals: ['finance', 'asset pricing', 'return', 'portfolio', 'factor', 'risk premium', 'corporate finance'],
      datasets: ['authorized_or_generated_finance_panel'],
      metrics: ['mean_return', 'tail_return', 'standard_error', 'robustness_gap'],
      questions: [
        'Does the claimed factor or policy signal survive stress-test perturbations?',
        'Are tail outcomes and uncertainty reported alongside average performance?',
      ],
      defaultSeeds: [13, 31, 41, 53, 67],
      defaultRepetitions: 80,
      tableSpec: {
        id: 'finance_factor_stress_table',
        caption: 'Finance factor stress-test summary',
        columns: ['policy', 'mean_return', 'tail_return', 'standard_error'],
      },
      figureSpec: {
        id: 'tail_return_chart',
        caption: 'Tail-return comparison under stress levels',
        source: 'results/empirical_summary.json',
      },
    },
    {
      id: 'operations_optimization_benchmark',
      label: 'Operations and optimization benchmark suite',
      domains: ['operations_research', 'optimization', 'management_science'],
      venueFamilies: ['operations_research', 'management_science', 'moor', 'msom', 'informs_joc'],
      signals: ['operations', 'optimization', 'inventory', 'queue', 'scheduling', 'service', 'supply chain'],
      datasets: ['authorized_or_generated_operations_instances'],
      metrics: ['mean_score', 'constraint_violation_rate', 'standard_error', 'robustness_gap'],
      questions: [
        'Does the method improve objective quality under controlled demand or instance perturbations?',
        'Are feasibility and service-level violations reported?',
      ],
      defaultSeeds: [11, 23, 47, 71, 89],
      defaultRepetitions: 80,
      tableSpec: {
        id: 'operations_instance_summary_table',
        caption: 'Operations benchmark summary',
        columns: ['policy', 'mean_score', 'constraint_violation_rate', 'standard_error'],
      },
      figureSpec: {
        id: 'service_robustness_chart',
        caption: 'Service and feasibility robustness by method',
        source: 'results/empirical_summary.json',
      },
    },
  ];
  const registry = {
    version: 1,
    kind: 'EmpiricalBenchmarkRegistry',
    status: 'empirical_benchmark_registry_ready',
    profileCount: profiles.length,
    profiles,
    safety: {
      localOnly: true,
      noExternalDatasetFetch: true,
      deterministicAgentSelection: true,
      regexRouting: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...registry,
    empiricalBenchmarkRegistryHash: hashPaperRecord('EmpiricalBenchmarkRegistry', registry),
  };
}

function selectBenchmarkSuite({
  paperTask,
  targetProfile,
  sourceText,
  benchmarkRegistry,
  createdAt = null,
}) {
  const text = [
    paperTask?.title,
    paperTask?.paperType,
    paperTask?.paperId,
    targetProfile?.profile?.label,
    targetProfile?.profile?.id,
    ...(targetProfile?.profile?.keywords || []),
    sourceText.slice(0, 12000),
  ].join(' ');
  const venueId = normalizeText(targetProfile?.profile?.id || '').toLowerCase();
  const candidates = benchmarkRegistry?.profiles || [];
  const scored = candidates.map((candidate) => ({
    ...candidate,
    signalScore: countSignals(text, candidate.signals),
    venueScore: (candidate.venueFamilies || []).includes(venueId) ? 2 : 0,
    domainScore: countSignals(text, candidate.domains || []),
  })).map((candidate) => ({
    ...candidate,
    score: candidate.signalScore + candidate.venueScore + candidate.domainScore,
  })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const selected = scored[0]?.score > 0
    ? scored[0]
    : candidates.find((candidate) => candidate.id === 'ml_algorithm_benchmark') || candidates[0];
  const policy = {
    version: 1,
    kind: 'BenchmarkSuiteSelectionPolicy',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: selected ? 'benchmark_suite_selection_ready' : 'benchmark_suite_selection_blocked',
    empiricalBenchmarkRegistryHash: benchmarkRegistry?.empiricalBenchmarkRegistryHash || null,
    targetJournalProfileHash: targetProfile?.journalTargetProfileHash || null,
    selectedSuiteId: selected?.id || null,
    selectedSuiteLabel: selected?.label || null,
    candidateScores: scored.map((candidate) => ({
      suiteId: candidate.id,
      score: candidate.score,
      signalScore: candidate.signalScore,
      venueScore: candidate.venueScore,
      domainScore: candidate.domainScore,
    })),
    rationale: selected ? [
      `selected ${selected.label} from target venue, paper metadata, and source evidence signals`,
      'selection is a deterministic local agent decision over structured benchmark profiles',
      'suite selection does not fetch external data and does not imply venue acceptance',
    ] : [],
    safety: {
      deterministicAgentJudgment: true,
      regexRouting: false,
      modelCallPerformed: false,
      externalDataLookup: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...policy,
    selectedSuite: selected || null,
    benchmarkSuiteSelectionPolicyHash: hashPaperRecord('BenchmarkSuiteSelectionPolicy', policy),
  };
}

function judgeEmpiricalDesign({ suiteSelectionPolicy }) {
  const selected = suiteSelectionPolicy?.selectedSuite || {};
  return {
    kind: 'AgentEmpiricalDesignJudgment',
    selectedExperimentFamily: selected.id,
    selectedExperimentLabel: selected.label,
    candidateScores: suiteSelectionPolicy?.candidateScores || [],
    metrics: selected.metrics,
    datasets: selected.datasets,
    questions: selected.questions,
    seeds: selected.defaultSeeds || [17, 23, 31, 43, 59],
    repetitions: selected.defaultRepetitions || 64,
    tableSpec: selected.tableSpec || null,
    figureSpec: selected.figureSpec || null,
    rationale: [
      ...(suiteSelectionPolicy?.rationale || []),
      'uses local deterministic empirical design; DatasetAccessContract binds authorized local data when supplied and otherwise falls back to generated data',
      'results are empirical support artifacts, not external journal acceptance evidence',
    ],
    safety: {
      deterministicAgentJudgment: true,
      regexRouting: false,
      modelCallPerformed: false,
      externalDataLookup: false,
    },
  };
}

function buildEmpiricalAnalysisPlan({
  paperTask,
  targetProfile,
  targetSelectionPolicy,
  benchmarkRegistry,
  suiteSelectionPolicy,
  sourceText,
  createdAt,
}) {
  const blockers = [];
  if (!paperTask?.taskKey) blockers.push('paper_task_missing');
  if (!sourceText) blockers.push('source_text_missing_for_empirical_design');
  if (benchmarkRegistry?.status !== 'empirical_benchmark_registry_ready') {
    blockers.push('empirical_benchmark_registry_not_ready');
  }
  if (suiteSelectionPolicy?.status !== 'benchmark_suite_selection_ready') {
    blockers.push('benchmark_suite_selection_not_ready');
  }
  const judgment = judgeEmpiricalDesign({ suiteSelectionPolicy });
  const plan = {
    version: 1,
    kind: 'EmpiricalAnalysisPlan',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'empirical_analysis_plan_blocked' : 'empirical_analysis_plan_ready',
    targetJournalProfileHash: targetProfile?.journalTargetProfileHash || null,
    targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || null,
    empiricalBenchmarkRegistryHash: benchmarkRegistry?.empiricalBenchmarkRegistryHash || null,
    benchmarkSuiteSelectionPolicyHash: suiteSelectionPolicy?.benchmarkSuiteSelectionPolicyHash || null,
    journalId: targetProfile?.profile?.id || null,
    journalLabel: targetProfile?.profile?.label || null,
    selectedBenchmarkSuiteId: suiteSelectionPolicy?.selectedSuiteId || null,
    selectedBenchmarkSuiteLabel: suiteSelectionPolicy?.selectedSuiteLabel || null,
    agentJudgment: judgment,
    plannedExperiments: [
      {
        id: judgment.selectedExperimentFamily,
        label: judgment.selectedExperimentLabel,
        datasets: judgment.datasets,
        metrics: judgment.metrics,
        questions: judgment.questions,
        seeds: judgment.seeds,
        repetitions: judgment.repetitions,
      },
    ],
    requiredArtifacts: [
      'generated_dataset_manifest',
      'experiment_code',
      'experiment_results_csv',
      'experiment_summary_json',
      'empirical_evidence_manifest',
      'reproducibility_status',
      'latex_table_snippet',
      'figure_spec',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      writesRuntimeOnly: true,
      writesSource: false,
      externalDataAccess: false,
      networkAccess: false,
      modelCallPerformed: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...plan,
    empiricalAnalysisPlanHash: hashPaperRecord('EmpiricalAnalysisPlan', plan),
  };
}

function unsafeDatasetPath(value) {
  const text = normalizeText(value).toLowerCase();
  return /(^|\/)(\.ssh|\.gnupg|\.config|\.openclaw|credentials?|secrets?|tokens?|cookies?)(\/|$)/.test(text);
}

async function buildLocalBenchmarkRegistry({
  root,
  runtimeRoot,
  datasetRoot = null,
  benchmarkId = null,
  paperTask = null,
  createdAt = null,
} = {}) {
  const normalizedDatasetRoot = normalizeText(datasetRoot || '');
  const blockers = [];
  const records = [];
  let resolvedDatasetRoot = null;
  let registryManifest = null;
  if (normalizedDatasetRoot) {
    if (path.isAbsolute(normalizedDatasetRoot)) {
      resolvedDatasetRoot = path.resolve(normalizedDatasetRoot);
    } else {
      const candidates = uniqueStrings([
        path.resolve(root, normalizedDatasetRoot),
        path.resolve(runtimeRoot, normalizedDatasetRoot),
        path.resolve(process.cwd(), normalizedDatasetRoot),
      ], 8);
      resolvedDatasetRoot = candidates[0];
      for (const candidate of candidates) {
        if (await dirExists(candidate)) {
          resolvedDatasetRoot = candidate;
          break;
        }
      }
    }
    if (unsafeDatasetPath(resolvedDatasetRoot)) blockers.push('unsafe_dataset_path_rejected');
    if (!pathWithin(root, resolvedDatasetRoot) && !pathWithin(runtimeRoot, resolvedDatasetRoot)) {
      blockers.push('dataset_root_outside_hepta_workspace');
    }
    if (!blockers.length) {
      registryManifest = await readJsonIfExists(path.join(resolvedDatasetRoot, 'BENCHMARK_REGISTRY.json'));
      const files = await walkFiles(resolvedDatasetRoot, {
        maxDepth: 4,
        maxFiles: 256,
        includeHidden: false,
        match: (_full, name) => name !== 'BENCHMARK_REGISTRY.json'
          && /\.(csv|json|jsonl|txt|md)$/i.test(name)
          && !/credential|secret|token|cookie/i.test(name),
      });
      for (const file of files.slice(0, 128)) {
        const record = await fileRecord(root, file, 'authorized_local_dataset');
        if (record) records.push(record);
      }
      if (!records.length) blockers.push('authorized_dataset_files_missing');
    }
  }
  const primaryDataset = records.find((record) => /\.(csv|json|jsonl)$/i.test(record.filename))
    || records[0]
    || null;
  const registry = {
    version: 1,
    kind: 'LocalBenchmarkRegistry',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: normalizedDatasetRoot
      ? blockers.length
        ? 'local_benchmark_registry_blocked'
        : 'local_benchmark_registry_ready'
      : 'local_benchmark_registry_not_requested',
    benchmarkId: normalizeText(benchmarkId || registryManifest?.benchmarkId || registryManifest?.id || '') || null,
    manifest: registryManifest
      ? {
        kind: normalizeText(registryManifest.kind || '') || 'BenchmarkRegistryManifest',
        label: normalizeText(registryManifest.label || registryManifest.name || '') || null,
        task: normalizeText(registryManifest.task || registryManifest.description || '') || null,
      }
      : null,
    datasetRoot: resolvedDatasetRoot ? relativePath(root, resolvedDatasetRoot) : null,
    primaryDataset,
    datasetFiles: records,
    datasetFileCount: records.length,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      explicitDatasetRootRequired: true,
      externalDataAccess: false,
      credentialAccess: false,
      networkAccess: false,
      readsOnly: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...registry,
    localBenchmarkRegistryHash: hashPaperRecord('LocalBenchmarkRegistry', registry),
  };
}

function buildDatasetAccessContract({
  root,
  paperTask,
  plan,
  runDir,
  localBenchmarkRegistry = null,
  createdAt,
}) {
  const blockers = [];
  if (plan.status !== 'empirical_analysis_plan_ready') blockers.push('empirical_analysis_plan_not_ready');
  const authorizedLocalDatasetReady = localBenchmarkRegistry?.status === 'local_benchmark_registry_ready'
    && localBenchmarkRegistry?.primaryDataset?.path;
  if (localBenchmarkRegistry?.status === 'local_benchmark_registry_blocked') {
    blockers.push('local_benchmark_registry_not_ready');
  }
  const datasetMode = authorizedLocalDatasetReady
    ? 'authorized_local_dataset'
    : 'local_synthetic_generated';
  const authorizedDatasets = authorizedLocalDatasetReady
    ? (localBenchmarkRegistry.datasetFiles || []).map((record) => ({
      datasetId: localBenchmarkRegistry.benchmarkId || record.filename,
      source: 'authorized_local_dataset_root',
      path: record.path,
      hash: record.hash,
      filename: record.filename,
      sizeBytes: record.sizeBytes,
      licenseBoundary: 'operator_authorized_local_data',
      externalAccessRequired: false,
    }))
    : plan.agentJudgment.datasets.map((datasetId) => ({
      datasetId,
      source: 'generated_by_local_experiment_script',
      licenseBoundary: 'local_generated_no_external_data',
      externalAccessRequired: false,
    }));
  const contract = {
    version: 1,
    kind: 'DatasetAccessContract',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'dataset_access_contract_blocked' : 'dataset_access_contract_ready',
    empiricalAnalysisPlanHash: plan.empiricalAnalysisPlanHash,
    localBenchmarkRegistryHash: localBenchmarkRegistry?.localBenchmarkRegistryHash || null,
    datasetMode,
    authorizedDatasets,
    primaryDataset: authorizedLocalDatasetReady ? localBenchmarkRegistry.primaryDataset : null,
    primaryDatasetAbsolutePath: authorizedLocalDatasetReady
      ? repoPath(root, localBenchmarkRegistry.primaryDataset.path)
      : null,
    datasetRoot: authorizedLocalDatasetReady
      ? localBenchmarkRegistry.datasetRoot
      : relativePath(root, path.join(runDir, 'data')),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      authorizedLocalData: authorizedLocalDatasetReady,
      generatedSyntheticFallback: !authorizedLocalDatasetReady,
      externalDataAccess: false,
      credentialAccess: false,
      networkAccess: false,
      writesRuntimeOnly: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...contract,
    datasetAccessContractHash: hashPaperRecord('DatasetAccessContract', contract),
  };
}

function buildDatasetLicenseProvenanceGate({
  paperTask,
  suiteSelectionPolicy,
  localBenchmarkRegistry,
  datasetContract,
  createdAt,
}) {
  const blockers = [];
  if (suiteSelectionPolicy?.status !== 'benchmark_suite_selection_ready') {
    blockers.push('benchmark_suite_selection_not_ready');
  }
  if (datasetContract?.status !== 'dataset_access_contract_ready') {
    blockers.push('dataset_access_contract_not_ready');
  }
  if (datasetContract?.datasetMode === 'authorized_local_dataset' && !datasetContract.primaryDataset?.hash) {
    blockers.push('authorized_primary_dataset_hash_missing');
  }
  const gate = {
    version: 1,
    kind: 'DatasetLicenseProvenanceGate',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length
      ? 'dataset_license_provenance_gate_blocked'
      : 'dataset_license_provenance_gate_ready',
    benchmarkSuiteSelectionPolicyHash: suiteSelectionPolicy?.benchmarkSuiteSelectionPolicyHash || null,
    localBenchmarkRegistryHash: localBenchmarkRegistry?.localBenchmarkRegistryHash || null,
    datasetAccessContractHash: datasetContract?.datasetAccessContractHash || null,
    datasetMode: datasetContract?.datasetMode || null,
    provenance: datasetContract?.datasetMode === 'authorized_local_dataset'
      ? {
        boundary: 'operator_authorized_local_data',
        datasetRoot: datasetContract.datasetRoot || null,
        primaryDatasetPath: datasetContract.primaryDataset?.path || null,
        primaryDatasetHash: datasetContract.primaryDataset?.hash || null,
        datasetFileCount: localBenchmarkRegistry?.datasetFileCount || 0,
      }
      : {
        boundary: 'local_generated_no_external_data',
        datasetRoot: datasetContract?.datasetRoot || null,
        primaryDatasetPath: null,
        primaryDatasetHash: null,
        datasetFileCount: 0,
      },
    licenseBoundary: datasetContract?.datasetMode === 'authorized_local_dataset'
      ? 'operator_authorized_local_data'
      : 'local_generated_no_external_data',
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      externalDataAccess: false,
      credentialAccess: false,
      networkAccess: false,
      sourceMutation: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...gate,
    datasetLicenseProvenanceGateHash: hashPaperRecord('DatasetLicenseProvenanceGate', gate),
  };
}

function buildTableFigureSpec({
  paperTask,
  plan,
  suiteSelectionPolicy,
  datasetContract,
  createdAt,
}) {
  const blockers = [];
  if (plan.status !== 'empirical_analysis_plan_ready') blockers.push('empirical_analysis_plan_not_ready');
  if (suiteSelectionPolicy?.status !== 'benchmark_suite_selection_ready') {
    blockers.push('benchmark_suite_selection_not_ready');
  }
  const selectedSuite = suiteSelectionPolicy?.selectedSuite || {};
  if (!selectedSuite.tableSpec?.id) blockers.push('table_spec_missing');
  if (!selectedSuite.figureSpec?.id) blockers.push('figure_spec_missing');
  const spec = {
    version: 1,
    kind: 'TableFigureSpec',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'table_figure_spec_blocked' : 'table_figure_spec_ready',
    empiricalAnalysisPlanHash: plan.empiricalAnalysisPlanHash,
    benchmarkSuiteSelectionPolicyHash: suiteSelectionPolicy?.benchmarkSuiteSelectionPolicyHash || null,
    datasetAccessContractHash: datasetContract?.datasetAccessContractHash || null,
    selectedSuiteId: suiteSelectionPolicy?.selectedSuiteId || null,
    tableSpec: selectedSuite.tableSpec || null,
    figureSpec: selectedSuite.figureSpec || null,
    requiredArtifactRoles: [
      'empirical_table_tex',
      'empirical_figure_spec_json',
      'empirical_summary_json',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      writesRuntimeOnly: true,
      writesSource: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...spec,
    tableFigureSpecHash: hashPaperRecord('TableFigureSpec', spec),
  };
}

import { experimentConfig, makeExperimentCode } from './experiment-runner.mjs';

function buildExperimentCodePatchBundle({
  paperTask,
  plan,
  datasetContract,
  tableFigureSpec,
  codeText,
  codeRecord = null,
  execute = false,
  createdAt,
}) {
  const blockers = [];
  if (plan.status !== 'empirical_analysis_plan_ready') blockers.push('empirical_analysis_plan_not_ready');
  if (datasetContract.status !== 'dataset_access_contract_ready') blockers.push('dataset_access_contract_not_ready');
  const bundle = {
    version: 1,
    kind: 'ExperimentCodePatchBundle',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length
      ? 'experiment_code_patch_bundle_blocked'
      : execute
        ? 'experiment_code_patch_bundle_written'
        : 'experiment_code_patch_bundle_planned',
    empiricalAnalysisPlanHash: plan.empiricalAnalysisPlanHash,
    datasetAccessContractHash: datasetContract.datasetAccessContractHash,
    tableFigureSpecHash: tableFigureSpec?.tableFigureSpecHash || null,
    language: 'nodejs',
    codePath: codeRecord?.path || 'runtime_empirical_analysis_code_pending',
    codeHash: codeRecord?.hash || sha256Text(codeText),
    generatedBy: 'openclaw-agent-empirical-analysis',
    blockers: uniqueStrings(blockers, 32),
    safety: {
      writesRuntimeOnly: true,
      writesSource: false,
      importsOldControlPlane: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...bundle,
    experimentCodePatchBundleHash: hashPaperRecord('ExperimentCodePatchBundle', bundle),
  };
}

function buildSandboxExecutionPlan({
  paperTask,
  plan,
  datasetContract,
  codeBundle,
  command,
  cwd,
  execute = false,
  createdAt,
}) {
  const blockers = [];
  if (codeBundle.status === 'experiment_code_patch_bundle_blocked') blockers.push('experiment_code_patch_bundle_not_ready');
  if (!execute) blockers.push('empirical_analysis_execute_not_requested');
  const packet = {
    version: 1,
    kind: 'SandboxExecutionPlan',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'sandbox_execution_plan_blocked' : 'sandbox_execution_plan_ready',
    empiricalAnalysisPlanHash: plan.empiricalAnalysisPlanHash,
    datasetAccessContractHash: datasetContract.datasetAccessContractHash,
    experimentCodePatchBundleHash: codeBundle.experimentCodePatchBundleHash,
    command,
    cwd,
    timeoutMs: 60000,
    environment: {
      nodeVersion: process.version,
      networkAccessExpected: false,
    },
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      writesRuntimeOnly: true,
      writesSource: false,
      externalDataAccess: false,
      networkAccess: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    sandboxExecutionPlanHash: hashPaperRecord('SandboxExecutionPlan', packet),
  };
}

function buildExperimentRunReceipt({
  paperTask,
  sandboxPlan,
  result,
  stdoutRecord = null,
  stderrRecord = null,
  startedAt = null,
  completedAt = null,
}) {
  const executed = Boolean(result);
  const blockers = [];
  if (sandboxPlan.status !== 'sandbox_execution_plan_ready') blockers.push('sandbox_execution_plan_not_ready');
  if (!executed) blockers.push('experiment_run_not_executed');
  if (executed && result.status !== 0) blockers.push('experiment_command_failed');
  if (executed && result.error) blockers.push('experiment_command_error');
  const receipt = {
    version: 1,
    kind: 'ExperimentRunReceipt',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'experiment_run_receipt_blocked' : 'experiment_run_receipt_recorded',
    sandboxExecutionPlanHash: sandboxPlan.sandboxExecutionPlanHash,
    command: sandboxPlan.command,
    cwd: sandboxPlan.cwd,
    startedAt,
    completedAt,
    exitCode: executed ? result.status : null,
    signal: executed ? result.signal : null,
    stdoutHash: stdoutRecord?.hash || null,
    stderrHash: stderrRecord?.hash || null,
    stdoutPath: stdoutRecord?.path || null,
    stderrPath: stderrRecord?.path || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      writesRuntimeOnly: true,
      writesSource: false,
      externalDataAccess: false,
      networkAccess: false,
      externalActionPerformed: false,
    },
    createdAt: completedAt || nowIso(),
  };
  return {
    ...receipt,
    experimentRunReceiptHash: hashPaperRecord('ExperimentRunReceipt', receipt),
  };
}

async function recordArtifacts(root, files) {
  const records = [];
  for (const [file, role] of files) {
    const record = await fileRecord(root, file, role);
    if (record) records.push(record);
  }
  return records;
}

function buildResultArtifactPackage({
  paperTask,
  plan,
  datasetContract,
  datasetLicenseProvenanceGate,
  tableFigureSpec,
  codeBundle,
  runReceipt,
  artifacts,
  createdAt,
}) {
  const blockers = [];
  if (runReceipt.status !== 'experiment_run_receipt_recorded') blockers.push('experiment_run_receipt_not_recorded');
  const roles = new Set((artifacts || []).map((artifact) => artifact.role));
  for (const role of [
    'empirical_results_csv',
    'empirical_summary_json',
    'empirical_evidence_manifest',
    'empirical_reproducibility_status',
    'empirical_table_tex',
    'empirical_figure_spec_json',
  ]) {
    if (!roles.has(role)) blockers.push(`${role}_missing`);
  }
  if (!roles.has('generated_dataset_manifest') && !roles.has('authorized_dataset_manifest')) {
    blockers.push('dataset_manifest_missing');
  }
  const packet = {
    version: 1,
    kind: 'ResultArtifactPackage',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'result_artifact_package_blocked' : 'result_artifact_package_ready',
    empiricalAnalysisPlanHash: plan.empiricalAnalysisPlanHash,
    datasetAccessContractHash: datasetContract.datasetAccessContractHash,
    datasetLicenseProvenanceGateHash: datasetLicenseProvenanceGate?.datasetLicenseProvenanceGateHash || null,
    tableFigureSpecHash: tableFigureSpec?.tableFigureSpecHash || null,
    experimentCodePatchBundleHash: codeBundle.experimentCodePatchBundleHash,
    experimentRunReceiptHash: runReceipt.experimentRunReceiptHash,
    artifacts,
    artifactCount: artifacts.length,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      writesRuntimeOnly: true,
      writesSource: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    resultArtifactPackageHash: hashPaperRecord('ResultArtifactPackage', packet),
  };
}

function manuscriptPatchText({ paperTask, plan, resultPackage }) {
  const artifacts = Object.fromEntries((resultPackage.artifacts || []).map((artifact) => [artifact.role, artifact]));
  const hasAuthorizedDataset = Boolean(artifacts.authorized_dataset_manifest);
  return [
    '# Manuscript Empirical Patch Draft',
    '',
    `paper_id: ${paperTask.paperId}`,
    `experiment_family: ${plan.agentJudgment.selectedExperimentFamily}`,
    '',
    '## Suggested empirical-analysis paragraph',
    '',
    hasAuthorizedDataset
      ? 'We add a local deterministic empirical stress test to complement the main claim. The experiment consumes the authorized local dataset recorded in the dataset manifest and compares the paper-specific agent against nominal and simple baselines under controlled perturbation levels. The associated result files, seeds, and dataset manifest are hash-bound in the empirical evidence package.'
      : 'We add a local deterministic empirical stress test to complement the main claim. The experiment uses generated synthetic data only and compares the paper-specific agent against nominal and simple baselines under controlled perturbation levels. The associated result files, seeds, and generated dataset manifest are hash-bound in the empirical evidence package.',
    '',
    '## Suggested artifacts',
    '',
    `- results CSV: ${artifacts.empirical_results_csv?.path || 'missing'}`,
    `- summary JSON: ${artifacts.empirical_summary_json?.path || 'missing'}`,
    `- table TeX: ${artifacts.empirical_table_tex?.path || 'missing'}`,
    `- figure spec: ${artifacts.empirical_figure_spec_json?.path || 'missing'}`,
    `- evidence manifest: ${artifacts.empirical_evidence_manifest?.path || 'missing'}`,
    `- authorized dataset manifest: ${artifacts.authorized_dataset_manifest?.path || 'not_used'}`,
    '',
    '## Boundary',
    '',
    'This patch draft is not applied to source automatically. It is local generated evidence, not external benchmark evidence and not live venue acceptance.',
    '',
  ].join('\n');
}

function empiricalLatexBlock({
  paperTask,
  plan,
  datasetContract,
  datasetLicenseProvenanceGate,
  tableFigureSpec,
  resultPackage,
}) {
  const artifacts = Object.fromEntries((resultPackage.artifacts || []).map((artifact) => [artifact.role, artifact]));
  const tablePath = 'empirical/table_empirical_summary.tex';
  const figureSpecPath = 'empirical/figure_spec.json';
  const sourceKind = datasetContract.datasetMode === 'authorized_local_dataset'
    ? 'authorized local benchmark data'
    : 'locally generated benchmark data';
  const suite = plan.selectedBenchmarkSuiteLabel || plan.agentJudgment.selectedExperimentLabel;
  const caption = tableFigureSpec?.tableSpec?.caption || 'Local empirical benchmark summary';
  const beginMarker = `% BEGIN HEPTA EMPIRICAL ANALYSIS: ${paperTask.paperId}`;
  const endMarker = `% END HEPTA EMPIRICAL ANALYSIS: ${paperTask.paperId}`;
  return [
    beginMarker,
    '\\section{Empirical Analysis}',
    `We add a controlled empirical analysis using ${escapeTexText(sourceKind)} for the ${escapeTexText(suite)}. The run compares the paper-specific agent against nominal and simple baselines under deterministic perturbation levels. All generated results, seeds, stdout/stderr, dataset provenance, and table/figure specifications are recorded in the local empirical evidence package.`,
    '',
    '\\paragraph{Evidence boundary.}',
    `The empirical package is local-only and hash-bound. Dataset provenance is recorded by \\texttt{DatasetAccessContract} and \\texttt{DatasetLicenseProvenanceGate}; the current evidence mode is \\texttt{${escapeTexText(datasetContract.datasetMode)}}. No external data lookup, model call, portal action, or live venue submission is performed by this analysis.`,
    '',
    '\\begin{table}[t]',
    '\\centering',
    `\\caption{${escapeTexText(caption)}}`,
    `\\input{${tablePath}}`,
    '\\end{table}',
    '',
    `The accompanying figure specification is stored at \\texttt{${escapeTexText(figureSpecPath)}} and references the empirical summary artifact. The runtime evidence manifest is recorded at \\texttt{${escapeTexText(artifacts.empirical_evidence_manifest?.path || 'missing')}}.`,
    endMarker,
    '',
  ].join('\n');
}

function replaceEmpiricalBlock(sourceText, paperId, blockText) {
  const beginMarker = `% BEGIN HEPTA EMPIRICAL ANALYSIS: ${paperId}`;
  const endMarker = `% END HEPTA EMPIRICAL ANALYSIS: ${paperId}`;
  const beginIndex = sourceText.indexOf(beginMarker);
  const endIndex = sourceText.indexOf(endMarker);
  if (beginIndex >= 0 && endIndex > beginIndex) {
    const afterEnd = endIndex + endMarker.length;
    return {
      text: sourceText.slice(0, beginIndex) + blockText + sourceText.slice(afterEnd).replace(/^\n+/, '\n'),
      mode: 'replace_existing_empirical_block',
    };
  }
  const endDocument = sourceText.lastIndexOf('\\end{document}');
  if (endDocument >= 0) {
    return {
      text: sourceText.slice(0, endDocument).replace(/\s*$/, '\n\n') + blockText + '\n' + sourceText.slice(endDocument),
      mode: 'insert_before_end_document',
    };
  }
  return {
    text: sourceText.replace(/\s*$/, '\n\n') + blockText,
    mode: 'append_to_main_tex',
  };
}

function buildManuscriptEmpiricalApplyApprovalPacket({
  paperTask,
  manuscriptEmpiricalPatch,
  applyManuscript = false,
  createdAt,
}) {
  const blockers = [];
  if (manuscriptEmpiricalPatch.status !== 'manuscript_empirical_patch_ready') {
    blockers.push('manuscript_empirical_patch_not_ready');
  }
  if (!applyManuscript) blockers.push('explicit_empirical_manuscript_apply_required');
  const packet = {
    version: 1,
    kind: 'ManuscriptEmpiricalApplyApprovalPacket',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length
      ? 'manuscript_empirical_apply_approval_blocked'
      : 'manuscript_empirical_apply_approval_ready',
    approved: blockers.length === 0,
    approvalActor: blockers.length === 0 ? 'agent' : null,
    manuscriptEmpiricalPatchHash: manuscriptEmpiricalPatch.manuscriptEmpiricalPatchHash,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      explicitApplyFlagRequired: true,
      sourceMutationAuthorized: blockers.length === 0,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    manuscriptEmpiricalApplyApprovalPacketHash: hashPaperRecord(
      'ManuscriptEmpiricalApplyApprovalPacket',
      packet,
    ),
  };
}

async function buildManuscriptEmpiricalApplyPlan({
  root,
  row,
  approvalPacket,
  manuscriptEmpiricalPatch,
  resultPackage,
  createdAt,
}) {
  const mainTexAbs = repoPath(root, row?.task?.mainTex);
  const sourceDirAbs = repoPath(root, row?.task?.sourceWorkspace);
  const blockers = [];
  if (approvalPacket.status !== 'manuscript_empirical_apply_approval_ready') {
    blockers.push('manuscript_empirical_apply_approval_not_ready');
  }
  if (!mainTexAbs) blockers.push('main_tex_missing');
  if (!sourceDirAbs) blockers.push('source_workspace_missing');
  if (mainTexAbs && !pathWithin(root, mainTexAbs)) blockers.push('main_tex_outside_root');
  if (sourceDirAbs && !pathWithin(root, sourceDirAbs)) blockers.push('source_workspace_outside_root');
  const preimageRecord = mainTexAbs ? await fileRecord(root, mainTexAbs, 'empirical_apply_main_tex_preimage') : null;
  if (!preimageRecord) blockers.push('main_tex_preimage_missing');
  const artifacts = Object.fromEntries((resultPackage.artifacts || []).map((artifact) => [artifact.role, artifact]));
  const tableArtifact = artifacts.empirical_table_tex || null;
  const figureArtifact = artifacts.empirical_figure_spec_json || null;
  if (!tableArtifact?.path) blockers.push('empirical_table_artifact_missing');
  if (!figureArtifact?.path) blockers.push('empirical_figure_spec_artifact_missing');
  const plan = {
    version: 1,
    kind: 'ManuscriptEmpiricalApplyPlan',
    paperId: row?.task?.paperId || null,
    taskKey: row?.task?.taskKey || null,
    status: blockers.length ? 'manuscript_empirical_apply_plan_blocked' : 'manuscript_empirical_apply_plan_ready',
    manuscriptEmpiricalApplyApprovalPacketHash: approvalPacket.manuscriptEmpiricalApplyApprovalPacketHash,
    manuscriptEmpiricalPatchHash: manuscriptEmpiricalPatch.manuscriptEmpiricalPatchHash,
    resultArtifactPackageHash: resultPackage.resultArtifactPackageHash,
    targetMainTex: mainTexAbs ? relativePath(root, mainTexAbs) : null,
    sourceWorkspace: sourceDirAbs ? relativePath(root, sourceDirAbs) : null,
    preimageRecord,
    sourceAdjuncts: [
      {
        role: 'empirical_table_tex_source_adjunct',
        sourceArtifactPath: tableArtifact?.path || null,
        targetPath: sourceDirAbs ? relativePath(root, path.join(sourceDirAbs, 'empirical', 'table_empirical_summary.tex')) : null,
      },
      {
        role: 'empirical_figure_spec_source_adjunct',
        sourceArtifactPath: figureArtifact?.path || null,
        targetPath: sourceDirAbs ? relativePath(root, path.join(sourceDirAbs, 'empirical', 'figure_spec.json')) : null,
      },
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      sourceMutationPlanned: blockers.length === 0,
      markerBasedIdempotentApply: true,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...plan,
    manuscriptEmpiricalApplyPlanHash: hashPaperRecord('ManuscriptEmpiricalApplyPlan', plan),
  };
}

async function applyManuscriptEmpiricalPatch({
  root,
  row,
  plan,
  datasetContract,
  datasetLicenseProvenanceGate,
  tableFigureSpec,
  resultPackage,
  empiricalAnalysisPlan,
}) {
  const blockers = [];
  if (plan.status !== 'manuscript_empirical_apply_plan_ready') {
    blockers.push('manuscript_empirical_apply_plan_not_ready');
  }
  const mainTexAbs = repoPath(root, row?.task?.mainTex);
  const sourceDirAbs = repoPath(root, row?.task?.sourceWorkspace);
  const tableSource = repoPath(root, plan.sourceAdjuncts?.[0]?.sourceArtifactPath);
  const figureSource = repoPath(root, plan.sourceAdjuncts?.[1]?.sourceArtifactPath);
  const tableTarget = sourceDirAbs ? path.join(sourceDirAbs, 'empirical', 'table_empirical_summary.tex') : null;
  const figureTarget = sourceDirAbs ? path.join(sourceDirAbs, 'empirical', 'figure_spec.json') : null;
  let applyMode = null;
  let postimageRecord = null;
  const adjunctRecords = [];
  let changed = false;
  if (!blockers.length) {
    const sourceText = await readTextIfExists(mainTexAbs);
    const tableText = await readTextIfExists(tableSource);
    const figureText = await readTextIfExists(figureSource);
    if (!sourceText) blockers.push('main_tex_text_missing');
    if (!tableText) blockers.push('empirical_table_text_missing');
    if (!figureText) blockers.push('empirical_figure_spec_text_missing');
    if (!blockers.length) {
      await ensureDir(path.dirname(tableTarget));
      await writeTextFile(tableTarget, tableText);
      await writeTextFile(figureTarget, figureText);
      const tableRecord = await fileRecord(root, tableTarget, 'empirical_table_tex_source_adjunct');
      const figureRecord = await fileRecord(root, figureTarget, 'empirical_figure_spec_source_adjunct');
      if (tableRecord) adjunctRecords.push(tableRecord);
      if (figureRecord) adjunctRecords.push(figureRecord);
      const blockText = empiricalLatexBlock({
        paperTask: row.task,
        plan: empiricalAnalysisPlan,
        datasetContract,
        datasetLicenseProvenanceGate,
        tableFigureSpec,
        resultPackage,
      });
      const replacement = replaceEmpiricalBlock(sourceText, row.task.paperId, blockText);
      applyMode = replacement.mode;
      changed = replacement.text !== sourceText || adjunctRecords.length > 0;
      await writeTextFile(mainTexAbs, replacement.text.endsWith('\n') ? replacement.text : replacement.text + '\n');
      postimageRecord = await fileRecord(root, mainTexAbs, 'empirical_apply_main_tex_postimage');
    }
  }
  const receipt = {
    version: 1,
    kind: 'ManuscriptEmpiricalApplyReceipt',
    paperId: row?.task?.paperId || null,
    taskKey: row?.task?.taskKey || null,
    status: blockers.length ? 'manuscript_empirical_apply_blocked' : 'manuscript_empirical_apply_applied',
    manuscriptEmpiricalApplyPlanHash: plan.manuscriptEmpiricalApplyPlanHash,
    targetMainTex: plan.targetMainTex,
    applyMode,
    changed,
    preimageRecord: plan.preimageRecord || null,
    postimageRecord,
    sourceAdjunctRecords: adjunctRecords,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      sourceMutation: blockers.length === 0,
      markerBasedIdempotentApply: true,
      externalActionPerformed: false,
      liveSubmissionPerformed: false,
    },
    createdAt: nowIso(),
  };
  return {
    ...receipt,
    manuscriptEmpiricalApplyReceiptHash: hashPaperRecord('ManuscriptEmpiricalApplyReceipt', receipt),
  };
}

function buildManuscriptEmpiricalPatch({
  paperTask,
  plan,
  evidenceGate,
  resultPackage,
  patchRecord = null,
  createdAt,
}) {
  const blockers = [];
  if (evidenceGate.status !== 'empirical_evidence_gate_ready') blockers.push('empirical_evidence_gate_not_ready');
  const packet = {
    version: 1,
    kind: 'ManuscriptEmpiricalPatch',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'manuscript_empirical_patch_blocked' : 'manuscript_empirical_patch_ready',
    empiricalAnalysisPlanHash: plan.empiricalAnalysisPlanHash,
    empiricalEvidenceGateHash: evidenceGate.empiricalEvidenceGateHash,
    resultArtifactPackageHash: resultPackage.resultArtifactPackageHash,
    patchPath: patchRecord?.path || null,
    patchHash: patchRecord?.hash || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      patchDraftOnly: true,
      writesRuntimeOnly: true,
      writesSource: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    manuscriptEmpiricalPatchHash: hashPaperRecord('ManuscriptEmpiricalPatch', packet),
  };
}

export async function runEmpiricalAnalysisAdapter({
  root = null,
  runtimeRoot = null,
  row = null,
  targetProfile = null,
  targetSelectionPolicy = null,
  datasetRoot = null,
  benchmarkId = null,
  applyManuscript = false,
  execute = false,
} = {}) {
  if (!root || !row?.task?.paperId) throw new Error('runEmpiricalAnalysisAdapter requires root and row');
  const resolvedRoot = path.resolve(root);
  const resolvedRuntimeRoot = runtimeRoot
    ? path.resolve(runtimeRoot)
    : path.join(resolvedRoot, 'hepta-paper-workspace', 'runtime');
  const runDir = path.join(resolvedRuntimeRoot, 'empirical-analysis', row.task.paperId);
  if (!pathWithin(resolvedRuntimeRoot, runDir)) {
    throw new Error(`Empirical run dir escapes runtime root: ${runDir}`);
  }
  const sourceText = await readSourceText(resolvedRoot, row);
  const createdAt = nowIso();
  const empiricalBenchmarkRegistry = buildEmpiricalBenchmarkRegistry({ createdAt });
  const benchmarkSuiteSelectionPolicy = selectBenchmarkSuite({
    paperTask: row.task,
    targetProfile,
    sourceText,
    benchmarkRegistry: empiricalBenchmarkRegistry,
    createdAt,
  });
  const plan = buildEmpiricalAnalysisPlan({
    paperTask: row.task,
    targetProfile,
    targetSelectionPolicy,
    benchmarkRegistry: empiricalBenchmarkRegistry,
    suiteSelectionPolicy: benchmarkSuiteSelectionPolicy,
    sourceText,
    createdAt,
  });
  const localBenchmarkRegistry = await buildLocalBenchmarkRegistry({
    root: resolvedRoot,
    runtimeRoot: resolvedRuntimeRoot,
    datasetRoot,
    benchmarkId,
    paperTask: row.task,
    createdAt,
  });
  const datasetContract = buildDatasetAccessContract({
    root: resolvedRoot,
    paperTask: row.task,
    plan,
    runDir,
    localBenchmarkRegistry,
    createdAt,
  });
  const datasetLicenseProvenanceGate = buildDatasetLicenseProvenanceGate({
    paperTask: row.task,
    suiteSelectionPolicy: benchmarkSuiteSelectionPolicy,
    localBenchmarkRegistry,
    datasetContract,
    createdAt,
  });
  const tableFigureSpec = buildTableFigureSpec({
    paperTask: row.task,
    plan,
    suiteSelectionPolicy: benchmarkSuiteSelectionPolicy,
    datasetContract,
    createdAt,
  });
  const config = experimentConfig({
    paperTask: row.task,
    plan,
    datasetContract,
    suiteSelectionPolicy: benchmarkSuiteSelectionPolicy,
    tableFigureSpec,
  });
  const codeText = makeExperimentCode(config);
  const codePath = path.join(runDir, 'experiments', 'run_empirical_analysis.mjs');
  let codeRecord = null;
  let result = null;
  let stdoutRecord = null;
  let stderrRecord = null;
  let startedAt = null;
  let completedAt = null;
  if (execute && !plan.blockers.length && !datasetContract.blockers.length) {
    await ensureDir(path.dirname(codePath));
    await writeTextFile(codePath, codeText);
    codeRecord = await fileRecord(resolvedRoot, codePath, 'experiment_code');
  }
  const codeBundle = buildExperimentCodePatchBundle({
    paperTask: row.task,
    plan,
    datasetContract,
    tableFigureSpec,
    codeText,
    codeRecord,
    execute,
    createdAt,
  });
  const command = [
    process.execPath,
    relativePath(resolvedRoot, codePath),
  ];
  const sandboxPlan = buildSandboxExecutionPlan({
    paperTask: row.task,
    plan,
    datasetContract,
    codeBundle,
    command,
    cwd: relativePath(resolvedRoot, runDir),
    execute,
    createdAt,
  });
  if (sandboxPlan.status === 'sandbox_execution_plan_ready') {
    await ensureDir(path.join(runDir, 'logs'));
    startedAt = nowIso();
    result = spawnSync(process.execPath, [codePath], {
      cwd: runDir,
      encoding: 'utf8',
      timeout: sandboxPlan.timeoutMs,
      env: {
        ...process.env,
        HEPTA_EMPIRICAL_SANDBOX: '1',
        NO_NETWORK: '1',
      },
    });
    completedAt = nowIso();
    const stdoutPath = path.join(runDir, 'logs', 'stdout.txt');
    const stderrPath = path.join(runDir, 'logs', 'stderr.txt');
    await writeTextFile(stdoutPath, result.stdout || '');
    await writeTextFile(stderrPath, result.stderr || '');
    stdoutRecord = await fileRecord(resolvedRoot, stdoutPath, 'experiment_stdout');
    stderrRecord = await fileRecord(resolvedRoot, stderrPath, 'experiment_stderr');
  }
  const runReceipt = buildExperimentRunReceipt({
    paperTask: row.task,
    sandboxPlan,
    result,
    stdoutRecord,
    stderrRecord,
    startedAt,
    completedAt,
  });
  const artifacts = await recordArtifacts(resolvedRoot, [
    [path.join(runDir, 'data', 'generated_dataset_manifest.json'), 'generated_dataset_manifest'],
    [path.join(runDir, 'data', 'authorized_dataset_manifest.json'), 'authorized_dataset_manifest'],
    [path.join(runDir, 'experiments', 'run_empirical_analysis.mjs'), 'experiment_code'],
    [path.join(runDir, 'results', 'empirical_results.csv'), 'empirical_results_csv'],
    [path.join(runDir, 'results', 'empirical_summary.json'), 'empirical_summary_json'],
    [path.join(runDir, 'results', 'EMPIRICAL_EVIDENCE_MANIFEST.json'), 'empirical_evidence_manifest'],
    [path.join(runDir, 'results', 'REPRODUCIBILITY_STATUS.md'), 'empirical_reproducibility_status'],
    [path.join(runDir, 'tables', 'table_empirical_summary.tex'), 'empirical_table_tex'],
    [path.join(runDir, 'figures', 'figure_spec.json'), 'empirical_figure_spec_json'],
    [path.join(runDir, 'logs', 'stdout.txt'), 'experiment_stdout'],
    [path.join(runDir, 'logs', 'stderr.txt'), 'experiment_stderr'],
  ]);
  const resultPackage = buildResultArtifactPackage({
    paperTask: row.task,
    plan,
    datasetContract,
    datasetLicenseProvenanceGate,
    tableFigureSpec,
    codeBundle,
    runReceipt,
    artifacts,
    createdAt: nowIso(),
  });
  const empiricalEvidenceGate = buildEmpiricalEvidenceGate({
    paperTask: row.task,
    plan,
    datasetContract,
    datasetLicenseProvenanceGate,
    tableFigureSpec,
    runReceipt,
    resultPackage,
    createdAt: nowIso(),
  });
  let patchRecord = null;
  if (execute && empiricalEvidenceGate.status === 'empirical_evidence_gate_ready') {
    const patchPath = path.join(runDir, 'MANUSCRIPT_EMPIRICAL_PATCH.md');
    await writeTextFile(patchPath, manuscriptPatchText({
      paperTask: row.task,
      plan,
      resultPackage,
    }));
    patchRecord = await fileRecord(resolvedRoot, patchPath, 'manuscript_empirical_patch_draft');
  }
  const manuscriptEmpiricalPatch = buildManuscriptEmpiricalPatch({
    paperTask: row.task,
    plan,
    evidenceGate: empiricalEvidenceGate,
    resultPackage,
    patchRecord,
    createdAt: nowIso(),
  });
  const manuscriptEmpiricalApplyApprovalPacket = buildManuscriptEmpiricalApplyApprovalPacket({
    paperTask: row.task,
    manuscriptEmpiricalPatch,
    applyManuscript: Boolean(applyManuscript),
    createdAt: nowIso(),
  });
  const manuscriptEmpiricalApplyPlan = await buildManuscriptEmpiricalApplyPlan({
    root: resolvedRoot,
    row,
    approvalPacket: manuscriptEmpiricalApplyApprovalPacket,
    manuscriptEmpiricalPatch,
    resultPackage,
    createdAt: nowIso(),
  });
  const manuscriptEmpiricalApplyReceipt = await applyManuscriptEmpiricalPatch({
    root: resolvedRoot,
    row,
    plan: manuscriptEmpiricalApplyPlan,
    datasetContract,
    datasetLicenseProvenanceGate,
    tableFigureSpec,
    resultPackage,
    empiricalAnalysisPlan: plan,
  });
  const report = {
    version: 1,
    kind: 'EmpiricalAnalysisAdapterReport',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: empiricalEvidenceGate.smokeValidationStatus === 'empirical_smoke_validation_ready'
      ? 'empirical_analysis_smoke_ready'
      : 'empirical_analysis_blocked',
    execute: Boolean(execute),
    runtimeDir: relativePath(resolvedRoot, runDir),
    empiricalBenchmarkRegistry,
    benchmarkSuiteSelectionPolicy,
    empiricalAnalysisPlan: plan,
    localBenchmarkRegistry,
    datasetAccessContract: datasetContract,
    datasetLicenseProvenanceGate,
    tableFigureSpec,
    experimentCodePatchBundle: codeBundle,
    sandboxExecutionPlan: sandboxPlan,
    experimentRunReceipt: runReceipt,
    resultArtifactPackage: resultPackage,
    empiricalEvidenceGate,
    manuscriptEmpiricalPatch,
    manuscriptEmpiricalApplyApprovalPacket,
    manuscriptEmpiricalApplyPlan,
    manuscriptEmpiricalApplyReceipt,
    resultArtifactCount: resultPackage.artifactCount,
    blockers: uniqueStrings([
      ...(plan.blockers || []),
      ...(empiricalBenchmarkRegistry.blockers || []),
      ...(benchmarkSuiteSelectionPolicy.blockers || []),
      ...(localBenchmarkRegistry.blockers || []),
      ...(datasetContract.blockers || []),
      ...(datasetLicenseProvenanceGate.blockers || []),
      ...(tableFigureSpec.blockers || []),
      ...(codeBundle.blockers || []),
      ...(sandboxPlan.blockers || []),
      ...(runReceipt.blockers || []),
      ...(resultPackage.blockers || []),
      ...(empiricalEvidenceGate.blockers || []),
      ...(manuscriptEmpiricalPatch.blockers || []),
      ...(applyManuscript ? manuscriptEmpiricalApplyApprovalPacket.blockers || [] : []),
      ...(applyManuscript ? manuscriptEmpiricalApplyPlan.blockers || [] : []),
      ...(applyManuscript ? manuscriptEmpiricalApplyReceipt.blockers || [] : []),
    ], 64),
    safety: {
      localOnly: true,
      writesRuntimeOnly: Boolean(execute),
      writesSource: manuscriptEmpiricalApplyReceipt.status === 'manuscript_empirical_apply_applied',
      sourceMutation: manuscriptEmpiricalApplyReceipt.status === 'manuscript_empirical_apply_applied',
      externalDataAccess: false,
      networkAccess: false,
      modelCallPerformed: false,
      externalActionPerformed: false,
      importsOldControlPlane: false,
    },
    createdAt,
    completedAt: nowIso(),
  };
  const reportWithHash = {
    ...report,
    empiricalAnalysisAdapterReportHash: hashPaperRecord('EmpiricalAnalysisAdapterReport', report),
  };
  if (execute) {
    await writeJsonFile(path.join(runDir, 'EMPIRICAL_BENCHMARK_REGISTRY.json'), empiricalBenchmarkRegistry);
    await writeJsonFile(path.join(runDir, 'BENCHMARK_SUITE_SELECTION_POLICY.json'), benchmarkSuiteSelectionPolicy);
    await writeJsonFile(path.join(runDir, 'EMPIRICAL_ANALYSIS_PLAN.json'), plan);
    await writeJsonFile(path.join(runDir, 'LOCAL_BENCHMARK_REGISTRY.json'), localBenchmarkRegistry);
    await writeJsonFile(path.join(runDir, 'DATASET_ACCESS_CONTRACT.json'), datasetContract);
    await writeJsonFile(path.join(runDir, 'DATASET_LICENSE_PROVENANCE_GATE.json'), datasetLicenseProvenanceGate);
    await writeJsonFile(path.join(runDir, 'TABLE_FIGURE_SPEC.json'), tableFigureSpec);
    await writeJsonFile(path.join(runDir, 'EXPERIMENT_CODE_PATCH_BUNDLE.json'), codeBundle);
    await writeJsonFile(path.join(runDir, 'SANDBOX_EXECUTION_PLAN.json'), sandboxPlan);
    await writeJsonFile(path.join(runDir, 'EXPERIMENT_RUN_RECEIPT.json'), runReceipt);
    await writeJsonFile(path.join(runDir, 'RESULT_ARTIFACT_PACKAGE.json'), resultPackage);
    await writeJsonFile(path.join(runDir, 'EMPIRICAL_EVIDENCE_GATE.json'), empiricalEvidenceGate);
    await writeJsonFile(path.join(runDir, 'MANUSCRIPT_EMPIRICAL_PATCH.json'), manuscriptEmpiricalPatch);
    await writeJsonFile(path.join(runDir, 'MANUSCRIPT_EMPIRICAL_APPLY_APPROVAL_PACKET.json'), manuscriptEmpiricalApplyApprovalPacket);
    await writeJsonFile(path.join(runDir, 'MANUSCRIPT_EMPIRICAL_APPLY_PLAN.json'), manuscriptEmpiricalApplyPlan);
    await writeJsonFile(path.join(runDir, 'MANUSCRIPT_EMPIRICAL_APPLY_RECEIPT.json'), manuscriptEmpiricalApplyReceipt);
    await writeJsonFile(path.join(runDir, 'EMPIRICAL_ANALYSIS_REPORT.json'), reportWithHash);
  }
  return reportWithHash;
}
