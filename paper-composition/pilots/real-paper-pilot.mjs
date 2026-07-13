// Concrete pilot composition; domain authority remains in the injected services.
import path from 'node:path';
import { runPaperBatch } from '../batch/paper-batch-application.mjs';
import { bootstrapPaperExecutionContext } from '../bootstrap/service-bootstrap.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { sha256File } from '../../workflow-kernel/runtime/file-utils.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export async function runRealPaperPilot({ root, runtimeRoot, paperId = null } = {}) {
  const inventory = await runPaperBatch({ root, runtimeRoot, mode: 'inventory' });
  const selected = inventory.results.find((item) => item.paperId === paperId)
    || inventory.results.find((item) => item.task.mainTex && (item.task.registry?.submissionIntent?.status || item.task.submissionIntent?.status) === 'submission_candidate');
  if (!selected) throw new Error('No real submission candidate with a main source was found');
  const sourceRoot = path.resolve(root, selected.task.sourceWorkspace);
  const mainTex = path.resolve(root, selected.task.mainTex);
  const mainTexRelative = path.relative(sourceRoot, mainTex).replace(/\\/g, '/');
  if (mainTexRelative.startsWith('..')) throw new Error('Pilot main source is outside its source workspace');
  const context = bootstrapPaperExecutionContext({ root, runtimeRoot, mode: 'real-paper-pilot', execute: true, writeReport: true });
  return withArtifactWriteContext(context.services, async () => {
    const mainTexHash = await sha256File(mainTex);
    const plan = {
      version: 1,
      kind: 'NativeResearchWorkerPlan',
      paperId: selected.paperId,
      taskKey: selected.task.taskKey,
      pilotClass: 'real_paper_non_authoritative_integrity_pilot',
      workers: [{
        id: 'pilot_source_integrity',
        type: 'artifact_integrity',
        evidenceClass: 'research_evidence',
        syntheticInput: false,
        outcomesPreprogrammed: false,
        claimIds: ['pilot-source-integrity'],
        inputs: [{ role: 'manuscript_source', path: mainTexRelative, sha256: mainTexHash }],
        parameters: {},
      }],
    };
    const sourceRepository = context.services.artifactRepositoryFactory(sourceRoot);
    const planWriteReceipt = await sourceRepository.writeJson(path.join(sourceRoot, 'RESEARCH_WORKER_PLAN.json'), plan, { role: 'real_paper_research_worker_plan' });
    const researchRun = await runPaperBatch({ root, runtimeRoot, mode: 'research-verify', paperIds: [selected.paperId], execute: true });
    const reviewedRun = await runPaperBatch({ root, runtimeRoot, mode: 'reviewed-submit', paperIds: [selected.paperId], execute: false });
    const research = researchRun.results[0]?.researchReport || null;
    const reviewed = reviewedRun.results[0] || null;
    const lifecycle = reviewed?.lifecycle || null;
    const blockers = [
      ...(research?.blockers || []),
      ...(lifecycle?.reviewedSubmitPreflightPacket?.blockers || []),
    ];
    const payload = {
      version: 1,
      kind: 'RealPaperEndToEndPilotReceipt',
      status: lifecycle?.reviewedSubmitPreflightPacket?.status === 'reviewed_submit_preflight_ready_for_external_executor'
        ? 'real_paper_pilot_handoff_ready'
        : 'real_paper_pilot_blocked_on_external_materials',
      paperId: selected.paperId,
      taskKey: selected.task.taskKey,
      sourceWorkspace: selected.task.sourceWorkspace,
      mainTex: selected.task.mainTex,
      mainTexHash,
      researchWorkerPlanHash: planWriteReceipt.hash,
      researchWorkerPlanWriteReceiptHash: planWriteReceipt.writeReceiptHash,
      nativeWorkerStatus: research?.nativeResearchWorkerExecution?.status || null,
      nativeWorkerReceiptHashes: research?.nativeResearchWorkerExecution?.workerReceiptHashes || [],
      academicEvidenceStatus: research?.academicEvidenceAttestation?.status || null,
      academicEvidenceReceiptHash: research?.academicEvidenceAttestation?.academicEvidenceAttestationHash || null,
      independentRefereeStatus: lifecycle?.independentReviewAuthorityReceipt?.status || null,
      independentRefereeReceiptHash: lifecycle?.independentReviewAuthorityReceipt?.independentRefereeAuthorityReceiptHash || null,
      liveAuthorizationStatus: lifecycle?.liveAuthorizationReceipt?.status || null,
      liveAuthorizationReceiptHash: lifecycle?.liveAuthorizationReceipt?.liveSubmissionAuthorizationReceiptHash || null,
      preflightStatus: lifecycle?.reviewedSubmitPreflightPacket?.status || null,
      controlledExecutorStatus: lifecycle?.controlledExecutorReceipt?.status || null,
      providerExecutorPresent: false,
      externalActionPerformed: false,
      blockers: [...new Set(blockers)],
      replay: {
        researchReportHash: research?.researchReportHash || null,
        lifecycleReceiptHash: lifecycle?.receipt?.adapterRunReceiptHash || null,
        venueStateProofHash: lifecycle?.venueStateProof?.channelStateProofHash || null,
      },
    };
    const realPaperEndToEndPilotReceiptHash = hashRecord('RealPaperEndToEndPilotReceipt', payload);
    const receipt = { ...payload, realPaperEndToEndPilotReceiptHash };
    const ledger = context.services.receiptLedger.record({ ...receipt, receiptHash: realPaperEndToEndPilotReceiptHash }, { stream: 'real-paper-pilots', paperId: selected.paperId });
    const outputRoot = path.join(runtimeRoot, 'pilots', selected.paperId);
    const repository = context.services.artifactRepositoryFactory(outputRoot);
    const writeReceipt = await repository.writeJson(path.join(outputRoot, 'REAL_PAPER_END_TO_END_PILOT_RECEIPT.json'), { ...receipt, ledgerReceiptId: ledger.receiptId }, { role: 'real_paper_pilot_receipt' });
    return { ...receipt, ledgerReceiptId: ledger.receiptId, writeReceiptHash: writeReceipt.writeReceiptHash };
  });
}
