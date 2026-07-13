import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDir,
  fileRecord,
  pathWithin,
  readTextIfExists,
  relativePath,
  sha256File,
  sha256Text,
} from '../../workflow-kernel/runtime/file-utils.mjs';
import { inspectScopedPathSync, readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { writeJsonFile, writeTextFile } from '../artifacts/write-artifact.mjs';

function shaDigest(value) {
  return normalizeText(value).toLowerCase().replace(/^sha256:/, '');
}

export function stderrLines(value, limit = 8) {
  return String(value || '')
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .slice(0, limit);
}

const CLOSED_REFEREE_STATUSES = new Set(['closed', 'resolved', 'applied', 'no_patch_needed']);
const AGENT_REPAIR_BEGIN = '% HEPTA_REFEREE_REPAIR_AGENT_NOTES_BEGIN';
const AGENT_REPAIR_END = '% HEPTA_REFEREE_REPAIR_AGENT_NOTES_END';

export function issueIsOpen(issue = {}) {
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

export async function buildAgentRepairPatchBundle({
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

export async function validateAndMaybeApplyPatches({
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
    const targetIdentity = expected?.exists
      ? inspectScopedPathSync({ scopeRoot: sourceRoot, candidate: targetAbs, expect: 'file' })
      : inspectScopedPathSync({ scopeRoot: sourceRoot, candidate: path.dirname(targetAbs), expect: 'directory', forbidHardlinks: false });
    if (targetIdentity.status !== 'scoped_file_identity_verified') checkBlockers.push(...targetIdentity.blockers.map((item) => `target_identity:${item}`));
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
      const patchRead = readScopedFileSync({ scopeRoot: root, candidate: patchAbs, maximumBytes: 16 * 1024 * 1024 });
      if (patchRead.status === 'scoped_file_read_verified') actualHash = patchRead.hash;
      else recordBlockers.push('patch_file_missing_or_unsafe', ...patchRead.blockers);
    }
    if (patch.patchSha256 && actualHash && shaDigest(patch.patchSha256) !== shaDigest(actualHash)) {
      recordBlockers.push('patch_hash_mismatch');
    }
    for (const targetPath of patch.targetPaths || []) {
      const targetAbs = path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
      if (!pathWithin(root, targetAbs)) recordBlockers.push('patch_target_outside_repo_root');
      if (!pathWithin(sourceRoot, targetAbs)) recordBlockers.push('patch_target_outside_source_workspace');
      const parentIdentity = inspectScopedPathSync({ scopeRoot: sourceRoot, candidate: path.dirname(targetAbs), expect: 'directory', forbidHardlinks: false });
      if (parentIdentity.status !== 'scoped_file_identity_verified') recordBlockers.push(...parentIdentity.blockers.map((item) => `patch_target_identity:${item}`));
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

export async function rollbackAppliedPatches({ root, row, patchApplyResult } = {}) {
  const blockers = [];
  const patches = (patchApplyResult?.validationRecords || []).filter((record) => !record.blockers?.length && record.patchPath);
  if (!patchApplyResult?.applied) blockers.push('applied_patch_result_required');
  if (!patches.length) blockers.push('applied_patch_records_missing');
  const patchPaths = patches.map((record) => path.isAbsolute(record.patchPath) ? record.patchPath : path.join(root, record.patchPath));
  if (!blockers.length) {
    const check = spawnSync('git', ['apply', '--reverse', '--check', '--whitespace=nowarn', ...patchPaths], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (check.status !== 0) blockers.push('repair_rollback_check_failed');
    if (!blockers.length) {
      const rollback = spawnSync('git', ['apply', '--reverse', '--whitespace=nowarn', ...patchPaths], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (rollback.status !== 0) blockers.push('repair_rollback_apply_failed');
    }
  }
  const restoredPreimages = [];
  for (const preimage of patchApplyResult?.targetPreimageChecks || []) {
    const candidate = path.isAbsolute(preimage.targetPath) ? preimage.targetPath : path.join(root, preimage.targetPath);
    const record = pathWithin(root, candidate) ? await fileRecord(root, candidate, 'repair_rollback_preimage') : null;
    const restored = Boolean(record?.hash && preimage.expectedPreimageHash && shaDigest(record.hash) === shaDigest(preimage.expectedPreimageHash));
    if (!restored) blockers.push(`repair_rollback_preimage_mismatch:${preimage.targetPath}`);
    restoredPreimages.push({ targetPath: preimage.targetPath, expectedHash: preimage.expectedPreimageHash || null, actualHash: record?.hash || null, restored });
  }
  const payload = {
    version: 1,
    kind: 'RepairRollbackReceipt',
    paperId: row?.task?.paperId || null,
    status: blockers.length ? 'repair_rollback_blocked' : 'repair_rollback_verified',
    appliedPatchHashes: patchApplyResult?.appliedPatchHashes || [],
    restoredPreimages,
    blockers: uniqueStrings(blockers, 64),
    safety: { sourceRestored: blockers.length === 0, externalActionPerformed: false },
  };
  return { ...payload, repairRollbackReceiptHash: sha256Text(JSON.stringify(payload)) };
}

export function buildRepairApplyProof({ row, preimageSnapshotLedger, patchApplyResult } = {}) {
  const blockers = [];
  if (!patchApplyResult?.applied) blockers.push('repair_apply_not_performed');
  if (!(patchApplyResult?.targetPreimageChecks || []).every((entry) => entry.status === 'preimage_check_passed')) blockers.push('repair_preimage_checks_not_verified');
  if (!(patchApplyResult?.postimageRecords || []).length) blockers.push('repair_postimages_missing');
  if (!patchApplyResult?.sourceDiffHash) blockers.push('repair_source_diff_hash_missing');
  const payload = {
    version: 1,
    kind: 'RepairApplyProof',
    paperId: row?.task?.paperId || null,
    status: blockers.length ? 'repair_apply_proof_blocked' : 'repair_apply_proof_ready',
    preimageLedgerHash: preimageSnapshotLedger?.preimageSnapshotLedgerHash || null,
    acceptedPreimages: patchApplyResult?.targetPreimageChecks || [],
    appliedPatchHashes: patchApplyResult?.appliedPatchHashes || [],
    postimageRecords: patchApplyResult?.postimageRecords || [],
    sourceDiffHash: patchApplyResult?.sourceDiffHash || null,
    blockers,
    reconciliation: {
      preimageCount: (patchApplyResult?.targetPreimageChecks || []).length,
      postimageCount: (patchApplyResult?.postimageRecords || []).length,
      everyPreimageAccountedFor: (patchApplyResult?.targetPreimageChecks || []).length === (patchApplyResult?.postimageRecords || []).length,
    },
  };
  if (!payload.reconciliation.everyPreimageAccountedFor) payload.blockers.push('repair_preimage_postimage_count_mismatch');
  if (payload.blockers.length) payload.status = 'repair_apply_proof_blocked';
  return { ...payload, repairApplyProofHash: sha256Text(JSON.stringify(payload)) };
}
