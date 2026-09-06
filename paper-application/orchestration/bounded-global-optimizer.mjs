import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/u;
const RESOURCE_FIELDS = Object.freeze([
  'cpuUnits',
  'gpuUnits',
  'memoryMiB',
  'storageBytes',
  'tokenCount',
]);
const PROBLEM_FIELDS = Object.freeze([
  'schemaVersion',
  'kind',
  'problemId',
  'objectiveVersion',
  'candidateSetHash',
  'resourceLimits',
  'maximumCostMicrousd',
  'requiredGroups',
  'requiredCapabilities',
  'candidates',
]);
const SEALED_PROBLEM_FIELDS = Object.freeze([...PROBLEM_FIELDS, 'problemHash']);
const CANDIDATE_FIELDS = Object.freeze([
  'candidateId',
  'decisionGroup',
  'valueMicrounits',
  'costMicrousd',
  'resourceVector',
  'dependencies',
  'conflicts',
  'capabilities',
]);
const DEFAULT_LIMITS = Object.freeze({
  maximumCandidates: 128,
  maximumGroups: 64,
  maximumExpansions: 1_000_000,
  maximumStringBytes: 8192,
  maximumArrayItems: 4096,
  maximumTotalBytes: 8 * 1024 * 1024,
});

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordValues(value, allowed, code) {
  if (value === null || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)
    || !descriptors[key].enumerable
    || !Object.hasOwn(descriptors[key], 'value'))) throw failure(code);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArrayValues(value, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (!descriptors.length || descriptors.length.value !== value.length
    || descriptors.length.enumerable || keys.length !== value.length + 1
    || keys.some((key) => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)
        || Number(key) >= value.length))) throw failure(code);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure(code);
    }
    return descriptor.value;
  });
}

function boundedString(value, limits, code, { hash = false } = {}) {
  if (typeof value !== 'string' || value.length === 0
    || Buffer.byteLength(value, 'utf8') > limits.maximumStringBytes
    || (hash && !HASH.test(value))) throw failure(code);
  return value;
}

function safeInteger(value, code, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) throw failure(code);
  return Object.is(value, -0) ? 0 : value;
}

function safeAdd(left, right, code = 'optimization_integer_overflow') {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw failure(code);
  return value;
}

function captureStringSet(value, limits, code, { allowEmpty = true } = {}) {
  const rows = denseArrayValues(value, code);
  if (rows.length > limits.maximumArrayItems || (!allowEmpty && rows.length === 0)) {
    throw failure(code);
  }
  const values = rows.map((row) => boundedString(row, limits, code));
  if (new Set(values).size !== values.length) throw failure(code);
  return Object.freeze(values.sort(compareText));
}

function normalizeLimits(options = {}) {
  const values = recordValues(options, Object.keys(DEFAULT_LIMITS), 'optimizer_limits_invalid');
  const limits = { ...DEFAULT_LIMITS, ...values };
  const ceilings = {
    maximumCandidates: 4096,
    maximumGroups: 1024,
    maximumExpansions: 10_000_000,
    maximumStringBytes: 1024 * 1024,
    maximumArrayItems: 65536,
    maximumTotalBytes: 64 * 1024 * 1024,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key]) {
      throw failure('optimizer_limits_invalid');
    }
  }
  return Object.freeze(limits);
}

function captureResourceVector(value, code) {
  const input = recordValues(value, RESOURCE_FIELDS, code);
  if (RESOURCE_FIELDS.some((key) => !Object.hasOwn(input, key))) throw failure(code);
  return Object.freeze(Object.fromEntries(RESOURCE_FIELDS.map((key) => [
    key,
    safeInteger(input[key], `${code}:${key}`),
  ])));
}

