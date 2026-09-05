import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { buildBoundedOptimizationRequest } from './candidate-optimization-model.mjs';
import { verifyPlanningCycle } from './verified-planning-cycle.mjs';

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function plainRecord(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== allowed.length || keys.some((key) => typeof key !== 'string'
    || !allowed.includes(key))) throw failure(code);
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure(code);
    output[key] = descriptor.value;
  }
  return output;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))) {
      output[key] = canonicalValue(value[key]);
    }
    return output;
  }
  return value;
}

function canonicalHash(kind, value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalValue({ kind, value }))).digest('hex')}`;
}

export function verifyPlanningCycleV2(input) {
  const row = plainRecord(input, ['controlSnapshot', 'candidateFrontier', 'modelSet',
    'optimizationResult', 'acceptancePolicy'], 'planning_cycle_v2_input_invalid');
  const projection = buildBoundedOptimizationRequest({ candidateFrontier: row.candidateFrontier,
    modelSet: row.modelSet });
  const verified = verifyPlanningCycle({ controlSnapshot: row.controlSnapshot,
    candidateFrontier: row.candidateFrontier,
    optimizationRequest: projection.optimizationRequest,
    optimizationResult: row.optimizationResult,
    acceptancePolicy: row.acceptancePolicy });
  const body = Object.freeze({ version: 2, kind: 'VerifiedPlanningDecisionV2',
    status: 'verified_nonactivating', controlSnapshotHash: verified.controlSnapshotHash,
    controlSubjectHash: verified.controlSubjectHash,
    candidateFrontierHash: projection.candidateFrontierHash,
    candidateOptimizationModelSetHash: projection.candidateOptimizationModelSetHash,
    optimizationRequestProjectionHash: projection.optimizationRequestProjectionHash,
    planningRequestHash: verified.planningRequestHash,
    candidateSetHash: verified.candidateSetHash,
    optimizationRequestHash: verified.optimizationRequestHash,
    optimizationResultHash: verified.optimizationResultHash,
    verifiedBoundedPlanHash: verified.verifiedBoundedPlanHash,
    verifiedPlanningDecisionV1Hash: verified.verifiedPlanningDecisionHash,
    policyHash: verified.policyHash, objectiveVersion: verified.objectiveVersion,
    selectedPlan: verified.selectedPlan, proof: verified.proof,
    authority: Object.freeze({ productionAuthorized: false, executionAuthorized: false,
      writerAuthorized: false, providerAuthorized: false, releaseAuthorized: false,
      submissionAuthorized: false, externalAuthorityClaimed: false }),
    externalActionPerformed: false });
  return Object.freeze({ ...body,
    verifiedPlanningDecisionHash: canonicalHash('VerifiedPlanningDecisionV2', body) });
}
