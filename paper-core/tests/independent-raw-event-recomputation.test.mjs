import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  buildSystemBenchmarkArmProtocolSet,
  evaluateSystemBenchmarkArmRawObservation,
} from '../../paper-domain/automation/system-benchmark-arm-protocol.mjs';
import {
  buildSystemBenchmarkCellChallenge,
  evaluateSystemBenchmarkCellResponses,
} from '../../paper-domain/automation/system-benchmark-challenge.mjs';
import {
  RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT,
  buildIndependentRawEventRecomputationManifest,
  buildIndependentSystemBenchmarkCellFixture,
  independentlyAggregateSystemBenchmarkEvents,
  independentlyEvaluateSystemBenchmarkCellResponses,
  verifyIndependentFixtureBinding,
} from '../../paper-adapters/research-verify/independent-system-benchmark-recomputation.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const FAMILIES = Object.freeze([
  'ml_algorithm_benchmark',
  'rl_stochastic_control_benchmark',
  'econometrics_panel_benchmark',
  'finance_asset_pricing_benchmark',
  'operations_optimization_benchmark',
]);

function responsesFor(protocol, challenge) {
  return challenge.cases.map((item, index) => ({
    caseId: item.caseId,
    [challenge.responseField]: protocol.arm === 'baseline'
      ? item.referenceResponse
      : Number(((index - 3) / 4).toFixed(4)),
  }));
}

test('independent recomputation import boundary excludes every producer evaluator and aggregator', () => {
  const source = fs.readFileSync(new URL(
    '../../paper-adapters/research-verify/independent-system-benchmark-recomputation.mjs',
    import.meta.url,
  ), 'utf8');
  for (const forbidden of [
    'system-benchmark-challenge.mjs',
    'system-benchmark-arm-protocol.mjs',
    'analysis-protocol-run-binding.mjs',
    'analysis-protocol-evaluator.mjs',
    'analysis-statistics.mjs',
    'system-benchmark-primitive-fixture-resolver.mjs',
  ]) assert.doesNotMatch(source, new RegExp(forbidden.replaceAll('.', '\\.')));
  const descriptorAbiSource = fs.readFileSync(new URL(
    '../../paper-domain/automation/system-benchmark-evaluator-abi.mjs',
    import.meta.url,
  ), 'utf8');
  for (const forbidden of [
    'system-benchmark-arm-protocol.mjs',
    'analysis-statistics.mjs',
    'evaluateSystemBenchmarkArmRawObservation',
  ]) assert.doesNotMatch(descriptorAbiSource, new RegExp(forbidden.replaceAll('.', '\\.')));
  assert.match(source, /system-benchmark-evaluator-abi\.mjs/,
    'independent recomputation may share only the validated data descriptor ABI');
  assert.equal(RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT.producerEvaluatorImportsAllowed, false);
  assert.equal(RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT.fixtureOracleBuilderIndependent, true);
  assert.equal(RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT.responseEventEvaluatorIndependent, true);
  assert.equal(RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT.eventMetricAggregatorIndependent, true);
  assert.equal(RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT.processIndependent, false);
  const { rawEventRecomputationIndependenceContractHash, ...payload } =
    RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT;
  assert.equal(rawEventRecomputationIndependenceContractHash,
    hashRecord('RawEventRecomputationIndependenceContract', payload));
});

test('separate fixture, response, and metric implementations agree with all five producer families', () => {
  for (const benchmarkId of FAMILIES) {
    const selector = buildCampaignBenchmarkSelector({ benchmarkId, datasetMounts: [] });
    const design = selector.experimentDesign;
    for (const protocol of design.benchmarkHarness.armProtocolSet.protocols) {
      const producerFixture = buildSystemBenchmarkCellChallenge({ protocol, seed: 117, repetition: 2 });
      const independentFixture = buildIndependentSystemBenchmarkCellFixture({ protocol, seed: 117, repetition: 2 });
      assert.equal(independentFixture.status, 'independent_fixture_built', benchmarkId);
      assert.deepEqual(independentFixture.challenge, producerFixture.challenge, `${benchmarkId}:${protocol.arm}:challenge`);
      assert.deepEqual(independentFixture.oracle, producerFixture.oracle, `${benchmarkId}:${protocol.arm}:oracle`);
      const responses = responsesFor(protocol, producerFixture.challenge);
      const producerEvents = evaluateSystemBenchmarkCellResponses({
        protocol,
        challenge: producerFixture.challenge,
        oracle: producerFixture.oracle,
        document: {
          version: 1,
          kind: 'CampaignBenchmarkCellResponses',
          systemBenchmarkCellChallengeHash: producerFixture.challenge.systemBenchmarkCellChallengeHash,
          responses,
        },
      });
      const independentEvents = independentlyEvaluateSystemBenchmarkCellResponses({
        protocol,
        challenge: independentFixture.challenge,
        oracle: independentFixture.oracle,
        responses,
      });
      assert.equal(producerEvents.status, 'system_benchmark_cell_response_evaluated', `${benchmarkId}:${protocol.arm}`);
      assert.equal(independentEvents.status, 'independent_response_evaluation_verified', `${benchmarkId}:${protocol.arm}`);
      assert.deepEqual(independentEvents.events, producerEvents.events, `${benchmarkId}:${protocol.arm}:events`);
      const producerMetrics = evaluateSystemBenchmarkArmRawObservation({
        protocol,
        document: { version: 1, kind: 'CampaignBenchmarkCellRawEvents', events: producerEvents.events },
        requiredMetrics: design.requiredMetrics,
        metricSpecs: design.metricSpecs,
      });
      const independentMetrics = independentlyAggregateSystemBenchmarkEvents({
        protocol,
        events: independentEvents.events,
        requiredMetrics: design.requiredMetrics,
        metricSpecs: design.metricSpecs,
      });
      assert.equal(producerMetrics.status, 'system_benchmark_arm_observation_computed', `${benchmarkId}:${protocol.arm}`);
      assert.equal(independentMetrics.status, 'independent_event_aggregation_verified', `${benchmarkId}:${protocol.arm}`);
      assert.deepEqual(independentMetrics.metrics, producerMetrics.metrics, `${benchmarkId}:${protocol.arm}:metrics`);
    }
  }
});

