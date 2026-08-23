import {
  runStrictNpmAudit,
} from '../../paper-adapters/runtime/strict-npm-audit-launcher.mjs';

export function runProductionStrictNpmAudit(options) {
  return runStrictNpmAudit(options);
}
