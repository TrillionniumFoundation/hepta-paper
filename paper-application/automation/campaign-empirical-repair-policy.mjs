import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SCIENTIFIC_VERDICTS = new Set(['positive', 'negative', 'inconclusive']);
const TECHNICAL_EXECUTION_BLOCKER = /(?:command_failed|execution_threw|runner_|runtime_identity|source_snapshot|source_changed|arm_adapter|response_document_shape|observation_(?:unreadable|json_invalid|artifact_mismatch|metric_set_invalid)|artifact_missing|output_|process_|schedule_incomplete|deadline_exhausted|cpu_budget_exhausted|environment_bom|dataset_access_unverified|raw_event_(?:artifact|count|limit)|metric_(?:set|schema|serialization))/;
const NON_TECHNICAL_OUTCOME_BLOCKER = /(?:confirmatory_hypothesis|hypothesis_not_supported|scientific_verdict|acceptance_predicate|declared_threshold_not_met|metric_inconsistent|replay_observation_inconsistent)/;
const OUTCOME_BLIND_DIAGNOSTIC_KEYS = Object.freeze([
  'version', 'kind', 'source', 'failureClasses', 'rawProcessOutputWithheld',
  'observedOutcomesWithheld', 'artifactsWithheld', 'empiricalOutcomeBlindRepairDiagnosticHash',
]);

const EXECUTION_FAILURE_CLASSES = Object.freeze([
  [/command_failed/, 'command_failed'],
  [/execution_threw/, 'execution_threw'],
  [/runner_/, 'runner_failure'],
  [/runtime_identity/, 'runtime_identity_failure'],
  [/source_snapshot|source_changed/, 'source_identity_failure'],
  [/arm_adapter/, 'arm_adapter_failure'],
  [/response_document_shape/, 'response_shape_failure'],
  [/observation_unreadable/, 'observation_unreadable'],
  [/observation_json_invalid/, 'observation_json_invalid'],
  [/observation_artifact_mismatch/, 'observation_artifact_mismatch'],
  [/observation_metric_set_invalid/, 'observation_metric_set_invalid'],
  [/artifact_missing/, 'artifact_missing'],
  [/output_/, 'output_contract_failure'],
  [/process_/, 'process_failure'],
  [/schedule_incomplete/, 'schedule_incomplete'],
  [/deadline_exhausted/, 'deadline_exhausted'],
  [/cpu_budget_exhausted/, 'cpu_budget_exhausted'],
  [/environment_bom/, 'environment_identity_failure'],
  [/dataset_access_unverified/, 'dataset_access_unverified'],
  [/raw_event_(?:artifact|count|limit)/, 'raw_event_contract_failure'],
  [/metric_(?:set|schema|serialization)/, 'metric_contract_failure'],
]);

const RESULT_CONTRACT_FAILURE_CLASSES = Object.freeze([
  [/empirical_results_json_missing/, 'results_json_missing'],
  [/empirical_results_json_invalid/, 'results_json_invalid'],
  [/empirical_results_csv_missing/, 'results_csv_missing'],
  [/empirical_results_csv_invalid/, 'results_csv_invalid'],
  [/empirical_metric_schema_unsatisfied/, 'metric_schema_unsatisfied'],
  [/empirical_metric_missing:/, 'registered_metric_missing'],
  [/empirical_experiment_design_not_executed/, 'experiment_design_not_executed'],
  [/empirical_seed_schedule_incomplete/, 'seed_schedule_incomplete'],
  [/empirical_repetition_schedule_incomplete/, 'repetition_schedule_incomplete'],
  [/empirical_baseline_results_missing/, 'baseline_results_missing'],
  [/empirical_ablation_results_missing/, 'ablation_results_missing'],
  [/empirical_benchmark_metric_missing:/, 'benchmark_metric_missing'],
  [/experiment_run_result_artifact_hash_missing/, 'result_artifact_hash_missing'],
  [/experiment_json_csv_observations_mismatch/, 'json_csv_observations_mismatch'],
]);

function classifiedFailures(blockers, classifiers, fallback) {
  const classes = [];
  for (const blocker of blockers) {
    const matched = classifiers.find(([pattern]) => pattern.test(String(blocker || '')));
    if (matched) classes.push(matched[1]);
  }
  return [...new Set(classes.length ? classes : [fallback])].sort();
}

function outcomeBlindDiagnostic(source, failureClasses) {
  const payload = {
    version: 1,
    kind: 'EmpiricalOutcomeBlindRepairDiagnostic',
    source,
    failureClasses: Object.freeze([...failureClasses]),
    rawProcessOutputWithheld: true,
    observedOutcomesWithheld: true,
    artifactsWithheld: true,
  };
  return Object.freeze({
    ...payload,
    empiricalOutcomeBlindRepairDiagnosticHash: hashRecord('EmpiricalOutcomeBlindRepairDiagnostic', payload),
  });
}

