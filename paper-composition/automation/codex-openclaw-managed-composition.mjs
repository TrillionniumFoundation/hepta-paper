import {
  buildOpenClawManagedFailureEvidence,
  codexOpenClawManagedVersion,
  executeCodexOpenClawManaged,
  provisionCodexOpenClawManagedHome,
  verifyCodexOpenClawManagedLogin,
  withCodexOpenClawManagedStdoutIsolation,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';

export function composeCodexOpenClawManagedCommandRuntime() {
  return Object.freeze({
    buildFailureEvidence: buildOpenClawManagedFailureEvidence,
    execute: executeCodexOpenClawManaged,
    provisionHome: provisionCodexOpenClawManagedHome,
    verifyLogin: verifyCodexOpenClawManagedLogin,
    version: codexOpenClawManagedVersion,
    withStdoutIsolation: withCodexOpenClawManagedStdoutIsolation,
  });
}
