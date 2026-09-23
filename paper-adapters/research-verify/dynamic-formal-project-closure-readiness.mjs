import {
  assertCurrentDynamicFormalExecutionAuthorityEngine,
  inspectConfiguredDynamicFormalExecutionAuthorityEngine,
  inspectConfiguredDynamicFormalProjectClosureEngine,
} from './dynamic-formal-project-closure-readiness-engine.mjs';

export {
  buildDynamicFormalExecutionAuthority,
  verifyDynamicFormalExecutionAuthority,
} from './dynamic-formal-execution-authority.mjs';

const REMOVED_SANDBOX_DEPENDENCY_KEYS = Object.freeze([
  'projectSnapshotRepository',
  'sandboxProbeRunnerFactory',
  'verifySandboxProbeReceipt',
]);

function rejectSandboxDependencyInjection(options) {
  const forbidden = REMOVED_SANDBOX_DEPENDENCY_KEYS.filter((key) => (
    Object.prototype.hasOwnProperty.call(options, key)
  ));
  if (forbidden.length) {
    throw new Error(`dynamic_formal_sandbox_dependency_injection_forbidden:${forbidden.join(',')}`);
  }
}

export function inspectConfiguredDynamicFormalProjectClosure(options = {}) {
  rejectSandboxDependencyInjection(options);
  return inspectConfiguredDynamicFormalProjectClosureEngine(options);
}

export function inspectConfiguredDynamicFormalExecutionAuthority(options = {}) {
  rejectSandboxDependencyInjection(options);
  return inspectConfiguredDynamicFormalExecutionAuthorityEngine(options);
}

export function assertCurrentDynamicFormalExecutionAuthority(expected, options = {}) {
  rejectSandboxDependencyInjection(options);
  return assertCurrentDynamicFormalExecutionAuthorityEngine(expected, options);
}
