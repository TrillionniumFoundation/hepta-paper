import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  evaluateSelectedPlan,
  optimizeBoundedPlan,
} from './bounded-global-optimizer.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,127})$/u;
const STATUSES = Object.freeze(['optimal', 'bounded_gap']);
const MAX_CAPTURE_DEPTH = 64;
const MAX_CAPTURE_NODES = 1_000_000;
const MAX_BYTES = 16 * 1024 * 1024;

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function plainRecord(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || (allowed && !allowed.includes(key)))) {
    throw failure(code);
  }
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw failure(code);
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output.push(descriptor.value);
  }
  return output;
}

function token(value, code) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw failure(code);
  return value;
}

function hash(value, code) {
  if (typeof value !== 'string' || !HASH.test(value)) throw failure(code);
  return value;
}

function decimal(value, code) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw failure(code);
  return value;
}

function captureJson(value) {
  const seen = new Set();
  let nodes = 0;
  function visit(current, depth) {
    if (++nodes > MAX_CAPTURE_NODES || depth > MAX_CAPTURE_DEPTH) {
      throw failure('bounded_plan_result_structure_limit');
    }
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Math.abs(current) > Number.MAX_SAFE_INTEGER) {
        throw failure('bounded_plan_result_number_invalid');
      }
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== 'object') throw failure('bounded_plan_result_value_invalid');
    if (seen.has(current)) throw failure('bounded_plan_result_cycle');
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        return Object.freeze(denseArray(current, 100_000,
          'bounded_plan_result_array_invalid').map((entry) => visit(entry, depth + 1)));
      }
      const row = plainRecord(current, null, 'bounded_plan_result_record_invalid');
      const output = Object.create(null);
      for (const key of Object.keys(row).sort(compareUtf8)) output[key] = visit(row[key], depth + 1);
      return Object.freeze(output);
    } finally {
      seen.delete(current);
    }
  }
  const captured = visit(value, 0);
  if (canonicalBytes(captured).length > MAX_BYTES) throw failure('bounded_plan_result_byte_limit');
  return captured;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort(compareUtf8)) output[key] = canonicalValue(value[key]);
    return output;
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8');
}

function canonicalHash(kind, value) {
  return `sha256:${createHash('sha256').update(canonicalBytes({ kind, value })).digest('hex')}`;
}

function sameValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function capturePolicy(value) {
  const raw = plainRecord(value, ['version', 'kind', 'policyId', 'allowedStatuses',
    'maximumAcceptedGapMicrounits', 'requireObjectiveOptimal', 'requireCompleteTieBreak',
    'policyHash'], 'bounded_plan_policy_invalid');
  if (Object.keys(raw).length !== 8 || raw.version !== 1
    || raw.kind !== 'BoundedPlanAcceptancePolicyV1'
    || typeof raw.requireObjectiveOptimal !== 'boolean'
    || typeof raw.requireCompleteTieBreak !== 'boolean') {
    throw failure('bounded_plan_policy_invalid');
  }
  const allowedStatuses = denseArray(raw.allowedStatuses, STATUSES.length,
    'bounded_plan_policy_statuses_invalid').map((status) => {
    if (!STATUSES.includes(status)) throw failure('bounded_plan_policy_statuses_invalid');
    return status;
  }).sort(compareUtf8);
  if (!allowedStatuses.length || new Set(allowedStatuses).size !== allowedStatuses.length) {
    throw failure('bounded_plan_policy_statuses_invalid');
  }
  const body = Object.freeze({ version: 1, kind: raw.kind,
    policyId: token(raw.policyId, 'bounded_plan_policy_invalid'),
    allowedStatuses: Object.freeze(allowedStatuses),
    maximumAcceptedGapMicrounits: decimal(raw.maximumAcceptedGapMicrounits,
      'bounded_plan_policy_gap_invalid'),
    requireObjectiveOptimal: raw.requireObjectiveOptimal,
    requireCompleteTieBreak: raw.requireCompleteTieBreak });
  const expected = canonicalHash('BoundedPlanAcceptancePolicyV1', body);
  if (raw.policyHash !== expected) throw failure('bounded_plan_policy_hash_mismatch');
  return Object.freeze({ body, policyHash: expected });
}

