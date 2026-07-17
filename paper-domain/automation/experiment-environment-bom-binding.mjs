import { verifyEmpiricalEnvironmentBom } from './environment-bom-contract.mjs';

export const EXPERIMENT_REPLAY_ASSURANCE_SCOPE =
  'independent-process-replay-same-hardware-bom-allowed-not-independent-hardware-replication-v1';

function exactBomBinding(environmentBom, environmentBomHash) {
  return verifyEmpiricalEnvironmentBom(environmentBom).valid
    && environmentBom?.environmentBomHash === environmentBomHash;
}

export function verifyHarnessEnvironmentBomBinding(receipt) {
  const workers = (receipt?.armBatchExecutions || []).map((batch) => batch.runnerReceipt);
  return workers.length === receipt?.expectedProcessExecutionCount
    && exactBomBinding(receipt?.environmentBom, receipt?.environmentBomHash)
    && workers.every((worker) => worker.environmentBomHash === receipt.environmentBomHash
      && JSON.stringify(worker.environmentBom) === JSON.stringify(receipt.environmentBom));
}

export function buildExperimentRunEnvironmentBomBinding({ harnessExecutionReceipt, runnerReceipt } = {}) {
  const executionReceipt = harnessExecutionReceipt || runnerReceipt || null;
  const fields = Object.freeze({
    environmentBom: executionReceipt?.environmentBom || null,
    environmentBomHash: executionReceipt?.environmentBomHash || null,
  });
  return Object.freeze({
    fields,
    blockers: Object.freeze(exactBomBinding(fields.environmentBom, fields.environmentBomHash)
      ? [] : ['experiment_run_environment_bom_invalid']),
  });
}

export function verifyExperimentRunEnvironmentBomBinding(receipt) {
  const executionReceipt = receipt?.harnessExecutionReceipt || receipt?.runnerReceipt || null;
  return exactBomBinding(receipt?.environmentBom, receipt?.environmentBomHash)
    && executionReceipt?.environmentBomHash === receipt.environmentBomHash
    && JSON.stringify(executionReceipt?.environmentBom) === JSON.stringify(receipt.environmentBom);
}

export function experimentReplayEnvironmentBomFields(originalRunReceipt, replayRunReceipt) {
  return Object.freeze({
    originalEnvironmentBomHash: originalRunReceipt?.environmentBomHash || null,
    replayEnvironmentBomHash: replayRunReceipt?.environmentBomHash || null,
    replayAssuranceScope: EXPERIMENT_REPLAY_ASSURANCE_SCOPE,
  });
}

export function verifyExperimentReplayEnvironmentBomBinding(receipt) {
  return receipt?.originalEnvironmentBomHash === receipt?.originalRunReceipt?.environmentBomHash
    && receipt?.replayEnvironmentBomHash === receipt?.replayRunReceipt?.environmentBomHash
    && receipt?.replayAssuranceScope === EXPERIMENT_REPLAY_ASSURANCE_SCOPE;
}
