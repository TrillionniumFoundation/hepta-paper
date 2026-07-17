# Reference and compatibility boundaries

`core/` is the vendored `design-production-core` reference package. It is not
part of the active hepta-paper runtime. Its accepted bytes are recorded in
`core/CORE_BASELINE.json`; `README.md`, `package.json`, `src/`, `docs/`,
fixtures and source-snapshot metadata below that directory are baseline-bound
and must not be edited as part of paper architecture cleanup.

The root `package.json` records this classification under
`heptaPaper.referencePackages`. Active production code lives under the paper
layers and `workflow-kernel`. The architecture gate requires their reachable
graph to contain no `core/src` module or `design-production-core` import.

Use `npm run reference:integrity`, `npm run reference:selftest`, and
`npm run reference:runtime-dry-run` to verify the reference. Accepting a new
baseline is a deliberate maintenance action via
`npm run reference:baseline:accept`; it is never part of CI or release.
The production batch preview and execute paths neither import the integrity
adapter nor walk the reference tree, and batch reports do not claim a reference
integrity result. Verification and release commands own that evidence.

Hash-bound behavioral compatibility, offline migration support, and retired
path tombstones are listed in `migration/compatibility-support.v1.json`. In particular,
`paper-adapters/referee-revise/decision-routing.mjs` remains at its exact path
because the frozen salvage manifest and differential replay bind it. It is an
explicit compatibility bridge, not a template for new domain logic.
`migration/retirement/*` and the legacy-history translators are offline audit
support and are forbidden from the production reachable graph.

The remaining `workflow_states` projection is exposed only by
`npm run compat:legacy-workflow-projection`. The production batch CLI cannot
load that module statically or dynamically, and package-script reachability
keeps compatibility and experimental modules outside the operator graph.
Legacy stage metrics are likewise computed only by that explicit compatibility
command. Normal inventory, plan and execute reports contain campaign queue
facts and never manufacture retired stage payloads or zero-valued stage status.

Moving, merging, or rewriting a hash-bound or migration-support path requires a
dedicated migration that refreshes its frozen evidence and differential
verification. Paths listed under `retiredCode` must remain absent; their
replacement owner must remain present.
