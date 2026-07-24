import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runPackageAdapter } from '../../paper-adapters/build-package/index.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { evaluateManuscriptPromotion } from '../../paper-domain/quality/manuscript-promotion-gate.mjs';
import { verifyExperimentRegistry } from '../../paper-domain/research/experiment-registry-verifier.mjs';
import { buildTargetScopeReceipt } from '../../paper-domain/automation/target-scope-policy.mjs';
import { buildSemanticPromotionLock } from '../../paper-domain/submission/semantic-promotion-lock.mjs';
import { bindFormalReviewsToWorkers, formalAcademicPromotionBlockers } from '../../paper-adapters/research-verify/worker-runtime.mjs';
import { buildFormalClaimContract } from '../../paper-domain/research/formal-claim-contract.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
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

test('a rehashed synthetic registry cannot self-declare academic eligibility', () => {
  const raw = (name, suffix) => ({
    name,
    path: `${name}.ndjson`,
    hash: `sha256:${suffix.repeat(64)}`,
    role: `campaign-experiment-raw-events:paper:campaign:node:attempt:${name}`,
    bytes: 64,
    artifactWriteReceiptHash: `sha256:${(name === 'raw-events-original' ? 'c' : 'd').repeat(64)}`,
    ledgerReceiptId: `ledger:${name}`,
  });
  const evidencePayload = {
    version: 3,
    kind: 'CampaignExperimentEvidenceBinding',
    status: 'experiment_evidence_binding_verified',
    experimentId: 'synthetic-fixture',
    outputArtifacts: [raw('raw-events-original', 'a'), raw('raw-events-independent-replay', 'b')],
    trustedLedgerReceiptsVerified: true,
    rawArtifactSourcesVerified: true,
    rawArtifactLedgerReceiptsVerified: true,
    assuranceScope: 'synthetic-conformance-only-not-academic-promotion-v1',
    evidenceClass: 'software-conformance-evidence',
    promotionScope: 'software-conformance-only',
    academicPromotionEligible: false,
    blockers: [],
  };
  const evidenceBinding = {
    ...evidencePayload,
    experimentEvidenceBindingHash: hashRecord('CampaignExperimentEvidenceBinding', evidencePayload),
  };
  const acceptancePayload = {
    version: 1,
    kind: 'ExperimentAcceptancePolicyReport',
    experimentId: 'synthetic-fixture',
    status: 'experiment_result_recorded_non_promotable',
    experimentEvidenceBindingHash: evidenceBinding.experimentEvidenceBindingHash,
    blockers: [],
  };
  const experiment = {
    experimentId: 'synthetic-fixture',
    status: 'experiment_reproducible',
    missing: [],
    academicPromotionEligible: false,
    assuranceScope: 'synthetic-conformance-only-not-academic-promotion-v1',
    evidenceClass: 'software-conformance-evidence',
    promotionScope: 'software-conformance-only',
    evidenceBinding,
    acceptancePolicy: {
      ...acceptancePayload,
      experimentAcceptancePolicyHash: hashRecord('ExperimentAcceptancePolicyReport', acceptancePayload),
    },
  };
  const registryPayload = {
    version: 4,
    kind: 'ExperimentRegistry',
    paperId: 'paper',
    status: 'experiment_registry_ready',
    experiments: [experiment],
    incompleteExperimentIds: [],
    academicExperimentCount: 1,
    conformanceExperimentCount: 1,
    academicPromotionEligibleExperimentIds: ['synthetic-fixture'],
    conformanceExperimentIds: ['synthetic-fixture'],
  };
  const registry = {
    ...registryPayload,
    experimentRegistryHash: hashRecord('ExperimentRegistry', registryPayload),
  };
  const verification = verifyExperimentRegistry(registry, { expectedPaperId: 'paper' });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('experiment_registry_academic_count_mismatch'));
  assert.ok(verification.blockers.includes('experiment_registry_academic_ids_mismatch'));
  const gate = evaluateManuscriptPromotion({
    paperTask: { paperId: 'paper', paperQualityProfile: 'empirical_or_experiment', registry: {} },
    profile: 'empirical_or_experiment',
    researchReport: { capabilities: { experimentRegistry: registry }, typedContracts: {} },
  });
  assert.equal(gate.status, 'manuscript_promotion_blocked');
  assert.ok(gate.blockers.includes('experiment_registry_semantics_invalid'));
});