test('signed private fixture source is interpreted without the producer oracle builder', () => {
  const seedSchedule = [11, 23, 37, 41];
  const minimumRepetitions = 8;
  const definition = {
    version: 1,
    kind: 'OperatorAuthorizedDatasetBenchmarkHarness',
    benchmarkId: 'operator-dataset',
    benchmarkFamily: 'ml_algorithm_benchmark',
    seedSchedule,
    minimumRepetitions,
    cells: seedSchedule.flatMap((seed) => Array.from({ length: minimumRepetitions }, (_, index) => ({
      seed,
      repetition: index + 1,
      cases: Array.from({ length: 8 }, (__, caseIndex) => ({
        caseId: hashRecord('IndependentPrivateFixtureCase', { seed, repetition: index + 1, caseIndex }),
        input: { primary: caseIndex / 8, secondary: seed / 100 },
        ablationInput: { secondary: seed / 100 },
        referenceResponse: 0,
        oracle: { label: caseIndex % 2, robustLabel: (caseIndex + 1) % 2 },
      })),
    }))),
  };
  const protocols = buildSystemBenchmarkArmProtocolSet({
    benchmarkId: definition.benchmarkId,
    datasetBacked: true,
    benchmarkFamily: definition.benchmarkFamily,
  });
  for (const protocol of protocols.protocols) {
    const producer = buildSystemBenchmarkCellChallenge({
      protocol,
      seed: seedSchedule[0],
      repetition: 1,
      operatorDatasetHarnessDefinition: definition,
    });
    const independent = buildIndependentSystemBenchmarkCellFixture({
      protocol,
      seed: seedSchedule[0],
      repetition: 1,
      operatorDatasetHarnessDefinition: definition,
    });
    assert.equal(independent.status, 'independent_fixture_built');
    assert.deepEqual(independent.challenge, producer.challenge);
    assert.deepEqual(independent.oracle, producer.oracle);
  }
});

test('oracle and common-mode event-plus-metric tampering stop at independent boundaries', () => {
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: 'ml_algorithm_benchmark', datasetMounts: [] });
  const design = selector.experimentDesign;
  const protocol = design.benchmarkHarness.armProtocolSet.protocols.find((item) => item.arm === 'treatment');
  const fixture = buildIndependentSystemBenchmarkCellFixture({ protocol, seed: 117, repetition: 2 });
  const responses = responsesFor(protocol, fixture.challenge);
  const evaluated = independentlyEvaluateSystemBenchmarkCellResponses({
    protocol,
    challenge: fixture.challenge,
    oracle: fixture.oracle,
    responses,
  });
  assert.equal(evaluated.status, 'independent_response_evaluation_verified');

  const forgedEvents = structuredClone(evaluated.events);
  forgedEvents[0].score = forgedEvents[0].score === 1 ? 0 : 1;
  const forgedMetrics = evaluateSystemBenchmarkArmRawObservation({
    protocol,
    document: { version: 1, kind: 'CampaignBenchmarkCellRawEvents', events: forgedEvents },
    requiredMetrics: design.requiredMetrics,
    metricSpecs: design.metricSpecs,
  });
  assert.equal(forgedMetrics.status, 'system_benchmark_arm_observation_computed');
  assert.notDeepEqual(evaluated.events, forgedEvents,
    'a producer that changes both derived events and aggregates still conflicts with candidate responses');

  const rowDocument = { events: evaluated.events };
  const line = `${JSON.stringify(rowDocument)}\n`;
  const cell = {
    cellId: hashRecord('IndependentAttackCell', { seed: 117 }),
    armProtocol: protocol,
    rawEventArtifactHash: hashBytes(line),
    rawEventCount: evaluated.events.length,
    metrics: forgedMetrics.metrics,
  };
  const manifest = buildIndependentRawEventRecomputationManifest({
    cells: [cell],
    rawEventRows: [{ cellId: cell.cellId, document: rowDocument, line }],
    requiredMetrics: design.requiredMetrics,
    metricSpecs: design.metricSpecs,
  });
  assert.equal(manifest.status, 'raw_event_recomputation_blocked');
  assert.ok(manifest.blockers.includes('independent_metric_residual_nonzero'));

  const oracleAttack = verifyIndependentFixtureBinding({
    protocol,
    seed: 117,
    repetition: 2,
    executedChallenge: fixture.challenge,
    executedOracleHash: `sha256:${'f'.repeat(64)}`,
  });
  assert.equal(oracleAttack.valid, false);
});
