import path from 'node:path';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { NATIVE_RESEARCH_WORKER_TYPES } from './native-research-worker-execution.mjs';

export async function buildNativeResearchWorkerExecutionReport({
  receipts,
  reportBlockers,
  workers,
  paperTask,
  planRecord,
  theoremSpecification,
  dynamicFormalExecutionAuthority,
  engineHash,
  selectedWorkerTypes,
  execute,
  outputDir,
  artifactRepository,
} = {}) {
  const verifiedReceipts = receipts.filter((receipt) => (
    receipt.status === 'native_research_worker_execution_verified'
    && receipt.academicEvidenceEligible === true
  ));
  const report = {
    version: 1,
    kind: 'NativeResearchWorkerExecutionReport',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: reportBlockers.length || verifiedReceipts.length !== workers.length
      ? 'native_research_workers_blocked'
      : 'native_research_workers_verified',
    executeRequested: Boolean(execute),
    planPath: planRecord?.path || null,
    planHash: planRecord?.hash || null,
    theoremSpecificationHash: theoremSpecification?.theoremSpecificationHash || null,
    theoremSpecificationClaimHashes: Object.freeze((theoremSpecification?.claims || [])
      .map((claim) => claim.theoremSpecificationClaimHash)),
    dynamicFormalExecutionAuthority,
    engineHash,
    workerTypeFilter: selectedWorkerTypes ? [...selectedWorkerTypes].sort() : null,
    plannedResearchWorkerCount: workers.length,
    executedResearchWorkerCount: verifiedReceipts.length,
    verifiedAcademicEvidenceWorkerCount: verifiedReceipts.length,
    workerReceipts: receipts,
    workerReceiptHashes: verifiedReceipts.map((receipt) => receipt.nativeResearchWorkerExecutionReceiptHash),
    blockers: [...new Set([
      ...reportBlockers,
      ...receipts.flatMap((receipt) => receipt.blockers || []),
    ])],
    safety: {
      allowlistedWorkerTypes: [...NATIVE_RESEARCH_WORKER_TYPES],
      networkAccess: false,
      subprocessExecution: workers.some((worker) => ['formal_verifier_lean', 'formal_verifier_lake'].includes(worker?.type)),
      subprocessBoundedByWorkerRunnerPort: true,
      sourceMutation: receipts.some((receipt) => receipt.sourceMutationDetected === true),
      writesRuntimeOnly: Boolean(execute),
      externalActionPerformed: false,
    },
  };
  const hashed = {
    ...report,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord('NativeResearchWorkerExecutionReport', report),
  };
  if (execute && outputDir && artifactRepository) {
    await artifactRepository.writeJson(path.join(outputDir, 'RESEARCH_WORKER_EXECUTION_REPORT.json'), hashed, {
      role: 'native_research_worker_execution_report',
    });
  }
  return hashed;
}