test('a fully fabricated and rehashed academic registry has no evidence authority', () => {
  const raw = (name, suffix, receiptSuffix) => ({
    name,
    path: `${name}.ndjson`,
    hash: `sha256:${suffix.repeat(64)}`,
    role: `campaign-experiment-raw-events:paper:campaign:node:attempt:${name === 'raw-events-original' ? 'original' : 'independent-replay'}`,
    bytes: 64,
    artifactWriteReceiptHash: `sha256:${receiptSuffix.repeat(64)}`,
    ledgerReceiptId: `fabricated:${name}`,
  });
  const evidencePayload = {
    version: 3,
    kind: 'CampaignExperimentEvidenceBinding',
    status: 'experiment_evidence_binding_verified',
    experimentId: 'fabricated-academic',
    experimentRunReceiptHash: `sha256:${'1'.repeat(64)}`,
    experimentReplayReceiptHash: `sha256:${'2'.repeat(64)}`,
    workerReceiptHash: `sha256:${'3'.repeat(64)}`,
    replayWorkerReceiptHash: `sha256:${'4'.repeat(64)}`,
    reproducibilityLedgerReceiptHash: `sha256:${'5'.repeat(64)}`,
    originalCampaignNodeResultHash: `sha256:${'6'.repeat(64)}`,
    replayCampaignNodeResultHash: `sha256:${'7'.repeat(64)}`,
    sourceLineageHash: `sha256:${'8'.repeat(64)}`,
    outputArtifacts: [
      raw('raw-events-original', 'a', 'c'),
      raw('raw-events-independent-replay', 'b', 'd'),
    ],
    trustedLedgerReceiptsVerified: true,
    rawArtifactSourcesVerified: true,
    rawArtifactLedgerReceiptsVerified: true,
    executionAssuranceProfile: 'operator-hidden-evaluation-v1',
    assuranceProfile: 'system-harness-store-cas-source-plus-trusted-ledger-v3',
    assuranceScope: 'operator-authorized-hidden-evaluation-v1',
    evidenceClass: 'academic-experiment-evidence',
    promotionScope: 'academic-research-promotion',
    academicPromotionEligible: true,
    authorityEvidence: {
      version: 1,
      kind: 'CampaignExperimentEvidenceAuthorityEvidence',
      paperId: 'paper',
      campaignId: 'campaign',
    },
    blockers: [],
  };
  const evidenceBinding = {
    ...evidencePayload,
    experimentEvidenceBindingHash: hashRecord('CampaignExperimentEvidenceBinding', evidencePayload),
  };
  const acceptancePayload = {
    version: 1,
    kind: 'ExperimentAcceptancePolicyReport',
    experimentId: 'fabricated-academic',
    status: 'experiment_result_recorded_non_promotable',
    experimentEvidenceBindingHash: evidenceBinding.experimentEvidenceBindingHash,
    blockers: [],
  };
  const experiment = {
    experimentId: 'fabricated-academic',
    status: 'experiment_reproducible',
    missing: [],
    academicPromotionEligible: true,
    assuranceProfile: 'operator-hidden-evaluation-v1',
    assuranceScope: 'operator-authorized-hidden-evaluation-v1',
    evidenceClass: 'academic-experiment-evidence',
    promotionScope: 'academic-research-promotion',
    evidenceBinding,
    acceptancePolicy: {
      ...acceptancePayload,
      experimentAcceptancePolicyHash: hashRecord('ExperimentAcceptancePolicyReport', acceptancePayload),
    },
  };
  const registryPayload = {
    version: 4,
    kind: 'ExperimentRegistry',
    paperId: 'paper',
    status: 'experiment_registry_ready',
    experiments: [experiment],
    incompleteExperimentIds: [],
    academicExperimentCount: 1,
    conformanceExperimentCount: 0,
    academicPromotionEligibleExperimentIds: ['fabricated-academic'],
    conformanceExperimentIds: [],
  };
  const registry = { ...registryPayload, experimentRegistryHash: hashRecord('ExperimentRegistry', registryPayload) };
  const verification = verifyExperimentRegistry(registry, {
    expectedPaperId: 'paper',
    expectedCampaignId: 'campaign',
  });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('experiment_registry_academic_authority_required'));
  assert.ok(verification.blockers.includes('experiment_registry_academic_count_mismatch'));
  assert.ok(verification.blockers.includes('experiment_registry_academic_ids_mismatch'));
});

