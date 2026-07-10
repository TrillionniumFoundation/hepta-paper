# Integration Gate Tooling

`src/integration-gate-tooling.mjs` is the stable public facade for local
architecture gate metadata. It does not import or expose the audit
implementation. Instead it verifies that CLI-only gate modules are invoked
through package scripts and that the latest reports required by the architecture
checkpoint are present and ok. It also verifies that `package.json` exposes only
the stable package root and package metadata, so package consumers cannot bypass
`src/index.mjs` with deep `src/` package imports. The companion channel import
allowlist report closes the sibling-path bypass by checking ZBJ, EPWK, and
Hepta relative imports.
The package-root resolver report proves the package name works from those
channel roots. The package-root import migration report proves the real channel
tree has zero remaining relative imports and file plans, and the package-root
regression fixture proves synthetic sibling `src/*.mjs` imports are rejected.
The package-root symbol manifest then checks the named symbols each channel
imports from `design-production-core`, so package-root imports cannot become an
unbounded namespace. The package-root symbol regression fixture proves
namespace/default/unlisted/missing-export package-root imports are rejected.
The package-root symbol minimization report then compares the explicit manifest
with current real imports and produces a report-only exact-current shrink plan.
The report freshness guard then verifies that latest reports are present, ok,
hashable, and, in final checkpoint mode, still match the hashes recorded by the
latest integration gate. The report freshness regression fixture proves those
freshness blocker codes with synthetic bad latest-report states.
Tooling and strict integration audit now use the same semantic latest-report
hash binding as freshness: report-specific aliases are required, and a generic
top-level `hash` cannot substitute for stripped aliases or upstream matrix
hashes.
The integration gate sequence regression fixture proves the gate's child
freshness and tooling/audit ordering from source inspection plus synthetic bad
step permutations.
The report inventory consistency fixture proves the freshness, tooling,
checkpoint, gate-summary hash key, and package-script inventories cannot drift
apart silently.
The report schema contract guard proves latest JSON reports keep stable `kind`,
`status`, `ok`, `generatedAt`, hash, safety, and blocker shapes before freshness
hash binding relies on them.
The report lineage topology guard proves the latest-report DAG, gate step
ordering, package scripts, checkpoint bindings, and gate summary hash keys stay
connected before freshness and checkpoint trust the latest reports.
The report hash stability regression fixture proves canonical latest-report
hashes are stable across generatedAt/output path/key-order noise while semantic
summary, blocker, and safety changes still alter the hash.
The report output pairing fixture proves latest JSON/Markdown report files,
README entries, package scripts, and freshness inventory stay aligned.
The report artifact reproducibility guard proves latest-report artifact digests
stay stable across volatile metadata, output path, and key-order noise while
semantic report changes alter the digest and synthetic gate/checkpoint hash
binding drift fails closed.
The report self-reference boundary regression guard proves mid-gate reports may
observe stale gate/checkpoint bindings without failing, while required-binding
fixtures and final freshness still fail closed on real drift.
The report manifest drift regression guard proves each central report contract
stays wired through package scripts, gate steps, tooling report ids, freshness
inventory, checkpoint bindings, gate summary hash keys, and exporter stdout /
latest-file conventions.
The report latest recovery regression guard proves blocked latest reports in
the audit/tooling/freshness/schema/gate cycle fail closed, bootstrap seeds
recover schema/freshness/tooling, and final freshness only passes when recovered
hashes match the gate summary.
The report bootstrap seed and gate clean rerun regression guards prove seeds
stay allowlisted and synthetic, final reports overwrite seed hashes, and clean
reruns skip all five seed files without leaking seed metadata.
The report retention regression fixture proves that report pruning keeps
`*-latest.{json,md}` and `README.md` while only timestamped or invalid
latest-like report files become archive candidates.

Run:

```bash
npm run integration:tooling
```

The exporter writes `reports/integration-gate-tooling-latest.json` and `reports/integration-gate-tooling-latest.md`. It
checks:

- `integration-gate-tooling` is in `CORE_PUBLIC_MODULES`
- `integration-dependency-audit` is not in `CORE_COMPATIBILITY_MODULES`
- `src/index.mjs` does not root-export `integration-dependency-audit.mjs`
- `package.json` exports `.` to `./src/index.mjs`, exports `./package.json`,
  and does not expose `./src/*` or extra public subpaths
