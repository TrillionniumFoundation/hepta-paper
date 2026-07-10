# Public API

The package root is the import surface for channel adapters and control plane
code that want to consume `design-production-core`. Package-name imports are
pinned to `src/index.mjs` internally: `package.json` only exposes `.` as
`./src/index.mjs` plus `./package.json` for tooling metadata.

The stable public surface is intentionally small: contracts/schema,
plan/reference routing, execution gates, adapter SDK, and the
receipt/proof/ledger lifecycle. Use those exports instead of importing random
implementation files from `src/`:

```js
import {
  buildPlanOnlyDraft,
  evaluateExecutionGate,
  buildChannelActionManifest,
  buildAdapterRunPreview,
  buildExternalActionLifecycleSchema,
  buildAdapterRunnerSdkContract,
  buildAdapterRunReceipt,
  buildChannelStateProof,
  buildExternalActionLedgerEntry,
} from 'design-production-core';
```

Package consumers should import `design-production-core`, not
`design-production-core/src/*.mjs`. The package export map intentionally blocks
deep `src/` subpaths so local implementation files cannot become a shadow
public API. Inside this repo, implementation scripts may still use relative
imports when they own the local report/gate workflow.
Run `npm run package:surface` after changing `package.json` or `src/index.mjs`
to exercise the actual Node package resolver.
Sibling channel repos are checked separately by `npm run channel:imports`;
channel runtime code should import `design-production-core` from the package
root. Package deep, sibling relative core-src, internal, compatibility, and
unlisted stable imports fail the allowlist.
`npm run package-root:resolver` verifies that ZBJ, EPWK, and Hepta can resolve
`import('design-production-core')` from their runtime roots. `npm run
package-root:migration` proves the real channel tree has zero sibling relative
imports and zero file plans. `npm run package-root:regression` proves a
synthetic bad sibling relative import would be blocked.
`npm run package-root:symbols` then verifies that package-root imports stay as
explicit named imports, and that each imported symbol is listed for that channel
and exported by the package root.
`npm run package-root:symbol-regression` proves synthetic namespace/default,
unlisted, and missing-export imports would be blocked.

`CORE_PUBLIC_MODULES` lists the stable modules. `CORE_COMPATIBILITY_MODULES` is
intentionally empty: the legacy root compatibility bridge has been removed, and
the compatibility policy freeze cap is zero. `compatibility-export-policy` is now
the zero-compatibility invariant that fails if new root compatibility exports are
added; its report summary must keep `zeroCompatibilityInvariant: true`.

The stable public API exports contract, adapter normalization,
the versioned contract JSON Schema snapshot, the compatibility export policy,
the channel import allowlist, the package-root resolver, the package-root import
migration plan, the read-only report chain facade, the report freshness facade,
stable hash utilities, plan/reference/buyer asset
contracts, approval/evidence gates, state and action
manifest contracts, the external action lifecycle schema, adapter SDK, receipt,
proof, and ledger modules. It does not export `selftest.mjs`, sample exporters,
generated reports, or fixture helpers.

`external-action-lifecycle` is the stable facade for channel runner handoff,
receipt, proof, inbox, dispatch, ledger, audit, replay, and lifecycle schema
helpers. New channel code should import lifecycle helpers from that facade
instead of the legacy per-module files. `external-action-lifecycle-schema` is
the canonical versioned map for the external action chain. It names the
minimal, live-entrypoint, standard inbox, dispatch inbox, and dispatch-guarded
profiles so channel code can prove it satisfies the same lifecycle without
copying receipt/proof/inbox/ledger state machine rules.
The facade also exposes `buildPostActionRuntimeStatus` and
`summarizePostActionRuntimeStatus` so downstream code can consume the whole
runtime/post-action matrix closure as one stable summary without importing
internal matrix modules or reading report files directly.

The runner lifecycle modules (`adapter-runner`,
`adapter-runner-capabilities`, `adapter-runner-registry`,
`adapter-handoff-outbox`, `adapter-receipt-inbox`,
`channel-state-proof-inbox`, and `receipt-state-transition-inbox`) are no
longer root compatibility modules. They remain internal implementation files
behind the stable `external-action-lifecycle` facade and `adapter-runner-sdk`.

