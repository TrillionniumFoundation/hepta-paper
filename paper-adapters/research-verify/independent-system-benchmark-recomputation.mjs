import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  REGISTERED_SCALAR_RESPONSE_BENCHMARK_FAMILY,
  SYSTEM_BENCHMARK_EVALUATOR_REGISTRY,
  systemBenchmarkEvaluatorDescriptorFor,
} from '../../paper-domain/automation/system-benchmark-evaluator-abi.mjs';
import {
  SYSTEM_BENCHMARK_CASE_COUNT,
  SYSTEM_BENCHMARK_CHALLENGE_MAXIMUM_PARTS,
  SYSTEM_BENCHMARK_CHALLENGE_PART_BYTES,
} from '../../paper-domain/automation/system-benchmark-challenge-limits.mjs';
import {
  autonomousEmpiricalFamilyPluginProfileFor,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const MAXIMUM_RAW_EVENTS_PER_CELL = 64;
const ARMS = new Set(['treatment', 'baseline', 'ablation']);

function responseFieldFor(benchmarkFamily) {
  return autonomousEmpiricalFamilyPluginProfileFor(benchmarkFamily)?.responseField || null;
}

const INDEPENDENCE_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'RawEventRecomputationIndependenceContract',
  level: 'repository-separate-implementation-same-process-v1',
  dataSourceIndependent: true,
  fixtureOracleBuilderIndependent: true,
  responseEventEvaluatorIndependent: true,
  eventMetricAggregatorIndependent: true,
  producerEvaluatorImportsAllowed: false,
  processIndependent: false,
  sharedTrustBase: Object.freeze([
    'sha256-record-identity',
    'scoped-cas-artifact-reader',
    'signed-private-fixture-source-resolver',
  ]),
});

export const RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT = Object.freeze({
  ...INDEPENDENCE_PAYLOAD,
  rawEventRecomputationIndependenceContractHash: hashRecord(
    'RawEventRecomputationIndependenceContract',
    INDEPENDENCE_PAYLOAD,
  ),
});

const IMPLEMENTATION_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'IndependentSystemBenchmarkRecomputationImplementation',
  assuranceScope: RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT.level,
  independenceContractHash:
    RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT
      .rawEventRecomputationIndependenceContractHash,
  evaluatorRegistryHash:
    SYSTEM_BENCHMARK_EVALUATOR_REGISTRY.systemBenchmarkEvaluatorRegistryHash,
  producerEvaluatorImportsAllowed: false,
  processIndependent: false,
});

// The release production-graph manifest binds the bytes of this module. This
// record separately gives receipts a stable, typed identity for the verifier
// implementation instead of reusing the producer harness identity.
export const INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION = Object.freeze({
  ...IMPLEMENTATION_PAYLOAD,
  independentSystemBenchmarkRecomputationImplementationHash: hashRecord(
    'IndependentSystemBenchmarkRecomputationImplementation',
    IMPLEMENTATION_PAYLOAD,
  ),
});

function same(left, right, kind = 'IndependentRecomputationExpected') {
  return hashRecord(kind, left) === hashRecord(kind, right);
}

function mean(values) {
  if (!values.length) return Number.NaN;
  let total = 0;
  let lostLowOrder = 0;
  for (const value of values) {
    const combined = total + value;
    lostLowOrder += Math.abs(total) >= Math.abs(value)
      ? (total - combined) + value
      : (value - combined) + total;
    total = combined;
  }
  return (total + lostLowOrder) / values.length;
}

function standardError(values) {
  if (values.length < 2) return Number.NaN;
  let count = 0;
  let runningMean = 0;
  let centeredSquares = 0;
  for (const value of values) {
    count += 1;
    const distance = value - runningMean;
    runningMean += distance / count;
    centeredSquares += distance * (value - runningMean);
  }
  return Math.sqrt(Math.max(0, centeredSquares) / (count - 1)) / Math.sqrt(count);
}

function independentlyEvaluateMetricExpression(events, expression) {
  const [left, right] = expression.operands;
  if (expression.operator === 'arithmetic_mean') return mean(events.map((event) => event[left]));
  if (expression.operator === 'sample_standard_error') {
    return standardError(events.map((event) => event[left]));
  }
  if (expression.operator === 'arithmetic_mean_difference') {
    return mean(events.map((event) => event[left] - event[right]));
  }
  return Number.NaN;
}

