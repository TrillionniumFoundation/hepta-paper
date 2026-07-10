# Integration Dependency Gate

`src/integration-dependency-gate.mjs` is the local hard gate for
production-core integration work. It writes
`reports/integration-dependency-gate-latest.json` and `reports/integration-dependency-gate-latest.md` and exits non-zero in
strict mode if any step fails.

Run:

```bash
npm run gate:integration:strict
```

The gate currently runs:

- syntax check for `external-action-lifecycle-schema.mjs`
- syntax check for `external-action-lifecycle.mjs`
- syntax check for `contract-schema.mjs`
- syntax check for `compatibility-export-policy.mjs`
- syntax check for `integration-gate-tooling.mjs`
- syntax check for `channel-import-allowlist.mjs`
- syntax check for `package-root-resolver.mjs`
- syntax check for `package-root-import-migration.mjs`
- syntax check for `package-root-import-regression.mjs`
- syntax check for `package-root-symbol-manifest.mjs`
- syntax check for `package-root-symbol-regression.mjs`
- syntax check for `package-root-symbol-minimization.mjs`
- syntax check for `read-only-report-chain.mjs`
- syntax check for `report-freshness.mjs`
- syntax check for `report-freshness-regression.mjs`
- syntax check for `integration-gate-sequence-regression.mjs`
- syntax check for `report-inventory-consistency.mjs`
- syntax check for `report-schema-contract.mjs`
- syntax check for `report-lineage-topology.mjs`
- syntax check for `report-hash-stability-regression.mjs`
- syntax check for `report-output-pairing.mjs`
- syntax check for `report-artifact-reproducibility.mjs`
- syntax check for `report-self-reference-boundary-regression.mjs`
- syntax check for `report-contract-manifest.mjs`
- syntax check for `report-contract-required-coverage-regression.mjs`
- syntax check for `report-contract-doc-coverage-regression.mjs`
- syntax check for `report-contract-syntax-coverage-regression.mjs`
- syntax check for `report-contract-source-derivation-regression.mjs`
- syntax check for `report-contract-summary-key-regression.mjs`
- syntax check for `report-manifest-drift-regression.mjs`
- syntax check for `report-latest-recovery-regression.mjs`
- syntax check for `report-bootstrap-seed-regression.mjs`
- syntax check for `report-gate-clean-rerun-regression.mjs`
- syntax check for `report-clean-gate-idempotence-regression.mjs`
- syntax check for `report-final-settlement-regression.mjs`
- syntax check for `report-post-final-drift-regression.mjs`
- syntax check for `report-closeout-drift-classification-regression.mjs`
- syntax check for `report-closeout-command-inventory-regression.mjs`
- syntax check for `report-runner-contract-regression.mjs`
- syntax check for `prune-reports.mjs`
- syntax check for `report-retention-regression.mjs`
- syntax check for `export-contract-schemas.mjs`
- syntax check for `export-compatibility-policy.mjs`
- syntax check for `export-integration-gate-tooling.mjs`
- syntax check for `export-package-surface.mjs`
- syntax check for `export-channel-import-allowlist.mjs`
- syntax check for `export-package-root-resolver.mjs`
- syntax check for `export-package-root-import-migration.mjs`
- syntax check for `export-package-root-import-regression.mjs`
- syntax check for `export-package-root-symbol-manifest.mjs`
- syntax check for `export-package-root-symbol-regression.mjs`
- syntax check for `export-package-root-symbol-minimization.mjs`
- syntax check for `export-readonly-report-chain.mjs`
- syntax check for `export-report-freshness.mjs`
- syntax check for `export-report-freshness-regression.mjs`
- syntax check for `export-integration-gate-sequence-regression.mjs`
- syntax check for `export-report-inventory-consistency.mjs`
- syntax check for `export-report-schema-contract.mjs`
- syntax check for `export-report-lineage-topology.mjs`
- syntax check for `export-report-hash-stability-regression.mjs`
- syntax check for `export-report-output-pairing.mjs`
- syntax check for `export-report-artifact-reproducibility.mjs`
- syntax check for `export-report-self-reference-boundary-regression.mjs`
- syntax check for `export-report-contract-manifest.mjs`
- syntax check for `export-report-contract-required-coverage-regression.mjs`
- syntax check for `export-report-contract-doc-coverage-regression.mjs`
- syntax check for `export-report-contract-syntax-coverage-regression.mjs`
- syntax check for `export-report-contract-summary-key-regression.mjs`
- syntax check for `export-report-manifest-drift-regression.mjs`
- syntax check for `export-report-latest-recovery-regression.mjs`
- syntax check for `export-report-bootstrap-seed-regression.mjs`
- syntax check for `export-report-gate-clean-rerun-regression.mjs`
- syntax check for `export-report-clean-gate-idempotence-regression.mjs`
- syntax check for `export-report-final-settlement-regression.mjs`
- syntax check for `export-report-post-final-drift-regression.mjs`
- syntax check for `export-report-closeout-drift-classification-regression.mjs`
- syntax check for `export-report-closeout-command-inventory-regression.mjs`
- syntax check for `export-report-bootstrap-seeds.mjs`
- syntax check for `export-report-runner-contract-regression.mjs`
- syntax check for `export-report-retention-regression.mjs`
- syntax check for `selftest-lanes.mjs`
- syntax check for `export-architecture-checkpoint.mjs`
- syntax check for `index.mjs`
- syntax check for `integration-dependency-audit.mjs`
- `src/export-contract-schemas.mjs`
- `src/export-compatibility-policy.mjs --strict`
- `src/export-readonly-report-chain.mjs --strict`
- `src/export-package-surface.mjs --strict`
- `src/export-channel-import-allowlist.mjs --strict`
- `src/export-package-root-resolver.mjs --strict`
- `src/export-package-root-import-migration.mjs --strict`
- `src/export-package-root-import-regression.mjs --strict`
- `src/export-package-root-symbol-manifest.mjs --strict`
- `src/export-package-root-symbol-regression.mjs --strict`
- `src/export-package-root-symbol-minimization.mjs --strict`
- `src/export-report-freshness-regression.mjs --strict`
- `src/export-report-retention-regression.mjs --strict`
- `src/export-integration-gate-sequence-regression.mjs --strict`
- `src/export-report-inventory-consistency.mjs --strict`
- `src/export-report-schema-contract.mjs --strict`
- `src/export-report-lineage-topology.mjs --strict`
- `src/export-report-hash-stability-regression.mjs --strict`
- `src/export-report-output-pairing.mjs --strict`
- `src/export-report-artifact-reproducibility.mjs --strict`
- `src/export-report-self-reference-boundary-regression.mjs --strict`
- `src/export-report-contract-manifest.mjs --strict`
- `src/export-report-contract-required-coverage-regression.mjs --strict`
- `src/export-report-contract-doc-coverage-regression.mjs --strict`
- `src/export-report-contract-syntax-coverage-regression.mjs --strict`
- `src/export-report-contract-source-derivation-regression.mjs --strict`
- `src/export-report-contract-summary-key-regression.mjs --strict`
- `src/export-report-manifest-drift-regression.mjs --strict`
- `src/export-report-latest-recovery-regression.mjs --strict`
- `src/export-report-bootstrap-seed-regression.mjs --strict`
- `src/export-report-gate-clean-rerun-regression.mjs --strict`
- `src/export-report-clean-gate-idempotence-regression.mjs --strict`
- `src/export-report-final-settlement-regression.mjs --strict`
- `src/export-report-post-final-drift-regression.mjs --strict`
- `src/export-report-closeout-drift-classification-regression.mjs --strict`
- `src/export-report-closeout-command-inventory-regression.mjs --strict`
- `src/export-report-runner-contract-regression.mjs --strict`
- `src/export-report-freshness.mjs --strict --skip-gate`
- `src/export-integration-gate-tooling.mjs --strict`
- `src/selftest.mjs`
- `src/selftest-lanes.mjs --strict`
- `src/integration-dependency-audit.mjs --strict`
- `src/export-report-freshness.mjs --strict --skip-gate`

