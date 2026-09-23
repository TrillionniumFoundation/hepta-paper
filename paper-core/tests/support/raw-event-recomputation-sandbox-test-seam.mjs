import { registerHooks } from 'node:module';

import {
  withRawEventRecomputationSandboxRunnerForTest,
} from '../test-doubles/raw-event-recomputation-sandbox-runner-factory.mjs';
import {
  withSystemBenchmarkWallClockForTest,
} from '../test-doubles/system-benchmark-wall-clock.mjs';
import {
  createRawEventRecomputationSandboxTestFixture,
} from './raw-event-recomputation-sandbox-fixture.mjs';

const PROCESS_MODULE = new URL(
  '../../../paper-adapters/research-verify/process-isolated-system-benchmark-recomputation.mjs',
  import.meta.url,
);
const HARNESS_MODULE = new URL(
  '../../../paper-adapters/automation/system-benchmark-harness.mjs',
  import.meta.url,
);
const HARNESS_BATCH_VERIFICATION_MODULE = new URL(
  '../../../paper-adapters/automation/system-benchmark-harness-batch-verification.mjs',
  import.meta.url,
);
const MULTI_LANGUAGE_EXECUTOR_MODULE = new URL(
  '../../../paper-adapters/automation/multi-language-empirical-executor.mjs',
  import.meta.url,
);
const SYSTEM_BENCHMARK_EXECUTION_MODULE = new URL(
  '../../../paper-adapters/automation/system-benchmark-empirical-execution.mjs',
  import.meta.url,
);
const TYPED_NUMERIC_PROCESS_MODULE = new URL(
  '../../../paper-adapters/automation/system-benchmark-typed-numeric-process.mjs',
  import.meta.url,
);
const EXPERIMENT_RUN_CONTRACT = new URL(
  '../../../paper-domain/automation/experiment-run-contract.mjs',
  import.meta.url,
);
const EXPERIMENT_IR_EXECUTION_AUTHORITY = new URL(
  '../../../paper-domain/automation/experiment-ir-execution-authority-contract.mjs',
  import.meta.url,
);
const AUTONOMOUS_RESEARCH_RELEASE_BINDING = new URL(
  '../../../paper-domain/automation/autonomous-research-release-binding-contract.mjs',
  import.meta.url,
);
const AUTONOMOUS_RESEARCH_RECURSIVE_RELEASE_CLOSURE = new URL(
  '../../../paper-domain/automation/autonomous-research-recursive-release-closure.mjs',
  import.meta.url,
);
const CAMPAIGN_RELEASE_CONTRACTS = new URL(
  '../../../paper-domain/automation/campaign-release-contracts.mjs',
  import.meta.url,
);
const CAMPAIGN_RELEASE_PROMOTION_CANDIDATE_CONTRACT = new URL(
  '../../../paper-domain/automation/campaign-release-promotion-candidate-contract.mjs',
  import.meta.url,
);
const ANALYSIS_RUN_BINDING = new URL(
  '../../../paper-domain/automation/analysis-protocol-run-binding.mjs',
  import.meta.url,
);
const HARNESS_RECEIPT_VERIFIER = new URL(
  '../../../paper-domain/automation/system-benchmark-harness-execution-receipt-verifier.mjs',
  import.meta.url,
);
const RECEIPT_VERIFICATION_HELPERS = new URL(
  '../../../paper-domain/automation/experiment-run-receipt-verification-helpers.mjs',
  import.meta.url,
);
const EXPERIMENT_REGISTRY = new URL(
  '../../../paper-domain/research/experiment-registry.mjs',
  import.meta.url,
);
const EXPERIMENT_REGISTRY_AUTHORITY = new URL(
  '../../../paper-domain/research/experiment-registry-authority.mjs',
  import.meta.url,
);
const FACTORY_MODULE = new URL(
  '../../../paper-adapters/research-verify/raw-event-recomputation-sandbox-runner-factory.mjs',
  import.meta.url,
);
const FACTORY_DOUBLE = new URL(
  '../test-doubles/raw-event-recomputation-sandbox-runner-factory.mjs',
  import.meta.url,
);
const OS_SANDBOX_RECEIPT_CONTRACT = new URL(
  '../../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs',
  import.meta.url,
);
const OS_SANDBOX_RECEIPT_CONTRACT_DOUBLE = new URL(
  '../test-doubles/raw-event-recomputation-os-sandbox-worker-receipt-contract.mjs',
  import.meta.url,
);
const RECOMPUTATION_HELPER = new URL(
  '../../../paper-adapters/automation/system-benchmark-independent-recomputation-assurance.mjs',
  import.meta.url,
);
const RESULT_REPOSITORY = new URL(
  '../../../paper-adapters/automation/system-benchmark-result-repository.mjs',
  import.meta.url,
);
const WALL_CLOCK_MODULE = new URL(
  '../../../paper-adapters/automation/system-benchmark-wall-clock.mjs',
  import.meta.url,
);
const WALL_CLOCK_DOUBLE = new URL(
  '../test-doubles/system-benchmark-wall-clock.mjs',
  import.meta.url,
);