function deterministicUnit(parts) {
  const hexadecimal = hashRecord('SystemBenchmarkDeterministicFixtureScalar', parts)
    .slice('sha256:'.length, 'sha256:'.length + 13);
  return Number.parseInt(hexadecimal, 16) / 0xfffffffffffff;
}

function rounded(value) {
  return Number(value.toFixed(12));
}

function independentlyEquivalentJsonNumber(left, right) {
  if (left === right) return true;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const magnitude = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= (Number.EPSILON * magnitude * 4);
}

function deterministicScalar(parts, minimum, maximum) {
  return rounded(minimum + ((maximum - minimum) * deterministicUnit(parts)));
}

function independentlyBuiltInCase({ family, arm, seed, repetition, index }) {
  const key = { benchmarkId: family, seed, repetition, index };
  const caseId = hashRecord('SystemBenchmarkFixtureCase', key);
  if (family === 'ml_algorithm_benchmark') {
    const primary = deterministicScalar({ ...key, field: 'primary' }, -1, 1);
    const secondary = deterministicScalar({ ...key, field: 'secondary' }, -1, 1);
    const label = primary + (0.35 * secondary) >= 0 ? 1 : 0;
    const robustLabel = primary + (0.2 * secondary) >= 0 ? 1 : 0;
    return {
      caseId,
      input: arm === 'ablation' ? { secondary } : { primary, secondary },
      referenceResponse: 0,
      oracle: { label, robustLabel },
    };
  }
  if (family === 'rl_stochastic_control_benchmark') {
    const state = deterministicScalar({ ...key, field: 'state' }, -2, 2);
    const disturbance = deterministicScalar({ ...key, field: 'disturbance' }, -0.2, 0.2);
    const constraintLimit = deterministicScalar({ ...key, field: 'limit' }, 0.8, 1.2);
    return {
      caseId,
      input: arm === 'ablation' ? { state } : { constraintLimit, state },
      referenceResponse: 0,
      oracle: { constraintLimit, disturbance, target: rounded((0.65 * state) + disturbance) },
    };
  }
  if (family === 'econometrics_panel_benchmark') {
    const trueEffect = deterministicScalar({ ...key, field: 'effect' }, -0.75, 0.75);
    const confounder = deterministicScalar({ ...key, field: 'confounder' }, -1, 1);
    const observations = Array.from({ length: 6 }, (_, row) => {
      const treatment = (row + index) % 2;
      const covariate = deterministicScalar({ ...key, field: `x:${row}` }, -1, 1);
      const noise = deterministicScalar({ ...key, field: `noise:${row}` }, -0.05, 0.05);
      const outcome = rounded((trueEffect * treatment) + (0.4 * covariate) + (0.25 * confounder) + noise);
      return arm === 'ablation' ? { outcome, treatment } : { covariate, outcome, treatment };
    });
    return {
      caseId,
      input: { observations },
      referenceResponse: 0,
      oracle: { robustEffect: rounded(trueEffect * 0.95), trueEffect },
    };
  }
  if (family === 'finance_asset_pricing_benchmark') {
    const signal = deterministicScalar({ ...key, field: 'signal' }, -1, 1);
    const factor = deterministicScalar({ ...key, field: 'factor' }, -0.1, 0.1);
    const futureReturn = rounded((0.08 * signal) + factor);
    return {
      caseId,
      input: arm === 'ablation' ? { volatility: Math.abs(factor) } : { signal, volatility: Math.abs(factor) },
      referenceResponse: 0.5,
      oracle: { futureReturn, robustReturn: rounded(futureReturn - (0.02 * Math.sign(futureReturn || 1))) },
    };
  }
  if (family === 'operations_optimization_benchmark') {
    const demandSignal = deterministicScalar({ ...key, field: 'demand' }, 0, 10);
    const capacity = deterministicScalar({ ...key, field: 'capacity' }, 4, 12);
    const unitCost = deterministicScalar({ ...key, field: 'cost' }, 0.5, 2);
    return {
      caseId,
      input: arm === 'ablation' ? { demandSignal, unitCost } : { capacity, demandSignal, unitCost },
      referenceResponse: rounded(Math.min(capacity, demandSignal) / 2),
      oracle: { capacity, demand: rounded(demandSignal * 1.05), unitCost },
    };
  }
  return null;
}

