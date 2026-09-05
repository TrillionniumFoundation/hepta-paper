import { Buffer } from 'node:buffer';
import {
  canonicalHashRecord, canonicalStringify, compareUtf8,
} from './candidate-router-canonical.mjs';
import {
  denseArray, failure, plainRecord, timestamp,
} from './candidate-router-primitives.mjs';
import { normalizeBounds } from './candidate-router-structured.mjs';
import {
  normalizeModuleBindings, normalizePlanningRequest,
} from './candidate-router-request.mjs';
import {
  actionCandidatePayloadHash, normalizeCandidate,
} from './candidate-router-candidate.mjs';

export { actionCandidatePayloadHash };

export function routeCandidateFrontier(input) {
  const supplied = plainRecord(input,
    ['planningRequest', 'moduleBindings', 'candidates', 'observedAt', 'bounds'],
    ['planningRequest', 'moduleBindings', 'candidates', 'observedAt'],
    'candidate_router_input_invalid');
  const bounds = normalizeBounds(Object.hasOwn(supplied, 'bounds') ? supplied.bounds : {});
  const observed = timestamp(supplied.observedAt, 'candidate_router_observed_at_invalid');
  const request = normalizePlanningRequest(supplied.planningRequest, bounds, observed);
  const modules = normalizeModuleBindings(supplied.moduleBindings, bounds, request, observed);
  const rows = denseArray(supplied.candidates, request.candidateLimit, 'action_candidate_collection_invalid');
  if (rows.length === 0) throw failure('candidate_frontier_empty');
  const byId = new Map();
  const byPayload = new Map();
  let inputBytes = 0;
  let duplicateCount = 0;
  for (const raw of rows) {
    const normalized = normalizeCandidate(raw, bounds, request, modules, observed);
    const canonicalBytes = canonicalStringify(normalized.candidate);
    inputBytes += Buffer.byteLength(canonicalBytes, 'utf8');
    if (inputBytes > request.candidateBytesLimit) throw failure('candidate_frontier_byte_limit');
    const priorId = byId.get(normalized.candidate.candidateId);
    if (priorId) {
      if (canonicalStringify(priorId.candidate) !== canonicalBytes) {
        throw failure('action_candidate_id_conflict');
      }
      duplicateCount += 1;
      continue;
    }
    byId.set(normalized.candidate.candidateId, normalized);
    const payloadHash = normalized.candidate.candidatePayloadHash;
    const priorPayload = byPayload.get(payloadHash);
    if (priorPayload) {
      if (priorPayload.semanticBytes !== normalized.semanticBytes) {
        throw failure('action_candidate_payload_hash_collision');
      }
      duplicateCount += 1;
      if (compareUtf8(normalized.candidate.candidateId, priorPayload.candidate.candidateId) < 0) {
        byPayload.set(payloadHash, normalized);
      }
      continue;
    }
    byPayload.set(payloadHash, normalized);
  }
  const frontier = [...byPayload.values()].map((item) => item.candidate)
    .sort((left, right) => compareUtf8(left.candidatePayloadHash, right.candidatePayloadHash)
      || compareUtf8(left.moduleId, right.moduleId)
      || compareUtf8(left.moduleVersion, right.moduleVersion)
      || compareUtf8(left.candidateId, right.candidateId));
  if (frontier.length === 1) {
    if (!frontier[0].singletonReason) throw failure('candidate_frontier_singleton_reason_required');
  } else if (frontier.some((candidate) => candidate.singletonReason !== undefined
    && candidate.singletonReason !== null)) {
    throw failure('candidate_frontier_singleton_reason_forbidden');
  }
  const planningRequestHash = canonicalHashRecord('PlanningRequestV1', request);
  const candidateSetHash = canonicalHashRecord('CandidateFrontierV1', Object.freeze({
    planningRequestHash,
    moduleBindingSetHash: modules.hash,
    candidatePayloadHashes: Object.freeze(frontier.map((candidate) => candidate.candidatePayloadHash)),
    candidates: Object.freeze(frontier),
    dominanceReductionApplied: false,
  }));
  return Object.freeze({
    schemaVersion: 1,
    kind: 'CandidateFrontierV1',
    status: 'candidate_frontier_complete',
    planningRequestId: request.planningRequestId,
    stateSnapshotHash: request.stateSnapshotHash,
    capabilityId: request.capabilityId,
    planningRequestHash,
    moduleBindingSetHash: modules.hash,
    observedAt: observed.value,
    expiresAt: request.expiresAt,
    candidateCount: frontier.length,
    duplicateCount,
    inputCandidateCount: rows.length,
    inputCandidateBytes: inputBytes,
    candidates: Object.freeze(frontier),
    dominanceReductionApplied: false,
    dominancePolicy: 'context_replacement_proof_required',
    candidateSetHash,
    externalActionPerformed: false,
    authority: Object.freeze({
      productionAuthorized: false,
      providerAuthorized: false,
      writerAuthorized: false,
      releaseAuthorized: false,
      submissionAuthorized: false,
    }),
  });
}
