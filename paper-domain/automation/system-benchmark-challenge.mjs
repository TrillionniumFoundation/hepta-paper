import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { operatorDatasetHarnessCell } from './operator-dataset-harness-contract.mjs';

const CASE_COUNT = 8;
const MAXIMUM_ARM_BATCH_CELLS = 128;
export const SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_PART_BYTES = 60 * 1024;
export const SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_MAXIMUM_PARTS = 16;
const RESPONSE_FIELDS = Object.freeze({
  rl_stochastic_control_benchmark: 'action',
  ml_algorithm_benchmark: 'prediction',
  econometrics_panel_benchmark: 'estimate',
  finance_asset_pricing_benchmark: 'position',
  operations_optimization_benchmark: 'decision',
});

function unit(parts) {
  const hexadecimal = hashRecord('SystemBenchmarkDeterministicFixtureScalar', parts).slice('sha256:'.length, 'sha256:'.length + 13);
  return Number.parseInt(hexadecimal, 16) / 0xfffffffffffff;
}

function rounded(value) {
  return Number(value.toFixed(12));
}

function scalar(parts, minimum, maximum) {
  return rounded(minimum + ((maximum - minimum) * unit(parts)));
}

function caseFixture({ benchmarkId, arm, seed, repetition, index }) {
  const key = { benchmarkId, seed, repetition, index };
  const caseId = hashRecord('SystemBenchmarkFixtureCase', key);
  if (benchmarkId === 'ml_algorithm_benchmark') {
    const primary = scalar({ ...key, field: 'primary' }, -1, 1);
    const secondary = scalar({ ...key, field: 'secondary' }, -1, 1);
    const label = primary + (0.35 * secondary) >= 0 ? 1 : 0;
    const robustLabel = primary + (0.2 * secondary) >= 0 ? 1 : 0;
    const input = arm === 'ablation' ? { secondary } : { primary, secondary };
    return { caseId, input, referenceResponse: 0, oracle: { label, robustLabel } };
  }
  if (benchmarkId === 'rl_stochastic_control_benchmark') {
    const state = scalar({ ...key, field: 'state' }, -2, 2);
    const disturbance = scalar({ ...key, field: 'disturbance' }, -0.2, 0.2);
    const constraintLimit = scalar({ ...key, field: 'limit' }, 0.8, 1.2);
    const input = arm === 'ablation' ? { state } : { constraintLimit, state };
    return { caseId, input, referenceResponse: 0, oracle: { constraintLimit, disturbance, target: rounded((0.65 * state) + disturbance) } };
  }
  if (benchmarkId === 'econometrics_panel_benchmark') {
    const trueEffect = scalar({ ...key, field: 'effect' }, -0.75, 0.75);
    const confounder = scalar({ ...key, field: 'confounder' }, -1, 1);
    const observations = Array.from({ length: 6 }, (_, row) => {
      const treatment = (row + index) % 2;
      const covariate = scalar({ ...key, field: `x:${row}` }, -1, 1);
      const noise = scalar({ ...key, field: `noise:${row}` }, -0.05, 0.05);
      const outcome = rounded((trueEffect * treatment) + (0.4 * covariate) + (0.25 * confounder) + noise);
      return arm === 'ablation' ? { outcome, treatment } : { covariate, outcome, treatment };
    });
    return { caseId, input: { observations }, referenceResponse: 0, oracle: { robustEffect: rounded(trueEffect * 0.95), trueEffect } };
  }
  if (benchmarkId === 'finance_asset_pricing_benchmark') {
    const signal = scalar({ ...key, field: 'signal' }, -1, 1);
    const factor = scalar({ ...key, field: 'factor' }, -0.1, 0.1);
    const futureReturn = rounded((0.08 * signal) + factor);
    const input = arm === 'ablation' ? { volatility: Math.abs(factor) } : { signal, volatility: Math.abs(factor) };
    return { caseId, input, referenceResponse: 0.5, oracle: { futureReturn, robustReturn: rounded(futureReturn - (0.02 * Math.sign(futureReturn || 1))) } };
  }
  if (benchmarkId === 'operations_optimization_benchmark') {
    const demandSignal = scalar({ ...key, field: 'demand' }, 0, 10);
    const capacity = scalar({ ...key, field: 'capacity' }, 4, 12);
    const unitCost = scalar({ ...key, field: 'cost' }, 0.5, 2);
    const input = arm === 'ablation' ? { demandSignal, unitCost } : { capacity, demandSignal, unitCost };
    return { caseId, input, referenceResponse: rounded(Math.min(capacity, demandSignal) / 2), oracle: { capacity, demand: rounded(demandSignal * 1.05), unitCost } };
  }
  return null;
}

