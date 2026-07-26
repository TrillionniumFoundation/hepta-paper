import path from 'node:path';
import { resolveRepoPath } from '../../workflow-kernel/runtime/path-utils.mjs';
import { bindResearchGapPlan } from '../../paper-domain/research/gap-planner.mjs';
import { defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { verifyAcademicEvidenceAttestation } from './academic-evidence.mjs';
import { verifyEvidenceBatch } from './evidence-verifier.mjs';
import {
  runNativeResearchWorkers,
  verifyNativeResearchWorkerExecutionReport,
} from './worker-runtime.mjs';
import { produceTrustedFormalEvidence } from './trusted-formal-producer.mjs';
import {
  readRefereeRevisionRequests,
  readResearchEvidenceSources,
} from './research-evidence-reader.mjs';
import {
  buildEvidenceVerificationCandidates,
  buildResearchCapabilityState,
  buildResearchContractContext,
  buildResearchVerifyReport,
} from './research-report-builder.mjs';
import { verifyCampaignResearchSourceSnapshot } from '../../paper-domain/automation/campaign-research-contract.mjs';
import { createOperatorDatasetHarnessAuthorityReceiptVerifier } from '../automation/operator-dataset-harness-authority-receipt-verifier.mjs';
import { loadOperatorDatasetAuthorityTrustStoreSync } from '../automation/operator-dataset-harness-reader.mjs';
import { createIndependentRawEventArtifactRecomputationVerifier } from './raw-event-artifact-recomputation-verifier.mjs';

export async function runResearchVerifyAdapter({
  root,
  row,
  runtimeRoot = null,
  executeResearchWorkers = false,
  requireNativeWorkers = false,
  trustStoreOverride = null,
  now = new Date(),
  authorityVerifier = null,
  jobReceiptStore = null,
  nativeResearchWorkerJobReceiptStore = null,
  artifactRepositoryFactory = null,
  receiptLedger = null,
  trustedResearchReceiptWriters = null,
  clock = null,
  trustedFormalSandboxRuntime = null,
  trustedFormalExecutionAuthority = null,
  campaign = null,
  authoritativeFormalNode = null,
  authoritativeTheoremSpecification = null,
  authoritativeFormalReceipt = null,
  assertExternalSideEffectReady = null,
  executionSignal = null,
  store = null,
  formalReviewEnvelope = null,
  campaignExperiments = [],
  campaignEvidenceContext = null,
  campaignResearchSourceSnapshot = null,
  nativeResearchWorkerExecutionOverride = null,
  operatorDatasetHarnessAuthorityVerifier: suppliedDatasetAuthorityVerifier = null,
  rawEventRecomputationVerifier: suppliedRawEventRecomputationVerifier = null,
  externalReplayRequired = false,
  externalReplayRequest = null,
  externalReplayReceipt = null,
  externalReplayReceiptVerifier = null,
} = {}) {
  if (campaignResearchSourceSnapshot) {
    const snapshotVerification = verifyCampaignResearchSourceSnapshot(campaignResearchSourceSnapshot, {
      campaignId: campaignEvidenceContext?.campaignId || null,
      paperId: row?.task?.paperId || null,
      researchNodeId: campaignEvidenceContext?.researchNodeId || null,
      researchAttemptId: campaignEvidenceContext?.researchAttemptId || null,
      researchLeaseGeneration: campaignEvidenceContext?.researchLeaseGeneration || null,
    });
    if (!snapshotVerification.valid) throw new Error(`campaign_research_source_snapshot_invalid:${snapshotVerification.blockers.join(',')}`);
  }
  const sourceRoot = resolveRepoPath(root, row.task.sourceWorkspace);
  const resolvedRuntimeRoot = runtimeRoot
    ? path.resolve(runtimeRoot)
    : defaultPaperRuntimeRoot();
  const operatorDatasetHarnessAuthorityVerifier = suppliedDatasetAuthorityVerifier
    || createOperatorDatasetHarnessAuthorityReceiptVerifier({
      trustStoreProvider: () => loadOperatorDatasetAuthorityTrustStoreSync({
        runtimeRoot: resolvedRuntimeRoot,
        trustStoreOverride,
      }),
      clock: clock?.now ? clock : Object.freeze({ now: () => new Date(now) }),
    });
  const rawEventRecomputationVerifier = suppliedRawEventRecomputationVerifier
    || createIndependentRawEventArtifactRecomputationVerifier({
      runtimeRoot: resolvedRuntimeRoot,
      trustStoreProvider: () => loadOperatorDatasetAuthorityTrustStoreSync({
        runtimeRoot: resolvedRuntimeRoot,
        trustStoreOverride,
      }),
      clock: clock?.now ? clock : Object.freeze({ now: () => new Date(now) }),
    });
  const logRoot = path.join(root, 'logs', 'paperctl', row.task.paperId);
  const empiricalRoot = path.join(resolvedRuntimeRoot, 'empirical-analysis', row.task.paperId);
  const evidence = await readResearchEvidenceSources({ root, sourceRoot, logRoot, empiricalRoot, paperTask: row.task });
  const directRunIds = new Set(campaignExperiments.map((item) => item?.experimentRunReceipt?.experimentRunReceiptHash).filter(Boolean));
  const structured = {
    ...evidence.structured,
    experiments: [
      ...evidence.structured.experiments.filter((item) => !directRunIds.has(item?.experimentRunReceipt?.experimentRunReceiptHash)),
      ...campaignExperiments,
    ],
  };

  if (nativeResearchWorkerExecutionOverride) {
    const verification = verifyNativeResearchWorkerExecutionReport(
      nativeResearchWorkerExecutionOverride,
      {
        paperId: row.task.paperId,
        taskKey: row.task.taskKey,
        requireFormalWorkers: true,
      },
    );
    if (!verification.valid) {
      throw new Error(
        `native_research_worker_execution_override_invalid:${verification.blockers.join(',')}`,
      );
    }
  }
  const trustedFormalEvidence = [];
  if (trustedFormalExecutionAuthority) {
    trustedFormalEvidence.push(await produceTrustedFormalEvidence({
      root,
      runtimeRoot: resolvedRuntimeRoot,
      paperTask: row.task,
      campaignEvidenceContext,
      campaignResearchSourceSnapshot,
      campaign,
      authoritativeFormalNode,
      authoritativeTheoremSpecification,
      authoritativeFormalReceipt,
      nativeResearchWorkerExecution: nativeResearchWorkerExecutionOverride,
      proposalClaimToTheoremBinding:
        formalReviewEnvelope?.proposalClaimToTheoremBinding || null,
      requestHints: evidence.structured.formalCertificateRequests,
      campaignExecutionAuthority: trustedFormalExecutionAuthority,
      assertExternalSideEffectReady,
      executionSignal,
      artifactRepositoryFactory,
      receiptWriters: trustedResearchReceiptWriters,
      clock,
      trustedSandboxRuntime: trustedFormalSandboxRuntime,
    }));
  }
  const nativeResearchWorkerExecution = nativeResearchWorkerExecutionOverride || await runNativeResearchWorkers({
    root,
    sourceRoot,
    runtimeRoot: resolvedRuntimeRoot,
    paperTask: row.task,
    execute: Boolean(executeResearchWorkers),
    jobReceiptStore: nativeResearchWorkerJobReceiptStore,
    artifactRepositoryFactory,
    formalReviewEnvelope,
    campaignEvidenceContext,
  });
  const academicEvidenceAttestation = await verifyAcademicEvidenceAttestation({
    root,
    sourceRoot,
    runtimeRoot: resolvedRuntimeRoot,
    paperTask: row.task,
    workerExecutionReport: nativeResearchWorkerExecution,
    trustStoreOverride,
    now,
  });
  const contractContext = buildResearchContractContext({
    row,
    sourceRoot,
    evidenceRecords: evidence.evidenceRecords,
    proposalSeedEvidence: evidence.proposalSeedEvidence,
    structured,
    nativeResearchWorkerExecution,
    requireNativeWorkers,
  });
  const evidenceVerificationReceipts = await verifyEvidenceBatch({
    sourceRoot,
    evidenceItems: buildEvidenceVerificationCandidates({ root, sourceRoot, structured }),
    authorityVerifier,
  });
  const revisionRequests = readRefereeRevisionRequests(store, row.task.paperId);
  const capabilityState = buildResearchCapabilityState({
    row,
    structured,
    contractContext,
    academicEvidenceAttestation,
    nativeResearchWorkerExecution,
    evidenceVerificationReceipts,
    trustedFormalEvidence,
    revisionRequests,
    receiptLedger,
    campaignEvidenceContext,
    researchSourceSnapshotHash:
      campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash || null,
    campaignResearchSourceSnapshot,
    formalReviewEnvelope,
    operatorDatasetHarnessAuthorityVerifier,
    rawEventRecomputationVerifier,
    externalReplayRequired,
    externalReplayRequest,
    externalReplayReceipt,
    externalReplayReceiptVerifier,
    now,
  });
  const researchGapPlanBinding = executeResearchWorkers && jobReceiptStore && receiptLedger && clock
    ? bindResearchGapPlan({
      plan: capabilityState.researchGapPlan,
      jobReceiptStore,
      receiptLedger,
      clock,
      workerId: executeResearchWorkers ? 'research-gap-planner' : null,
    })
    : null;
  return buildResearchVerifyReport({
    root,
    row,
    sourceRoot,
    logRoot,
    empiricalRoot,
    ...evidence,
    structured,
    contractContext,
    capabilityState,
    academicEvidenceAttestation,
    nativeResearchWorkerExecution,
    trustedFormalEvidence,
    evidenceVerificationReceipts,
    researchGapPlanBinding,
    executeResearchWorkers,
    trustedFormalExecutionAuthority,
    campaignResearchSourceSnapshot,
    formalReviewEnvelope,
    externalReplayRequired,
    externalReplayRequest,
    externalReplayReceipt,
  });
}
