import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SCIENTIFIC_VERDICTS = new Set(['positive', 'negative', 'inconclusive']);
const TECHNICAL_EXECUTION_BLOCKER = /(?:command_failed|execution_threw|runner_|runtime_identity|source_snapshot|source_changed|arm_adapter|response_document_shape|observation_(?:unreadable|json_invalid|artifact_mismatch|metric_set_invalid)|artifact_missing|output_|process_|schedule_incomplete|deadline_exhausted|cpu_budget_exhausted|environment_bom|dataset_access_unverified|raw_event_(?:artifact|count|limit)|metric_(?:set|schema|serialization))/;
const NON_TECHNICAL_OUTCOME_BLOCKER = /(?:confirmatory_hypothesis|hypothesis_not_supported|scientific_verdict|acceptance_predicate|declared_threshold_not_met|metric_inconsistent|replay_observation_inconsistent)/;

function infrastructureBlocked(result, language) {
  return (result.blockers || []).some((blocker) => /runtime_unavailable|sandbox_runtime_unavailable|gpu_required_but_unavailable|worker_dataset_access_(?:trusted_supervisor_backend_unavailable|tracer_unavailable)|os_sandbox_process_limit_unavailable/.test(blocker))
    || (language === 'latex' && /can't find the format file|mktexfmt:/i.test(`${result.stderrTail || ''}\n${result.stdoutTail || ''}`));
}

function scientificVerdict(result) {
  return result?.scientificVerdict || result?.harnessExecutionReceipt?.scientificVerdict
    || result?.harnessExecutionReceipt?.analysisProtocolEvaluation?.scientificVerdict || null;
}

export function empiricalTechnicalRepairEligible(result, { language = null } = {}) {
  if (!result || SCIENTIFIC_VERDICTS.has(scientificVerdict(result))
    || result.repairEligible === false || result.failureClass === 'scientific_outcome') return false;
  const blockers = Array.isArray(result.blockers) ? result.blockers.map(String) : [];
  if (blockers.some((blocker) => NON_TECHNICAL_OUTCOME_BLOCKER.test(blocker))) return false;
  return !infrastructureBlocked(result, language)
    && (blockers.some((blocker) => TECHNICAL_EXECUTION_BLOCKER.test(blocker))
      || (result.failureClass === 'technical_failure' && result.repairEligible === true && blockers.length === 0)
      || (language === 'latex' && Boolean(result.stderrTail || result.stdoutTail)));
}

export function empiricalResultContractTechnicalRepairEligible(contract) {
  const blockers = Array.isArray(contract?.blockers) ? contract.blockers.map(String) : [];
  if (!blockers.length || blockers.some((blocker) => NON_TECHNICAL_OUTCOME_BLOCKER.test(blocker))) return false;
  return blockers.every((blocker) => /^(?:empirical_results_(?:json|csv)_(?:missing|invalid)|empirical_metric_(?:schema_unsatisfied|missing:.*)|empirical_experiment_design_not_executed|empirical_(?:seed|repetition)_schedule_incomplete|empirical_(?:baseline|ablation)_results_missing|empirical_benchmark_metric_missing:.*|experiment_(?:run_result_artifact_hash_missing|json_csv_observations_mismatch))$/.test(blocker));
}

export function buildEmpiricalFailedAttemptRecord({ spec, result, contract = null }) {
  const payload = {
    version: 1,
    kind: 'EmpiricalFailedAttemptLineage',
    status: 'empirical_technical_failure_recorded',
    attemptVersion: Number(spec.empiricalAttemptVersion || 1),
    experimentAttemptId: String(spec.env?.HEPTA_EXPERIMENT_ATTEMPT_ID || ''),
    sourceLineageHash: spec.sourceLineageHash || null,
    analysisProtocolHash: spec.benchmarkSelector?.experimentDesign?.analysisProtocolHash || null,
    preDataAccessFreezeHash: result?.empiricalPreDataAccessFreezeHash
      || result?.harnessExecutionReceipt?.empiricalPreDataAccessFreezeHash || null,
    sourceMerkleHash: result?.sourceMerkleHash || result?.harnessExecutionReceipt?.sourceMerkleHash || null,
    sourceWorkspaceManifestHash: result?.sourceWorkspaceManifestHash
      || result?.harnessExecutionReceipt?.sourceWorkspaceManifestHash || null,
    executionStatus: result?.status || null,
    executionIntegrityStatus: result?.integrityStatus || null,
    failureClass: 'technical_failure',
    executionReceiptHash: result?.multiLanguageEmpiricalReceiptHash
      || result?.harnessExecutionReceipt?.systemBenchmarkHarnessExecutionReceiptHash || null,
    resultContractReceiptHash: contract?.empiricalResultContractReceiptHash || null,
    blockers: [...new Set([...(result?.blockers || []), ...(contract?.blockers || [])].map(String))],
  };
  return Object.freeze({ ...payload, empiricalFailedAttemptLineageHash: hashRecord('EmpiricalFailedAttemptLineage', payload) });
}

export function advanceEmpiricalTechnicalRepairSpec(spec, failedAttempt) {
  const attemptVersion = Number(spec.empiricalAttemptVersion || 1) + 1;
  const failedAttemptLineageHashes = Object.freeze([
    ...(spec.failedAttemptLineageHashes || []),
    failedAttempt.empiricalFailedAttemptLineageHash,
  ]);
  const rootAttemptId = String(spec.empiricalAttemptRootId || spec.env?.HEPTA_EXPERIMENT_ATTEMPT_ID || 'empirical-attempt');
  const sourceLineageHash = hashRecord('EmpiricalTechnicalRepairSourceLineage', {
    previousSourceLineageHash: spec.sourceLineageHash || null,
    failedAttemptLineageHash: failedAttempt.empiricalFailedAttemptLineageHash,
    attemptVersion,
  });
  return Object.freeze({
    ...spec,
    empiricalAttemptRootId: rootAttemptId,
    empiricalAttemptVersion: attemptVersion,
    failedAttemptLineageHashes,
    sourceLineageHash,
    env: Object.freeze({
      ...spec.env,
      HEPTA_EXPERIMENT_ATTEMPT_ID: `${rootAttemptId}:v${attemptVersion}`,
    }),
  });
}
