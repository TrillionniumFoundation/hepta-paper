import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  SYSTEM_BENCHMARK_HARNESS_ROOTS,
  SYSTEM_BENCHMARK_HARNESS_TARGETS,
} from '../../workflow-kernel/system-benchmark-harness-implementation-manifest.mjs';

export { SYSTEM_BENCHMARK_HARNESS_ROOTS, SYSTEM_BENCHMARK_HARNESS_TARGETS };

const payload = Object.freeze({
  version: 2,
  kind: 'SystemBenchmarkHarnessImplementationManifest',
  roots: SYSTEM_BENCHMARK_HARNESS_ROOTS,
  targets: SYSTEM_BENCHMARK_HARNESS_TARGETS,
});

export const SYSTEM_BENCHMARK_HARNESS_IMPLEMENTATION = Object.freeze({
  ...payload,
  systemBenchmarkHarnessImplementationHash: hashRecord('SystemBenchmarkHarnessImplementationManifest', payload),
});