export function buildSystemBenchmarkCellChallenge({ protocol, seed, repetition, operatorDatasetHarnessDefinition = null } = {}) {
  const benchmarkId = String(protocol?.benchmarkId || '');
  const benchmarkFamily = String(protocol?.benchmarkFamily || benchmarkId);
  const arm = String(protocol?.arm || '');
  const responseField = RESPONSE_FIELDS[benchmarkFamily] || null;
  if (!responseField || !['treatment', 'baseline', 'ablation'].includes(arm)
    || !Number.isSafeInteger(Number(seed)) || !Number.isSafeInteger(Number(repetition)) || Number(repetition) < 1) {
    throw new Error('system_benchmark_fixture_request_invalid');
  }
  const authorizedCell = operatorDatasetHarnessDefinition
    ? operatorDatasetHarnessCell(operatorDatasetHarnessDefinition, { seed, repetition })
    : null;
  const fixtures = authorizedCell
    ? authorizedCell.cases.map((item) => ({
      caseId: item.caseId,
      input: arm === 'ablation' ? item.ablationInput : item.input,
      referenceResponse: item.referenceResponse,
      oracle: item.oracle,
    }))
    : Array.from({ length: CASE_COUNT }, (_, index) => caseFixture({
      benchmarkId: benchmarkFamily, arm, seed: Number(seed), repetition: Number(repetition), index,
    }));
  if (fixtures.some((fixture) => !fixture)) throw new Error(`system_benchmark_fixture_unavailable:${benchmarkId}`);
  const publicCases = fixtures.map(({ caseId, input, referenceResponse }) => Object.freeze({
    caseId,
    input,
    ...(arm === 'baseline' ? { referenceResponse } : {}),
  }));
  const payload = {
    version: 1,
    kind: 'SystemBenchmarkCellChallenge',
    benchmarkId,
    benchmarkFamily,
    arm,
    seed: Number(seed),
    repetition: Number(repetition),
    responseField,
    inputPolicy: arm === 'ablation' ? 'repository-owned-primary-feature-removed-v1' : 'repository-owned-fixed-input-v1',
    cases: publicCases,
  };
  const challenge = Object.freeze({ ...payload, systemBenchmarkCellChallengeHash: hashRecord('SystemBenchmarkCellChallenge', payload) });
  const oraclePayload = {
    version: 1,
    kind: 'SystemBenchmarkCellOracle',
    systemBenchmarkCellChallengeHash: challenge.systemBenchmarkCellChallengeHash,
    cases: fixtures.map(({ caseId, oracle }) => ({ caseId, oracle })),
  };
  const oracle = Object.freeze({ ...oraclePayload, systemBenchmarkCellOracleHash: hashRecord('SystemBenchmarkCellOracle', oraclePayload) });
  return Object.freeze({ challenge, oracle });
}

