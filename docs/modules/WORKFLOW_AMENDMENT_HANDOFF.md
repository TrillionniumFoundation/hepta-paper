# Local workflow amendments and manuscript revision handoff

## Scope and source ownership

`rust/crates/hepta-paper-service/src/workflow/amendment.rs` implements explicit
local/shadow append, budget increase, lease renewal and bounded review repair.
Its `amendment/broker_revision.rs` child validates the broker manuscript contract;
it does not add a scheduler, writer, result database or signing authority.
`rust/crates/hepta-campaign-writer/src/workflow_amendment.rs` owns their atomic
storage in the existing campaign writer. Neither path opens a production writer,
changes registry activation, grants provider credentials or makes Node retired.

A structural repair uses caller-supplied manuscript content and the deterministic
native reviewer. It is not an autonomous model revision loop or independent
scientific review. The broker contract below also supports explicit signed `author/revise` and
`reviewer/review` tasks through the ordinary autonomous entry. Dynamic request
issuance, independent installed principals, live-model acceptance, actual billing
and commit-bound ACK remain separate requirements.

## API and executable command

```text
amend_local_workflow_v1(root, expected_definition_hash, request, now_unix_ms)
  -> WorkflowAmendmentReceiptV1

hepta-local-workflow amend STATE CURRENT_DEFINITION_HASH REQUEST.json [NOW_MS]
hepta-local-workflow status STATE NEW_DEFINITION_HASH
hepta-local-workflow advance STATE NEW_DEFINITION_HASH ABSOLUTE_THROUGH_STEPS [NOW_MS]
```

Without the optional `NOW_MS`, amendment, advance and revision-bound
pause/resume/cancel sample the real system clock through the existing owners.
Explicit `NOW_MS` preserves the deterministic local-drill interface only; it
must not be confused with live lease admission. Read-only status needs no clock.

`amend_local_workflow_with_clock_v1(root, expected_definition_hash, request, clock)`
shares the same workflow lock, immutable definition, history and SQLite owner.
New amendments sample after history validation, again after `BEGIN IMMEDIATE`,
and immediately before `COMMIT`. The final check uses the **previous** lease,
not the newly staged expiry, so a renewal cannot authorize its own late write.
Expiry, clock rollback or observation failure rolls back the definition, budget,
lease, revision and event together. Exact replay remains clock-free and returns
the original receipt without renewing again. These are system-time observations,
not independent time attestation, automatic renewal or in-flight cancellation.

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
| `repairRejectedReview` | Requires the latest committed step to be a rejected native structural or versioned broker manuscript review and the matching strict replacement round below. |

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

## Broker manuscript revision contract

The same `repairRejectedReview` amendment can select a broker round only when
both original roles already use the frozen `broker_execute` or `broker_prepared`
worker binding. The original author must be `author/draft` or `author/revise`;
the replacement is `author/revise`, not a fresh unbound draft. The reviewer remains
`reviewer/review` in the same module. Author and reviewer endpoints must differ;
this is a routing check, **not proof of independent installed Unix principals**.

The replacement author retains the original author module, output schema,
workspace identity and mutation policy. Four mandatory CAS bindings provide the
previous manuscript bytes and digest, plus the exact rejected assessment bytes
and digest. The explicit version-1 input is
[`broker-manuscript-revision-input.v1.json`](examples/broker-manuscript-revision-input.v1.json).
The only free instruction field is text; unknown authority or other extra fields
are rejected. The existing signed request still has to bind the resulting exact
manifest, prompt, task, attempt, revision, lease and resource ceilings.

The reviewer job template is byte-equivalent as a JSON value to the original,
including its rubric, prompt, schema, workspace and mutation constraints. Its
reserved resources and cost ceiling cannot be weakened. The version-1 input is
[`broker-manuscript-review-input.v1.json`](examples/broker-manuscript-review-input.v1.json).
Only the two source bindings change to the revised manuscript bytes and digest;
the `/accepted` gate must report that exact digest in `/manuscriptHash`.