function captureCandidate(value, limits) {
  const input = recordValues(value, CANDIDATE_FIELDS, 'optimization_candidate_invalid');
  if (CANDIDATE_FIELDS.some((key) => !Object.hasOwn(input, key))) {
    throw failure('optimization_candidate_invalid');
  }
  return Object.freeze({
    candidateId: boundedString(input.candidateId, limits, 'optimization_candidate_invalid'),
    decisionGroup: boundedString(input.decisionGroup, limits, 'optimization_candidate_invalid'),
    valueMicrounits: safeInteger(
      input.valueMicrounits,
      'optimization_candidate_value_invalid',
      { minimum: Number.MIN_SAFE_INTEGER },
    ),
    costMicrousd: safeInteger(input.costMicrousd, 'optimization_candidate_cost_invalid'),
    resourceVector: captureResourceVector(
      input.resourceVector,
      'optimization_candidate_resource_invalid',
    ),
    dependencies: captureStringSet(
      input.dependencies,
      limits,
      'optimization_candidate_dependencies_invalid',
    ),
    conflicts: captureStringSet(
      input.conflicts,
      limits,
      'optimization_candidate_conflicts_invalid',
    ),
    capabilities: captureStringSet(
      input.capabilities,
      limits,
      'optimization_candidate_capabilities_invalid',
    ),
  });
}

function captureProblemBody(value, limits) {
  const input = recordValues(value, PROBLEM_FIELDS, 'optimization_problem_invalid');
  if (PROBLEM_FIELDS.some((key) => !Object.hasOwn(input, key))
    || input.schemaVersion !== 1 || input.kind !== 'GlobalOptimizationProblemV1') {
    throw failure('optimization_problem_invalid');
  }
  const rows = denseArrayValues(input.candidates, 'optimization_candidate_set_invalid');
  if (rows.length === 0 || rows.length > limits.maximumCandidates) {
    throw failure('optimization_candidate_count_limit');
  }
  const candidates = rows.map((row) => captureCandidate(row, limits))
    .sort((left, right) => compareText(left.decisionGroup, right.decisionGroup)
      || compareText(left.candidateId, right.candidateId));
  const ids = candidates.map((candidate) => candidate.candidateId);
  if (new Set(ids).size !== ids.length) throw failure('optimization_candidate_id_duplicate');
  const groups = [...new Set(candidates.map((candidate) => candidate.decisionGroup))];
  if (groups.length > limits.maximumGroups) throw failure('optimization_group_count_limit');
  const requiredGroups = captureStringSet(
    input.requiredGroups,
    limits,
    'optimization_required_groups_invalid',
  );
  if (requiredGroups.some((group) => !groups.includes(group))) {
    throw failure('optimization_required_group_missing');
  }
  const known = new Set(ids);
  for (const candidate of candidates) {
    for (const dependency of candidate.dependencies) {
      if (!known.has(dependency) || dependency === candidate.candidateId) {
        throw failure('optimization_dependency_invalid');
      }
    }
    for (const conflict of candidate.conflicts) {
      if (!known.has(conflict) || conflict === candidate.candidateId) {
        throw failure('optimization_conflict_invalid');
      }
    }
  }
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'GlobalOptimizationProblemV1',
    problemId: boundedString(input.problemId, limits, 'optimization_problem_invalid'),
    objectiveVersion: boundedString(input.objectiveVersion, limits, 'optimization_problem_invalid'),
    candidateSetHash: boundedString(
      input.candidateSetHash,
      limits,
      'optimization_problem_invalid',
      { hash: true },
    ),
    resourceLimits: captureResourceVector(input.resourceLimits, 'optimization_resource_limits_invalid'),
    maximumCostMicrousd: safeInteger(
      input.maximumCostMicrousd,
      'optimization_cost_limit_invalid',
    ),
    requiredGroups,
    requiredCapabilities: captureStringSet(
      input.requiredCapabilities,
      limits,
      'optimization_required_capabilities_invalid',
    ),
    candidates: Object.freeze(candidates),
  });
  if (Buffer.byteLength(stableStringify(body), 'utf8') > limits.maximumTotalBytes) {
    throw failure('optimization_problem_byte_limit');
  }
  return body;
}

export function sealOptimizationProblem(value, options = {}) {
  const limits = normalizeLimits(options);
  const body = captureProblemBody(value, limits);
  return Object.freeze({
    ...body,
    problemHash: hashRecord('GlobalOptimizationProblemV1', body),
  });
}

function captureSealedProblem(value, limits) {
  const input = recordValues(value, SEALED_PROBLEM_FIELDS, 'optimization_problem_invalid');
  if (!Object.hasOwn(input, 'problemHash')) throw failure('optimization_problem_invalid');
  const body = captureProblemBody(Object.fromEntries(
    PROBLEM_FIELDS.map((key) => [key, input[key]]),
  ), limits);
  const problemHash = boundedString(
    input.problemHash,
    limits,
    'optimization_problem_hash_invalid',
    { hash: true },
  );
  if (problemHash !== hashRecord('GlobalOptimizationProblemV1', body)) {
    throw failure('optimization_problem_hash_invalid');
  }
  return Object.freeze({ ...body, problemHash });
}

