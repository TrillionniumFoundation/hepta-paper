# Resource allocation model

## 1. Scope

The resource allocator provides admission, reservation, accounting, fairness,
and lease fencing for execution plans. It does not choose research content,
commit campaign state, validate scientific claims, issue provider credentials,
or authorize release or submission.

All mutation remains mediated by the central commit sequencer and the
capability-specific writer boundaries. Resource availability never overrides an
authority or qualification failure.

## 2. Resource vector

Every admitted action declares a finite non-negative resource vector over the
configured dimensions. The initial canonical dimensions are:

```text
agent slots
CPU millicores
memory bytes
GPU device identities
GPU memory admission bytes
scratch bytes
persistent-write budget
provider concurrency
provider cost reserve
network action slots
```

Dimensions may be added only through a versioned schema and migration. Unknown,
negative, non-finite, overflowing, or unit-ambiguous values fail closed. GPU
identity admission and GPU-memory admission are distinct; a memory estimate is
not proof of device isolation.

## 3. Capacity hierarchy

Capacity is evaluated through an explicit hierarchy:

```text
host or cluster
  -> service class
    -> team or tenant
      -> campaign
        -> action attempt
```

Each level may define a hard ceiling, guaranteed share, burst allowance, and
maximum reservation horizon. A child cannot expand a parent ceiling. Missing
configuration inherits no implicit production capacity.

Capacity snapshots bind provider, runtime, device, filesystem, database, and
policy generations. A changed generation invalidates an unconsumed admission.

## 4. Reservation protocol

Admission is a prepare/finalize protocol:

1. validate plan certificate and exact action identity;
2. read one immutable capacity and accounting snapshot;
3. test hard ceilings and fairness eligibility;
4. durably prepare the complete resource vector;
5. revalidate plan and capacity generations;
6. finalize a renewable, fenced reservation lease;
7. return a single-use dispatch capability.

A prepared reservation performs no provider or worker action. Failure before
finalization rolls back the full vector. Lost finalization acknowledgement is
reconciled by reservation identity rather than blindly repeated.

## 5. Dominant-resource fairness

Fairness is based on hierarchical dominant-resource share. For entity `i` and
resource `r`:

```text
dominantShare(i) = max_r allocated(i,r) / entitledCapacity(i,r)
```

Only dimensions with a configured positive entitlement participate. Selection
uses the lowest eligible dominant share after applying hard priority classes and
aging. Ties use deterministic campaign and action ranks.

Fairness operates on finalized allocation plus prepared reservations that can
still commit. It never ignores in-flight or externally uncertain consumption.

## 6. Aging and starvation bounds

Every continuously eligible action accumulates bounded age. Age may promote an
action within its policy class but cannot cross an authority boundary, violate a
hard ceiling, or preempt a point-of-no-return operation.

The allocator records eligibility intervals, deferral reasons, and effective
rank. Canonical fairness workloads must demonstrate that an admissible action
receives service within its declared bound when capacity and higher-priority
load satisfy the workload assumptions. No universal starvation-free claim is
made outside those assumptions.

## 7. Leases and fencing

A finalized reservation contains:

- reservation and attempt IDs;
- owner principal and worker identity;
- capacity/accounting generation;
- exact resource vector;
- issued, expiry, and renewal deadlines;
- monotonically increasing fence generation;
- plan and action hashes;
- terminal state and self-hash.

Renewal requires the exact live owner, fence generation, and unexpired policy
window. Expiry prevents new work but cannot prove that an external side effect
did not occur. Recovery distinguishes pre-action, post-marker, prepared-result,
integration, and externally uncertain states.

## 8. Accounting

Accounting is append-derived and reconciled against authoritative leases,
attempts, provider receipts, runtime observations, and durable action journals.
The allocator maintains separate values for requested, prepared, finalized,
observed, released, refunded, and uncertain consumption.

Unknown cost or resource usage is conservative: the unresolved reserve remains
charged until a trusted reconciliation receipt closes it. Retry-policy changes
cannot reset lifetime attempt, cost, or quota accounting.

## 9. Preemption

Preemption is permitted only for actions that explicitly declare a safe
preemption boundary and have not crossed a point of no return. The preemption
plan binds victim identity, expected reclamation, checkpoint semantics, and a
rollback deadline.

Killing a process is not sufficient proof of resource or external-effect
release. Device, container, provider, filesystem, database, and network state
must be independently reconciled before reclaimed capacity is reusable.

## 10. Recovery and reconciliation

Startup and periodic reconciliation detect:

- expired or owner-dead reservations;
- prepared reservations without finalization;
- finalized reservations without a live attempt;
- attempts whose observed use exceeds reservation;
- resource generations changed during dispatch;
- unknown provider or external-action outcomes;
- accounting rows without their bound plan or receipt.

