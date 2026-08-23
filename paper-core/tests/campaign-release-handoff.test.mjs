import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createCampaignNodeExecutor } from '../../paper-composition/automation/campaign-node-execution-composition.mjs';
import { consumeCampaignReleaseBundleForSubmission, verifyCampaignReleaseBundleForSubmission } from '../../paper-adapters/submission/campaign-release-bundle-consumer.mjs';
import { prepareSubmissionAuthorities } from '../../paper-adapters/submission/submission-authority-orchestrator.mjs';
import { exportSubmissionHandoffBundle } from '../../paper-adapters/submission/handoff-bundle-exporter.mjs';
import { executeSubmissionHandoffExport } from '../../paper-composition/submission/submission-handoff-export-composition.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createSqliteCampaignReleaseQueryRepository } from '../../paper-adapters/persistence/sqlite-campaign-release-query-repository.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { createAutomationPromotionCandidate, createCampaignReleaseBundle, verifyCampaignReleaseBundle } from '../../paper-domain/automation/campaign-release-contracts.mjs';
import { buildCampaignResearchSourceSnapshot } from '../../paper-domain/automation/campaign-research-contract.mjs';
import { buildExperimentRegistry } from '../../paper-domain/research/experiment-registry.mjs';
import { buildTargetScopeReceipt } from '../../paper-domain/automation/target-scope-policy.mjs';
import { createPaperTask } from '../../paper-domain/contracts/index.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectWorkspaceExecutionSnapshot, sourceTreeExcludedNames } from '../../paper-adapters/runtime/execution-snapshot.mjs';
import { bootstrapAutomationContext } from '../../paper-composition/bootstrap/automation-context-bootstrap.mjs';
import { convergeAutonomousSubmissionHandoff } from '../../paper-composition/bootstrap/autonomous-submission-handoff-migration-composition.mjs';
import { bootstrapSubmissionContext } from '../../paper-composition/bootstrap/capability-scoped-bootstrap.mjs';
import { verifyCampaignReleaseEvidenceCapsuleDirectory } from '../../paper-adapters/build-package/research-evidence-capsule.mjs';
import { createCampaignReleasePackager } from '../../paper-adapters/automation/campaign-release-packager.mjs';
import { createTrustedIndependentPdfRebuildVerifierFixture } from './fixtures/trusted-independent-pdf-rebuild-verifier.mjs';
import { buildDeterministicPdfFixture } from './support/deterministic-pdf-fixture.mjs';
import { assertSubmissionHandoffDetachedRecoveryConsistency, buildSubmissionHandoffExportLifecycleFixture, createCampaignReleaseAuthorityRepositoryFixture, createProviderCapabilityCurrentSignatureRevalidatorFixture, persistSubmissionHandoffExportLifecycle } from './support/submission-handoff-export-lifecycle-fixture.mjs';
const submissionHandoffCli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'paper-submission-handoff.mjs');

function testHandoffMutationCoordinator() {
  const coveredDatabaseRoles = Object.freeze(['submission-handoff']);
  return Object.freeze({
    implemented: true, coveredDatabaseRoles,
    executeMutation() {
      throw new Error('campaign_release_handoff_test_mutation_unexpected');
    },
    recoverPendingMutations() { return Object.freeze([]); },
    inspectStatus: () => Object.freeze({
      status: 'externally_fenced_sqlite_mutation_coordinator_ready',
      implemented: true, coveredDatabaseRoles, blockers: Object.freeze([]),
    }),
  });
}

function bootstrapTestAutomationContext(options) {
  return bootstrapAutomationContext({
    ...options, submissionHandoffMutationCoordinator: testHandoffMutationCoordinator(),
  });
}

function runSubmissionHandoffCli({ campaignId, root, runtimeRoot } = {}) {
  return spawnSync(process.execPath, [
    submissionHandoffCli,
    '--campaign-id', campaignId,
    '--root', root,
    '--runtime-root', runtimeRoot,
  ], { encoding: 'utf8', timeout: 30_000 });
}

function removeFixtureTree(root) {
  function restoreOwnerWrite(candidate) {
    let entry;
    try { entry = fs.lstatSync(candidate); } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (entry.isSymbolicLink()) return;
    fs.chmodSync(candidate, entry.isDirectory() ? 0o700 : 0o600);
    if (entry.isDirectory()) for (const name of fs.readdirSync(candidate)) {
      restoreOwnerWrite(path.join(candidate, name));
    }
  }
  restoreOwnerWrite(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-campaign-release-'));
  const workspace = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(workspace, 'automation-results', 'final'), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), '\\documentclass{article}\\begin{document}Fixture. \\section{Limitations}None.\\end{document}\n');
  fs.writeFileSync(path.join(workspace, 'SOURCE_PACKAGE_CONTRACT.json'), JSON.stringify({
    version: 1,
    kind: 'SourcePackageContract',
    paperId: 'paper',
    venueTarget: 'Fixture Journal',
    files: [{ path: 'main.tex', role: 'main_tex', required: true }],
  }));
  fs.writeFileSync(
    path.join(workspace, 'automation-results', 'final', 'main.pdf'),
    buildDeterministicPdfFixture({ marker: 'campaign-release-authoritative' }),
  );
  t.after(() => removeFixtureTree(root));
  return { root, workspace, runtimeRoot };
}

function bindReleaseAuthority(plan) {
  const bound = {
    ...plan,
    researchVerificationRequired: true,
    paperQualityRequirements: {
      ...(plan.paperQualityRequirements || {}),
      researchVerificationRequired: true,
    },
  };
  return { ...bound, campaignPlanHash: hashRecord('PaperCampaignPlan', bound) };
}

function rehashAutomationPromotionCandidate(candidate) {
  const payload = structuredClone(candidate);
  delete payload.automationPromotionCandidateHash;
  return {
    ...payload,
    automationPromotionCandidateHash:
      hashRecord('AutomationPromotionCandidate', payload),
  };
}

function rehashCampaignReleaseBundle(bundle) {
  const payload = structuredClone(bundle);
  delete payload.campaignReleaseBundleHash;
  return {
    ...payload,
    campaignReleaseBundleHash: hashRecord('CampaignReleaseBundle', payload),
  };
}

function readyResearchReport(identity = {}) {
  const researchGapPlanHash = hashRecord('ResearchGapPlanFixture', {});
  const promotionInputSnapshotHash = hashRecord('PromotionInputSnapshotFixture', {});
  const experimentRegistry = Object.freeze(buildExperimentRegistry({
    paperTask: { paperId: 'paper' },
    artifacts: [],
  }));
  const payload = {
    version: 1,
    kind: 'PaperResearchVerifyReport',
    paperId: 'paper',
    taskKey: 'paper:campaign',
    status: 'verified',
    experimentRegistryHash: experimentRegistry.experimentRegistryHash,
    promotionEligibility: { status: 'research_promotion_ready', blockers: [] },
    capabilities: {
      evidenceQualityGate: {
        status: 'evidence_quality_ready',
        blockers: [],
        evidenceQualityGateHash: hashRecord('EvidenceQualityGateFixture', {}),
      },
      experimentRegistry,
      researchGapPlan: { jobs: [], researchGapPlanHash },
      promotionInputSnapshot: {
        status: 'promotion_input_snapshot_frozen',
        researchGapPlanHash,
        promotionInputSnapshotHash,
      },
      researchGapClosureReceipt: {
        status: 'research_gap_closure_verified',
        promotionInputSnapshotHash,
        researchGapClosureReceiptHash: hashRecord('ResearchGapClosureReceiptFixture', {}),
      },
    },
    typedContracts: {},
    nativeResearchWorkerExecution: { workerReceipts: [] },
    ...identity,
  };
  return Object.freeze({ ...payload, researchReportHash: hashPaperRecord('PaperResearchVerifyReport', payload) });
}

function readyResearchResult({ campaignId = 'campaign', report = readyResearchReport() } = {}) {
  return Object.freeze({
    version: 1,
    kind: 'CampaignResearchVerificationResult',
    status: 'campaign_research_verification_completed',
    campaignId,
    paperId: 'paper',
    researchReportHash: report.researchReportHash,
    researchPromotionStatus: 'research_promotion_ready',
    researchNodeId: report.researchNodeId || null,
    researchAttemptId: report.researchAttemptId || null,
    researchLeaseGeneration: report.researchLeaseGeneration || null,
    verifiedSourceMerkleHash: report.verifiedSourceMerkleHash || null,
    verifiedSourceWorkspaceManifestHash: report.verifiedSourceWorkspaceManifestHash || null,
    campaignResearchSourceSnapshotHash: report.campaignResearchSourceSnapshotHash || null,
    campaignResearchSourceSnapshot: report.campaignResearchSourceSnapshot || null,
    report,
  });
}

function nodes(workspace = null) {
  const sourceSnapshot = workspace ? inspectWorkspaceExecutionSnapshot(workspace, {
    excludeNames: sourceTreeExcludedNames(workspace),
  }) : { merkleHash: 'sha256:fixture-source-merkle', manifestHash: 'sha256:fixture-source-manifest' };
  const finalResult = {
    status: 'empirical_execution_completed',
    materializedPaths: ['automation-results/final/main.pdf'],
    multiLanguageEmpiricalReceiptHash: 'sha256:final-compile',
    sourceMerkleHash: sourceSnapshot.merkleHash,
    sourceWorkspaceManifestHash: sourceSnapshot.manifestHash,
  };
  const finalCompileNode = {
    nodeId: 'campaign:1:final-compile',
    kind: 'final-compile',
    status: 'completed',
    result: finalResult,
    resultSha256: hashRecord('PaperCampaignNodeResult', finalResult),
    dependencies: ['campaign:1:convergence'],
  };
  const researchReport = readyResearchReport();
  const researchResult = readyResearchResult({ report: researchReport });
  const researchVerifyNode = {
    nodeId: 'campaign:2:research-verify',
    kind: 'research-verify',
    status: 'completed',
    attemptId: 'research-attempt-1',
    leaseGeneration: 1,
    result: researchResult,
    resultSha256: hashRecord('PaperCampaignNodeResult', researchResult),
    dependencies: [finalCompileNode.nodeId],
  };
  const packageNode = {
    nodeId: 'campaign:3:package',
    kind: 'package',
    status: 'running',
    attemptId: 'attempt-1',
    updatedAt: '2026-07-14T00:00:00.000Z',
    dependencies: [finalCompileNode.nodeId, researchVerifyNode.nodeId],
  };
  return { finalCompileNode, researchVerifyNode, packageNode };
}