function addResources(left, right) {
  return Object.freeze(Object.fromEntries(RESOURCE_FIELDS.map((key) => [
    key,
    safeAdd(left[key], right[key]),
  ])));
}

function withinResources(used, limits) {
  return RESOURCE_FIELDS.every((key) => used[key] <= limits[key]);
}

function zeroResources() {
  return Object.freeze(Object.fromEntries(RESOURCE_FIELDS.map((key) => [key, 0])));
}

function selectedKey(selected) {
  return [...selected].sort(compareText).join('\u0000');
}

function betterSolution(candidate, incumbent) {
  if (incumbent === null || candidate.value > incumbent.value) return true;
  if (candidate.value < incumbent.value) return false;
  return compareText(selectedKey(candidate.selected), selectedKey(incumbent.selected)) < 0;
}

function validatePartial(node, context) {
  if (node.cost > context.problem.maximumCostMicrousd
    || !withinResources(node.resources, context.problem.resourceLimits)) return false;
  for (const candidateId of node.selected) {
    const candidate = context.byId.get(candidateId);
    for (const conflict of candidate.conflicts) {
      if (node.selected.has(conflict)) return false;
    }
    for (const other of node.selected) {
      if (context.byId.get(other).conflicts.includes(candidateId)) return false;
    }
    for (const dependency of candidate.dependencies) {
      const group = context.byId.get(dependency).decisionGroup;
      const assignedIndex = context.groupIndex.get(group);
      if (assignedIndex < node.index && !node.selected.has(dependency)) return false;
    }
  }
  const possibleCapabilities = new Set(node.capabilities);
  for (let index = node.index; index < context.groups.length; index += 1) {
    for (const candidate of context.byGroup.get(context.groups[index])) {
      for (const capability of candidate.capabilities) possibleCapabilities.add(capability);
    }
  }
  return context.problem.requiredCapabilities.every((capability) => possibleCapabilities.has(capability));
}

function completeFeasible(node, context) {
  if (!context.problem.requiredCapabilities.every((capability) => node.capabilities.has(capability))) {
    return false;
  }
  for (const candidateId of node.selected) {
    const candidate = context.byId.get(candidateId);
    if (!candidate.dependencies.every((dependency) => node.selected.has(dependency))) return false;
    if (candidate.conflicts.some((conflict) => node.selected.has(conflict))) return false;
  }
  return true;
}

function nodeUpperBound(node, context) {
  let upper = node.value;
  for (let index = node.index; index < context.groups.length; index += 1) {
    upper = safeAdd(upper, context.groupMaximum.get(context.groups[index]));
  }
  return upper;
}

function compareNodes(left, right) {
  if (left.upperBound !== right.upperBound) return left.upperBound < right.upperBound ? 1 : -1;
  if (left.index !== right.index) return right.index - left.index;
  return compareText(selectedKey(left.selected), selectedKey(right.selected));
}

