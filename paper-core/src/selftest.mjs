import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PAPER_ACTIONS,
  PAPER_PRODUCT_PROFILE,
  createPaperActionManifest,
  buildPaperHandoffEnvelope,
  buildPaperAdapterRunReceipt,
} from './paper-contracts.mjs';
import { discoverInventory } from '../../paper-adapters/inventory/index.mjs';
import { runPaperBatch } from './paper-batch-runner.mjs';
import { runPaperProposalAdapter } from '../../paper-adapters/proposal/index.mjs';
import { runEmpiricalAnalysisAdapter } from '../../paper-adapters/empirical-analysis/index.mjs';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import {
  runLatexBuildAdapter,
  runPackageAdapter,
} from '../../paper-adapters/build-package/index.mjs';
import { buildSubmissionLifecycle } from '../../paper-adapters/submission/index.mjs';
import {
  buildJournalConferenceRegistry,
  buildTargetSelectionPolicy,
} from '../../paper-adapters/journal-manage/index.mjs';
import {
  defaultLegacyPaperFactoryRoot,
  defaultPaperAssetRoot,
} from './workspace-layout.mjs';
import { bootstrapPaperExecutionContext } from '../../paper-application/bootstrap/service-bootstrap.mjs';
import { enterArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const paperFactoryRoot = defaultPaperAssetRoot();
const legacyPaperFactoryRoot = defaultLegacyPaperFactoryRoot();

async function sourceText(file) {
  return fs.readFile(path.join(workspaceRoot, file), 'utf8');
}

async function assertNoOldControlPlaneImports() {
  const files = [
    'paper-core/src/paper-contracts.mjs',
    'paper-core/src/paper-batch-runner.mjs',
    'paper-adapters/inventory/index.mjs',
    'paper-adapters/build-package/index.mjs',
    'paper-adapters/research-verify/index.mjs',
    'paper-adapters/referee-review/index.mjs',
    'paper-adapters/referee-revise/index.mjs',
    'paper-adapters/venue-resolve/index.mjs',
    'paper-adapters/source-adapt/index.mjs',
    'paper-adapters/submission/index.mjs',
    'paper-adapters/legacy-cleanup/index.mjs',
    'paper-adapters/proposal/index.mjs',
    'paper-adapters/journal-manage/index.mjs',
  ];
  for (const file of files) {
    const text = await sourceText(file);
    assert.equal(/from ['"].*(paperctl_modules|bin\/paperctl)/.test(text), false, `${file} imports old control plane`);
  }
}

async function main() {
  const selftestContext = bootstrapPaperExecutionContext({
    root: paperFactoryRoot,
    runtimeRoot: path.join(workspaceRoot, 'runtime', 'selftest'),
    mode: 'selftest',
    execute: true,
  });
  enterArtifactWriteContext(selftestContext.services);
  assert.equal(PAPER_PRODUCT_PROFILE.safety.importsOldControlPlane, false);
  await assertNoOldControlPlaneImports();

  const inventory = await discoverInventory({ root: paperFactoryRoot, limit: 3 });
  assert.ok(inventory.rows.length > 0, 'inventory should discover paper rows');
  assert.ok(inventory.rows[0].task.kind === 'PaperTask');
  assert.ok(inventory.rows[0].state.kind === 'PaperWorkflowState');

  const manifest = createPaperActionManifest({
    paperTask: inventory.rows[0].task,
    action: PAPER_ACTIONS.VENUE_DRY_RUN,
  });
  const handoff = buildPaperHandoffEnvelope({ manifest });
  const receipt = buildPaperAdapterRunReceipt({ envelope: handoff, manifest });
  assert.equal(receipt.externalActionPerformed, false);

  const proposalReport = await runPaperProposalAdapter({
    root: paperFactoryRoot,
    idea: 'A distributionally robust reinforcement learning theorem for stochastic control',
    discipline: 'machine learning',
    venue: 'NeurIPS',
    title: 'Distributionally Robust RL for Stochastic Control',
    materials: ['existing theorem sketch', 'simulation plan'],
  });
  assert.equal(proposalReport.kind, 'PaperProposalAdapterReport');
  assert.equal(proposalReport.safety.modelCallPerformed, false);
  assert.equal(proposalReport.safety.sourceMutation, false);
  assert.equal(proposalReport.safety.externalActionPerformed, false);
  assert.equal(proposalReport.ideaBrief.kind, 'PaperIdeaBrief');
  assert.equal(proposalReport.generationManifest.kind, 'PaperProposalGenerationManifest');
  assert.equal(proposalReport.proposalEnvelope.kind, 'PaperProposalEnvelope');
  assert.equal(proposalReport.generationReceipt.kind, 'PaperProposalGenerationReceipt');
  assert.equal(proposalReport.reviewGate.kind, 'PaperProposalReviewGate');
  assert.equal(proposalReport.productionPlanEnvelope.kind, 'PaperProductionPlanEnvelope');
  assert.equal(proposalReport.journalConferenceRegistry.kind, 'JournalConferenceRegistry');
  assert.equal(proposalReport.journalConferenceRegistry.status, 'journal_conference_registry_ready');
  assert.equal(proposalReport.targetSelectionPolicy.kind, 'TargetSelectionPolicy');
  assert.equal(proposalReport.targetSelectionPolicy.status, 'target_selection_policy_ready');
  assert.equal(proposalReport.targetJournalProfile.kind, 'JournalTargetProfile');
  assert.equal(proposalReport.targetJournalProfile.status, 'journal_target_profile_ready');
  assert.equal(proposalReport.journalRubricPacket.kind, 'JournalRubricPacket');
  assert.equal(proposalReport.journalRubricPacket.status, 'journal_rubric_packet_ready');
  assert.equal(proposalReport.venueRubricManager.kind, 'VenueRubricManager');
  assert.equal(proposalReport.venueRubricManager.status, 'venue_rubric_manager_ready');
  assert.equal(proposalReport.reviewGate.approved, false);
  assert.ok(proposalReport.reviewGate.blockers.includes('explicit_proposal_approval_required'));

  const autoVenueProposalReport = await runPaperProposalAdapter({
    root: paperFactoryRoot,
    idea: 'A learned database query optimizer for cloud analytics',
    discipline: 'database systems',
    title: 'Learned Query Optimization for Cloud Analytics',
  });
  assert.equal(autoVenueProposalReport.targetSelectionPolicy.kind, 'TargetSelectionPolicy');
  assert.equal(autoVenueProposalReport.targetSelectionPolicy.status, 'target_selection_policy_ready');
  assert.equal(autoVenueProposalReport.targetSelectionPolicy.selectionMode, 'agent_auto_selected_from_idea');
  assert.equal(autoVenueProposalReport.targetSelectionPolicy.autoSelected, true);
  assert.ok(['sigmod', 'vldb'].includes(autoVenueProposalReport.targetSelectionPolicy.primaryTarget.journalId));
  assert.ok(autoVenueProposalReport.targetSelectionPolicy.backupTargets.length > 0);
  assert.equal(autoVenueProposalReport.targetJournalProfile.kind, 'JournalTargetProfile');
  assert.equal(autoVenueProposalReport.journalConferenceRegistry.profileCount >= 40, true);
  assert.equal(autoVenueProposalReport.journalConferenceRegistry.profileIds.includes('aaai'), false);
  assert.equal(autoVenueProposalReport.journalConferenceRegistry.profileIds.includes('ijcai'), false);

  const deadlineRegistry = buildJournalConferenceRegistry({ createdAt: '2026-07-09T00:00:00.000Z' });
  const farConferencePolicy = buildTargetSelectionPolicy({
    hints: ['computer vision video segmentation benchmark'],
    registry: deadlineRegistry,
    createdAt: '2026-07-09T00:00:00.000Z',
  });
  assert.equal(farConferencePolicy.preDeadlinePrimaryTarget.journalId, 'cvpr');
  assert.equal(farConferencePolicy.primaryTarget.journalId, 'tpami');
  assert.equal(farConferencePolicy.primaryTarget.kind, 'journal');
  assert.equal(
    farConferencePolicy.agentDeadlineRoutingDecision.status,
    'conference_deadline_too_far_rerouted_to_journal',
  );
  assert.equal(farConferencePolicy.safety.regexDeadlineRouting, false);

  const nearConferencePolicy = buildTargetSelectionPolicy({
    hints: ['representation learning generative model deep learning'],
    registry: deadlineRegistry,
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(nearConferencePolicy.primaryTarget.journalId, 'iclr');
  assert.equal(nearConferencePolicy.primaryTarget.kind, 'conference');
  assert.equal(
    nearConferencePolicy.agentDeadlineRoutingDecision.status,
    'conference_deadline_within_agent_window',
  );

  const explicitConferencePolicy = buildTargetSelectionPolicy({
    target: 'NeurIPS',
    hints: ['machine learning reinforcement learning'],
    registry: deadlineRegistry,
    createdAt: '2026-07-09T00:00:00.000Z',
  });
  assert.equal(explicitConferencePolicy.primaryTarget.journalId, 'neurips');
  assert.equal(
    explicitConferencePolicy.agentDeadlineRoutingDecision.status,
    'explicit_target_preserved_deadline_risk_recorded',
  );

  const autoEconProposalReport = await runPaperProposalAdapter({
    root: paperFactoryRoot,
    idea: 'A market design and political economy model of platform contracting',
    discipline: 'economics',
    title: 'Platform Contracting and Market Design',
  });
  assert.equal(autoEconProposalReport.targetSelectionPolicy.selectionMode, 'agent_auto_selected_from_idea');
  assert.ok(['aer', 'qje', 'jpe', 'econometrica', 'restud'].includes(
    autoEconProposalReport.targetSelectionPolicy.primaryTarget.journalId,
  ));

  const autoFinanceProposalReport = await runPaperProposalAdapter({
    root: paperFactoryRoot,
    idea: 'An asset pricing anomaly with corporate finance and market microstructure evidence',
    discipline: 'finance',
    title: 'Asset Pricing and Market Microstructure Evidence',
  });
  assert.equal(autoFinanceProposalReport.targetSelectionPolicy.selectionMode, 'agent_auto_selected_from_idea');
  assert.ok(['journal_finance', 'jfe', 'rfs'].includes(
    autoFinanceProposalReport.targetSelectionPolicy.primaryTarget.journalId,
  ));
  assert.equal(autoFinanceProposalReport.journalConferenceRegistry.profileIds.includes('jfqa'), false);
  [
    'accounting_review',
    'jae',
    'jar',
    'journal_finance',
    'jfe',
    'rfs',
    'isr',
    'informs_joc',
    'misq',
    'jcr',
    'journal_marketing',
    'jmr',
    'marketing_science',
    'management_science',
    'operations_research',
    'msom',
    'organization_science',
    'smj',
    'amj',
    'amr',
    'asq',
    'jibs',
    'jom',
    'pom',
  ].forEach((journalId) => {
    assert.equal(autoFinanceProposalReport.journalConferenceRegistry.profileIds.includes(journalId), true);
  });

  const autoMathProposalReport = await runPaperProposalAdapter({
    root: paperFactoryRoot,
    idea: 'A new theorem in algebraic geometry and number theory',
    discipline: 'mathematics',
    title: 'A Theorem in Algebraic Geometry',
  });
  assert.equal(autoMathProposalReport.targetSelectionPolicy.selectionMode, 'agent_auto_selected_from_idea');
  assert.ok(['annals_math', 'inventiones', 'acta_math', 'jams'].includes(
    autoMathProposalReport.targetSelectionPolicy.primaryTarget.journalId,
  ));
  ['annals_math', 'inventiones', 'acta_math', 'jams'].forEach((journalId) => {
    assert.equal(autoMathProposalReport.journalConferenceRegistry.profileIds.includes(journalId), true);
  });

  const approvedProposalReport = await runPaperProposalAdapter({
    root: paperFactoryRoot,
    runtimeRoot: path.join(workspaceRoot, 'runtime', 'selftest'),
    idea: 'A distributionally robust reinforcement learning theorem for stochastic control',
    discipline: 'machine learning',
    venue: 'NeurIPS',
    title: 'Distributionally Robust RL for Stochastic Control',
    approved: true,
    materializeSource: true,
  });
  assert.equal(approvedProposalReport.reviewGate.approved, true);
  assert.equal(approvedProposalReport.materialization?.kind, 'PaperProposalMaterialization');
  assert.equal(approvedProposalReport.materialization?.manuscriptSourceContract?.kind, 'ManuscriptSourceContract');
  assert.equal(approvedProposalReport.materialization?.paperTask?.kind, 'PaperTask');
  assert.equal(approvedProposalReport.materialization?.paperTaskCreationEnvelope?.status, 'paper_task_draft_ready');
  assert.equal(approvedProposalReport.materialization?.seedContractBundle?.kind, 'PaperProposalSeedContractBundle');
  assert.equal(approvedProposalReport.materialization?.seedContractRecord?.role, 'proposal_seed_contracts');
  assert.ok(approvedProposalReport.materialization?.records.some((record) => record.role === 'journal_conference_registry'));
  assert.ok(approvedProposalReport.materialization?.records.some((record) => record.role === 'target_selection_policy'));
  assert.ok(approvedProposalReport.materialization?.records.some((record) => record.role === 'journal_target_profile'));
  assert.ok(approvedProposalReport.materialization?.records.some((record) => record.role === 'journal_rubric_packet'));
  assert.ok(approvedProposalReport.materialization?.records.some((record) => record.role === 'venue_rubric_manager'));
  assert.equal(approvedProposalReport.materialization?.safety.journalConferenceRegistryWritten, true);
  assert.equal(approvedProposalReport.materialization?.safety.targetSelectionPolicyWritten, true);
  assert.equal(approvedProposalReport.materialization?.safety.journalProfileWritten, true);
  assert.equal(approvedProposalReport.materialization?.safety.journalRubricWritten, true);
  assert.equal(approvedProposalReport.materialization?.safety.venueRubricManagerWritten, true);
  assert.equal(approvedProposalReport.materialization?.safety.writesRegistry, false);
  assert.equal(approvedProposalReport.materialization?.safety.externalActionPerformed, false);

  const stagedPaperId = 'selftest_proposal_staging';
  const stagedRuntimeRoot = path.join(workspaceRoot, 'runtime', 'selftest');
  const stagedProposalReport = await runPaperProposalAdapter({
    root: paperFactoryRoot,
    runtimeRoot: stagedRuntimeRoot,
    paperId: stagedPaperId,
    idea: 'A staged proposal inventory bridge for paper production',
    discipline: 'machine learning',
    venue: 'NeurIPS',
    title: 'Selftest Proposal Staging',
    approved: true,
    materializeSource: true,
    stageInventory: true,
  });
  assert.equal(stagedProposalReport.inventoryStaging?.kind, 'PaperProposalInventoryStaging');
  assert.equal(stagedProposalReport.inventoryStaging?.status, 'proposal_inventory_staged');
  assert.equal(stagedProposalReport.safety.createsInventoryStaging, true);
  assert.equal(stagedProposalReport.safety.createsProposalSeedContracts, true);
  const stagedInventory = await discoverInventory({
    root: paperFactoryRoot,
    includeLooseDrafts: false,
    paperIds: [stagedPaperId],
    proposalStagingRoot: path.join(stagedRuntimeRoot, 'proposal-staging'),
  });
  assert.equal(stagedInventory.rows.length, 1);
  assert.equal(stagedInventory.rows[0].task.kind, 'PaperTask');
  assert.equal(stagedInventory.rows[0].task.registry.inventorySource, 'proposal_staging');
  assert.equal(stagedInventory.rows[0].task.sourceWorkspace.includes('runtime/selftest/proposals'), true);
  assert.equal(stagedInventory.rows[0].state.compileStatus, 'build_ready');
  assert.equal(stagedInventory.rows[0].state.researchVerifyStatus, 'proposal_seed_present');
  assert.equal(stagedInventory.summary.proposalStaged, 1);
  const stagedResearchReport = await runResearchVerifyAdapter({
    root: paperFactoryRoot,
    row: stagedInventory.rows[0],
  });
  assert.equal(stagedResearchReport.status, 'proposal_seed_present');
  assert.ok(stagedResearchReport.proposalSeedEvidenceCount > 0);
  assert.ok(stagedResearchReport.claimCount > 0);
  assert.ok(stagedResearchReport.proofObligationCount > 0);
  assert.ok(stagedResearchReport.evidenceItemCount > 0);
  assert.ok(stagedResearchReport.reproducibilityItemCount > 0);
  assert.ok(stagedResearchReport.warnings.includes('proposal_seed_contracts_require_real_evidence_followup'));
  const authorizedDatasetRoot = path.join(stagedRuntimeRoot, 'authorized-datasets', stagedPaperId);
  await fs.mkdir(authorizedDatasetRoot, { recursive: true });
  await fs.writeFile(path.join(authorizedDatasetRoot, 'BENCHMARK_REGISTRY.json'), JSON.stringify({
    kind: 'BenchmarkRegistryManifest',
    benchmarkId: 'selftest_authorized_rl_dataset',
    label: 'Selftest authorized local RL benchmark',
    task: 'local empirical-analysis smoke for staged proposals',
  }, null, 2) + '\n', 'utf8');
  await fs.writeFile(path.join(authorizedDatasetRoot, 'control_returns.csv'), [
    'episode,disturbance,return,violation',
    '1,0.10,-0.82,0.00',
    '2,0.25,-1.15,0.02',
    '3,0.40,-1.58,0.04',
    '4,0.70,-2.31,0.08',
    '',
  ].join('\n'), 'utf8');
  const stagedMainTexPath = path.isAbsolute(stagedInventory.rows[0].task.mainTex)
    ? stagedInventory.rows[0].task.mainTex
    : path.join(paperFactoryRoot, stagedInventory.rows[0].task.mainTex);
  const stagedMainTexBeforeEmpirical = await fs.readFile(stagedMainTexPath, 'utf8');
  const stagedEmpiricalReport = await runEmpiricalAnalysisAdapter({
    root: paperFactoryRoot,
    runtimeRoot: stagedRuntimeRoot,
    row: stagedInventory.rows[0],
    datasetRoot: authorizedDatasetRoot,
    benchmarkId: 'selftest_authorized_rl_dataset',
    applyManuscript: true,
    execute: true,
  });
  assert.equal(stagedEmpiricalReport.kind, 'EmpiricalAnalysisAdapterReport');
  assert.equal(stagedEmpiricalReport.status, 'empirical_analysis_smoke_ready');
  assert.equal(stagedEmpiricalReport.empiricalBenchmarkRegistry.status, 'empirical_benchmark_registry_ready');
  assert.equal(stagedEmpiricalReport.benchmarkSuiteSelectionPolicy.status, 'benchmark_suite_selection_ready');
  assert.equal(stagedEmpiricalReport.localBenchmarkRegistry.status, 'local_benchmark_registry_ready');
  assert.equal(stagedEmpiricalReport.datasetAccessContract.datasetMode, 'authorized_local_dataset');
  assert.ok(stagedEmpiricalReport.datasetAccessContract.primaryDataset?.path);
  assert.equal(stagedEmpiricalReport.datasetLicenseProvenanceGate.status, 'dataset_license_provenance_gate_ready');
  assert.equal(stagedEmpiricalReport.tableFigureSpec.status, 'table_figure_spec_ready');
  assert.equal(stagedEmpiricalReport.experimentRunReceipt.status, 'experiment_run_receipt_recorded');
  assert.equal(stagedEmpiricalReport.resultArtifactPackage.status, 'result_artifact_package_ready');
  assert.ok(stagedEmpiricalReport.resultArtifactPackage.artifacts.some((artifact) => (
    artifact.role === 'empirical_figure_spec_json'
  )));
  assert.equal(stagedEmpiricalReport.empiricalEvidenceGate.status, 'empirical_evidence_gate_blocked');
  assert.equal(stagedEmpiricalReport.empiricalEvidenceGate.smokeValidationStatus, 'empirical_smoke_validation_ready');
  assert.equal(stagedEmpiricalReport.empiricalEvidenceGate.evidenceMode, 'pipeline_smoke_only');
  assert.equal(stagedEmpiricalReport.empiricalEvidenceGate.academicEvidenceEligible, false);
  assert.ok(stagedEmpiricalReport.empiricalEvidenceGate.blockers.includes('generated_simulator_outcomes_preprogrammed'));
  assert.equal(stagedEmpiricalReport.manuscriptEmpiricalPatch.status, 'manuscript_empirical_patch_blocked');
  assert.equal(stagedEmpiricalReport.manuscriptEmpiricalApplyApprovalPacket.status, 'manuscript_empirical_apply_approval_blocked');
  assert.equal(stagedEmpiricalReport.manuscriptEmpiricalApplyPlan.status, 'manuscript_empirical_apply_plan_blocked');
  assert.equal(stagedEmpiricalReport.manuscriptEmpiricalApplyReceipt.status, 'manuscript_empirical_apply_blocked');
  assert.equal(stagedEmpiricalReport.safety.writesSource, false);
  assert.equal(stagedEmpiricalReport.safety.sourceMutation, false);
  assert.equal(stagedEmpiricalReport.safety.externalActionPerformed, false);
  const stagedMainTexAfterEmpirical = await fs.readFile(stagedMainTexPath, 'utf8');
  assert.equal(stagedMainTexAfterEmpirical, stagedMainTexBeforeEmpirical);
  const stagedResearchAfterEmpirical = await runResearchVerifyAdapter({
    root: paperFactoryRoot,
    row: stagedInventory.rows[0],
    runtimeRoot: stagedRuntimeRoot,
  });
  assert.equal(stagedResearchAfterEmpirical.status, 'evidence_present');
  assert.ok(stagedResearchAfterEmpirical.empiricalEvidenceCount > 0);
  assert.equal(stagedResearchAfterEmpirical.academicEvidenceEligible, false);
  assert.equal(stagedResearchAfterEmpirical.academicEvidenceStatus, 'academic_evidence_attestation_missing');
  assert.equal(stagedResearchAfterEmpirical.evidenceProvenance.pipelineSmokeExcludedFromAcademicEvidence, true);
  const stagedBuildResult = await runLatexBuildAdapter({
    root: paperFactoryRoot,
    row: stagedInventory.rows[0],
    runtimeRoot: stagedRuntimeRoot,
    execute: true,
  });
  if (stagedBuildResult.blockers.includes('latex_engine_missing')) {
    assert.equal(stagedBuildResult.buildArtifactAcceptance.status, 'build_artifact_acceptance_blocked');
  } else {
    assert.equal(stagedBuildResult.status, 'build_passed');
    assert.equal(stagedBuildResult.buildArtifactAcceptance?.status, 'compiled_pdf_accepted_for_local_package');
    assert.equal(stagedBuildResult.buildArtifactAcceptance?.accepted, true);
    assert.equal(stagedBuildResult.buildArtifactAcceptanceRecord?.role, 'build_artifact_acceptance');
    assert.equal(stagedBuildResult.builtPdf?.role, 'compiled_pdf');
    const stagedPackageResult = await runPackageAdapter({
      root: paperFactoryRoot,
      row: stagedInventory.rows[0],
      buildResult: stagedBuildResult,
      runtimeRoot: stagedRuntimeRoot,
    });
    const stagedPackageRoles = stagedPackageResult.artifactPackage.artifacts.map((artifact) => artifact.role);
    assert.equal(stagedPackageResult.artifactPackage.submitReady, true);
    assert.ok(stagedPackageRoles.includes('compiled_pdf'));
    assert.ok(stagedPackageRoles.includes('build_artifact_acceptance'));
    assert.equal(stagedPackageResult.safety.externalActionPerformed, false);
    const stagedReviewedSubmitLifecycle = buildSubmissionLifecycle({
      row: stagedInventory.rows[0],
      venues: stagedInventory.venues,
      artifactPackage: stagedPackageResult.artifactPackage,
      researchReport: stagedResearchReport,
      mode: 'reviewed-submit',
      reviewedSubmit: true,
    });
    assert.equal(stagedReviewedSubmitLifecycle.reviewedSubmitPreflightPacket?.kind, 'ReviewedSubmitPreflightPacket');
    assert.equal(stagedReviewedSubmitLifecycle.reviewedSubmitPreflightPacket?.status, 'reviewed_submit_preflight_blocked');
    assert.equal(stagedReviewedSubmitLifecycle.reviewedSubmitPreflightPacket?.approvalRequired, true);
    assert.equal(stagedReviewedSubmitLifecycle.reviewedSubmitPreflightPacket?.liveExecutorBoundaryBlocked, true);
    assert.equal(stagedReviewedSubmitLifecycle.approvalPacket?.status, 'blocked_approval_packet');
    assert.equal(stagedReviewedSubmitLifecycle.approvalPacket?.agentApproved, false);
    assert.ok(stagedReviewedSubmitLifecycle.approvalPacket?.blockers.includes('attested_academic_evidence_required_for_reviewed_submit'));
    assert.equal(stagedReviewedSubmitLifecycle.freshVenueEvidenceBundle?.status, 'blocked_fresh_venue_evidence');
    assert.equal(stagedReviewedSubmitLifecycle.outbox?.status, 'blocked_outbox_item');
    assert.equal(stagedReviewedSubmitLifecycle.controlledExecutorReceipt?.status, 'controlled_external_executor_blocked');
    assert.equal(stagedReviewedSubmitLifecycle.controlledExecutorReceipt?.externalActionPerformed, false);
    assert.equal(stagedReviewedSubmitLifecycle.receipt?.externalActionPerformed, false);
  }

  const report = await runPaperBatch({
    root: paperFactoryRoot,
    mode: 'local-dry-run',
    limit: 3,
  });
  assert.equal(report.safety.coreSnapshotModified, false);
  assert.equal(report.safety.importsOldPaperFactoryControlPlane, false);
  assert.equal(report.safety.externalActionPerformed, false);
  assert.equal(report.rows.length, 3);
  assert.ok(report.markdownTable.includes('| paper_id |'));
  assert.ok(Number.isFinite(report.summary.researchTypedContracts));
  assert.ok(Number.isFinite(report.summary.legacyCatalogReferenceReceipts));
  assert.ok(Number.isFinite(report.summary.legacyCatalogReferenceCount));
  assert.ok(Number.isFinite(report.summary.researchContractReady));
  assert.ok(Number.isFinite(report.summary.researchEvidenceCandidatePresent));
  assert.ok(Number.isFinite(report.summary.researchNativeExecutionReady));
  assert.ok(Number.isFinite(report.summary.researchAcademicEvidenceReady));
  assert.ok(Number.isFinite(report.summary.lifecycleOutboxItems));
  assert.ok(report.summary.submissionPreflight && Number.isFinite(report.summary.submissionPreflight.externalActionsPerformed));
  assert.ok(report.results.some((result) => result.lifecycle?.replayGuard?.kind === 'SubmissionReplayGuard'));
  assert.ok(report.results.every((result) => (
    result.researchReport?.typedContracts?.legacyCatalogReferences?.length === 0
    && result.researchReport?.safety?.legacyWorkerCatalogScanned === false
  )));

  const journalManageReport = await runPaperBatch({
    root: paperFactoryRoot,
    mode: 'journal-manage',
    limit: 3,
  });
  assert.equal(journalManageReport.safety.externalActionPerformed, false);
  assert.ok(Number.isFinite(journalManageReport.summary.journalManageReports));
  assert.ok(Number.isFinite(journalManageReport.summary.journalConferenceRegistries));
  assert.ok(Number.isFinite(journalManageReport.summary.targetSelectionPolicies));
  assert.ok(Number.isFinite(journalManageReport.summary.journalTargetProfiles));
  assert.ok(Number.isFinite(journalManageReport.summary.journalTargetProfileReady));
  assert.ok(Number.isFinite(journalManageReport.summary.journalRubricPackets));
  assert.ok(Number.isFinite(journalManageReport.summary.journalRubricReady));
  assert.ok(Number.isFinite(journalManageReport.summary.venueRubricManagers));
  assert.ok(Number.isFinite(journalManageReport.summary.freshRefereePools));
  assert.ok(Number.isFinite(journalManageReport.summary.venueEvidenceGates));
  assert.ok(Number.isFinite(journalManageReport.summary.venueLifecyclePolicies));
  assert.ok(Number.isFinite(journalManageReport.summary.journalConferenceSystemPackets));
  assert.ok(journalManageReport.results.some((result) => (
    result.journalManagement?.registry?.kind === 'JournalConferenceRegistry'
  )));
  assert.ok(journalManageReport.results.some((result) => (
    result.journalManagement?.targetSelectionPolicy?.kind === 'TargetSelectionPolicy'
  )));
  assert.ok(journalManageReport.results.some((result) => (
    result.journalManagement?.targetProfile?.kind === 'JournalTargetProfile'
  )));
  assert.ok(journalManageReport.results.some((result) => (
    result.journalManagement?.rubricPacket?.kind === 'JournalRubricPacket'
  )));
  assert.ok(journalManageReport.results.some((result) => (
    result.journalManagement?.venueRubricManager?.kind === 'VenueRubricManager'
  )));
  assert.ok(journalManageReport.results.some((result) => (
    result.journalManagement?.freshRefereePool?.kind === 'FreshRefereePool'
  )));
  assert.ok(journalManageReport.results.some((result) => (
    result.journalManagement?.systemPacket?.kind === 'JournalConferenceSystemPacket'
  )));

  const journalManageOverrideReport = await runPaperBatch({
    root: paperFactoryRoot,
    mode: 'journal-manage',
    limit: 1,
    targetOverride: 'JMLR',
  });
  assert.equal(journalManageOverrideReport.requestedTargetOverride, 'JMLR');
  assert.equal(
    journalManageOverrideReport.results[0]?.journalManagement?.targetProfile?.profile?.id,
    'jmlr',
  );
  assert.equal(
    journalManageOverrideReport.results[0]?.journalManagement?.targetProfile?.safety?.writesLegacyRegistry,
    false,
  );

  const refereeReviewReport = await runPaperBatch({
    root: paperFactoryRoot,
    mode: 'referee-review',
    limit: 3,
  });
  assert.equal(refereeReviewReport.safety.externalActionPerformed, false);
  assert.ok(Number.isFinite(refereeReviewReport.summary.refereeReviewReports));
  assert.ok(Number.isFinite(refereeReviewReport.summary.refereeReviewReady));
  assert.ok(Number.isFinite(refereeReviewReport.summary.refereeReviewBlocked));
  assert.ok(Number.isFinite(refereeReviewReport.summary.refereeReviewFindings));
  assert.ok(Number.isFinite(refereeReviewReport.summary.refereeIssueQueueMaterializations));
  assert.ok(Number.isFinite(refereeReviewReport.summary.refereeIssueQueueMaterializationPlanned));
  assert.ok(Number.isFinite(refereeReviewReport.summary.refereeIssueQueueMaterialized));
  assert.ok(Number.isFinite(refereeReviewReport.summary.refereeIssueQueueMaterializationBlocked));
  assert.ok(Number.isFinite(refereeReviewReport.summary.refereeReviewIssueRowsInserted));
  assert.ok(Number.isFinite(refereeReviewReport.summary.refereeReviewIssueRowsAlreadyPresent));
  assert.ok(refereeReviewReport.results.some((result) => result.refereeReview?.intake?.kind === 'RefereeReviewIntake')
    || refereeReviewReport.results.every((result) => !result.task?.mainTex));
  assert.ok(refereeReviewReport.results.some((result) => result.refereeReview?.reviewReport?.kind === 'AgentRefereeReviewReport')
    || refereeReviewReport.results.every((result) => !result.task?.mainTex));
  assert.ok(refereeReviewReport.results.some((result) => result.refereeReview?.materialization?.kind === 'RefereeIssueQueueMaterialization')
    || refereeReviewReport.results.every((result) => !result.task?.mainTex));
  assert.ok(refereeReviewReport.results.every((result) => result.refereeReview?.safety?.sourceMutation === false));
  assert.ok(refereeReviewReport.results.every((result) => result.refereeReview?.safety?.externalActionPerformed === false));

  const refereeReport = await runPaperBatch({
    root: paperFactoryRoot,
    mode: 'referee-revise',
    limit: 3,
  });
  assert.equal(refereeReport.safety.externalActionPerformed, false);
  assert.ok(Number.isFinite(refereeReport.summary.refereeOpenIssues));
  assert.ok(Number.isFinite(refereeReport.summary.refereePreflightReady));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRollbackLedgerDrafts));
  assert.ok(Number.isFinite(refereeReport.summary.refereePreimageSnapshotLedgers));
  assert.ok(Number.isFinite(refereeReport.summary.refereeExecutePlansReady));
  assert.ok(Number.isFinite(refereeReport.summary.refereeApplyModeContracts));
  assert.ok(Number.isFinite(refereeReport.summary.refereeExecuteDesignPackets));
  assert.ok(Number.isFinite(refereeReport.summary.refereeExecuteDesignReadyApplyBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeExecuteDesignReadyForApplyExecution));
  assert.ok(Number.isFinite(refereeReport.summary.refereeApplyApprovalPackets));
  assert.ok(Number.isFinite(refereeReport.summary.refereeApplyApprovalBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeApplyApprovalReady));
  assert.ok(Number.isFinite(refereeReport.summary.refereeApplyAgentApproved));
  assert.ok(Number.isFinite(refereeReport.summary.refereePatchApplyExecutions));
  assert.ok(Number.isFinite(refereeReport.summary.refereePatchApplyExecutionBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereePatchApplyExecutionReady));
  assert.ok(Number.isFinite(refereeReport.summary.refereePatchApplyApprovalGateBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereePatchApplyInvocations));
  assert.ok(Number.isFinite(refereeReport.summary.refereePatchApplyInvocationBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereePatchApplyInvocationRequired));
  assert.ok(Number.isFinite(refereeReport.summary.refereePatchApplyValidationBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereePatchApplyInvocationApplied));
  assert.ok(Number.isFinite(refereeReport.summary.refereeAgentRepairPatchBundles));
  assert.ok(Number.isFinite(refereeReport.summary.refereeAgentRepairPatchBundleReady));
  assert.ok(Number.isFinite(refereeReport.summary.refereeAgentRepairPatchBundleAlreadyPresent));
  assert.ok(Number.isFinite(refereeReport.summary.refereeAgentRepairPatchBundleBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeSourceMutations));
  assert.ok(Number.isFinite(refereeReport.summary.refereeAppliedPatchReceipts));
  assert.ok(Number.isFinite(refereeReport.summary.refereeAppliedPatchReceiptBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeAppliedPatchReceiptRecorded));
  assert.ok(Number.isFinite(refereeReport.summary.refereeAppliedPatchExecutionGateBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeAppliedPatchInvocationGateBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereePostRepairBuildPackages));
  assert.ok(Number.isFinite(refereeReport.summary.refereePostRepairBuildPackageBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereePostRepairBuildPackageReady));
  assert.ok(Number.isFinite(refereeReport.summary.refereePostRepairBuildRecheckPassed));
  assert.ok(Number.isFinite(refereeReport.summary.refereePostRepairPackageRewriteReady));
  assert.ok(Number.isFinite(refereeReport.summary.refereePostRepairResearchRecheckPassed));
  assert.ok(Number.isFinite(refereeReport.summary.refereePostRepairAppliedReceiptGateBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeIssueResolutionProofs));
  assert.ok(Number.isFinite(refereeReport.summary.refereeIssueResolutionProofBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeIssueResolutionProofReady));
  assert.ok(Number.isFinite(refereeReport.summary.refereeIssueResolutionEvidenceItems));
  assert.ok(Number.isFinite(refereeReport.summary.refereeIssueResolutionPostRepairGateBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairReconciliations));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairReconciliationBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairReconciliationReady));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairReconciled));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairStateMutationReceipts));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairStateMutationRecorded));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairStateMutationBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairStateMutationIssueRowsUpdated));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairStateMutationPatchRowsInserted));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairStateMutationPatchRowsUpdated));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairStateMutationPatchRowsAlreadyPresent));
  assert.ok(Number.isFinite(refereeReport.summary.refereeReviewedSubmitReadinessReleased));
  assert.ok(Number.isFinite(refereeReport.summary.refereeIssueStateMutations));
  assert.ok(Number.isFinite(refereeReport.summary.refereeSqliteWrites));
  assert.ok(Number.isFinite(refereeReport.summary.refereeRepairReconciliationProofGateBlocked));
  assert.ok(Number.isFinite(refereeReport.summary.refereeApplyApprovalRequired));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.patchExecutionPreflight?.kind === 'RefereeRevisionPatchExecutionPreflight')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.rollbackLedgerDraft?.kind === 'RefereeRevisionRollbackLedgerDraft')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.executeDesignPacket?.kind === 'RefereeRevisionExecuteDesignPacket')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.applyApprovalPacket?.kind === 'RefereeApplyApprovalPacket')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.applyApprovalPacket?.status === 'referee_apply_approval_ready_for_patch_execution')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.applyApprovalPacket?.approvalActor === 'agent')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.patchApplyExecution?.kind === 'RefereePatchApplyExecution')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.patchApplyExecution?.status === 'referee_patch_apply_ready_for_separate_executor')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => (
    result.refereeRevision?.patchApplyExecution?.safety?.sourceMutation === false
  )) || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.patchApplyInvocation?.kind === 'RefereePatchApplyInvocation')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.patchApplyInvocation?.status === 'referee_patch_apply_invocation_blocked')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => (
    result.refereeRevision?.patchApplyInvocation?.safety?.sourceMutation === false
  )) || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.appliedPatchReceipt?.kind === 'RefereeAppliedPatchReceipt')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.appliedPatchReceipt?.status === 'applied_patch_receipt_blocked')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => (
    result.refereeRevision?.appliedPatchReceipt?.safety?.writesSource === false
  )) || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.postRepairBuildPackage?.kind === 'PostRepairBuildPackage')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.postRepairBuildPackage?.status === 'post_repair_build_package_blocked')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => (
    result.refereeRevision?.postRepairBuildPackage?.safety?.writesPackage === false
  )) || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.issueResolutionProof?.kind === 'RefereeIssueResolutionProof')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.issueResolutionProof?.status === 'referee_issue_resolution_proof_blocked')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => (
    result.refereeRevision?.issueResolutionProof?.safety?.marksIssuesResolved === false
  )) || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.repairReconciliation?.kind === 'RepairReconciliation')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => result.refereeRevision?.repairReconciliation?.status === 'repair_reconciliation_blocked')
    || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));
  assert.ok(refereeReport.results.some((result) => (
    result.refereeRevision?.repairReconciliation?.safety?.advancesSubmissionReadiness === false
  )) || refereeReport.results.every((result) => !result.refereeRevision?.openIssueCount));

  const localReviewLoopReport = await runPaperBatch({
    root: paperFactoryRoot,
    mode: 'local-review-loop',
    limit: 1,
    maxRounds: 2,
    targetOverride: 'JMLR',
  });
  assert.equal(localReviewLoopReport.safety.externalActionPerformed, false);
  assert.equal(localReviewLoopReport.requestedTargetOverride, 'JMLR');
  for (const metric of [
    'localDiagnosticReviewLoopRuns',
    'localDiagnosticReviewLoopPassed',
    'localDiagnosticReviewLoopBlocked',
    'localDiagnosticReviewLoopRounds',
    'localDiagnosticReviewLoopFinalOpenIssues',
    'localDiagnosticReviewLoopSourceMutations',
    'localDiagnosticReviewLoopSqliteWrites',
    'localDiagnosticReviewLoopReceipts',
    'localDiagnosticReviewLoopPassRecorded',
    'localDiagnosticReviewLoopExternalActions',
    'localHeuristicVerdicts',
    'localDiagnosticPasses',
    'localDiagnosticRevisions',
  ]) assert.ok(Number.isFinite(localReviewLoopReport.summary[metric]), metric);
  assert.ok(localReviewLoopReport.results.some((result) => (
    result.localDiagnosticReviewLoop?.kind === 'LocalDiagnosticReviewLoopReport'
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.targetSelectionPolicy?.kind === 'TargetSelectionPolicy'
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.targetJournalProfile?.kind === 'JournalTargetProfile'
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.targetJournalProfile?.profile?.id === 'jmlr'
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.targetOverrideApplied === true
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.safety?.targetOverrideRuntimeOnly === true
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.safety?.writesLegacyRegistry === false
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.finalVenueEvidenceGate?.kind === 'VenueEvidenceGate'
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.finalVenueLifecyclePolicy?.kind === 'VenueLifecyclePolicy'
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.finalFreshRefereeVerdict?.kind === 'FreshRefereeVerdict'
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.diagnosticReceipt?.kind === 'LocalDiagnosticReviewLoopReceipt'
    && result.localDiagnosticReviewLoop?.academicAcceptanceGranted === false
  )));
  assert.ok(localReviewLoopReport.results.every((result) => (
    result.localDiagnosticReviewLoop?.safety?.externalActionPerformed === false
  )));

  const venueReport = await runPaperBatch({
    root: paperFactoryRoot,
    mode: 'venue-resolve',
    limit: 3,
  });
  assert.equal(venueReport.safety.externalActionPerformed, false);
  assert.ok(Number.isFinite(venueReport.summary.venueResolution.required));
  assert.ok(Number.isFinite(venueReport.summary.venueResolution.submitReadyPackagePlansRequired));
  assert.ok(Number.isFinite(venueReport.summary.venueResolution.registryAddPlansReady));
  assert.ok(Number.isFinite(venueReport.summary.venueResolution.operatorPacketsReady));
  assert.ok(Number.isFinite(venueReport.summary.venueResolution.operatorPacketsBlocked));
  assert.ok(venueReport.results.some((result) => result.venueResolution?.venueResolutionOperatorPacket?.kind === 'VenueResolutionOperatorPacket')
    || venueReport.summary.venueResolution.required === 0);

  const sourceAdaptReport = await runPaperBatch({
    root: paperFactoryRoot,
    mode: 'source-adapt',
    limit: 3,
  });
  assert.equal(sourceAdaptReport.safety.externalActionPerformed, false);
  assert.ok(Number.isFinite(sourceAdaptReport.summary.sourceAdaptation.required));
  assert.ok(Number.isFinite(sourceAdaptReport.summary.sourceAdaptation.operatorPacketsReady));
  assert.ok(Number.isFinite(sourceAdaptReport.summary.sourceAdaptation.operatorPacketsBlocked));
  assert.ok(sourceAdaptReport.results.some((result) => result.sourceAdaptation?.sourceAdaptationOperatorPacket?.kind === 'SourceAdaptationOperatorPacket')
    || sourceAdaptReport.summary.sourceAdaptation.required === 0);

  const legacyReport = await runPaperBatch({
    root: legacyPaperFactoryRoot,
    mode: 'legacy-cleanup',
    limit: 1,
  });
  assert.ok(legacyReport.legacyCleanupAudit?.kind === 'LegacyPaperFactoryCleanupAudit');
  assert.equal(legacyReport.legacyCleanupAudit.status, 'read_only_retirement_audit');
  assert.ok(Number.isFinite(legacyReport.legacyCleanupAudit.summary.migrationBacklogCount));
  assert.ok(Number.isFinite(legacyReport.legacyCleanupAudit.summary.heptaAdapterCount));
  assert.ok(legacyReport.legacyCleanupAudit.summary.byRetirementWave);
  assert.ok(Array.isArray(legacyReport.legacyCleanupAudit.retirementPlan?.waves));
  assert.ok(Array.isArray(legacyReport.legacyCleanupAudit.retirementPlan?.immediateBacklog));
  assert.equal(legacyReport.legacyCleanupAudit.summary.retirementWavePacketCount, 7);
  assert.ok(legacyReport.legacyCleanupAudit.summary.byRetirementWaveFamily);
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.legacyEntrypointDeprecationPacket?.kind,
    'LegacyEntrypointDeprecationPacket',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.heptaDataAssetExportPlan?.kind,
    'HeptaDataAssetExportPlan',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.migrationBacklogPacket?.kind,
    'PaperFactoryMigrationBacklogPacket',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.p0P1BacklogDrainReceipt?.kind,
    'PaperFactoryP0P1BacklogDrainReceipt',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.quarantineManifest?.kind,
    'PaperFactoryQuarantineManifest',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.retirementReadinessGate?.kind,
    'PaperFactoryRetirementReadinessGate',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.retirementReadinessGate?.status,
    legacyReport.legacyCleanupAudit.summary.retirementReadinessStatus,
  );
  assert.ok(Array.isArray(legacyReport.legacyCleanupAudit.retirementPlan?.retirementWavePackets));
  assert.equal(legacyReport.legacyCleanupAudit.retirementPlan.retirementWavePackets.length, 7);
  assert.ok(Array.isArray(legacyReport.legacyCleanupAudit.retirementPlan?.retirementWaveExecutionReceipts));
  assert.equal(legacyReport.legacyCleanupAudit.retirementPlan.retirementWaveExecutionReceipts.length, 7);
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.legacyEntrypointFreezeReceipt?.kind,
    'LegacyEntrypointFreezeReceipt',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.dataAssetExportReceipt?.kind,
    'HeptaDataAssetExportReceipt',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.researchSourcePackageCoverageReceipt?.kind,
    'PaperFactoryMigrationCoverageReceipt',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.refereeReviewRepairCoverageReceipt?.kind,
    'PaperFactoryMigrationCoverageReceipt',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.submissionVenueSourceCoverageReceipt?.kind,
    'PaperFactoryMigrationCoverageReceipt',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.liveExternalExecutorPolicyReceipt?.kind,
    'PaperFactoryLiveExternalExecutorPolicyReceipt',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.quarantineIsolationReceipt?.kind,
    'PaperFactoryQuarantineIsolationReceipt',
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.oldControlPlaneRemovalReceipt?.kind,
    'OldPaperFactoryControlPlaneRemovalReceipt',
  );
  assert.ok(Number.isFinite(legacyReport.legacyCleanupAudit.summary.retirementWaveExecutionReceiptCount));
  assert.equal(legacyReport.legacyCleanupAudit.summary.verifiedDispositionCount, 263);
  assert.equal(legacyReport.legacyCleanupAudit.summary.verifiedBehavioralReplacementCount, 14);
  assert.equal(legacyReport.legacyCleanupAudit.summary.verifiedExplicitRetirementCount, 249);
  assert.equal(legacyReport.legacyCleanupAudit.summary.semanticMigrationClaimCount, 14);
  assert.equal(legacyReport.legacyCleanupAudit.summary.functionalParityClaimAllowed, false);
  assert.equal(
    legacyReport.legacyCleanupAudit.summary.explicitRetirementIsNotBehavioralMigration,
    true,
  );
  assert.equal(
    legacyReport.legacyCleanupAudit.retirementPlan?.retirementReadinessGate
      ?.retirementReadinessDoesNotMeanFunctionalParity,
    true,
  );
  assert.ok(Number.isFinite(legacyReport.legacyCleanupAudit.summary.activeP0MigrationBlockerCount));
  assert.ok(Number.isFinite(legacyReport.legacyCleanupAudit.summary.activeP1MigrationBlockerCount));
  assert.equal(legacyReport.legacyCleanupAudit.summary.liveExternalActionAllowed, false);
  assert.equal(legacyReport.legacyCleanupAudit.safety.sourceMutation, false);

  process.stdout.write(JSON.stringify({
    ok: true,
    inventoryRows: inventory.rows.length,
    proposalStatus: proposalReport.status,
    dryRunRows: report.rows.length,
    summary: report.summary,
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write((error && error.stack) ? error.stack + '\n' : String(error) + '\n');
  process.exitCode = 1;
});
