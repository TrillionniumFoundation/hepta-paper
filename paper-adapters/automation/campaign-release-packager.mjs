import fs from 'node:fs';
import path from 'node:path';
import { withArtifactWriteContext } from '../artifacts/artifact-write-context.mjs';
import { createResearchExecutionReleaseAttestor, runPackageAdapter } from '../build-package/index.mjs';
import { createPaperBuildArtifactAcceptance, createPaperTask } from '../../paper-domain/contracts/index.mjs';
import { createAutomationPromotionCandidate, createAutonomousResearchReleaseBinding, createCampaignReleaseBundle, verifyCampaignReleaseBundle } from '../../paper-domain/automation/campaign-release-contracts.mjs';
import { assertCampaignReleasePackagerPort } from '../../paper-ports/campaign-release-packager-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  campaignTrustedAutonomousManuscriptAuthorshipReceipt,
} from '../../paper-domain/automation/autonomous-manuscript-release-proof-contract.mjs';
import { verifyCampaignResearchSourceSnapshot } from '../../paper-domain/automation/campaign-research-contract.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import {
  buildGpuScientificCampaignPromotionEvidence,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';
import { createTrustedExperimentRegistryAuthorityVerifier } from '../research-verify/experiment-registry-authority-verifier.mjs';
import { createOperatorDatasetHarnessAuthorityReceiptVerifier } from './operator-dataset-harness-authority-receipt-verifier.mjs';
import {
  assertCurrentGpuScientificQualificationAuthority,
  campaignReleaseGpuScientificAuthorityObservedAt,
  freezeCampaignReleaseGpuScientificAuthorityTrustStore,
  verifyPackagedGpuScientificAuthorityFreshness,
} from './campaign-release-gpu-scientific-authority-freshness.mjs';
import {
  assertSealedImmutableCampaignPackageFilesSync, campaignReleasePackageRootFor,
  campaignReleaseRebuildRootFor, campaignReleaseRootFor,
  fsyncCampaignReleasePackageDirectorySync, initializeCampaignReleaseRootSync,
  initializeCampaignReleasePackageScopeSync,
  persistCampaignReleaseMaterializationSync,
  readCampaignReleaseMaterializationSync,
} from './campaign-release-materialization.mjs';
import {
  assertCampaignReleasePackageBuildTransactionCurrentSync, beginCampaignReleasePackageBuildTransactionSync,
} from './campaign-release-package-build-transaction-repository.mjs';
import { campaignReleaseGenerationLeaseWaitBudgetMs, withCampaignReleasePackageGenerationLease } from './campaign-release-package-generation-lease.mjs';
import { executeIndependentCampaignPdfRebuild } from './campaign-release-independent-pdf-rebuild.mjs';
import {
  assertCampaignReleaseExternalResearchReplayAuthority,
} from './campaign-external-research-replay.mjs';
import {
  assertCampaignReleaseReviewerEvidenceForPackaging,
} from './campaign-release-reviewer-evidence.mjs';
import {
  assertSameCampaignReleaseSourceSnapshot,
  buildCampaignReleaseSourceArchiveDefinition,
  campaignManuscriptPath,
  campaignReleasePackageNodeResult,
  campaignReleaseSourceSnapshotOptions,
  compiledCampaignPdfRecord,
  fsyncCampaignReleaseFileSync,
  inspectCampaignReleaseSourceSnapshot,
  withCampaignReleasePackageWriterBoundary,
} from './campaign-release-packaging-helpers.mjs';
export { createResearchExecutionReleaseAttestor };
export { assertCampaignReleaseReviewerEvidenceForPackaging };
export function createCampaignReleasePackager({
  artifactRepositoryFactory,
  store = null,
  receiptLedger = null,
  experimentRegistryAuthorityVerifier: suppliedAuthorityVerifier = null,
  operatorDatasetHarnessAuthorityVerifier: suppliedDatasetAuthorityVerifier = null,
  runtimeRoot: configuredRuntimeRoot = null,
  operatorDatasetAuthorityTrustStoreProvider = null,
  clock = null,
  gpuScientificPromotionAuthorityVerifier = null,
  researchExecutionReleaseAttestor = null,
  independentPdfRebuildVerifier: suppliedPdfRebuildVerifier = null,
  externalResearchReplay = null,
  packageAdapter = runPackageAdapter, packageDeletionWriterBoundary = null, packageDeletionWriterOperationId = null,
} = {}) {
  if (typeof artifactRepositoryFactory !== 'function') throw new Error('Campaign release packager requires ArtifactRepositoryFactory');
  if (typeof packageAdapter !== 'function') throw new Error('Campaign release packager requires runPackageAdapter');
  const configuredReleaseRuntimeRoot = configuredRuntimeRoot ? path.resolve(String(configuredRuntimeRoot)) : null;
  const port = {
    version: 1,
    kind: 'CampaignReleasePackagerPort',
    async packageRelease({
      campaign,
      packageNode,
      finalCompileNode,
      researchVerifyNode = null,
      researchReport = null,
      sourceWorkspace,
      manuscriptPath: requestedManuscriptPath = null,
      trustedAutonomousManuscriptResult = null,
      refereeConvergenceDecision = null,
      evidenceEntailmentReviewReceipt = null,
      reviewerEvidenceAuthority = null,
      experimentExecutionClosure = null,
      advancedNumericalExecutionPlan = null,
      advancedNumericalExecutionEvidence = null,
      gpuScientificExecutionPlan = null,
      gpuScientificExecutionEvidence = null,
      gpuScientificResearchEvidence = null,
      runtimeRoot,
      createdAt,
      executionSignal = null, executionBudget = null,
      assertExternalSideEffectReady = null,
    } = {}) {
      campaignReleaseGenerationLeaseWaitBudgetMs(executionBudget, clock); if (executionSignal?.aborted) throw new Error('campaign_release_packaging_cancelled');
      if (!campaign?.campaignId || !campaign?.spec?.campaignPlanHash) throw new Error('campaign_release_campaign_lineage_required');
      if (packageNode?.kind !== 'package') throw new Error('campaign_release_package_node_required');
      if (finalCompileNode?.kind !== 'final-compile' || finalCompileNode.status !== 'completed') throw new Error('campaign_release_final_compile_not_completed');
      const researchVerificationRequired = true;
      const paperQualityProfiles = campaign.spec.paperQualityProfiles || [campaign.spec.paperQualityProfile].filter(Boolean);
      if (researchVerificationRequired) {
        if (researchVerifyNode?.kind !== 'research-verify' || researchVerifyNode.status !== 'completed'
          || !(packageNode.dependencies || []).includes(researchVerifyNode.nodeId)
          || !(researchVerifyNode.dependencies || []).includes(finalCompileNode.nodeId)) throw new Error('campaign_release_research_verification_dependency_required');
        if (!researchVerifyNode.attemptId || !Number.isInteger(researchVerifyNode.leaseGeneration) || researchVerifyNode.leaseGeneration < 1) throw new Error('campaign_release_research_attempt_identity_required');
        if (researchReport?.kind !== 'PaperResearchVerifyReport' || !researchReport.researchReportHash || researchReport.promotionEligibility?.status !== 'research_promotion_ready') throw new Error('campaign_release_research_report_not_promotion_ready');
      }
      assertCampaignReleaseExternalResearchReplayAuthority({
        campaign,
        researchReport,
        externalResearchReplay,
      });
      if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error('campaign_release_created_at_required');
      const workspace = path.resolve(sourceWorkspace || campaign.spec.sourceWorkspace || '');
      const requestedRuntimeRoot = runtimeRoot
        ? path.resolve(String(runtimeRoot))
        : configuredReleaseRuntimeRoot;
      if (!requestedRuntimeRoot) throw new Error('campaign_release_runtime_root_required');
      if (configuredReleaseRuntimeRoot && requestedRuntimeRoot !== configuredReleaseRuntimeRoot) {
        throw new Error('campaign_release_runtime_root_mismatch');
      }
      const resolvedRuntimeRoot = requestedRuntimeRoot;
      const sourceRuntimeTrustStoreProvider =
        typeof operatorDatasetAuthorityTrustStoreProvider === 'function'
          ? operatorDatasetAuthorityTrustStoreProvider : null;
      const frozenGpuScientificAuthorityTrustStore =
        gpuScientificExecutionPlan
          ? freezeCampaignReleaseGpuScientificAuthorityTrustStore({
            trustStoreProvider: sourceRuntimeTrustStoreProvider,
            runtimeRoot: resolvedRuntimeRoot,
          }) : null;
      const runtimeTrustStoreProvider = sourceRuntimeTrustStoreProvider
        ? (gpuScientificExecutionPlan
          ? () => frozenGpuScientificAuthorityTrustStore
          : () => sourceRuntimeTrustStoreProvider({
            runtimeRoot: resolvedRuntimeRoot,
          }))
        : null;
      const initialGpuScientificAuthorityObservedAt =
        gpuScientificExecutionPlan
          ? campaignReleaseGpuScientificAuthorityObservedAt(clock) : null;
      const initialGpuScientificAuthorityInspection =
        assertCurrentGpuScientificQualificationAuthority({
        gpuScientificExecutionPlan,
        gpuScientificResearchEvidence,
        gpuScientificPromotionAuthorityVerifier,
        trustStore: frozenGpuScientificAuthorityTrustStore,
          observedAt: initialGpuScientificAuthorityObservedAt,
        });
      const releaseScopedGpuScientificPromotionAuthorityVerifier =
        gpuScientificExecutionPlan
          ? Object.freeze({
            version: 1,
            kind: 'ExternallyAnchoredGpuScientificPromotionAuthorityVerifier',
            trustStoreExternallyAnchored: true,
            verify: (input) => gpuScientificPromotionAuthorityVerifier.verify(input),
            verifyReleaseSnapshot(input) {
              const snapshotInspection =
                gpuScientificPromotionAuthorityVerifier.verify(input);
              const frozenStoreInspection =
                gpuScientificPromotionAuthorityVerifier.verify({
                  ...input,
                  trustStore: frozenGpuScientificAuthorityTrustStore,
                });
              return JSON.stringify(snapshotInspection)
                  === JSON.stringify(frozenStoreInspection)
                ? snapshotInspection : frozenStoreInspection;
            },
          })
          : gpuScientificPromotionAuthorityVerifier;
      const operatorDatasetHarnessAuthorityVerifier =
        (!gpuScientificExecutionPlan && suppliedDatasetAuthorityVerifier)
        || (runtimeTrustStoreProvider && typeof clock?.now === 'function'
          ? createOperatorDatasetHarnessAuthorityReceiptVerifier({
            trustStoreProvider: runtimeTrustStoreProvider,
            clock,
          })
          : null);
      const experimentRegistryAuthorityVerifier =
        (!gpuScientificExecutionPlan && suppliedAuthorityVerifier)
        || createTrustedExperimentRegistryAuthorityVerifier({
          receiptLedger,
          operatorDatasetHarnessAuthorityVerifier,
          runtimeRoot: resolvedRuntimeRoot,
          operatorDatasetAuthorityTrustStoreProvider: runtimeTrustStoreProvider,
          clock,
        });
      const campaignResearchSourceSnapshot = researchReport?.campaignResearchSourceSnapshot || null;
      if (researchVerificationRequired) {
        const { researchReportHash: claimedResearchReportHash, ...researchReportPayload } = researchReport || {};
        const snapshotVerification = verifyCampaignResearchSourceSnapshot(campaignResearchSourceSnapshot, {
          campaignId: campaign.campaignId,
          paperId: campaign.paperId,
          researchNodeId: researchVerifyNode.nodeId,
          researchAttemptId: researchVerifyNode.attemptId,
          researchLeaseGeneration: researchVerifyNode.leaseGeneration,
          verifiedSourceMerkleHash: researchReport?.verifiedSourceMerkleHash,
          verifiedSourceWorkspaceManifestHash: researchReport?.verifiedSourceWorkspaceManifestHash,
        });
        if (!claimedResearchReportHash || hashPaperRecord('PaperResearchVerifyReport', researchReportPayload) !== claimedResearchReportHash
          || researchVerifyNode?.result?.researchReportHash !== claimedResearchReportHash
          || researchVerifyNode?.result?.report?.researchReportHash !== claimedResearchReportHash
          || !snapshotVerification.valid
          || researchReport?.researchNodeId !== researchVerifyNode.nodeId
          || researchReport?.researchAttemptId !== researchVerifyNode.attemptId
          || researchReport?.researchLeaseGeneration !== researchVerifyNode.leaseGeneration
          || researchVerifyNode?.result?.researchNodeId !== researchVerifyNode.nodeId
          || researchVerifyNode?.result?.researchAttemptId !== researchVerifyNode.attemptId
          || researchVerifyNode?.result?.researchLeaseGeneration !== researchVerifyNode.leaseGeneration
          || researchReport?.campaignResearchSourceSnapshotHash !== campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash
          || researchVerifyNode?.result?.campaignResearchSourceSnapshotHash !== campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash
          || researchVerifyNode?.result?.verifiedSourceMerkleHash !== campaignResearchSourceSnapshot?.verifiedSourceMerkleHash
          || researchVerifyNode?.result?.verifiedSourceWorkspaceManifestHash !== campaignResearchSourceSnapshot?.verifiedSourceWorkspaceManifestHash
          || hashRecord('PaperCampaignNodeResult', researchVerifyNode?.result) !== researchVerifyNode?.resultSha256) {
          throw new Error(`campaign_release_research_source_snapshot_invalid:${snapshotVerification.blockers.join(',')}`);
        }
      }
      const snapshotOptions = campaignReleaseSourceSnapshotOptions({
        workspace,
        campaign,
        campaignResearchSourceSnapshot,
      });
      const packageStartSourceSnapshot = inspectCampaignReleaseSourceSnapshot(
        workspace,
        snapshotOptions,
      );
      if (campaignResearchSourceSnapshot) {
        if (packageStartSourceSnapshot.merkleHash !== campaignResearchSourceSnapshot.verifiedSourceMerkleHash
          || packageStartSourceSnapshot.manifestHash !== campaignResearchSourceSnapshot.verifiedSourceWorkspaceManifestHash) {
          throw new Error('campaign_release_source_changed_after_research');
        }
      }
      if (!finalCompileNode?.resultSha256 || hashRecord('PaperCampaignNodeResult', finalCompileNode.result) !== finalCompileNode.resultSha256
        || finalCompileNode.result?.sourceMerkleHash !== packageStartSourceSnapshot.merkleHash
        || finalCompileNode.result?.sourceWorkspaceManifestHash !== packageStartSourceSnapshot.manifestHash) {
        throw new Error('campaign_release_final_compile_source_identity_mismatch');
      }
      const archiveDefinition = buildCampaignReleaseSourceArchiveDefinition({
        paperId: campaign.paperId,
        sourceSnapshot: packageStartSourceSnapshot,
        lineageHash: campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash || null,
      });
      const releaseRoot = campaignReleaseRootFor(resolvedRuntimeRoot, campaign, packageNode);
      const publishedPackageDir = campaignReleasePackageRootFor(resolvedRuntimeRoot, campaign, packageNode);
      const mainTex = String(
        requestedManuscriptPath || campaignManuscriptPath(workspace),
      );
      const mainRecord = packageStartSourceSnapshot.fileRecords
        .find((record) => record.path === mainTex) || null;
      const manuscriptIrRecord = packageStartSourceSnapshot.fileRecords
        .find((record) => record.path === 'AUTONOMOUS_MANUSCRIPT_IR.json') || null;
      const manuscriptIrDraftRecord = packageStartSourceSnapshot.fileRecords
        .find((record) => record.path === 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json') || null;
      let manuscriptIr = null;
      let manuscriptIrDraft = null;
      if (manuscriptIrRecord) {
        try {
          manuscriptIr = JSON.parse(fs.readFileSync(
            path.resolve(workspace, manuscriptIrRecord.path),
            'utf8',
          ));
        } catch {
          throw new Error('campaign_release_manuscript_ir_invalid');
        }
        const { evidenceBoundManuscriptIrHash: claimedIrHash, ...irPayload } = manuscriptIr || {};
        if (!claimedIrHash
          || hashRecord('EvidenceBoundManuscriptIR', irPayload) !== claimedIrHash) {
          throw new Error('campaign_release_manuscript_ir_hash_invalid');
        }
      }
      if (manuscriptIrDraftRecord) {
        try {
          manuscriptIrDraft = JSON.parse(fs.readFileSync(
            path.resolve(workspace, manuscriptIrDraftRecord.path),
            'utf8',
          ));
        } catch {
          throw new Error('campaign_release_manuscript_ir_draft_invalid');
        }
      }
      const autonomousResearchReleaseBinding = createAutonomousResearchReleaseBinding({
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        campaignPlanHash: campaign.spec.campaignPlanHash,
        preparation: campaign.spec.autonomousResearchPreparation || null,
        machineIntake: campaign.spec.autonomousResearchMachineIntake || null,
        machineIntakeAdmission:
          campaign.spec.autonomousResearchMachineIntakeAdmission || null,
        manuscriptPath: mainTex,
        renderedManuscriptHash: mainRecord?.hash || null,
        evidenceBoundManuscriptIrHash:
          manuscriptIr?.evidenceBoundManuscriptIrHash || null,
        manuscriptIrFileHash: manuscriptIrRecord?.hash || null,
        agentAuthoredSourceDraft: manuscriptIrDraft,
        agentAuthoredSourceDraftFileHash: manuscriptIrDraftRecord?.hash || null,
        trustedAutonomousManuscriptResult,
        refereeConvergenceDecision,
        reviewerEvidenceAuthority,
        researchReport,
        experimentIrExecutionAuthorityReceipt:
          experimentExecutionClosure?.experimentIrExecutionAuthorityReceipt || null,
        experimentReplayReceipt:
          experimentExecutionClosure?.experimentReplayReceipt || null,
      });
      const productionEntailmentRequired = campaign.spec.autonomousResearchPreparation
        ?.launchMode === 'production-run';
      const trustedRenderReceipt = trustedAutonomousManuscriptResult
        ?.result?.trustedAutonomousManuscriptRenderReceipt || null;
      assertCampaignReleaseReviewerEvidenceForPackaging({
        campaign,
        releaseBinding: autonomousResearchReleaseBinding,
        reviewerEvidenceAuthority,
        expectedManuscriptHash: mainRecord?.hash || null,
      });
      const expected = {
        campaignId: campaign.campaignId,
        campaignPlanHash: campaign.spec.campaignPlanHash,
        paperId: campaign.paperId,
        venueTarget: campaign.spec.venueTarget || null,
        packageNodeId: packageNode.nodeId,
        packageAttemptId: packageNode.attemptId,
        researchReportHash: researchReport?.researchReportHash || null,
        proposalClaimToTheoremBindingHash:
          researchReport?.proposalClaimToTheoremBindingHash || null,
        experimentRegistryHash: researchReport?.experimentRegistryHash || null,
        empiricalAssertionAuthorityHash: researchReport?.empiricalAssertionAuthorityHash || null,
        empiricalAssertionUniverseHash: researchReport?.empiricalAssertionUniverseHash || null,
        empiricalAssertionUniverseBindingHash: researchReport?.empiricalAssertionUniverseBindingHash || null,
        empiricalAssertionManuscriptCorpusHash: researchReport?.empiricalAssertionManuscriptCorpusHash || null,
        researchVerifyNodeId: researchVerifyNode?.nodeId || null,
        researchVerifyAttemptId: researchVerifyNode?.attemptId || null,
        researchVerifyLeaseGeneration: researchVerifyNode?.leaseGeneration || null,
        verifiedSourceMerkleHash: packageStartSourceSnapshot.merkleHash,
        verifiedSourceWorkspaceManifestHash: packageStartSourceSnapshot.manifestHash,
        ...(autonomousResearchReleaseBinding ? {
          autonomousResearchReleaseBindingHash:
            autonomousResearchReleaseBinding.autonomousResearchReleaseBindingHash,
        } : {}),
        ...(advancedNumericalExecutionPlan ? {
          advancedNumericalExecutionPlanHash:
            advancedNumericalExecutionPlan.advancedNumericalCampaignExecutionPlanHash,
          advancedNumericalCampaignExecutionReceiptHash:
            advancedNumericalExecutionEvidence?.executionReceiptHash || null,
          advancedNumericalCampaignEvidenceHash:
            advancedNumericalExecutionEvidence?.evidenceHash || null,
        } : {}),
        ...(gpuScientificExecutionPlan ? {
          gpuScientificExecutionPlanHash:
            gpuScientificExecutionPlan.gpuScientificCampaignExecutionPlanHash,
          gpuScientificCampaignExecutionResultHash:
            gpuScientificExecutionEvidence
              ?.gpuScientificCampaignExecutionResultHash || null,
          gpuScientificArtifactBodyArchiveManifestHash:
            gpuScientificResearchEvidence
              ?.artifactArchiveManifestHash || null,
          gpuScientificCampaignQualificationEvidenceHash:
            gpuScientificResearchEvidence
              ?.qualificationEvidenceHash || null,
        } : {}),
      };
      return withCampaignReleasePackageWriterBoundary({ runtimeRoot: resolvedRuntimeRoot, packagePath: publishedPackageDir, artifactRepositoryFactory, packageDeletionWriterBoundary, packageDeletionWriterOperationId }, async (packageDeletionWriterSelector) => {
      const existing = readCampaignReleaseMaterializationSync({ runtimeRoot: resolvedRuntimeRoot, releaseRoot });
      if (existing) {
        const verification = verifyCampaignReleaseBundle(existing.bundle, expected, {
          experimentRegistryAuthorityVerifier,
          gpuScientificPromotionAuthorityVerifier:
            releaseScopedGpuScientificPromotionAuthorityVerifier,
        });
        if (!verification.valid) throw new Error(`campaign_release_immutable_bundle_invalid:${verification.blockers.join(',')}`);
        if (productionEntailmentRequired
          && (existing.bundle?.manuscriptPromotionGate?.version !== 2
            || existing.bundle?.manuscriptPromotionGate
              ?.evidenceEntailmentReviewRequired !== true
            || existing.bundle?.manuscriptPromotionGate
              ?.independentEvidenceEntailmentReviewReceiptHash
                !== evidenceEntailmentReviewReceipt
                  ?.independentEvidenceEntailmentReviewReceiptHash)) {
          throw new Error('campaign_release_immutable_entailment_review_invalid');
        }
        if (campaign.spec.autonomousResearchPreparation?.launchMode === 'production-run') {
          const persistedBinding = existing.bundle.autonomousResearchReleaseBinding || null;
          assertCampaignReleaseReviewerEvidenceForPackaging({
            campaign,
            releaseBinding: persistedBinding,
            reviewerEvidenceAuthority,
            expectedManuscriptHash: mainRecord?.hash || null,
            errorCode: 'campaign_release_immutable_reviewer_evidence_invalid',
          });
        }
        assertSealedImmutableCampaignPackageFilesSync(
          existing.bundle.packageOutput,
          resolvedRuntimeRoot,
        );
        if (gpuScientificExecutionPlan) {
          const persistedQualificationEvidence = existing.bundle
            ?.gpuScientificCampaignPromotionEvidence
            ?.gpuScientificCampaignQualificationEvidence || null;
          verifyPackagedGpuScientificAuthorityFreshness({
            packageResult: {
              packageDirAbsolute: existing.bundle?.packageOutput?.packageDir,
              researchEvidenceCapsule: {
                manifest: existing.bundle?.researchEvidenceCapsuleManifest,
                manifestFile: {
                  hash: existing.bundle?.packageOutput
                    ?.researchEvidenceCapsuleManifestFileHash,
                },
                researchExecutionReleaseAttestationHash:
                  existing.bundle?.researchExecutionReleaseAttestationHash,
              },
            },
            qualificationEvidence: persistedQualificationEvidence,
            initialAuthorityInspection:
              initialGpuScientificAuthorityInspection,
            initialObservedAt: initialGpuScientificAuthorityObservedAt,
            frozenAuthorityTrustStore:
              frozenGpuScientificAuthorityTrustStore,
            gpuScientificPromotionAuthorityVerifier,
            clock,
          });
        }
        const materializationReceipt = persistCampaignReleaseMaterializationSync({ runtimeRoot: resolvedRuntimeRoot, releaseRoot, bundle: existing.bundle });
        return campaignReleasePackageNodeResult(existing.bundle, materializationReceipt);
      }
      initializeCampaignReleaseRootSync(resolvedRuntimeRoot, releaseRoot); initializeCampaignReleasePackageScopeSync(resolvedRuntimeRoot);
      return withCampaignReleasePackageGenerationLease({ runtimeRoot: resolvedRuntimeRoot, releaseRoot, signal: executionSignal, executionBudget, clock }, async (generationLease) => {
      const packageBuildTransaction = beginCampaignReleasePackageBuildTransactionSync({
        runtimeRoot: resolvedRuntimeRoot, releaseRoot, packageDir: publishedPackageDir, generationLease,
        binding: {
          campaignId: campaign.campaignId, campaignPlanHash: campaign.spec.campaignPlanHash,
          packageNodeId: packageNode.nodeId, packageAttemptId: packageNode.attemptId,
          leaseGeneration: packageNode.leaseGeneration, createdAt,
          sourceSnapshotHash: archiveDefinition.sourceTreeManifestHash,
          sourceWorkspaceManifestHash: packageStartSourceSnapshot.manifestHash,
        },
      });
      const packageBuildTransactionHash = packageBuildTransaction.record.campaignReleasePackageBuildingTransactionHash;
      const builtPdf = await compiledCampaignPdfRecord(workspace, finalCompileNode);
      generationLease.assertHeld(); if (!builtPdf) throw new Error('campaign_release_compiled_pdf_required');
      const independentPdfRebuild = await executeIndependentCampaignPdfRebuild({
        verifier: suppliedPdfRebuildVerifier,
        sourceWorkspace: workspace,
        sourceArchiveDefinition: archiveDefinition,
        campaignId: campaign.campaignId,
        rebuildRoot: campaignReleaseRebuildRootFor(resolvedRuntimeRoot, campaign, packageNode),
        paperId: campaign.paperId,
        mainTex,
        authoritativePdf: builtPdf,
        createdAt,
        signal: executionSignal,
        assertExternalSideEffectReady,
      });
      generationLease.assertHeld(); const paperTask = createPaperTask({
        paperId: campaign.paperId,
        title: campaign.spec.title || campaign.paperId,
        venueTarget: campaign.spec.venueTarget || null,
        sourceWorkspace: workspace,
        mainTex: path.join(workspace, mainTex),
        paperQualityProfile: campaign.spec.paperQualityProfile || null,
        paperQualityProfiles,
        createdAt,
      });
      const buildArtifactAcceptance = createPaperBuildArtifactAcceptance({
        paperTask,
        execute: true,
        command: [],
        buildDir: path.dirname(path.resolve(workspace, builtPdf.path)),
        sourceWorkspace: workspace,
        mainTex: path.join(workspace, mainTex),
        builtPdf,
        execution: { executed: true, status: 0, signal: null },
        blockers: [],
        warnings: [],
        createdAt,
      });
      const row = {
        task: paperTask,
        state: { compileStatus: 'build_passed' },
        artifacts: { pdfs: [builtPdf] },
      };
      assertCampaignReleasePackageBuildTransactionCurrentSync({ runtimeRoot: resolvedRuntimeRoot, releaseRoot, expectedTransactionHash: packageBuildTransactionHash });
      const packageDir = packageBuildTransaction.preparedPackageDir;
      const packageResult = await withArtifactWriteContext({ artifactRepositoryFactory, packageDeletionWriterSelector }, () => packageAdapter({
        root: workspace,
        row,
        buildResult: { status: 'build_passed', builtPdf, buildArtifactAcceptance },
        researchReport,
        runtimeRoot: resolvedRuntimeRoot,
        execute: true,
        store,
        packageOutputDir: packageDir,
        immutableOutput: true,
        createdAt,
        requirePaperQuality: paperQualityProfiles.length > 0,
        experimentRegistryAuthorityVerifier,
        expectedCampaignId: campaign.campaignId,
        receiptLedger,
        operatorDatasetAuthorityTrustStore: gpuScientificExecutionPlan
          ? frozenGpuScientificAuthorityTrustStore
          : runtimeTrustStoreProvider ? runtimeTrustStoreProvider() : null,
        researchExecutionReleaseAttestor,
        assertExternalSideEffectReady,
        gpuScientificExecutionPlan,
        gpuScientificExecutionNode: gpuScientificExecutionPlan ? {
          nodeId: gpuScientificExecutionEvidence?.nodeId,
          kind: 'gpu-scientific-execution',
          attemptId: gpuScientificExecutionEvidence?.attemptId,
          leaseGeneration: gpuScientificExecutionEvidence?.leaseGeneration,
          gpuScientificExecutionPlanHash:
            gpuScientificExecutionPlan
              .gpuScientificCampaignExecutionPlanHash,
          gpuScientificResourceBudgetHash:
            gpuScientificExecutionPlan.resourceBudgetHash,
          resultSha256: gpuScientificResearchEvidence?.nodeResultHash,
          result: gpuScientificExecutionEvidence,
        } : null,
        gpuScientificExecutionResult: gpuScientificExecutionEvidence,
        gpuScientificQualificationEvidence:
          gpuScientificResearchEvidence?.qualificationEvidence || null,
        gpuScientificArtifactBodyArchiveManifest:
          gpuScientificResearchEvidence?.artifactArchiveManifest || null,
        independentPdfRebuild,
        sourceArchiveDefinition: archiveDefinition,
        evidenceEntailmentReviewReceipt,
        requireEvidenceEntailmentReview: productionEntailmentRequired,
        expectedManuscriptHash: mainRecord?.hash || null,
        expectedEvidenceEntailmentContractHash:
          trustedRenderReceipt?.evidenceEntailmentContractHash || null,
        expectedEvidenceBoundManuscriptIrHash:
          manuscriptIr?.evidenceBoundManuscriptIrHash || null,
        expectedManuscriptAuthorPrincipalId:
          campaignTrustedAutonomousManuscriptAuthorshipReceipt(
            trustedAutonomousManuscriptResult?.result,
          )?.principalId
          || campaignTrustedAutonomousManuscriptAuthorshipReceipt(
            trustedAutonomousManuscriptResult?.result,
          )?.agentId
          || null,
      }));
      generationLease.assertHeld(); assertCampaignReleasePackageBuildTransactionCurrentSync({ runtimeRoot: resolvedRuntimeRoot, releaseRoot, expectedTransactionHash: packageBuildTransactionHash });
      if (executionSignal?.aborted) throw new Error('campaign_release_packaging_cancelled');
      const packageEndSourceSnapshot = inspectCampaignReleaseSourceSnapshot(
        workspace,
        snapshotOptions,
      );
      assertSameCampaignReleaseSourceSnapshot(
        packageEndSourceSnapshot,
        packageStartSourceSnapshot,
        'campaign_release_source_changed_during_packaging',
      );
      if (packageResult?.sourceTreeManifest?.sourceTreeManifestHash !== archiveDefinition.sourceTreeManifestHash
        || packageResult?.sourceTreeManifest?.sourcePackageContractHash !== archiveDefinition.sourcePackageContractHash) {
        throw new Error('campaign_release_source_archive_definition_mismatch');
      }
      if (packageResult.status !== 'package_ready' || packageResult.artifactPackage?.submitReady !== true) {
        const error = new Error(`campaign_release_package_blocked:${(packageResult.blockers || []).join(',')}`);
        error.retryable = false;
        error.receipt = packageResult.packageVerificationReceipt || packageResult.manuscriptPromotionGate || packageResult;
        throw error;
      }
      if (productionEntailmentRequired
        && (packageResult.manuscriptPromotionGate?.version !== 2
          || packageResult.manuscriptPromotionGate
            ?.independentEvidenceEntailmentReviewReceiptHash
              !== evidenceEntailmentReviewReceipt
                ?.independentEvidenceEntailmentReviewReceiptHash)) {
        throw new Error('campaign_release_package_entailment_review_invalid');
      }
      for (const candidate of [
        packageResult.sourceZip?.path ? path.resolve(packageResult.artifactBaseRoot, packageResult.sourceZip.path) : null,
        packageResult.immutableCompiledPdf?.path ? path.resolve(packageResult.artifactBaseRoot, packageResult.immutableCompiledPdf.path) : null,
        packageResult.packageRecord?.path ? path.join(packageDir, 'PACKAGE_RECORD.json') : null,
        packageResult.sha256Sums?.path ? path.join(packageDir, 'SHA256SUMS.txt') : null,
        packageResult.independentRebuiltPdf?.path
          ? path.resolve(packageResult.artifactBaseRoot, packageResult.independentRebuiltPdf.path) : null,
        packageResult.independentPdfRebuildReceiptRecord?.path
          ? path.resolve(packageResult.artifactBaseRoot, packageResult.independentPdfRebuildReceiptRecord.path) : null,
        ...(packageResult.researchEvidenceCapsule?.allFiles || []).map((file) => path.join(packageDir, file.path)),
      ]) {
        if (candidate) {
          fsyncCampaignReleaseFileSync(candidate);
        }
      }
      fsyncCampaignReleasePackageDirectorySync(packageDir);
      const gpuScientificReleaseAuthorityFreshnessReceipt =
        gpuScientificExecutionPlan
          ? verifyPackagedGpuScientificAuthorityFreshness({
            packageResult,
            qualificationEvidence:
              gpuScientificResearchEvidence?.qualificationEvidence || null,
            initialAuthorityInspection:
              initialGpuScientificAuthorityInspection,
            initialObservedAt: initialGpuScientificAuthorityObservedAt,
            frozenAuthorityTrustStore:
              frozenGpuScientificAuthorityTrustStore,
            gpuScientificPromotionAuthorityVerifier,
            clock,
          }) : null;
      const gpuScientificPromotionEvidence = gpuScientificExecutionPlan
        ? buildGpuScientificCampaignPromotionEvidence({
          qualificationEvidence:
            gpuScientificResearchEvidence?.qualificationEvidence,
          researchEvidenceCapsuleManifestHash:
            packageResult.researchEvidenceCapsule
              ?.researchEvidenceCapsuleManifestHash,
          researchEvidenceCapsuleManifestFileHash:
            packageResult.researchEvidenceCapsule?.manifestFile?.hash,
          researchExecutionReleaseAttestationHash:
            packageResult.researchEvidenceCapsule
              ?.researchExecutionReleaseAttestationHash,
        })
        : null;
      const promotionCandidate = createAutomationPromotionCandidate({
        campaignPlanHash: campaign.spec.campaignPlanHash,
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        venueTarget: campaign.spec.venueTarget || null,
        packageNode,
        finalCompileNode,
        researchVerifyNode,
        researchReport,
        campaignResearchSourceSnapshot,
        verifiedSourceMerkleHash: packageStartSourceSnapshot.merkleHash,
        verifiedSourceWorkspaceManifestHash: packageStartSourceSnapshot.manifestHash,
        sourceWorkspace: workspace,
        sourceSnapshotHash: packageResult.sourceTreeManifest.sourceTreeManifestHash,
        sourceTreeManifest: packageResult.sourceTreeManifest,
        researchEvidenceCapsuleManifest: packageResult.researchEvidenceCapsule?.manifest || null,
        researchEvidenceCapsuleManifestFileHash:
          packageResult.researchEvidenceCapsule?.manifestFile?.hash || null,
        researchExecutionReleaseAttestation:
          packageResult.researchEvidenceCapsule?.researchExecutionReleaseAttestation || null,
        autonomousResearchReleaseBinding,
        advancedNumericalExecutionPlan,
        advancedNumericalExecutionEvidence,
        gpuScientificExecutionPlan,
        gpuScientificExecutionEvidence,
        gpuScientificResearchEvidence,
        gpuScientificPromotionEvidence,
        gpuScientificReleaseAuthorityFreshnessReceipt,
        createdAt,
        experimentRegistryAuthorityVerifier,
        gpuScientificPromotionAuthorityVerifier:
          releaseScopedGpuScientificPromotionAuthorityVerifier,
      });
      const publishedArtifactBaseRoot = path.dirname(publishedPackageDir);
      const packageOutputFiles = [
        ['generated_source_zip', packageResult.sourceZip, packageResult.sourceZip?.path ? path.resolve(publishedArtifactBaseRoot, packageResult.sourceZip.path) : null],
        ['compiled_pdf', packageResult.immutableCompiledPdf, packageResult.immutableCompiledPdf?.path ? path.resolve(publishedArtifactBaseRoot, packageResult.immutableCompiledPdf.path) : null],
        ['package_record', packageResult.packageRecord, path.join(publishedPackageDir, 'PACKAGE_RECORD.json')],
        ['sha256sums', packageResult.sha256Sums, path.join(publishedPackageDir, 'SHA256SUMS.txt')],
        ['independent_rebuilt_pdf', packageResult.independentRebuiltPdf, packageResult.independentRebuiltPdf?.path
          ? path.resolve(publishedArtifactBaseRoot, packageResult.independentRebuiltPdf.path) : null],
        ['independent_pdf_rebuild_receipt', packageResult.independentPdfRebuildReceiptRecord,
          packageResult.independentPdfRebuildReceiptRecord?.path
            ? path.resolve(publishedArtifactBaseRoot, packageResult.independentPdfRebuildReceiptRecord.path) : null],
      ].filter(([, record, candidate]) => record?.path && record?.hash && candidate).map(([role, record, candidate]) => Object.freeze({
        role,
        path: candidate,
        hash: record.hash,
        bytes: Number(record.sizeBytes),
      }));
      packageOutputFiles.push(...(packageResult.researchEvidenceCapsule?.allFiles || []).map((record) => Object.freeze({
        role: record.role === 'research_evidence_capsule_manifest'
          ? 'research_evidence_capsule_manifest'
          : record.role === 'research_execution_release_attestation'
            ? 'research_execution_release_attestation'
            : 'research_evidence_capsule_file',
        capsuleRole: record.role,
        executionRole: record.executionRole,
        experimentId: record.experimentId,
        path: path.join(publishedPackageDir, record.path),
        packageRelativePath: record.path,
        hash: record.hash,
        bytes: Number(record.bytes),
      })));
      const packageOutputPayload = {
        version: 1,
        kind: 'ImmutableCampaignPackageOutput',
        immutable: true,
        releaseRoot,
        packageDir: publishedPackageDir,
        artifactBaseRoot: publishedArtifactBaseRoot,
        sourceZipPath: packageResult.sourceZip?.path || null,
        sourceZipHash: packageResult.sourceZip?.hash || null,
        packageRecordPath: packageResult.packageRecord?.path || null,
        packageRecordHash: packageResult.packageRecord?.hash || null,
        sha256SumsPath: packageResult.sha256Sums?.path || null,
        sha256SumsHash: packageResult.sha256Sums?.hash || null,
        authoritativeCompiledPdfHash: packageResult.immutableCompiledPdf?.hash || null,
        independentRebuiltPdfHash: packageResult.independentRebuiltPdf?.hash || null,
        independentPdfRebuildVerificationReceiptHash:
          packageResult.independentPdfRebuildReceipt?.independentPdfRebuildVerificationReceiptHash || null,
        independentPdfRebuildReceiptFileHash: packageResult.independentPdfRebuildReceiptRecord?.hash || null,
        independentPdfRebuildReceipt: packageResult.independentPdfRebuildReceipt || null,
        packageVerificationReceiptHash: packageResult.packageVerificationReceipt.packageVerificationReceiptHash,
        researchEvidenceCapsuleManifestHash: packageResult.researchEvidenceCapsule?.researchEvidenceCapsuleManifestHash || null,
        researchEvidenceCapsuleManifestFileHash: packageResult.researchEvidenceCapsule?.manifestFile?.hash || null,
        researchExecutionReleaseAttestationHash:
          packageResult.researchEvidenceCapsule?.researchExecutionReleaseAttestationHash || null,
        researchExecutionReleaseAttestationFileHash:
          packageResult.researchEvidenceCapsule?.executionAttestationFile?.hash || null,
        files: packageOutputFiles,
        fileCount: packageOutputFiles.length,
        externalActionPerformed: false,
      };
      const packageOutput = Object.freeze({
        ...packageOutputPayload,
        immutableCampaignPackageOutputHash: hashRecord('ImmutableCampaignPackageOutput', packageOutputPayload),
      });
      const releaseBundle = createCampaignReleaseBundle({
        promotionCandidate,
        artifactPackage: packageResult.artifactPackage,
        packageVerificationReceipt: packageResult.packageVerificationReceipt,
        manuscriptPromotionGate: packageResult.manuscriptPromotionGate,
        researchReport,
        researchEvidenceCapsuleManifest: packageResult.researchEvidenceCapsule?.manifest || null,
        researchExecutionReleaseAttestation:
          packageResult.researchEvidenceCapsule?.researchExecutionReleaseAttestation || null,
        packageOutput,
        createdAt,
        experimentRegistryAuthorityVerifier,
        gpuScientificPromotionAuthorityVerifier:
          releaseScopedGpuScientificPromotionAuthorityVerifier,
      });
      const verification = verifyCampaignReleaseBundle(releaseBundle, expected, {
        experimentRegistryAuthorityVerifier,
        gpuScientificPromotionAuthorityVerifier:
          releaseScopedGpuScientificPromotionAuthorityVerifier,
      });
      if (!verification.valid) throw new Error(`campaign_release_bundle_self_verification_failed:${verification.blockers.join(',')}`);
      assertCampaignReleasePackageBuildTransactionCurrentSync({ runtimeRoot: resolvedRuntimeRoot, releaseRoot, expectedTransactionHash: packageBuildTransactionHash });
      const materializationReceipt = persistCampaignReleaseMaterializationSync({
        runtimeRoot: resolvedRuntimeRoot,
        releaseRoot,
        bundle: releaseBundle,
        preparedPackageDir: packageDir, generationLease,
      });
      return campaignReleasePackageNodeResult(releaseBundle, materializationReceipt);
      });
      });
    },
  };
  return assertCampaignReleasePackagerPort(port);
}
