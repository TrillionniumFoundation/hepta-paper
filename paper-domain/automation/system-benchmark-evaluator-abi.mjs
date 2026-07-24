import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAXIMUM_PROFILES = 128;
const MAXIMUM_FIELDS = 64;
const MAXIMUM_METRICS = 64;
const ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);

export const REGISTERED_SCALAR_RESPONSE_BENCHMARK_FAMILY =
  'registered_scalar_response_benchmark';

export const SYSTEM_BENCHMARK_EVALUATOR_OPERATORS = Object.freeze({
  arithmetic_mean: Object.freeze({ operandCount: 1 }),
  sample_standard_error: Object.freeze({ operandCount: 1 }),
  arithmetic_mean_difference: Object.freeze({ operandCount: 2 }),
});

const DESCRIPTORS = Object.freeze([
  Object.freeze({
    version: 1,
    kind: 'SystemBenchmarkEvaluatorDescriptor',
    profileId: 'rl-stochastic-control-event-metrics-v1',
    benchmarkFamily: 'rl_stochastic_control_benchmark',
    armOperations: Object.freeze({
      treatment: 'candidate-policy',
      baseline: 'zero-action-reference-policy',
      ablation: 'candidate-without-constraint-penalty',
    }),
    oracleFields: Object.freeze(['constraintLimit', 'disturbance', 'target']),
    rawEventFields: Object.freeze(['constraintViolation', 'return', 'robustnessReturn', 'tailReturn']),
    metrics: Object.freeze([
      Object.freeze({ metric: 'mean_return', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['return']) }) }),
      Object.freeze({ metric: 'tail_return', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['tailReturn']) }) }),
      Object.freeze({ metric: 'constraint_violation_rate', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['constraintViolation']) }) }),
      Object.freeze({ metric: 'robustness_gap', expression: Object.freeze({ operator: 'arithmetic_mean_difference', operands: Object.freeze(['return', 'robustnessReturn']) }) }),
    ]),
  }),
  Object.freeze({
    version: 1,
    kind: 'SystemBenchmarkEvaluatorDescriptor',
    profileId: 'ml-algorithm-event-metrics-v1',
    benchmarkFamily: 'ml_algorithm_benchmark',
    armOperations: Object.freeze({
      treatment: 'candidate-model',
      baseline: 'majority-class-reference-model',
      ablation: 'candidate-without-primary-feature-group',
    }),
    oracleFields: Object.freeze(['label', 'robustLabel']),
    rawEventFields: Object.freeze(['referenceScore', 'robustnessScore', 'score']),
    metrics: Object.freeze([
      Object.freeze({ metric: 'mean_score', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['score']) }) }),
      Object.freeze({ metric: 'standard_error', expression: Object.freeze({ operator: 'sample_standard_error', operands: Object.freeze(['score']) }) }),
      Object.freeze({ metric: 'baseline_gap', expression: Object.freeze({ operator: 'arithmetic_mean_difference', operands: Object.freeze(['score', 'referenceScore']) }) }),
      Object.freeze({ metric: 'robustness_gap', expression: Object.freeze({ operator: 'arithmetic_mean_difference', operands: Object.freeze(['score', 'robustnessScore']) }) }),
    ]),
  }),
  Object.freeze({
    version: 1,
    kind: 'SystemBenchmarkEvaluatorDescriptor',
    profileId: 'econometrics-panel-event-metrics-v1',
    benchmarkFamily: 'econometrics_panel_benchmark',
    armOperations: Object.freeze({
      treatment: 'candidate-estimator',
      baseline: 'pooled-ols-reference-estimator',
      ablation: 'candidate-with-placebo-outcome',
    }),
    oracleFields: Object.freeze(['robustEffect', 'trueEffect']),
    rawEventFields: Object.freeze(['effect', 'placeboEffect', 'robustnessEffect']),
    metrics: Object.freeze([
      Object.freeze({ metric: 'mean_effect', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['effect']) }) }),
      Object.freeze({ metric: 'standard_error', expression: Object.freeze({ operator: 'sample_standard_error', operands: Object.freeze(['effect']) }) }),
      Object.freeze({ metric: 'placebo_gap', expression: Object.freeze({ operator: 'arithmetic_mean_difference', operands: Object.freeze(['effect', 'placeboEffect']) }) }),
      Object.freeze({ metric: 'robustness_gap', expression: Object.freeze({ operator: 'arithmetic_mean_difference', operands: Object.freeze(['effect', 'robustnessEffect']) }) }),
    ]),
  }),
  Object.freeze({
    version: 1,
    kind: 'SystemBenchmarkEvaluatorDescriptor',
    profileId: 'finance-asset-pricing-event-metrics-v1',
    benchmarkFamily: 'finance_asset_pricing_benchmark',
    armOperations: Object.freeze({
      treatment: 'candidate-strategy',
      baseline: 'equal-weight-reference-strategy',
      ablation: 'candidate-without-primary-factor',
    }),
    oracleFields: Object.freeze(['futureReturn', 'robustReturn']),
    rawEventFields: Object.freeze(['return', 'robustnessReturn', 'tailReturn']),
    metrics: Object.freeze([
      Object.freeze({ metric: 'mean_return', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['return']) }) }),
      Object.freeze({ metric: 'tail_return', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['tailReturn']) }) }),
      Object.freeze({ metric: 'standard_error', expression: Object.freeze({ operator: 'sample_standard_error', operands: Object.freeze(['return']) }) }),
      Object.freeze({ metric: 'robustness_gap', expression: Object.freeze({ operator: 'arithmetic_mean_difference', operands: Object.freeze(['return', 'robustnessReturn']) }) }),
    ]),
  }),
  Object.freeze({
    version: 1,
    kind: 'SystemBenchmarkEvaluatorDescriptor',
    profileId: 'operations-optimization-event-metrics-v1',
    benchmarkFamily: 'operations_optimization_benchmark',
    armOperations: Object.freeze({
      treatment: 'candidate-solver',
      baseline: 'greedy-feasible-reference-solver',
      ablation: 'candidate-without-primary-constraint-family',
    }),
    oracleFields: Object.freeze(['capacity', 'demand', 'unitCost']),
    rawEventFields: Object.freeze(['constraintViolation', 'robustnessScore', 'score']),
    metrics: Object.freeze([
      Object.freeze({ metric: 'mean_score', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['score']) }) }),
      Object.freeze({ metric: 'constraint_violation_rate', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['constraintViolation']) }) }),
      Object.freeze({ metric: 'standard_error', expression: Object.freeze({ operator: 'sample_standard_error', operands: Object.freeze(['score']) }) }),
      Object.freeze({ metric: 'robustness_gap', expression: Object.freeze({ operator: 'arithmetic_mean_difference', operands: Object.freeze(['score', 'robustnessScore']) }) }),
    ]),
  }),
  Object.freeze({
    version: 1,
    kind: 'SystemBenchmarkEvaluatorDescriptor',
    profileId: 'registered-scalar-response-event-metrics-v1',
    benchmarkFamily: REGISTERED_SCALAR_RESPONSE_BENCHMARK_FAMILY,
    armOperations: Object.freeze({
      treatment: 'candidate-scalar-response',
      baseline: 'operator-registered-reference-response',
      ablation: 'candidate-scalar-response-on-operator-redacted-input',
    }),
    oracleFields: Object.freeze(['lowerBound', 'robustTarget', 'target', 'upperBound']),
    rawEventFields: Object.freeze(['constraintViolation', 'robustnessScore', 'score']),
    metrics: Object.freeze([
      Object.freeze({ metric: 'mean_score', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['score']) }) }),
      Object.freeze({ metric: 'standard_error', expression: Object.freeze({ operator: 'sample_standard_error', operands: Object.freeze(['score']) }) }),
      Object.freeze({ metric: 'constraint_violation_rate', expression: Object.freeze({ operator: 'arithmetic_mean', operands: Object.freeze(['constraintViolation']) }) }),
      Object.freeze({ metric: 'robustness_gap', expression: Object.freeze({ operator: 'arithmetic_mean_difference', operands: Object.freeze(['score', 'robustnessScore']) }) }),
    ]),
  }),
]);

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value).sort();
  return actual.join('\0') === [...keys].sort().join('\0')
    && actual.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
    });
}

function denseDataArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.keys(value).length !== value.length) return false;
  return Array.from({ length: value.length }, (_, index) => index).every((index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function canonicalString(value, pattern, error) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(error);
  return value;
}

function canonicalUniqueStrings(values, { maximum, error }) {
  if (!denseDataArray(values) || values.length < 1 || values.length > maximum
    || values.some((value) => typeof value !== 'string' || !IDENTIFIER.test(value))
    || new Set(values).size !== values.length) throw new Error(error);
  return Object.freeze([...values]);
}

function compileDescriptor(value) {
  if (!exactKeys(value, [
    'version', 'kind', 'profileId', 'benchmarkFamily', 'armOperations', 'oracleFields',
    'rawEventFields', 'metrics',
  ]) || value.version !== 1 || value.kind !== 'SystemBenchmarkEvaluatorDescriptor') {
    throw new Error('system_benchmark_evaluator_descriptor_shape_invalid');
  }
  const profileId = canonicalString(
    value.profileId,
    PROFILE_ID,
    'system_benchmark_evaluator_descriptor_profile_id_invalid',
  );
  const benchmarkFamily = canonicalString(
    value.benchmarkFamily,
    IDENTIFIER,
    'system_benchmark_evaluator_descriptor_family_invalid',
  );
  if (!exactKeys(value.armOperations, ARMS)
    || ARMS.some((arm) => typeof value.armOperations[arm] !== 'string'
      || !PROFILE_ID.test(value.armOperations[arm]))
    || new Set(ARMS.map((arm) => value.armOperations[arm])).size !== ARMS.length) {
    throw new Error('system_benchmark_evaluator_descriptor_arm_operations_invalid');
  }
  const rawEventFields = canonicalUniqueStrings(value.rawEventFields, {
    maximum: MAXIMUM_FIELDS,
    error: 'system_benchmark_evaluator_descriptor_event_fields_invalid',
  });
  if (rawEventFields.join('\0') !== [...rawEventFields].sort().join('\0')) {
    throw new Error('system_benchmark_evaluator_descriptor_event_fields_not_canonical');
  }
  const oracleFields = canonicalUniqueStrings(value.oracleFields, {
    maximum: MAXIMUM_FIELDS,
    error: 'system_benchmark_evaluator_descriptor_oracle_fields_invalid',
  });
  if (oracleFields.join('\0') !== [...oracleFields].sort().join('\0')) {
    throw new Error('system_benchmark_evaluator_descriptor_oracle_fields_not_canonical');
  }
  if (!denseDataArray(value.metrics) || value.metrics.length < 1 || value.metrics.length > MAXIMUM_METRICS) {
    throw new Error('system_benchmark_evaluator_descriptor_metrics_invalid');
  }
  const metricNames = new Set();
  const metrics = value.metrics.map((entry) => {
    if (!exactKeys(entry, ['metric', 'expression'])
      || typeof entry.metric !== 'string' || !IDENTIFIER.test(entry.metric)
      || metricNames.has(entry.metric)
      || !exactKeys(entry.expression, ['operator', 'operands'])) {
      throw new Error('system_benchmark_evaluator_descriptor_metric_invalid');
    }
    metricNames.add(entry.metric);
    const operation = typeof entry.expression.operator === 'string'
      && Object.hasOwn(SYSTEM_BENCHMARK_EVALUATOR_OPERATORS, entry.expression.operator)
      ? SYSTEM_BENCHMARK_EVALUATOR_OPERATORS[entry.expression.operator]
      : null;
    if (!operation) throw new Error('system_benchmark_evaluator_descriptor_operator_unknown');
    const operands = canonicalUniqueStrings(entry.expression.operands, {
      maximum: operation.operandCount,
      error: 'system_benchmark_evaluator_descriptor_operands_invalid',
    });
    if (operands.length !== operation.operandCount
      || operands.some((operand) => !rawEventFields.includes(operand))) {
      throw new Error('system_benchmark_evaluator_descriptor_operands_invalid');
    }
    return Object.freeze({
      metric: entry.metric,
      expression: Object.freeze({ operator: entry.expression.operator, operands }),
    });
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'SystemBenchmarkEvaluatorDescriptor',
    profileId,
    benchmarkFamily,
    armOperations: Object.freeze(Object.fromEntries(ARMS.map((arm) => [arm, value.armOperations[arm]]))),
    oracleFields,
    rawEventFields,
    metrics: Object.freeze(metrics),
  });
  return Object.freeze({
    ...payload,
    systemBenchmarkEvaluatorDescriptorHash: hashRecord('SystemBenchmarkEvaluatorDescriptor', payload),
  });
}

export function compileSystemBenchmarkEvaluatorRegistry(descriptors) {
  if (!denseDataArray(descriptors) || descriptors.length < 1 || descriptors.length > MAXIMUM_PROFILES) {
    throw new Error('system_benchmark_evaluator_registry_descriptors_invalid');
  }
  const profiles = descriptors.map(compileDescriptor)
    .sort((left, right) => (left.benchmarkFamily === right.benchmarkFamily
      ? 0 : (left.benchmarkFamily < right.benchmarkFamily ? -1 : 1)));
  if (new Set(profiles.map((profile) => profile.benchmarkFamily)).size !== profiles.length) {
    throw new Error('system_benchmark_evaluator_registry_family_duplicate');
  }
  if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length) {
    throw new Error('system_benchmark_evaluator_registry_profile_duplicate');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'SystemBenchmarkEvaluatorRegistry',
    profiles: Object.freeze(profiles),
  });
  return Object.freeze({
    ...payload,
    systemBenchmarkEvaluatorRegistryHash: hashRecord('SystemBenchmarkEvaluatorRegistry', payload),
  });
}

