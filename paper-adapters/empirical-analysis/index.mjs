import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir, fileRecord, pathWithin, relativePath } from '../../workflow-kernel/runtime/file-utils.mjs';
import { uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import { writeJsonFile, writeTextFile } from '../artifacts/write-artifact.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { buildEmpiricalEvidenceGate } from './evidence-policy.mjs';
import { defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { experimentConfig, makeExperimentCode } from './experiment-runner.mjs';
import { repoPath, escapeTexText, readSourceText, countSignals, buildEmpiricalBenchmarkRegistry, selectBenchmarkSuite, judgeEmpiricalDesign, buildEmpiricalAnalysisPlan, unsafeDatasetPath, buildLocalBenchmarkRegistry, buildDatasetAccessContract, buildDatasetLicenseProvenanceGate, buildTableFigureSpec } from './benchmark-contracts.mjs';
import { buildExperimentCodePatchBundle, buildSandboxExecutionPlan, buildExperimentRunReceipt, recordArtifacts, buildResultArtifactPackage, manuscriptPatchText, empiricalLatexBlock, replaceEmpiricalBlock, buildManuscriptEmpiricalApplyApprovalPacket, buildManuscriptEmpiricalApplyPlan, applyManuscriptEmpiricalPatch, buildManuscriptEmpiricalPatch } from './execution-contracts.mjs';

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
    : defaultPaperRuntimeRoot();
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
  const runtimeFileRecord = async (candidate, role) => {
    const record = await fileRecord(resolvedRuntimeRoot, candidate, role);
    return record ? { ...record, path: relativePath(resolvedRoot, candidate) } : null;
  };
  if (execute && !plan.blockers.length && !datasetContract.blockers.length) {
    await ensureDir(path.dirname(codePath));
    await writeTextFile(codePath, codeText);
    codeRecord = await runtimeFileRecord(codePath, 'experiment_code');
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
    stdoutRecord = await runtimeFileRecord(stdoutPath, 'experiment_stdout');
    stderrRecord = await runtimeFileRecord(stderrPath, 'experiment_stderr');
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
  const artifacts = await recordArtifacts(resolvedRuntimeRoot, [
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
  ], { logicalRoot: resolvedRoot });
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
    patchRecord = await runtimeFileRecord(patchPath, 'manuscript_empirical_patch_draft');
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
    await ensureDir(runDir);
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
