# Rust external schema finalization and observation candidate

This is an integrated passive candidate. It does not modify or activate the runtime and
does not claim acceptance by an external authority service.

The candidate mirrors the Node completion request builders in
`autonomous-research-online-schema-transition-state.mjs`. It binds the exact
reservation receipt hash, installation records, independently supplied post
inventory hash, post pristine runtime hash, completion timestamp, durable observe
nonce, and observation timestamp. `finalize_schema_transition_v1` consumes only
a `VerifiedMutationReceiptV1` and returns another verifier-bound opaque receipt;
`observe_schema_transition_v1` is available only for protocol v1. Version 2
returns the explicit target-configuration-restart-required error at the
observation boundary, matching Node's rebind flow.

`observe_schema_transition_post_state_v1` supplies the local precondition for
those builders: it resolves a fresh complete inventory, checks every installation
record against the actual post schema, and for v2 reads ten private snapshots to
recompute the aggregate pristine runtime hash. For v1 it emits the exact Node
not-applicable pristine hash. It does not publish progress, write final receipts,
release locks, restart authority configuration, construct `Active`, or treat an
external response as evidence of local post state. The caller must persist the
exact observe request before invoking the external service and compare returned
receipts through the pinned authority verifier. External fencing/linearizability
and target authority restart remain external trust obligations.

Validation in the integrated working tree (with the original isolated evidence retained):

- Three Rust unit tests passed, including two negative shape/boundary tests.
- The Rust request objects byte-for-byte matched the Node request builders for
  the same plan, receipt, hashes, nonce, and timestamps.
- Candidate rustfmt, strict Clippy (`-Dunsafe-code`, `-Dwarnings`, and unwrap,
  expect, panic denied), and the Node oracle ESLint gate passed.

The installation implementation still compares every committed database to its
expected exact post state; this candidate's post-state helper must be called
after installation and before finalization so the final live inventory and
aggregate pristine hash are independently recomputed.