Repairs are idempotent, generation-fenced, and journalled. Ambiguity retains the
charge and blocks conflicting reuse rather than manufacturing availability.

## 11. Required tests and evidence

Source and hosted tests cover atomic multi-dimension admission, hierarchy
ceilings, deterministic DRF ordering, aging, lease renewal, stale-owner fencing,
concurrent last-slot races, overflow, partial commit, acknowledgement loss, and
unknown-usage handling.

Target-host evidence covers real cgroup and device observations, process death,
reboot, storage pressure, GPU contention, provider throttling, and long-running
fairness workloads. Production activation additionally requires current
capacity configuration, monitoring, rollback, and independent qualification.

## 12. Non-claims

An admitted resource vector is not an execution result. A lease is not proof of
kernel isolation. A scheduler fairness report is not a universal liveness proof.
Capacity, priority, or low cost never grants provider, writer, release, storage,
portal, submission, or external-authority permission.


## 13. Current Node governor: executable bounded admission

`paper-application/automation/resource-governor.mjs::createResourceGovernor`
implements a local, trusted in-process admission subset. It is not the durable,
hierarchical allocator described above. Its four legacy dimensions are `agent`,
`cpu`, `gpu` (whole slots) and `memoryMiB` (whole MiB); these are not the Rust
protocol's CPU millicores, memory bytes or GPU device identities. Callers must
convert units explicitly. `resourcesForCampaignNode` rejects invalid empirical
worker-byte declarations and rounds positive byte counts upward to whole MiB.

The source API is `createResourceGovernor(limits, admissionPolicy)` followed by
`await governor.acquire(vector, { signal })`. Vectors and limits are plain or
null-prototype data records. Only the four named dimensions are accepted;
values must be non-negative safe integers. Strings, booleans, non-finite or
fractional values, negative values, accessor properties and unknown dimensions
are rejected before accounting or queue mutation. Omitted request dimensions
mean zero. Existing omitted-limit defaults (4 agent, 4 CPU, 1 GPU, 8192 MiB)
remain solely for legacy compatibility and do not qualify production capacity.

An acquisition resolves to its own release function. Calling that function
more than once has no effect after its first call, including after other work
has acquired the freed slots. Admission compares each request against
`maximum - used`, then updates all dimensions synchronously; it cannot overflow
an intermediate sum. By induction from zero usage, successful admissions and
single effective releases keep every counter within `[0, maximum]`. This is a
source-level accounting invariant, not proof that workers obey reservations.

The immutable admission policy has two optional fields:

| Field | Default | Permitted range | Effect |
|---|---:|---:|---|
| `maximumWaitingRequests` | 1024 | 1–4096 | Reject excess waiters with `resource_wait_queue_full` before attaching a listener |
| `maximumConflictingBypasses` | `null` | `null` or 0–1024 | Opt-in maximum younger grants sharing any requested dimension while a waiter remains queued |

The default `null` retains legacy work-conserving first-fit ordering. A caller
may opt into a finite bypass limit only for independent work that does not hold
a reservation while awaiting another acquisition. Otherwise a waiting large
request could block a small nested child whose parent holds the resources the
large request needs. Dependency-aware priority inheritance is not implemented.
The default therefore does not claim a starvation bound. The nested-parent
regression exercises 40 successive child calls while another job waits.

With a finite policy, a blocked waiter's bypass count increases only when a younger conflicting
request is granted, and never resets while that waiter remains queued. At its
limit, it becomes a barrier to further conflicting younger grants. Disjoint
resource requests can still proceed. A limit of zero gives FIFO ordering for
conflicting requests. This trades some work conservation for bounded overtaking;
it is not DRF, priority inheritance, preemption, a wall-time deadline, or a
universal starvation guarantee. Progress requires finite earlier queued work
and eventual explicit release by all granted owners. The source has no timer
that invents capacity when an owner stops responding. Queue storage is bounded
by the policy; one drain has worst-case quadratic queue scans over four fixed
dimensions. Target-host latency and throughput are not established by this bound.

Native abort signals remove pending waiters and their listeners, and removing
a barrier immediately reconsiders remaining requests. Subscription uses Node's
`events.addAbortListener` rather than an ordinary `addEventListener`: an earlier
listener's `stopImmediatePropagation()` cannot suppress this cleanup. The returned
disposable is released on both grant and cancellation, leaving unrelated
listeners untouched. A cancelled waiter cannot retain the last waiting-queue
slot merely because another listener stopped event propagation. Abort after grant does
not release a charge: the caller must reconcile the operation and invoke its
release handle. The same limitation applies after process death; the Node
in-memory helper neither persists nor reconstructs authoritative leases.

