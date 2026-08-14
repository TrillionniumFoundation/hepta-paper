import path from 'node:path';
import { createPaperTask } from '../../paper-domain/contracts/workflow-contracts.mjs';
import { buildCampaignResearchSourceSnapshot, verifyCampaignResearchVerificationInput } from '../../paper-domain/automation/campaign-research-contract.mjs';
import { runResearchVerifyAdapter } from '../research-verify/index.mjs';
import { assertCampaignResearchVerifierPort } from '../../paper-ports/campaign-research-verifier-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyExperimentReplayReceipt, verifyExperimentRunReceipt } from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  assertCompletedNodeResult,
  expectedCampaignEmpiricalAttemptId,
  replayProfile,
  sourceClosureTerminal,
} from './campaign-research-verifier-evidence-helpers.mjs';
import { hashWorkspaceFile } from './campaign-node-workspace-support.mjs';
import { inspectWorkspaceExecutionSnapshot, sourceTreeExcludedNames } from '../runtime/execution-snapshot.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { readFinalizedTheoremSpecification } from './theorem-specification-finalizer.mjs';
import {
  assertCompletedCampaignFormalNode,
  verifyCampaignFormalReceipt,
} from './campaign-formal-verification-evidence.mjs';
import {
  issueTrustedFormalCampaignExecutionAuthority,
} from '../research-verify/trusted-formal-producer-contract.mjs';
import { recordCampaignExperimentReceipts } from './campaign-experiment-receipt-recorder.mjs';
import { runCampaignExternalResearchReplay } from './campaign-external-research-replay.mjs';
import { verifyCampaignFormalResearch } from './campaign-formal-research-verifier.mjs';
import {
  verifyCampaignAdvancedNumericalExecutionResult,
} from '../../paper-domain/automation/advanced-numerical-campaign-execution-contract.mjs';
import { requireCampaignResearchGpuScientificEvidence } from './campaign-research-gpu-scientific-evidence.mjs';

export {
  runFencedFormalNativeResearchWorkers,
} from './campaign-formal-research-verifier.mjs';

