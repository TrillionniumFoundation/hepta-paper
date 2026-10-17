# Concrete recoverability action fence: source audit and narrow native slice

This integrated slice does not expose Active, publish an activation receipt, or authorize any business action. Sixth-batch actual source remains frozen.

## Original consumer chain

The checked checkout has no function named `createOnlineMutationRuntime`. The actual activation boundary is `composeAutonomousResearchOnlineMutationRuntimeActivation` in `paper-composition/bootstrap/autonomous-research-online-mutation-composition.mjs`, calling `activateAutonomousResearchOnlineMutationRuntime` in `paper-adapters/automation/autonomous-research-online-runtime-activation.mjs`.

`paper-composition/automation/autonomous-research-supervisor-prerequisites.mjs` composes a backup service, observes inventory/stored restore sources, builds one recoverability controller, passes the same controller as the coordinator's recoverability fence, performs active activation, marks its final head, and passes the activated components to state-safety inspection. Its initial JSON restore-head shortcut and final JSON readiness checks are not native capability constructors.

The image-specific consumer is `paper-composition/automation/autonomous-research-supervisor-runtime-composition.mjs` → `runtime-image-reproducibility-composition.mjs` → `runtime-image-reproducibility-receipt-repository.mjs`. It passes the activated coordinator, verifies the actual receipt, executes the fixed publication operation, requires signed finalization/side-effect permit, and then publishes the mirror. This path adds no implicit controller-current call of its own.

Activation requires actual schema/inventory, per-database startup recovery, a fresh global authority challenge, per-database finalized-chain inspection against the same global head, real source/static safety observations, signed evidence-cache publication, and current inventory after publication. Parent owns the opaque ten-database finalized-head aggregate; this slice does not replace it.

The Node and Rust SQLite coordinator use `RecoverabilityEpochFenceV1` for finalized/reconciliation feedback. Neither implicitly invokes `assertCurrent` before every SQL operation. Actual external action consumers call the controller separately, e.g. `paper-composition/automation/autonomous-research-campaign-external-side-effect-composition.mjs`: pre-begin reconciliation; begin/current checks; reconciliation after recorded progress; current checks before the independent side-effect permit. Adding blanket per-SQL epoch gating would change these semantics.

## Native dependency map

| Existing native source | Concrete evidence / remaining boundary |
| --- | --- |
| `state_recoverability/controller.rs` | Private ready state requires actual restore source, actual inventory and effective row proof, signed fresh authority head, real resident lease. Starts unverified. Existing permit projection has no origin/generation revalidation API. |
| `state_recoverability/service.rs` | Pinned backup and online public trust; actual backup/drill/reconciliation; private source and full current-state replay proof. |
| `state_recoverability/resident.rs` | Re-reads held actual SQLite lease; owner/token/generation/expiry must agree. Claims alone cannot create observation. |
| `state_recoverability/observation.rs` | Signed head tied to selected opaque source and authority configuration; expiry, age and highwater validity. |
| `sqlite_mutation_coordinator/execution.rs` | Open trait accepts arbitrary implementations and diagnostic `Value`; unsuitable as the constructor input for future high-level Active proof. Real coordinator still enforces its independent signed mutation protocol. |
| `online_mutation_composition.rs` | Fixed complete plans and held configuration; private read-only wrapper with no extraction or write route. |
| `online_runtime_activation.rs` | Contracts/refresh/database inspection exist; no complete native Active composition constructor. |
| `runtime_image_reproducibility/online_publication.rs` | Private activated-publication fields and no public constructor. Must remain unavailable until real activation dependencies are joined. |

## Proposed and isolated implementation

`controller/fence.rs` owns one concrete `StateRecoverabilityControllerV1` in a private `Rc<RefCell<_>>`. Clones share the controller and can supply existing low-level coordinator feedback while the owner retains real reconciliation access. No controller getter, mutation-coordinator getter, `Deref`, JSON deserialization or caller ready-state constructor exists.