The strict audit is v34. It fails if the public lifecycle schema is missing or
unversioned, if the compatibility export policy, integration gate tooling, or
channel import allowlist / package-root resolver / package-root import
migration / package-root import regression / package-root symbol manifest /
package-root symbol regression / package-root symbol minimization / read-only
report chain / report freshness facade / report freshness regression fixture /
integration gate sequence regression fixture / report inventory consistency
fixture / report schema contract fixture / report lineage topology fixture /
report hash stability regression fixture / report output pairing fixture /
report artifact reproducibility fixture / report self-reference boundary
regression fixture / report contract manifest fixture / report contract required
coverage regression fixture / report contract doc coverage regression fixture /
report contract syntax coverage regression fixture / report contract source
derivation regression fixture / report contract summary key regression fixture /
report manifest drift regression fixture /
report latest recovery regression fixture / report bootstrap seed regression
fixture / report gate clean rerun regression fixture / report clean gate
idempotence regression fixture / report final settlement regression fixture /
report post-final drift regression fixture /
report closeout drift classification regression fixture /
report closeout command inventory regression fixture /
report runner contract regression fixture /
report retention guard / report retention regression
fixture is missing, if report retention / integration gate
scripts are missing, if
`integration-dependency-audit.mjs` is still root exported, if `package.json`
re-opens deep `src/` package subpaths or any extra public package export, if a
channel adds package deep `src/*`, internal, compatibility, or unlisted stable
relative imports, if a sibling relative core-src import appears after the
package-root rewrite, if a package-root import uses a namespace/default import
or a named symbol outside that channel's explicit manifest, if core hardcodes
channel command previews again, or if any live
external entrypoint is not covered by the schema-derived
`live_entrypoint_enforced` phases. It also checks channel-side bridge code for
explicit lifecycle schema validation with the expected profile: ZBJ dispatch
inbox, EPWK standard inbox, and Hepta live entrypoint.

