import { decodeSystemBenchmarkArmBatchChallengeEnvironment } from '../../paper-domain/automation/system-benchmark-challenge.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PERMITTED_WORKER_ENVIRONMENT_KEYS = new Set([
  'ELAN_HOME', 'ELAN_TOOLCHAIN', 'LEAN_PATH', 'LAKE_HOME', 'HEPTA_SEED', 'HEPTA_OUTPUT_DIR',
  'HEPTA_BENCHMARK_ID', 'HEPTA_BENCHMARK_SELECTOR_HASH', 'HEPTA_EXPERIMENT_DESIGN_HASH',
  'HEPTA_EXPERIMENT_DESIGN_JSON', 'HEPTA_BENCHMARK_HARNESS_HASH', 'HEPTA_EXPERIMENT_ATTEMPT_ID',
  'HEPTA_EXPERIMENT_RUN_ID', 'HEPTA_EXPERIMENT_SEED', 'HEPTA_EXPERIMENT_REPETITION',
  'HEPTA_EXPERIMENT_ARM', 'HEPTA_EXPERIMENT_ARM_PROTOCOL_ID', 'HEPTA_EXPERIMENT_ARM_PROTOCOL_HASH',
  'HEPTA_EXPERIMENT_ARM_PROTOCOL_SET_HASH', 'HEPTA_EXPERIMENT_ARM_ADAPTER_PATH',
  'HEPTA_EXPERIMENT_ARM_ADAPTER_HASH', 'HEPTA_EXPERIMENT_ARM_ADAPTER_SET_HASH',
  'HEPTA_PRE_DATA_ACCESS_FREEZE_HASH',
  'HEPTA_BENCHMARK_CHALLENGE_HASH', 'HEPTA_BENCHMARK_CHALLENGE_JSON', 'HEPTA_BENCHMARK_CHALLENGE_PART_COUNT',
  'HEPTA_BENCHMARK_CHALLENGE_JSON_PART_1', 'HEPTA_BENCHMARK_CHALLENGE_JSON_PART_2',
  'HEPTA_BENCHMARK_CHALLENGE_JSON_PART_3', 'HEPTA_BENCHMARK_CHALLENGE_JSON_PART_4', 'HEPTA_HARNESS_CELL_ID',
  'PYTHONHASHSEED', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS',
  'BLIS_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'RAYON_NUM_THREADS', 'OMP_DYNAMIC', 'MKL_DYNAMIC',
  'CUDA_VISIBLE_DEVICES', 'R_ENVIRON_USER', 'RENV_PATHS_CACHE',
]);

export function selectAndValidateWorkerEnvironment({ env = {}, datasetAuthorizationSetHash = null } = {}) {
  const permittedEnvironment = Object.entries({ ...env, HEPTA_DATASET_AUTHORIZATION_SET_HASH: datasetAuthorizationSetHash })
    .filter(([key]) => PERMITTED_WORKER_ENVIRONMENT_KEYS.has(key) || key.startsWith('HEPTA_DATASET_'));
  const challengeEnvironment = Object.fromEntries(permittedEnvironment);
  const blockers = [];
  if (challengeEnvironment.HEPTA_BENCHMARK_CHALLENGE_JSON !== undefined) {
    let challenge = null;
    try { challenge = JSON.parse(String(challengeEnvironment.HEPTA_BENCHMARK_CHALLENGE_JSON || '')); } catch { challenge = null; }
    const { systemBenchmarkCellChallengeHash = null, ...challengePayload } = challenge || {};
    if (Buffer.byteLength(String(challengeEnvironment.HEPTA_BENCHMARK_CHALLENGE_JSON || '')) > 64 * 1024
      || !challenge || challenge.kind !== 'SystemBenchmarkCellChallenge' || challenge.version !== 1
      || systemBenchmarkCellChallengeHash !== challengeEnvironment.HEPTA_BENCHMARK_CHALLENGE_HASH
      || hashRecord('SystemBenchmarkCellChallenge', challengePayload) !== systemBenchmarkCellChallengeHash) {
      blockers.push('worker_benchmark_challenge_binding_invalid');
    }
  } else if (challengeEnvironment.HEPTA_BENCHMARK_CHALLENGE_PART_COUNT !== undefined
    || challengeEnvironment.HEPTA_BENCHMARK_CHALLENGE_HASH !== undefined) {
    if (!decodeSystemBenchmarkArmBatchChallengeEnvironment(challengeEnvironment)) {
      blockers.push('worker_benchmark_arm_batch_challenge_binding_invalid');
    }
  }
  const environmentBindingHash = hashRecord('WorkerEnvironmentBinding', Object.fromEntries(
    permittedEnvironment.map(([key, value]) => [key, String(value)]).sort(([left], [right]) => left.localeCompare(right)),
  ));
  return Object.freeze({ permittedEnvironment: Object.freeze(permittedEnvironment), environmentBindingHash, blockers: Object.freeze(blockers) });
}