export function boundedPlanAcceptancePolicyHash(value) {
  const raw = plainRecord(value, ['version', 'kind', 'policyId', 'allowedStatuses',
    'maximumAcceptedGapMicrounits', 'requireObjectiveOptimal', 'requireCompleteTieBreak'],
  'bounded_plan_policy_invalid');
  if (Object.keys(raw).length !== 7 || raw.version !== 1
    || raw.kind !== 'BoundedPlanAcceptancePolicyV1'
    || typeof raw.requireObjectiveOptimal !== 'boolean'
    || typeof raw.requireCompleteTieBreak !== 'boolean') {
    throw failure('bounded_plan_policy_invalid');
  }
  const allowedStatuses = denseArray(raw.allowedStatuses, STATUSES.length,
    'bounded_plan_policy_statuses_invalid').map((status) => {
    if (!STATUSES.includes(status)) throw failure('bounded_plan_policy_statuses_invalid');
    return status;
  }).sort(compareUtf8);
  if (!allowedStatuses.length || new Set(allowedStatuses).size !== allowedStatuses.length) {
    throw failure('bounded_plan_policy_statuses_invalid');
  }
  const body = Object.freeze({ version: 1, kind: raw.kind,
    policyId: token(raw.policyId, 'bounded_plan_policy_invalid'),
    allowedStatuses: Object.freeze(allowedStatuses),
    maximumAcceptedGapMicrounits: decimal(raw.maximumAcceptedGapMicrounits,
      'bounded_plan_policy_gap_invalid'),
    requireObjectiveOptimal: raw.requireObjectiveOptimal,
    requireCompleteTieBreak: raw.requireCompleteTieBreak });
  return canonicalHash('BoundedPlanAcceptancePolicyV1', body);
}

export function verifyBoundedPlan({ request, result, policy }) {
  const capturedResult = captureJson(result);
  const expected = optimizeBoundedPlan(request);
  if (!sameValue(capturedResult, expected)) throw failure('bounded_plan_result_mismatch');
  const accepted = capturePolicy(policy);
  if (!accepted.body.allowedStatuses.includes(expected.status)) {
    throw failure('bounded_plan_status_not_accepted');
  }
  if (expected.selectedPlan === null) throw failure('bounded_plan_no_selectable_incumbent');
  const gap = decimal(expected.proof.absoluteGapMicrounits, 'bounded_plan_result_gap_invalid');
  if (BigInt(gap) > BigInt(accepted.body.maximumAcceptedGapMicrounits)) {
    throw failure('bounded_plan_gap_exceeds_policy');
  }
  if (accepted.body.requireObjectiveOptimal && expected.proof.objectiveOptimal !== true) {
    throw failure('bounded_plan_objective_not_proved_optimal');
  }
  if (accepted.body.requireCompleteTieBreak && expected.proof.tieBreakComplete !== true) {
    throw failure('bounded_plan_tiebreak_incomplete');
  }
  const evaluated = evaluateSelectedPlan(request, expected.selectedPlan.selectedCandidateIds);
  if (evaluated.objectiveMicrounits !== expected.selectedPlan.objectiveMicrounits
    || !sameValue(evaluated.usedResources, expected.selectedPlan.usedResources)) {
    throw failure('bounded_plan_selected_plan_invalid');
  }
  const body = Object.freeze({ version: 1, kind: 'VerifiedBoundedPlanV1',
    status: 'verified_nonactivating', optimizationRequestHash: expected.optimizationRequestHash,
    optimizationResultHash: hash(expected.optimizationResultHash, 'bounded_plan_result_hash_invalid'),
    policyHash: accepted.policyHash, planningRequestHash: expected.planningRequestHash,
    stateSnapshotHash: expected.stateSnapshotHash, candidateSetHash: expected.candidateSetHash,
    objectiveVersion: expected.objectiveVersion, selectedPlan: expected.selectedPlan,
    proof: expected.proof,
    authority: Object.freeze({ productionAuthorized: false, executionAuthorized: false,
      writerAuthorized: false, providerAuthorized: false, externalAuthorityClaimed: false }),
    externalActionPerformed: false });
  return Object.freeze({ ...body,
    verifiedBoundedPlanHash: canonicalHash('VerifiedBoundedPlanV1', body) });
}
