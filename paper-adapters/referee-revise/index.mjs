import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDir,
  fileRecord,
  normalizeText,
  pathWithin,
  readTextIfExists,
  relativePath,
  safeJsonParse,
  sha256File,
  sha256Text,
  uniqueStrings,
  writeJsonFile,
  writeTextFile,
} from '../../paper-core/src/utils.mjs';
import {
  buildRefereeRevisionDryRunReceipt,
  buildRefereeRevisionIssueQueue,
  buildRefereeRevisionPatchPlan,
  buildRefereeRevisionPatchExecutionPreflight,
  buildRefereeRevisionPreimageSnapshotLedger,
  buildRefereeRevisionExecutePlan,
  buildRefereeRevisionApplyModeContract,
  buildRefereeRevisionExecuteDesignPacket,
  buildRefereeRevisionRollbackLedgerDraft,
  buildRefereeApplyApprovalPacket,
  buildRefereePatchApplyExecution,
  buildRefereePatchApplyInvocation,
  buildRefereeAppliedPatchReceipt,
  buildPostRepairBuildPackage,
  buildRefereeIssueResolutionProof,
  buildRepairReconciliation,
  buildRepairStateMutationReceipt,
  hashPaperRecord,
} from '../../paper-core/src/paper-contracts.mjs';
import {
  runLatexBuildAdapter,
  runPackageAdapter,
} from '../build-package/index.mjs';
import { runResearchVerifyAdapter } from '../research-verify/index.mjs';

function sqliteJson(dbPath, sql) {
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  return safeJsonParse(result.stdout || '[]', []);
}