The audit also reports public API migration pressure by classifying channel
imports as stable public, legacy compatibility, or internal. Current channel
bridges should stay stable-only. The root compatibility bridge is now empty, so
any compatibility or internal channel import should be treated as migration debt.

The compatibility policy is a separate hard step. It now enforces a zero
compatibility invariant: `CORE_COMPATIBILITY_MODULES` must remain empty and the
current freeze cap is 0. The generated policy report must also expose
`zeroCompatibilityInvariant: true` so zero entries are treated as intentional,
not missing policy coverage.

The integration gate tooling step verifies that architecture CLI/report
tooling is reachable through package scripts while the audit implementation
stays CLI-only/internal. It also verifies the stable-only package export map.
See `docs/integration-gate-tooling.md`.

The package surface step performs the executable package import smoke test:
package-name root import must resolve to the stable public API, and a deep
`design-production-core/src/index.mjs` package import must be blocked by the
export map.

The channel import allowlist step scans ZBJ, EPWK, and Hepta runtime roots. It
requires channel package-root imports and prevents future package deep, sibling
relative core-src, internal, compatibility, or unlisted stable core imports from
becoming a shadow public API.

The package-root resolver step checks the local workspace package link and runs
Node resolver probes from each channel root. It must pass before channel imports
can be safely rewritten to `design-production-core`.

The package-root import migration step is report-only. It verifies the package
surface and resolver reports are safe; after the rewrite it should report
`migratableRelativeImportCount=0` and `filePlanCount=0`. A failed resolver
report keeps `rewriteReady=false` so package-root rewrites are not attempted
before package linking is fixed.
The audit is package-root aware: named imports from `design-production-core`
are mapped back to stable public modules before checking channel wiring, so a
successful rewrite does not look like a missing runtime dependency.

The package-root import regression step is the negative fixture. It synthesizes
bad sibling relative core-src imports and passes only if the allowlist and
migration reports reject them.

The package-root symbol manifest step scans package-root named imports in the
same channel roots. It passes only when imports are explicit named bindings,
listed for that channel, and exported by the package root.

The package-root symbol regression step is the negative fixture for that
manifest. It synthesizes namespace, default, unlisted, and missing-export
package-root imports, and passes only when the symbol manifest rejects them.

The package-root symbol minimization step is report-only. It compares the
explicit per-channel symbol manifest with current package-root named imports and
reports unused allowed symbols plus an exact-current proposal without editing
channel files or shrinking the manifest.

The read-only report chain is also a separate hard step. It fails if a chain
stage is missing its builder/validator role, if one of its package scripts is
missing, or if a bound latest report is present but not ok.

The report freshness step is the latest-report consistency guard. Inside the
integration gate it runs with `--skip-gate`, so it can validate child reports
while the current gate report is still being written. The architecture
checkpoint refreshes the same guard in final mode and blocks if any latest child
report hash no longer matches the hash recorded by
`integration-dependency-gate-latest.json`.

The report freshness regression step is the negative fixture for that guard. It
synthesizes missing reports, not-ok reports, missing hashes, gate summary hash
drift, missing final gate reports, and gate file hash drift, and passes only if
the expected freshness blockers are observed.

The integration gate sequence regression step is the negative fixture for gate
ordering. It inspects `integration-dependency-gate.mjs`, verifies the
pre-tooling/final child freshness sequence and `--skip-gate` self-reference
break, and passes only if synthetic bad ordering changes produce expected
blockers.

The report inventory consistency step compares the source inventories that bind
latest reports: freshness required reports, tooling report ids, checkpoint
bindings, gate summary hash keys, and package scripts. It passes only if those
inventories stay aligned and synthetic drift scenarios produce expected
blockers.

The report schema contract step reads local latest JSON reports and checks that
each report still exposes stable kind/status/ok/generatedAt/hash/safety/blocker
shape before the freshness guard binds report hashes to the latest integration
gate.

The report latest recovery regression step uses synthetic latest-report
contamination fixtures to prove schema contract, skip-gate freshness, and
integration tooling fail closed before bootstrap recovery, then pass again after
the bootstrap records and final gate hashes line up.

The report lineage topology step inspects the latest-report DAG, package
scripts, gate steps, checkpoint bindings, and gate summary hash keys. It passes
only if dependencies run before consumers, the graph has no cycles, and
synthetic topology drift scenarios produce expected blockers.