The ordinary `autonomous-research --action amend` and `--action converge` paths
use the existing SQLite amendment, prepared-result and commit owners. Rejection
stays set after the revised author commits. Only the bound replacement assessment
can clear it; a second rejection is durable and blocks the remaining suffix.
A lost broker execution response remains query-only on restart. Amending or
replaying a receipt cannot discard that uncertainty or issue another execution.

The broker revision regression module imports both JSON examples directly and
invokes the actual CLI. Its protocol peers are deliberately not real provider
canaries: source integration does not certify scientific acceptance, independently
controlled reviewers, installed research activation, measured provider settlement
or commit-bound acknowledgement. Executable test selectors and exact source
bindings are maintained in the canonical route ledger and source evidence bundle,
not duplicated as an acceptance checklist here.

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

## Autonomous product caller with persisted references

After initial `--workflow-file` launch, the same autonomous entrypoint can operate
on the existing owner without reconstructing an amended private definition:

```sh
hepta-paper-rust autonomous-research --campaign-id CAMPAIGN --workflow-root STATE --definition-hash CURRENT_HASH --action status
hepta-paper-rust autonomous-research --campaign-id CAMPAIGN --workflow-root STATE --definition-hash CURRENT_HASH --action amend --amendment-file REQUEST
hepta-paper-rust autonomous-research --campaign-id CAMPAIGN --workflow-root STATE --definition-hash NEW_HASH --action converge
```

`STATE` and `REQUEST` are absolute canonical paths. The request is the existing
closed `WorkflowAmendmentV1`, not a second amendment protocol; its regular file
must be caller-owned, private, single-link, no-follow, stable and at most 16 MiB.
The CLI never prints private definitions, writer tokens or untrusted diagnostics.
File and persisted-reference modes are mutually exclusive. Prepare still requires
an explicit definition file. Amend requires its own request and forbids separate
`--through-steps`/`--expected-revision`; the revision is bound inside that request.
Persisted pause/resume/cancel retain `--expected-revision`. Full-readiness,
production-run and golden-bootstrap remain refused.

The crate-private `read_current_local_workflow_v1` captures the active definition
from the original immutable definition, exact SQLite amendment/result history
and actual CAS bytes under the existing cooperative workflow lock. This read is
not a capability. Subsequent operations revalidate the caller's **explicit** hash
under their original owner lock; a concurrent amendment cannot silently retarget
an invocation. The template's original on-disk lease may be expired while the
current replayed owner lease is valid. No second writer, scheduler, journal or
public private-definition export is added.

`amend` calls `amend_local_workflow_with_clock_v1` directly with a live clock.
New operations require the current hash/revision and the still-valid previous
lease. Exact old-request replay is checked by the owner before live admission,
including after later progress or completion, and returns the original receipt
without another budget addition, lease extension or worker launch. The caller
uses the returned `definitionHash` for future operations. This is explicit
renewal, not automatic heartbeat, independent time attestation, physical
in-flight cancellation or complete model-driven research.

Five actual-binary regressions in
`tests/local_workflow/autonomous_amendment.rs` cover positive continuation after
renewal, immutable definition bytes, lost-response replay, old-expiry/current-lease
separation, stale/foreign/substituted requests, terminal refusal, direct inspection
non-mutation and private-file/alias/byte limits. Their exact selectors are bound
in the existing functional-source evidence and 57-route command map. Local
execution does not promote an external or production qualification state.

## Verification

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-campaign-writer workflow_amendment
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test local_workflow
```

Tests cover budget/lease/definition atomicity, event-insert rollback, response-loss
replay, event-bound receipt corruption, stale/expired/terminal/pending denial,
prefix preservation, old-expiry continuation after explicit renewal, same-rubric
repair, repeated rejection, no rejected-manuscript packaging, redacted CLI and
actual SIGKILL after amendment COMMIT. Live-clock cases additionally test old-lease expiry after staged renewal, rollback/clock failure, exact clock-free replay, continuation beyond the old expiry, and actual CLI renewal/advance/pause/resume/cancel without a supplied time. Existing workflow and workspace suites stay
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
