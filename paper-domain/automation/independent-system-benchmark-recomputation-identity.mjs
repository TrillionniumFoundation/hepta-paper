import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  SYSTEM_BENCHMARK_EVALUATOR_REGISTRY,
} from './system-benchmark-evaluator-abi.mjs';

const INDEPENDENCE_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'RawEventRecomputationIndependenceContract',
  level: 'repository-separate-implementation-same-process-v1',
  dataSourceIndependent: true,
  fixtureOracleBuilderIndependent: true,
  responseEventEvaluatorIndependent: true,
  eventMetricAggregatorIndependent: true,
  producerEvaluatorImportsAllowed: false,
  processIndependent: false,
  sharedTrustBase: Object.freeze([
    'sha256-record-identity',
    'scoped-cas-artifact-reader',
    'signed-private-fixture-source-resolver',
  ]),
});

export const RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT = Object.freeze({
  ...INDEPENDENCE_PAYLOAD,
  rawEventRecomputationIndependenceContractHash: hashRecord(
    'RawEventRecomputationIndependenceContract',
    INDEPENDENCE_PAYLOAD,
  ),
});

const IMPLEMENTATION_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'IndependentSystemBenchmarkRecomputationImplementation',
  assuranceScope: RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT.level,
  independenceContractHash:
    RAW_EVENT_RECOMPUTATION_INDEPENDENCE_CONTRACT
      .rawEventRecomputationIndependenceContractHash,
  evaluatorRegistryHash:
    SYSTEM_BENCHMARK_EVALUATOR_REGISTRY.systemBenchmarkEvaluatorRegistryHash,
  producerEvaluatorImportsAllowed: false,
  processIndependent: false,
});

export const INDEPENDENT_SYSTEM_BENCHMARK_RECOMPUTATION_IMPLEMENTATION =
  Object.freeze({
    ...IMPLEMENTATION_PAYLOAD,
    independentSystemBenchmarkRecomputationImplementationHash: hashRecord(
      'IndependentSystemBenchmarkRecomputationImplementation',
      IMPLEMENTATION_PAYLOAD,
    ),
  });