export function buildSystemBenchmarkArmBatchChallenge({ protocol, cells = [], operatorDatasetHarnessDefinition = null } = {}) {
  const benchmarkId = String(protocol?.benchmarkId || '');
  const benchmarkFamily = String(protocol?.benchmarkFamily || benchmarkId);
  const arm = String(protocol?.arm || '');
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > MAXIMUM_ARM_BATCH_CELLS
    || !RESPONSE_FIELDS[benchmarkFamily] || !['treatment', 'baseline', 'ablation'].includes(arm)) {
    throw new Error('system_benchmark_arm_batch_request_invalid');
  }
  const seen = new Set();
  const fixtures = cells.map((cell) => {
    const cellId = String(cell?.cellId || '');
    if (!/^sha256:[0-9a-f]{64}$/i.test(cellId) || seen.has(cellId)) {
      throw new Error('system_benchmark_arm_batch_cell_invalid');
    }
    seen.add(cellId);
    const fixture = buildSystemBenchmarkCellChallenge({
      protocol,
      seed: cell.seed,
      repetition: cell.repetition,
      operatorDatasetHarnessDefinition,
    });
    return Object.freeze({ cellId, ...fixture });
  });
  const payload = {
    version: 1,
    kind: 'SystemBenchmarkArmBatchChallenge',
    benchmarkId,
    benchmarkFamily,
    arm,
    responseField: RESPONSE_FIELDS[benchmarkFamily],
    scheduleCellCount: fixtures.length,
    cells: fixtures.map(({ cellId, challenge }) => Object.freeze({ cellId, challenge })),
  };
  const challenge = Object.freeze({
    ...payload,
    systemBenchmarkArmBatchChallengeHash: hashRecord('SystemBenchmarkArmBatchChallenge', payload),
  });
  return Object.freeze({ challenge, fixtures: Object.freeze(fixtures) });
}

export function systemBenchmarkArmBatchChallengeEnvironment(challenge) {
  const document = JSON.stringify(challenge);
  const parts = [];
  for (let offset = 0; offset < document.length; offset += SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_PART_BYTES) {
    parts.push(document.slice(offset, offset + SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_PART_BYTES));
  }
  if (!parts.length || parts.length > SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_MAXIMUM_PARTS
    || parts.some((part) => new TextEncoder().encode(part).byteLength > SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_PART_BYTES)) {
    throw new Error('system_benchmark_arm_batch_challenge_environment_limit_exceeded');
  }
  return Object.freeze({
    HEPTA_BENCHMARK_CHALLENGE_HASH: challenge.systemBenchmarkArmBatchChallengeHash,
    HEPTA_BENCHMARK_CHALLENGE_PART_COUNT: String(parts.length),
    ...Object.fromEntries(parts.map((part, index) => [`HEPTA_BENCHMARK_CHALLENGE_JSON_PART_${index + 1}`, part])),
  });
}

export function decodeSystemBenchmarkArmBatchChallengeEnvironment(environment = {}) {
  const count = Number(environment.HEPTA_BENCHMARK_CHALLENGE_PART_COUNT);
  if (!Number.isSafeInteger(count) || count < 1 || count > SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_MAXIMUM_PARTS) return null;
  const parts = Array.from({ length: count }, (_, index) => environment[`HEPTA_BENCHMARK_CHALLENGE_JSON_PART_${index + 1}`]);
  if (parts.some((part) => typeof part !== 'string'
    || new TextEncoder().encode(part).byteLength > SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_PART_BYTES)
    || Array.from({ length: SYSTEM_BENCHMARK_ARM_BATCH_CHALLENGE_MAXIMUM_PARTS - count }, (_, index) => (
      environment[`HEPTA_BENCHMARK_CHALLENGE_JSON_PART_${count + index + 1}`]
    )).some((part) => part !== undefined)) return null;
  let challenge = null;
  try { challenge = JSON.parse(parts.join('')); } catch { return null; }
  const { systemBenchmarkArmBatchChallengeHash = null, ...payload } = challenge || {};
  if (!challenge || challenge.version !== 1 || challenge.kind !== 'SystemBenchmarkArmBatchChallenge'
    || systemBenchmarkArmBatchChallengeHash !== environment.HEPTA_BENCHMARK_CHALLENGE_HASH
    || hashRecord('SystemBenchmarkArmBatchChallenge', payload) !== systemBenchmarkArmBatchChallengeHash) return null;
  return challenge;
}

