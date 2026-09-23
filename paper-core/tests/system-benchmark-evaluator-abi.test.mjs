import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  buildSystemBenchmarkArmProtocolSet,
  evaluateSystemBenchmarkArmRawObservation,
} from '../../paper-domain/automation/system-benchmark-arm-protocol.mjs';
import {
  SYSTEM_BENCHMARK_EVALUATOR_DESCRIPTORS,
  SYSTEM_BENCHMARK_EVALUATOR_OPERATORS,
  SYSTEM_BENCHMARK_EVALUATOR_REGISTRY,
  compileSystemBenchmarkEvaluatorRegistry,
  systemBenchmarkEvaluatorDescriptorFor,
  verifySystemBenchmarkEvaluatorRegistry,
} from '../../paper-domain/automation/system-benchmark-evaluator-abi.mjs';
import { independentlyAggregateSystemBenchmarkEvents } from '../../paper-adapters/research-verify/independent-system-benchmark-recomputation.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const COMPATIBLE_PROTOCOL_SET_HASHES = Object.freeze({
  rl_stochastic_control_benchmark: 'sha256:12643be98ab1111c6b1abb6166fcef6a27c9e595a8462902f52ea4b23e49e066',
  ml_algorithm_benchmark: 'sha256:b242d55cce72bb2f33b7fef12b60479d0cdcebfaa884695085e71487d420204f',
  econometrics_panel_benchmark: 'sha256:62f7308debb0ff5f46aab93b962e2ad06b3e06e7b280889c0492b4190e689b82',
  finance_asset_pricing_benchmark: 'sha256:7e6cb431b6ae7928a4ad14ce213193e05b3eefceaa6740b60eb121cd1efe3b2b',
  operations_optimization_benchmark: 'sha256:03193af1ef60675c7971344d96745a51bd1766a980039edf481143748bb2d32e',
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function customDescriptor(overrides = {}) {
  return {
    version: 1,
    kind: 'SystemBenchmarkEvaluatorDescriptor',
    profileId: 'custom-quality-event-metrics-v1',
    benchmarkFamily: 'custom_quality_benchmark',
    armOperations: {
      treatment: 'candidate-quality-system',
      baseline: 'reference-quality-system',
      ablation: 'candidate-without-quality-component',
    },
    oracleFields: ['referenceTarget', 'target'],
    rawEventFields: ['referenceScore', 'score'],
    metrics: [
      { metric: 'mean_score', expression: { operator: 'arithmetic_mean', operands: ['score'] } },
      { metric: 'standard_error', expression: { operator: 'sample_standard_error', operands: ['score'] } },
      { metric: 'baseline_gap', expression: { operator: 'arithmetic_mean_difference', operands: ['score', 'referenceScore'] } },
    ],
    ...overrides,
  };
}

function mlFixture() {
  const selector = buildCampaignBenchmarkSelector({
    benchmarkId: 'ml_algorithm_benchmark',
    datasetMounts: [],
  });
  const protocol = selector.experimentDesign.benchmarkHarness.armProtocolSet.protocols[0];
  return {
    selector,
    protocol,
    document: {
      version: 1,
      kind: 'CampaignBenchmarkCellRawEvents',
      events: [
        { referenceScore: 1, robustnessScore: 1, score: 1 },
        { referenceScore: 0, robustnessScore: 1, score: 0 },
      ],
    },
  };
}

