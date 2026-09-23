import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDir,
  fileRecord,
  pathWithin,
  readTextIfExists,
  relativePath,
} from '../../workflow-kernel/runtime/file-utils.mjs';
import { uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { writeJsonFile, writeTextFile } from '../artifacts/write-artifact.mjs';
import { insertRepairNotes, repairNotesLatex, sourceLocatorPath } from './repair-notes-builder.mjs';
import {
  AGENT_REPAIR_BEGIN,
  issueIsOpen,
  shaDigest,
  stderrLines,
} from './repair-shared.mjs';

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
