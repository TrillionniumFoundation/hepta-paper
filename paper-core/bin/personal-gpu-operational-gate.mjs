#!/usr/bin/env node

// Thin executable boundary for the private GPU gate. The orchestration and
// infrastructure bindings live in the verification runner; this file only
// exposes the stable operator path and command-surface API.
export {
  executeGate,
  loadExistingReceipt,
  runPersonalGpuOperationalGateCli,
} from '../verification/personal-gpu-operational-gate-runner.mjs';

import { runPersonalGpuOperationalGateCli } from '../verification/personal-gpu-operational-gate-runner.mjs';

if (process.argv[1] && process.argv[1].endsWith('/personal-gpu-operational-gate.mjs')) {
  runPersonalGpuOperationalGateCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