test('compile-time evaluator registry is hash-bound data with a closed operator vocabulary', () => {
  assert.deepEqual(Object.keys(SYSTEM_BENCHMARK_EVALUATOR_OPERATORS).sort(), [
    'arithmetic_mean',
    'arithmetic_mean_difference',
    'sample_standard_error',
  ]);
  assert.equal(SYSTEM_BENCHMARK_EVALUATOR_REGISTRY.profiles.length, 6);
  assert.equal(SYSTEM_BENCHMARK_EVALUATOR_REGISTRY.systemBenchmarkEvaluatorRegistryHash,
    hashRecord('SystemBenchmarkEvaluatorRegistry', {
      version: 1,
      kind: 'SystemBenchmarkEvaluatorRegistry',
      profiles: SYSTEM_BENCHMARK_EVALUATOR_REGISTRY.profiles,
    }));
  for (const profile of SYSTEM_BENCHMARK_EVALUATOR_REGISTRY.profiles) {
    const { systemBenchmarkEvaluatorDescriptorHash, ...payload } = profile;
    assert.equal(systemBenchmarkEvaluatorDescriptorHash,
      hashRecord('SystemBenchmarkEvaluatorDescriptor', payload));
    assert.equal(systemBenchmarkEvaluatorDescriptorFor(profile.benchmarkFamily), profile);
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.oracleFields), true);
    assert.equal(Object.isFrozen(profile.metrics), true);
    assert.equal(profile.metrics.some((metric) => typeof metric.expression.operator !== 'string'), false);
  }
  assert.equal(systemBenchmarkEvaluatorDescriptorFor('unregistered_benchmark'), null);
});

test('strict descriptor compilation adds a data-only profile through a verified immutable registry', () => {
  const extension = customDescriptor();
  const compiled = compileSystemBenchmarkEvaluatorRegistry([
    ...SYSTEM_BENCHMARK_EVALUATOR_DESCRIPTORS,
    extension,
  ]);
  const profile = compiled.profiles.find((item) => item.benchmarkFamily === extension.benchmarkFamily);
  assert.equal(profile.profileId, extension.profileId);
  assert.deepEqual(profile.rawEventFields, extension.rawEventFields);
  assert.deepEqual(profile.metrics.map((metric) => metric.expression.operator), [
    'arithmetic_mean',
    'sample_standard_error',
    'arithmetic_mean_difference',
  ]);
  assert.equal(verifySystemBenchmarkEvaluatorRegistry(compiled), true);
  assert.equal(systemBenchmarkEvaluatorDescriptorFor(extension.benchmarkFamily, compiled), profile,
    'verified registries expose data-only evaluator profiles without callbacks');
  assert.throws(
    () => buildSystemBenchmarkArmProtocolSet({ benchmarkId: extension.benchmarkFamily }),
    /system_benchmark_arm_protocol_unsupported/,
    'an unreviewed runtime descriptor cannot register a production evaluator',
  );
});

test('custom registries remain fail-closed after compilation-time tampering', () => {
  const compiled = compileSystemBenchmarkEvaluatorRegistry([customDescriptor()]);
  const tampered = clone(compiled);
  tampered.profiles[0].rawEventFields[0] = 'forgedScore';
  assert.equal(verifySystemBenchmarkEvaluatorRegistry(tampered), false);
  assert.equal(systemBenchmarkEvaluatorDescriptorFor('custom_quality_benchmark', tampered), null);

  const forgedRegistryHash = clone(compiled);
  forgedRegistryHash.systemBenchmarkEvaluatorRegistryHash = `sha256:${'f'.repeat(64)}`;
  assert.equal(verifySystemBenchmarkEvaluatorRegistry(forgedRegistryHash), false);
  assert.equal(systemBenchmarkEvaluatorDescriptorFor(
    'custom_quality_benchmark',
    forgedRegistryHash,
  ), null);
});