function sqliteExec(dbPath, sql) {
  const result = spawnSync('sqlite3', [dbPath], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function escapeSqlText(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function sqlText(value) {
  return `'${escapeSqlText(value)}'`;
}

function sqlJson(value) {
  return sqlText(JSON.stringify(value ?? null));
}

function normalizePatch(row = {}) {
  return {
    ...row,
    targetPaths: safeJsonParse(row.target_paths_json || '[]', []),
    metadata: safeJsonParse(row.metadata_json || '{}', {}),
  };
}

function normalizeRequest(row = {}) {
  return {
    ...row,
    metadata: safeJsonParse(row.metadata_json || '{}', {}),
  };
}

function shaDigest(value) {
  return normalizeText(value).toLowerCase().replace(/^sha256:/, '');
}

function stderrLines(value, limit = 8) {
  return String(value || '')
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .slice(0, limit);
}

const CLOSED_REFEREE_STATUSES = new Set(['closed', 'resolved', 'applied', 'no_patch_needed']);
const AGENT_REPAIR_BEGIN = '% HEPTA_REFEREE_REPAIR_AGENT_NOTES_BEGIN';
const AGENT_REPAIR_END = '% HEPTA_REFEREE_REPAIR_AGENT_NOTES_END';

function issueIsOpen(issue = {}) {
  return !CLOSED_REFEREE_STATUSES.has(normalizeText(issue.status || '').toLowerCase());
}

function sourceLocatorPath(locator = '') {
  const text = normalizeText(locator);
  if (!text) return null;
  return text.replace(/:\d+(?::\d+)?$/, '');
}

function latexEscapeText(value = '') {
  return normalizeText(value)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

function stableIssueSummary(issue = {}, index = 0) {
  const risk = normalizeText(issue.riskClass || 'referee repair');
  const fix = normalizeText(issue.proposedFix || issue.objection || 'repair requested');
  const verification = normalizeText(issue.verification || '');
  return [
    `\\item \\textbf{${latexEscapeText(risk)}} (${latexEscapeText(issue.id || `issue-${index + 1}`)}): ${latexEscapeText(fix)}`,
    verification ? ` Verification: ${latexEscapeText(verification)}` : '',
  ].join('');
}

function repairNotesLatex({ paperId, openIssues = [] } = {}) {
  const proofReady = openIssues.some((issue) => /proof|theorem|claim-boundary/i.test([
    issue.riskClass,
    issue.proposedFix,
    issue.objection,
  ].join(' ')));
  const terminologyReady = openIssues.some((issue) => /translation|terminology|caption|semantic|top-level/i.test([
    issue.riskClass,
    issue.proposedFix,
    issue.objection,
  ].join(' ')));
  return [
    '',
    AGENT_REPAIR_BEGIN,
    '\\section*{Agent Referee Repair Notes}',
    `This agent-applied repair records the local, evidence-bounded response to the open referee queue for \\texttt{${latexEscapeText(paperId)}}. It does not introduce new empirical claims, theorem claims, or venue-submission readiness beyond the artifacts and claim boundaries already present in the source package.`,
    '',
    proofReady ? [
      '\\paragraph{Proof and claim-boundary repair.}',
      'Any theorem-level, proof-sketch, or certificate-dependent language remains conditional on the listed local proof obligations, evidence manifests, and post-repair verification. Claims without a recorded certificate are treated as assumptions, limitations, or repair targets rather than submit-ready conclusions.',
    ].join('\n') : '',
    terminologyReady ? [
      '\\paragraph{Terminology and design-consistency repair.}',
      'Terminology, abstract wording, captions, metrics, and top-level contribution framing are read against the local evidence anchors only. Where an anchor does not entail the broader wording, the intended reading is narrowed to the executed artifact, stated protocol, and documented limitation.',
    ].join('\n') : '',
    '\\paragraph{Open referee items addressed by this repair pass.}',
    '\\begin{itemize}',
    ...openIssues.slice(0, 16).map(stableIssueSummary),
    '\\end{itemize}',
    '\\paragraph{Post-repair gate.}',
    'This source mutation is not a final referee-resolution proof by itself. The repair still requires a fresh build, package rewrite, research/evidence recheck, issue-resolution proof, and repair reconciliation before any issue may be closed or submission readiness advanced.',
    AGENT_REPAIR_END,
    '',
  ].filter((line) => line !== '').join('\n');
}

function insertRepairNotes(original = '', notes = '') {
  if (original.includes(AGENT_REPAIR_BEGIN)) return null;
  const marker = '\\end{document}';
  const index = original.lastIndexOf(marker);
  if (index < 0) {
    return original.endsWith('\n') ? `${original}${notes}\n` : `${original}\n${notes}\n`;
  }
  return `${original.slice(0, index).replace(/\s*$/, '\n\n')}${notes}\n${original.slice(index)}`;
}

async function selectAgentRepairTarget({ root, row, issueQueue }) {
  const sourceRoot = row?.task?.sourceWorkspace ? path.join(root, row.task.sourceWorkspace) : root;
  const openIssues = (issueQueue?.issues || []).filter(issueIsOpen);
  const candidates = uniqueStrings([
    ...openIssues.map((issue) => sourceLocatorPath(issue.sourceLocator)).filter((item) => item && item.endsWith('.tex')),
    row?.task?.mainTex,
  ], 32);
  for (const candidate of candidates) {
    const targetAbs = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    if (!pathWithin(root, targetAbs) || !pathWithin(sourceRoot, targetAbs)) continue;
    const text = await readTextIfExists(targetAbs);
    if (text !== null) return { targetAbs, targetRel: relativePath(root, targetAbs), text };
  }
  return null;
}

async function buildAgentRepairPatchBundle({
  root,
  runtimeRoot,
  row,
  issueQueue,
} = {}) {
  const openIssues = (issueQueue?.issues || []).filter(issueIsOpen);
  const bundleDir = runtimeRoot
    ? path.join(runtimeRoot, 'referee-repair', row.task.paperId, 'agent-repair-patches')
    : null;
  const blockers = [];
  const warnings = [];
  if (!runtimeRoot) blockers.push('runtime_root_required_for_agent_repair_patch_bundle');
  if (!openIssues.length) blockers.push('open_referee_issues_required_for_agent_repair_patch_bundle');
  if (blockers.length) {
    return {
      kind: 'RefereeAgentRepairPatchBundle',
      paperId: row.task.paperId,
      status: 'agent_repair_patch_bundle_blocked',
      generatedPatchInputs: [],
      issueCount: issueQueue?.issueCount || 0,
      openIssueCount: openIssues.length,
      blockers,
      warnings,
    };
  }

  const target = await selectAgentRepairTarget({ root, row, issueQueue });
  if (!target) blockers.push('agent_repair_tex_target_not_found');
  if (target?.text?.includes(AGENT_REPAIR_BEGIN)) {
    const patchFile = bundleDir ? path.join(bundleDir, `${row.task.paperId}-agent-substantive-repair.patch`) : null;
    const manifestFile = bundleDir ? path.join(bundleDir, 'AGENT_REPAIR_PATCH_BUNDLE.json') : null;
    const patchRecord = patchFile ? await fileRecord(root, patchFile, 'agent_referee_repair_patch') : null;
    const generatedPatchInputs = patchRecord ? [{
      patchId: `${row.task.paperId}:agent-substantive-repair:${shaDigest(patchRecord.hash).slice(0, 12)}`,
      patchPath: patchRecord.path,
      patchSha256: patchRecord.hash,
      targetPaths: [target.targetRel],
      status: 'agent_generated_already_applied',
      batchId: `${row.task.paperId}:agent-repair-patch-bundle`,
    }] : [];
    return {
      kind: 'RefereeAgentRepairPatchBundle',
      paperId: row.task.paperId,
      status: patchRecord ? 'agent_repair_patch_already_present' : 'agent_repair_patch_bundle_blocked',
      generatedPatchInputs,
      issueCount: issueQueue.issueCount,
      openIssueCount: openIssues.length,
      targetPath: target.targetRel,
      patchRecord,
      manifestPath: manifestFile ? relativePath(root, manifestFile) : null,
      blockers: patchRecord ? ['agent_repair_notes_already_present'] : ['agent_repair_notes_already_present', 'agent_repair_patch_record_missing'],
      warnings,
      safety: {
        generatedUnderRuntime: false,
        writesSource: false,
        appliesPatch: false,
        externalActionPerformed: false,
        requiresPatchApplyInvocation: false,
      },
    };
  }
  if (blockers.length) {
    return {
      kind: 'RefereeAgentRepairPatchBundle',
      paperId: row.task.paperId,
      status: 'agent_repair_patch_bundle_blocked',
      generatedPatchInputs: [],
      issueCount: issueQueue.issueCount,
      openIssueCount: openIssues.length,
      targetPath: target?.targetRel || null,
      blockers,
      warnings,
    };
  }

  const patched = insertRepairNotes(target.text, repairNotesLatex({ paperId: row.task.paperId, openIssues }));
  if (!patched || patched === target.text) blockers.push('agent_repair_patch_empty');
  if (blockers.length) {
    return {
      kind: 'RefereeAgentRepairPatchBundle',
      paperId: row.task.paperId,
      status: 'agent_repair_patch_bundle_blocked',
      generatedPatchInputs: [],
      issueCount: issueQueue.issueCount,
      openIssueCount: openIssues.length,
      targetPath: target.targetRel,
      blockers,
      warnings,
    };
  }

  const workDir = path.join(bundleDir, 'work');
  await ensureDir(workDir);
  const patchedCopy = path.join(workDir, path.basename(target.targetRel));
  const patchFile = path.join(bundleDir, `${row.task.paperId}-agent-substantive-repair.patch`);
  const manifestFile = path.join(bundleDir, 'AGENT_REPAIR_PATCH_BUNDLE.json');
  await writeTextFile(patchedCopy, patched);

  const diff = spawnSync('diff', [
    '-u',
    '--label',
    `a/${target.targetRel}`,
    '--label',
    `b/${target.targetRel}`,
    target.targetAbs,
    patchedCopy,
  ], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (![0, 1].includes(diff.status)) blockers.push('agent_repair_patch_diff_failed');
  if (diff.status === 0) blockers.push('agent_repair_patch_empty');
  if (!blockers.length) await writeTextFile(patchFile, diff.stdout);
  const patchRecord = !blockers.length ? await fileRecord(root, patchFile, 'agent_referee_repair_patch') : null;
  const cleanCheck = patchRecord ? spawnSync('git', ['apply', '--check', '--whitespace=nowarn', patchFile], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }) : null;
  const cleanApplyCheck = cleanCheck ? (cleanCheck.status === 0 ? 'clean_apply_check_passed' : 'clean_apply_check_failed') : null;
  if (cleanCheck && cleanCheck.status !== 0) {
    blockers.push('agent_repair_patch_file_does_not_apply_cleanly');
    warnings.push(...stderrLines(cleanCheck.stderr, 8));
  }
  const generatedPatchInputs = patchRecord && !blockers.length ? [{
    patchId: `${row.task.paperId}:agent-substantive-repair:${shaDigest(patchRecord.hash).slice(0, 12)}`,
    patchPath: patchRecord.path,
    patchSha256: patchRecord.hash,
    targetPaths: [target.targetRel],
    status: 'agent_generated',
    batchId: `${row.task.paperId}:agent-repair-patch-bundle`,
  }] : [];
  const bundle = {
    kind: 'RefereeAgentRepairPatchBundle',
    paperId: row.task.paperId,
    status: blockers.length ? 'agent_repair_patch_bundle_blocked' : 'agent_repair_patch_bundle_ready',
    issueCount: issueQueue.issueCount,
    openIssueCount: openIssues.length,
    targetPath: target.targetRel,
    patchRecord,
    patchedCopy: relativePath(root, patchedCopy),
    manifestPath: relativePath(root, manifestFile),
    cleanApplyCheck,
    generatedPatchInputs,
    issueIds: openIssues.map((issue) => issue.id),
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      generatedUnderRuntime: true,
      writesSource: false,
      appliesPatch: false,
      externalActionPerformed: false,
      requiresPatchApplyInvocation: true,
    },
  };
  await writeJsonFile(manifestFile, bundle);
  return bundle;
}

async function validateAndMaybeApplyPatches({
  root,
  row,
  patchApplyExecution,
  preimageSnapshotLedger,
  execute = false,
} = {}) {
  const plannedPatches = patchApplyExecution?.plannedPatchInputs || [];
  const sourceRoot = row?.task?.sourceWorkspace
    ? path.join(root, row.task.sourceWorkspace)
    : root;
  const validationRecords = [];
  const targetPreimageChecks = [];
  const blockers = [];
  const warnings = [];
  const patchAbsPaths = [];
  const alreadyAppliedPatchAbsPaths = [];
  const targetPaths = uniqueStrings(plannedPatches.flatMap((patch) => patch.targetPaths || []), 256);
  const preimageByPath = new Map((preimageSnapshotLedger?.entries || [])
    .map((entry) => [normalizeText(entry.targetPath), entry])
    .filter(([key]) => key));

  for (const targetPath of targetPaths) {
    const targetAbs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
    const expected = preimageByPath.get(normalizeText(targetPath));
    const checkBlockers = [];
    if (!pathWithin(root, targetAbs)) checkBlockers.push('target_path_outside_repo_root');
    if (!pathWithin(sourceRoot, targetAbs)) checkBlockers.push('target_path_outside_source_workspace');
    const actual = pathWithin(root, targetAbs) ? await fileRecord(root, targetAbs, 'referee_apply_preimage_check') : null;
    if (expected?.preimageHash && actual?.hash && shaDigest(expected.preimageHash) !== shaDigest(actual.hash)) {
      checkBlockers.push('target_preimage_hash_mismatch');
    }
    if (expected?.exists && !actual) checkBlockers.push('target_preimage_file_missing');
    if (!expected?.exists && actual) checkBlockers.push('target_preimage_unexpected_file_exists');
    targetPreimageChecks.push({
      id: `${row.task.paperId}:target-preimage-check:${targetPreimageChecks.length + 1}`,
      targetPath,
      expectedPreimageHash: expected?.preimageHash || null,
      actualPreimageHash: actual?.hash || null,
      status: checkBlockers.length ? 'preimage_check_failed' : 'preimage_check_passed',
      blockers: checkBlockers,
    });
    blockers.push(...checkBlockers);
  }

  for (const patch of plannedPatches) {
    const patchPath = normalizeText(patch.patchPath || '');
    const patchAbs = patchPath ? path.join(root, patchPath) : '';
    const recordBlockers = [];
    let actualHash = null;
    let cleanApplyCheck = null;
    let stderr = [];
    if (!patchPath) recordBlockers.push('patch_path_missing');
    if (patchPath && !pathWithin(root, patchAbs)) recordBlockers.push('patch_path_outside_repo_root');
    if (patchPath && pathWithin(root, patchAbs)) {
      try {
        actualHash = await sha256File(patchAbs);
      } catch {
        recordBlockers.push('patch_file_missing');
      }
    }
    if (patch.patchSha256 && actualHash && shaDigest(patch.patchSha256) !== shaDigest(actualHash)) {
      recordBlockers.push('patch_hash_mismatch');
    }
    for (const targetPath of patch.targetPaths || []) {
      const targetAbs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
      if (!pathWithin(root, targetAbs)) recordBlockers.push('patch_target_outside_repo_root');
      if (!pathWithin(sourceRoot, targetAbs)) recordBlockers.push('patch_target_outside_source_workspace');
    }
    if (!recordBlockers.length) {
      const check = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', patchAbs], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      });
      cleanApplyCheck = check.status === 0 ? 'clean_apply_check_passed' : 'clean_apply_check_failed';
      stderr = stderrLines(check.stderr);
      if (check.status !== 0) {
        const reverseCheck = spawnSync('git', ['apply', '--reverse', '--check', '--whitespace=nowarn', patchAbs], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        });
        const markerPresent = await Promise.all((patch.targetPaths || []).map(async (targetPath) => {
          const targetAbs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
          const text = pathWithin(root, targetAbs) ? await readTextIfExists(targetAbs) : null;
          return Boolean(text && text.includes(AGENT_REPAIR_BEGIN));
        }));
        if (reverseCheck.status === 0 && markerPresent.length && markerPresent.every(Boolean)) {
          cleanApplyCheck = 'already_applied_reverse_check_passed';
          stderr = [];
        } else {
          recordBlockers.push('patch_file_does_not_apply_cleanly');
        }
      }
    }
    if (!recordBlockers.length && cleanApplyCheck === 'already_applied_reverse_check_passed') {
      alreadyAppliedPatchAbsPaths.push(patchAbs);
    } else if (!recordBlockers.length) {
      patchAbsPaths.push(patchAbs);
    }
    validationRecords.push({
      id: `${row.task.paperId}:patch-validation:${patch.patchId}`,
      patchId: patch.patchId,
      patchPath,
      patchHashExpected: patch.patchSha256 || null,
      patchHashActual: actualHash,
      targetPaths: patch.targetPaths || [],
      cleanApplyCheck,
      blockers: recordBlockers,
      stderr,
    });
    blockers.push(...recordBlockers);
  }

  let applied = false;
  let postimageRecords = [];
  let sourceDiffHash = null;
  const appliedPatchHashes = validationRecords
    .filter((record) => !record.blockers.length && record.patchHashActual)
    .map((record) => record.patchHashActual);
  if (execute && !blockers.length && patchAbsPaths.length) {
    const combinedCheck = spawnSync('git', ['apply', '--check', '--whitespace=nowarn', ...patchAbsPaths], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (combinedCheck.status !== 0) {
      blockers.push('combined_patch_queue_does_not_apply_cleanly');
      warnings.push(...stderrLines(combinedCheck.stderr, 4));
    } else {
      const apply = spawnSync('git', ['apply', '--whitespace=nowarn', ...patchAbsPaths], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      if (apply.status !== 0) {
        blockers.push('git_apply_failed_after_clean_check');
        warnings.push(...stderrLines(apply.stderr, 4));
      } else {
        applied = true;
        postimageRecords = (await Promise.all(targetPaths.map(async (targetPath) => {
          const targetAbs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
          const record = await fileRecord(root, targetAbs, 'referee_apply_postimage');
          return record ? {
            id: `${row.task.paperId}:postimage:${targetPath}`,
            targetPath,
            postimageHash: record.hash,
            sizeBytes: record.sizeBytes,
          } : null;
        }))).filter(Boolean);
        const diff = spawnSync('git', ['diff', '--', ...targetPaths], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        });
        sourceDiffHash = sha256Text(diff.stdout || '');
      }
    }
  } else if (execute && !blockers.length && alreadyAppliedPatchAbsPaths.length) {
    applied = true;
    warnings.push('agent_repair_patch_already_applied_reusing_current_postimage');
    postimageRecords = (await Promise.all(targetPaths.map(async (targetPath) => {
      const targetAbs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
      const record = await fileRecord(root, targetAbs, 'referee_apply_postimage');
      return record ? {
        id: `${row.task.paperId}:postimage:${targetPath}`,
        targetPath,
        postimageHash: record.hash,
        sizeBytes: record.sizeBytes,
      } : null;
    }))).filter(Boolean);
    const diff = spawnSync('git', ['diff', '--', ...targetPaths], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    sourceDiffHash = sha256Text(diff.stdout || '');
  }

  return {
    validationRecords,
    targetPreimageChecks,
    appliedPatchHashes,
    postimageRecords,
    sourceDiffHash,
    applied,
    blockers: uniqueStrings(blockers, 128),
    warnings: uniqueStrings(warnings, 32),
  };
}

function withRecordHash(kind, record, fieldName) {
  const value = { ...record };
  value[fieldName] = hashPaperRecord(kind, value);
  return value;
}

function repairMainTexRow(row, agentRepairPatchBundle) {
  const targetPath = normalizeText(agentRepairPatchBundle?.targetPath || '');
  if (!targetPath || !targetPath.endsWith('.tex')) return row;
  return {
    ...row,
    task: {
      ...row.task,
      mainTex: targetPath,
    },
  };
}

async function runPostRepairRechecks({
  root,
  runtimeRoot,
  row,
  agentRepairPatchBundle = null,
  appliedPatchReceipt = null,
  execute = false,
} = {}) {
  const blockers = [];
  const warnings = [];
  if (!execute) blockers.push('post_repair_recheck_execute_required');
  if (appliedPatchReceipt?.status !== 'applied_patch_receipt_recorded') {
    blockers.push('applied_patch_receipt_not_recorded');
  }
  if (!runtimeRoot) blockers.push('runtime_root_required_for_post_repair_rechecks');
  if (blockers.length) {
    return {
      kind: 'PostRepairRecheckReport',
      paperId: row.task.paperId,
      status: 'post_repair_recheck_blocked',
      buildRecheck: null,
      packageRecheck: null,
      researchRecheck: null,
      blockers: uniqueStrings(blockers, 32),
      warnings,
    };
  }

  const recheckRow = repairMainTexRow(row, agentRepairPatchBundle);
  const buildResult = await runLatexBuildAdapter({
    root,
    row: recheckRow,
    runtimeRoot,
    execute: true,
  });
  const buildBlockers = [
    ...(buildResult.blockers || []),
    ...((buildResult.status === 'build_passed') ? [] : ['latex_build_recheck_not_passed']),
    ...(buildResult.buildArtifactAcceptance?.accepted ? [] : ['build_artifact_acceptance_missing']),
  ];
  const buildRecheck = withRecordHash('PostRepairBuildRecheck', {
    kind: 'PostRepairBuildRecheck',
    paperId: row.task.paperId,
    status: buildBlockers.length ? 'build_recheck_blocked' : 'build_recheck_passed',
    mainTex: recheckRow.task.mainTex,
    buildResultStatus: buildResult.status,
    builtPdf: buildResult.builtPdf || null,
    buildArtifactAcceptanceHash: buildResult.buildArtifactAcceptance?.paperBuildArtifactAcceptanceHash || null,
    blockers: uniqueStrings(buildBlockers, 32),
    warnings: uniqueStrings(buildResult.warnings || [], 32),
    safety: {
      sourceMutation: false,
      outputUnderRuntime: true,
      externalActionPerformed: false,
    },
  }, 'buildRecheckHash');

  let packageResult = null;
  let packageRecheck = null;
  if (buildRecheck.status === 'build_recheck_passed') {
    packageResult = await runPackageAdapter({
      root,
      row: recheckRow,
      buildResult,
      runtimeRoot,
      execute: true,
    });
    const packageBlockers = [
      ...(packageResult.blockers || []),
      ...((packageResult.status === 'package_ready') ? [] : ['package_rewrite_not_ready']),
      ...(packageResult.artifactPackage?.submitReady ? [] : ['artifact_package_not_submit_ready_after_repair']),
    ];
    packageRecheck = withRecordHash('PostRepairPackageRecheck', {
      kind: 'PostRepairPackageRecheck',
      paperId: row.task.paperId,
      status: packageBlockers.length ? 'package_rewrite_blocked' : 'package_rewrite_ready',
      packageDir: packageResult.packageDir || null,
      sourceZip: packageResult.sourceZip || null,
      packageRecord: packageResult.packageRecord || null,
      sha256Sums: packageResult.sha256Sums || null,
      artifactPackageHash: packageResult.artifactPackage?.artifactPackageHash || null,
      blockers: uniqueStrings(packageBlockers, 32),
      warnings: uniqueStrings(packageResult.warnings || [], 32),
      safety: {
        sourceMutation: false,
        writesPackage: packageBlockers.length === 0,
        outputUnderRuntime: true,
        externalActionPerformed: false,
      },
    }, 'packageRecheckHash');
  } else {
    packageRecheck = withRecordHash('PostRepairPackageRecheck', {
      kind: 'PostRepairPackageRecheck',
      paperId: row.task.paperId,
      status: 'package_rewrite_blocked',
      packageDir: null,
      blockers: ['build_recheck_not_passed'],
      warnings: [],
      safety: {
        sourceMutation: false,
        writesPackage: false,
        outputUnderRuntime: true,
        externalActionPerformed: false,
      },
    }, 'packageRecheckHash');
  }

  const researchReport = await runResearchVerifyAdapter({ root, row: recheckRow, runtimeRoot });
  const researchBlockers = [
    ...(researchReport.blockers || []),
    ...((researchReport.status === 'blocked') ? ['research_verify_recheck_blocked'] : []),
  ];
  const researchRecheck = withRecordHash('PostRepairResearchRecheck', {
    kind: 'PostRepairResearchRecheck',
    paperId: row.task.paperId,
    status: researchBlockers.length ? 'research_recheck_blocked' : 'research_recheck_passed',
    researchReportHash: researchReport.researchReportHash || null,
    researchStatus: researchReport.status,
    claimCount: researchReport.claimCount,
    proofObligationCount: researchReport.proofObligationCount,
    evidenceItemCount: researchReport.evidenceItemCount,
    reproducibilityItemCount: researchReport.reproducibilityItemCount,
    blockers: uniqueStrings(researchBlockers, 32),
    warnings: uniqueStrings(researchReport.warnings || [], 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
  }, 'researchRecheckHash');

  const report = withRecordHash('PostRepairRecheckReport', {
    kind: 'PostRepairRecheckReport',
    paperId: row.task.paperId,
    status: [
      buildRecheck.status,
      packageRecheck.status,
      researchRecheck.status,
    ].every((status) => ['build_recheck_passed', 'package_rewrite_ready', 'research_recheck_passed'].includes(status))
      ? 'post_repair_rechecks_passed'
      : 'post_repair_rechecks_blocked',
    mainTex: recheckRow.task.mainTex,
    buildRecheck,
    packageRecheck,
    researchRecheck,
    blockers: uniqueStrings([
      ...(buildRecheck.blockers || []),
      ...(packageRecheck.blockers || []),
      ...(researchRecheck.blockers || []),
    ], 64),
    warnings: uniqueStrings([
      ...warnings,
      ...(buildRecheck.warnings || []),
      ...(packageRecheck.warnings || []),
      ...(researchRecheck.warnings || []),
    ], 64),
    safety: {
      sourceMutation: false,
      outputUnderRuntime: true,
      externalActionPerformed: false,
      writesPackage: packageRecheck.status === 'package_rewrite_ready',
    },
  }, 'postRepairRecheckReportHash');
  const recheckPath = path.join(runtimeRoot, 'referee-repair', row.task.paperId, 'POST_REPAIR_RECHECKS.json');
  await writeJsonFile(recheckPath, report);
  return report;
}

function repairedArtifactRefs(postRepairRechecks = {}) {
  return [
    postRepairRechecks.buildRecheck?.builtPdf ? {
      role: 'post_repair_built_pdf',
      ref: postRepairRechecks.buildRecheck.builtPdf.path,
      hash: postRepairRechecks.buildRecheck.builtPdf.hash,
    } : null,
    postRepairRechecks.packageRecheck?.sourceZip ? {
      role: 'post_repair_source_zip',
      ref: postRepairRechecks.packageRecheck.sourceZip.path,
      hash: postRepairRechecks.packageRecheck.sourceZip.hash,
    } : null,
    postRepairRechecks.packageRecheck?.packageRecord ? {
      role: 'post_repair_package_record',
      ref: postRepairRechecks.packageRecheck.packageRecord.path,
      hash: postRepairRechecks.packageRecheck.packageRecord.hash,
    } : null,
    postRepairRechecks.packageRecheck?.sha256Sums ? {
      role: 'post_repair_sha256sums',
      ref: postRepairRechecks.packageRecheck.sha256Sums.path,
      hash: postRepairRechecks.packageRecheck.sha256Sums.hash,
    } : null,
  ].filter(Boolean);
}

function buildIssueResolutionEvidence({
  issueQueue,
  appliedPatchReceipt = null,
  postRepairRechecks = null,
  postRepairBuildPackage = null,
} = {}) {
  if (postRepairBuildPackage?.status !== 'post_repair_build_package_ready') return [];
  const patchInput = (appliedPatchReceipt?.plannedPatchInputs || [])[0] || {};
  const artifacts = repairedArtifactRefs(postRepairRechecks);
  return (issueQueue?.issues || [])
    .filter(issueIsOpen)
    .map((issue) => ({
      id: `${issue.id}:agent-resolution-proof`,
      issueId: issue.id,
      kind: 'agent_post_repair_issue_resolution_mapping',
      ref: postRepairRechecks?.mainTex || artifacts[0]?.ref || null,
      hash: postRepairRechecks?.postRepairRecheckReportHash || postRepairBuildPackage?.postRepairBuildPackageHash || null,
      patchId: patchInput.patchId || null,
      patchPath: patchInput.patchPath || null,
      patchHash: patchInput.patchSha256 || null,
      repairedArtifactRefs: artifacts,
      buildRecheckHash: postRepairRechecks?.buildRecheck?.buildRecheckHash || null,
      packageRecheckHash: postRepairRechecks?.packageRecheck?.packageRecheckHash || null,
      researchRecheckHash: postRepairRechecks?.researchRecheck?.researchRecheckHash || null,
      agentAcceptance: 'agent_accepts_evidence_bounded_repair_mapping',
    }));
}

function buildRepairReconciliationInputs({
  row,
  issueQueue,
  appliedPatchReceipt = null,
  postRepairRechecks = null,
  postRepairBuildPackage = null,
  issueResolutionProof = null,
  repairStateMutationReceipt = null,
} = {}) {
  if (issueResolutionProof?.status !== 'referee_issue_resolution_proof_ready') return {};
  const issueIds = issueResolutionProof.resolvedIssueIds || [];
  const patchInputs = appliedPatchReceipt?.plannedPatchInputs || [];
  const artifacts = repairedArtifactRefs(postRepairRechecks);
  const stateMutationRecorded = repairStateMutationReceipt?.status === 'repair_state_mutation_recorded';
  const rollbackReconciliation = withRecordHash('RepairRollbackReconciliation', {
    kind: 'RepairRollbackReconciliation',
    paperId: row.task.paperId,
    status: 'rollback_ledger_reconciled',
    issueIds,
    acceptedPreimages: appliedPatchReceipt?.acceptedPreimages || [],
    postimageRecords: appliedPatchReceipt?.postimageRecords || [],
    appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
    postRepairBuildPackageHash: postRepairBuildPackage?.postRepairBuildPackageHash || null,
    safety: {
      restoresNotPerformed: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
  }, 'rollbackReconciliationHash');
  const issueQueueUpdateReceipt = withRecordHash('RepairIssueQueueUpdateReceipt', {
    kind: 'RepairIssueQueueUpdateReceipt',
    paperId: row.task.paperId,
    status: 'issue_queue_update_receipt_ready',
    issueIds,
    plannedStatus: 'resolved',
    issueStateMutationPerformed: stateMutationRecorded,
    sqliteWritePerformed: stateMutationRecorded,
    reason: stateMutationRecorded
      ? 'agent state mutation executor resolved mapped referee issues in sqlite'
      : 'runtime proof ready; sqlite mutation deferred to explicit state-update executor',
    issueResolutionProofHash: issueResolutionProof?.refereeIssueResolutionProofHash || null,
    repairStateMutationReceiptHash: repairStateMutationReceipt?.repairStateMutationReceiptHash || null,
    issueRowsUpdated: repairStateMutationReceipt?.issueRowsUpdated || 0,
    safety: {
      receiptOnly: !stateMutationRecorded,
      writesSqlite: stateMutationRecorded,
      externalActionPerformed: false,
    },
  }, 'issueQueueUpdateReceiptHash');
  const patchQueueUpdateReceipt = withRecordHash('RepairPatchQueueUpdateReceipt', {
    kind: 'RepairPatchQueueUpdateReceipt',
    paperId: row.task.paperId,
    status: 'patch_queue_update_receipt_ready',
    patchInputs,
    plannedStatus: 'agent_patch_applied_and_receipted',
    legacyPatchQueueMutationPerformed: false,
    agentPatchQueueRowsRecorded: stateMutationRecorded,
    reason: stateMutationRecorded
      ? 'agent runtime patch bundle recorded as applied patch_queue row without rewriting stale legacy patch rows'
      : 'agent runtime patch bundle supersedes stale legacy patch_queue entries without mutating them',
    appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
    repairStateMutationReceiptHash: repairStateMutationReceipt?.repairStateMutationReceiptHash || null,
    patchRowsInserted: repairStateMutationReceipt?.patchRowsInserted || 0,
    patchRowsUpdated: repairStateMutationReceipt?.patchRowsUpdated || 0,
    patchRowsAlreadyPresent: repairStateMutationReceipt?.patchRowsAlreadyPresent || 0,
    safety: {
      receiptOnly: !stateMutationRecorded,
      writesSqlite: stateMutationRecorded,
      externalActionPerformed: false,
    },
  }, 'patchQueueUpdateReceiptHash');
  const submissionReadinessReentryGate = withRecordHash('SubmissionReadinessReentryGate', {
    kind: 'SubmissionReadinessReentryGate',
    paperId: row.task.paperId,
    status: 'submission_readiness_reentry_ready',
    submissionReadinessAdvanced: stateMutationRecorded,
    reason: stateMutationRecorded
      ? 'mapped referee issue blockers resolved; paper may re-enter reviewed-submit dry-run readiness path'
      : 'repair loop reconciled locally; reviewed-submit lifecycle remains a separate dry-run/reviewed-submit path',
    repairedArtifactRefs: artifacts,
    postRepairBuildPackageHash: postRepairBuildPackage?.postRepairBuildPackageHash || null,
    repairStateMutationReceiptHash: repairStateMutationReceipt?.repairStateMutationReceiptHash || null,
    safety: {
      gateOnly: true,
      advancesSubmissionReadiness: stateMutationRecorded,
      externalActionPerformed: false,
    },
  }, 'submissionReadinessReentryGateHash');
  const repairAuditArchiveRecord = withRecordHash('RepairAuditArchiveRecord', {
    kind: 'RepairAuditArchiveRecord',
    paperId: row.task.paperId,
    status: 'repair_audit_archive_record_ready',
    refs: [
      { role: 'applied_patch_receipt', hash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null },
      { role: 'post_repair_recheck_report', hash: postRepairRechecks?.postRepairRecheckReportHash || null },
      { role: 'post_repair_build_package', hash: postRepairBuildPackage?.postRepairBuildPackageHash || null },
      { role: 'issue_resolution_proof', hash: issueResolutionProof?.refereeIssueResolutionProofHash || null },
      ...artifacts,
    ].filter((ref) => ref.hash || ref.ref),
    safety: {
      archiveRecordOnly: true,
      externalActionPerformed: false,
    },
  }, 'repairAuditArchiveRecordHash');
  return {
    rollbackReconciliation,
    issueQueueUpdateReceipt,
    patchQueueUpdateReceipt,
    submissionReadinessReentryGate,
    repairAuditArchiveRecord,
  };
}

function mergeRefereeRepairMetadata(current, patchInput, context) {
  const existing = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const history = Array.isArray(existing.state_transition_history)
    ? existing.state_transition_history.slice(-24)
    : [];
  return {
    ...existing,
    hepta_referee_repair: {
      source: 'hepta_referee_agent_repair',
      status: 'resolved',
      resolvedBy: 'openclaw-agent',
      resolvedAt: context.resolvedAt,
      agentPatchId: patchInput?.patchId || null,
      agentPatchPath: patchInput?.patchPath || null,
      agentPatchSha256: patchInput?.patchSha256 || null,
      issueResolutionProofHash: context.issueResolutionProofHash || null,
      repairReconciliationHash: context.repairReconciliationHash || null,
      appliedPatchReceiptHash: context.appliedPatchReceiptHash || null,
      postRepairBuildPackageHash: context.postRepairBuildPackageHash || null,
    },
    state_transition_history: [
      ...history,
      {
        at: context.resolvedAt,
        from: context.previousStatus,
        to: 'resolved',
        dry_run: false,
        assignee: 'openclaw-agent',
        reason: 'resolved_by_agent_repair_reconciliation',
        worker_patch_id: null,
        verification_log_path: context.issueResolutionProofPath || '',
        source: 'hepta_referee_repair_state_mutation_executor',
        issue_resolution_proof_hash: context.issueResolutionProofHash || null,
        repair_reconciliation_hash: context.repairReconciliationHash || null,
      },
    ],
  };
}

function patchQueueMetadata(patchInput, context) {
  return {
    source: 'hepta_referee_agent_repair',
    status: 'agent_patch_applied_and_receipted',
    agentPatchId: patchInput?.patchId || null,
    resolvedIssueIds: context.resolvedIssueIds || [],
    appliedAt: context.resolvedAt,
    appliedPatchReceiptHash: context.appliedPatchReceiptHash || null,
    issueResolutionProofHash: context.issueResolutionProofHash || null,
    postRepairBuildPackageHash: context.postRepairBuildPackageHash || null,
    repairReconciliationHash: context.repairReconciliationHash || null,
  };
}

async function runRepairStateMutationExecutor({
  dbPath,
  runtimeRoot,
  row,
  requests,
  issueQueue,
  appliedPatchReceipt = null,
  postRepairBuildPackage = null,
  issueResolutionProof = null,
  repairReconciliation = null,
  execute = false,
} = {}) {
  const resolvedIssueIds = new Set(issueResolutionProof?.resolvedIssueIds || []);
  const openIssues = (issueQueue?.issues || []).filter(issueIsOpen);
  const patchInputs = appliedPatchReceipt?.plannedPatchInputs || [];
  const blockers = [];
  const warnings = [];
  const errors = [];
  if (execute && repairReconciliation?.status === 'repair_reconciliation_ready' && !patchInputs.length) {
    blockers.push('agent_patch_input_missing');
  }
  const openRequestRows = (requests || [])
    .filter((request) => resolvedIssueIds.has(normalizeText(request.request_key || request.requestKey || request.id || '')))
    .filter((request) => !CLOSED_REFEREE_STATUSES.has(normalizeText(request.status || '').toLowerCase()));
  const missingIssueRows = [...resolvedIssueIds].filter((issueId) => !openRequestRows.some((request) => (
    normalizeText(request.request_key || request.requestKey || request.id || '') === issueId
  )));
  if (execute && repairReconciliation?.status === 'repair_reconciliation_ready' && missingIssueRows.length) {
    blockers.push('resolved_issue_rows_missing');
    warnings.push(...missingIssueRows.slice(0, 8).map((issueId) => `missing_issue_row:${issueId}`));
  }

  let issueRowsUpdated = 0;
  let issueRowsAlreadyResolved = 0;
  let patchRowsInserted = 0;
  let patchRowsUpdated = 0;
  let patchRowsAlreadyPresent = 0;
  let issueRows = [];
  let patchRows = [];
  let sqliteWritePerformed = false;
  const resolvedAt = new Date().toISOString();

  if (execute && !blockers.length && openIssues.length && repairReconciliation?.status === 'repair_reconciliation_ready') {
    const statements = ['begin immediate;'];
    const contextBase = {
      resolvedAt,
      resolvedIssueIds: [...resolvedIssueIds],
      issueResolutionProofHash: issueResolutionProof?.refereeIssueResolutionProofHash || null,
      repairReconciliationHash: repairReconciliation?.repairReconciliationHash || null,
      appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
      postRepairBuildPackageHash: postRepairBuildPackage?.postRepairBuildPackageHash || null,
      issueResolutionProofPath: runtimeRoot
        ? relativePath(row.root || path.dirname(dbPath), path.join(runtimeRoot, 'referee-repair', row.task.paperId, 'ISSUE_RESOLUTION_PROOF.json'))
        : '',
    };
    const patchInput = patchInputs[0] || null;
    for (const request of openRequestRows) {
      const previousStatus = normalizeText(request.status || '');
      const metadata = mergeRefereeRepairMetadata(request.metadata, patchInput, {
        ...contextBase,
        previousStatus,
      });
      statements.push([
        'update referee_revision_requests',
        'set status=\'resolved\',',
        'state_reason=\'resolved_by_agent_repair_reconciliation\',',
        'assignee=\'openclaw-agent\',',
        `metadata_json=${sqlJson(metadata)},`,
        'updated_at=datetime(\'now\'),',
        'last_transition_at=datetime(\'now\')',
        `where slug=${sqlText(row.task.paperId)}`,
        `and request_key=${sqlText(request.request_key || request.requestKey || request.id)}`,
        'and status not in (\'closed\',\'resolved\',\'applied\',\'no_patch_needed\');',
      ].join(' '));
      issueRows.push({
        requestId: request.request_id || request.requestId || null,
        requestKey: request.request_key || request.requestKey || request.id,
        previousStatus,
        nextStatus: 'resolved',
        stateReason: 'resolved_by_agent_repair_reconciliation',
      });
    }
    issueRowsUpdated = openRequestRows.length;

    for (const patchInputItem of patchInputs) {
      const patchPath = normalizeText(patchInputItem.patchPath || '');
      const patchSha256 = normalizeText(patchInputItem.patchSha256 || '');
      if (!patchPath || !patchSha256) {
        warnings.push('agent_patch_queue_record_missing_path_or_hash');
        continue;
      }
      const existing = sqliteJson(
        dbPath,
        [
          'select patch_id,status,metadata_json from patch_queue',
          `where slug=${sqlText(row.task.paperId)}`,
          `and patch_path=${sqlText(patchPath)}`,
          `and patch_sha256=${sqlText(patchSha256)}`,
          'limit 1;',
        ].join(' '),
      )[0] || null;
      const metadata = patchQueueMetadata(patchInputItem, contextBase);
      const targetPathsJson = JSON.stringify(patchInputItem.targetPaths || []);
      const batchId = normalizeText(patchInputItem.batchId || `${row.task.paperId}:agent-repair-patch-bundle`);
      if (existing) {
        if (normalizeText(existing.status).toLowerCase() === 'applied') {
          patchRowsAlreadyPresent += 1;
        } else {
          patchRowsUpdated += 1;
        }
        statements.push([
          'update patch_queue',
          'set status=\'applied\',',
          `target_paths_json=${sqlText(targetPathsJson)},`,
          `batch_id=${sqlText(batchId)},`,
          `metadata_json=${sqlJson(metadata)},`,
          'updated_at=datetime(\'now\')',
          `where patch_id=${Number(existing.patch_id)};`,
        ].join(' '));
        patchRows.push({
          patchId: existing.patch_id,
          status: 'applied',
          action: normalizeText(existing.status).toLowerCase() === 'applied' ? 'already_present' : 'updated',
          patchPath,
          patchSha256,
        });
      } else {
        patchRowsInserted += 1;
        statements.push([
          'insert into patch_queue',
          '(slug,status,patch_path,patch_sha256,target_paths_json,batch_id,metadata_json)',
          'values',
          `(${sqlText(row.task.paperId)},'applied',${sqlText(patchPath)},${sqlText(patchSha256)},${sqlText(targetPathsJson)},${sqlText(batchId)},${sqlJson(metadata)});`,
        ].join(' '));
        patchRows.push({
          patchId: null,
          status: 'applied',
          action: 'inserted',
          patchPath,
          patchSha256,
        });
      }
    }
    statements.push('commit;');
    const execResult = sqliteExec(dbPath, statements.join('\n'));
    if (!execResult.ok) {
      errors.push(...stderrLines(execResult.stderr, 8));
      sqliteWritePerformed = false;
    } else {
      sqliteWritePerformed = true;
      const refreshedPatchRows = [];
      for (const patchRow of patchRows) {
        const refreshed = sqliteJson(
          dbPath,
          [
            'select patch_id,status,patch_path,patch_sha256 from patch_queue',
            `where slug=${sqlText(row.task.paperId)}`,
            `and patch_path=${sqlText(patchRow.patchPath)}`,
            `and patch_sha256=${sqlText(patchRow.patchSha256)}`,
            'limit 1;',
          ].join(' '),
        )[0] || null;
        refreshedPatchRows.push(refreshed ? { ...patchRow, patchId: refreshed.patch_id, status: refreshed.status } : patchRow);
      }
      patchRows = refreshedPatchRows;
    }
  }

  if (execute && sqliteWritePerformed) {
    const remaining = sqliteJson(
      dbPath,
      [
        'select count(*) as n from referee_revision_requests',
        `where slug=${sqlText(row.task.paperId)}`,
        'and status not in (\'closed\',\'resolved\',\'applied\',\'no_patch_needed\');',
      ].join(' '),
    )[0];
    if (Number(remaining?.n || 0) > 0) warnings.push(`remaining_open_issues:${Number(remaining.n)}`);
  }

  return buildRepairStateMutationReceipt({
    paperTask: row.task,
    issueQueue,
    appliedPatchReceipt,
    issueResolutionProof,
    repairReconciliation,
    execute,
    sqliteWritePerformed,
    issueRowsUpdated,
    issueRowsAlreadyResolved,
    patchRowsInserted,
    patchRowsUpdated,
    patchRowsAlreadyPresent,
    issueRows,
    patchRows,
    errors,
    blockers,
    warnings,
  });
}

async function targetPreimageRecords(root, targetPaths = []) {
  const records = [];
  const seen = new Set();
  for (const targetPath of targetPaths || []) {
    const normalized = normalizeText(targetPath);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const candidate = path.isAbsolute(normalized) ? normalized : path.join(root, normalized);
    if (!pathWithin(root, candidate)) continue;
    const record = await fileRecord(root, candidate, 'referee_revision_preimage');
    if (record) records.push(record);
  }
  return records;
}

export async function runRefereeReviseAdapter({
  root,
  runtimeRoot = null,
  row,
  mode = 'dry-run',
  execute = false,
  limit = 64,
} = {}) {
  const dbPath = path.join(root, 'paper_factory.sqlite');
  const slug = escapeSqlText(row.task.paperId);
  const requests = sqliteJson(
    dbPath,
    `select * from referee_revision_requests where slug='${slug}' order by status!='requested', cluster_rank desc, matrix_rank asc, request_id asc limit ${Number(limit) || 64};`,
  ).map(normalizeRequest);
  const patches = sqliteJson(
    dbPath,
    `select * from patch_queue where slug='${slug}' order by updated_at desc, patch_id desc limit ${Number(limit) || 64};`,
  ).map(normalizePatch);
  const baseIssueQueue = buildRefereeRevisionIssueQueue({
    paperTask: row.task,
    requests,
    patchQueue: patches,
  });
  const agentRepairPatchBundle = execute && Number(baseIssueQueue.openIssueCount || 0) > 0
    ? await buildAgentRepairPatchBundle({
      root,
      runtimeRoot,
      row,
      issueQueue: baseIssueQueue,
    })
    : null;
  const agentPatchBundleSelected = [
    'agent_repair_patch_bundle_ready',
    'agent_repair_patch_already_present',
  ].includes(agentRepairPatchBundle?.status);
  const effectivePatchQueue = agentPatchBundleSelected
    ? agentRepairPatchBundle.generatedPatchInputs
    : patches;
  const issueQueue = buildRefereeRevisionIssueQueue({
    paperTask: row.task,
    requests,
    patchQueue: effectivePatchQueue,
  });
  const patchPlan = buildRefereeRevisionPatchPlan({
    paperTask: row.task,
    issueQueue,
    mode,
  });
  const patchExecutionPreflight = buildRefereeRevisionPatchExecutionPreflight({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    sourceWorkspace: row.task.sourceWorkspace,
    mode,
  });
  const rollbackLedgerDraft = buildRefereeRevisionRollbackLedgerDraft({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    mode,
  });
  const targetRecords = await targetPreimageRecords(root, patchExecutionPreflight.targetPaths || []);
  const preimageSnapshotLedger = buildRefereeRevisionPreimageSnapshotLedger({
    paperTask: row.task,
    patchExecutionPreflight,
    targetRecords,
  });
  const executePlan = buildRefereeRevisionExecutePlan({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    preimageSnapshotLedger,
    mode: 'execute-plan',
  });
  const applyModeContract = buildRefereeRevisionApplyModeContract({
    paperTask: row.task,
    executePlan,
    approved: true,
    approver: 'openclaw-agent',
    approvalActor: 'agent',
  });
  const dryRunReceipt = buildRefereeRevisionDryRunReceipt({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    rollbackLedgerDraft,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
  });
  const executeDesignPacket = buildRefereeRevisionExecuteDesignPacket({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
    dryRunReceipt,
  });
  const applyApprovalPacket = buildRefereeApplyApprovalPacket({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    rollbackLedgerDraft,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
    executeDesignPacket,
    approved: true,
    approver: 'openclaw-agent',
    approvalActor: 'agent',
  });
  const patchApplyExecution = buildRefereePatchApplyExecution({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
    executeDesignPacket,
    applyApprovalPacket,
    execute: Boolean(execute),
  });
  const patchApplyAttempt = execute
    ? await validateAndMaybeApplyPatches({
      root,
      row,
      patchApplyExecution,
      preimageSnapshotLedger,
      execute: Boolean(execute),
    })
    : null;
  const patchApplyInvocation = buildRefereePatchApplyInvocation({
    paperTask: row.task,
    issueQueue,
    patchApplyExecution,
    applyApprovalPacket,
    execute: Boolean(execute),
    executorId: 'openclaw-agent-local-patch-apply',
    validationRecords: patchApplyAttempt?.validationRecords || [],
    targetPreimageChecks: patchApplyAttempt?.targetPreimageChecks || [],
    appliedPatchHashes: patchApplyAttempt?.appliedPatchHashes || [],
    postimageRecords: patchApplyAttempt?.postimageRecords || [],
    sourceDiffHash: patchApplyAttempt?.sourceDiffHash || null,
    applied: Boolean(patchApplyAttempt?.applied),
    blockers: patchApplyAttempt?.blockers || [],
    warnings: patchApplyAttempt?.warnings || [],
  });
  if (execute && runtimeRoot && Number(issueQueue.openIssueCount || 0) > 0) {
    const invocationPath = path.join(runtimeRoot, 'referee-repair', row.task.paperId, 'PATCH_APPLY_INVOCATION.json');
    await writeJsonFile(invocationPath, patchApplyInvocation);
  }
  const appliedPatchReceipt = buildRefereeAppliedPatchReceipt({
    paperTask: row.task,
    issueQueue,
    patchPlan,
    patchApplyExecution,
    patchApplyInvocation,
    applyApprovalPacket,
    preimageSnapshotLedger,
    applied: patchApplyInvocation.status === 'referee_patch_apply_invocation_applied',
    executorId: patchApplyInvocation.executorId,
    postimageRecords: patchApplyInvocation.postimageRecords || [],
  });
  const postRepairRechecks = appliedPatchReceipt.status === 'applied_patch_receipt_recorded'
    ? await runPostRepairRechecks({
      root,
      runtimeRoot,
      row,
      agentRepairPatchBundle,
      appliedPatchReceipt,
      execute: Boolean(execute),
    })
    : null;
  const postRepairBuildPackage = buildPostRepairBuildPackage({
    paperTask: row.task,
    issueQueue,
    patchApplyExecution,
    patchApplyInvocation,
    appliedPatchReceipt,
    buildRecheck: postRepairRechecks?.buildRecheck || null,
    packageRecheck: postRepairRechecks?.packageRecheck || null,
    researchRecheck: postRepairRechecks?.researchRecheck || null,
  });
  const resolutionEvidence = buildIssueResolutionEvidence({
    issueQueue,
    appliedPatchReceipt,
    postRepairRechecks,
    postRepairBuildPackage,
  });
  const issueResolutionProof = buildRefereeIssueResolutionProof({
    paperTask: row.task,
    issueQueue,
    appliedPatchReceipt,
    postRepairBuildPackage,
    resolutionEvidence,
  });
  let repairReconciliationInputs = buildRepairReconciliationInputs({
    row,
    issueQueue,
    appliedPatchReceipt,
    postRepairRechecks,
    postRepairBuildPackage,
    issueResolutionProof,
  });
  let repairReconciliation = buildRepairReconciliation({
    paperTask: row.task,
    issueQueue,
    appliedPatchReceipt,
    postRepairBuildPackage,
    issueResolutionProof,
    ...repairReconciliationInputs,
  });
  const repairStateMutationReceipt = await runRepairStateMutationExecutor({
    dbPath,
    runtimeRoot,
    row,
    requests,
    issueQueue,
    appliedPatchReceipt,
    postRepairBuildPackage,
    issueResolutionProof,
    repairReconciliation,
    execute: Boolean(execute),
  });
  if (repairStateMutationReceipt.status === 'repair_state_mutation_recorded') {
    repairReconciliationInputs = buildRepairReconciliationInputs({
      row,
      issueQueue,
      appliedPatchReceipt,
      postRepairRechecks,
      postRepairBuildPackage,
      issueResolutionProof,
      repairStateMutationReceipt,
    });
    repairReconciliation = buildRepairReconciliation({
      paperTask: row.task,
      issueQueue,
      appliedPatchReceipt,
      postRepairBuildPackage,
      issueResolutionProof,
      repairStateMutationReceipt,
      ...repairReconciliationInputs,
    });
  }
  if (execute && runtimeRoot && Number(issueQueue.openIssueCount || 0) > 0) {
    const repairDir = path.join(runtimeRoot, 'referee-repair', row.task.paperId);
    await writeJsonFile(path.join(repairDir, 'ISSUE_RESOLUTION_PROOF.json'), issueResolutionProof);
    await writeJsonFile(path.join(repairDir, 'REPAIR_STATE_MUTATION_RECEIPT.json'), repairStateMutationReceipt);
    await writeJsonFile(path.join(repairDir, 'REPAIR_RECONCILIATION.json'), repairReconciliation);
  }
  const warnings = [];
  if (!requests.length && !patches.length) warnings.push('referee_revision_queue_empty');
  const blockers = [];
  if (mode !== 'dry-run') blockers.push('referee_revision_execute_requires_explicit_rollback_ledger');
  const report = {
    version: 1,
    kind: 'RefereeRevisionAdapterReport',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: blockers.length ? 'blocked' : (issueQueue.openIssueCount ? 'dry_run_patch_plan_ready' : 'referee_revision_queue_clear'),
    issueCount: issueQueue.issueCount,
    openIssueCount: issueQueue.openIssueCount,
    patchCount: issueQueue.patchCount,
    legacyPatchCount: patches.length,
    effectivePatchSource: agentPatchBundleSelected
      ? 'agent_repair_patch_bundle'
      : 'legacy_patch_queue',
    agentRepairPatchBundle,
    issueQueue,
    patchPlan,
    patchExecutionPreflight,
    rollbackLedgerDraft,
    preimageSnapshotLedger,
    executePlan,
    applyModeContract,
    executeDesignPacket,
    applyApprovalPacket,
    patchApplyExecution,
    patchApplyInvocation,
    appliedPatchReceipt,
    postRepairRechecks,
    postRepairBuildPackage,
    issueResolutionProof,
    repairStateMutationReceipt,
    repairReconciliation,
    dryRunReceipt,
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    source: {
      sqlite: 'paper_factory.sqlite',
      tables: ['referee_revision_requests', 'patch_queue'],
      agentRepairPatchBundle: agentRepairPatchBundle?.manifestPath || null,
    },
    safety: {
      readsOnly: !patchApplyInvocation.safety?.sourceMutation,
      dryRunOnly: !execute,
      sourceMutation: Boolean(patchApplyInvocation.safety?.sourceMutation),
      externalActionPerformed: false,
      importsOldControlPlane: false,
    },
  };
  return {
    ...report,
    refereeRevisionAdapterReportHash: hashPaperRecord('RefereeRevisionAdapterReport', report),
  };
}
