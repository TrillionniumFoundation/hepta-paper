# Native schema final receipt publication

This handoff documents the Rust v1 historical `FINAL.json` publication boundary
for the online schema transition. It is a durable evidence record, not an
Active runtime capability and not a replacement for the external authority or
production cutover gates.

## Bound inputs and proof

`prepare_schema_transition_audit_v1` accepts independently retained plan,
expected plan hash, state and writer manifests, reserve/reservation,
finalize/finalization, observe/observation records, and all ten installation
records. It pins the authority configuration and writer-manifest hash, rechecks
the live inventory, reruns the post-state observer, validates every instance's
post schema and source identity, and verifies the reservation, finalization and
observation signatures plus cross-request fields. The prepared proof has no
public constructor, deserializer, mutable database handle, or activation
method. Version 2 is rejected until an independently owned target-authority
restart proof is available.

## Publication and recovery

`publish_schema_transition_final_receipt_v1` binds publication to the prepared
runtime root and the first observed source's maintenance lock. The repository
holds the directory identity and kernel lock, uses compare-and-exchange
semantics, writes bounded canonical JSON through an atomic exchange, retains
conflicting residue, and rechecks the proof, inventory, authority configuration,
and file digest before returning. An equal verified receipt is idempotent; a
mismatched expected previous digest fails without clobbering the existing file.
The checkpoint interface permits a process-death test between publication and
return, after which a new process can verify and resume idempotently.

## Validation and limits

`tests/finalization_publication.rs` passed three groups: a real Node ten-database
signed fixture with signature-splice and plan-hash negative cases, Node pinned
reader verification, and a child exit after publication followed by idempotent
recovery. Strict production Clippy, rustfmt check, package rustdoc, and the
publication repository's bounded CAS unit test passed.

The receipt is historical only. This slice does not complete the finalization
RPC journal, claim cross-database atomicity, construct `Active`, or retire the
Node command. Independent authority credentials, target-host qualification,
KMS/HSM/WORM controls, and production cutover remain external gates.
