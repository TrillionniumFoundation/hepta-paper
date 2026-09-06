import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import {
  captureQualifiedPlanningModuleSetV1,
  routeActionCandidatesV1,
} from './candidate-router.mjs';
import {
  captureBoundedPlanSelectionProblemV1,
  capturePlannerJson,
  comparePlannerText,
  exactPlannerRecord,
  failPlanner,
  plannerDenseArray,
  plannerHash,
  plannerIdentifier,
  plannerInteger,
  plannerTimestamp,
} from './bounded-plan-selection-contract.mjs';

const COLLECTION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'planningRequestId',
  'planningRequestHash', 'stateSnapshotHash', 'capabilityId',
  'qualifiedModuleSetHash', 'producerSetHash', 'observedAt', 'producerCount',
  'producerDispositions', 'incompleteReasons', 'frontier', 'authority',
  'candidateCollectionResultHash',
]);
const DISPOSITION_FIELDS = Object.freeze([
  'moduleId', 'moduleVersion', 'status', 'completedAt', 'errorCode',
  'submittedCandidateCount', 'acceptedCandidateCount', 'candidateSetHash',
]);
const RECEIPT_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'stateSnapshotHash', 'buildRequestHash',
  'observedAt', 'moduleRegistryHash', 'policySetHash',
  'resourcePriceSnapshotHash', 'objectiveVersion',
  'qualifiedProjectionSetHash', 'currentGenerationSetHash',
  'currentProjectionGenerations', 'authority', 'currentnessReceiptHash',
]);
const AUTHORITY_FIELDS = Object.freeze([
  'centralWriteAuthorized', 'executionAuthorized', 'writerAuthorized',
  'providerAuthorized', 'releaseAuthorized', 'externalAuthorityClaimed',
]);

function falseAuthority(value, allowed, code) {
  const data = exactPlannerRecord(value, allowed, code);
  if (allowed.some((field) => data[field] !== false)) failPlanner(code);
  return Object.freeze(Object.fromEntries(allowed.map((field) => [field, false])));
}

function planningRequestData(value) {
  const captured = capturePlannerJson(value);
  const data = exactPlannerRecord(captured, [
    'schemaVersion', 'kind', 'planningRequestId', 'stateSnapshotHash',
    'capabilityId', 'goalReference', 'policyReference', 'hardConstraintSetHash',
    'objectiveVersion', 'resourcePriceSnapshotHash', 'qualifiedModuleSetHash',
    'candidateLimit', 'maximumCandidateBytes', 'maximumTotalCandidateBytes',
    'deadline', 'allowedSideEffectClasses', 'inputArtifacts',
  ], 'plan_planning_request_invalid');
  return Object.freeze({
    planningRequestId: plannerIdentifier(data.planningRequestId,
      'plan_planning_request_invalid'),
    stateSnapshotHash: plannerHash(data.stateSnapshotHash,
      'plan_planning_request_invalid'),
    capabilityId: data.capabilityId,
    hardConstraintSetHash: plannerHash(data.hardConstraintSetHash,
      'plan_planning_request_invalid'),
    objectiveVersion: data.objectiveVersion,
    resourcePriceSnapshotHash: plannerHash(data.resourcePriceSnapshotHash,
      'plan_planning_request_invalid'),
    qualifiedModuleSetHash: plannerHash(data.qualifiedModuleSetHash,
      'plan_planning_request_invalid'),
    candidateLimit: plannerInteger(data.candidateLimit, 1, 4096,
      'plan_planning_request_invalid'),
    deadline: plannerTimestamp(data.deadline, 'plan_planning_request_invalid'),
  });
}