function infrastructureBlocked(result, language) {
  return (result.blockers || []).some((blocker) => /runtime_unavailable|sandbox_runtime_unavailable|gpu_required_but_unavailable|worker_dataset_access_(?:trusted_supervisor_backend_unavailable|tracer_unavailable)|os_sandbox_process_limit_unavailable/.test(blocker))
    || (language === 'latex' && /can't find the format file|mktexfmt:/i.test(`${result.stderrTail || ''}\n${result.stdoutTail || ''}`));
}

function scientificVerdict(result) {
  return result?.scientificVerdict || result?.harnessExecutionReceipt?.scientificVerdict
    || result?.harnessExecutionReceipt?.analysisProtocolEvaluation?.scientificVerdict || null;
}

function latexScientificContentBinding(source) {
  const withoutTechnicalPreamble = String(source || '')
    .replace(/^\s*\\usepackage(?:\[[^\]\n]*\])?\{[^{}\n]*\}\s*$/gm, '')
    .replace(/(^|[^\\])%.*$/gm, '$1');
  const atoms = withoutTechnicalPreamble.match(
    /\\[A-Za-z@]+|\\[^\sA-Za-z]|[\p{L}\p{N}]+(?:[.'’_-][\p{L}\p{N}]+)*|[<>=+\-*/^_|&]/gu,
  ) || [];
  return Object.freeze({
    atomCount: atoms.length,
    contentHash: hashRecord('LatexScientificContentAtoms', { atoms }),
  });
}

export function assertLatexTechnicalRepairPreservesScientificContent({
  before,
  after,
  repairReceipt = null,
} = {}) {
  const beforeBinding = latexScientificContentBinding(before);
  const afterBinding = latexScientificContentBinding(after);
  const preserved = beforeBinding.contentHash === afterBinding.contentHash;
  const payload = {
    version: 1,
    kind: 'LatexTechnicalRepairContentPreservationReceipt',
    status: preserved
      ? 'latex_technical_repair_content_preserved'
      : 'latex_technical_repair_content_changed',
    beforeScientificContentHash: beforeBinding.contentHash,
    afterScientificContentHash: afterBinding.contentHash,
    beforeScientificAtomCount: beforeBinding.atomCount,
    afterScientificAtomCount: afterBinding.atomCount,
    repairAgentReceiptHash: repairReceipt?.agentExecutionReceiptHash || null,
    externalActionPerformed: false,
  };
  const receipt = Object.freeze({
    ...payload,
    latexTechnicalRepairContentPreservationReceiptHash: hashRecord(
      'LatexTechnicalRepairContentPreservationReceipt',
      payload,
    ),
  });
  if (!preserved) {
    const error = new Error('campaign_latex_repair_scientific_content_changed');
    error.retryable = false;
    error.receipt = receipt;
    throw error;
  }
  return receipt;
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

export function assertConfirmatoryWritableRepairAllowed({ spec, language, nodeKind, stage, receipt = null } = {}) {
  if (language === 'latex' || (!spec?.benchmarkSelector && !spec?.datasetMounts?.length)) return true;
  const error = new Error(`campaign_confirmatory_writable_repair_fail_closed:${nodeKind || 'unknown'}:${stage || 'unknown'}`);
  error.retryable = false;
  error.receipt = receipt;
  throw error;
}

export function buildEmpiricalOutcomeBlindExecutionDiagnostic(result, { language = null } = {}) {
  if (!empiricalTechnicalRepairEligible(result, { language })) {
    const error = new Error('empirical_outcome_blind_execution_diagnostic_not_technical');
    error.retryable = false;
    throw error;
  }
  const blockers = Array.isArray(result?.blockers) ? result.blockers.map(String) : [];
  const fallback = language === 'latex' ? 'latex_compilation_failure' : 'technical_execution_failure';
  return outcomeBlindDiagnostic('execution', classifiedFailures(blockers, EXECUTION_FAILURE_CLASSES, fallback));
}

export function buildEmpiricalOutcomeBlindResultContractDiagnostic(contract) {
  if (!empiricalResultContractTechnicalRepairEligible(contract)) {
    const error = new Error('empirical_outcome_blind_result_contract_diagnostic_not_technical');
    error.retryable = false;
    throw error;
  }
  return outcomeBlindDiagnostic('result-contract', classifiedFailures(
    contract.blockers,
    RESULT_CONTRACT_FAILURE_CLASSES,
    'result_contract_failure',
  ));
}

export function verifyEmpiricalOutcomeBlindRepairDiagnostic(value, { source = null } = {}) {
  if (!exactKeys(value, OUTCOME_BLIND_DIAGNOSTIC_KEYS)) return false;
  const { empiricalOutcomeBlindRepairDiagnosticHash, ...payload } = value;
  return value.version === 1
    && value.kind === 'EmpiricalOutcomeBlindRepairDiagnostic'
    && ['execution', 'result-contract'].includes(value.source)
    && (!source || value.source === source)
    && Array.isArray(value.failureClasses)
    && value.failureClasses.length > 0
    && value.failureClasses.every((item) => /^[a-z][a-z0-9_]{0,95}$/.test(String(item || '')))
    && new Set(value.failureClasses).size === value.failureClasses.length
    && JSON.stringify([...value.failureClasses].sort()) === JSON.stringify(value.failureClasses)
    && value.rawProcessOutputWithheld === true
    && value.observedOutcomesWithheld === true
    && value.artifactsWithheld === true
    && hashRecord('EmpiricalOutcomeBlindRepairDiagnostic', payload)
      === empiricalOutcomeBlindRepairDiagnosticHash;
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