test('descriptor compiler rejects callbacks, shape drift, duplicates, and unknown operators', () => {
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([
      SYSTEM_BENCHMARK_EVALUATOR_DESCRIPTORS[0],
      SYSTEM_BENCHMARK_EVALUATOR_DESCRIPTORS[0],
    ]),
    /system_benchmark_evaluator_registry_family_duplicate/,
  );
  const duplicateProfile = customDescriptor({
    profileId: SYSTEM_BENCHMARK_EVALUATOR_DESCRIPTORS[0].profileId,
  });
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([
      SYSTEM_BENCHMARK_EVALUATOR_DESCRIPTORS[0],
      duplicateProfile,
    ]),
    /system_benchmark_evaluator_registry_profile_duplicate/,
  );

  let callbackInvocations = 0;
  const callback = () => { callbackInvocations += 1; };
  const callbackDescriptor = customDescriptor();
  callbackDescriptor.metrics[0].expression.operator = callback;
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([callbackDescriptor]),
    /system_benchmark_evaluator_descriptor_operator_unknown/,
  );
  assert.equal(callbackInvocations, 0);

  const executableField = customDescriptor();
  executableField.evaluate = callback;
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([executableField]),
    /system_benchmark_evaluator_descriptor_shape_invalid/,
  );
  assert.equal(callbackInvocations, 0);

  const unknownOperator = customDescriptor();
  unknownOperator.metrics[0].expression.operator = 'javascript_callback';
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([unknownOperator]),
    /system_benchmark_evaluator_descriptor_operator_unknown/,
  );
  const inheritedOperator = customDescriptor();
  inheritedOperator.metrics[0].expression.operator = 'constructor';
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([inheritedOperator]),
    /system_benchmark_evaluator_descriptor_operator_unknown/,
  );

  const duplicateField = customDescriptor({ rawEventFields: ['score', 'score'] });
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([duplicateField]),
    /system_benchmark_evaluator_descriptor_event_fields_invalid/,
  );
  const sparseFields = customDescriptor({ rawEventFields: new Array(2) });
  sparseFields.rawEventFields[1] = 'score';
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([sparseFields]),
    /system_benchmark_evaluator_descriptor_event_fields_invalid/,
  );
  const fieldOrderDrift = customDescriptor({ rawEventFields: ['score', 'referenceScore'] });
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([fieldOrderDrift]),
    /system_benchmark_evaluator_descriptor_event_fields_not_canonical/,
  );
  const duplicateOracleField = customDescriptor({ oracleFields: ['target', 'target'] });
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([duplicateOracleField]),
    /system_benchmark_evaluator_descriptor_oracle_fields_invalid/,
  );
  const oracleFieldOrderDrift = customDescriptor({
    oracleFields: ['target', 'referenceTarget'],
  });
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([oracleFieldOrderDrift]),
    /system_benchmark_evaluator_descriptor_oracle_fields_not_canonical/,
  );
  const unknownOperand = customDescriptor();
  unknownOperand.metrics[0].expression.operands = ['unregisteredField'];
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([unknownOperand]),
    /system_benchmark_evaluator_descriptor_operands_invalid/,
  );
  const duplicateMetric = customDescriptor();
  duplicateMetric.metrics[1].metric = duplicateMetric.metrics[0].metric;
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([duplicateMetric]),
    /system_benchmark_evaluator_descriptor_metric_invalid/,
  );
  const armAlias = customDescriptor();
  armAlias.armOperations.ablation = armAlias.armOperations.treatment;
  assert.throws(
    () => compileSystemBenchmarkEvaluatorRegistry([armAlias]),
    /system_benchmark_evaluator_descriptor_arm_operations_invalid/,
  );
});

test('all five v1 evaluator identities and protocol hashes remain byte-compatible', () => {
  for (const [benchmarkId, expectedHash] of Object.entries(COMPATIBLE_PROTOCOL_SET_HASHES)) {
    const protocolSet = buildSystemBenchmarkArmProtocolSet({ benchmarkId });
    assert.equal(protocolSet.systemBenchmarkArmProtocolSetHash, expectedHash, benchmarkId);
    for (const protocol of protocolSet.protocols) {
      assert.equal(protocol.evaluatorId, `repository-owned-${benchmarkId}-event-evaluator-v1`);
      assert.deepEqual(protocol.rawEventFields,
        systemBenchmarkEvaluatorDescriptorFor(benchmarkId).rawEventFields);
    }
  }
  const datasetProtocolSet = buildSystemBenchmarkArmProtocolSet({
    benchmarkId: 'operator-dataset',
    datasetBacked: true,
    benchmarkFamily: 'ml_algorithm_benchmark',
  });
  assert.equal(datasetProtocolSet.systemBenchmarkArmProtocolSetHash,
    'sha256:ae7bf9b9c9727f487dccf14e91e8e0e37202fde3bcf5658ad139d1df05f708a6');
  assert.equal(datasetProtocolSet.protocols[0].evaluatorId,
    'repository-owned-operator-dataset-event-evaluator-v1');
});

