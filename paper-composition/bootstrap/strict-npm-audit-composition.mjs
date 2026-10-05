import {
  buildStrictNpmAuditInvocation,
  runStrictNpmAudit,
} from '../../paper-adapters/runtime/strict-npm-audit-launcher.mjs';

export function runProductionStrictNpmAudit(options) {
  return runStrictNpmAudit(options);
}

// Check the existing runtime identities and construct the invocation only.
// This does not execute npm or sanitize the environment of its caller.
export function buildProductionStrictNpmAuditInvocation(options) {
  return buildStrictNpmAuditInvocation(options);
}