- required local scripts exist: audit, gate, checkpoint, compatibility policy,
  package surface, channel import allowlist, package-root resolver,
  package-root import migration, package-root import regression, package-root
  symbol manifest, package-root symbol regression, read-only report chain,
  package-root symbol minimization, report freshness, report freshness
  regression, integration gate sequence regression, report inventory
  consistency, report schema contract, report lineage topology, report hash
  stability regression, report output pairing, report artifact reproducibility,
  report self-reference boundary regression, report contract manifest, report
  manifest drift regression, report latest recovery regression, report
  bootstrap seed regression, report gate clean rerun regression, runner
  contract regression, report retention regression,
  schemas, selftest lanes,
  and report retention
- latest lower-level architecture reports exist and are ok; the top-level
  integration gate and architecture checkpoint consume this tooling report
  rather than being inputs to it

The `package-surface-latest` report is an executable smoke check: it imports the
package root by name and verifies a deep `src/` package import fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

The `channel-import-allowlist-latest` report is the sibling-repo import check:
it allows package-root imports for each channel and blocks package deep `src/*`,
sibling relative core-src, internal, compatibility, or unlisted stable imports.

The `package-root-resolver-latest` report is the executable channel resolver
check: it verifies the workspace package link and confirms ZBJ, EPWK, and Hepta
can import `design-production-core` while deep `src/` package imports remain
blocked.

The `package-root-import-migration-latest` report is the report-only migration
audit for replacing stable sibling relative imports with `design-production-core`
package root imports. It must stay ok with no remaining file plans before the
checkpoint can claim a clear path away from sibling `src/*.mjs` imports.

The `package-root-import-regression-latest` report is the synthetic negative
fixture: it intentionally creates bad sibling relative imports and passes only
when the allowlist and migration reports reject them.

The `package-root-symbol-manifest-latest` report is the named import manifest:
it scans package-root imports for ZBJ, EPWK, and Hepta, blocks namespace/default
imports, blocks symbols outside that channel's explicit list, and blocks symbols
that are not exported by the package root.

The `package-root-symbol-regression-latest` report is the synthetic negative
fixture for the symbol manifest. It passes only when the manifest rejects
namespace imports, default imports, unlisted symbols, and missing package-root
exports.

The `package-root-symbol-minimization-latest` report is the report-only
exact-current plan for the symbol manifest. It lists unused allowed symbols and
the proposed per-channel symbol list that matches current real imports without
editing channel files or shrinking the manifest.

The `report-freshness-latest` report is the latest-report consistency guard.
During the integration gate it runs in `--skip-gate` mode to avoid a
self-reference cycle. The architecture checkpoint refreshes it in final mode,
including `integration-dependency-gate-latest.json`, so stale child report hashes
become checkpoint blockers.

The `report-freshness-regression-latest` report is the synthetic negative
fixture for report freshness. It passes only when missing reports, not-ok
reports, missing hashes, gate summary hash drift, missing final gate reports,
and gate file hash drift all produce the expected blocker codes.

The `integration-gate-sequence-regression-latest` report is the synthetic
negative fixture for the integration gate order. It inspects
`integration-dependency-gate.mjs`, checks the child freshness self-reference
break, and passes only when bad step order and missing `--skip-gate` scenarios
produce expected blockers.

The `report-inventory-consistency-latest` report is the synthetic negative
fixture for latest-report inventory. It passes only when the actual freshness
required reports, tooling report inputs, architecture checkpoint bindings, gate
summary hash keys, and required package scripts line up, and when synthetic
missing/extra/duplicate/drift scenarios produce expected blockers.

The `report-schema-contract-latest` report is the latest-report schema guard.
It reads local latest JSON reports and passes only when each report exposes a
stable kind/status/ok/generatedAt/hash/safety/blocker shape. Its synthetic bad
states prove missing reports, malformed reports, missing hashes, hash alias
drift, unsafe external safety flags, and malformed blockers fail closed.

The `report-lineage-topology-latest` report is the latest-report DAG guard. It
inspects local source and package metadata, then passes only when lineage nodes,
dependencies, gate steps, package scripts, checkpoint bindings, and gate summary
hash keys line up. Its synthetic bad states prove missing dependencies, wrong
order, cycles, missing gate steps, missing scripts, missing checkpoint bindings,
and missing hash keys fail closed.

