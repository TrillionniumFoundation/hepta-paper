import { registerHooks } from 'node:module';

const PROCESS_MODULE = new URL(
  '../../../paper-adapters/research-verify/process-isolated-typed-numeric-oracle-recomputation.mjs',
  import.meta.url,
);
const PROCESS_MODULE_TEST = new URL(PROCESS_MODULE.href);
PROCESS_MODULE_TEST.searchParams.set('hepta_test_graph', 'raw-event-recomputation-fixture-v1');
const PROCESS_CONTRACT = new URL(
  '../../../paper-domain/research/process-isolated-typed-numeric-oracle-recomputation-contract.mjs',
  import.meta.url,
);
const RESOURCE_CONTRACT = new URL(
  '../../../paper-domain/automation/system-benchmark-resource-budget-contract.mjs',
  import.meta.url,
);
const FACTORY_MODULE = new URL(
  '../../../paper-adapters/research-verify/typed-numeric-oracle-sandbox-runner-factory.mjs',
  import.meta.url,
);
const FACTORY_DOUBLE = new URL(
  '../test-doubles/typed-numeric-oracle-sandbox-runner-factory.mjs',
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

const exactTestEdgeRedirects = new Map([
  [[PROCESS_MODULE.href, FACTORY_MODULE.href].join('\n'), FACTORY_DOUBLE.href],
  [[PROCESS_MODULE_TEST.href, FACTORY_MODULE.href].join('\n'), FACTORY_DOUBLE.href],
  [[PROCESS_MODULE.href, OS_SANDBOX_RECEIPT_CONTRACT.href].join('\n'),
    OS_SANDBOX_RECEIPT_CONTRACT_DOUBLE.href],
  [[PROCESS_MODULE_TEST.href, OS_SANDBOX_RECEIPT_CONTRACT.href].join('\n'),
    OS_SANDBOX_RECEIPT_CONTRACT_DOUBLE.href],
  [[PROCESS_CONTRACT.href, OS_SANDBOX_RECEIPT_CONTRACT.href].join('\n'),
    OS_SANDBOX_RECEIPT_CONTRACT_DOUBLE.href],
  [[RESOURCE_CONTRACT.href, OS_SANDBOX_RECEIPT_CONTRACT.href].join('\n'),
    OS_SANDBOX_RECEIPT_CONTRACT_DOUBLE.href],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const replacement = exactTestEdgeRedirects.get(
      [context.parentURL, resolved.url].join('\n'),
    );
    return replacement ? { shortCircuit: true, url: replacement } : resolved;
  },
});

const {
  withTypedNumericOracleSandboxRunnerForTest,
} = await import('../test-doubles/typed-numeric-oracle-sandbox-runner-factory.mjs');
const {
  createRawEventRecomputationSandboxTestFixture,
} = await import('./raw-event-recomputation-sandbox-fixture.mjs');

export { withTypedNumericOracleSandboxRunnerForTest };

export function withTypedNumericOracleSandboxFixtureForTest(operation, options = {}) {
  return withTypedNumericOracleSandboxRunnerForTest(
    createRawEventRecomputationSandboxTestFixture(options),
    operation,
  );
}
