import { registerHooks } from 'node:module';

import {
  withCanonicalCupyPdePoisson2dSandboxRunnerForTest,
} from '../test-doubles/canonical-cupy-pde-poisson-2d-sandbox-runner-factory.mjs';

const EXECUTOR_MODULE = new URL(
  '../../../paper-adapters/research-verify/canonical-cupy-pde-poisson-2d-executor.mjs',
  import.meta.url,
);
const EXECUTOR_TEST_MODULE = new URL(EXECUTOR_MODULE.href);
EXECUTOR_TEST_MODULE.searchParams.set(
  'hepta_test_graph',
  'canonical-cupy-pde-poisson-2d-fixture-v1',
);
const FACTORY_MODULE = new URL(
  '../../../paper-adapters/research-verify/canonical-cupy-pde-poisson-2d-sandbox-runner-factory.mjs',
  import.meta.url,
);
const FACTORY_DOUBLE = new URL(
  '../test-doubles/canonical-cupy-pde-poisson-2d-sandbox-runner-factory.mjs',
  import.meta.url,
);
const RECEIPT_CONTRACT = new URL(
  '../../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs',
  import.meta.url,
);
const RECEIPT_CONTRACT_DOUBLE = new URL(
  '../test-doubles/canonical-cupy-os-sandbox-worker-receipt-contract.mjs',
  import.meta.url,
);

const redirects = new Map([
  [[EXECUTOR_TEST_MODULE.href, FACTORY_MODULE.href].join('\n'), FACTORY_DOUBLE.href],
  [[EXECUTOR_TEST_MODULE.href, RECEIPT_CONTRACT.href].join('\n'),
    RECEIPT_CONTRACT_DOUBLE.href],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const replacement = redirects.get([context.parentURL, resolved.url].join('\n'));
    return replacement ? { shortCircuit: true, url: replacement } : resolved;
  },
});

export async function importCanonicalCupyPdePoisson2dExecutorForTest() {
  return import(EXECUTOR_TEST_MODULE.href);
}

export { withCanonicalCupyPdePoisson2dSandboxRunnerForTest };