The `report-hash-stability-regression-latest` report is the latest-report hash
stability guard. It reads local latest JSON reports after schema/topology
guards and passes only when each report exposes a stable sha256 report hash.
Its synthetic bad states prove generatedAt/output path/key-order noise does not
change canonical hashes, while summary, blocker, and safety changes do.

The `report-output-pairing-latest` report is the latest-report output index
guard. It reads local latest JSON/Markdown files, `reports/README.md`, package
scripts, and freshness inventory, then passes only when each indexed latest JSON
has a Markdown pair, exact README entry, aligned `reportFiles` pointers when
present, and package/freshness coverage.

The `report-artifact-reproducibility-latest` report is the latest-report
artifact reproducibility guard. It reads local latest JSON reports, integration
gate summary hashes, and architecture checkpoint report bindings, then passes
only when reproducible artifact digests stay stable across volatile metadata and
the synthetic semantic/binding-drift scenarios fail closed.

The `report-self-reference-boundary-regression-latest` report is the
gate/freshness self-reference boundary guard. It inspects local source and uses
synthetic stale-hash fixtures, then passes only when mid-gate artifact reports
can observe stale bindings without failing, required-binding scenarios fail
closed, child freshness keeps `--skip-gate`, and final freshness remains the
owner of live gate summary hash drift.

The `report-contract-manifest-latest` report is the report exporter contract
manifest guard. It inspects the central manifest and runner source, then passes
only when required exporter contracts, latest JSON ids, hash fields, gate
summary hash keys, and gate step ids are unique and the runner aliases the
manifest instead of keeping a parallel list.

The `report-manifest-drift-regression-latest` report is the report manifest
drift guard. It inspects the central manifest, package scripts, integration
gate source, tooling metadata, freshness inventory, checkpoint bindings, and
exporter sources, then passes only when each manifest entry remains wired across
the runner/gate/freshness/checkpoint chain.

The `report-latest-recovery-regression-latest` report is the latest-report
recovery guard. It uses synthetic fixtures to prove contaminated latest reports
fail schema/freshness/tooling closed, bootstrap seeds restore those checks, and
final freshness remains bound to the recovered gate summary hashes.

The `report-bootstrap-seed-regression-latest` report is the bootstrap seed
guard. It proves only the allowlisted cycle-breaker reports may receive local
seed reports and that final reports overwrite seed hashes without retaining
bootstrap metadata.

The `report-gate-clean-rerun-regression-latest` report is the clean rerun
guard. It proves a clean second gate run skips the bootstrap seed writer for
all five allowlisted reports and that no seed markers or hashes leak into final
reports or gate summary bindings.

The `report-clean-gate-idempotence-regression-latest` report is the clean gate
idempotence guard. It proves repeated clean gate snapshots keep stable semantic
hashes, skip all bootstrap seeds, and keep gate summary hashes bound to final
latest reports before runner contract validation.

The `report-contract-syntax-coverage-regression-latest` report is the manifest
syntax coverage guard. It proves each report contract has source and exporter
syntax checks before its gate export step.

The `report-contract-source-derivation-regression-latest` report is the
manifest derivation guard. It proves each report contract derives its source,
exporter, docs, report, script, step, and hash fields from the contract id
before summary-key validation.

The `report-runner-contract-regression-latest` report is the report exporter
runner contract guard. It inspects package scripts, integration gate runner
steps, freshness inventory, gate summary hash keys, and exporter sources, then
passes only when strict args, parseable JSON stdout, hash fields, reportFiles
pointers, and latest JSON/Markdown writes stay aligned.

The `report-retention-regression-latest` report is the synthetic negative
fixture for report retention. It passes only when timestamped reports are
archive candidates, latest JSON/Markdown reports and `README.md` are protected,
latest-like invalid names are not protected, and dry-run output reports
candidates without file mutation.

`integration-dependency-audit.mjs` remains executable as a direct CLI/report
tool:

```bash
npm run audit:integration:strict
```

It should not be imported from the root public API. Channel runtimes should only
consume stable contract, lifecycle, and adapter SDK surfaces.

## Boundary

This is local metadata only. It does not call providers, run browser
automation, upload, submit, send messages, pay, accept delivery, deploy, fetch
channel state, mutate lifecycle state, or grant execution permission.
