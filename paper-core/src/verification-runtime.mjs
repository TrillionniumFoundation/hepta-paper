import path from 'node:path';
import { defaultPaperRuntimeRoot } from './workspace-layout.mjs';

export function verificationRuntimeStatus() {
  const runtimeRoot = defaultPaperRuntimeRoot();
  const isolated = process.env.HEPTA_PAPER_RUNTIME_ISOLATED === '1';
  const declaredRoot = process.env.HEPTA_PAPER_RUNTIME_ROOT
    ? path.resolve(process.env.HEPTA_PAPER_RUNTIME_ROOT)
    : null;
  return Object.freeze({
    version: 1,
    kind: 'VerificationRuntimeStatus',
    isolated,
    runtimeRoot,
    declaredRoot,
    valid: isolated && declaredRoot === runtimeRoot,
  });
}

export function assertIsolatedVerificationRuntime(label = 'verification command') {
  const status = verificationRuntimeStatus();
  if (!status.valid) {
    throw new Error(`${label} requires HEPTA_PAPER_RUNTIME_ISOLATED=1 and an explicit isolated HEPTA_PAPER_RUNTIME_ROOT`);
  }
  return status;
}