export function createCampaignResearchVerifier({
  runtimeRoot,
  clock,
  store = null,
  receiptLedger = null,
  artifactRepositoryFactory = null,
  nativeResearchWorkerJobReceiptStore = null,
  trustedResearchReceiptWriters = null,
  campaignStore = null,
  operatorDatasetHarnessAuthorityVerifier = null,
  rawEventRecomputationVerifier = null,
  externalResearchReplay = null,
  trustedFormalSandboxRuntime = null,
  dynamicFormalExecutionAuthority = null,
  dynamicFormalExecutionEnvironment = process.env,
} = {}) {
  if (!runtimeRoot || !clock?.now) throw new Error('campaign research verifier requires runtimeRoot and ClockPort');
  return Object.freeze(assertCampaignResearchVerifierPort({
    version: 1,
    kind: 'CampaignResearchVerifierPort',
    async verify({
      campaign,
      node,
      workspace,
      manuscript,
      formalReviewEnvelope = null,
      theoremSpecification = null,
      formalAuthorReceipts = [],
      formalReviewAgentReceipt = null,
      formalVerificationIteration = 0,
      formalRepairHistory = [],
      typedTheoremObligationBundle = null,
      formalProofSearchPlan = null,
      formalProofSearchCandidate = null,
      formalProofSearchOperationReceipt = null,
      typedTheoremDependencyGraph = null,
      formalTheoremDependencyGraphOperationReceipt = null,
      formalProofSearchAttempts = [],
      formalVerificationReceipt = null,
      verificationScope = null,
      executionSignal = null,
      assertExternalSideEffectReady = null,
    } = {}) {
      if (executionSignal?.aborted) throw new Error('campaign_research_verification_cancelled');
      const effectiveVerificationScope = verificationScope
        || (node?.kind === 'formal-verify' ? 'formal-only' : 'aggregate-research');
      if (!['formal-only', 'aggregate-research'].includes(effectiveVerificationScope)
        || (effectiveVerificationScope === 'formal-only' && node?.kind !== 'formal-verify')
        || (effectiveVerificationScope === 'aggregate-research' && node?.kind !== 'research-verify')) {
        throw new Error('campaign_research_verification_scope_invalid');
      }
      const input = campaign?.spec?.researchVerificationInput;
      const inputVerification = verifyCampaignResearchVerificationInput(input, { paperId: campaign?.paperId });
      if (!inputVerification.valid) {
        const error = new Error(`campaign_research_verification_input_invalid:${inputVerification.blockers.join(',')}`);
        error.retryable = false;
        throw error;
      }
      const original = input.paperTask;
      const paperTask = createPaperTask({
        paperId: original.paperId,
        title: original.title,
        status: original.status,
        venueTarget: campaign.spec.venueTarget || original.venueTarget || null,
        paperType: original.paperType,
        canonicalDir: original.canonicalDir,
        sourceWorkspace: workspace,
        mainTex: path.join(workspace, manuscript),
        registry: original.registry,
        source: original.source,
        evidenceRefs: original.evidenceRefs,
        createdAt: original.createdAt,
        paperQualityProfile: campaign.spec.paperQualityProfile || original.paperQualityProfile || null,
        paperQualityProfiles: campaign.spec.paperQualityProfiles || original.paperQualityProfiles || [],
      });
      const paperQualityProfiles = new Set([
        campaign.spec.paperQualityProfile,
        ...(campaign.spec.paperQualityProfiles || []),
      ].filter(Boolean));
      const formalRequested = paperQualityProfiles.has('formal_theorem_or_proof');
      let authoritativeTheoremSpecification = null;
      if (formalRequested) {
        try {
          authoritativeTheoremSpecification = readFinalizedTheoremSpecification({
            workspace,
            manuscriptPath: manuscript,
            paperId: campaign.paperId,
            campaignId: campaign.campaignId,
            scientificClaimAuthority: campaign.spec.scientificClaimAuthority || null,
            approvedProposalSeed: campaign.spec.approvedProposalSeed || null,
          });
        } catch (error) {
          const specificationError = new Error(`campaign_theorem_specification_invalid:${error?.message || 'unknown'}`);
          specificationError.retryable = false;
          throw specificationError;
        }
      }
      const authoritativeNodes = campaignStore?.listNodes?.(campaign.campaignId) || [];
      const authoritativeResearchNode = authoritativeNodes.find((candidate) => candidate.nodeId === node.nodeId) || null;
      if (!authoritativeResearchNode || authoritativeResearchNode.attemptId !== node.attemptId
        || authoritativeResearchNode.leaseGeneration !== node.leaseGeneration) {
        throw new Error('campaign_research_store_attempt_evidence_invalid');
      }
      const currentSourceLineageHash = hashWorkspaceFile(workspace, manuscript);
      const sourceDatasetRoots = (campaign.spec.datasetMounts || []).map((mount) => path.resolve(String(mount.source || '')))
        .filter((source) => source !== path.resolve(workspace) && isPathWithin(workspace, source));
      const sourceExcludedNames = sourceTreeExcludedNames(workspace);
      const currentExecutionSnapshot = inspectWorkspaceExecutionSnapshot(workspace, {
        excludeRoots: sourceDatasetRoots,
        excludeNames: sourceExcludedNames,
      });
      if (currentExecutionSnapshot.blockers.length) throw new Error('campaign_research_workspace_execution_snapshot_invalid');
      const campaignResearchSourceSnapshot = buildCampaignResearchSourceSnapshot({
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        researchNodeId: authoritativeResearchNode.nodeId,
        researchAttemptId: authoritativeResearchNode.attemptId,
        researchLeaseGeneration: authoritativeResearchNode.leaseGeneration,
        verifiedSourceMerkleHash: currentExecutionSnapshot.merkleHash,
        verifiedSourceWorkspaceManifestHash: currentExecutionSnapshot.manifestHash,
        excludedRelativeRoots: sourceDatasetRoots.map((candidate) => path.relative(workspace, candidate).replace(/\\/g, '/')),
        excludedNames: sourceExcludedNames,
        fileRecords: currentExecutionSnapshot.fileRecords,
        directoryRecords: currentExecutionSnapshot.directoryRecords,
      });
      const directDependencies = new Set(authoritativeResearchNode.dependencies || []);
      const theoremSpecificationDependencyNodes = authoritativeNodes.filter((candidate) => (
        directDependencies.has(candidate.nodeId) && candidate.kind === 'theorem-spec'
      ));
      const campaignEvidenceContext = Object.freeze({
        paperId: campaign.paperId,
        campaignId: campaign.campaignId,
        researchNodeId: authoritativeResearchNode.nodeId,
        researchAttemptId: authoritativeResearchNode.attemptId,
        researchLeaseGeneration: authoritativeResearchNode.leaseGeneration,
      });
      if (effectiveVerificationScope === 'formal-only') {
        if (!formalRequested) {
          const error = new Error('campaign_formal_verification_profile_required');
          error.retryable = false;
          throw error;
        }
        return verifyCampaignFormalResearch({
          assertExternalSideEffectReady,
          campaign,
          input,
          paperTask,
          workspace,
          runtimeRoot,
          authoritativeResearchNode,
          authoritativeTheoremSpecification,
          theoremSpecificationDependencyNodes,
          campaignEvidenceContext,
          campaignResearchSourceSnapshot,
          theoremSpecification,
          formalAuthorReceipts,
          formalReviewAgentReceipt,
          formalVerificationIteration,
          formalRepairHistory,
          typedTheoremObligationBundle,
          formalProofSearchPlan,
          formalProofSearchCandidate,
          formalProofSearchOperationReceipt,
          typedTheoremDependencyGraph,
          formalTheoremDependencyGraphOperationReceipt,
          formalProofSearchAttempts,
          formalReviewEnvelope,
          nativeResearchWorkerJobReceiptStore,
          artifactRepositoryFactory,
          trustedFormalSandboxRuntime,
          dynamicFormalExecutionAuthority,
          dynamicFormalExecutionEnvironment,
          executionSignal,
        });
      }
      const formalDependencyNodes = authoritativeNodes.filter((candidate) => (
        directDependencies.has(candidate.nodeId) && candidate.kind === 'formal-verify'
      ));
      let authoritativeFormalReceipt = null;
      let authoritativeFormalNode = null;
      let trustedFormalExecutionAuthority = null;
      if (formalRequested) {
        const completedFormalDependencyNodes = formalDependencyNodes
          .filter((candidate) => candidate.status === 'completed')
          .sort((left, right) => Number(sourceClosureTerminal(right)) - Number(sourceClosureTerminal(left))
            || Number(right.roundIndex || 0) - Number(left.roundIndex || 0)
            || String(right.nodeId || '').localeCompare(String(left.nodeId || '')));
        if (!completedFormalDependencyNodes.length) {
          throw new Error('campaign_research_formal_verification_dependency_invalid');
        }
        const formalNode = assertCompletedCampaignFormalNode(completedFormalDependencyNodes[0]);
        if (!formalVerificationReceipt
          || hashRecord('PaperCampaignNodeResult', formalVerificationReceipt) !== formalNode.resultSha256) {
          throw new Error('campaign_research_formal_verification_context_invalid');
        }
        const verification = verifyCampaignFormalReceipt(formalNode.result, {
          campaign,
          formalNode,
          sourceSnapshot: campaignResearchSourceSnapshot,
          paperTask,
          theoremSpecification: authoritativeTheoremSpecification,
        });
        if (!verification.valid) {
          throw new Error(`campaign_research_formal_verification_invalid:${verification.blockers.join(',')}`);
        }
        authoritativeFormalReceipt = formalNode.result;
        authoritativeFormalNode = formalNode;
        trustedFormalExecutionAuthority =
          issueTrustedFormalCampaignExecutionAuthority({
            paperId: campaign.paperId,
            campaignId: campaign.campaignId,
            researchNodeId: authoritativeResearchNode.nodeId,
            researchAttemptId: authoritativeResearchNode.attemptId,
            researchLeaseGeneration: authoritativeResearchNode.leaseGeneration,
            researchSourceSnapshotHash:
              campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
            formalNodeId: formalNode.nodeId,
            formalAttemptId: formalNode.attemptId,
            formalLeaseGeneration: formalNode.leaseGeneration,
            formalNodeResultHash: formalNode.resultSha256,
            formalVerificationReceiptHash:
              authoritativeFormalReceipt.campaignFormalVerificationReceiptHash,
            nativeResearchWorkerExecutionReportHash:
              authoritativeFormalReceipt.nativeResearchWorkerExecutionReportHash,
          });
      } else if (formalDependencyNodes.length || formalVerificationReceipt) {
        throw new Error('campaign_research_unrequested_formal_verification_dependency');
      }
      const advancedNumericalPlan = campaign.spec.advancedNumericalExecutionPlan || null;
      const advancedNumericalDependencyNodes = authoritativeNodes.filter((candidate) => (
        directDependencies.has(candidate.nodeId)
          && candidate.kind === 'advanced-numerical-analysis'
      ));
      let advancedNumericalExecutionEvidence = null;
      if (advancedNumericalPlan) {
        if (advancedNumericalDependencyNodes.length !== 1) {
          throw new Error('campaign_research_advanced_numerical_dependency_required');
        }
        const advancedNode = assertCompletedNodeResult(
          advancedNumericalDependencyNodes[0],
          'advanced_numerical_node',
        );
        if (!verifyCampaignAdvancedNumericalExecutionResult(advancedNode.result, {
          campaign,
          node: advancedNode,
          plan: advancedNumericalPlan,
        })) {
          throw new Error('campaign_research_advanced_numerical_evidence_invalid');
        }
        const {
          workspaceAttemptIntegration: _workspaceAttemptIntegration,
          ...advancedNumericalSemanticResult
        } = advancedNode.result;
        advancedNumericalExecutionEvidence = Object.freeze({
          nodeId: advancedNode.nodeId,
          attemptId: advancedNode.attemptId,
          leaseGeneration: advancedNode.leaseGeneration,
          nodeResultHash: advancedNode.resultSha256,
          executionPlanHash:
            advancedNumericalPlan.advancedNumericalCampaignExecutionPlanHash,
          executionReceiptHash:
            advancedNode.result.advancedNumericalCampaignExecutionReceiptHash,
          evidenceHash: advancedNode.result.advancedNumericalCampaignEvidenceHash,
          evidenceDocumentHash: advancedNode.result.evidenceDocumentHash,
          productionQualified: advancedNode.result.productionQualified,
          promotionEligible: advancedNode.result.promotionEligible,
          result: Object.freeze(advancedNumericalSemanticResult),
        });
        if (!advancedNumericalExecutionEvidence.promotionEligible) {
          const error = new Error(
            'campaign_research_advanced_numerical_production_qualification_required',
          );
          error.retryable = false;
          error.receipt = advancedNode.result;
          throw error;
        }
      } else if (advancedNumericalDependencyNodes.length) {
        throw new Error('campaign_research_unplanned_advanced_numerical_dependency');
      }
      requireCampaignResearchGpuScientificEvidence({
        campaign, authoritativeNodes, directDependencies,
      });
      const latestReplayByProfile = new Map();
      for (const candidate of authoritativeNodes) {
        if (!directDependencies.has(candidate.nodeId) || candidate.status !== 'completed'
          || !/^(?:empirical-reproduce|revalidate-empirical-reproduce)(?:-|$)/.test(candidate.kind)) continue;
        const profile = replayProfile(candidate.kind);
        const previous = latestReplayByProfile.get(profile);
        if (!previous
          || Number(sourceClosureTerminal(candidate)) > Number(sourceClosureTerminal(previous))
          || (sourceClosureTerminal(candidate) === sourceClosureTerminal(previous)
            && (candidate.roundIndex > previous.roundIndex
              || (candidate.roundIndex === previous.roundIndex
                && candidate.nodeId.localeCompare(previous.nodeId) > 0)))) {
          latestReplayByProfile.set(profile, candidate);
        }
      }
      const campaignExperiments = [...latestReplayByProfile.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)).flatMap((candidate) => {
        const replayNode = assertCompletedNodeResult(candidate, 'replay_node');
        const originalNode = assertCompletedNodeResult(authoritativeNodes.find((dependency) =>
          replayNode.dependencies.includes(dependency.nodeId)
          && /^(?:empirical|revalidate-empirical)(?:$|-(?!reproduce(?:-|$)))/.test(dependency.kind)), 'original_node');
        const replayReceipt = replayNode.result.experimentReplayReceipt || null;
        const originalRunReceipt = originalNode.result.experimentRunReceipt || null;
        const replayRunReceipt = replayNode.result.experimentRunReceipt || null;
        if (!verifyExperimentRunReceipt(originalRunReceipt) || !verifyExperimentRunReceipt(replayRunReceipt)
          || !verifyExperimentReplayReceipt(replayReceipt)
          || replayReceipt.originalExperimentRunReceiptHash !== originalRunReceipt.experimentRunReceiptHash
          || replayReceipt.replayExperimentRunReceiptHash !== replayRunReceipt.experimentRunReceiptHash
          || originalRunReceipt.experimentAttemptId
            !== expectedCampaignEmpiricalAttemptId(campaign, originalNode, originalRunReceipt)
          || replayRunReceipt.experimentAttemptId
            !== expectedCampaignEmpiricalAttemptId(campaign, replayNode, replayRunReceipt)
          || originalRunReceipt.sourceLineageHash !== currentSourceLineageHash
          || replayRunReceipt.sourceLineageHash !== currentSourceLineageHash
          || originalRunReceipt.sourceMerkleHash !== currentExecutionSnapshot.merkleHash
          || replayRunReceipt.sourceMerkleHash !== currentExecutionSnapshot.merkleHash
          || originalRunReceipt.sourceWorkspaceManifestHash !== currentExecutionSnapshot.manifestHash
          || replayRunReceipt.sourceWorkspaceManifestHash !== currentExecutionSnapshot.manifestHash) {
          throw new Error('campaign_experiment_authoritative_replay_invalid');
        }
        const trusted = recordCampaignExperimentReceipts({
          campaign, originalNode, replayNode, originalRunReceipt, replayRunReceipt, replayReceipt,
          writers: trustedResearchReceiptWriters,
        });
        return [{
          kind: 'experiment',
          paperId: campaign.paperId,
          campaignId: campaign.campaignId,
          experimentId: trusted.experimentId,
          runId: originalRunReceipt.experimentRunReceiptHash,
          resultPath: `campaign-node:${replayNode.nodeId}`,
          resultHash: replayRunReceipt.observationManifestHash,
          claimIds: Object.freeze(originalRunReceipt.analysisProtocol.hypotheses.map((hypothesis) => hypothesis.claimId)),
          empiricalClaimBindings: Object.freeze(originalRunReceipt.analysisProtocol.hypotheses.map((hypothesis) => Object.freeze({
            hypothesisId: hypothesis.hypothesisId,
            claimId: hypothesis.claimId,
            manuscriptClaimHash: hypothesis.manuscriptClaimHash,
            proposalClaimRecordHash: hypothesis.proposalClaimRecordHash,
          }))),
          empiricalClaimUniverseHash: originalRunReceipt.analysisProtocol.empiricalClaimUniverseHash || null,
          manuscriptCorpusHash: originalRunReceipt.analysisProtocol.manuscriptCorpusHash || null,
          experimentRunReceipt: originalRunReceipt,
          reproducibilityReceipt: replayReceipt,
          workerReceipt: trusted.originalWorkerReceipt,
          replayWorkerReceipt: trusted.replayWorkerReceipt,
          reproducibilityLedgerReceipt: trusted.reproducibilityReceipt,
          sourceLineageHash: currentSourceLineageHash,
          originalCampaignNodeId: originalNode.nodeId,
          originalCampaignNodeAttemptId: originalNode.attemptId,
          originalCampaignNodeLeaseGeneration: originalNode.leaseGeneration,
          originalCampaignNodeResultHash: originalNode.resultSha256,
          campaignNodeId: replayNode.nodeId,
          campaignNodeAttemptId: replayNode.attemptId,
          campaignNodeLeaseGeneration: replayNode.leaseGeneration,
          campaignNodeResultHash: replayNode.resultSha256,
        }];
      });
      const externalReplay = await runCampaignExternalResearchReplay({
        campaign,
        campaignResearchSourceSnapshot,
        campaignExperiments,
        authoritativeFormalReceipt,
        externalResearchReplay,
        signal: executionSignal,
        assertExternalSideEffectReady,
      });
      const externalReplayRequired = externalReplay.required;
      const externalReplayRequest = externalReplay.request;
      const externalReplayReceipt = externalReplay.receipt;
      const report = await runResearchVerifyAdapter({
        root: workspace,
        row: { task: paperTask, state: input.state },
        runtimeRoot,
        executeResearchWorkers: false,
        requireNativeWorkers: formalRequested,
        artifactRepositoryFactory,
        nativeResearchWorkerJobReceiptStore,
        trustedResearchReceiptWriters,
        receiptLedger,
        trustedFormalSandboxRuntime,
        trustedFormalExecutionAuthority,
        campaign,
        authoritativeFormalNode,
        authoritativeTheoremSpecification,
        authoritativeFormalReceipt,
        assertExternalSideEffectReady,
        executionSignal,
        store,
        clock,
        formalReviewEnvelope: authoritativeFormalReceipt?.formalReviewEnvelope || formalReviewEnvelope,
        nativeResearchWorkerExecutionOverride: authoritativeFormalReceipt?.nativeResearchWorkerExecution || null,
        campaignExperiments,
        campaignEvidenceContext: Object.freeze({
          ...campaignEvidenceContext,
          advancedNumericalCampaignExecutionReceiptHash:
            advancedNumericalExecutionEvidence?.executionReceiptHash || null,
          advancedNumericalCampaignEvidenceHash:
            advancedNumericalExecutionEvidence?.evidenceHash || null,
        }),
        campaignResearchSourceSnapshot,
        operatorDatasetHarnessAuthorityVerifier,
        rawEventRecomputationVerifier,
        externalReplayRequired,
        externalReplayRequest,
        externalReplayReceipt,
        externalReplayReceiptVerifier: externalReplay.receiptVerifier,
        now: clock.now(),
      });
      if (executionSignal?.aborted) throw new Error('campaign_research_verification_cancelled');
      if (report?.kind !== 'PaperResearchVerifyReport' || !report?.researchReportHash) {
        const error = new Error('campaign_research_verification_report_invalid');
        error.retryable = false;
        throw error;
      }
      if (formalRequested && report?.proposalClaimToTheoremBindingHash
        !== authoritativeFormalReceipt?.proposalClaimToTheoremBindingHash) {
        throw new Error('campaign_research_proposal_theorem_lineage_mismatch');
      }
      const promotionReady = report.promotionEligibility?.status === 'research_promotion_ready';
      const payload = {
        version: 1,
        kind: 'CampaignResearchVerificationResult',
        status: promotionReady ? 'campaign_research_verification_completed' : 'campaign_research_verification_blocked',
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        campaignResearchVerificationInputHash: input.campaignResearchVerificationInputHash,
        researchReportHash: report.researchReportHash,
        experimentRegistryHash: report.experimentRegistryHash,
        researchStatus: report.status,
        researchPromotionStatus: report.promotionEligibility?.status || null,
        researchPromotionBlockers: report.promotionEligibility?.blockers || [],
        formalVerificationReceiptHash: authoritativeFormalReceipt?.campaignFormalVerificationReceiptHash || null,
        proposalClaimToTheoremBindingHash: authoritativeFormalReceipt?.proposalClaimToTheoremBindingHash || null,
        formalVerificationNodeId: authoritativeFormalReceipt?.formalNodeId || null,
        formalVerificationAttemptId: authoritativeFormalReceipt?.formalAttemptId || null,
        formalVerificationLeaseGeneration: authoritativeFormalReceipt?.formalLeaseGeneration || null,
        researchNodeId: campaignResearchSourceSnapshot.researchNodeId,
        researchAttemptId: campaignResearchSourceSnapshot.researchAttemptId,
        researchLeaseGeneration: campaignResearchSourceSnapshot.researchLeaseGeneration,
        verifiedSourceMerkleHash: campaignResearchSourceSnapshot.verifiedSourceMerkleHash,
        verifiedSourceWorkspaceManifestHash: campaignResearchSourceSnapshot.verifiedSourceWorkspaceManifestHash,
        campaignResearchSourceSnapshotHash: campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
        campaignResearchSourceSnapshot,
        report,
        externalReplayRequestHash: externalReplayRequest?.requestHash || null,
        externalResearchReplayReceiptHash:
          externalReplayReceipt?.externalResearchReplayReceiptHash || null,
        advancedNumericalCampaignExecutionReceiptHash:
          advancedNumericalExecutionEvidence?.executionReceiptHash || null,
        advancedNumericalCampaignEvidenceHash:
          advancedNumericalExecutionEvidence?.evidenceHash || null,
        advancedNumericalExecutionEvidence,
        externalActionPerformed: Boolean(externalReplayReceipt),
      };
      return Object.freeze({
        ...payload,
        campaignResearchVerificationResultHash: hashRecord('CampaignResearchVerificationResult', payload),
      });
    },
  }));
}
