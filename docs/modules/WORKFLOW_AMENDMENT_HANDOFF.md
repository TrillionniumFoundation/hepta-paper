# Local workflow amendments and structural revision handoff

## Scope and source ownership

`rust/crates/hepta-paper-service/src/workflow/amendment.rs` implements explicit
local/shadow append, budget increase, lease renewal and structural review repair.
`rust/crates/hepta-campaign-writer/src/workflow_amendment.rs` owns their atomic
storage in the existing campaign writer. Neither path opens a production writer,
changes registry activation, grants provider credentials or makes Node retired.

A structural repair uses caller-supplied manuscript content and the deterministic
native reviewer. It is not an autonomous model revision loop or independent
scientific review. Qualified broker/model and scientific-runtime integration
remain separate implementation and evaluation requirements.

## API and executable command

```text
amend_local_workflow_v1(root, expected_definition_hash, request, now_unix_ms)
  -> WorkflowAmendmentReceiptV1

hepta-local-workflow amend STATE CURRENT_DEFINITION_HASH REQUEST.json NOW_MS
hepta-local-workflow status STATE NEW_DEFINITION_HASH
hepta-local-workflow advance STATE NEW_DEFINITION_HASH ABSOLUTE_THROUGH_STEPS NOW_MS
```

The command uses bounded regular-file JSON input and prints a bounded receipt.
The receipt contains request/old-definition/new-definition hashes, original
application revision/time and committed prefix length. It never prints the full
private definition, manuscript, process configuration or writer token. Errors use
the CLI's existing generic stderr message; private state is retained for inspection.

The executable example is [`examples/workflow-amendment.v1.json`](examples/workflow-amendment.v1.json); the Rust workflow tests import these exact bytes.

Example budget and lease request:

```json
{
  "version": 1,
  "operationId": "amend-1",
  "expectedRevision": 3,
  "steps": [],
  "additionalBudgetMicrousd": 50,
  "leaseExpiresAtUnixMs": 200000,
  "repairRejectedReview": false
}
```

These times are explicit drill inputs, not a live clock or deployment profile.
The example can be sent only to a matching local campaign at revision 3 with a
still-current lease no later than 200000. Replace the identities and observations
from the actual local status; do not copy this into a production configuration.

## Field and transition contract

| Field | Contract |
|---|---|
| `version` | Exactly 1; unknown fields rejected. |
| `operationId` | 1–96 ASCII alphanumeric, dot, dash or underscore characters. |
| `expectedRevision` | Exact current campaign revision; replay is identified separately. |
| `steps` | Ordinary mode appends; repair mode replaces only the uncommitted suffix. |
| `additionalBudgetMicrousd` | Nonnegative integer; checked cumulative total/remaining amounts fit SQLite signed integers. Never a refund or provider-charge reconciliation. |
| `leaseExpiresAtUnixMs` | Absolute expiry, not earlier than the current lease; generation/token remain unchanged. Expired leases cannot be revived. |
| `repairRejectedReview` | Requires the latest committed step to be a rejected native structural review and the strict replacement round below. |

The entire request and next definition are bounded to 16 MiB. Total steps remain
at most 128 and all identifiers/dependencies/resource sums remain validated by
`LocalWorkflowV1`. At most 128 amendments and 64 MiB of serialized amendment
history are accepted. No change widens the resource envelope, worker registry,
source identity, initial state, hard policy or production/external-action fields.

Ordinary changes work only while Running or Paused. Paused remains Paused;
Cancelled and Completed do not reopen. Extend before completing the final step.
Any pending saved step configuration blocks amendment: an uncommitted or ambiguous
attempt cannot be renamed, discarded, refunded or silently re-executed by changing
the workflow. Resource exhaustion is still a typed failure, not permission to
increase limits without a new explicit contract.

## Durable state and atomicity

The optional exact schema group `local_workflow_amendments_v1` is accepted only
beside both the local-only marker and control stream schema. It stores versioned
closed request/receipt bodies indexed by campaign, ordinal and operation ID. The
service and storage layers independently decode the same closed wire contract.