function captureCompleteCollection(value, planningRequest, qualifiedModules) {
  const captured = capturePlannerJson(value);
  const data = exactPlannerRecord(captured, COLLECTION_FIELDS,
    'plan_candidate_collection_invalid');
  if (data.schemaVersion !== 1 || data.kind !== 'CandidateCollectionResultV1'
    || data.status !== 'candidate_frontier_complete' || data.frontier === null) {
    failPlanner('plan_candidate_collection_incomplete');
  }
  falseAuthority(data.authority, [
    'executionAuthorized', 'writerAuthorized', 'providerAuthorized',
    'releaseAuthorized', 'externalAuthorityClaimed',
  ], 'plan_candidate_collection_authority_invalid');
  if (!Array.isArray(data.incompleteReasons) || data.incompleteReasons.length !== 0) {
    failPlanner('plan_candidate_collection_incomplete');
  }
  const collectionBody = Object.freeze(Object.fromEntries(
    COLLECTION_FIELDS.filter((field) => field !== 'candidateCollectionResultHash')
      .map((field) => [field, data[field]]),
  ));
  if (data.candidateCollectionResultHash !== hashRecord(
    'CandidateCollectionResultV1', collectionBody,
  )) failPlanner('plan_candidate_collection_hash_invalid');

  const rerouted = routeActionCandidatesV1({
    planningRequest,
    qualifiedModules,
    candidates: data.frontier.candidates,
    observedAt: data.observedAt,
  });
  if (stableStringify(rerouted) !== stableStringify(data.frontier)) {
    failPlanner('plan_candidate_frontier_mismatch');
  }
  const request = planningRequestData(planningRequest);
  const qualified = captureQualifiedPlanningModuleSetV1(qualifiedModules);
  if (data.planningRequestId !== request.planningRequestId
    || data.planningRequestHash !== rerouted.planningRequestHash
    || data.stateSnapshotHash !== request.stateSnapshotHash
    || data.capabilityId !== request.capabilityId
    || data.qualifiedModuleSetHash !== qualified.qualifiedModuleSetHash) {
    failPlanner('plan_candidate_collection_subject_mismatch');
  }
  const expected = qualified.modules
    .filter((module) => module.capabilityIds.includes(request.capabilityId))
    .sort((left, right) => comparePlannerText(
      `${left.moduleId}\0${left.moduleVersion}`,
      `${right.moduleId}\0${right.moduleVersion}`,
    ));
  const producerSet = Object.freeze(expected.map((binding) => Object.freeze({
    moduleId: binding.moduleId,
    moduleVersion: binding.moduleVersion,
    qualificationStatus: binding.qualificationStatus,
    qualificationIdentity: binding.qualificationIdentity,
  })));
  if (data.producerSetHash !== hashRecord('CandidateProducerSetV1', producerSet)
    || data.producerCount !== expected.length) {
    failPlanner('plan_candidate_producer_set_mismatch');
  }
  const dispositions = plannerDenseArray(
    data.producerDispositions, 1024,
    'plan_candidate_producer_dispositions_invalid', expected.length,
  );
  if (dispositions.length !== expected.length) {
    failPlanner('plan_candidate_producer_dispositions_invalid');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const disposition = exactPlannerRecord(
      dispositions[index], DISPOSITION_FIELDS,
      'plan_candidate_producer_disposition_invalid',
    );
    const binding = expected[index];
    const accepted = Object.freeze(rerouted.candidates.filter((candidate) =>
      candidate.moduleId === binding.moduleId
      && candidate.moduleVersion === binding.moduleVersion));
    if (disposition.moduleId !== binding.moduleId
      || disposition.moduleVersion !== binding.moduleVersion
      || disposition.status !== 'candidate_batch_complete'
      || disposition.errorCode !== null
      || disposition.acceptedCandidateCount !== accepted.length
      || !Number.isSafeInteger(disposition.submittedCandidateCount)
      || disposition.submittedCandidateCount < accepted.length
      || disposition.submittedCandidateCount > request.candidateLimit
      || disposition.candidateSetHash !== hashRecord('ModuleCandidateSetV1', accepted)
      || Date.parse(plannerTimestamp(disposition.completedAt,
        'plan_candidate_producer_disposition_time_invalid'))
        > Date.parse(data.observedAt)) {
      failPlanner('plan_candidate_producer_disposition_mismatch');
    }
  }
  return Object.freeze({
    value: captured,
    hash: data.candidateCollectionResultHash,
    observedAt: plannerTimestamp(data.observedAt,
      'plan_candidate_collection_time_invalid'),
    frontier: rerouted,
    request,
    qualified,
  });
}

