import {
  buildOpenClawManagedFailureEvidence,
  codexOpenClawManagedVersion,
  executeCodexOpenClawManaged,
  provisionCodexOpenClawManagedHome,
  verifyCodexOpenClawManagedLogin,
  withCodexOpenClawManagedStdoutIsolation,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  projectOpenClawManagedFailureCode,
} from '../../paper-adapters/automation/codex-openclaw-managed-failure-code.mjs';

export function composeCodexOpenClawManagedCommandRuntime() {
  return Object.freeze({
    buildFailureEvidence: buildOpenClawManagedFailureEvidence,
    execute: executeCodexOpenClawManaged,
    projectFailureCode: projectOpenClawManagedFailureCode,
    provisionHome: provisionCodexOpenClawManagedHome,
    verifyLogin: verifyCodexOpenClawManagedLogin,
    version: codexOpenClawManagedVersion,
    withStdoutIsolation: withCodexOpenClawManagedStdoutIsolation,
  });
}