function testVerificationGraphUrl(moduleUrl) {
  const url = new URL(moduleUrl.href);
  url.searchParams.set('hepta_test_graph', 'raw-event-recomputation-fixture-v1');
  return url;
}

const HARNESS_TEST_MODULE = testVerificationGraphUrl(HARNESS_MODULE);
const HARNESS_BATCH_VERIFICATION_TEST_MODULE = testVerificationGraphUrl(
  HARNESS_BATCH_VERIFICATION_MODULE,
);
const MULTI_LANGUAGE_EXECUTOR_TEST_MODULE = testVerificationGraphUrl(
  MULTI_LANGUAGE_EXECUTOR_MODULE,
);
const SYSTEM_BENCHMARK_EXECUTION_TEST_MODULE = testVerificationGraphUrl(
  SYSTEM_BENCHMARK_EXECUTION_MODULE,
);
const TYPED_NUMERIC_PROCESS_TEST_MODULE = testVerificationGraphUrl(
  TYPED_NUMERIC_PROCESS_MODULE,
);
const EXPERIMENT_RUN_CONTRACT_TEST_MODULE = testVerificationGraphUrl(
  EXPERIMENT_RUN_CONTRACT,
);
const EXPERIMENT_IR_EXECUTION_AUTHORITY_TEST_MODULE = testVerificationGraphUrl(
  EXPERIMENT_IR_EXECUTION_AUTHORITY,
);
const AUTONOMOUS_RESEARCH_RELEASE_BINDING_TEST_MODULE = testVerificationGraphUrl(
  AUTONOMOUS_RESEARCH_RELEASE_BINDING,
);
const AUTONOMOUS_RESEARCH_RECURSIVE_RELEASE_CLOSURE_TEST_MODULE =
  testVerificationGraphUrl(AUTONOMOUS_RESEARCH_RECURSIVE_RELEASE_CLOSURE);
const CAMPAIGN_RELEASE_CONTRACTS_TEST_MODULE = testVerificationGraphUrl(
  CAMPAIGN_RELEASE_CONTRACTS,
);
const CAMPAIGN_RELEASE_PROMOTION_CANDIDATE_CONTRACT_TEST_MODULE =
  testVerificationGraphUrl(CAMPAIGN_RELEASE_PROMOTION_CANDIDATE_CONTRACT);
const ANALYSIS_RUN_BINDING_TEST_MODULE = testVerificationGraphUrl(
  ANALYSIS_RUN_BINDING,
);
const HARNESS_RECEIPT_VERIFIER_TEST_MODULE = testVerificationGraphUrl(
  HARNESS_RECEIPT_VERIFIER,
);
const RECEIPT_VERIFICATION_HELPERS_TEST_MODULE = testVerificationGraphUrl(
  RECEIPT_VERIFICATION_HELPERS,
);
const PROCESS_TEST_MODULE = testVerificationGraphUrl(PROCESS_MODULE);
const RECOMPUTATION_HELPER_TEST_MODULE = testVerificationGraphUrl(
  RECOMPUTATION_HELPER,
);
const RESULT_REPOSITORY_TEST_MODULE = testVerificationGraphUrl(
  RESULT_REPOSITORY,
);
const EXPERIMENT_REGISTRY_TEST_MODULE = testVerificationGraphUrl(
  EXPERIMENT_REGISTRY,
);
const EXPERIMENT_REGISTRY_AUTHORITY_TEST_MODULE = testVerificationGraphUrl(
  EXPERIMENT_REGISTRY_AUTHORITY,
);

