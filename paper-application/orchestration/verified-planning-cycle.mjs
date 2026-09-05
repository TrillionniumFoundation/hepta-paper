import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { verifyBoundedPlan } from './bounded-plan-verifier.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const MAX_CANDIDATES = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 1_000_000;

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

function requiredHash(value, code) {
  if (typeof value !== 'string' || !HASH.test(value)) throw failure(code);
  return value;
}

function captureJson(value) {
  const seen = new Set();
  let nodes = 0;
  function visit(current, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw failure('planning_cycle_structure_limit');
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Math.abs(current) > Number.MAX_SAFE_INTEGER) {
        throw failure('planning_cycle_number_invalid');
      }
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== 'object') throw failure('planning_cycle_value_invalid');
    if (seen.has(current)) throw failure('planning_cycle_cycle');
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        return Object.freeze(denseArray(current, 100_000,
          'planning_cycle_array_invalid').map((entry) => visit(entry, depth + 1)));
      }
      const row = plainRecord(current, null, 'planning_cycle_record_invalid');
      const output = Object.create(null);
      for (const key of Object.keys(row).sort(compareUtf8)) output[key] = visit(row[key], depth + 1);
      return Object.freeze(output);
    } finally {
      seen.delete(current);
    }
  }
  const captured = visit(value, 0);
  if (canonicalBytes(captured).length > MAX_BYTES) throw failure('planning_cycle_byte_limit');
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

function falseAuthority(value, code) {
  const row = plainRecord(value, null, code);
  if (!Object.keys(row).length || Object.values(row).some((flag) => flag !== false)) throw failure(code);
  return Object.freeze(Object.fromEntries(Object.keys(row).sort(compareUtf8).map((key) => [key, false])));
}

function captureSnapshot(value) {
  const row = plainRecord(captureJson(value), null, 'planning_cycle_snapshot_invalid');
  if (row.version !== 1 || row.kind !== 'ControlSnapshotV1'
    || row.externalActionPerformed !== false) throw failure('planning_cycle_snapshot_invalid');
  return Object.freeze({ value: row,
    controlSnapshotHash: requiredHash(row.controlSnapshotHash, 'planning_cycle_snapshot_hash_invalid'),
    subjectHash: requiredHash(row.subjectHash, 'planning_cycle_snapshot_subject_invalid'),
    authority: falseAuthority(row.authority, 'planning_cycle_snapshot_authority_invalid') });
}

function captureFrontier(value) {
  const row = plainRecord(captureJson(value), null, 'planning_cycle_frontier_invalid');
  if (row.version !== 1 || row.kind !== 'CandidateFrontierV1'
    || row.externalActionPerformed !== false || row.dominanceReductionApplied !== false) {
    throw failure('planning_cycle_frontier_invalid');
  }
  const rawCandidates = denseArray(row.candidates, MAX_CANDIDATES,
    'planning_cycle_frontier_candidates_invalid');
  if (!rawCandidates.length) throw failure('planning_cycle_frontier_candidates_invalid');
  const candidates = rawCandidates.map((value) => {
    const candidate = plainRecord(value, null, 'planning_cycle_frontier_candidate_invalid');
    if (typeof candidate.candidateId !== 'string' || !candidate.candidateId.length) {
      throw failure('planning_cycle_frontier_candidate_invalid');
    }
    return Object.freeze({ candidateId: candidate.candidateId,
      candidatePayloadHash: requiredHash(candidate.candidatePayloadHash,
        'planning_cycle_frontier_candidate_hash_invalid') });
  }).sort((left, right) => compareUtf8(left.candidateId, right.candidateId));
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) {
    throw failure('planning_cycle_frontier_candidate_id_duplicate');
  }
  if (new Set(candidates.map((candidate) => candidate.candidatePayloadHash)).size !== candidates.length) {
    throw failure('planning_cycle_frontier_candidate_hash_duplicate');
  }
  return Object.freeze({ value: row, candidates: Object.freeze(candidates),
    planningRequestHash: requiredHash(row.planningRequestHash, 'planning_cycle_request_hash_invalid'),
    stateSnapshotHash: requiredHash(row.stateSnapshotHash, 'planning_cycle_frontier_snapshot_hash_invalid'),
    candidateSetHash: requiredHash(row.candidateSetHash, 'planning_cycle_candidate_set_hash_invalid'),
    candidateFrontierHash: requiredHash(row.candidateFrontierHash, 'planning_cycle_frontier_hash_invalid'),
    authority: falseAuthority(row.authority, 'planning_cycle_frontier_authority_invalid') });
}

