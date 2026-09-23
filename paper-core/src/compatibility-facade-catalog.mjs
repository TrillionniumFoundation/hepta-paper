// Small source-level facades that intentionally preserve an old import path.
// Every row needs an owner and an explicit retirement condition; adding an
// untracked re-export is an architecture failure.
export const COMPATIBILITY_FACADE_CATALOG = Object.freeze([
  Object.freeze({ path: 'paper-core/src/paper-batch-runner.mjs', owner: 'migration-entrypoint-compatibility', retireAfter: 'legacy entrypoint parity verification is retired' }),
]);

// These facades are intentionally stable paper-core APIs. They are heavily
// consumed by CLIs and verification entrypoints and are not migration debt.
export const STABLE_PUBLIC_FACADE_CATALOG = Object.freeze([
  Object.freeze({ path: 'paper-core/src/code-provenance.mjs', owner: 'paper-core-runtime-api', apiVersion: 1 }),
  Object.freeze({ path: 'paper-core/src/workspace-layout.mjs', owner: 'paper-core-runtime-api', apiVersion: 1 }),
]);