function authorizedCell(definition, seed, repetition) {
  if (!definition || definition.version !== 1
    || definition.kind !== 'OperatorAuthorizedDatasetBenchmarkHarness'
    || !Array.isArray(definition.cells)) return null;
  const matches = definition.cells.filter((cell) => (
    Number(cell?.seed) === seed && Number(cell?.repetition) === repetition
  ));
  if (matches.length !== 1 || !Array.isArray(matches[0].cases)
    || matches[0].cases.length !== SYSTEM_BENCHMARK_CASE_COUNT) return null;
  const cases = matches[0].cases;
  if (new Set(cases.map((item) => item?.caseId)).size !== SYSTEM_BENCHMARK_CASE_COUNT) {
    return null;
  }
  return matches[0];
}

export function buildIndependentSystemBenchmarkCellFixture({
  protocol,
  seed,
  repetition,
  operatorDatasetHarnessDefinition = null,
} = {}) {
  const blockers = [];
  const benchmarkId = String(protocol?.benchmarkId || '');
  const family = String(protocol?.benchmarkFamily || benchmarkId);
  const arm = String(protocol?.arm || '');
  const numericSeed = Number(seed);
  const numericRepetition = Number(repetition);
  const responseField = responseFieldFor(family);
  if (!responseField || !ARMS.has(arm) || !Number.isSafeInteger(numericSeed)
    || !Number.isSafeInteger(numericRepetition) || numericRepetition < 1) {
    blockers.push('independent_fixture_request_invalid');
  }
  const privateCell = operatorDatasetHarnessDefinition
    ? authorizedCell(operatorDatasetHarnessDefinition, numericSeed, numericRepetition)
    : null;
  if (operatorDatasetHarnessDefinition && (!privateCell
    || operatorDatasetHarnessDefinition.benchmarkId !== benchmarkId
    || operatorDatasetHarnessDefinition.benchmarkFamily !== family)) {
    blockers.push('independent_private_fixture_source_invalid');
  }
  const cases = blockers.length ? [] : (privateCell
    ? privateCell.cases.map((item) => ({
      caseId: item.caseId,
      input: arm === 'ablation' ? item.ablationInput : item.input,
      referenceResponse: item.referenceResponse,
      oracle: item.oracle,
    }))
    : Array.from({ length: SYSTEM_BENCHMARK_CASE_COUNT }, (_, index) => independentlyBuiltInCase({
      family,
      arm,
      seed: numericSeed,
      repetition: numericRepetition,
      index,
    })));
  if (cases.length !== SYSTEM_BENCHMARK_CASE_COUNT || cases.some((item) => !item)) {
    blockers.push('independent_fixture_unavailable');
  }
  const publicCases = cases.map(({ caseId, input, referenceResponse }) => ({
    caseId,
    input,
    ...(arm === 'baseline' ? { referenceResponse } : {}),
  }));
  const challengePayload = {
    version: 1,
    kind: 'SystemBenchmarkCellChallenge',
    benchmarkId,
    benchmarkFamily: family,
    arm,
    seed: numericSeed,
    repetition: numericRepetition,
    responseField,
    inputPolicy: arm === 'ablation'
      ? `${operatorDatasetHarnessDefinition ? 'operator-authorized' : 'repository-owned'}-primary-feature-removed-v1`
      : `${operatorDatasetHarnessDefinition ? 'operator-authorized' : 'repository-owned'}-fixed-input-v1`,
    cases: publicCases,
  };
  const challenge = blockers.length ? null : Object.freeze({
    ...challengePayload,
    systemBenchmarkCellChallengeHash: hashRecord('SystemBenchmarkCellChallenge', challengePayload),
  });
  const oraclePayload = challenge ? {
    version: 1,
    kind: 'SystemBenchmarkCellOracle',
    systemBenchmarkCellChallengeHash: challenge.systemBenchmarkCellChallengeHash,
    cases: cases.map(({ caseId, oracle }) => ({ caseId, oracle })),
  } : null;
  const oracle = oraclePayload ? Object.freeze({
    ...oraclePayload,
    systemBenchmarkCellOracleHash: hashRecord('SystemBenchmarkCellOracle', oraclePayload),
  }) : null;
  return Object.freeze({
    status: blockers.length ? 'independent_fixture_blocked' : 'independent_fixture_built',
    blockers: Object.freeze([...new Set(blockers)]),
    challenge,
    oracle,
  });
}

