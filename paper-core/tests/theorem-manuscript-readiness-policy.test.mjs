import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
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

test('theorem readiness recognizes custom and starred newtheorem environments', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-custom-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '\\newtheorem{mainresult}{Main Result}',
    '\\newtheorem*{supportingresult}{Supporting Result}',
    '\\begin{mainresult}First custom claim.\\end{mainresult}',
    '\\begin{proof}Complete first proof.\\end{proof}',
    '\\begin{supportingresult}Second custom claim.\\end{supportingresult}',
    '\\begin{proof}Complete second proof.\\end{proof}',
    '\\appendix',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'proof_status.md'), 'All obligations closed.\n');
  fs.writeFileSync(path.join(root, 'evidence_manifest.md'), 'Evidence supports both statements.\n');
  const report = runTheoremManuscriptReadinessCheck({ workspacePath: root });
  assert.equal(report.passed, true, JSON.stringify(report.blockers));
  assert.equal(report.theoremStatementCount, 2);
  assert.equal(report.proofEnvironmentCount, 2);
  assert.equal(report.theoremEnvironmentDeclarationCount, 2);
});

test('theorem readiness rejects one proof environment for multiple theorem statements', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-proof-cardinality-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '\\begin{theorem}First claim.\\end{theorem}',
    '\\begin{theorem}Second claim.\\end{theorem}',
    '\\begin{proof}One proof cannot cover both claims.\\end{proof}',
    '\\appendix',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'proof_status.md'), 'All obligations claimed closed.\n');
  fs.writeFileSync(path.join(root, 'evidence_manifest.md'), 'Evidence claims support.\n');
  const report = runTheoremManuscriptReadinessCheck({ workspacePath: root });
  assert.equal(report.passed, false);
  assert.equal(report.theoremStatementCount, 2);
  assert.equal(report.proofEnvironmentCount, 1);
  assert.ok(report.blockers.includes('theorem_proof_environment_count_mismatch'));
});

test('theorem readiness rejects an unrelated proof placed before a theorem even when counts match', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-proof-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '\\begin{proof}Unrelated argument.\\end{proof}',
    '\\begin{theorem}Claim without its own proof.\\end{theorem}',
    '\\appendix',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'proof_status.md'), 'All obligations claimed closed.\n');
  fs.writeFileSync(path.join(root, 'evidence_manifest.md'), 'Evidence claims support.\n');

  const report = runTheoremManuscriptReadinessCheck({ workspacePath: root, profile: 'theorem_or_proof' });
  assert.equal(report.theoremStatementCount, 1);
  assert.equal(report.proofEnvironmentCount, 1);
  assert.equal(report.passed, false);
  assert.ok(report.blockers.includes('theorem_proof_environment_pairing_invalid'));
  assert.ok(report.theoremProofPairingBlockers.some((item) => item.code === 'theorem_proof_pairing_orphan_proof'));
});

test('theorem readiness fails closed on an unsafe newtheorem declaration', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-unsafe-declaration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), '\\newtheorem{\\dynamicname}{Dynamic Result}\n\\appendix\n');
  fs.writeFileSync(path.join(root, 'proof_status.md'), 'All obligations claimed closed.\n');
  fs.writeFileSync(path.join(root, 'evidence_manifest.md'), 'Evidence claims support.\n');
  const report = runTheoremManuscriptReadinessCheck({ workspacePath: root });
  assert.equal(report.passed, false);
  assert.ok(report.blockers.includes('theorem_environment_declaration_unresolved'));
  assert.ok(report.theoremEnvironmentSyntaxBlockers.some((item) => item.code === 'theorem_environment_name_unsafe'));
});

test('theorem readiness fails closed for common macro families that construct theorem environments', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-macro-construction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '\\newcommand{\\claimnew}[1]{\\begin{theorem}#1\\end{theorem}\\begin{proof}Done.\\end{proof}}',
    '\\renewcommand{\\claimrenew}[1]{\\begin{lemma}#1\\end{lemma}}',
    '\\providecommand{\\claimprovided}[1]{\\begin{proposition}#1\\end{proposition}}',
    '\\DeclareRobustCommand{\\claimrobust}[1]{\\begin{corollary}#1\\end{corollary}}',
    '\\long\\def\\claimdef#1{\\begin{theorem}#1\\end{theorem}}',
    '\\gdef\\claimgdef#1{\\lemma #1\\endlemma}',
    '\\edef\\claimedef#1{\\begin{proposition}#1\\end{proposition}}',
    '\\xdef\\claimxdef#1{\\begin{corollary}#1\\end{corollary}}',
    '\\claimnew{First generated claim.}',
    '\\claimnew{Second generated claim.}',
    '\\appendix',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'proof_status.md'), 'All obligations claimed closed.\n');
  fs.writeFileSync(path.join(root, 'evidence_manifest.md'), 'Evidence claims support.\n');
  const report = runTheoremManuscriptReadinessCheck({ workspacePath: root });
  assert.equal(report.passed, false);
  assert.equal(report.theoremStatementCount, 0);
  assert.equal(report.proofEnvironmentCount, 0);
  assert.equal(report.theoremEnvironmentMacroDefinitionCount, 8);
  assert.ok(report.blockers.includes('theorem_environment_macro_construction_unresolved'));
  assert.equal(report.theoremEnvironmentMacroConstructionBlockerCount, 8);
  assert.equal(report.theoremEnvironmentSyntaxBlockers.filter((item) => (
    item.code === 'theorem_environment_macro_construction_unsupported'
  )).length, 8);
});

test('theorem readiness rejects dynamically constructed theorem environments and include commands', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-dynamic-syntax-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '\\def\\claim#1{\\csname begin\\endcsname{theorem}#1\\csname end\\endcsname{theorem}}',
    '\\claim{Hidden claim.}',
    '\\subfile{hidden-claim}',
    '\\input\\claimfile',
    '\\begin{theorem}Visible claim.\\end{theorem}',
    '\\begin{proof}Visible proof.\\end{proof}',
    '\\appendix',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'hidden-claim.tex'), '\\begin{theorem}Subfile claim.\\end{theorem}\n');
  fs.writeFileSync(path.join(root, 'proof_status.md'), 'All obligations claimed closed.\n');
  fs.writeFileSync(path.join(root, 'evidence_manifest.md'), 'Evidence claims support.\n');
  const report = runTheoremManuscriptReadinessCheck({
    workspacePath: root,
    profile: 'formal_theorem_or_proof',
  });
  assert.equal(report.passed, false);
  assert.equal(report.theoremStatementCount, 1);
  assert.equal(report.proofEnvironmentCount, 1);
  assert.ok(report.blockers.includes('theorem_environment_declaration_unresolved'));
  assert.ok(report.blockers.includes('theorem_environment_macro_construction_unresolved'));
  assert.ok(report.theoremEnvironmentSyntaxBlockers.some((item) => (
    item.code === 'theorem_environment_dynamic_control_sequence_unsupported'
  )));
  assert.ok(report.theoremEnvironmentSyntaxBlockers.some((item) => (
    item.code === 'theorem_environment_include_command_unsupported'
  )));
  assert.ok(report.theoremEnvironmentSyntaxBlockers.some((item) => (
    item.code === 'theorem_environment_dynamic_include_unsupported'
  )));
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