One `BEGIN IMMEDIATE` transaction verifies writer identity/expiry, campaign
revision, control-result count, pending node absence and the previous definition.
It commits the amendment receipt, budget delta, next revision, new lease expiry
and existing campaign event-chain entry together. There is no separate progress
cursor, new database writer service or side-file pointer swap. Exceptions before
COMMIT roll back every effect. The storage layer pre-serializes the receipt before COMMIT. A later transport failure does not undo the transaction; exact request replay recovers the original receipt.

The original `workflow.json` and existing `step-NNNN.json` files are unchanged.
Reading status captures campaign, result history and amendments in one SQLite read
transaction. It rechecks each receipt's event binding, definition hash, preserved
prefix and template restrictions, then reconstructs old step configurations using
the definition/budget/lease valid at that step's revision. Deleting or changing a
receipt, reordering changes or losing its event is an integrity failure.

An operation retry with the exact original expected definition and request returns
the original receipt, including after subsequent changes or expiry. It does not
add budget, renew a lease or create another definition. Conflicting reuse rejects.
New operations require the latest definition hash. A successful reply lost before
the client reads it is recovered by resending that original request, not by
inventing a new operation ID.

## Structural review repair contract

A rejected review and its subject remain committed history. Repair can start only
at that rejected boundary and must supply a fresh native author step followed
immediately by a native reviewer with the original module and identical rubric.
The review must consume the new author's actual CAS bytes and bind that exact hash
via `/manuscriptHash`; the decision field is `/accepted`. Removing the review,
weakening the rubric or pointing it at the original rejected manuscript fails.
Downstream bindings cannot reuse the rejected author/reviewer artifacts.

Only those two repair steps may run while the old rejection is unresolved.
`gateRejected` remains true after the new author, and
`repairAllowedThroughSteps` describes the bounded repair window. A successful
new structural review clears the routing rejection, not scientific acceptance.
Another rejection closes the window and blocks all later packaging. A further
repair needs a new operation ID, fresh step IDs and the new rejected boundary.

## Errors and recovery

`Definition`: malformed/oversized input, duplicate IDs, policy/definition mismatch,
no-op, changed prefix, invalid round, invalid dependency, resource/number bounds.
`Conflict`: stale definition/revision, clock rollback, terminal state, expiry,
changed writer identity, replay conflict or failed storage amendment.
`Reconciliation`: a saved next-step plan exists and cannot be safely abandoned.
`GateRejected`: ordinary amendment attempted across a rejection, or repair without
an actual rejection. Filesystem/history errors preserve the existing categories.

Cancellation remains between steps under the cooperative workflow lock. This
implementation does not promise immediate cancellation of an executing child.
A crash after amendment COMMIT leaves an exactly replayable receipt; subsequent
advance runs only remaining work. A process with arbitrary same-UID SQLite/file
write access remains in the trusted computing base.

## Verification

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-campaign-writer workflow_amendment
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test local_workflow
```

Tests cover budget/lease/definition atomicity, event-insert rollback, response-loss
replay, event-bound receipt corruption, stale/expired/terminal/pending denial,
prefix preservation, old-expiry continuation after explicit renewal, same-rubric
repair, repeated rejection, no rejected-manuscript packaging, redacted CLI and
actual SIGKILL after amendment COMMIT. Existing workflow and workspace suites stay
required on the exact new source head.

## Migration and remaining acceptance

A pre-amendment local database is readable without creating the optional schema.
The schema appears atomically with its first amendment. Older binaries which do
not recognize it intentionally reject that database; do not strip amendment rows
or restore a stale backup to claim rollback. Preserve current state and use a
compatible version or an independently reviewed forward/reverse migration.

The nearest Node behaviors are campaign resume/budget changes, extension and
review/revise rounds, but CLI units, distributed scheduling, model quality,
external effects and active schemas differ. These are scoped source mappings,
not accepted command parity. Live model, runtime isolation, target-host storage,
external evidence, writer cutover and mechanical Node retirement remain open.