function captureCurrentnessReceipt(value) {
  const captured = capturePlannerJson(value);
  const data = exactPlannerRecord(captured, RECEIPT_FIELDS,
    'plan_snapshot_currentness_receipt_invalid');
  if (data.schemaVersion !== 1
    || data.kind !== 'ControlPlaneSnapshotCurrentnessReceiptV1'
    || data.status !== 'control_plane_snapshot_current') {
    failPlanner('plan_snapshot_currentness_receipt_invalid');
  }
  falseAuthority(data.authority, [
    'centralWriteAuthorized', 'executionAuthorized', 'providerAuthorized',
    'releaseAuthorized', 'externalAuthorityClaimed',
  ], 'plan_snapshot_currentness_authority_invalid');
  const generations = plannerDenseArray(
    data.currentProjectionGenerations, 2048,
    'plan_snapshot_generation_set_invalid', 1,
  ).map((entry) => {
    const row = exactPlannerRecord(entry, ['projectionId', 'sourceGeneration'],
      'plan_snapshot_generation_invalid');
    return Object.freeze({
      projectionId: plannerIdentifier(row.projectionId,
        'plan_snapshot_generation_invalid'),
      sourceGeneration: plannerInteger(row.sourceGeneration, 1,
        Number.MAX_SAFE_INTEGER, 'plan_snapshot_generation_invalid'),
    });
  });
  const ordered = [...generations].sort((left, right) => comparePlannerText(
    left.projectionId, right.projectionId,
  ));
  if (stableStringify(ordered) !== stableStringify(generations)
    || new Set(generations.map((entry) => entry.projectionId)).size !== generations.length
    || data.currentGenerationSetHash !== hashRecord(
      'CurrentProjectionGenerationSetV1', Object.freeze(generations),
    )) failPlanner('plan_snapshot_generation_set_invalid');
  const body = Object.freeze(Object.fromEntries(
    RECEIPT_FIELDS.filter((field) => field !== 'currentnessReceiptHash')
      .map((field) => [field, data[field]]),
  ));
  if (data.currentnessReceiptHash !== hashRecord(
    'ControlPlaneSnapshotCurrentnessReceiptV1', body,
  )) failPlanner('plan_snapshot_currentness_receipt_hash_invalid');
  return Object.freeze({
    value: captured,
    hash: data.currentnessReceiptHash,
    stateSnapshotHash: plannerHash(data.stateSnapshotHash,
      'plan_snapshot_currentness_receipt_invalid'),
    observedAt: plannerTimestamp(data.observedAt,
      'plan_snapshot_currentness_receipt_invalid'),
    policySetHash: plannerHash(data.policySetHash,
      'plan_snapshot_currentness_receipt_invalid'),
    resourcePriceSnapshotHash: plannerHash(data.resourcePriceSnapshotHash,
      'plan_snapshot_currentness_receipt_invalid'),
    objectiveVersion: data.objectiveVersion,
  });
}

function popcount(value) {
  let count = 0;
  let current = value;
  while (current) {
    current &= current - 1n;
    count += 1;
  }
  return count;
}