test('producer and independent interpreters fail closed on identity, field, and metric-set drift', () => {
  const { selector, protocol, document } = mlFixture();
  const design = selector.experimentDesign;
  const evaluateProducer = (overrides = {}) => evaluateSystemBenchmarkArmRawObservation({
    protocol,
    document,
    requiredMetrics: design.requiredMetrics,
    metricSpecs: design.metricSpecs,
    ...overrides,
  });
  const evaluateIndependent = (overrides = {}) => independentlyAggregateSystemBenchmarkEvents({
    protocol,
    events: document.events,
    requiredMetrics: design.requiredMetrics,
    metricSpecs: design.metricSpecs,
    ...overrides,
  });
  const producer = evaluateProducer();
  const independent = evaluateIndependent();
  assert.equal(producer.status, 'system_benchmark_arm_observation_computed');
  assert.equal(independent.status, 'independent_event_aggregation_verified');
  assert.deepEqual(producer.metrics, {
    mean_score: 0.5,
    standard_error: 0.5,
    baseline_gap: 0,
    robustness_gap: -0.5,
  });
  assert.deepEqual(independent.metrics, producer.metrics);

  const unknownEvaluator = { ...protocol, evaluatorId: 'unregistered-evaluator-v1' };
  assert.ok(evaluateProducer({ protocol: unknownEvaluator }).blockers
    .includes('benchmark_repository_owned_evaluator_unavailable'));
  assert.ok(evaluateIndependent({ protocol: unknownEvaluator }).blockers
    .includes('independent_metric_evaluator_unavailable'));

  const unknownFamily = { ...protocol, benchmarkFamily: 'unregistered_benchmark' };
  assert.ok(evaluateProducer({ protocol: unknownFamily }).blockers
    .includes('benchmark_repository_owned_evaluator_unavailable'));
  assert.ok(evaluateIndependent({ protocol: unknownFamily }).blockers
    .includes('independent_metric_evaluator_unavailable'));

  const fieldDrift = { ...protocol, rawEventFields: ['referenceScore', 'score'] };
  assert.ok(evaluateProducer({ protocol: fieldDrift }).blockers
    .includes('benchmark_evaluator_event_field_set_drift'));
  assert.ok(evaluateIndependent({ protocol: fieldDrift }).blockers
    .includes('independent_evaluator_event_field_set_drift'));

  const eventShapeDrift = clone(document);
  eventShapeDrift.events[0].unexpected = 1;
  assert.ok(evaluateProducer({ document: eventShapeDrift }).blockers
    .includes('benchmark_cell_raw_event_schema_invalid'));
  assert.ok(evaluateIndependent({ events: eventShapeDrift.events }).blockers
    .includes('independent_raw_event_schema_invalid'));

  const missingMetric = design.requiredMetrics.slice(1);
  const missingMetricSpecs = Object.fromEntries(missingMetric.map((metric) => [metric, design.metricSpecs[metric]]));
  assert.ok(evaluateProducer({ requiredMetrics: missingMetric, metricSpecs: missingMetricSpecs }).blockers
    .includes('benchmark_evaluator_metric_set_drift'));
  assert.ok(evaluateIndependent({ requiredMetrics: missingMetric, metricSpecs: missingMetricSpecs }).blockers
    .includes('independent_metric_spec_set_invalid'));

  const addedMetric = [...design.requiredMetrics, 'unexpected_metric'];
  const addedMetricSpecs = {
    ...design.metricSpecs,
    unexpected_metric: { unit: 'ratio', direction: 'maximize', minimum: 0, maximum: 1 },
  };
  assert.ok(evaluateProducer({ requiredMetrics: addedMetric, metricSpecs: addedMetricSpecs }).blockers
    .includes('benchmark_evaluator_metric_set_drift'));
  assert.ok(evaluateIndependent({ requiredMetrics: addedMetric, metricSpecs: addedMetricSpecs }).blockers
    .includes('independent_metric_spec_set_invalid'));
});