`VerifiedRecoverabilityActionV1` retains private origin and generation allocation identities and the already verified permit. `observe_action` creates it only after the actual controller check. `assert_action_current` requires the same originating controller, current generation, exact action and unchanged verified head, then repeats real evidence checks. Reconciliation attempts, finalization/reconciliation feedback, and failed observation revoke prior tokens, including same-head reconciliation. Token allocations remain alive while referenced, avoiding generation overflow and allocation-address reuse. Reentrant access returns a closed error rather than panicking or exposing mutable state.

The fixed observation sequence is: existing controller action check; source/live-inventory/resident and backup configuration/command/key revalidation; online public trust/key revalidation; signed head/source binding revalidation; final clock sample on the same controller highwater; pure in-memory resident expiry, authority head expiry/age, and exact stored-drill 24-hour age checks. Generic transports' internal process state is outside this public-trust check; process transports recheck their own pins on invoke. The checks make no new RPC. They retain the previously authenticated head observation only within its signed expiry and configured age window; they do not claim that an authority head cannot advance concurrently without a new challenge.

These are explicit observation boundaries, not a distributed filesystem lock. No finite repetition can defeat an arbitrary malicious in-process clock that writes after each check. A future production composition must own the real system clock and pinned process transports. The token proves an observation of its own controller only; it does not independently bind an arbitrary external publication runtime supplied by a caller. Production activation must build/own the controller from its own selected runtime and authority scope, rather than comparing diagnostic global-head values across unrelated handles. Caller-supplied clocks remain a lower-level testability contract, never a way to mint Active from a boolean. The last clock is after all I/O so later I/O cannot silently consume unmeasured lease or receipt validity.

## Remaining implementation work outside this slice

1. Opaque all-database finalized-head aggregate (parent's parallel slice).
2. Complete startup recovery, active challenge/static/schema/restore binding and signed cache publication joined under final currentness checks.
3. Concrete process configuration and owned same-runtime/same-scope controller and real-clock construction for production activation; passive diagnostics and arbitrary low-level trait objects must never be promoted.
4. Real activated coordinator / runtime-image publication constructors accepting only that completed activation proof.
5. Application-specific external side-effect consumers that use exact action proofs alongside independent business authorization and side-effect permits.
6. This slice is single-threaded, matching existing non-Send clocks/transports; it does not claim a thread-safe or cross-process epoch lock.

## Tests

Pending: real original Node ten-database fixture, actual Ed25519 protocol signatures using fixture-only keys, actual native backup/drill/reconcile, origin/action/generation mismatch, shared coordinator feedback, zero-RPC action revalidation, actual source/inventory/resident/configuration/key mutations, final clock expiry/rollback, a write during the preceding controller clock callback, reentrant denial, and strict Clippy. No production credentials or external authority calls are used.

## Isolated validation result (2026-09-19)

The implementation and fixture test listed above are complete in the isolated `check-epoch-fence` checkout. The exact promotion set is recorded in `work/backup-cli/epoch-fence-final-manifest.json`; `work/backup-cli/epoch-fence-final.patch` applies cleanly to the actual repository HEAD. The final original ten-database fixture run is `/tmp/hepta-concrete-fence-final.log`: four tests passed, zero failed, in 768.33 seconds. It covers origin, generation, and exact-action binding; shared coordinator feedback and same-head invalidation; actual restore source, inventory, resident lease, backup/online trust and command mutations; zero-authority-call revalidation; final expiry/rollback and a write from a preceding clock callback; and reentrant borrow/replacement denial. Strict compilation/clippy is recorded in `/tmp/hepta-concrete-fence-clippy.log`; the private JSON-construction compile-fail doctest is in `/tmp/hepta-concrete-fence-doctest.log`.

The slice was promoted into the working tree after the evidence above and remains passive: it has not been exposed as Active. The earlier Pending test list is historical scope; the logs above are the authoritative current evidence.