function selectionResult(problem, collection, receipt, outcome) {
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'BoundedPlanSelectionResultV1',
    status: outcome.status,
    planId: problem.planId,
    optimizationProblemHash: problem.optimizationProblemHash,
    candidateCollectionResultHash: collection.hash,
    snapshotCurrentnessReceiptHash: receipt.hash,
    stateSnapshotHash: collection.request.stateSnapshotHash,
    selectedAt: problem.selectedAt,
    selectedCandidateIds: Object.freeze(outcome.selectedCandidateIds),
    selectedCandidatePayloadHashes: Object.freeze(
      outcome.selectedCandidatePayloadHashes,
    ),
    achievedUtilityMicrounits: outcome.achievedUtilityMicrounits,
    resourceUsage: Object.freeze(outcome.resourceUsage),
    lowerBoundMicrounits: outcome.lowerBoundMicrounits,
    upperBoundMicrounits: outcome.upperBoundMicrounits,
    optimalityGapMicrounits: outcome.optimalityGapMicrounits,
    nodeExpansions: outcome.nodeExpansions,
    remainingSearchNodes: outcome.remainingSearchNodes,
    searchComplete: outcome.searchComplete,
    objectiveOptimal: outcome.objectiveOptimal,
    hardConstraintsSatisfied: outcome.hardConstraintsSatisfied,
    deterministicTieRule: 'first_feasible_in_fixed_include_first_search_order',
    searchOrderHash: outcome.searchOrderHash,
    authority: Object.freeze({
      executionAuthorized: false,
      writerAuthorized: false,
      providerAuthorized: false,
      releaseAuthorized: false,
      externalAuthorityClaimed: false,
    }),
  });
  return Object.freeze({
    ...body,
    planSelectionResultHash: hashRecord('BoundedPlanSelectionResultV1', body),
  });
}

