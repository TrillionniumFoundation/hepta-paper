import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAgentRepairPatchBundle,
  buildRepairApplyProof,
  issueIsOpen,
  rollbackAppliedPatches,
  stderrLines,
  validateAndMaybeApplyPatches,
} from '../../paper-adapters/referee-revise/repair-executor.mjs';
import { buildAgentRepairPatchBundle as directBundle } from '../../paper-adapters/referee-revise/repair-patch-bundle.mjs';
import { buildRepairApplyProof as directProof } from '../../paper-adapters/referee-revise/repair-proof-builder.mjs';
import { repairNotesLatex, insertRepairNotes } from '../../paper-adapters/referee-revise/repair-notes-builder.mjs';
import { rollbackAppliedPatches as directRollback } from '../../paper-adapters/referee-revise/repair-rollback-executor.mjs';
import { validateAndMaybeApplyPatches as directApply } from '../../paper-adapters/referee-revise/repair-apply-executor.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';

function temporaryRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function initializeGitRepository(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Hepta Test'], { cwd: root });
}

test('repair executor facade preserves the original API bindings', () => {
  assert.equal(buildAgentRepairPatchBundle, directBundle);
  assert.equal(buildRepairApplyProof, directProof);
  assert.equal(rollbackAppliedPatches, directRollback);
  assert.equal(validateAndMaybeApplyPatches, directApply);
  assert.equal(typeof issueIsOpen, 'function');
  assert.equal(typeof stderrLines, 'function');
});

test('repair note pure builder matches the compatibility golden and is idempotent', () => {
  const notes = repairNotesLatex({
    paperId: 'paper_1',
    openIssues: [{
      id: 'issue_1',
      status: 'open',
      riskClass: 'proof & theorem',
      proposedFix: 'Narrow claim #1',
      verification: 'Run proof_check',
    }],
  });
  assert.equal(notes, [
    '% HEPTA_REFEREE_REPAIR_AGENT_NOTES_BEGIN',
    '\\section*{Agent Referee Repair Notes}',
    'This agent-applied repair records the local, evidence-bounded response to the open referee queue for \\texttt{paper\\_1}. It does not introduce new empirical claims, theorem claims, or venue-submission readiness beyond the artifacts and claim boundaries already present in the source package.',
    '\\paragraph{Proof and claim-boundary repair.}',
    'Any theorem-level, proof-sketch, or certificate-dependent language remains conditional on the listed local proof obligations, evidence manifests, and post-repair verification. Claims without a recorded certificate are treated as assumptions, limitations, or repair targets rather than submit-ready conclusions.',
    '\\paragraph{Open referee items addressed by this repair pass.}',
    '\\begin{itemize}',
    '\\item \\textbf{proof \\& theorem} (issue\\_1): Narrow claim \\#1 Verification: Run proof\\_check',
    '\\end{itemize}',
    '\\paragraph{Post-repair gate.}',
    'This source mutation is not a final referee-resolution proof by itself. The repair still requires a fresh build, package rewrite, research/evidence recheck, issue-resolution proof, and repair reconciliation before any issue may be closed or submission readiness advanced.',
    '% HEPTA_REFEREE_REPAIR_AGENT_NOTES_END',
  ].join('\n'));
  const source = '\\documentclass{article}\n\\begin{document}\nBody\n\\end{document}\n';
  const patched = insertRepairNotes(source, notes);
  assert.equal(patched.includes(`${notes}\n\\end{document}`), true);
  assert.equal(insertRepairNotes(patched, notes), null);
});

test('repair patch bundle covers ready and already-present source states', async (t) => {
  const root = temporaryRoot(t, 'hepta-repair-bundle-');
  const runtimeRoot = path.join(root, 'runtime');
  const sourceRoot = path.join(root, 'paper');
  await fsp.mkdir(sourceRoot, { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, 'main.tex'), [
    '\\documentclass{article}',
    '\\begin{document}',
    'Original body.',
    '\\end{document}',
    '',
  ].join('\n'));
  initializeGitRepository(root);
  execFileSync('git', ['add', 'paper/main.tex'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  const row = { task: { paperId: 'paper', sourceWorkspace: 'paper', mainTex: 'paper/main.tex' } };
  const issueQueue = {
    issueCount: 1,
    issues: [{
      id: 'issue:proof',
      status: 'open',
      riskClass: 'proof boundary',
      sourceLocator: 'paper/main.tex:3',
      proposedFix: 'Narrow the theorem claim',
      verification: 'rebuild and recheck',
    }],
  };

  const artifactRepositoryFactory = () => ({
    async writeJson(target, value) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
      return {};
    },
    async writeText(target, value) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, value);
      return {};
    },
  });
  await withArtifactWriteContext({ artifactRepositoryFactory }, async () => {
    const ready = await buildAgentRepairPatchBundle({ root, runtimeRoot, row, issueQueue });
    assert.equal(ready.status, 'agent_repair_patch_bundle_ready');
    assert.equal(ready.cleanApplyCheck, 'clean_apply_check_passed');
    assert.deepEqual(ready.blockers, []);
    assert.deepEqual(ready.issueIds, ['issue:proof']);
    assert.equal(ready.generatedPatchInputs.length, 1);
    assert.equal(ready.generatedPatchInputs[0].status, 'agent_generated');
    assert.equal(ready.safety.requiresPatchApplyInvocation, true);
    const patchPath = path.join(root, ready.generatedPatchInputs[0].patchPath);
    assert.equal(fs.existsSync(patchPath), true);
    assert.equal(fs.existsSync(path.join(root, ready.manifestPath)), true);

    execFileSync('git', ['apply', '--whitespace=nowarn', patchPath], { cwd: root });
    const alreadyPresent = await buildAgentRepairPatchBundle({ root, runtimeRoot, row, issueQueue });
    assert.equal(alreadyPresent.status, 'agent_repair_patch_already_present');
    assert.deepEqual(alreadyPresent.blockers, ['agent_repair_notes_already_present']);
    assert.equal(alreadyPresent.generatedPatchInputs[0].status, 'agent_generated_already_applied');
    assert.equal(alreadyPresent.safety.requiresPatchApplyInvocation, false);
  });
});