export const SYSTEM_BENCHMARK_EVALUATOR_DESCRIPTORS = DESCRIPTORS;
export const SYSTEM_BENCHMARK_EVALUATOR_REGISTRY = compileSystemBenchmarkEvaluatorRegistry(DESCRIPTORS);
const SYSTEM_BENCHMARK_EVALUATOR_BY_FAMILY = new Map(
  SYSTEM_BENCHMARK_EVALUATOR_REGISTRY.profiles.map(
    (profile) => [profile.benchmarkFamily, profile],
  ),
);

export function verifySystemBenchmarkEvaluatorRegistry(registry) {
  if (registry === SYSTEM_BENCHMARK_EVALUATOR_REGISTRY) return true;
  if (!exactKeys(registry, [
    'version', 'kind', 'profiles', 'systemBenchmarkEvaluatorRegistryHash',
  ]) || registry.version !== 1 || registry.kind !== 'SystemBenchmarkEvaluatorRegistry'
    || !denseDataArray(registry.profiles)) return false;
  try {
    const rebuilt = compileSystemBenchmarkEvaluatorRegistry(registry.profiles.map((profile) => {
      const { systemBenchmarkEvaluatorDescriptorHash, ...descriptor } = profile || {};
      if (typeof systemBenchmarkEvaluatorDescriptorHash !== 'string'
        || hashRecord('SystemBenchmarkEvaluatorDescriptor', descriptor)
          !== systemBenchmarkEvaluatorDescriptorHash) {
        throw new Error('system_benchmark_evaluator_descriptor_hash_invalid');
      }
      return descriptor;
    }));
    return JSON.stringify(rebuilt) === JSON.stringify(registry);
  } catch {
    return false;
  }
}

export function systemBenchmarkEvaluatorDescriptorFor(
  benchmarkFamily,
  registry = SYSTEM_BENCHMARK_EVALUATOR_REGISTRY,
) {
  if (typeof benchmarkFamily !== 'string' || !IDENTIFIER.test(benchmarkFamily)) return null;
  if (registry === SYSTEM_BENCHMARK_EVALUATOR_REGISTRY) {
    return SYSTEM_BENCHMARK_EVALUATOR_BY_FAMILY.get(benchmarkFamily) || null;
  }
  if (!verifySystemBenchmarkEvaluatorRegistry(registry)) return null;
  return registry.profiles.find((profile) => profile.benchmarkFamily === benchmarkFamily) || null;
}