export function decodeIndependentSystemBenchmarkArmBatchChallenge(environment = {}) {
  const count = Number(environment.HEPTA_BENCHMARK_CHALLENGE_PART_COUNT);
  if (!Number.isSafeInteger(count) || count < 1
    || count > SYSTEM_BENCHMARK_CHALLENGE_MAXIMUM_PARTS) return null;
  const parts = Array.from({ length: count }, (_, index) => (
    environment[`HEPTA_BENCHMARK_CHALLENGE_JSON_PART_${index + 1}`]
  ));
  if (parts.some((part) => typeof part !== 'string'
    || Buffer.byteLength(part, 'utf8') > SYSTEM_BENCHMARK_CHALLENGE_PART_BYTES)) return null;
  for (let index = count + 1; index <= SYSTEM_BENCHMARK_CHALLENGE_MAXIMUM_PARTS; index += 1) {
    if (environment[`HEPTA_BENCHMARK_CHALLENGE_JSON_PART_${index}`] !== undefined) return null;
  }
  let challenge = null;
  try { challenge = JSON.parse(parts.join('')); } catch { return null; }
  if (!challenge || ![1, 2].includes(challenge.version)
    || challenge.kind !== 'SystemBenchmarkArmBatchChallenge'
    || (challenge.version === 2
      && !SHA256.test(String(challenge.versionedExperimentIrHash || '')))) return null;
  const { systemBenchmarkArmBatchChallengeHash, ...payload } = challenge;
  if (!SHA256.test(String(systemBenchmarkArmBatchChallengeHash || ''))
    || systemBenchmarkArmBatchChallengeHash !== environment.HEPTA_BENCHMARK_CHALLENGE_HASH
    || hashRecord('SystemBenchmarkArmBatchChallenge', payload) !== systemBenchmarkArmBatchChallengeHash) return null;
  return challenge;
}

function eventFromResponse(family, response, oracle) {
  if (family === 'ml_algorithm_benchmark') {
    const prediction = response >= 0.5 ? 1 : 0;
    return {
      referenceScore: oracle.label === 0 ? 1 : 0,
      robustnessScore: prediction === oracle.robustLabel ? 1 : 0,
      score: prediction === oracle.label ? 1 : 0,
    };
  }
  if (family === 'rl_stochastic_control_benchmark') {
    const reward = -((response - oracle.target) ** 2);
    const robustReward = -((response - (oracle.target + 0.1)) ** 2);
    return {
      constraintViolation: Math.abs(response) > oracle.constraintLimit ? 1 : 0,
      return: reward,
      robustnessReturn: robustReward,
      tailReturn: Math.min(reward, robustReward),
    };
  }
  if (family === 'econometrics_panel_benchmark') {
    return {
      effect: -Math.abs(response - oracle.trueEffect),
      placeboEffect: -Math.abs(response),
      robustnessEffect: -Math.abs(response - oracle.robustEffect),
    };
  }
  if (family === 'finance_asset_pricing_benchmark') {
    const realized = response * oracle.futureReturn;
    const robust = response * oracle.robustReturn;
    return { return: realized, robustnessReturn: robust, tailReturn: Math.min(realized, robust) };
  }
  if (family === 'operations_optimization_benchmark') {
    const score = -((response - oracle.demand) ** 2) - (oracle.unitCost * Math.max(0, response));
    const robustnessScore = -((response - (oracle.demand * 1.1)) ** 2)
      - (oracle.unitCost * Math.max(0, response));
    return {
      constraintViolation: response < 0 || response > oracle.capacity ? 1 : 0,
      robustnessScore,
      score,
    };
  }
  if (family === REGISTERED_SCALAR_RESPONSE_BENCHMARK_FAMILY) {
    return {
      constraintViolation: response < oracle.lowerBound || response > oracle.upperBound ? 1 : 0,
      robustnessScore: -((response - oracle.robustTarget) ** 2),
      score: -((response - oracle.target) ** 2),
    };
  }
  return null;
}

