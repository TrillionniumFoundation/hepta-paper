import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PAPER_ACTIONS,
  PAPER_PRODUCT_PROFILE,
  createPaperActionManifest,
  buildPaperHandoffEnvelope,
  buildPaperAdapterRunReceipt,
  createPaperProposalApprovalDocument,
} from '../../paper-domain/contracts/index.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { discoverInventory } from '../../paper-adapters/inventory/index.mjs';
import { runPaperBatch } from '../src/paper-batch-runner.mjs';
import { runPaperProposalAdapter } from '../../paper-adapters/proposal/index.mjs';
import { runEmpiricalAnalysisAdapter } from '../../paper-adapters/empirical-analysis/index.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import {
  runLatexBuildAdapter,
  runPackageAdapter,
} from '../../paper-adapters/build-package/index.mjs';
import { buildSubmissionLifecycle } from '../../paper-adapters/submission/index.mjs';
import {
  buildJournalConferenceRegistry,
  buildTargetSelectionPolicy,
  runJournalManageAdapter,
} from '../../paper-adapters/journal-manage/index.mjs';
import { runRefereeReviewAdapter } from '../../paper-adapters/referee-review/index.mjs';
import { runRefereeReviseAdapter } from '../../paper-adapters/referee-revise/index.mjs';
import { runVenueResolveAdapter } from '../../paper-adapters/venue-resolve/index.mjs';
import { runSourceAdaptAdapter } from '../../paper-adapters/source-adapt/index.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';
import { bootstrapAutomationContext } from '../../paper-composition/bootstrap/automation-context-bootstrap.mjs';
import {
  createDefaultPaperStore,
  createReadOnlyPaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import { enterArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { assertIsolatedVerificationRuntime } from '../src/verification-runtime.mjs';

assertIsolatedVerificationRuntime('paper selftest');

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const paperFactoryRoot = defaultPaperAssetRoot();
const selftestRuntimeRoot = path.join(defaultPaperRuntimeRoot(), 'selftest');

function createSelftestAutonomousSubmissionOutbox() {
  const unavailable = () => {
    throw new Error('paper_selftest_autonomous_submission_write_unexpected');
  };
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionHandoffOutboxPort',
    durability: 'sqlite-transactional-outbox-v1',
    externallyFencedMutations: false,
    prepareAutonomousSubmission: unavailable,
    beginAutonomousSubmissionAttempt: unavailable,
    recordAutonomousSubmissionOutcome: unavailable,
    getAutonomousSubmission: () => null,
    listAutonomousSubmissionsForCampaign: () => Object.freeze([]),
    listDispatchableAutonomousSubmissions: () => Object.freeze([]),
  });
}

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
    'paper-adapters/proposal/index.mjs',
    'paper-adapters/journal-manage/index.mjs',
  ];
  for (const file of files) {
    const text = await sourceText(file);
    assert.equal(/from ['"].*(paperctl_modules|bin\/paperctl)/.test(text), false, `${file} imports old control plane`);
  }
}

async function snapshotRuntimeTree(root) {
  const entries = [];
  async function visit(current, relative = '') {
    let children;
    try {
      children = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childRelative = relative ? path.join(relative, child.name) : child.name;
      const childPath = path.join(current, child.name);
      const stat = await fs.lstat(childPath);
      entries.push({
        path: childRelative,
        type: child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'symlink' : 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
      if (child.isDirectory()) await visit(childPath, childRelative);
    }
  }
  await visit(root);
  return entries;
}

function proposalApprovalAuthority(report) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const now = Date.now();
  const operatorIdentity = { subjectId: 'paper-selftest-proposal-operator', displayName: 'Paper Selftest Operator' };
  const unsigned = createPaperProposalApprovalDocument({
    ideaBrief: report.ideaBrief,
    proposalEnvelope: report.proposalEnvelope,
    generationReceipt: report.generationReceipt,
    operatorIdentity,
    riskAcceptanceRationale: 'Selftest operator accepts the exact proposal risks bound by the signed document.',
    signedAt: new Date(now - 60_000).toISOString(),
    validFrom: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
  });
  return {
    approvalDocument: signAuthorityDocument(unsigned, {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      keyId: 'paper-selftest-proposal-key',
      role: 'proposal_approver',
    }),
    trustStoreOverride: {
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: [{
        keyId: 'paper-selftest-proposal-key',
        subjectId: operatorIdentity.subjectId,
        algorithm: 'ed25519',
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
        roles: ['proposal_approver'],
        status: 'active',
      }],
    },
  };
}

function selftestScientificClaimDocument() {
  return {
    version: 1,
    kind: 'PaperScientificClaimInput',
    claims: [{
      claimKey: 'distributionally-robust-rl-convergence',
      statement: 'For every discounted finite-state control problem satisfying the stated rectangular ambiguity and contraction assumptions, the proposed robust Bellman iteration converges to its unique fixed point.',
      assumptions: ['The ambiguity set is rectangular and the robust Bellman operator is a contraction.'],
      quantifiers: ['For every discounted finite-state control problem satisfying the stated assumptions.'],
      negativeBoundaries: ['No convergence claim is made for non-rectangular ambiguity sets or undiscounted problems.'],
      proofObligations: ['Prove contraction, fixed-point uniqueness, and convergence of the robust Bellman iteration.'],
    }],
  };
}

async function main() {
  // Selftest owns this disposable isolated store, so schema creation is an
  // explicit fixture setup step rather than an implicit bootstrap side effect.
  await fs.rm(selftestRuntimeRoot, { recursive: true, force: true });
  createDefaultPaperStore({
    root: paperFactoryRoot,
    runtimeRoot: selftestRuntimeRoot,
  }).close();
  const selftestContext = bootstrapAutomationContext({
    root: paperFactoryRoot,
    runtimeRoot: selftestRuntimeRoot,
    mode: 'selftest',
    execute: true,
    serviceOverrides: {
      autonomousSubmissionOutbox: createSelftestAutonomousSubmissionOutbox(),
    },
  });
  try {
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
    runtimeRoot: selftestRuntimeRoot,
    idea: 'A distributionally robust reinforcement learning theorem for stochastic control',
    discipline: 'machine learning',
    venue: 'NeurIPS',
    title: 'Distributionally Robust RL for Stochastic Control',
    materials: ['existing theorem sketch', 'simulation plan'],
    scientificClaimDocument: selftestScientificClaimDocument(),
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
  assert.ok(proposalReport.reviewGate.blockers.includes('proposal_approval_authority_required'));

  const autoVenueProposalReport = await runPaperProposalAdapter({
    root: paperFactoryRoot,
    runtimeRoot: selftestRuntimeRoot,
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
    runtimeRoot: selftestRuntimeRoot,
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
    runtimeRoot: selftestRuntimeRoot,
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
    runtimeRoot: selftestRuntimeRoot,
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
    runtimeRoot: selftestRuntimeRoot,
    idea: 'A distributionally robust reinforcement learning theorem for stochastic control',
    discipline: 'machine learning',
    venue: 'NeurIPS',
    title: 'Distributionally Robust RL for Stochastic Control',
    materials: ['existing theorem sketch', 'simulation plan'],
    scientificClaimDocument: selftestScientificClaimDocument(),
    ...proposalApprovalAuthority(proposalReport),
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
  const stagedRuntimeRoot = selftestRuntimeRoot;
  const stagedProposalInput = {
    root: paperFactoryRoot,
    runtimeRoot: stagedRuntimeRoot,
    paperId: stagedPaperId,
    idea: 'A staged proposal inventory bridge for paper production',
    discipline: 'machine learning',
    venue: 'NeurIPS',
    title: 'Selftest Proposal Staging',
  };
  const stagedProposalDraft = await runPaperProposalAdapter(stagedProposalInput);
  const stagedProposalReport = await runPaperProposalAdapter({
    ...stagedProposalInput,
    ...proposalApprovalAuthority(stagedProposalDraft),
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
  assert.equal(stagedInventory.rows[0].task.sourceWorkspace.includes('selftest/proposals'), true);
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
  const stagedEmpiricalRunDir = path.join(
    stagedRuntimeRoot,
    'empirical-analysis',
    stagedPaperId,
  );
  const stagedEmpiricalWorkerRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: [process.execPath],
    allowedRoots: [stagedEmpiricalRunDir],
    allowedOutputRoots: [stagedEmpiricalRunDir],
    allowedDatasetRoots: [authorizedDatasetRoot],
    dockerImage: AUTOMATION_RUNTIME_IMAGES.python.imageDigest,
  });
  const stagedEmpiricalReport = await runEmpiricalAnalysisAdapter({
    root: paperFactoryRoot,
    runtimeRoot: stagedRuntimeRoot,
    row: stagedInventory.rows[0],
    datasetRoot: authorizedDatasetRoot,
    benchmarkId: 'selftest_authorized_rl_dataset',
    datasetLicenseId: 'CC0-1.0',
    applyManuscript: true,
    execute: true,
    workerRunner: stagedEmpiricalWorkerRunner,
  });
  assert.equal(stagedEmpiricalReport.kind, 'EmpiricalAnalysisAdapterReport');
  assert.equal(stagedEmpiricalReport.status, 'empirical_analysis_smoke_ready', JSON.stringify({
    blockers: stagedEmpiricalReport.blockers,
    kernelSandboxReceipt: stagedEmpiricalReport.kernelSandboxReceipt
      ? {
        ok: stagedEmpiricalReport.kernelSandboxReceipt.ok,
        blockers: stagedEmpiricalReport.kernelSandboxReceipt.blockers,
      }
      : null,
    validationBlockers: stagedEmpiricalReport.empiricalEvidenceGate?.validationBlockers,
  }));
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
    assert.equal(stagedPackageResult.artifactPackage.submitReady, false);
    assert.equal(stagedPackageResult.packageVerificationReceipt, null);
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

  let previewStageCalls = 0;
  const previewStageTrap = new Proxy({}, {
    get() {
      previewStageCalls += 1;
      throw new Error('batch_preview_must_not_resolve_stage_execution');
    },
  });
  // This selftest deliberately keeps its writable automation context open.
  // Supply an explicit read-only connection so the batch preview cannot fall
  // back to immutable mode while a live WAL belongs to that context.
  const previewStore = createReadOnlyPaperStore({
    root: paperFactoryRoot,
    runtimeRoot: selftestRuntimeRoot,
  });
  const runtimeBeforePreview = await snapshotRuntimeTree(selftestRuntimeRoot);
  const report = await runPaperBatch({
    root: paperFactoryRoot,
    runtimeRoot: selftestRuntimeRoot,
    mode: 'local-dry-run',
    limit: 3,
    execute: false,
    writeReport: false,
    serviceOverrides: { stageExecution: previewStageTrap, store: previewStore },
  });
  const runtimeAfterPreview = await snapshotRuntimeTree(selftestRuntimeRoot);
  assert.deepEqual(runtimeAfterPreview, runtimeBeforePreview, 'batch preview must not mutate runtime state');
  assert.equal(previewStageCalls, 0, 'batch preview must not resolve or execute a stage adapter');
  assert.equal(report.safety.vendoredReferenceRuntimeScanPerformed, false);
  assert.equal(Object.hasOwn(report.safety, 'coreSnapshotModified'), false);
  assert.equal(Object.hasOwn(report, 'coreIntegrity'), false);
  assert.equal(Object.hasOwn(report, 'compatibilityStageSummary'), false);
  assert.equal(report.safety.importsOldPaperFactoryControlPlane, false);
  assert.equal(report.safety.externalActionPerformed, false);
  assert.equal(report.rows.length, 3);
  assert.ok(report.markdownTable.includes('| paper_id |'));
  assert.equal(Object.hasOwn(report.summary, 'researchTypedContracts'), false);
  assert.equal(Object.hasOwn(report.summary, 'lifecycleOutboxItems'), false);
  assert.equal(Object.hasOwn(report.summary, 'submissionPreflight'), false);
  assert.ok(Number.isFinite(report.summary.campaignQueue.nodeCount));
  const stageResultKeys = [
    'buildResult',
    'packageResult',
    'researchReport',
    'refereeReview',
    'refereeRevision',
    'localDiagnosticReviewLoop',
    'journalManagement',
    'empiricalAnalysis',
    'venueResolution',
    'sourceAdaptation',
    'lifecycle',
  ];
  assert.ok(report.results.every((result) => (
    stageResultKeys.every((key) => !Object.hasOwn(result, key))
    && result.campaignSubmission === null
    && result.workflowAuthorityLedgerEntry === null
    && result.workflowStateProjection === null
  )));

  const batchCampaignOptions = {
    root: paperFactoryRoot,
    runtimeRoot: selftestRuntimeRoot,
    mode: 'local-build',
    limit: 1,
    paperIds: [inventory.rows[0].task.paperId],
    inventorySource: 'yaml',
    execute: true,
    writeReport: false,
    serviceOverrides: {
      autonomousSubmissionOutbox: createSelftestAutonomousSubmissionOutbox(),
    },
  };
  const campaignReport = await runPaperBatch(batchCampaignOptions);
  assert.equal(campaignReport.results.length, 1);
  const campaignResult = campaignReport.results[0];
  assert.equal(campaignResult.campaignSubmission?.status, 'paper_campaign_queued');
  assert.deepEqual(campaignResult.campaignPlan?.nodes?.map((node) => node.kind), ['compile']);
  assert.equal(campaignReport.status, 'paper_campaigns_queued_not_executed');
  assert.equal(campaignReport.executionStatus, 'queued_not_executed');
  assert.equal(campaignReport.workflowExecutionPerformed, false);
  assert.equal(
    campaignResult.workflowAuthorityLineage?.campaignId,
    campaignResult.campaignPlan?.campaignId,
  );
  assert.equal(
    campaignResult.workflowAuthorityLineage?.campaignPlanHash,
    campaignResult.campaignPlan?.campaignPlanHash,
  );
  assert.equal(campaignResult.workflowAuthorityLineage?.workflowReceiptHash, null);
  assert.ok(stageResultKeys.every((key) => !Object.hasOwn(campaignResult, key)));
  const replayedCampaignReport = await runPaperBatch(batchCampaignOptions);
  assert.equal(
    replayedCampaignReport.results[0]?.campaignSubmission?.status,
    'paper_campaign_already_queued',
  );
  assert.equal(
    replayedCampaignReport.results[0]?.campaignPlan?.campaignPlanHash,
    campaignResult.campaignPlan?.campaignPlanHash,
  );

  const adapterRow = inventory.rows[0];
  const journalManagement = await runJournalManageAdapter({
    root: paperFactoryRoot,
    runtimeRoot: selftestRuntimeRoot,
    row: adapterRow,
    target: 'JMLR',
    execute: false,
  });
  assert.equal(journalManagement.kind, 'JournalManageAdapterReport');
  assert.equal(journalManagement.registry?.kind, 'JournalConferenceRegistry');
  assert.equal(journalManagement.targetSelectionPolicy?.kind, 'TargetSelectionPolicy');
  assert.equal(journalManagement.targetProfile?.kind, 'JournalTargetProfile');
  assert.equal(journalManagement.targetProfile?.profile?.id, 'jmlr');
  assert.equal(journalManagement.rubricPacket?.kind, 'JournalRubricPacket');
  assert.equal(journalManagement.venueRubricManager?.kind, 'VenueRubricManager');
  assert.equal(journalManagement.freshRefereePool?.kind, 'FreshRefereePool');
  assert.equal(journalManagement.systemPacket?.kind, 'JournalConferenceSystemPacket');
  assert.equal(journalManagement.safety?.writesLegacyRegistry, false);
  assert.equal(journalManagement.safety?.externalActionPerformed, false);

  const adapterStore = createReadOnlyPaperStore({
    root: paperFactoryRoot,
    runtimeRoot: selftestRuntimeRoot,
    immutable: true,
  });
  try {
    const refereeReview = await runRefereeReviewAdapter({
      root: paperFactoryRoot,
      runtimeRoot: selftestRuntimeRoot,
      row: adapterRow,
      execute: false,
      store: adapterStore,
    });
    assert.equal(refereeReview.kind, 'RefereeReviewAdapterReport');
    assert.equal(refereeReview.intake?.kind, 'RefereeReviewIntake');
    assert.equal(refereeReview.reviewReport?.kind, 'AgentRefereeReviewReport');
    assert.equal(refereeReview.materialization?.kind, 'RefereeIssueQueueMaterialization');
    assert.equal(refereeReview.safety?.sourceMutation, false);
    assert.equal(refereeReview.safety?.sqliteWrites, false);
    assert.equal(refereeReview.safety?.externalActionPerformed, false);

    const refereeRevision = await runRefereeReviseAdapter({
      root: paperFactoryRoot,
      runtimeRoot: selftestRuntimeRoot,
      row: adapterRow,
      mode: 'dry-run',
      execute: false,
      store: adapterStore,
    });
    assert.equal(refereeRevision.kind, 'RefereeRevisionAdapterReport');
    assert.equal(
      refereeRevision.patchExecutionPreflight?.kind,
      'RefereeRevisionPatchExecutionPreflight',
    );
    assert.equal(refereeRevision.rollbackLedgerDraft?.kind, 'RefereeRevisionRollbackLedgerDraft');
    assert.equal(refereeRevision.executeDesignPacket?.kind, 'RefereeRevisionExecuteDesignPacket');
    assert.equal(refereeRevision.safety?.dryRunOnly, true);
    assert.equal(refereeRevision.safety?.sourceMutation, false);
    assert.equal(refereeRevision.safety?.externalActionPerformed, false);
  } finally {
    adapterStore.close();
  }

  const venueResolution = await runVenueResolveAdapter({
    row: adapterRow,
    venues: inventory.venues,
  });
  assert.equal(venueResolution.kind, 'VenueResolveAdapterReport');
  assert.equal(venueResolution.venueResolutionOperatorPacket?.kind, 'VenueResolutionOperatorPacket');
  assert.equal(venueResolution.safety?.writesRegistry, false);
  assert.equal(venueResolution.safety?.externalActionPerformed, false);

  const sourceAdaptation = await runSourceAdaptAdapter({
    root: paperFactoryRoot,
    row: adapterRow,
  });
  assert.equal(sourceAdaptation.kind, 'SourceAdaptAdapterReport');
  assert.equal(sourceAdaptation.sourceAdaptationOperatorPacket?.kind, 'SourceAdaptationOperatorPacket');
  assert.equal(sourceAdaptation.safety?.writesSource, false);
  assert.equal(sourceAdaptation.safety?.externalActionPerformed, false);
  process.stdout.write(JSON.stringify({
    ok: true,
    inventoryRows: inventory.rows.length,
    proposalStatus: proposalReport.status,
    dryRunRows: report.rows.length,
    campaignId: campaignResult.campaignPlan?.campaignId,
    summary: report.summary,
  }, null, 2) + '\n');
  } finally {
    selftestContext.services.persistenceSession.close?.();
  }
}

main().catch((error) => {
  process.stderr.write((error && error.stack) ? error.stack + '\n' : String(error) + '\n');
  process.exitCode = 1;
});