function createTrustedReleasePackagerFixture({ context, store, runtimeRoot, fixtureId }) {
  return createCampaignReleasePackager({
    artifactRepositoryFactory: context.services.artifactRepositoryFactory,
    store,
    receiptLedger: context.services.receiptLedger,
    runtimeRoot,
    clock: context.services.clock,
    independentPdfRebuildVerifier:
      createTrustedIndependentPdfRebuildVerifierFixture({ fixtureId }),
  });
}

async function prepareFencedPackage({
  context, workspace, runtimeRoot,
  campaignId = 'campaign',
  releasePackager = context?.services?.releasePackager, executionBudget = null,
} = {}) {
  const campaignStore = context.services.campaignStore;
  const { finalCompileNode, researchVerifyNode, packageNode } = nodes(workspace);
  finalCompileNode.nodeId = `${campaignId}:1:final-compile`;
  researchVerifyNode.nodeId = `${campaignId}:2:research-verify`;
  researchVerifyNode.dependencies = [finalCompileNode.nodeId];
  packageNode.nodeId = `${campaignId}:3:package`;
  packageNode.dependencies = [finalCompileNode.nodeId, researchVerifyNode.nodeId];
  const spec = bindReleaseAuthority({
    campaignId,
    paperId: 'paper',
    venueTarget: 'Fixture Journal',
    sourceWorkspace: workspace,
    paperQualityProfile: null,
    maxRounds: 1,
    nodes: [
      { nodeId: finalCompileNode.nodeId, kind: 'final-compile', dependencies: [], priority: 1, maxAttempts: 2 },
      { nodeId: researchVerifyNode.nodeId, kind: 'research-verify', dependencies: [finalCompileNode.nodeId], priority: 2, maxAttempts: 2 },
      { nodeId: packageNode.nodeId, kind: 'package', dependencies: [finalCompileNode.nodeId, researchVerifyNode.nodeId], priority: 3, maxAttempts: 2 },
    ],
  });
  campaignStore.createCampaign(spec);
  const finalClaim = campaignStore.claimReady({ campaignId, workerId: 'worker', leaseSeconds: 600, limit: 1 })[0];
  const finalRunning = campaignStore.startNode({
    nodeId: finalClaim.nodeId, workerId: 'worker', attemptId: finalClaim.attemptId,
    leaseGeneration: finalClaim.leaseGeneration,
  });
  campaignStore.completeNode({
    nodeId: finalRunning.nodeId, workerId: 'worker',
    attemptId: finalRunning.attemptId, leaseGeneration: finalRunning.leaseGeneration,
    result: finalCompileNode.result,
  });
  const researchClaim = campaignStore.claimReady({ campaignId, workerId: 'worker', leaseSeconds: 600, limit: 1 })[0];
  const researchRunning = campaignStore.startNode({
    nodeId: researchClaim.nodeId, workerId: 'worker', attemptId: researchClaim.attemptId,
    leaseGeneration: researchClaim.leaseGeneration,
  });
  const sourceSnapshot = inspectWorkspaceExecutionSnapshot(workspace,
    { excludeNames: sourceTreeExcludedNames(workspace) });
  const campaignResearchSourceSnapshot = buildCampaignResearchSourceSnapshot({
    campaignId,
    paperId: 'paper',
    researchNodeId: researchRunning.nodeId,
    researchAttemptId: researchRunning.attemptId,
    researchLeaseGeneration: researchRunning.leaseGeneration,
    verifiedSourceMerkleHash: sourceSnapshot.merkleHash,
    verifiedSourceWorkspaceManifestHash: sourceSnapshot.manifestHash,
    excludedNames: sourceTreeExcludedNames(workspace),
    fileRecords: sourceSnapshot.fileRecords,
    directoryRecords: sourceSnapshot.directoryRecords,
  });
  const researchReport = readyResearchReport({
    researchNodeId: researchRunning.nodeId,
    researchAttemptId: researchRunning.attemptId,
    researchLeaseGeneration: researchRunning.leaseGeneration,
    verifiedSourceMerkleHash: sourceSnapshot.merkleHash,
    verifiedSourceWorkspaceManifestHash: sourceSnapshot.manifestHash,
    campaignResearchSourceSnapshotHash: campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot,
  });
  campaignStore.completeNode({
    nodeId: researchRunning.nodeId, workerId: 'worker',
    attemptId: researchRunning.attemptId, leaseGeneration: researchRunning.leaseGeneration,
    result: readyResearchResult({ campaignId, report: researchReport }),
  });
  const packageClaim = campaignStore.claimReady({ campaignId, workerId: 'worker', leaseSeconds: 600, limit: 1 })[0];
  const packageRunning = campaignStore.startNode({
    nodeId: packageClaim.nodeId, workerId: 'worker', attemptId: packageClaim.attemptId,
    leaseGeneration: packageClaim.leaseGeneration,
  });
  const executor = createCampaignNodeExecutor({
    runtimeRoot, releasePackager,
    agentExecutor: { async execute() { throw new Error('agent_not_expected'); } },
    empiricalExecutor: { execute() { throw new Error('empirical_not_expected'); } },
  });
  const campaign = campaignStore.getCampaign(campaignId);
  const packageResult = await executor.execute({
    campaign, node: packageRunning,
    allNodes: campaignStore.listNodes(campaignId),
    executionBudget, deferWorkspaceIntegration: true,
  });
  const result = packageResult;
  const descriptorHash = result.workspaceAttemptIntegration?.workspaceAttemptIntegrationDescriptorHash;
  if (!descriptorHash) throw new Error('test_campaign_release_workspace_attempt_descriptor_missing');
  const prepared = campaignStore.prepareNodeResult({
    nodeId: packageRunning.nodeId, workerId: 'worker', attemptId: packageRunning.attemptId,
    leaseGeneration: packageRunning.leaseGeneration,
    result, requiresIntegration: true, integrationKey: descriptorHash,
  });
  return { campaignStore, campaign, executor, packageRunning, prepared, result, descriptorHash };
}

async function integratePreparedPackage(preparedPackage) {
  const { campaignStore, campaign, executor, packageRunning, result, descriptorHash } = preparedPackage;
  campaignStore.beginNodeResultIntegration({
    nodeId: packageRunning.nodeId,
    workerId: 'worker',
    attemptId: packageRunning.attemptId,
    leaseGeneration: packageRunning.leaseGeneration,
    integrationKey: descriptorHash,
  });
  const integrationReceipt = executor.integratePrepared({
    campaign,
    node: packageRunning,
    result,
  });
  const integrated = campaignStore.markNodeResultIntegrated({
    nodeId: packageRunning.nodeId,
    workerId: 'worker',
    attemptId: packageRunning.attemptId,
    leaseGeneration: packageRunning.leaseGeneration,
    integrationKey: descriptorHash,
    integrationReceipt,
  });
  return { ...preparedPackage, integrated, integrationReceipt };
}

function completePreparedPackage(preparedPackage) {
  const { campaignStore, packageRunning, prepared } = preparedPackage;
  return campaignStore.completeNode({
    nodeId: packageRunning.nodeId,
    workerId: 'worker',
    attemptId: packageRunning.attemptId,
    leaseGeneration: packageRunning.leaseGeneration,
    preparedResultHash: prepared.preparedResultHash,
  });
}

test('campaign plan packages only after final compile and research verification', () => {
  const paperTask = createPaperTask({
    paperId: 'paper',
    title: 'Campaign release plan fixture',
    sourceWorkspace: '/paper',
    mainTex: '/paper/main.tex',
  });
  const plan = buildPaperCampaignPlan({
    paperId: paperTask.paperId,
    sourceWorkspace: '/paper',
    campaignId: 'campaign',
    maxRounds: 2,
    paperTask,
  });
  const finalCompile = plan.nodes.find((node) => node.kind === 'final-compile');
  const researchVerify = plan.nodes.find((node) => node.kind === 'research-verify');
  const packageNode = plan.nodes.find((node) => node.kind === 'package');
  assert.ok(finalCompile);
  assert.ok(researchVerify);
  assert.ok(researchVerify.dependencies.includes(finalCompile.nodeId));
  assert.deepEqual(packageNode.dependencies, [finalCompile.nodeId, researchVerify.nodeId]);
  assert.equal(finalCompile.language, 'latex');
  assert.equal(packageNode.language, null);
  assert.equal(plan.nodes.at(-1).kind, 'package');
});

