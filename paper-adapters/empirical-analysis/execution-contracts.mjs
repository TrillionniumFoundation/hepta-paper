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
import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import { writeJsonFile, writeTextFile } from '../artifacts/write-artifact.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';
import { buildEmpiricalEvidenceGate } from './evidence-policy.mjs';
import { defaultPaperRuntimeRoot } from '../../paper-core/src/workspace-layout.mjs';

import { experimentConfig, makeExperimentCode } from './experiment-runner.mjs';
import { repoPath, escapeTexText } from './benchmark-contracts.mjs';


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

async function recordArtifacts(scopeRoot, files, { logicalRoot = scopeRoot } = {}) {
  const records = [];
  for (const [file, role] of files) {
    const record = await fileRecord(scopeRoot, file, role);
    if (record) records.push({ ...record, path: relativePath(logicalRoot, file) });
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


export { buildExperimentCodePatchBundle, buildSandboxExecutionPlan, buildExperimentRunReceipt, recordArtifacts, buildResultArtifactPackage, manuscriptPatchText, empiricalLatexBlock, replaceEmpiricalBlock, buildManuscriptEmpiricalApplyApprovalPacket, buildManuscriptEmpiricalApplyPlan, applyManuscriptEmpiricalPatch, buildManuscriptEmpiricalPatch };
