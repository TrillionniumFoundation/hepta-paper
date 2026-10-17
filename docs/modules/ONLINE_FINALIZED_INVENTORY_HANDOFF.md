# Actual ten-database finalized-chain inspection

## Source and implemented boundary

The original activation adapter in `paper-adapters/automation/autonomous-research-online-runtime-activation.mjs` inspects the finalized head of each registered database and binds each result to the active refresh's global sequence and hash. `online_runtime_activation/finalized_inventory.rs` composes the existing native per-database inspector over an actual opaque ten-role inventory, an actual complete source proof, and the existing opaque signed active-authority observation.

The constructor validates the closed inventory and manifest binding before any additional authority call. Each database is copied through the inventory's guarded private-snapshot API; SQLite opens that private copy read-only, with zero busy timeout, trusted schema disabled and query-only enabled. The original live database is never passed to SQLite by this composition. Each call verifies the full local finalized chain using the existing inspector and an independent fresh signed current-head request. All ten observations must agree with the active evidence's global head and its complete database-head vector. Checking the whole vector is a native tightening beyond the original activation loop's per-database/global comparison.

## Retained proof and lifetime

`VerifiedFinalizedInventoryV1` has private fields, no JSON constructor or deserializer and no mutation/coordinator accessor. The aggregate report is diagnostic and retains `runtimeReady: false`; individual receipts keep the original Node contract. The object retains its original runtime root, inventory hash, active-evidence hash, static proof hash, authority configuration hash and all ten actual inspection results.

Before return and each subsequent `assert_current`, it checks the actual inventory and original source/authority dependencies again. All signed active and finalized-head age/expiry windows are checked in memory after the last I/O. Nested clock observations are monotonic. The object retains its largest observed time across calls, including a time observed during a check that later fails, so expiry followed by clock rollback cannot revive the same proof. This uses an interior `Cell`; the value is not a cross-thread synchronization primitive.

The supplied clock and transport are trusted in-process dependencies, and transport responses remain untrusted until verified. The clock is expected to observe time without changing the inspected inputs. This is a sequence of actual observations, not an atomic global filesystem snapshot or a future lease. A deployment composition must own its real clock and process pins and recheck all required dependencies at its action boundary. This module does not complete startup repair, schema installation, state-safety/restore qualification, cache publication, or Active construction.

## Differential and hostile validation

The new integration target provisions the original ten-file SQLite fixture, copies and scans the original complete writer source tree, performs a real signed three-observation refresh and then ten real signed finalized-head requests. Its Node oracle runs the unchanged per-database inspector on the isolated original files with the exact native nonce and original cryptographic contract verification; every complete individual receipt must match. The aggregate itself is a native composition document, not an invented incumbent receipt format.

Tests also exercise late global-head divergence, a bad middle signature, inconsistent other-database heads, final-I/O expiry, clock rollback, post-expiry rollback, source namespace drift and actual business-row drift. Revalidation invokes no authority transport. The final integrated component run passed the five existing/extended per-database groups in 10.29 seconds and the aggregate integration group in 304.50 seconds. Production strict Clippy, both test targets, formatting, the no-deserialization compile-fail documentation test and oracle ESLint all passed. Logs are `/tmp/hepta-seventh-finalized-final-{tests,strict,targets,doc,eslint,fmt}.log`; the combined exit file is zero. These are component results; whole-project integration and independent command acceptance are tracked separately.

## Zero-head genesis binding

The per-database inspector additionally requires the metadata genesis global hash to equal the signed current global hash when the current global sequence is zero. A real signed counterexample is accepted by the original Node inspector and refused by Rust; this is an intentional native consistency strengthening. At a later nonzero global sequence, the current global hash is not a substitute for historical signed genesis evidence. That history remains bound through schema-installation/readiness and recovery evidence at the complete activation boundary.
