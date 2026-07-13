import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCampaignNodeExecutor } from '../../paper-adapters/automation/campaign-node-executor.mjs';
import { runTheoremManuscriptReadinessCheck } from '../../paper-adapters/automation/theorem-manuscript-readiness-check.mjs';
import { createTheoremQualityRevisionSink } from '../../paper-adapters/automation/theorem-quality-revision-sink.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { evaluateRefereeConvergence } from '../../paper-domain/automation/referee-convergence.mjs';

function writeTheoremWorkspace(root, { blocked = false } = {}) {
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '\\begin{theorem}Every fixture is deterministic.\\end{theorem}',
    blocked ? '\\begin{proof}Proof sketch; remaining work.\\end{proof}' : '\\begin{proof}By construction.\\end{proof}',
    '\\appendix',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'proof_status.md'), blocked
    ? '## Still Open\n\n| Item | Detail |\n| --- | --- |\n| Lemma A | unfinished |\n'
    : '# Proof status\n\nAll stated obligations are closed.\n');
  fs.writeFileSync(path.join(root, 'evidence_manifest.md'), blocked
    ? '# Evidence\n\nThe fixture does not prove the theorem.\n'
    : '# Evidence\n\nThe checked proof supports the theorem statement.\n');
}

test('theorem readiness detects unresolved proof semantics from manuscript sources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeTheoremWorkspace(root, { blocked: true });
  const report = runTheoremManuscriptReadinessCheck({ workspacePath: root, paperId: 'fixture', profile: 'theorem_or_proof' });
  assert.equal(report.passed, false);
  assert.ok(report.blockers.includes('theorem_proof_skeleton_present'));
  assert.ok(report.blockers.includes('theorem_open_proof_obligations_present'));
  assert.ok(report.blockers.includes('theorem_evidence_manifest_disclaims_support'));
});

test('theorem readiness is enforced by convergence and package boundaries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeTheoremWorkspace(root, { blocked: true });
  const executor = createCampaignNodeExecutor({
    runtimeRoot: path.join(root, 'runtime'),
    agentExecutor: { async execute() { throw new Error('agent_not_expected'); } },
    empiricalExecutor: { execute() { throw new Error('package_must_be_blocked_before_execution'); } },
  });
  const campaign = { campaign_id: 'campaign', paper_id: 'fixture', spec: { sourceWorkspace: root, paperQualityProfile: 'theorem_or_proof' } };
  const convergenceInput = await executor.execute({ campaign, node: { node_id: 'convergence', kind: 'convergence', roundIndex: 1 }, allNodes: [] });
  const reviews = [1, 2, 3].map((index) => ({ reviewerId: `r${index}`, verdict: 'accept', score: 0.95, criticalFindingCount: 0, reviewHash: `sha256:r${index}`, manuscriptHash: 'sha256:manuscript', childSessionId: `session-${index}` }));
  const decision = evaluateRefereeConvergence({ paperId: 'fixture', roundIndex: 1, reviews, expectedManuscriptHash: 'sha256:manuscript', qualityGates: convergenceInput.qualityGates });
  assert.equal(decision.accepted, false);
  assert.equal(decision.qualityGatesPassed, false);
  assert.ok(decision.qualityGateBlockers.includes('theorem_open_proof_obligations_present'));
  await assert.rejects(
    executor.execute({ campaign, node: { node_id: 'package', kind: 'package', roundIndex: 2 }, allNodes: [] }),
    /theorem_proof_skeleton_present/,
  );

  writeTheoremWorkspace(root, { blocked: false });
  const passed = await executor.execute({ campaign, node: { node_id: 'convergence-2', kind: 'convergence', roundIndex: 2 }, allNodes: [] });
  assert.equal(passed.qualityGates[0].passed, true);
});

test('non-theorem manuscripts do not trigger title or keyword inference', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-nontheorem-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), '\\section{Discussion} We discuss proof engineering without stating a theorem.\n');
  const report = runTheoremManuscriptReadinessCheck({ workspacePath: root, paperId: 'fixture' });
  assert.equal(report.applicable, false);
  assert.equal(report.passed, true);
});

test('theorem readiness follows safe recursive LaTeX includes and nested appendix files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-includes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sections'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backmatter'), { recursive: true });
  fs.writeFileSync(path.join(root, 'main.tex'), '\\input{sections/theorem}\n\\input{sections/cycle}\n');
  fs.writeFileSync(path.join(root, 'sections', 'theorem.tex'), '\\begin{theorem}Nested.\\end{theorem}\n\\begin{proof}Complete.\\end{proof}\n');
  fs.writeFileSync(path.join(root, 'sections', 'cycle.tex'), '\\input{../main}\n');
  fs.writeFileSync(path.join(root, 'backmatter', 'appendix-proof.tex'), 'Supporting details.\n');
  fs.writeFileSync(path.join(root, 'proof_status.md'), 'All obligations closed.\n');
  fs.writeFileSync(path.join(root, 'evidence_manifest.md'), 'Evidence supports the statement.\n');
  const report = runTheoremManuscriptReadinessCheck({ workspacePath: root });
  assert.equal(report.passed, true, JSON.stringify(report.blockers));
  assert.deepEqual(report.manuscriptPaths, ['main.tex', 'sections/cycle.tex', 'sections/theorem.tex']);
  assert.deepEqual(report.appendixPaths, ['backmatter/appendix-proof.tex']);
});

test('blocked theorem policy materializes idempotent referee revision requests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-revision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeTheoremWorkspace(root, { blocked: true });
  const store = createDefaultPaperStore({ root, runtimeRoot: path.join(root, 'runtime') });
  t.after(() => store.close());
  assert.equal(store.execute("INSERT INTO papers(slug,canonical_dir) VALUES('fixture','fixture');").ok, true);
  const report = runTheoremManuscriptReadinessCheck({ workspacePath: root, paperId: 'fixture', profile: 'theorem_or_proof' });
  const sink = createTheoremQualityRevisionSink({ store, clock: { nowIso: () => '2026-07-12T00:00:00.000Z' } });
  sink.record({ paperId: 'fixture', report, sourceWorkspace: root });
  sink.record({ paperId: 'fixture', report, sourceWorkspace: root });
  const rows = store.query("SELECT request_key,status,evidence_locator FROM referee_revision_requests WHERE slug='fixture' ORDER BY request_key;").rows;
  assert.equal(rows.length, report.blockers.length);
  assert.ok(rows.every((row) => row.status === 'requested' && row.evidence_locator === report.theoremManuscriptReadinessPolicyHash));
});
