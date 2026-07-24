// Small source-level facades that intentionally preserve an old import path.
// Every row needs an owner and an explicit retirement condition; adding an
// untracked re-export is an architecture failure.
export const COMPATIBILITY_FACADE_CATALOG = Object.freeze([
  Object.freeze({ path: 'paper-application/research/gap-planner.mjs', owner: 'migration-capability-replay', retireAfter: 'migration consumers import paper-domain/research/gap-planner.mjs' }),
  Object.freeze({ path: 'paper-core/src/authority-signatures.mjs', owner: 'paper-core-verification', retireAfter: 'paper-core public module compatibility is versioned or removed' }),
  Object.freeze({ path: 'paper-core/src/batch-summary.mjs', owner: 'paper-core-verification', retireAfter: 'verification consumers import paper-application reporting directly' }),
  Object.freeze({ path: 'paper-core/src/core-integrity.mjs', owner: 'paper-core-verification', retireAfter: 'verification imports adapter owner directly' }),
  Object.freeze({ path: 'paper-core/src/hepta-store.mjs', owner: 'paper-core-cli', retireAfter: 'CLI imports store paths directly' }),
  Object.freeze({ path: 'paper-core/src/paper-batch-runner.mjs', owner: 'migration-entrypoint-compatibility', retireAfter: 'legacy entrypoint parity verification is retired' }),
]);

// These facades are intentionally stable paper-core APIs. They are heavily
// consumed by CLIs and verification entrypoints and are not migration debt.
export const STABLE_PUBLIC_FACADE_CATALOG = Object.freeze([
  Object.freeze({ path: 'paper-core/src/code-provenance.mjs', owner: 'paper-core-runtime-api', apiVersion: 1 }),
  Object.freeze({ path: 'paper-core/src/workspace-layout.mjs', owner: 'paper-core-runtime-api', apiVersion: 1 }),
]);