test('formal Lake build-only output is never academic promotion evidence', () => {
  const buildOnly = formalAcademicPromotionBlockers({ type: 'formal_verifier_lake', claimIds: ['c'], parameters: {} }, { status: 'formal_build_verified' });
  assert.ok(buildOnly.includes('formal_claim_bindings_required_for_academic_evidence'));
  assert.ok(buildOnly.includes('formal_claim_verification_required:formal_build_verified'));
  const formalClaimContract = buildFormalClaimContract({
    claimId: 'c', claimText: 'Claim c.', sourceLocator: 'paper.tex#c', theoremName: 'cTheorem',
    theoremTypeHash: 'sha256:type', sourceStatementHash: 'sha256:statement', proofObligations: ['cTheorem'],
    manuscriptSourceIdentity: {
      path: 'paper.tex', byteStart: 0, byteEnd: 8,
      contentHash: 'sha256:claim', fileHash: 'sha256:manuscript',
    },
    semanticReview: {
      status: 'formal_semantic_review_verified', reviewerId: 'reviewer', authorId: 'author',
      semanticEquivalenceVerified: true, reviewReceiptHash: hashRecord('FormalSemanticReviewReceipt', { claimId: 'c' }),
      reviewEnvelopeHash: 'sha256:envelope', reviewNodeId: 'formal-review', reviewAttemptId: 'attempt-1',
      reviewAgentReceiptHash: 'sha256:review-agent', authorNodeId: 'formal-author',
      authorAgentReceiptHash: 'sha256:author-agent', reviewedManuscriptHash: 'sha256:manuscript',
      reviewedWorkerPlanHash: 'sha256:worker-plan',
    },
  });
  const validBinding = { claimId: 'c', theoremName: 'cTheorem', expectedTypeHash: 'sha256:type', sourceStatementHash: 'sha256:statement', proofObligations: ['cTheorem'], manuscriptClaimHash: formalClaimContract.manuscriptClaimHash, formalClaimContract };
  const replayed = {
    status: 'formal_claim_verified',
    replayReceipt: { status: 'formal_claim_replay_verified' },
    formalCertificateReplayReceiptHash: 'sha256:replay',
  };
  assert.deepEqual(formalAcademicPromotionBlockers({ type: 'formal_verifier_lake', claimIds: ['c'], parameters: { claimBindings: [validBinding] } }, replayed), []);
  assert.ok(formalAcademicPromotionBlockers({ type: 'formal_verifier_lake', claimIds: ['c'], parameters: { claimBindings: [{ claimId: 'c' }] } }, { status: 'formal_claim_verified' })
    .some((item) => item.includes('formal_claim_contract')));
  assert.ok(formalAcademicPromotionBlockers({ type: 'formal_verifier_lake', claimIds: ['c'], parameters: { claimBindings: [{ claimId: 'c' }], allowedAxioms: ['Classical.choice'] } }, { status: 'formal_claim_verified' })
    .includes('formal_caller_axiom_allowlist_forbidden:Classical.choice'));
});

