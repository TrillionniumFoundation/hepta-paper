import {
  inspectConfiguredDynamicFormalProjectClosureEngine,
} from '../../../paper-adapters/research-verify/dynamic-formal-project-closure-readiness-engine.mjs';
import {
  inspectConfiguredDynamicFormalProjectClosure as
    inspectProductionConfiguredDynamicFormalProjectClosure,
} from '../../../paper-adapters/research-verify/dynamic-formal-project-closure-readiness.mjs';

const SANDBOX_TEST_DEPENDENCY_KEYS = Object.freeze([
  'projectSnapshotRepository',
  'sandboxProbeRunnerFactory',
  'verifySandboxProbeReceipt',
]);

export function inspectConfiguredDynamicFormalProjectClosureForTest(options = {}) {
  const productionOptions = { ...options };
  const sandboxTestDependencies = {};
  for (const key of SANDBOX_TEST_DEPENDENCY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(productionOptions, key)) {
      sandboxTestDependencies[key] = productionOptions[key];
      delete productionOptions[key];
    }
  }
  const selectedTestDependencies = Object.keys(sandboxTestDependencies).length
    ? sandboxTestDependencies : null;
  return inspectConfiguredDynamicFormalProjectClosureEngine(
    productionOptions,
    selectedTestDependencies,
  );
}

export { inspectProductionConfiguredDynamicFormalProjectClosure };