export function independentlyEvaluateSystemBenchmarkCellResponses({
  protocol,
  challenge,
  oracle,
  responses,
} = {}) {
  const blockers = [];
  const family = String(protocol?.benchmarkFamily || protocol?.benchmarkId || '');
  const responseField = responseFieldFor(family);
  if (!responseField || challenge?.responseField !== responseField
    || challenge?.arm !== protocol?.arm
    || oracle?.systemBenchmarkCellChallengeHash !== challenge?.systemBenchmarkCellChallengeHash
    || !Array.isArray(challenge?.cases)
    || challenge.cases.length !== SYSTEM_BENCHMARK_CASE_COUNT
    || !Array.isArray(oracle?.cases) || oracle.cases.length !== SYSTEM_BENCHMARK_CASE_COUNT
    || !Array.isArray(responses) || responses.length !== SYSTEM_BENCHMARK_CASE_COUNT) {
    blockers.push('independent_response_document_shape_invalid');
  }
  const oracleById = new Map((oracle?.cases || []).map((item) => [item?.caseId, item?.oracle]));
  const seen = new Set();
  const events = [];
  for (const [index, response] of (responses || []).entries()) {
    const caseId = String(response?.caseId || '');
    const value = response?.[responseField];
    const publicCase = challenge?.cases?.[index];
    if (!exactKeys(response, ['caseId', responseField]) || seen.has(caseId)
      || publicCase?.caseId !== caseId || !oracleById.has(caseId)
      || typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e6
      || (protocol?.arm === 'baseline'
        && !independentlyEquivalentJsonNumber(value, Number(publicCase?.referenceResponse)))) {
      blockers.push('independent_response_schema_invalid');
      continue;
    }
    seen.add(caseId);
    const event = eventFromResponse(family, value, oracleById.get(caseId));
    if (!event) blockers.push('independent_response_evaluator_unavailable');
    else events.push(Object.freeze(event));
  }
  if (seen.size !== SYSTEM_BENCHMARK_CASE_COUNT
    || events.length !== SYSTEM_BENCHMARK_CASE_COUNT) {
    blockers.push('independent_response_case_set_incomplete');
  }
  return Object.freeze({
    status: blockers.length
      ? 'independent_response_evaluation_blocked'
      : 'independent_response_evaluation_verified',
    blockers: Object.freeze([...new Set(blockers)]),
    events: blockers.length ? null : Object.freeze(events),
  });
}

export function independentlyAggregateSystemBenchmarkEvents({
  protocol,
  events,
  requiredMetrics = [],
  metricSpecs = {},
} = {}) {
  const blockers = [];
  const family = String(protocol?.benchmarkFamily || protocol?.benchmarkId || '');
  const evaluator = systemBenchmarkEvaluatorDescriptorFor(family);
  const eventFields = evaluator?.rawEventFields || null;
  const metricFields = evaluator?.metrics.map((metric) => metric.metric) || null;
  const required = [...requiredMetrics].map(String).sort();
  if (!evaluator || !eventFields || !metricFields
    || protocol?.evaluatorId !== `repository-owned-${protocol?.benchmarkId}-event-evaluator-v1`) {
    blockers.push('independent_metric_evaluator_unavailable');
  }
  if (evaluator && (!Array.isArray(protocol?.rawEventFields)
    || protocol.rawEventFields.join('\0') !== evaluator.rawEventFields.join('\0'))) {
    blockers.push('independent_evaluator_event_field_set_drift');
  }
  if (!eventFields || !Array.isArray(events) || events.length < 2 || events.length > MAXIMUM_RAW_EVENTS_PER_CELL
    || events.some((event) => !exactKeys(event, eventFields)
      || eventFields.some((field) => typeof event[field] !== 'number' || !Number.isFinite(event[field])))) {
    blockers.push('independent_raw_event_schema_invalid');
  }
  if (Object.keys(metricSpecs || {}).sort().join('\0') !== required.join('\0')
    || !metricFields || [...metricFields].sort().join('\0') !== required.join('\0')) {
    blockers.push('independent_metric_spec_set_invalid');
  }
  let metrics = null;
  if (!blockers.length) {
    metrics = Object.fromEntries(evaluator.metrics.map((metric) => [
      metric.metric,
      independentlyEvaluateMetricExpression(events, metric.expression),
    ]));
    for (const metric of required) {
      const spec = metricSpecs[metric];
      if (!spec || !['maximize', 'minimize'].includes(spec.direction) || !String(spec.unit || '')
        || !Number.isFinite(Number(spec.minimum)) || !Number.isFinite(Number(spec.maximum))
        || Number(spec.minimum) > Number(spec.maximum) || !Number.isFinite(Number(metrics?.[metric]))
        || Number(metrics[metric]) < Number(spec.minimum) || Number(metrics[metric]) > Number(spec.maximum)) {
        blockers.push(`independent_metric_out_of_declared_range:${metric}`);
      }
    }
  }
  return Object.freeze({
    status: blockers.length
      ? 'independent_event_aggregation_blocked'
      : 'independent_event_aggregation_verified',
    blockers: Object.freeze([...new Set(blockers)]),
    metrics: blockers.length ? null : Object.freeze(metrics),
    eventCount: blockers.length ? null : events.length,
  });
}