test('expired engine budget reaches the real packager without creating a build transaction',
  async (t) => {
    const { workspace, runtimeRoot } = fixture(t);
    const store = createDefaultPaperStore({ root: workspace, runtimeRoot });
    convergeAutonomousSubmissionHandoff({ nativeStore: store, runtimeRoot });
    const context = bootstrapTestAutomationContext({
      root: workspace, runtimeRoot, mode: 'campaign-release-expired-budget-test', execute: true,
      serviceOverrides: { store },
    });
    t.after(() => context.services.persistenceSession.close());
    const releasePackager = createTrustedReleasePackagerFixture({
      context, store, runtimeRoot, fixtureId: 'expired-generation-budget',
    });
    const campaignId = 'expired-generation-budget';
    const observedAtMs = context.services.clock.now().getTime();
    await assert.rejects(() => prepareFencedPackage({
      context, workspace, runtimeRoot, campaignId, releasePackager,
      executionBudget: {
        remainingWallTimeMs: 60_000,
        absoluteDeadlineEpochMs: observedAtMs - 1,
      },
    }), (error) => {
      assert.equal(error?.code, 'campaign_release_execution_budget_exhausted');
      assert.equal(error?.stateRecoverabilityDeferred, true);
      return true;
    });
    for (const directory of ['campaign-releases', 'packages']) {
      const outputRoot = path.join(runtimeRoot, directory);
      assert.deepEqual(fs.existsSync(outputRoot) ? fs.readdirSync(outputRoot) : [], []);
    }
  });

test('submission authority entry composes the normal non-campaign authority inputs', async () => {
  const now = new Date('2026-07-14T00:00:00.000Z');
  const task = createPaperTask({
    paperId: 'paper',
    title: 'Submission authority fixture',
    venueTarget: 'Fixture Journal',
    sourceWorkspace: 'source',
    mainTex: 'source/main.tex',
  });
  const packageVerificationReceiptHash = hashRecord('PackageVerificationReceiptFixture', {});
  const artifactSettlementHash = hashRecord('ArtifactSettlementFixture', {});
  const artifactPackage = {
    version: 1,
    kind: 'PaperArtifactPackage',
    paperId: task.paperId,
    artifactCount: 1,
    submitReady: true,
    artifactPackageHash: hashRecord('ArtifactPackageFixture', {}),
    packageVerificationReceiptHash,
    artifactSettlementStatus: 'artifact_settlement_verified',
    artifactSettlementHash,
    sourceSnapshotHash: hashRecord('SourceSnapshotFixture', {}),
  };
  const promotionInputSnapshotHash = hashRecord('PromotionInputSnapshotFixture', {});
  const researchReport = {
    researchReportHash: hashRecord('ResearchReportFixture', {}),
    capabilities: { promotionInputSnapshot: { promotionInputSnapshotHash } },
    typedContracts: {},
  };
  const packageResult = {
    packageVerificationReceipt: {
      status: 'package_verification_passed',
      packageVerificationReceiptHash,
      artifactSettlement: { status: 'artifact_settlement_verified', artifactSettlementHash },
    },
    manuscriptPromotionGate: {
      status: 'manuscript_promotion_ready',
      manuscriptPromotionGateHash: hashRecord('ManuscriptPromotionGateFixture', {}),
      promotionDependencyClosure: {
        status: 'promotion_dependency_closure_ready',
        promotionDependencyClosureHash: hashRecord('PromotionDependencyClosureFixture', {}),
      },
      promotionInputSnapshotHash,
    },
  };
  const targetScopeReceipt = buildTargetScopeReceipt({
    mode: 'reviewed-submit',
    execute: true,
    requestedPaperIds: [task.paperId],
    selectedTasks: [task],
    inventorySource: 'test-fixture',
    requireExplicitScope: true,
  });
  let independentCall = null;
  let liveCall = null;
  const result = await prepareSubmissionAuthorities({
    root: '/fixture',
    runtimeRoot: '/fixture/runtime',
    row: { task },
    venues: [{ venue_id: 'fixture-journal', name: 'Fixture Journal', kind: 'journal' }],
    artifactPackage,
    packageResult,
    researchReport,
    targetScopeReceipt,
    trustStoreOverride: { version: 1, kind: 'AuthorityTrustStore', keys: [] },
    now,
    submissionMetadata: {
      title: task.title,
      abstract: 'A reviewed submission authority fixture.',
      authors: [{ name: 'Fixture Author' }],
      track: 'main',
      anonymity: 'double_blind',
      keywords: ['verification'],
      subjectAreas: ['systems'],
      conflicts: [],
      supplements: [],
      checklist: { reproducibility: true },
      coverLetter: 'Please consider this manuscript.',
    },
    submissionMetadataReview: {
      reviewedBy: 'human-operator',
      reviewedAt: now.toISOString(),
      reviewActorType: 'human',
      humanConfirmedFields: [
        'title', 'abstract', 'authors', 'track', 'anonymity', 'keywords',
        'subjectAreas', 'conflicts', 'supplements', 'checklist', 'coverLetter',
      ],
    },
    authorityVerifier: {
      async verifyIndependentReferee(input) {
        independentCall = input;
        return {
          status: 'independent_referee_acceptance_verified',
          acceptanceAuthorityReady: true,
          independentRefereeAuthorityReceiptHash: hashRecord('IndependentRefereeReceiptFixture', {}),
          reviewerSubjectIds: ['referee-fixture'],
        };
      },
      async verifyLiveAuthorization(input) {
        liveCall = input;
        return {
          status: 'live_submission_authorization_verified',
          liveExternalActionAuthorized: true,
          liveSubmissionAuthorizationReceiptHash: hashRecord('LiveAuthorizationReceiptFixture', {}),
        };
      },
    },
  });
  assert.equal(result.venuePlan.status, 'local_dry_run_ready');
  assert.equal(result.semanticPromotionLock.status, 'semantic_promotion_unlocked');
  assert.equal(result.submissionDecisionPacket.status, 'reviewed_submission_decision_verified');
  assert.equal(result.campaignReleaseSubmissionInput, null);
  assert.equal(independentCall.sourceRoot, path.join('/fixture', 'source'));
  assert.equal(liveCall.semanticPromotionLock, result.semanticPromotionLock);
  assert.equal(liveCall.submissionDecisionPacket, result.submissionDecisionPacket);
  assert.equal(result.liveAuthorizationReceipt.status, 'live_submission_authorization_verified');
});