`paper-core/tests/resource-governor-invariants.test.mjs` tests duplicate and
stale releases, invalid vectors, atomic multi-resource limits, integer overflow,
queue saturation, cancellation, bounded overtaking, disjoint progress and a
repeatable 500-operation workload checked against an independent active-handle
ledger. Existing campaign and orchestration tests remain required. This source
increment contributes to RES-001/003/004; it does not close those complete work
items, G4, target-host acceptance or any activation gate. Changes to ordering
and rejection behavior require fresh exact-source integration and review.


## 14. Opt-in parent and child resource envelope

The same Node governor now exposes
`await governor.acquireEnvelope({ retained, childCapacity }, options)`. Both
required records use the four exact legacy slot/MiB dimensions and the strict
integer validation above; omitted dimensions inside each record mean zero.
The complete reservation is their overflow-checked componentwise sum. An empty
sum is rejected, and the entire sum is admitted once by the root governor.
No child receives an extra default capacity and no dimension is partially
admitted. This API does not change existing `acquire` call behavior or enable
envelopes by default in the campaign engine or the multiprocess governor.

`retained` includes the parent resources that remain occupied while it awaits
children. `childCapacity` is a distinct budget for independent leaf operations.
The owner returns only `childGovernor` to child consumers; its `acquire` and
`snapshot` are compatible with the existing nested-agent runner's resource
port. Children cannot close the root envelope, allocate a nested envelope or
borrow from retained parent capacity. Child operations must not hold a lease
while recursively acquiring more from that same pool. General dependency-aware
resource planning and priority inheritance are still separate work.

The owner methods are `seal()`, `close()` and `snapshot()`. The lifecycle is:

```text
open -> sealed -> closing -> released
open ----------> closing -> released
```

`seal()` forbids new children and rejects queued or granted-but-not-handed-off
child requests. Owner abort has the same effect; it does not prove parent work
has stopped. `close()` additionally declares the retained parent work finished
or reconciled. Root capacity is released only after this explicit declaration,
all handed-off child handles are released, and all pending handoffs have settled.
No timeout or cancellation automatically manufactures that completion evidence.
If a child hangs or the parent cannot reconcile, the root charge remains held.
The caller is responsible for cancelling actual execution and using the existing
side-effect/reconciliation gates before invoking its release or close handle.

Each child release and root settlement takes effect once. Late duplicates cannot
refund a later unrelated root owner. Aborting after a child grant leaves its
charge intact. Abort subscriptions use the same propagation-resistant native
mechanism as the root governor and are disposed on handoff or failure. Initial
owner construction failure before handoff releases the unconsumed root lease.

Options are `signal`, `maximumChildren` (default 1024, range 1..4096) and
`maximumWaitingRequests` (default 1024, range 1..4096). `maximumChildren` counts
active, waiting and in-transit child requests, including zero-resource requests;
this prevents zero-vector handles bypassing the metadata bound. Queue saturation
and excessive child count remain typed failures. The child pool deliberately
uses first-fit; the root governor retains its configured independent-work policy.
Snapshots distinguish retained parent reservation, child capacity, child usage,
active/pending handles, owner completion and whether the root charge remains.
They report logical reservations, not observed CPU/device/memory usage.

For resource dimension r, envelope j has retained reservation P_jr and child
capacity K_jr. Let E_jr = P_jr + K_jr and A_jr be summed live child reservations.
Root admission and child admission preserve sum_j E_jr <= C_r and
0 <= A_jr <= K_jr. Until the parent has reconciled, its retained use is bounded
by P_jr; hence sum_j (P_jr + A_jr) <= sum_j E_jr <= C_r. Explicit zero limits,
overflow rejection, whole-vector admission and one effective release per handle
are necessary to this source-level induction. This does not enforce physical
resource use by an uncooperative worker.

Because the child pool was reserved before the parent began, an unrelated large
request waiting at a root fairness barrier cannot prevent a child from using its
own pool. This removes that specific cross-level hold-and-wait cycle. It does
not establish a universal starvation or deadlock bound: child calls must be
independent leaves, other application locks/dependencies must not form cycles,
and granted work must eventually release and owners must eventually close.
Unused pre-reserved child capacity also reduces work conservation. Neither DRF,
durable leases, host isolation, distributed fencing nor production activation
is provided by this additive in-process feature.

`paper-core/tests/resource-envelope.test.mjs` covers sum admission, malformed
inputs, overflow, pool separation, bounded handles/queues, cancellation/handoff
races, retained charges, idempotence, subscription failure and deterministic
mixed workloads checked against a separate live-handle ledger. An integration
control calls the unchanged `createCampaignNestedAgentRunner` forty times with
the envelope child port while a conflicting root waiter remains blocked. It
uses a local campaign-store port and explicitly non-model local receipts, not
an external provider or a production campaign. The final close permits the
root waiter to proceed. Explicit engine wiring is described in section 15. Deployment enabling,
persisted recovery, target-host fairness/performance and independent review
remain required before widening rollout. This contributes to RES-001/003/004, without changing their global
work-item states or closing G4.