The report hash stability regression step reads local latest reports after the
schema contract and lineage topology guards. It proves canonical report hashes
ignore volatile generatedAt/output path/key-order noise while summary, blocker,
and safety semantic changes still affect the hash.

The report output pairing step runs after hash stability and before child
freshness. It proves every indexed latest JSON report has its Markdown pair,
`reports/README.md` lists exact JSON filenames, `reportFiles` pointers stay
aligned when present, and the package/freshness indexes include the guard.

The report artifact reproducibility step runs after output pairing and before
child freshness. It proves stable latest-report artifact digests ignore volatile
metadata, output path, and key-order noise while semantic changes alter the
digest and synthetic gate/checkpoint hash binding drift fails closed.

The report self-reference boundary regression step runs after artifact
reproducibility and before child freshness. It proves artifact reports can
observe stale gate/checkpoint bindings inside the gate without blocking the
current run, required-binding fixtures still fail closed, and final freshness
remains the live gate-summary hash authority.

The report contract manifest step runs after self-reference boundary and before
child freshness. It proves report exporter contracts are owned by one central
manifest instead of a parallel runner list.

The report contract required coverage regression step runs after the contract
manifest and before contract doc coverage. It proves every central manifest
entry is required by default unless it carries an explicit non-empty optional
reason.

The report contract doc coverage regression step runs after contract required
coverage and before syntax coverage. It proves every central manifest entry has
a docs file, README command entry, README docs link, and reports README latest
file listing.

The report contract syntax coverage regression step runs after contract doc
coverage and before source derivation coverage. It proves every central manifest
entry has source/exporter syntax checks before its export runner step.

The report contract source derivation regression step runs after contract syntax
coverage and before summary key coverage. It proves every central manifest entry
derives its source, exporter, docs, report, script, step, and hash fields from
the contract id.

The report contract summary key regression step runs after contract source
derivation coverage and before manifest drift. It proves every central manifest entry is
observable through integration gate, architecture checkpoint, integration audit,
selftest, and selftest-lanes summary/hash/scenario keys.

The report manifest drift regression step runs after contract summary key
coverage and before the latest recovery regressions. It proves each central manifest
entry is wired through package scripts, gate runner steps, tooling report ids,
freshness inventory, checkpoint bindings, gate summary hash keys, and exporter
stdout / latest-file conventions.

The report latest recovery and bootstrap seed regression steps run before the
runner contract regression. They prove contaminated audit/tooling/freshness/
schema/gate latest reports fail closed, the allowlisted bootstrap seed reports
can recover the cycle, and final gate output replaces every seed.

The report gate clean rerun regression step runs after bootstrap seed
regression and before clean gate idempotence regression. It proves a clean
second gate run skips all five seed files, rejects seed marker/hash leaks, and
keeps the bootstrap seed writer conditional rather than forced.

The report clean gate idempotence regression step runs after clean rerun
regression and before final settlement regression. It proves repeated clean gate
snapshots keep stable semantic hashes, skip seeds, and keep gate summary hashes
bound to final latest reports.

The report final settlement regression step runs after clean gate idempotence
regression and before post-final drift regression. It proves final gate,
retention dry-run, final freshness, architecture checkpoint, and clean bootstrap
seed checks stay ordered, and that mapped report writes after the final gate
cannot be silently accepted without refreshing final settlement.

The report post-final drift regression step runs after final settlement
regression and before closeout drift classification. It proves
`audit:integration:strict`, `integration:tooling`, `selftest:lanes`, and
`reports:output-pairing` latest refreshes after final closeout are blocked by
final freshness/checkpoint until a clean gate, final freshness, checkpoint, and
strict zero-seed closeout is rerun.

The report closeout drift classification regression step runs after post-final
drift regression and before runner contract regression. It classifies commands
after final closeout as required clean closeout steps, blocked gate-bound latest
writers, allowed non-gate-bound writers, or read-only probes.

The report closeout command inventory regression step runs after closeout drift
classification and before runner contract regression. It proves package scripts,
docs, exported classification constants, and gate runner steps cannot add
closeout commands outside the classified inventory.

The report runner contract regression step runs after closeout command inventory
and before child freshness. It proves report exporters keep strict package
scripts, strict gate runner args, parseable JSON stdout, hash fields,
reportFiles pointers, gate summary hash keys, and freshness inventory bindings.

The report retention regression step is the negative fixture for report
retention. It synthesizes timestamped reports, protected latest reports,
`README.md`, latest-like but invalid names, and dry-run output, and passes only
if archive candidates and protected files are classified correctly without
moving or deleting real reports.

It is a read-only local gate. It does not call providers, run browser
automation, upload, submit, send messages, pay, apply acceptance, deploy, fetch
channel state, apply local lifecycle state, or grant execution permission.