test('prepared bundle becomes submission-consumable only through the current completed release authority', async (t) => {
  const { root, workspace, runtimeRoot } = fixture(t);
  const submissionRoot = path.join(root, 'independent-submission-root');
  fs.mkdirSync(submissionRoot, { recursive: true });
  const store = createDefaultPaperStore({ root: workspace, runtimeRoot });
  convergeAutonomousSubmissionHandoff({ nativeStore: store, runtimeRoot });
  const context = bootstrapTestAutomationContext({
    root: workspace,
    runtimeRoot,
    mode: 'campaign-release-test',
    execute: true,
    serviceOverrides: { store },
  });
  t.after(() => context.services.persistenceSession.close());
  const submissionContext = bootstrapSubmissionContext({ root: workspace, runtimeRoot, execute: true });
  t.after(() => submissionContext.services.persistenceSession.close());
  const releasePackager = createTrustedReleasePackagerFixture({
    context,
    store,
    runtimeRoot,
    fixtureId: 'submission-consumable',
  });
  const preparedPackage = await prepareFencedPackage({
    context,
    workspace,
    runtimeRoot,
    releasePackager,
  });
  const first = preparedPackage.result;
  const campaignPlanHash = preparedPackage.campaign.spec.campaignPlanHash;
  const authorityRepository = submissionContext.services.campaignReleaseAuthorityRepository;

  assert.equal(first.status, 'campaign_release_prepared');
  assert.equal(first.submitReady, false);
  assert.equal(first.submissionConsumable, false);
  assert.equal(first.releaseBundle.status, 'campaign_release_bundle_prepared');
  assert.equal(first.releaseBundle.artifactPackage.submitReady, true);
  assert.equal(first.releaseBundle.packageVerificationReceipt.status, 'package_verification_passed');
  assert.equal(first.releaseBundle.packageOutput.immutable, true);
  assert.equal(first.releaseBundle.researchEvidenceCapsuleManifest.status, 'research_evidence_capsule_ready');
  assert.equal(first.releaseBundle.researchEvidenceCapsuleManifest.empiricalEvidenceIncluded, false);
  const packageDir = first.releaseBundle.packageOutput.packageDir;
  const offlineVerification = verifyCampaignReleaseEvidenceCapsuleDirectory({
    packageDir,
    expected: {
      campaignId: 'campaign',
      paperId: 'paper',
      researchReportHash: first.releaseBundle.researchReportHash,
      experimentRegistryHash: first.releaseBundle.experimentRegistryHash,
    },
  });
  assert.equal(offlineVerification.status, 'research_evidence_capsule_verification_passed', JSON.stringify(offlineVerification.blockers));
  const copiedPackageDir = path.join(root, 'copied-release-package');
  fs.cpSync(packageDir, copiedPackageDir, { recursive: true });
  assert.equal(verifyCampaignReleaseEvidenceCapsuleDirectory({ packageDir: copiedPackageDir }).valid, true);
  const capsuleText = fs.readdirSync(path.join(copiedPackageDir, 'evidence'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => fs.readFileSync(path.join(copiedPackageDir, 'evidence', name), 'utf8')).join('\n');
  assert.doesNotMatch(capsuleText, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(capsuleText, new RegExp(runtimeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(capsuleText, /"(?:scopeRoot|casRoot|privateKey|harnessDefinition|oracle)"\s*:/);
  const portablePackageRecord = fs.readFileSync(path.join(copiedPackageDir, 'PACKAGE_RECORD.json'), 'utf8');
  assert.doesNotMatch(portablePackageRecord, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(portablePackageRecord, new RegExp(runtimeRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const capsuleSums = fs.readFileSync(path.join(copiedPackageDir, 'SHA256SUMS.txt'), 'utf8');
  assert.match(capsuleSums, /  evidence\/CAPSULE_MANIFEST\.json$/m);
  assert.match(capsuleSums, /  evidence\/PUBLIC_AUTHORITY_TRUST_SNAPSHOT\.json$/m);
  assert.match(first.releaseBundle.researchEvidenceCapsuleManifest.publicAuthorityTrustSnapshotHash, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(capsuleSums, /campaign-releases|\/runtime\//);
  const releaseCandidate = first.releaseBundle.promotionCandidate;
  const authoritativeNodes = preparedPackage.campaignStore.listNodes('campaign');
  const finalCompileNode = authoritativeNodes.find(
    (candidate) => candidate.kind === 'final-compile',
  );
  const researchVerifyNode = authoritativeNodes.find(
    (candidate) => candidate.kind === 'research-verify',
  );
  const fakeGpuPlan = Object.freeze({
    version: 1,
    kind: 'GpuScientificCampaignExecutionPlan',
    gpuScientificCampaignExecutionPlanHash:
      hashRecord('GpuScientificCampaignExecutionPlanFixture', {}),
  });
  const fakeResearchEvidence = (label) => {
    const authorityPayload = {
      valid: true,
      cryptographicSignaturesVerified: true,
      qualificationEvidenceHash:
        hashRecord('GpuScientificQualificationEvidenceFixture', { label }),
    };
    const authorityInspection = {
      ...authorityPayload,
      gpuScientificCampaignQualificationAuthorityInspectionHash: hashRecord(
        'GpuScientificCampaignQualificationAuthorityInspection',
        authorityPayload,
      ),
    };
    const payload = {
      version: 1,
      kind: 'CampaignResearchGpuScientificEvidence',
      executionResultHash:
        hashRecord('GpuScientificExecutionResultFixture', { label }),
      artifactArchiveManifestHash:
        hashRecord('GpuScientificArtifactArchiveFixture', { label }),
      qualificationEvidenceHash: authorityPayload.qualificationEvidenceHash,
      authorityInspection,
    };
    return {
      ...payload,
      campaignResearchGpuScientificEvidenceHash: hashRecord(
        'CampaignResearchGpuScientificEvidence',
        payload,
      ),
    };
  };
  const authoritativeGpuResearchEvidence = fakeResearchEvidence('authority');
  const researchResultWithGpuAuthority = {
    ...researchVerifyNode.result,
    gpuScientificCampaignExecutionResultHash:
      authoritativeGpuResearchEvidence.executionResultHash,
    gpuScientificArtifactBodyArchiveManifestHash:
      authoritativeGpuResearchEvidence.artifactArchiveManifestHash,
    gpuScientificCampaignQualificationEvidenceHash:
      authoritativeGpuResearchEvidence.qualificationEvidenceHash,
    gpuScientificQualificationEvidence: authoritativeGpuResearchEvidence,
  };
  const researchNodeWithGpuAuthority = {
    ...researchVerifyNode,
    result: researchResultWithGpuAuthority,
    resultSha256: hashRecord(
      'PaperCampaignNodeResult',
      researchResultWithGpuAuthority,
    ),
  };
  const gpuCandidateInput = {
    campaignPlanHash: releaseCandidate.campaignPlanHash,
    campaignId: releaseCandidate.campaignId,
    paperId: releaseCandidate.paperId,
    venueTarget: releaseCandidate.venueTarget,
    packageNode: preparedPackage.packageRunning,
    finalCompileNode,
    researchVerifyNode: researchNodeWithGpuAuthority,
    researchReport: first.releaseBundle.researchReport,
    campaignResearchSourceSnapshot:
      releaseCandidate.campaignResearchSourceSnapshot,
    verifiedSourceMerkleHash: releaseCandidate.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash:
      releaseCandidate.verifiedSourceWorkspaceManifestHash,
    sourceWorkspace: releaseCandidate.sourceWorkspace,
    sourceSnapshotHash: releaseCandidate.sourceSnapshotHash,
    sourceTreeManifest: releaseCandidate.sourceTreeManifest,
    researchEvidenceCapsuleManifest:
      first.releaseBundle.researchEvidenceCapsuleManifest,
    researchEvidenceCapsuleManifestFileHash:
      first.releaseBundle.packageOutput
        .researchEvidenceCapsuleManifestFileHash,
    researchExecutionReleaseAttestation:
      first.releaseBundle.researchExecutionReleaseAttestation,
    autonomousResearchReleaseBinding:
      releaseCandidate.autonomousResearchReleaseBinding,
    gpuScientificExecutionPlan: fakeGpuPlan,
    gpuScientificExecutionEvidence: {},
    gpuScientificPromotionEvidence: {},
    createdAt: releaseCandidate.createdAt,
  };
  assert.throws(() => createAutomationPromotionCandidate({
    ...gpuCandidateInput,
    gpuScientificResearchEvidence: null,
  }), /automation_promotion_gpu_scientific_research_evidence_binding_invalid/);
  assert.throws(() => createAutomationPromotionCandidate({
    ...gpuCandidateInput,
    gpuScientificResearchEvidence: fakeResearchEvidence('spliced'),
  }), /automation_promotion_gpu_scientific_research_evidence_binding_invalid/);
  assert.throws(() => createAutomationPromotionCandidate({
    ...gpuCandidateInput,
    researchVerifyNode,
    gpuScientificResearchEvidence: fakeResearchEvidence('self-declared'),
  }), /automation_promotion_gpu_scientific_research_evidence_binding_invalid/);
  const incompleteGpuPlan = {
    version: 1,
    kind: 'GpuScientificCampaignExecutionPlan',
    gpuScientificCampaignExecutionPlanHash:
      hashRecord('IncompleteGpuScientificCampaignExecutionPlanFixture', {}),
  };
  const missingGpuEvidenceCandidate = rehashAutomationPromotionCandidate({
    ...first.releaseBundle.promotionCandidate,
    gpuScientificExecutionPlanHash:
      incompleteGpuPlan.gpuScientificCampaignExecutionPlanHash,
    gpuScientificExecutionPlan: incompleteGpuPlan,
  });
  assert.throws(() => createCampaignReleaseBundle({
    promotionCandidate: missingGpuEvidenceCandidate,
    artifactPackage: first.releaseBundle.artifactPackage,
    packageVerificationReceipt: first.releaseBundle.packageVerificationReceipt,
    manuscriptPromotionGate: first.releaseBundle.manuscriptPromotionGate,
    researchReport: first.releaseBundle.researchReport,
    researchEvidenceCapsuleManifest:
      first.releaseBundle.researchEvidenceCapsuleManifest,
    researchExecutionReleaseAttestation:
      first.releaseBundle.researchExecutionReleaseAttestation,
    packageOutput: first.releaseBundle.packageOutput,
    createdAt: first.releaseBundle.createdAt,
  }), /campaign_release_gpu_scientific_evidence_invalid/);

  const forgedGpuEvidence = {
    version: 1,
    kind: 'GpuScientificCampaignExecutionResult',
    promotionEligible: true,
    productionQualified: true,
    gpuScientificCampaignExecutionResultHash:
      hashRecord('ForgedGpuScientificCampaignExecutionResultFixture', {}),
  };
  const forgedGpuCandidate = rehashAutomationPromotionCandidate({
    ...first.releaseBundle.promotionCandidate,
    gpuScientificExecutionPlanHash:
      incompleteGpuPlan.gpuScientificCampaignExecutionPlanHash,
    gpuScientificCampaignExecutionResultHash:
      forgedGpuEvidence.gpuScientificCampaignExecutionResultHash,
    gpuScientificExecutionPlan: incompleteGpuPlan,
    gpuScientificExecutionEvidence: forgedGpuEvidence,
  });
  const forgedGpuBundle = rehashCampaignReleaseBundle({
    ...first.releaseBundle,
    automationPromotionCandidateHash:
      forgedGpuCandidate.automationPromotionCandidateHash,
    promotionCandidate: forgedGpuCandidate,
    gpuScientificExecutionPlanHash:
      forgedGpuCandidate.gpuScientificExecutionPlanHash,
    gpuScientificCampaignExecutionResultHash:
      forgedGpuCandidate.gpuScientificCampaignExecutionResultHash,
    gpuScientificExecutionPlan: incompleteGpuPlan,
    gpuScientificExecutionEvidence: forgedGpuEvidence,
  });
  const forgedGpuVerification = verifyCampaignReleaseBundle(forgedGpuBundle);
  assert.equal(forgedGpuVerification.valid, false);
  assert.ok(forgedGpuVerification.blockers.includes(
    'campaign_release_gpu_scientific_evidence_invalid',
  ));
  assert.equal(forgedGpuVerification.blockers.includes(
    'campaign_release_bundle_hash_invalid',
  ), false);
  assert.equal(forgedGpuVerification.blockers.includes(
    'automation_promotion_candidate_hash_invalid',
  ), false);
  const { immutableCampaignPackageOutputHash: _outputHash, ...inconsistentOutputPayload } = first.releaseBundle.packageOutput;
  inconsistentOutputPayload.sourceZipHash = 'sha256:inconsistent-source-archive';
  const inconsistentOutput = {
    ...inconsistentOutputPayload,
    immutableCampaignPackageOutputHash: hashRecord('ImmutableCampaignPackageOutput', inconsistentOutputPayload),
  };
  assert.throws(() => createCampaignReleaseBundle({
    promotionCandidate: first.releaseBundle.promotionCandidate,
    artifactPackage: first.releaseBundle.artifactPackage,
    packageVerificationReceipt: first.releaseBundle.packageVerificationReceipt,
    manuscriptPromotionGate: first.releaseBundle.manuscriptPromotionGate,
    researchReport: first.releaseBundle.researchReport,
    researchEvidenceCapsuleManifest: first.releaseBundle.researchEvidenceCapsuleManifest,
    packageOutput: inconsistentOutput,
    createdAt: first.releaseBundle.createdAt,
  }), /campaign_release_immutable_package_output_required/);
  assert.equal(authorityRepository.getCurrentRelease({ campaignId: 'campaign' }), null);
  assert.throws(() => consumeCampaignReleaseBundleForSubmission({
    releaseBundle: first.releaseBundle,
    runtimeRoot,
    sourceScopeRoots: [workspace, runtimeRoot],
  }), /campaign_release_raw_bundle_consumption_forbidden/);

  const integrated = await integratePreparedPackage(preparedPackage);
  assert.equal(authorityRepository.getCurrentRelease({ campaignId: 'campaign' }), null);
  completePreparedPackage(integrated);
  const authority = authorityRepository.getCurrentRelease({
    campaignId: 'campaign',
    paperId: 'paper',
    campaignPlanHash,
    packageNodeId: preparedPackage.packageRunning.nodeId,
    packageAttemptId: preparedPackage.packageRunning.attemptId,
    leaseGeneration: preparedPackage.packageRunning.leaseGeneration,
    packageResultHash: preparedPackage.prepared.preparedResultHash,
    integrationDescriptorHash: integrated.descriptorHash,
    integrationReceiptHash: integrated.integrationReceipt.workspaceAttemptIntegrationReceiptHash,
  });
  assert.equal(authority.status, 'current_completed_release');
  assert.equal(authority.packageNodeStatus, 'completed');
  assert.equal(authority.campaignStatus, 'completed');
  assert.equal(authority.promotionReceipt.submissionConsumable, true);
  assert.equal(authority.verifiedSourceMerkleHash, first.releaseBundle.verifiedSourceMerkleHash);
  assert.equal(authority.verifiedSourceWorkspaceManifestHash, first.releaseBundle.verifiedSourceWorkspaceManifestHash);
  assert.equal(authority.promotionReceipt.verifiedSourceMerkleHash, first.releaseBundle.verifiedSourceMerkleHash);
  assert.deepEqual(first.releaseBundle.promotionCandidate.sourceTreeManifest.rows.map((row) => row.path).sort(), ['SOURCE_PACKAGE_CONTRACT.json', 'main.tex']);
  assert.equal(authorityRepository.promoteCompletedRelease({ campaignId: 'campaign' }).promotionReceipt.campaignReleasePromotionReceiptHash, authority.promotionReceipt.campaignReleasePromotionReceiptHash);
  const exportObservedAt = new Date();
  const exportLifecycle = buildSubmissionHandoffExportLifecycleFixture({ artifactPackage: first.releaseBundle.artifactPackage, manuscriptPromotionGate: first.releaseBundle.manuscriptPromotionGate, campaignId: 'campaign', now: exportObservedAt });
  persistSubmissionHandoffExportLifecycle({ store, records: exportLifecycle, clock: Object.freeze({ now: () => new Date(exportObservedAt), nowIso: () => exportLifecycle.createdAt }) });
  const productionExportRequestPath = path.join(root, 'production-submission-handoff-request.json');
  fs.writeFileSync(productionExportRequestPath, JSON.stringify(exportLifecycle.request));
  const productionExportRoot = path.join(root, 'production-submission-handoff-bundle');
  const productionExport = await executeSubmissionHandoffExport({
    root: workspace, runtimeRoot, campaignId: 'campaign',
    bundleRoot: productionExportRoot, requestPath: productionExportRequestPath,
    serviceOverrides: {
      providerCapabilitySignatureRevalidator:
        createProviderCapabilityCurrentSignatureRevalidatorFixture(
          exportLifecycle,
        ),
    },
  });
  assert.equal(productionExport.status, 'submission_handoff_export_completed', JSON.stringify(productionExport.blockers));
  assert.equal(productionExport.campaignReleaseBundleHash, first.releaseBundle.campaignReleaseBundleHash);
  assert.equal(productionExport.bundleExportReceipt.status, 'submission_handoff_bundle_exported');
  assert.equal(productionExport.externalActionPerformed, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(productionExportRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'), 'utf8')).sealedPackageOutput.immutableCampaignPackageOutputHash, first.releaseBundle.packageOutput.immutableCampaignPackageOutputHash);
  const recoveredProductionExport = await executeSubmissionHandoffExport({ root: workspace, runtimeRoot, campaignId: 'campaign', bundleRoot: productionExportRoot, requestPath: productionExportRequestPath, serviceOverrides: { providerCapabilitySignatureRevalidator: createProviderCapabilityCurrentSignatureRevalidatorFixture(exportLifecycle) } });
  assertSubmissionHandoffDetachedRecoveryConsistency(productionExport, recoveredProductionExport);

  // Reconstruct a missing projection through the strict StorePort mutation path.
  const removedProjection = store.execute("DELETE FROM campaign_current_releases WHERE campaign_id='campaign';");
  assert.equal(removedProjection.ok, true);
  assert.equal(authorityRepository.getCurrentRelease({ campaignId: 'campaign' }), null);
  let mutationInput = null;
  const mutationStore = Object.freeze({
    query: store.query.bind(store), execute: store.execute.bind(store),
    mutate(input) {
      mutationInput = input;
      const value = input.mutate(Object.freeze({ run() { authorityRepository.promoteCompletedRelease({ campaignId: 'campaign' }); return Object.freeze({ changes: 1 }); } }));
      return Object.freeze({ status: 'externally_fenced_sqlite_mutation_finalized', value });
    },
  });
  const recoveredAuthority = createCampaignReleaseAuthorityRepositoryFixture({ store: mutationStore, clock: context.services.clock, runtimeRoot }).promoteCompletedRelease({ campaignId: 'campaign' });
  assert.equal(mutationInput.databaseRole, 'native-store');
  assert.equal(mutationInput.operationId, 'native-store.campaign-release-authority-repository.promoteCompletedRelease.v1');
  assert.equal(mutationInput.packageDeletionWriterSelector.packagePath, packageDir);
  assert.equal(recoveredAuthority.status, 'current_completed_release');
  assert.equal(recoveredAuthority.promotionReceipt.campaignReleasePromotionReceiptHash, authority.promotionReceipt.campaignReleasePromotionReceiptHash);
  assert.equal(recoveredAuthority.campaignReleaseBundleHash, authority.campaignReleaseBundleHash);

  const verified = verifyCampaignReleaseBundleForSubmission({
    releaseAuthority: authority,
    expected: { campaignId: 'campaign', paperId: 'paper', campaignPlanHash },
    runtimeRoot,
    sourceScopeRoots: [workspace, runtimeRoot],
  });
  assert.equal(verified.status, 'submission_campaign_release_verified', JSON.stringify(verified.blockers));

  const handoffArtifactPackage = first.releaseBundle.artifactPackage;
  const handoffPackageVerification = first.releaseBundle.packageVerificationReceipt;
  const handoffManifest = {
    status: 'ready_for_adapter',
    paperId: 'paper',
    taskKey: 'paper:campaign-release-handoff',
    manifestHash: hashRecord('CampaignReleaseHandoffManifestFixture', {}),
    payload: { artifactPackageHash: handoffArtifactPackage.artifactPackageHash },
  };
  const handoffEnvelope = {
    status: 'dry_run_ready',
    envelopeHash: hashRecord('CampaignReleaseHandoffEnvelopeFixture', {}),
    manifestHash: handoffManifest.manifestHash,
  };
  const replayGuard = {
    status: 'dry_run_replay_allowed',
    submissionReplayGuardHash: hashRecord('CampaignReleaseReplayGuardFixture', {}),
    manifestHash: handoffManifest.manifestHash,
  };
  const reviewedPreflight = {
    status: 'reviewed_submit_preflight_ready_for_external_executor',
    reviewedSubmitPreflightPacketHash:
      hashRecord('CampaignReleaseReviewedPreflightFixture', {}),
    outboxHash: hashRecord('CampaignReleaseOutboxFixture', {}),
  };
  const reviewedDecision = {
    status: 'reviewed_submission_decision_verified',
    reviewedSubmissionDecisionPacketHash:
      hashRecord('CampaignReleaseReviewedDecisionFixture', {}),
    metadata: { title: 'Campaign release handoff fixture' },
  };
  const dispatchAuthorization = {
    status: 'submission_dispatch_authorization_ready',
    submissionDispatchAuthorizationHash:
      hashRecord('CampaignReleaseDispatchAuthorizationFixture', {}),
    artifactPackageHash: handoffArtifactPackage.artifactPackageHash,
    preflightHash: reviewedPreflight.reviewedSubmitPreflightPacketHash,
    outboxHash: reviewedPreflight.outboxHash,
    reviewedSubmissionDecisionPacketHash:
      reviewedDecision.reviewedSubmissionDecisionPacketHash,
    provider: 'fixture-provider',
    accountId: 'fixture-account',
    nonce: 'fixture-nonce',
  };
  const handoffBundleRoot = path.join(root, 'submission-handoff-bundle');
  const handoffRepository = createFilesystemArtifactRepository({
    scopeRoot: root,
    casRoot: path.join(root, '.submission-handoff-cas'),
    receiptLedger: { record: () => ({ receiptId: 'handoff-ledger-fixture' }) },
    clock: {
      now: () => new Date('2026-07-14T00:00:00.000Z'),
      nowIso: () => '2026-07-14T00:00:00.000Z',
    },
  });
  const handoffExportInput = {
    artifactPackage: handoffArtifactPackage,
    packageVerificationReceipt: handoffPackageVerification,
    manifest: handoffManifest,
    handoff: handoffEnvelope,
    replayGuard,
    reviewedSubmitPreflightPacket: reviewedPreflight,
    dispatchAuthorization,
    submissionDecisionPacket: reviewedDecision,
    artifactBaseRoot: first.releaseBundle.packageOutput.artifactBaseRoot,
    artifactScopeRoots: [workspace, runtimeRoot],
    campaignReleaseBundle: first.releaseBundle,
    campaignReleaseAuthority: authority,
  };
  const handoffExport = await exportSubmissionHandoffBundle({
    ...handoffExportInput,
    artifactRepository: handoffRepository,
    bundleRoot: handoffBundleRoot,
  });
  assert.equal(
    handoffExport.status,
    'submission_handoff_bundle_exported',
    JSON.stringify(handoffExport.blockers),
  );
  const handoffBundleManifest = JSON.parse(fs.readFileSync(
    path.join(handoffBundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'),
    'utf8',
  ));
  assert.equal(
    handoffBundleManifest.campaignReleaseBundleHash,
    first.releaseBundle.campaignReleaseBundleHash,
  );
  assert.equal(
    handoffBundleManifest.sealedPackageOutput.immutableCampaignPackageOutputHash,
    first.releaseBundle.packageOutput.immutableCampaignPackageOutputHash,
  );
  assert.equal(
    handoffBundleManifest.sealedPackageFileCount,
    first.releaseBundle.packageOutput.fileCount,
  );
  assert.equal(
    handoffBundleManifest.sealedPackageOutput.fileCount,
    first.releaseBundle.packageOutput.fileCount,
  );
  assert.equal(
    handoffBundleManifest.sealedPackageOutput.files.length,
    first.releaseBundle.packageOutput.files.length,
  );
  const sealedSourceByRelative = new Map(first.releaseBundle.packageOutput.files.map(
    (file) => [path.relative(
      first.releaseBundle.packageOutput.packageDir,
      file.path,
    ).replace(/\\/g, '/'), file],
  ));
  for (const copied of handoffBundleManifest.sealedPackageOutput.files) {
    const source = sealedSourceByRelative.get(copied.packageRelativePath);
    assert.ok(source, copied.packageRelativePath);
    assert.deepEqual({
      role: copied.role,
      capsuleRole: copied.capsuleRole,
      executionRole: copied.executionRole,
      experimentId: copied.experimentId,
      hash: copied.hash,
      bytes: copied.bytes,
    }, {
      role: source.role,
      capsuleRole: source.capsuleRole || null,
      executionRole: source.executionRole || null,
      experimentId: source.experimentId || null,
      hash: source.hash,
      bytes: source.bytes,
    });
    const copiedBytes = fs.readFileSync(path.join(
      handoffBundleRoot,
      copied.bundlePath,
    ));
    assert.equal(hashBytes(copiedBytes), source.hash);
    assert.equal(copiedBytes.length, source.bytes);
  }
  assert.equal(
    handoffExport.sealedPackageWriteReceiptHashes.length,
    first.releaseBundle.packageOutput.fileCount,
  );
  const failingBaseRepository = createFilesystemArtifactRepository({
    scopeRoot: root,
    casRoot: path.join(root, '.submission-handoff-failure-cas'),
    receiptLedger: { record: () => ({ receiptId: 'handoff-failure-ledger' }) },
    clock: {
      now: () => new Date('2026-07-14T00:00:00.000Z'),
      nowIso: () => '2026-07-14T00:00:00.000Z',
    },
  });
  let sealedPackageWriteCount = 0;
  const originalFailingLinkSync = fs.linkSync;
  fs.linkSync = (source, target, ...rest) => {
    const parent = fs.realpathSync.native(path.dirname(String(target)));
    if (parent.includes(`${path.sep}sealed-package`)) {
      sealedPackageWriteCount += 1;
      if (sealedPackageWriteCount === 2) {
        throw new Error('injected_handoff_sealed_package_copy_failure');
      }
    }
    return originalFailingLinkSync(source, target, ...rest);
  };
  let failedHandoffExport;
  try {
    failedHandoffExport = await exportSubmissionHandoffBundle({
      ...handoffExportInput,
      artifactRepository: failingBaseRepository,
      bundleRoot: path.join(root, 'failed-submission-handoff-bundle'),
    });
  } finally {
    fs.linkSync = originalFailingLinkSync;
  }
  assert.equal(failedHandoffExport.status, 'submission_handoff_bundle_blocked');
  assert.deepEqual(failedHandoffExport.blockers, [
    'handoff_sealed_package_copy_invalid:injected_handoff_sealed_package_copy_failure',
  ]);
  assert.equal(failedHandoffExport.localFilesystemMutationPerformed, true);
  assert.equal(failedHandoffExport.externalActionPerformed, false);

  const exportWithManifestMutation = async (label, bundleRoot, mutate) => {
    const base = createFilesystemArtifactRepository({
      scopeRoot: root,
      casRoot: path.join(root, `.submission-handoff-${label}-cas`),
      receiptLedger: { record: () => ({ receiptId: `handoff-${label}-ledger` }) },
      clock: {
        now: () => new Date('2026-07-14T00:00:00.000Z'),
        nowIso: () => '2026-07-14T00:00:00.000Z',
      },
    });
    const originalLinkSync = fs.linkSync;
    let mutated = false;
    fs.linkSync = (source, target, ...rest) => {
      const write = originalLinkSync(source, target, ...rest);
      if (!mutated
        && path.basename(String(target)) === 'SUBMISSION_HANDOFF_MANIFEST.json') {
        mutated = true;
        mutate(fs.realpathSync.native(path.dirname(String(target))));
      }
      return write;
    };
    try {
      const receipt = await exportSubmissionHandoffBundle({
        ...handoffExportInput,
        artifactRepository: base,
        bundleRoot,
      });
      assert.equal(mutated, true);
      return receipt;
    } finally {
      fs.linkSync = originalLinkSync;
    }
  };
  for (const targetKind of ['artifact', 'sealed-package']) {
    const attackedBundleRoot = path.join(
      root,
      `manifest-mutates-${targetKind}-bundle`,
    );
    const attackedExport = await exportWithManifestMutation(
      targetKind,
      attackedBundleRoot,
      (stagingRoot) => {
        const relative = targetKind === 'artifact'
          ? path.join('artifacts', fs.readdirSync(
            path.join(stagingRoot, 'artifacts'),
          )[0])
          : path.join(
            'sealed-package',
            path.relative(
              first.releaseBundle.packageOutput.packageDir,
              first.releaseBundle.packageOutput.files[0].path,
            ),
          );
        const candidate = path.join(stagingRoot, relative);
        fs.chmodSync(candidate, 0o644);
        fs.appendFileSync(candidate, 'manifest-write-tamper');
      },
    );
    assert.equal(attackedExport.status, 'submission_handoff_bundle_blocked');
    assert.equal(attackedExport.localFilesystemMutationPerformed, true);
    assert.equal(attackedExport.externalActionPerformed, false);
    assert.ok(attackedExport.blockers.some((blocker) => blocker.startsWith(
      'handoff_bundle_sealing_invalid:',
    )));
  }
  const sourceMutationRoot = path.join(root, 'manifest-mutates-release-source');
  const releaseSourceFile = first.releaseBundle.packageOutput.files[0];
  let sourceMutationExport;
  try {
    sourceMutationExport = await exportWithManifestMutation(
      'release-source',
      sourceMutationRoot,
      () => fs.chmodSync(releaseSourceFile.path, 0o644),
    );
  } finally {
    fs.chmodSync(releaseSourceFile.path, 0o444);
  }
  assert.equal(sourceMutationExport.status, 'submission_handoff_bundle_blocked');
  assert.equal(sourceMutationExport.localFilesystemMutationPerformed, true);
  assert.equal(sourceMutationExport.externalActionPerformed, false);
  assert.ok(sourceMutationExport.blockers.some((blocker) => blocker.startsWith(
    'campaign_release_package_output_seal_invalid:',
  )));

  const consumed = consumeCampaignReleaseBundleForSubmission({
    releaseAuthorityRepository: authorityRepository,
    campaignId: 'campaign',
    expected: { campaignId: 'campaign', paperId: 'paper', campaignPlanHash },
    runtimeRoot,
    sourceScopeRoots: [workspace, runtimeRoot],
  });
  assert.equal(consumed.status, 'campaign_release_submission_input_ready');
  assert.equal(consumed.venueTarget, 'Fixture Journal');
  assert.equal(consumed.verificationReceipt.venueTarget, 'Fixture Journal');
  assert.equal(consumed.artifactPackage.artifactPackageHash, first.releaseBundle.artifactPackageHash);
  assert.equal(consumed.releaseAuthority.packageAttemptId, preparedPackage.packageRunning.attemptId);
  assert.equal(consumed.releaseAuthority.materializationReceipt.status, 'campaign_release_bundle_materialized');

  const submissionTask = createPaperTask({
    paperId: 'paper',
    venueTarget: 'Fixture Journal',
    sourceWorkspace: workspace,
    mainTex: path.join(workspace, 'main.tex'),
  });
  let delegatedAuthorityCalls = 0;
  const authorityVerifier = {
    async verifyIndependentReferee() {
      delegatedAuthorityCalls += 1;
      return {
        status: 'independent_referee_authority_blocked',
        acceptanceAuthorityReady: false,
        blockers: ['test_fixture_has_no_referee_authority'],
      };
    },
    async verifyLiveAuthorization({ artifactPackage: delegatedPackage }) {
      delegatedAuthorityCalls += 1;
      assert.equal(delegatedPackage.artifactPackageHash, consumed.artifactPackage.artifactPackageHash);
      return {
        status: 'live_submission_authorization_blocked',
        liveExternalActionAuthorized: false,
        blockers: ['test_fixture_has_no_live_authorization'],
      };
    },
  };
  const preparedAuthorities = await prepareSubmissionAuthorities({
    root: workspace,
    runtimeRoot,
    row: { task: submissionTask },
    venues: [{ venue_id: 'fixture-journal', name: 'Fixture Journal', kind: 'journal' }],
    packageResult: first,
    campaignReleaseAuthorityRepository: authorityRepository,
    trustStoreOverride: { version: 1, kind: 'AuthorityTrustStore', keys: [] },
    authorityVerifier,
    now: new Date('2026-07-14T00:00:00.000Z'),
  });
  assert.equal(preparedAuthorities.campaignReleaseSubmissionInput.status, 'campaign_release_submission_input_ready');
  assert.equal(
    preparedAuthorities.campaignReleaseSubmissionInput.releaseAuthority.campaignReleaseBundleHash,
    authority.campaignReleaseBundleHash,
  );
  assert.equal(preparedAuthorities.venuePlan.artifactPackageHash, consumed.artifactPackage.artifactPackageHash);
  assert.equal(delegatedAuthorityCalls, 2);

  await assert.rejects(
    prepareSubmissionAuthorities({
      root: workspace,
      runtimeRoot,
      row: { task: submissionTask },
      artifactPackage: {
        ...consumed.artifactPackage,
        artifactPackageHash: hashRecord('ConflictingSubmissionArtifactPackage', {}),
      },
      packageResult: first,
      campaignReleaseAuthorityRepository: authorityRepository,
      trustStoreOverride: { version: 1, kind: 'AuthorityTrustStore', keys: [] },
      authorityVerifier,
    }),
    /submission_campaign_release_artifact_package_mismatch/,
  );
  assert.equal(delegatedAuthorityCalls, 2);

  const emptyReleaseAuthorityRepository = {
    version: 1,
    promoteCompletedRelease() { throw new Error('not_expected'); },
    getCurrentRelease() { return null; },
  };
  await assert.rejects(
    prepareSubmissionAuthorities({
      root: workspace,
      runtimeRoot,
      row: { task: submissionTask },
      packageResult: first,
      campaignReleaseAuthorityRepository: emptyReleaseAuthorityRepository,
      trustStoreOverride: { version: 1, kind: 'AuthorityTrustStore', keys: [] },
      authorityVerifier,
    }),
    (error) => error?.code === 'submission_campaign_release_blocked'
      && error.receipt?.blockers?.includes('campaign_release_authority_required'),
  );
  assert.equal(delegatedAuthorityCalls, 2);

  const attemptWorkspace = first.workspaceAttemptIntegration.attemptWorkspace;
  assert.equal(first.releaseBundle.promotionCandidate.sourceWorkspace, attemptWorkspace);
  assert.equal(fs.existsSync(attemptWorkspace), true);
  fs.rmSync(attemptWorkspace, { recursive: true, force: true });
  const consumedAfterAttemptCleanup = consumeCampaignReleaseBundleForSubmission({
    releaseAuthorityRepository: authorityRepository,
    campaignId: 'campaign',
    expected: { campaignId: 'campaign', paperId: 'paper', campaignPlanHash },
    runtimeRoot,
  });
  assert.equal(consumedAfterAttemptCleanup.status, 'campaign_release_submission_input_ready');
  assert.equal(consumedAfterAttemptCleanup.verificationReceipt.sourceAuthority, 'immutable_generated_source_zip');
  assert.equal(consumedAfterAttemptCleanup.verificationReceipt.mutableSourceWorkspaceConsulted, false);
  const cliHandoff = runSubmissionHandoffCli({ campaignId: 'campaign', root: submissionRoot, runtimeRoot });
  assert.equal(cliHandoff.status, 0, cliHandoff.stderr);
  const cliInput = JSON.parse(cliHandoff.stdout);
  assert.equal(cliInput.kind, 'CampaignReleaseSubmissionInput');
  assert.equal(cliInput.status, 'campaign_release_submission_input_ready');
  assert.equal(cliInput.campaignId, 'campaign');
  assert.equal(cliInput.venueTarget, 'Fixture Journal');
  assert.equal(cliInput.packageAttemptId, preparedPackage.packageRunning.attemptId);
  assert.equal(cliInput.verificationReceipt.mutableSourceWorkspaceConsulted, false);
  assert.equal(cliInput.externalActionPerformed, false);

  const missingCli = runSubmissionHandoffCli({ campaignId: 'missing-release', root: submissionRoot, runtimeRoot });
  assert.notEqual(missingCli.status, 0);
  assert.match(missingCli.stderr, /campaign_release_submission_handoff_blocked/);
  assert.match(missingCli.stderr, /campaign_release_authority_required/);

  const materializedBundlePath = authority.materializationReceipt.path;
  const materializedBundleBytes = fs.readFileSync(materializedBundlePath);
  fs.chmodSync(materializedBundlePath, 0o600);
  fs.appendFileSync(materializedBundlePath, 'tamper');
  const materializedTamper = verifyCampaignReleaseBundleForSubmission({ releaseAuthority: authority, runtimeRoot });
  assert.ok(materializedTamper.blockers.includes('campaign_release_materialized_bundle_hash_mismatch'));
  fs.writeFileSync(materializedBundlePath, materializedBundleBytes, { mode: 0o444 });
  fs.chmodSync(materializedBundlePath, 0o444);

  const lineageTamper = structuredClone(authority);
  lineageTamper.releaseBundle.campaignPlanHash = 'sha256:tampered-plan';
  assert.ok(verifyCampaignReleaseBundleForSubmission({ releaseAuthority: lineageTamper, runtimeRoot, sourceScopeRoots: [workspace, runtimeRoot] }).blockers.includes('campaign_release_bundle_hash_invalid'));
  const sourceMirrorTamper = structuredClone(first.releaseBundle);
  sourceMirrorTamper.verifiedSourceMerkleHash = hashRecord('TamperedReleaseSource', {});
  const { campaignReleaseBundleHash: _sourceMirrorHash, ...sourceMirrorPayload } = sourceMirrorTamper;
  sourceMirrorTamper.campaignReleaseBundleHash = hashRecord('CampaignReleaseBundle', sourceMirrorPayload);
  const sourceMirrorVerification = verifyCampaignReleaseBundle(sourceMirrorTamper);
  assert.equal(sourceMirrorVerification.valid, false);
  assert.ok(sourceMirrorVerification.blockers.includes('campaign_release_candidate_lineage_mismatch'));
  assert.ok(sourceMirrorVerification.blockers.includes('campaign_release_source_archive_merkle_mismatch'));
  const artifactTamper = structuredClone(authority);
  artifactTamper.releaseBundle.artifactPackage.artifacts[0].hash = 'sha256:tampered-artifact';
  assert.ok(verifyCampaignReleaseBundleForSubmission({ releaseAuthority: artifactTamper, runtimeRoot, sourceScopeRoots: [workspace, runtimeRoot] }).blockers.includes('campaign_release_artifact_package_hash_invalid'));
  const staleAuthority = structuredClone(authority);
  staleAuthority.leaseGeneration += 1;
  assert.ok(verifyCampaignReleaseBundleForSubmission({ releaseAuthority: staleAuthority, runtimeRoot, sourceScopeRoots: [workspace, runtimeRoot] }).blockers.includes('campaign_release_authority_leaseGeneration_binding_mismatch'));
  const experimentMirrorTamper = structuredClone(authority);
  const { campaignReleasePromotionReceiptHash: _promotionHash, ...promotionPayload } = experimentMirrorTamper.promotionReceipt;
  promotionPayload.experimentRegistryHash = hashRecord('TamperedExperimentRegistry', {});
  experimentMirrorTamper.promotionReceipt = {
    ...promotionPayload,
    campaignReleasePromotionReceiptHash: hashRecord('CampaignReleasePromotionReceipt', promotionPayload),
  };
  experimentMirrorTamper.experimentRegistryHash = promotionPayload.experimentRegistryHash;
  assert.ok(verifyCampaignReleaseBundleForSubmission({
    releaseAuthority: experimentMirrorTamper,
    runtimeRoot,
    sourceScopeRoots: [workspace, runtimeRoot],
  }).blockers.includes('campaign_release_authority_experiment_registry_binding_mismatch'));

  const sealedPackageDir = first.releaseBundle.packageOutput.packageDir;
  const extraPackageFile = path.join(sealedPackageDir, 'UNDECLARED_EXTRA.txt');
  fs.chmodSync(sealedPackageDir, 0o755);
  fs.writeFileSync(extraPackageFile, 'undeclared package content');
  const extraFileTamper = verifyCampaignReleaseBundleForSubmission({
    releaseAuthority: authority,
    runtimeRoot,
    sourceScopeRoots: [workspace, runtimeRoot],
  });
  assert.ok(extraFileTamper.blockers.includes(
    'campaign_release_package_output_seal_invalid:campaign_release_package_output_exact_tree_invalid',
  ));
  fs.rmSync(extraPackageFile);
  fs.chmodSync(sealedPackageDir, 0o555);

  const sourceZip = first.releaseBundle.packageOutput.files.find((item) => item.role === 'generated_source_zip');
  fs.chmodSync(sourceZip.path, 0o600);
  fs.appendFileSync(sourceZip.path, 'tamper');
  const fileTamper = verifyCampaignReleaseBundleForSubmission({ releaseAuthority: authority, runtimeRoot, sourceScopeRoots: [workspace, runtimeRoot] });
  assert.ok(fileTamper.blockers.includes('campaign_release_package_output_file_hash_mismatch:generated_source_zip'));
  assert.ok(fileTamper.blockers.some((blocker) => (
    blocker.startsWith('campaign_release_package_output_seal_invalid:')
  )));
  const tamperedCli = runSubmissionHandoffCli({ campaignId: 'campaign', root: submissionRoot, runtimeRoot });
  assert.notEqual(tamperedCli.status, 0);
  assert.match(
    tamperedCli.stderr,
    /campaign_release_package_output_(?:file_hash_mismatch|file_invalid):generated_source_zip/,
  );
});

test('release promotion is atomic with fenced completion across a simulated crash', async (t) => {
  const { workspace, runtimeRoot } = fixture(t);
  const store = createDefaultPaperStore({ root: workspace, runtimeRoot });
  convergeAutonomousSubmissionHandoff({ nativeStore: store, runtimeRoot });
  const context = bootstrapTestAutomationContext({ root: workspace, runtimeRoot, execute: true, serviceOverrides: { store } });
  t.after(() => context.services.persistenceSession.close());
  const submissionContext = bootstrapSubmissionContext({ root: workspace, runtimeRoot, execute: true });
  t.after(() => submissionContext.services.persistenceSession.close());
  const releasePackager = createTrustedReleasePackagerFixture({
    context,
    store,
    runtimeRoot,
    fixtureId: 'atomic-crash',
  });
  const prepared = await integratePreparedPackage(await prepareFencedPackage({
    context,
    workspace,
    runtimeRoot,
    campaignId: 'crash',
    releasePackager,
  }));
  assert.equal(store.execute(`CREATE TRIGGER fail_release_promotion BEFORE INSERT ON campaign_current_releases BEGIN SELECT RAISE(ABORT,'simulated_release_promotion_crash'); END;`).ok, true);
  assert.throws(() => completePreparedPackage(prepared), /campaign_node_lease_lost/);
  const afterFailure = prepared.campaignStore.listNodes('crash').find((node) => node.kind === 'package');
  assert.equal(afterFailure.status, 'running');
  assert.equal(prepared.campaignStore.getCampaign('crash').status, 'running');
  assert.equal(store.query(`SELECT count(*) AS count FROM campaign_current_releases WHERE campaign_id='crash';`).rows[0].count, 0);
  assert.equal(prepared.campaignStore.listEvents('crash').some((event) => event.kind === 'campaign_node_completed' && event.nodeId === prepared.packageRunning.nodeId), false);
  assert.equal(store.execute('DROP TRIGGER fail_release_promotion;').ok, true);
  completePreparedPackage(prepared);
  assert.equal(submissionContext.services.campaignReleaseAuthorityRepository.getCurrentRelease({ campaignId: 'crash' }).status, 'current_completed_release');
});

test('cancelled prepared attempts and stale or manually orphaned current rows are rejected', async (t) => {
  const { root, workspace, runtimeRoot } = fixture(t);
  const submissionRoot = path.join(root, 'independent-submission-root');
  fs.mkdirSync(submissionRoot, { recursive: true });
  const store = createDefaultPaperStore({ root: workspace, runtimeRoot });
  convergeAutonomousSubmissionHandoff({ nativeStore: store, runtimeRoot });
  const context = bootstrapTestAutomationContext({ root: workspace, runtimeRoot, execute: true, serviceOverrides: { store } });
  t.after(() => context.services.persistenceSession.close());
  const submissionContext = bootstrapSubmissionContext({ root: workspace, runtimeRoot, execute: true });
  t.after(() => submissionContext.services.persistenceSession.close());
  const releasePackager = createTrustedReleasePackagerFixture({
    context,
    store,
    runtimeRoot,
    fixtureId: 'cancelled-and-stale',
  });
  const cancelled = await prepareFencedPackage({
    context,
    workspace,
    runtimeRoot,
    campaignId: 'cancelled',
    releasePackager,
  });
  cancelled.campaignStore.cancelCampaign('cancelled', 'test_cancelled_after_bundle_prepare');
  assert.equal(cancelled.campaignStore.getCampaign('cancelled').status, 'cancelled');
  assert.equal(submissionContext.services.campaignReleaseAuthorityRepository.getCurrentRelease({ campaignId: 'cancelled' }), null);
  assert.throws(() => consumeCampaignReleaseBundleForSubmission({
    releaseAuthorityRepository: submissionContext.services.campaignReleaseAuthorityRepository,
    campaignId: 'cancelled',
    runtimeRoot,
    sourceScopeRoots: [workspace, runtimeRoot],
  }), /submission_campaign_release_blocked/);
  const cancelledCli = runSubmissionHandoffCli({ campaignId: 'cancelled', root: submissionRoot, runtimeRoot });
  assert.notEqual(cancelledCli.status, 0);
  assert.match(cancelledCli.stderr, /campaign_release_authority_required/);

  const completed = await integratePreparedPackage(await prepareFencedPackage({
    context,
    workspace,
    runtimeRoot,
    campaignId: 'stale',
    releasePackager,
  }));
  completePreparedPackage(completed);
  assert.ok(submissionContext.services.campaignReleaseAuthorityRepository.getCurrentRelease({ campaignId: 'stale' }));
  assert.equal(store.execute(`UPDATE campaign_current_releases SET package_attempt_id='manual-orphan-attempt' WHERE campaign_id='stale';`).ok, true);
  assert.equal(submissionContext.services.campaignReleaseAuthorityRepository.getCurrentRelease({ campaignId: 'stale' }), null);
  assert.throws(() => consumeCampaignReleaseBundleForSubmission({
    releaseAuthorityRepository: submissionContext.services.campaignReleaseAuthorityRepository,
    campaignId: 'stale',
    runtimeRoot,
    sourceScopeRoots: [workspace, runtimeRoot],
  }), /submission_campaign_release_blocked/);
  const staleCli = runSubmissionHandoffCli({ campaignId: 'stale', root: submissionRoot, runtimeRoot });
  assert.notEqual(staleCli.status, 0);
  assert.match(staleCli.stderr, /campaign_release_authority_required/);
});

test('campaign package execution fails closed without an injected typed packager', async (t) => {
  const { workspace, runtimeRoot } = fixture(t);
  const { finalCompileNode, researchVerifyNode, packageNode } = nodes();
  const executor = createCampaignNodeExecutor({
    runtimeRoot,
    agentExecutor: { async execute() { throw new Error('agent_not_expected'); } },
    empiricalExecutor: { execute() { throw new Error('empirical_not_expected'); } },
  });
  await assert.rejects(executor.execute({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { sourceWorkspace: workspace, campaignPlanHash: 'sha256:plan' } },
    node: packageNode,
    allNodes: [finalCompileNode, researchVerifyNode, packageNode],
  }), /campaign_release_packager_required/);
});

test('campaign release architecture keeps formal packaging behind a port', () => {
  const releasePrimitivesSource = fs.readFileSync(new URL('../../paper-adapters/automation/campaign-release-primitives-adapter.mjs', import.meta.url), 'utf8');
  const applicationSource = fs.readFileSync(new URL('../../paper-application/automation/campaign-node-executor.mjs', import.meta.url), 'utf8');
  const orchestrationSource = fs.readFileSync(new URL('../../paper-application/automation/campaign-quality-release-orchestrator.mjs', import.meta.url), 'utf8');
  const compositionSource = fs.readFileSync(new URL('../../paper-composition/automation/campaign-node-execution-composition.mjs', import.meta.url), 'utf8');
  assert.match(releasePrimitivesSource, /campaign-release-packager-port\.mjs/);
  assert.doesNotMatch(releasePrimitivesSource, /build-package\/index\.mjs/);
  assert.match(releasePrimitivesSource, /campaign_release_packager_required/);
  assert.match(applicationSource, /campaignNodeOperation/);
  assert.match(orchestrationSource, /campaign_release_research_promotion_dependency_required/);
  assert.doesNotMatch(`${applicationSource}\n${orchestrationSource}`, /paper-adapters\//);
  assert.match(compositionSource, /createCampaignNodePrimitivesAdapter/);
});

test('campaign release handoff query adapter has no release-promotion authority', () => {
  const queries = [];
  const releaseQuery = createSqliteCampaignReleaseQueryRepository({
    store: {
      query(sql, parameters) {
        queries.push({ sql, parameters });
        return { ok: true, rows: [] };
      },
    },
  });
  assert.equal(releaseQuery.getCurrentRelease({ campaignId: 'missing' }), null);
  assert.deepEqual(queries.map(({ parameters }) => parameters), [['missing']]);
  assert.deepEqual(Object.keys(releaseQuery).sort(), ['getCurrentRelease', 'kind', 'version']);
  assert.equal(Object.hasOwn(releaseQuery, 'promoteCompletedRelease'), false);
  assert.equal(Object.hasOwn(releaseQuery, 'execute'), false);

  const querySource = fs.readFileSync(new URL('../../paper-adapters/persistence/sqlite-campaign-release-query-repository.mjs', import.meta.url), 'utf8');
  const consumerSource = fs.readFileSync(new URL('../../paper-adapters/submission/campaign-release-bundle-consumer.mjs', import.meta.url), 'utf8');
  const handoffSource = fs.readFileSync(submissionHandoffCli, 'utf8');
  assert.doesNotMatch(querySource, /campaign-release-authority-port|promoteCompletedRelease|BEGIN IMMEDIATE|INSERT\s+INTO|\.execute\s*\(/i);
  assert.doesNotMatch(consumerSource, /campaign-release-authority-port/);
  assert.match(handoffSource, /services\.campaignReleaseQuery/);
  assert.doesNotMatch(handoffSource, /services\.campaignReleaseAuthorityRepository/);
});