function captureOptimizationRequest(value) {
  const row = plainRecord(captureJson(value), null, 'planning_cycle_optimization_request_invalid');
  const candidates = denseArray(row.candidates, MAX_CANDIDATES,
    'planning_cycle_optimization_candidates_invalid').map((value) => {
    const candidate = plainRecord(value, null, 'planning_cycle_optimization_candidate_invalid');
    if (typeof candidate.candidateId !== 'string' || !candidate.candidateId.length) {
      throw failure('planning_cycle_optimization_candidate_invalid');
    }
    return Object.freeze({ candidateId: candidate.candidateId,
      candidatePayloadHash: requiredHash(candidate.candidatePayloadHash,
        'planning_cycle_optimization_candidate_hash_invalid') });
  }).sort((left, right) => compareUtf8(left.candidateId, right.candidateId));
  return Object.freeze({ value: row, candidates: Object.freeze(candidates),
    planningRequestHash: requiredHash(row.planningRequestHash, 'planning_cycle_request_hash_invalid'),
    stateSnapshotHash: requiredHash(row.stateSnapshotHash, 'planning_cycle_optimization_snapshot_hash_invalid'),
    candidateSetHash: requiredHash(row.candidateSetHash, 'planning_cycle_candidate_set_hash_invalid') });
}

function assertCandidateIdentity(frontier, optimization) {
  if (frontier.candidates.length !== optimization.candidates.length) {
    throw failure('planning_cycle_candidate_model_coverage_invalid');
  }
  for (let index = 0; index < frontier.candidates.length; index += 1) {
    const expected = frontier.candidates[index];
    const observed = optimization.candidates[index];
    if (expected.candidateId !== observed.candidateId
      || expected.candidatePayloadHash !== observed.candidatePayloadHash) {
      throw failure('planning_cycle_candidate_model_binding_invalid');
    }
  }
}

export function verifyPlanningCycle(input) {
  const raw = plainRecord(input, ['controlSnapshot', 'candidateFrontier',
    'optimizationRequest', 'optimizationResult', 'acceptancePolicy'],
  'planning_cycle_input_invalid');
  if (Object.keys(raw).length !== 5) throw failure('planning_cycle_input_invalid');
  const snapshot = captureSnapshot(raw.controlSnapshot);
  const frontier = captureFrontier(raw.candidateFrontier);
  const optimization = captureOptimizationRequest(raw.optimizationRequest);
  if (frontier.stateSnapshotHash !== snapshot.controlSnapshotHash
    || optimization.stateSnapshotHash !== snapshot.controlSnapshotHash) {
    throw failure('planning_cycle_snapshot_binding_mismatch');
  }
  if (optimization.planningRequestHash !== frontier.planningRequestHash) {
    throw failure('planning_cycle_request_binding_mismatch');
  }
  if (optimization.candidateSetHash !== frontier.candidateSetHash) {
    throw failure('planning_cycle_candidate_set_binding_mismatch');
  }
  assertCandidateIdentity(frontier, optimization);
  const verified = verifyBoundedPlan({ request: optimization.value,
    result: raw.optimizationResult, policy: raw.acceptancePolicy });
  if (verified.stateSnapshotHash !== snapshot.controlSnapshotHash
    || verified.planningRequestHash !== frontier.planningRequestHash
    || verified.candidateSetHash !== frontier.candidateSetHash) {
    throw failure('planning_cycle_verified_plan_binding_mismatch');
  }
  const body = Object.freeze({ version: 1, kind: 'VerifiedPlanningDecisionV1',
    status: 'verified_nonactivating', controlSnapshotHash: snapshot.controlSnapshotHash,
    controlSubjectHash: snapshot.subjectHash, candidateFrontierHash: frontier.candidateFrontierHash,
    planningRequestHash: frontier.planningRequestHash, candidateSetHash: frontier.candidateSetHash,
    optimizationRequestHash: verified.optimizationRequestHash,
    optimizationResultHash: verified.optimizationResultHash,
    verifiedBoundedPlanHash: verified.verifiedBoundedPlanHash,
    policyHash: verified.policyHash, objectiveVersion: verified.objectiveVersion,
    selectedPlan: verified.selectedPlan, proof: verified.proof,
    authority: Object.freeze({ productionAuthorized: false, executionAuthorized: false,
      writerAuthorized: false, providerAuthorized: false, releaseAuthorized: false,
      submissionAuthorized: false, externalAuthorityClaimed: false }),
    externalActionPerformed: false });
  return Object.freeze({ ...body,
    verifiedPlanningDecisionHash: canonicalHash('VerifiedPlanningDecisionV1', body) });
}