## 15. Explicit Node campaign-engine integration and nested-result barrier

`runPaperCampaign` in `paper-application/automation/campaign-engine.mjs` now
accepts the trusted composition argument `resourceEnvelopePolicy`. The default
is null: existing deployments and multiprocess governors do not change mode.
Campaign and node data cannot opt themselves into this mode. An enabled policy
requires an envelope-capable shared governor before any node is claimed; it does
not silently fall back if a multiprocess/custom governor lacks that API.

The normalized policy is a closed data record:

```javascript
{
  version: 1,
  nodeKinds: ['formal-verify'],
  childAgentSlots: 1,
  maximumChildren: 64,
  maximumWaitingRequests: 64
}
```

`nodeKinds` contains 1..64 unique exact kind strings and is canonically sorted.
`childAgentSlots` is an explicit integer in 1..64; the two optional metadata
limits default to 1024 and each allow 1..4096. Non-data properties, sparse arrays,
duplicates, unknown keys and coerced values are rejected. The canonical policy
hash is returned as `resourceEnvelopePolicyHash` on the run result and in
`executionBudget.resourceEnvelope.policyHash` for selected executions. This is
configuration correlation, not a signed policy approval or durable qualification.

For a selected, non-replay node, its existing `resourcesForCampaignNode` vector
is retained parent capacity; the child pool contains only the declared agent
slots. Both the shared governor and campaign-local governor admit the complete
parent-plus-child vector before `startNode` or executor invocation. Failure of
the second admission releases the unused first reservation. The executor's
existing `executionBudget.acquiredResources` remains the parent vector; it is
not inflated into permission to borrow child capacity. Its nested-agent runner
receives only the corresponding restricted shared/local child ports. Prepared
result replay does not re-execute children or reserve a new child pool.

A structured nested-call barrier registers every invocation before running it.
The number of unsettled invocation promises is bounded before calling the
nested runner, in addition to each underlying pool's handle/queue limits. Parent
return seals the invocation interface against new calls, then joins all already
registered children before result preparation, workspace integration or commit.
Normal completion drains registered queued children; it does not cancel them.
For this opt-in profile, any failed registered child (even one the caller catches
or ignores) denies parent success. Recovery that deliberately tolerates such
failures needs a separately versioned policy, not a catch-to-success shortcut.
One retained first failure and a bounded pending set suffice; successful child
history is not accumulated in an unbounded in-memory list.

Parent executor failure aborts its controller, seals both pools, and waits for
children to settle before releasing either parent reservation. The original
parent error is preserved. Supervisor cancellation uses a propagation-resistant
subscription. Cancellation alone does not finish the parent or refund an active
child. If a child never settles, the engine remains pending with its reservation
held; it cannot issue a completed receipt or silently reuse that capacity. A
retained nested-call closure denies new work after the parent barrier closes.
The enabled dispatch batch also joins all admitted peers before returning an
admission/infrastructure exception to its caller.

Status-query, reservation-check and start-node failures use the same guaranteed
pre-execution cleanup path; supervisor subscriptions, resource-loss listeners
and control timers are disposed on early exits as well as normal completion.
The existing prepare/integrate fence was moved without relaxed conditions to
`campaign-prepared-result-integration.mjs`, keeping the engine below its existing
500-line architectural limit. Cancellation is rechecked on return from that
await boundary before commit. Writer identity, attempt generation, budget
metering, external-action gates and verification responsibilities are unchanged.

`campaign-resource-envelope-integration.test.mjs` uses the real engine, SQLite
campaign store, governors and nested runner. Local executor controls demonstrate
forty nested calls across a blocked global waiter, no commit while a detached
child remains active, denial of caught/ignored child failures, cancellation and
handoff ordering, admission/start/query cleanup, batch settlement, metadata
bounds, unchanged budget/action denial and the post-integration cancellation
fence. Local callback receipts are not scientific or external provider evidence.

This mode is implemented but not automatically enabled by a CLI or service
bootstrap. It covers nested **agent** calls registered through the supplied port,
not arbitrary detached work, empirical-cell concurrency, recursive acquisitions,
rogue executors, network effects or physical usage. Executors must settle their
promises only after their actual local work is cleaned up; an unresolved external
effect still needs its original authoritative reconciliation. No new durable
lease, process-death recovery, hierarchical DRF, distributed fencing, Rust writer
or target-host qualification is implied. Per-deployment budgets, composition
approval, migration/rollback evidence and independent exact-head review remain
required. Global RES/NODE work states and G4 closure are not upgraded by these
source tests.
