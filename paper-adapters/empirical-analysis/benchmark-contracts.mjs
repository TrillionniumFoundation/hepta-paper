import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDir,
  dirExists,
  fileRecord,
  pathWithin,
  readJsonIfExists,
  readTextIfExists,
  relativePath,
  sha256Text,
  walkFiles,
} from '../../workflow-kernel/runtime/file-utils.mjs';
import { inspectScopedPathSync, readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import { writeJsonFile, writeTextFile } from '../artifacts/write-artifact.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { buildEmpiricalEvidenceGate } from './evidence-policy.mjs';
import { defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';

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
      const allowedDatasetScope = pathWithin(root, resolvedDatasetRoot) ? root : runtimeRoot;
      const datasetIdentity = inspectScopedPathSync({ scopeRoot: allowedDatasetScope, candidate: resolvedDatasetRoot, expect: 'directory', forbidHardlinks: false });
      if (datasetIdentity.status !== 'scoped_file_identity_verified') blockers.push('dataset_root_identity_not_verified', ...datasetIdentity.blockers);
      const manifestRead = readScopedFileSync({ scopeRoot: resolvedDatasetRoot, candidate: path.join(resolvedDatasetRoot, 'BENCHMARK_REGISTRY.json'), maximumBytes: 1024 * 1024 });
      if (manifestRead.status === 'scoped_file_read_verified') {
        try { registryManifest = JSON.parse(manifestRead.content.toString('utf8')); }
        catch { blockers.push('benchmark_registry_manifest_invalid'); }
      }
      const files = await walkFiles(resolvedDatasetRoot, {
        maxDepth: 4,
        maxFiles: 256,
        includeHidden: false,
        match: (_full, name) => name !== 'BENCHMARK_REGISTRY.json'
          && /\.(csv|json|jsonl|txt|md)$/i.test(name)
          && !/credential|secret|token|cookie/i.test(name),
      });
      for (const file of files.slice(0, 128)) {
        const record = await fileRecord(resolvedDatasetRoot, file, 'authorized_local_dataset');
        if (record) records.push({ ...record, path: relativePath(root, file) });
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


export { repoPath, escapeTexText, readSourceText, countSignals, buildEmpiricalBenchmarkRegistry, selectBenchmarkSuite, judgeEmpiricalDesign, buildEmpiricalAnalysisPlan, unsafeDatasetPath, buildLocalBenchmarkRegistry, buildDatasetAccessContract, buildDatasetLicenseProvenanceGate, buildTableFigureSpec };