function createContext(problem) {
  const byId = new Map(problem.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const groups = [...new Set(problem.candidates.map((candidate) => candidate.decisionGroup))]
    .sort(compareText);
  const groupIndex = new Map(groups.map((group, index) => [group, index]));
  const byGroup = new Map(groups.map((group) => [
    group,
    problem.candidates.filter((candidate) => candidate.decisionGroup === group)
      .sort((left, right) => (left.valueMicrounits === right.valueMicrounits
        ? compareText(left.candidateId, right.candidateId)
        : left.valueMicrounits < right.valueMicrounits ? 1 : -1)),
  ]));
  const required = new Set(problem.requiredGroups);
  const groupMaximum = new Map(groups.map((group) => {
    const maximum = Math.max(...byGroup.get(group).map((candidate) => candidate.valueMicrounits));
    return [group, required.has(group) ? maximum : Math.max(0, maximum)];
  }));
  return { problem, byId, groups, groupIndex, byGroup, required, groupMaximum };
}

function resultRecord(problem, status, expansions, complete, incumbent, upperBound) {
  const lowerBound = incumbent?.value ?? null;
  const selectedCandidateIds = incumbent
    ? Object.freeze([...incumbent.selected].sort(compareText))
    : Object.freeze([]);
  const body = Object.freeze({
    schemaVersion: 1,
    kind: 'BoundedOptimizationResultV1',
    status,
    problemHash: problem.problemHash,
    objectiveVersion: problem.objectiveVersion,
    expansions,
    searchComplete: complete,
    feasibleIncumbentFound: incumbent !== null,
    lowerBoundMicrounits: lowerBound,
    upperBoundMicrounits: upperBound,
    optimalityGapMicrounits: lowerBound === null ? null : upperBound - lowerBound,
    objectiveOptimalityProven: complete && incumbent !== null,
    infeasibilityProven: complete && incumbent === null,
    selectedCandidateIds,
    selectedCostMicrousd: incumbent?.cost ?? null,
    selectedResourceVector: incumbent?.resources ?? null,
    authority: Object.freeze({
      executionAuthorized: false,
      stateMutationAuthorized: false,
      productionActivationAuthorized: false,
    }),
  });
  return Object.freeze({
    ...body,
    resultHash: hashRecord('BoundedOptimizationResultV1', body),
  });
}

export function createBoundedGlobalOptimizer(options = {}) {
  const limits = normalizeLimits(options);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'BoundedGlobalOptimizerV1',
    limits,
    optimize(value, { maximumExpansions = limits.maximumExpansions } = {}) {
      if (!Number.isSafeInteger(maximumExpansions) || maximumExpansions < 1
        || maximumExpansions > limits.maximumExpansions) {
        throw failure('optimizer_expansion_limit_invalid');
      }
      const problem = captureSealedProblem(value, limits);
      const context = createContext(problem);
      const initial = {
        index: 0,
        selected: new Set(),
        value: 0,
        cost: 0,
        resources: zeroResources(),
        capabilities: new Set(),
      };
      initial.upperBound = nodeUpperBound(initial, context);
      const frontier = [initial];
      let incumbent = null;
      let expansions = 0;
      while (frontier.length && expansions < maximumExpansions) {
        frontier.sort(compareNodes);
        const node = frontier.shift();
        expansions += 1;
        if (incumbent !== null && node.upperBound < incumbent.value) continue;
        if (!validatePartial(node, context)) continue;
        if (node.index === context.groups.length) {
          if (completeFeasible(node, context) && betterSolution(node, incumbent)) {
            incumbent = node;
          }
          continue;
        }
        const group = context.groups[node.index];
        const options = [...context.byGroup.get(group)];
        if (!context.required.has(group)) options.push(null);
        for (const candidate of options) {
          const selected = new Set(node.selected);
          let value = node.value;
          let cost = node.cost;
          let resources = node.resources;
          const capabilities = new Set(node.capabilities);
          if (candidate !== null) {
            selected.add(candidate.candidateId);
            value = safeAdd(value, candidate.valueMicrounits);
            cost = safeAdd(cost, candidate.costMicrousd);
            resources = addResources(resources, candidate.resourceVector);
            for (const capability of candidate.capabilities) capabilities.add(capability);
          }
          const child = {
            index: node.index + 1,
            selected,
            value,
            cost,
            resources,
            capabilities,
          };
          child.upperBound = nodeUpperBound(child, context);
          if ((incumbent === null || child.upperBound >= incumbent.value)
            && validatePartial(child, context)) frontier.push(child);
        }
      }
      const complete = frontier.length === 0;
      const pendingUpper = complete
        ? incumbent?.value ?? Number.MIN_SAFE_INTEGER
        : Math.max(...frontier.map((node) => node.upperBound), incumbent?.value ?? Number.MIN_SAFE_INTEGER);
      if (complete && incumbent === null) {
        return resultRecord(problem, 'infeasible', expansions, true, null, null);
      }
      if (complete) {
        return resultRecord(problem, 'optimal', expansions, true, incumbent, incumbent.value);
      }
      if (incumbent === null) {
        return resultRecord(problem, 'no_feasible_incumbent', expansions, false, null, pendingUpper);
      }
      return resultRecord(problem, 'bounded', expansions, false, incumbent, pendingUpper);
    },
  });
}