export function buildIndependentRawEventRecomputationManifest({
  cells = [],
  rawEventRows = [],
  requiredMetrics = [],
  metricSpecs = {},
  versionedExperimentIrHash = null,
} = {}) {
  const rows = new Map(rawEventRows.map((row) => [row?.cellId, row]));
  const blockers = [];
  let maximumAbsoluteResidual = 0;
  const recomputedCells = cells.map((cell) => {
    const row = rows.get(cell.cellId);
    const line = String(row?.line || '');
    const evaluated = independentlyAggregateSystemBenchmarkEvents({
      protocol: cell.armProtocol,
      events: row?.document?.events,
      requiredMetrics,
      metricSpecs,
    });
    const rowHash = line ? hashBytes(line) : null;
    if (versionedExperimentIrHash
      && cell?.versionedExperimentIrHash !== versionedExperimentIrHash) {
      blockers.push(`independent_experiment_ir_mismatch:${cell.cellId}`);
    }
    if (rowHash !== cell.rawEventArtifactHash) {
      blockers.push(`independent_artifact_hash_mismatch:${cell.cellId}`);
    }
    blockers.push(...evaluated.blockers.map((item) => `${item}:${cell.cellId}`));
    for (const metric of requiredMetrics) {
      const residual = Math.abs(Number(evaluated.metrics?.[metric]) - Number(cell.metrics?.[metric]));
      if (Number.isFinite(residual)) maximumAbsoluteResidual = Math.max(maximumAbsoluteResidual, residual);
      else blockers.push(`independent_metric_residual_invalid:${cell.cellId}:${metric}`);
    }
    if (evaluated.eventCount !== cell.rawEventCount) {
      blockers.push(`independent_event_count_mismatch:${cell.cellId}`);
    }
    return Object.freeze({
      cellId: cell.cellId,
      rawEventArtifactHash: rowHash,
      rawEventCount: evaluated.eventCount,
      metrics: evaluated.metrics,
    });
  });
  if (rows.size !== cells.length) blockers.push('independent_raw_event_row_bijection_invalid');
  if (maximumAbsoluteResidual !== 0) blockers.push('independent_metric_residual_nonzero');
  const payload = {
    version: versionedExperimentIrHash ? 2 : 1,
    kind: 'RawEventRecomputationManifest',
    status: blockers.length ? 'raw_event_recomputation_blocked' : 'raw_event_recomputation_verified',
    cells: Object.freeze(recomputedCells),
    maximumAbsoluteResidual,
    blockers: Object.freeze([...new Set(blockers)]),
    ...(versionedExperimentIrHash ? { versionedExperimentIrHash } : {}),
  };
  return Object.freeze({
    ...payload,
    rawEventRecomputationManifestHash: hashRecord('RawEventRecomputationManifest', payload),
  });
}

export function verifyIndependentFixtureBinding({
  protocol,
  seed,
  repetition,
  executedChallenge,
  executedOracleHash,
  operatorDatasetHarnessDefinition = null,
} = {}) {
  const built = buildIndependentSystemBenchmarkCellFixture({
    protocol,
    seed,
    repetition,
    operatorDatasetHarnessDefinition,
  });
  const valid = built.status === 'independent_fixture_built'
    && same(built.challenge, executedChallenge, 'IndependentExecutedChallengeExpected')
    && built.challenge.systemBenchmarkCellChallengeHash === executedChallenge?.systemBenchmarkCellChallengeHash
    && built.oracle.systemBenchmarkCellOracleHash === executedOracleHash;
  return Object.freeze({ ...built, valid });
}
