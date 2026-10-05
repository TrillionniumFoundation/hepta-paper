# Native automation-store operational integrity observation

## Scope and entry

`OrdinaryReadOnlyStoreV1::automation_store_operational_integrity_v1` is the
native typed prerequisite for `inspectAutomationStoreOperationalIntegrity` in
`paper-composition/automation/automation-status-inspection.mjs`. It reads actual
SQLite rows through the existing retained ordinary read-only handle. It does
not accept SQL, callbacks, provider configuration, or mutation capabilities.

`AutomationIntegrityTimeV1::new(unix_ms)` uses the incumbent thirty-minute
no-progress window. `with_no_progress_window(unix_ms, window_ms)` accepts a
nonnegative integral millisecond window. Both times must fit the ECMAScript
Date domain. This bounded native input profile does not emulate arbitrary
JavaScript Date coercion or negative/fractional windows.

The typed report serializes the incumbent's complete operational-integrity
fields: quick-check result, required and observed columns, all nine counts,
query-ready/degraded state, and ordered blockers. Queries preserve SQLite's
existing text-date comparisons and JSON type distinctions. Policy-v0/missing
terminal settlement policy is preserved historical residue, not live debt;
policy-v1 residue and malformed policies remain debt. Missing schema or failed
queries produce null counts and blockers, never fabricated zeros.

## Retained observation and limits

The method uses the handle's original cancellation flag, absolute deadline,
read transaction, and main/WAL/journal/path-currentness checks. It reinstalls
the original SQLite progress handler after success or refusal. Cancellation,
deadline, currentness and native budget failure return errors, not semantic
readiness reports. No database schema or data is repaired or rewritten.

Ordinary WAL coordination remains the existing owner's disclosed effect: it
may prepare missing WAL/SHM leaves, and SQLite may change shared-memory read
marks. This method does not add another connection or change that policy.
Closed DELETE-mode fixtures assert unchanged database bytes and no sidecars.

Additional fixed profile-v1 bounds are 20 million SQLite VM steps, 4096
columns per table and quick-check rows, 64 KiB per selected text cell, and
1 MiB aggregate selected text. These are explicit native safety refusals;
Node does not claim equivalent limits. The ordinary handle's existing file,
SQLite-value and lifetime limits also apply. An OS filesystem call or SQLite's
bounded ten-second busy wait finishes before the next cancellation check.

## Ordinary automation-status remains incomplete

The ordinary Rust `automation-status` CLI still accepts only `--help [--json]`.
This library observer must not be substituted for an automation-readiness
report. It does not call the pure readiness evaluator with invented inputs.

The incumbent parser accepts the boolean flags `help`, `handoff`, `json`,
`live-formal-sandbox-probe`, `live-provider-canary`, `live-release-attestor`,
`require-full-research`, and `require-fully-autonomous`; value flags are
`deployment-environment-file`, `root`, and `runtime-root`. It rejects unknown,
duplicate, missing/empty values, boolean assignments, positional arguments and
`--`. Help is parsed before any observation. Normal output is always JSON;
semantic not-ready exits 2, unexpected infrastructure failures exit 1.

Closing that ordinary route still requires the native observation composition
in `paper-composition/automation/automation-readiness-query.mjs`, including:

- Runtime/image, formal-sandbox and provider probes with endpoint policy and a
  side-effect ledger
- Scoped migration receipts, campaign/node status groups, canonical
  authority-backed qualification pointers and release/capability verification
- Machine intake, resident supervisor/prerequisites, state safety, research
  assurance/experiment/capability scope, and submission-dispatcher readiness
- Optional provider canary, active formal probe/receipt publication, release
  attestor verification, and dependency-handoff composition

The existing native deployment-file loader and pure readiness policy are
separate prerequisites. Neither they nor this store observer establish those
missing observations, full route parity, deployment, or Node retirement.

## Verification and governance delta

With Rust 1.98.0 and Node v22.23.1:

```sh
cd rust
HEPTA_TEST_NODE=/absolute/node-v22.23.1/bin/node \
  cargo test --locked -p hepta-readonly-store --lib automation_integrity:: -- --test-threads=1
```

The actual Node differential covers a real Node-migrated store, nonempty
campaign/lease state, cutoff equality, distinct campaigns, every terminal
policy type, missing schema, malformed JSON, failed quick-check, UTF-16 column
sorting, Date boundaries, and live WAL rows. Negative native fixtures cover
in-flight cancellation/deadline, VM/cell bounds, file replacement and WAL
currentness. Tests use disposable local databases and never probe providers.

Static qualification, accepted parity, TCB/principal assignments, required
check contexts, external authority/package contracts, and production readiness
have no promotion delta. This is an additive diagnostic library API; the
ordinary command, recovery/writer ownership, installation and operator
permissions are unchanged. New source requires the existing exact-head
validation; local fixtures are not production or installed-host evidence.