function eventFromResponse({ benchmarkId, response, oracle }) {
  if (benchmarkId === 'ml_algorithm_benchmark') {
    const prediction = response >= 0.5 ? 1 : 0;
    return { referenceScore: oracle.label === 0 ? 1 : 0, robustnessScore: prediction === oracle.robustLabel ? 1 : 0, score: prediction === oracle.label ? 1 : 0 };
  }
  if (benchmarkId === 'rl_stochastic_control_benchmark') {
    const reward = -((response - oracle.target) ** 2);
    const robustReward = -((response - (oracle.target + 0.1)) ** 2);
    return { constraintViolation: Math.abs(response) > oracle.constraintLimit ? 1 : 0, return: reward, robustnessReturn: robustReward, tailReturn: Math.min(reward, robustReward) };
  }
  if (benchmarkId === 'econometrics_panel_benchmark') {
    return { effect: -Math.abs(response - oracle.trueEffect), placeboEffect: -Math.abs(response), robustnessEffect: -Math.abs(response - oracle.robustEffect) };
  }
  if (benchmarkId === 'finance_asset_pricing_benchmark') {
    const realized = response * oracle.futureReturn;
    const robust = response * oracle.robustReturn;
    return { return: realized, robustnessReturn: robust, tailReturn: Math.min(realized, robust) };
  }
  const score = -((response - oracle.demand) ** 2) - (oracle.unitCost * Math.max(0, response));
  const robustScore = -((response - (oracle.demand * 1.1)) ** 2) - (oracle.unitCost * Math.max(0, response));
  return { constraintViolation: response < 0 || response > oracle.capacity ? 1 : 0, robustnessScore: robustScore, score };
}

export function evaluateSystemBenchmarkCellResponses({ protocol, challenge, oracle, document, operatorDatasetHarnessDefinition = null } = {}) {
  const blockers = [];
  const benchmarkFamily = protocol?.benchmarkFamily || protocol?.benchmarkId;
  const responseField = RESPONSE_FIELDS[benchmarkFamily] || null;
  const expected = (() => {
    try { return buildSystemBenchmarkCellChallenge({ protocol, seed: challenge?.seed, repetition: challenge?.repetition, operatorDatasetHarnessDefinition }); } catch { return null; }
  })();
  if (!expected || hashRecord('SystemBenchmarkCellChallengeExpected', expected.challenge)
    !== hashRecord('SystemBenchmarkCellChallengeExpected', challenge)
    || hashRecord('SystemBenchmarkCellOracleExpected', expected.oracle)
      !== hashRecord('SystemBenchmarkCellOracleExpected', oracle)) blockers.push('benchmark_repository_owned_fixture_invalid');
  if (!document || document.version !== 1 || document.kind !== 'CampaignBenchmarkCellResponses'
    || document.systemBenchmarkCellChallengeHash !== challenge?.systemBenchmarkCellChallengeHash
    || Object.keys(document || {}).sort().join('\0') !== ['kind', 'responses', 'systemBenchmarkCellChallengeHash', 'version'].join('\0')
    || !Array.isArray(document.responses) || document.responses.length !== CASE_COUNT) {
    blockers.push('benchmark_cell_response_document_shape_invalid');
  }
  const oracleById = new Map((oracle?.cases || []).map((item) => [item.caseId, item.oracle]));
  const publicById = new Map((challenge?.cases || []).map((item) => [item.caseId, item]));
  const seen = new Set();
  const events = [];
  const canonicalResponses = [];
  for (const [index, response] of (document?.responses || []).entries()) {
    const keys = ['caseId', responseField].sort().join('\0');
    const caseId = String(response?.caseId || '');
    const candidate = response?.[responseField];
    const value = typeof candidate === 'number' ? candidate : Number.NaN;
    if (!responseField || Object.keys(response || {}).sort().join('\0') !== keys || seen.has(caseId)
      || challenge?.cases?.[index]?.caseId !== caseId
      || !oracleById.has(caseId) || !publicById.has(caseId) || !Number.isFinite(value) || Math.abs(value) > 1e6) {
      blockers.push('benchmark_cell_response_schema_invalid');
      continue;
    }
    seen.add(caseId);
    if (protocol.arm === 'baseline' && value !== Number(publicById.get(caseId).referenceResponse)) {
      blockers.push('benchmark_baseline_not_repository_reference');
      continue;
    }
    canonicalResponses.push(Object.freeze({ caseId, [responseField]: value }));
    events.push(eventFromResponse({ benchmarkId: benchmarkFamily, response: value, oracle: oracleById.get(caseId) }));
  }
  if (seen.size !== CASE_COUNT) blockers.push('benchmark_cell_response_case_set_incomplete');
  return Object.freeze({
    status: blockers.length ? 'system_benchmark_cell_response_blocked' : 'system_benchmark_cell_response_evaluated',
    blockers: [...new Set(blockers)],
    events: blockers.length ? null : Object.freeze(events.map((event) => Object.freeze(event))),
    responses: blockers.length ? null : Object.freeze(canonicalResponses),
    systemBenchmarkCellChallengeHash: challenge?.systemBenchmarkCellChallengeHash || null,
    systemBenchmarkCellOracleHash: oracle?.systemBenchmarkCellOracleHash || null,
    evaluatorId: protocol?.evaluatorId || null,
  });
}

