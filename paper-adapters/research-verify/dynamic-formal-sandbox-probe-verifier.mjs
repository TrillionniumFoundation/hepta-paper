import {
  executeDynamicFormalSandboxProbeEngine,
} from './dynamic-formal-sandbox-probe-verifier-engine.mjs';

const REMOVED_TEST_DEPENDENCY_KEYS = Object.freeze([
  'projectSnapshotRepository',
  'sandboxProbeRunnerFactory',
  'spawnSyncImpl',
  'verifySandboxProbeReceipt',
]);

export function executeDynamicFormalSandboxProbe(options = {}) {
  const forbidden = REMOVED_TEST_DEPENDENCY_KEYS.filter((key) => (
    Object.prototype.hasOwnProperty.call(options, key)
  ));
  if (forbidden.length) {
    throw new Error(`dynamic_formal_sandbox_dependency_injection_forbidden:${forbidden.join(',')}`);
  }
  return executeDynamicFormalSandboxProbeEngine(options);
}
