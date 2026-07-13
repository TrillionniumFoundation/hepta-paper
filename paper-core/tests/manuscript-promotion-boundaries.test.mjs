import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runPackageAdapter } from '../../paper-adapters/build-package/index.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { evaluateManuscriptPromotion } from '../../paper-domain/quality/manuscript-promotion-gate.mjs';
import { buildTargetScopeReceipt } from '../../paper-domain/automation/target-scope-policy.mjs';
import { buildSemanticPromotionLock } from '../../paper-domain/submission/semantic-promotion-lock.mjs';
import { formalAcademicPromotionBlockers } from '../../paper-adapters/research-verify/worker-runtime.mjs';
import { bindPaperTaskQualityProfile, createPaperActionManifest, createPaperTask, PAPER_ACTIONS } from '../../paper-domain/contracts/index.mjs';

function services() {
  return { artifactRepositoryFactory: () => ({
    async writeJson(target, value) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`); return {}; },
    async writeText(target, value) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return {}; },
  }) };
}

function fixture(t, manuscript, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-promotion-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.tex'), manuscript);
  fs.writeFileSync(path.join(source, 'existing.pdf'), '%PDF-1.4 fixture\n');
  for (const [name, value] of Object.entries(extraFiles)) fs.writeFileSync(path.join(source, name), value);
  fs.writeFileSync(path.join(source, 'SOURCE_PACKAGE_CONTRACT.json'), JSON.stringify({
    version: 1, kind: 'SourcePackageContract', paperId: 'paper',
    files: ['main.tex', 'existing.pdf', ...Object.keys(extraFiles)].map((file) => ({ path: file, role: file.endsWith('.pdf') ? 'compiled_pdf' : 'source_file', required: true })),
  }));
  const task = {
    paperId: 'paper', taskKey: 'paper:task', taskHash: 'sha256:task', title: 'Paper',
    sourceWorkspace: 'source', mainTex: 'source/main.tex', venueTarget: 'Venue', registry: {},
  };
  return { root, source, runtimeRoot: path.join(root, 'runtime'), task, row: { task, state: { compileStatus: 'compiled_pdf_present', blockers: [] }, artifacts: {} } };
}

test('package verifier failure is retained by final ArtifactPackage and submission manifest', async (t) => {
  const input = fixture(t, '\\documentclass{article}\\begin{document}x\\end{document}\n', { '.env': 'SECRET=fixture\n' });
  const pkg = await withArtifactWriteContext(services(), () => runPackageAdapter({ ...input, execute: true }));
  assert.equal(pkg.packageVerificationReceipt.status, 'package_verification_blocked');
  assert.equal(pkg.submitReady, false);
  assert.equal(pkg.artifactPackage.submitReady, false);
  assert.equal(pkg.artifactPackage.packageVerificationStatus, 'package_verification_blocked');
  const manifest = createPaperActionManifest({
    paperTask: input.task, action: PAPER_ACTIONS.REVIEWED_SUBMIT, mode: 'reviewed-submit',
    artifactPackage: pkg.artifactPackage, researchReport: { status: 'evidence_present' },
    venuePlan: { status: 'local_dry_run_ready' }, approvalPacket: { approved: true },
    promotionGate: { status: 'manuscript_promotion_ready' }, semanticPromotionLock: { status: 'semantic_promotion_unlocked' },
  });
  assert.equal(manifest.status, 'blocked_manifest');
  assert.ok(manifest.blockers.includes('artifact_package_not_submit_ready'));
});

test('standard package enforces theorem readiness outside Automation Plane', async (t) => {
  const input = fixture(t, [
    '\\documentclass{article}', '\\begin{document}', '\\begin{theorem}Open.\\end{theorem}',
    '\\begin{proof}Proof sketch. Still Open.\\end{proof}', '\\end{document}', '',
  ].join('\n'));
  const pkg = await withArtifactWriteContext(services(), () => runPackageAdapter({ ...input, execute: true }));
  assert.equal(pkg.packageVerificationReceipt.status, 'package_verification_passed');
  assert.equal(pkg.theoremReadiness.status, 'theorem_manuscript_readiness_blocked');
  assert.equal(pkg.manuscriptPromotionGate.status, 'manuscript_promotion_blocked');
  assert.equal(pkg.artifactPackage.submitReady, false);
});

test('evidence, experiment and formal blockers fail semantic promotion closed', () => {
  const task = { paperId: 'paper', taskKey: 'paper:task', taskHash: 'sha256:task', registry: {} };
  const researchReport = {
    researchReportHash: 'sha256:research',
    capabilities: {
      evidenceQualityGate: { status: 'evidence_quality_blocked', blockers: ['evidence_intake_not_verified'], evidenceQualityGateHash: 'sha256:evidence' },
      experimentRegistry: { status: 'experiment_registry_blocked', experiments: [{ experimentId: 'e' }], incompleteExperimentIds: ['e'], experimentRegistryHash: 'sha256:experiment' },
    },
    nativeResearchWorkerExecution: { workerReceipts: [{ workerId: 'formal', workerType: 'formal_verifier_lake', result: { status: 'formal_build_verified' } }] },
    typedContracts: {},
  };
  const promotionGate = evaluateManuscriptPromotion({ paperTask: task, researchReport, packageVerificationReceipt: { status: 'package_verification_passed', packageVerificationReceiptHash: 'sha256:verify' }, requireResearchQuality: true, requirePackageVerification: true, boundary: 'submission' });
  assert.equal(promotionGate.status, 'manuscript_promotion_blocked');
  assert.ok(promotionGate.blockers.includes('evidence_quality_gate_required_for_promotion'));
  assert.ok(promotionGate.blockers.includes('experiment_registry_required_for_promotion'));
  assert.ok(promotionGate.blockers.includes('formal_claim_binding_required:formal'));
  const scope = buildTargetScopeReceipt({ mode: 'reviewed-submit', execute: true, requestedPaperIds: ['paper'], selectedTasks: [task], inventorySource: 'hepta_sqlite', requireExplicitScope: true });
  const semantic = buildSemanticPromotionLock({ paperTask: task, targetScopeReceipt: scope, artifactPackage: { artifactPackageHash: 'sha256:package', submitReady: true, packageVerificationReceiptHash: 'sha256:verify' }, packageVerificationReceipt: { status: 'package_verification_passed', packageVerificationReceiptHash: 'sha256:verify' }, researchReport, promotionGate, venuePlan: { venueSubmissionPlanHash: 'sha256:venue' } });
  assert.equal(semantic.status, 'semantic_promotion_locked');
});

test('formal Lake build-only output is never academic promotion evidence', () => {
  const buildOnly = formalAcademicPromotionBlockers({ type: 'formal_verifier_lake', claimIds: ['c'], parameters: {} }, { status: 'formal_build_verified' });
  assert.ok(buildOnly.includes('formal_claim_bindings_required_for_academic_evidence'));
  assert.ok(buildOnly.includes('formal_claim_verification_required:formal_build_verified'));
  assert.deepEqual(formalAcademicPromotionBlockers({ type: 'formal_verifier_lake', claimIds: ['c'], parameters: { claimBindings: [{ claimId: 'c' }] } }, { status: 'formal_claim_verified' }), []);
  assert.ok(formalAcademicPromotionBlockers({ type: 'formal_verifier_lake', claimIds: ['c'], parameters: { claimBindings: [{ claimId: 'c' }], allowedAxioms: ['Classical.choice'] } }, { status: 'formal_claim_verified' })
    .includes('formal_caller_axiom_allowlist_forbidden:Classical.choice'));
});

test('caller-owned qualityEvidence cannot satisfy an enforced paper profile', () => {
  const task = {
    paperId: 'paper',
    paperQualityProfile: 'systems_or_artifact',
    registry: { qualityEvidence: [
      { requirementId: 'claim_registry', verified: true, hash: 'sha256:caller' },
      { requirementId: 'artifact_manifest', verified: true, hash: 'sha256:caller' },
      { requirementId: 'build_receipt', verified: true, hash: 'sha256:caller' },
      { requirementId: 'reproduction_receipt', verified: true, hash: 'sha256:caller' },
      { requirementId: 'limitations', verified: true, hash: 'sha256:caller' },
    ] },
  };
  const gate = evaluateManuscriptPromotion({ paperTask: task, requirePaperQuality: true, boundary: 'package' });
  assert.equal(gate.status, 'manuscript_promotion_blocked');
  assert.ok(gate.blockers.includes('paper_quality:paper_quality_evidence_missing_or_invalid:claim_registry'));
});

test('open referee research gaps remain a promotion and submission blocker', () => {
  const task = { paperId: 'paper', taskKey: 'paper:task', taskHash: 'sha256:task', registry: {} };
  const researchReport = {
    researchReportHash: 'sha256:research',
    capabilities: {
      evidenceQualityGate: { status: 'evidence_quality_ready', blockers: [], evidenceQualityGateHash: 'sha256:evidence' },
      experimentRegistry: { status: 'experiment_registry_ready', experiments: [], experimentRegistryHash: 'sha256:experiment' },
      researchGapPlan: { researchGapPlanHash: 'sha256:gaps', jobs: [{ jobId: 'gap-1', revisionRequestId: 'revision-1' }] },
      promotionInputSnapshot: { status: 'promotion_input_snapshot_frozen', researchGapPlanHash: 'sha256:gaps', promotionInputSnapshotHash: 'sha256:inputs' },
      researchGapClosureReceipt: { status: 'research_gap_closure_blocked', promotionInputSnapshotHash: 'sha256:inputs', researchGapClosureReceiptHash: 'sha256:closure' },
    },
    nativeResearchWorkerExecution: { workerReceipts: [] },
    typedContracts: {},
  };
  const promotionGate = evaluateManuscriptPromotion({ paperTask: task, researchReport, requireResearchQuality: true, boundary: 'submission' });
  assert.equal(promotionGate.status, 'manuscript_promotion_blocked');
  assert.ok(promotionGate.blockers.includes('promotion_gap_open:revision-1'));
  const scope = buildTargetScopeReceipt({ mode: 'reviewed-submit', execute: true, requestedPaperIds: ['paper'], selectedTasks: [task], inventorySource: 'hepta_sqlite', requireExplicitScope: true });
  const semantic = buildSemanticPromotionLock({
    paperTask: task,
    targetScopeReceipt: scope,
    artifactPackage: { artifactPackageHash: 'sha256:package', submitReady: true, packageVerificationReceiptHash: 'sha256:verify' },
    packageVerificationReceipt: { status: 'package_verification_passed', packageVerificationReceiptHash: 'sha256:verify' },
    researchReport,
    promotionGate,
    venuePlan: { venueSubmissionPlanHash: 'sha256:venue' },
  });
  assert.equal(semantic.status, 'semantic_promotion_locked');
  assert.ok(semantic.blockers.includes('semantic_lock_promotion_dependency_not_closed'));
});

test('target scope fails closed for missing requests and implicit truncated execution', () => {
  const missing = buildTargetScopeReceipt({ mode: 'reviewed-submit', execute: true, requestedPaperIds: ['missing'], selectedTasks: [], inventorySource: 'hepta_sqlite', requireExplicitScope: true });
  assert.equal(missing.status, 'target_scope_blocked');
  assert.ok(missing.blockers.includes('target_scope_requested_paper_missing:missing'));
  const truncated = buildTargetScopeReceipt({ mode: 'reviewed-submit', execute: true, selectedTasks: [{ paperId: 'p' }], inventorySource: 'hepta_sqlite', limit: 1, requireExplicitScope: true });
  assert.ok(truncated.blockers.includes('target_scope_limit_truncation_requires_explicit_ids'));
});

test('quality profile changes PaperTask and TargetScope semantic identity', () => {
  const base = createPaperTask({ paperId: 'paper', sourceWorkspace: 'source', mainTex: 'source/main.tex', createdAt: '2026-01-01T00:00:00.000Z' });
  const theorem = bindPaperTaskQualityProfile(base, 'theorem_or_proof');
  const empirical = bindPaperTaskQualityProfile(base, 'empirical_or_experiment');
  assert.notEqual(theorem.taskHash, empirical.taskHash);
  const theoremScope = buildTargetScopeReceipt({ mode: 'local-package', execute: true, requestedPaperIds: ['paper'], selectedTasks: [theorem], inventorySource: 'hepta_sqlite', requireExplicitScope: true });
  const empiricalScope = buildTargetScopeReceipt({ mode: 'local-package', execute: true, requestedPaperIds: ['paper'], selectedTasks: [empirical], inventorySource: 'hepta_sqlite', requireExplicitScope: true });
  assert.notEqual(theoremScope.targetScopeHash, empiricalScope.targetScopeHash);
});