test('repair patch bundle reports prerequisite and target blockers without writing source', async (t) => {
  const root = temporaryRoot(t, 'hepta-repair-bundle-blocked-');
  const row = { task: { paperId: 'paper', sourceWorkspace: 'paper', mainTex: 'paper/missing.tex' } };
  const prerequisites = await buildAgentRepairPatchBundle({
    root,
    row,
    issueQueue: { issueCount: 0, issues: [] },
  });
  assert.equal(prerequisites.status, 'agent_repair_patch_bundle_blocked');
  assert.deepEqual(prerequisites.blockers, [
    'runtime_root_required_for_agent_repair_patch_bundle',
    'open_referee_issues_required_for_agent_repair_patch_bundle',
  ]);

  const missingTarget = await buildAgentRepairPatchBundle({
    root,
    runtimeRoot: path.join(root, 'runtime'),
    row,
    issueQueue: { issueCount: 1, issues: [{ id: 'open', status: 'open', sourceLocator: 'paper/missing.tex:1' }] },
  });
  assert.equal(missingTarget.status, 'agent_repair_patch_bundle_blocked');
  assert.deepEqual(missingTarget.blockers, ['agent_repair_tex_target_not_found']);
  assert.equal(missingTarget.targetPath, null);
});

test('repair proof builder preserves ready mapping and blocked reconciliation gates', () => {
  const row = { task: { paperId: 'paper' } };
  const ready = buildRepairApplyProof({
    row,
    preimageSnapshotLedger: { preimageSnapshotLedgerHash: 'sha256:ledger' },
    patchApplyResult: {
      applied: true,
      targetPreimageChecks: [{ targetPath: 'paper/main.tex', status: 'preimage_check_passed', expectedPreimageHash: 'sha256:old' }],
      appliedPatchHashes: ['sha256:patch'],
      postimageRecords: [{ targetPath: 'paper/main.tex', postimageHash: 'sha256:new' }],
      sourceDiffHash: 'sha256:diff',
    },
  });
  assert.deepEqual(ready, {
    version: 1,
    kind: 'RepairApplyProof',
    paperId: 'paper',
    status: 'repair_apply_proof_ready',
    preimageLedgerHash: 'sha256:ledger',
    acceptedPreimages: [{ targetPath: 'paper/main.tex', status: 'preimage_check_passed', expectedPreimageHash: 'sha256:old' }],
    appliedPatchHashes: ['sha256:patch'],
    postimageRecords: [{ targetPath: 'paper/main.tex', postimageHash: 'sha256:new' }],
    sourceDiffHash: 'sha256:diff',
    blockers: [],
    reconciliation: { preimageCount: 1, postimageCount: 1, everyPreimageAccountedFor: true },
    repairApplyProofHash: 'sha256:df29430d7408c764dbe68f13c6cd37c9e0b813a7d4768aa6ccd0ba9e12f492bf',
  });

  const blocked = buildRepairApplyProof({
    row,
    preimageSnapshotLedger: {},
    patchApplyResult: {
      applied: false,
      targetPreimageChecks: [{ targetPath: 'paper/main.tex', status: 'preimage_check_failed' }],
      appliedPatchHashes: [],
      postimageRecords: [],
      sourceDiffHash: null,
    },
  });
  assert.deepEqual(blocked.blockers, [
    'repair_apply_not_performed',
    'repair_preimage_checks_not_verified',
    'repair_postimages_missing',
    'repair_source_diff_hash_missing',
    'repair_preimage_postimage_count_mismatch',
  ]);
  assert.equal(blocked.status, 'repair_apply_proof_blocked');
  assert.deepEqual(blocked.reconciliation, { preimageCount: 1, postimageCount: 0, everyPreimageAccountedFor: false });
  assert.equal(blocked.repairApplyProofHash, 'sha256:5b043bfc5f55cdcc25b7971e3dba00b60cf8aca45deecaacb1b243c4139cfee3');
});

test('rollback state module fails closed with a stable receipt when no apply occurred', async () => {
  const receipt = await rollbackAppliedPatches({
    root: '/tmp/not-used',
    row: { task: { paperId: 'paper' } },
    patchApplyResult: { applied: false, validationRecords: [], targetPreimageChecks: [], appliedPatchHashes: [] },
  });
  assert.deepEqual(receipt, {
    version: 1,
    kind: 'RepairRollbackReceipt',
    paperId: 'paper',
    status: 'repair_rollback_blocked',
    appliedPatchHashes: [],
    restoredPreimages: [],
    blockers: ['applied_patch_result_required', 'applied_patch_records_missing'],
    safety: { sourceRestored: false, externalActionPerformed: false },
    repairRollbackReceiptHash: 'sha256:57ff98517865c0aad4de3e11b8333d2e01cdbc3a24c92aca3a8dbd7f280f9b30',
  });
});