const exactTestEdgeRedirects = new Map([
  [[PROCESS_MODULE.href, FACTORY_MODULE.href].join('\n'), FACTORY_DOUBLE.href],
  [[PROCESS_MODULE.href, OS_SANDBOX_RECEIPT_CONTRACT.href].join('\n'),
    OS_SANDBOX_RECEIPT_CONTRACT_DOUBLE.href],
  [[PROCESS_TEST_MODULE.href, FACTORY_MODULE.href].join('\n'), FACTORY_DOUBLE.href],
  [[PROCESS_TEST_MODULE.href, OS_SANDBOX_RECEIPT_CONTRACT.href].join('\n'),
    OS_SANDBOX_RECEIPT_CONTRACT_DOUBLE.href],
  [[HARNESS_TEST_MODULE.href, EXPERIMENT_RUN_CONTRACT.href].join('\n'),
    EXPERIMENT_RUN_CONTRACT_TEST_MODULE.href],
  [[HARNESS_TEST_MODULE.href, ANALYSIS_RUN_BINDING.href].join('\n'),
    ANALYSIS_RUN_BINDING_TEST_MODULE.href],
  [[HARNESS_TEST_MODULE.href, TYPED_NUMERIC_PROCESS_MODULE.href].join('\n'),
    TYPED_NUMERIC_PROCESS_TEST_MODULE.href],
  [[HARNESS_TEST_MODULE.href, RECOMPUTATION_HELPER.href].join('\n'),
    RECOMPUTATION_HELPER_TEST_MODULE.href],
  [[HARNESS_TEST_MODULE.href, RESULT_REPOSITORY.href].join('\n'),
    RESULT_REPOSITORY_TEST_MODULE.href],
  [[HARNESS_TEST_MODULE.href, HARNESS_BATCH_VERIFICATION_MODULE.href].join('\n'),
    HARNESS_BATCH_VERIFICATION_TEST_MODULE.href],
  [[HARNESS_BATCH_VERIFICATION_TEST_MODULE.href,
    OS_SANDBOX_RECEIPT_CONTRACT.href].join('\n'),
  OS_SANDBOX_RECEIPT_CONTRACT_DOUBLE.href],
  [[HARNESS_BATCH_VERIFICATION_TEST_MODULE.href,
    EXPERIMENT_RUN_CONTRACT.href].join('\n'),
  EXPERIMENT_RUN_CONTRACT_TEST_MODULE.href],
  [[RECOMPUTATION_HELPER_TEST_MODULE.href, PROCESS_MODULE.href].join('\n'),
    PROCESS_TEST_MODULE.href],
  [[RECOMPUTATION_HELPER_TEST_MODULE.href, ANALYSIS_RUN_BINDING.href].join('\n'),
    ANALYSIS_RUN_BINDING_TEST_MODULE.href],
  [[EXPERIMENT_RUN_CONTRACT_TEST_MODULE.href, ANALYSIS_RUN_BINDING.href].join('\n'),
    ANALYSIS_RUN_BINDING_TEST_MODULE.href],
  [[EXPERIMENT_RUN_CONTRACT_TEST_MODULE.href, HARNESS_RECEIPT_VERIFIER.href].join('\n'),
    HARNESS_RECEIPT_VERIFIER_TEST_MODULE.href],
  [[EXPERIMENT_RUN_CONTRACT_TEST_MODULE.href, RECEIPT_VERIFICATION_HELPERS.href].join('\n'),
    RECEIPT_VERIFICATION_HELPERS_TEST_MODULE.href],
  [[ANALYSIS_RUN_BINDING_TEST_MODULE.href, OS_SANDBOX_RECEIPT_CONTRACT.href].join('\n'),
    OS_SANDBOX_RECEIPT_CONTRACT_DOUBLE.href],
  [[HARNESS_RECEIPT_VERIFIER_TEST_MODULE.href, ANALYSIS_RUN_BINDING.href].join('\n'),
    ANALYSIS_RUN_BINDING_TEST_MODULE.href],
  [[HARNESS_RECEIPT_VERIFIER_TEST_MODULE.href, OS_SANDBOX_RECEIPT_CONTRACT.href].join('\n'),
    OS_SANDBOX_RECEIPT_CONTRACT_DOUBLE.href],
  [[HARNESS_RECEIPT_VERIFIER_TEST_MODULE.href, RECEIPT_VERIFICATION_HELPERS.href].join('\n'),
    RECEIPT_VERIFICATION_HELPERS_TEST_MODULE.href],
  [[MULTI_LANGUAGE_EXECUTOR_TEST_MODULE.href,
    SYSTEM_BENCHMARK_EXECUTION_MODULE.href].join('\n'),
  SYSTEM_BENCHMARK_EXECUTION_TEST_MODULE.href],
  [[SYSTEM_BENCHMARK_EXECUTION_TEST_MODULE.href, HARNESS_MODULE.href].join('\n'),
    HARNESS_TEST_MODULE.href],
  [[SYSTEM_BENCHMARK_EXECUTION_TEST_MODULE.href, EXPERIMENT_RUN_CONTRACT.href].join('\n'),
    EXPERIMENT_RUN_CONTRACT_TEST_MODULE.href],
  [[EXPERIMENT_REGISTRY_TEST_MODULE.href, EXPERIMENT_RUN_CONTRACT.href].join('\n'),
    EXPERIMENT_RUN_CONTRACT_TEST_MODULE.href],
  [[EXPERIMENT_REGISTRY_TEST_MODULE.href, EXPERIMENT_REGISTRY_AUTHORITY.href].join('\n'),
    EXPERIMENT_REGISTRY_AUTHORITY_TEST_MODULE.href],
  [[EXPERIMENT_REGISTRY_AUTHORITY_TEST_MODULE.href,
    EXPERIMENT_RUN_CONTRACT.href].join('\n'),
  EXPERIMENT_RUN_CONTRACT_TEST_MODULE.href],
  [[EXPERIMENT_IR_EXECUTION_AUTHORITY_TEST_MODULE.href,
    EXPERIMENT_RUN_CONTRACT.href].join('\n'),
  EXPERIMENT_RUN_CONTRACT_TEST_MODULE.href],
  [[AUTONOMOUS_RESEARCH_RELEASE_BINDING_TEST_MODULE.href,
    AUTONOMOUS_RESEARCH_RECURSIVE_RELEASE_CLOSURE.href].join('\n'),
  AUTONOMOUS_RESEARCH_RECURSIVE_RELEASE_CLOSURE_TEST_MODULE.href],
  [[AUTONOMOUS_RESEARCH_RECURSIVE_RELEASE_CLOSURE_TEST_MODULE.href,
    EXPERIMENT_IR_EXECUTION_AUTHORITY.href].join('\n'),
  EXPERIMENT_IR_EXECUTION_AUTHORITY_TEST_MODULE.href],
  [[CAMPAIGN_RELEASE_CONTRACTS_TEST_MODULE.href,
    AUTONOMOUS_RESEARCH_RELEASE_BINDING.href].join('\n'),
  AUTONOMOUS_RESEARCH_RELEASE_BINDING_TEST_MODULE.href],
  [[CAMPAIGN_RELEASE_CONTRACTS_TEST_MODULE.href,
    CAMPAIGN_RELEASE_PROMOTION_CANDIDATE_CONTRACT.href].join('\n'),
  CAMPAIGN_RELEASE_PROMOTION_CANDIDATE_CONTRACT_TEST_MODULE.href],
  [[CAMPAIGN_RELEASE_PROMOTION_CANDIDATE_CONTRACT_TEST_MODULE.href,
    AUTONOMOUS_RESEARCH_RELEASE_BINDING.href].join('\n'),
  AUTONOMOUS_RESEARCH_RELEASE_BINDING_TEST_MODULE.href],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const replacement = exactTestEdgeRedirects.get(
      [context.parentURL, resolved.url].join('\n'),
    );
    if (replacement) {
      return { shortCircuit: true, url: replacement };
    }
    if ([RECOMPUTATION_HELPER.href, RESULT_REPOSITORY.href]
      .includes(context.parentURL?.split('?')[0])
      && resolved.url === WALL_CLOCK_MODULE.href) {
      return { shortCircuit: true, url: WALL_CLOCK_DOUBLE.href };
    }
    return resolved;
  },
});