The dispatch lifecycle modules (`adapter-dispatch-envelope`,
`adapter-dispatch-assignment`, `dispatch-readiness-operator-hints`,
`adapter-dispatch-readiness-report`, `adapter-dispatch-receipt-inbox`,
`adapter-dispatch-channel-state-proof-inbox`, and
`adapter-dispatch-receipt-state-transition-inbox`) are also no longer root
compatibility modules. Dispatch handoff and receipt/proof helpers stay behind
`external-action-lifecycle`; operator hint data is consumed through
`adapter-runner-sdk` reports and the lifecycle schema.

The audit lifecycle modules (`external-action-audit-bundle`,
`external-action-audit-archive`, `external-action-replay-guard`, and
`dispatch-replay-cycle-invariant`) are no longer root compatibility modules
either. They remain part of the stable `external-action-lifecycle` facade.

`read-only-report-chain` is the stable facade for dashboard, closeout, release,
verification, archive, and archive-closeout report-chain metadata. New code that
needs to reason about those reports should import the chain facade or run
`npm run readonly:report-chain` instead of importing the individual read-only
report builders from the root compatibility surface.

The read-only report builder and validator modules remain local implementation
files for the report scripts, but they are no longer root compatibility modules.

`integration-gate-tooling` is the stable facade for local architecture gate
metadata. It keeps `integration-dependency-audit.mjs` CLI-only: the audit can be
run through `npm run audit:integration:strict`, but it is no longer exported
from the root compatibility surface. It also checks the package export map so
the stable package root cannot be bypassed with package deep imports.

`channel-import-allowlist` is the stable facade for local channel import policy.
It checks that ZBJ, EPWK, and Hepta runtime code uses the package root and does
not re-open package deep `src/*`, sibling relative core-src, internal, or
compatibility imports through relative sibling paths. Run `npm run
channel:imports` after changing channel bridges or core public modules.

`package-root-resolver` is the stable facade for local package-name resolver
smoke tests. It checks the workspace link and proves each channel runtime root
can import the stable package root while deep `src/` package imports stay
blocked. Run `npm run package-root:resolver` before attempting a package-root
import rewrite.

`package-root-import-migration` is the stable facade for the report-only audit
that retires sibling relative imports. It consumes the allowlist, package
surface, and package-root resolver reports, and proves the remaining migration
plan is empty without editing channel files. Run `npm run
package-root:migration` after changing channel imports.

`package-root:regression` is a CLI-only local negative fixture for the completed
rewrite. It writes `reports/package-root-import-regression-latest.json` and `reports/package-root-import-regression-latest.md` and
passes only when synthetic sibling relative core-src imports are rejected by the
allowlist and migration reports.

`package-root:symbols` is a CLI-only local manifest for package-root named
imports after the rewrite. It writes
`reports/package-root-symbol-manifest-latest.json` and `reports/package-root-symbol-manifest-latest.md` and blocks namespace
imports, default imports, unlisted channel symbols, and symbols missing from the
package root.

`package-root:symbol-regression` is a CLI-only local negative fixture for the
symbol manifest. It writes `reports/package-root-symbol-regression-latest.json` and `reports/package-root-symbol-regression-latest.md`
and passes only when synthetic namespace, default, unlisted, and missing-export
package-root imports are rejected by `package-root:symbols`.

`package-root:symbol-minimize` is a CLI-only report-only exact-current plan for
the symbol manifest. It writes
`reports/package-root-symbol-minimization-latest.json` and `reports/package-root-symbol-minimization-latest.md` and lists unused
per-channel symbol allowances plus a proposed currently-imported symbol list.
It does not edit channel files or shrink the manifest.

Run the compatibility policy gate after changing `src/index.mjs`:

```bash
npm run compatibility:policy
```

That writes `reports/compatibility-export-policy-latest.json` and `reports/compatibility-export-policy-latest.md`. It fails if
any module is added to `CORE_COMPATIBILITY_MODULES`; the current freeze cap is 0.

## Boundary

The public API is still contract-only. Importing it does not execute adapters,
upload files, submit work, send messages, accept delivery, pay, deploy, fetch
channel state, apply lifecycle state, or grant permission.

Real channel runners must live outside core and re-check current approval,
fresh evidence, channel state, duplicate gates, and current-chat authorization
before doing anything external.