export function selectBoundedPlanV1(value) {
  const input = exactPlannerRecord(value, [
    'planningRequest', 'qualifiedModules', 'candidateCollection',
    'snapshotCurrentnessReceipt', 'problem',
  ], 'plan_selection_input_invalid');
  const collection = captureCompleteCollection(
    input.candidateCollection, input.planningRequest, input.qualifiedModules,
  );
  const receipt = captureCurrentnessReceipt(input.snapshotCurrentnessReceipt);
  const problem = captureBoundedPlanSelectionProblemV1(input.problem);
  const request = collection.request;
  if (receipt.stateSnapshotHash !== request.stateSnapshotHash
    || receipt.policySetHash !== request.hardConstraintSetHash
    || receipt.resourcePriceSnapshotHash !== request.resourcePriceSnapshotHash
    || receipt.objectiveVersion !== request.objectiveVersion
    || Date.parse(receipt.observedAt) < Date.parse(collection.observedAt)
    || Date.parse(problem.selectedAt) < Date.parse(receipt.observedAt)
    || Date.parse(problem.selectedAt) > Date.parse(request.deadline)) {
    failPlanner('plan_selection_snapshot_or_time_mismatch');
  }
  if (problem.candidateCollectionResultHash !== collection.hash
    || problem.snapshotCurrentnessReceiptHash !== receipt.hash
    || problem.hardConstraintSetHash !== request.hardConstraintSetHash
    || problem.objectiveVersion !== request.objectiveVersion
    || problem.resourcePriceSnapshotHash !== request.resourcePriceSnapshotHash) {
    failPlanner('plan_selection_problem_subject_mismatch');
  }
  const candidatesById = new Map(collection.frontier.candidates.map((candidate) => [
    candidate.candidateId, candidate,
  ]));
  if (problem.evaluations.length !== candidatesById.size) {
    failPlanner('plan_selection_evaluation_coverage_invalid');
  }
  for (const evaluation of problem.evaluations) {
    const candidate = candidatesById.get(evaluation.candidateId);
    if (!candidate || candidate.candidatePayloadHash !== evaluation.candidatePayloadHash) {
      failPlanner('plan_selection_evaluation_coverage_invalid');
    }
  }

  const evaluations = problem.evaluations;
  const count = evaluations.length;
  const ids = evaluations.map((item) => item.candidateId);
  const idToIndex = new Map(ids.map((id, index) => [id, index]));
  const dimensions = Object.keys(problem.capacities);
  const dependencies = evaluations.map((item) =>
    item.dependsOnCandidateIds.map((id) => idToIndex.get(id)));
  const conflictMasks = Array.from({ length: count }, () => 0n);
  for (const [leftId, rightId] of problem.conflicts) {
    const left = idToIndex.get(leftId);
    const right = idToIndex.get(rightId);
    conflictMasks[left] |= 1n << BigInt(right);
    conflictMasks[right] |= 1n << BigInt(left);
  }
  const groupMasks = [...problem.exactlyOneGroups, ...problem.atMostOneGroups]
    .map((group) => group.reduce((mask, id) =>
      mask | (1n << BigInt(idToIndex.get(id))), 0n));
  const memberships = Array.from({ length: count }, () => []);
  groupMasks.forEach((mask, groupIndex) => {
    for (let index = 0; index < count; index += 1) {
      if (mask & (1n << BigInt(index))) memberships[index].push(groupIndex);
    }
  });
  const exactMasks = problem.exactlyOneGroups.map((group) => group.reduce(
    (mask, id) => mask | (1n << BigInt(idToIndex.get(id))), 0n));
  const searchOrder = Array.from({ length: count }, (_, index) => index)
    .sort((left, right) => evaluations[right].utilityMicrounits
      - evaluations[left].utilityMicrounits
      || comparePlannerText(ids[left], ids[right]));
  const searchOrderHash = hashRecord('BoundedPlanSearchOrderV1',
    Object.freeze(searchOrder.map((index) => ids[index])));

  function includeCandidate(node, initialIndex) {
    let selectedMask = node.selectedMask;
    let forbiddenMask = node.forbiddenMask;
    let selectedCount = node.selectedCount;
    let utility = node.utility;
    const resources = [...node.resources];
    const queue = [initialIndex];
    while (queue.length) {
      const index = queue.pop();
      const bit = 1n << BigInt(index);
      if (selectedMask & bit) continue;
      if (forbiddenMask & bit) return null;
      if (selectedMask & conflictMasks[index]) return null;
      if (memberships[index].some((groupIndex) => selectedMask & groupMasks[groupIndex])) {
        return null;
      }
      selectedMask |= bit;
      selectedCount += 1;
      if (selectedCount > problem.maximumSelected) return null;
      utility += evaluations[index].utilityMicrounits;
      if (!Number.isSafeInteger(utility)) failPlanner('plan_search_utility_overflow');
      for (let dimension = 0; dimension < dimensions.length; dimension += 1) {
        resources[dimension] += evaluations[index].resources[dimensions[dimension]];
        if (!Number.isSafeInteger(resources[dimension])) {
          failPlanner('plan_search_resource_overflow');
        }
        if (resources[dimension] > problem.capacities[dimensions[dimension]]) {
          return null;
        }
      }
      for (const dependency of dependencies[index]) queue.push(dependency);
    }
    return { selectedMask, forbiddenMask, selectedCount, utility, resources };
  }

  function excludeCandidate(node, index) {
    const bit = 1n << BigInt(index);
    if (node.selectedMask & bit) return null;
    return { ...node, forbiddenMask: node.forbiddenMask | bit };
  }

  function upperBound(node) {
    let bound = node.utility;
    for (let index = 0; index < count; index += 1) {
      const bit = 1n << BigInt(index);
      if (!(node.selectedMask & bit) && !(node.forbiddenMask & bit)
        && evaluations[index].utilityMicrounits > 0) {
        bound += evaluations[index].utilityMicrounits;
      }
    }
    if (!Number.isSafeInteger(bound)) failPlanner('plan_search_utility_overflow');
    return bound;
  }

  function nextCandidate(node) {
    return searchOrder.find((index) => {
      const bit = 1n << BigInt(index);
      return !(node.selectedMask & bit) && !(node.forbiddenMask & bit);
    });
  }

  function leafFeasible(node) {
    if (node.selectedCount < problem.minimumSelected
      || node.selectedCount > problem.maximumSelected) return false;
    return exactMasks.every((mask) => popcount(node.selectedMask & mask) === 1);
  }

  let forbiddenMask = 0n;
  for (const id of problem.forbiddenCandidateIds) {
    forbiddenMask |= 1n << BigInt(idToIndex.get(id));
  }
  let root = {
    selectedMask: 0n,
    forbiddenMask,
    selectedCount: 0,
    utility: 0,
    resources: dimensions.map(() => 0),
  };
  for (const id of problem.requiredCandidateIds) {
    root = includeCandidate(root, idToIndex.get(id));
    if (root === null) break;
  }

  const candidateHashes = new Map(collection.frontier.candidates.map((candidate) => [
    candidate.candidateId, candidate.candidatePayloadHash,
  ]));
  if (root === null) {
    return selectionResult(problem, collection, receipt, {
      status: 'selection_infeasible_proven',
      selectedCandidateIds: [],
      selectedCandidatePayloadHashes: [],
      achievedUtilityMicrounits: null,
      resourceUsage: Object.fromEntries(dimensions.map((dimension) => [dimension, 0])),
      lowerBoundMicrounits: null,
      upperBoundMicrounits: null,
      optimalityGapMicrounits: null,
      nodeExpansions: 0,
      remainingSearchNodes: 0,
      searchComplete: true,
      objectiveOptimal: false,
      hardConstraintsSatisfied: false,
      searchOrderHash,
    });
  }

  const stack = [root];
  const discovered = new Set([
    `${root.selectedMask.toString(16)}:${root.forbiddenMask.toString(16)}`,
  ]);
  let nodeExpansions = 0;
  let incumbent = null;
  const push = (node) => {
    if (!node) return;
    const key = `${node.selectedMask.toString(16)}:${node.forbiddenMask.toString(16)}`;
    if (!discovered.has(key)) {
      discovered.add(key);
      stack.push(node);
    }
  };
  while (stack.length && nodeExpansions < problem.maximumNodeExpansions) {
    const node = stack.pop();
    nodeExpansions += 1;
    const bound = upperBound(node);
    if (incumbent && bound <= incumbent.utility) continue;
    const next = nextCandidate(node);
    if (next === undefined) {
      if (leafFeasible(node) && (!incumbent || node.utility > incumbent.utility)) {
        incumbent = node;
      }
      continue;
    }
    // Exclude is pushed first so include is explored first by the LIFO stack.
    push(excludeCandidate(node, next));
    push(includeCandidate(node, next));
  }

  const remainingUpper = stack.length
    ? Math.max(...stack.map(upperBound)) : null;
  const searchComplete = stack.length === 0;
  if (!incumbent) {
    return selectionResult(problem, collection, receipt, {
      status: searchComplete
        ? 'selection_infeasible_proven'
        : 'selection_no_incumbent_with_remaining_search',
      selectedCandidateIds: [],
      selectedCandidatePayloadHashes: [],
      achievedUtilityMicrounits: null,
      resourceUsage: Object.fromEntries(dimensions.map((dimension) => [dimension, 0])),
      lowerBoundMicrounits: null,
      upperBoundMicrounits: searchComplete ? null : remainingUpper,
      optimalityGapMicrounits: null,
      nodeExpansions,
      remainingSearchNodes: stack.length,
      searchComplete,
      objectiveOptimal: false,
      hardConstraintsSatisfied: false,
      searchOrderHash,
    });
  }
  const upper = searchComplete
    ? incumbent.utility : Math.max(incumbent.utility, remainingUpper);
  const objectiveOptimal = searchComplete || upper <= incumbent.utility;
  const selectedCandidateIds = ids.filter((id, index) =>
    incumbent.selectedMask & (1n << BigInt(index))).sort(comparePlannerText);
  const selectedCandidatePayloadHashes = selectedCandidateIds.map((id) =>
    candidateHashes.get(id));
  const resourceUsage = Object.fromEntries(dimensions.map((dimension, index) => [
    dimension, incumbent.resources[index],
  ]));
  return selectionResult(problem, collection, receipt, {
    status: objectiveOptimal
      ? 'selection_objective_optimal'
      : 'selection_feasible_bounded_gap',
    selectedCandidateIds,
    selectedCandidatePayloadHashes,
    achievedUtilityMicrounits: incumbent.utility,
    resourceUsage,
    lowerBoundMicrounits: incumbent.utility,
    upperBoundMicrounits: upper,
    optimalityGapMicrounits: upper - incumbent.utility,
    nodeExpansions,
    remainingSearchNodes: stack.length,
    searchComplete,
    objectiveOptimal,
    hardConstraintsSatisfied: true,
    searchOrderHash,
  });
}
