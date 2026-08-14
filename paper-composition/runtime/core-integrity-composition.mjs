import {
  buildCoreIntegrityReport,
  writeCoreBaseline,
} from '../../paper-adapters/runtime/core-integrity.mjs';

export function composeCoreIntegrityOperations() {
  return Object.freeze({
    buildCoreIntegrityReport,
    writeCoreBaseline,
  });
}