export {
  withRawEventRecomputationSandboxRunnerForTest,
  withSystemBenchmarkWallClockForTest,
};

export function withRawEventRecomputationSandboxFixtureForTest(
  operation,
  options = {},
) {
  const { nowEpochMs = () => Date.now(), ...runnerOptions } = options;
  return withSystemBenchmarkWallClockForTest(
    nowEpochMs,
    () => withRawEventRecomputationSandboxRunnerForTest(
      createRawEventRecomputationSandboxTestFixture(runnerOptions),
      operation,
    ),
  );
}

export function importSystemBenchmarkHarnessForTest() {
  return import(HARNESS_TEST_MODULE.href);
}

export function importMultiLanguageEmpiricalExecutorForTest() {
  return import(MULTI_LANGUAGE_EXECUTOR_TEST_MODULE.href);
}

export function importAnalysisProtocolRunBindingForTest() {
  return import(ANALYSIS_RUN_BINDING_TEST_MODULE.href);
}

export function importExperimentRunContractForTest() {
  return import(EXPERIMENT_RUN_CONTRACT_TEST_MODULE.href);
}

export function importExperimentRegistryForTest() {
  return import(EXPERIMENT_REGISTRY_TEST_MODULE.href);
}

export function importExperimentRegistryAuthorityForTest() {
  return import(EXPERIMENT_REGISTRY_AUTHORITY_TEST_MODULE.href);
}

export function importExperimentIrExecutionAuthorityForTest() {
  return import(EXPERIMENT_IR_EXECUTION_AUTHORITY_TEST_MODULE.href);
}

export function importAutonomousResearchReleaseBindingForTest() {
  return import(AUTONOMOUS_RESEARCH_RELEASE_BINDING_TEST_MODULE.href);
}

export function importCampaignReleaseContractsForTest() {
  return import(CAMPAIGN_RELEASE_CONTRACTS_TEST_MODULE.href);
}