test('independent formal review is assembled from a canonical manuscript range and execution-bound envelope', () => {
  const binding = { claimId: 'c', theoremName: 'cTheorem', expectedTypeHash: 'sha256:type', sourceStatementHash: 'sha256:statement', proofObligations: ['cTheorem'] };
  const worker = { type: 'formal_verifier_lake', claimIds: ['c'], parameters: { claimBindings: [binding] } };
  const canonicalClaim = {
    claimId: 'c', text: 'Claim c.', sourceLocator: 'paper.tex#bytes=0-8', manuscriptPath: 'paper.tex',
    manuscriptByteStart: 0, manuscriptByteEnd: 8, manuscriptContentHash: 'sha256:claim',
    manuscriptFileHash: 'sha256:manuscript', manuscriptClaimHash: hashRecord('unused', {}),
  };
  const envelopePayload = {
    version: 1, kind: 'FormalClaimSemanticReviewEnvelope', status: 'formal_semantic_review_envelope_verified',
    paperId: 'paper', manuscriptHash: 'sha256:manuscript', workerPlanHash: 'sha256:worker-plan',
    formalClaimUniverseHash: 'sha256:claim-universe', canonicalClaimRegistryHash: 'sha256:claim-registry',
    reviewNodeId: 'formal-review', reviewAttemptId: 'attempt-1', reviewAgentReceiptHash: 'sha256:review-agent',
    authorNodeId: 'formal-author', authorAgentReceiptHash: 'sha256:author-agent',
    reviewerPrincipalId: 'principal:reviewer', authorPrincipalId: 'principal:author',
    reviewerIndependenceAssuranceScope: 'configured_principal_and_process_separation',
    providerAccountIndependenceVerified: false,
    reviews: [{
      claimId: 'c', theoremName: 'cTheorem', theoremTypeHash: 'sha256:type',
      sourceStatementHash: 'sha256:statement', manuscriptClaimHash: canonicalClaim.manuscriptClaimHash,
      status: 'formal_semantic_review_verified', semanticEquivalenceVerified: true, verdict: 'equivalent',
    }],
    externalActionPerformed: false,
  };
  const envelope = {
    ...envelopePayload,
    formalSemanticReviewEnvelopeHash: hashPaperRecord('FormalClaimSemanticReviewEnvelope', envelopePayload),
  };
  const canonicalClaimRegistry = {
    manuscriptHash: 'sha256:manuscript', formalClaimUniverseHash: 'sha256:claim-universe',
    canonicalClaimRegistryHash: 'sha256:claim-registry', byClaimId: new Map([['c', canonicalClaim]]),
  };
  const boundResult = bindFormalReviewsToWorkers({
    workers: [worker], formalReviewEnvelope: envelope, paperId: 'paper', canonicalClaimRegistry,
    workerPlanHash: 'sha256:worker-plan',
  });
  assert.deepEqual(boundResult.blockers, []);
  const [bound] = boundResult.workers;
  assert.equal(bound.parameters.claimBindings[0].formalClaimContract.status, 'formal_claim_contract_verified');
  assert.deepEqual(formalAcademicPromotionBlockers(bound, {
    status: 'formal_claim_verified', replayReceipt: { status: 'formal_claim_replay_verified' },
    formalCertificateReplayReceiptHash: 'sha256:replay',
  }), []);
  const wrongPaper = bindFormalReviewsToWorkers({
    workers: [worker], formalReviewEnvelope: envelope, paperId: 'other-paper', canonicalClaimRegistry,
    workerPlanHash: 'sha256:worker-plan',
  });
  assert.ok(wrongPaper.blockers.includes('formal_semantic_review_envelope_paper_mismatch'));
  assert.equal(wrongPaper.workers[0].parameters.claimBindings[0].formalClaimContract, undefined);

  const signedPayload = {
    ...envelopePayload,
    reviewerIndependenceAssuranceScope:
      'signed_configured_identity_credential_root_and_signer_separation',
    providerAccountIndependenceVerified: false,
    reviewPrincipalDescriptorHash: hashRecord('ReviewPrincipalDescriptor', { id: 'reviewer' }),
    reviewerProviderAccountIdentityHash: hashRecord('ReviewerProviderAccount', { id: 'reviewer' }),
    reviewerCredentialRootIdentityHash: hashRecord('ReviewerCredentialRoot', { id: 'reviewer' }),
    reviewerTrustDomainIdentityHash: hashRecord('ReviewerTrustDomain', { id: 'reviewer' }),
    researchPrincipalPoolHash: hashRecord('ResearchPrincipalPool', { id: 'pool' }),
    signedReviewerReceiptHash: hashRecord('SignedReviewerReceipt', { id: 'reviewer' }),
  };
  const signedEnvelope = {
    ...signedPayload,
    formalSemanticReviewEnvelopeHash:
      hashPaperRecord('FormalClaimSemanticReviewEnvelope', signedPayload),
  };
  const signedBound = bindFormalReviewsToWorkers({
    workers: [worker],
    formalReviewEnvelope: signedEnvelope,
    paperId: 'paper',
    canonicalClaimRegistry,
    workerPlanHash: 'sha256:worker-plan',
  });
  assert.deepEqual(signedBound.blockers, []);
  const incompleteSignedPayload = { ...signedPayload, reviewerTrustDomainIdentityHash: null };
  const incompleteSignedEnvelope = {
    ...incompleteSignedPayload,
    formalSemanticReviewEnvelopeHash:
      hashPaperRecord('FormalClaimSemanticReviewEnvelope', incompleteSignedPayload),
  };
  const incompleteSigned = bindFormalReviewsToWorkers({
    workers: [worker],
    formalReviewEnvelope: incompleteSignedEnvelope,
    paperId: 'paper',
    canonicalClaimRegistry,
    workerPlanHash: 'sha256:worker-plan',
  });
  assert.ok(incompleteSigned.blockers.includes(
    'formal_semantic_review_envelope_assurance_scope_invalid',
  ));
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