export function evaluateSystemBenchmarkArmBatchResponses({ protocol, batchChallenge, fixtures = [], document, operatorDatasetHarnessDefinition = null } = {}) {
  const blockers = [];
  const exactDocumentKeys = ['cells', 'kind', 'systemBenchmarkArmBatchChallengeHash', 'version'].join('\0');
  if (!document || document.version !== 1 || document.kind !== 'CampaignBenchmarkArmBatchResponses'
    || document.systemBenchmarkArmBatchChallengeHash !== batchChallenge?.systemBenchmarkArmBatchChallengeHash
    || Object.keys(document || {}).sort().join('\0') !== exactDocumentKeys
    || !Array.isArray(document.cells) || document.cells.length !== fixtures.length) {
    blockers.push('benchmark_arm_batch_response_document_shape_invalid');
  }
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.cellId, fixture]));
  const seen = new Set();
  const evaluations = [];
  for (const [index, value] of (document?.cells || []).entries()) {
    const cellId = String(value?.cellId || '');
    const fixture = fixtureById.get(cellId);
    if (Object.keys(value || {}).sort().join('\0') !== ['cellId', 'responses', 'systemBenchmarkCellChallengeHash'].join('\0')
      || !fixture || seen.has(cellId) || fixtures[index]?.cellId !== cellId
      || value.systemBenchmarkCellChallengeHash !== fixture.challenge.systemBenchmarkCellChallengeHash) {
      blockers.push('benchmark_arm_batch_response_cell_invalid');
      continue;
    }
    seen.add(cellId);
    const evaluated = evaluateSystemBenchmarkCellResponses({
      protocol,
      challenge: fixture.challenge,
      oracle: fixture.oracle,
      operatorDatasetHarnessDefinition,
      document: {
        version: 1,
        kind: 'CampaignBenchmarkCellResponses',
        systemBenchmarkCellChallengeHash: value.systemBenchmarkCellChallengeHash,
        responses: value.responses,
      },
    });
    blockers.push(...evaluated.blockers.map((blocker) => `${blocker}:${cellId}`));
    evaluations.push(Object.freeze({ cellId, ...evaluated }));
  }
  if (seen.size !== fixtures.length) blockers.push('benchmark_arm_batch_response_cell_set_incomplete');
  return Object.freeze({
    status: blockers.length ? 'system_benchmark_arm_batch_response_blocked' : 'system_benchmark_arm_batch_response_evaluated',
    blockers: [...new Set(blockers)],
    evaluations: blockers.length ? null : Object.freeze(evaluations),
    systemBenchmarkArmBatchChallengeHash: batchChallenge?.systemBenchmarkArmBatchChallengeHash || null,
  });
}
