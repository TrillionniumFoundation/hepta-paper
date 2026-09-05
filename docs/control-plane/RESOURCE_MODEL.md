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
root waiter to proceed. The engine integration in section 15 is explicitly configured and source-tested;
persisted resource recovery, target-host fairness/performance and independent
review remain required before widening rollout. This contributes to RES-001/003/004, without changing their global
work-item states or closing G4.


## 15. Explicit campaign integration and joined nested execution

`paper-application/automation/campaign-resource-envelope.mjs` captures a trusted
`CampaignResourceEnvelopePolicyV1`; `runPaperCampaign` accepts it through the
new optional `resourceEnvelopePolicy` argument. It is not derived from a node's
candidate-reported resource wishes and is not a production authority grant.
Existing callers without a declaration keep their legacy resource routing and
result shape, but all callers now use the joined nested-execution boundary below.
There is no automatic envelope command-line rollout or multiprocess fallback.

The closed policy has `version: 1`, `kind: CampaignResourceEnvelopePolicyV1`, a
nonempty `nestedAgentSlotsByKind` mapping of exact known campaign node kinds to
1..64 agent slots, and optional `maximumChildren` / `maximumWaitingRequests`
(default 1024, range 1..4096 each). Up to 64 kind bindings are accepted. Values
are captured without numeric coercion or executing accessor properties. Keys
are sorted before the existing canonical hash function computes the policy
identity. Calling `captureCampaignResourceEnvelopePolicy` returns the frozen
policy and its `policyHash`.

Before creating the campaign, the trusted composition places that hash in the
plan's `resourceEnvelopePolicyHash`. Existing campaign-definition identity and
replay checks bind this field. Execution requires both the explicit runtime
policy and the identical persisted hash: supplying a different policy, omitting
the policy for a bound campaign, or adding a policy to an unbound campaign fails
before node claims. This is a configuration identity check, not authorization
of the configured source or a cryptographic signature by an external owner.

Both the global and campaign-local governors must expose the current in-process
`GlobalResourceGovernor` envelope interface. Unsupported distributed ports are
rejected rather than replaced by new process-local capacity. Every configured
node is checked against both governors' declared limits before `claimReady`;
capacity is checked again for each actual admission. The full parent-plus-child
reservation is acquired globally, then locally. Failed local acquisition
returns the unused global reservation. Both child ports are then passed to the
existing nested-agent runner, so it cannot accidentally re-enter the local
parent queue while avoiding the global queue. The original execution budget's
`acquiredResources` still describes retained parent work; the additional
`resourceEnvelope` binding records policy hash, parent, child and total vectors.
The final run result also records `resourceEnvelopePolicyHash`.

When an explicit policy is active, unlisted node kinds cannot invoke nested
agent work. Listed nodes use their declared pools. The wrapper bounds all
outstanding nested promises before asynchronous resource acquisition, including
calls that have not reached the pool yet. Same-scope recursive child entry is
rejected using asynchronous context tracking: a child cannot hold a slot while
recursively waiting for another from the same scope. Other locks, custom ports
or cross-scope cycles are not thereby proven safe.

For both legacy and declared-envelope callers, wrapped agent calls span the runner's resource acquisition,
existing action gate, budget reservation, callback, usage metering and release.
A parent must finish all its nested operations before returning its result.
If any call remains outstanding when the parent returns, the engine closes
nested admission, signals cancellation, awaits settlement of those operations
and fails with `campaign_nested_work_unsettled`. It does not prepare/integrate/
complete that parent result. The same drain occurs before processing a parent
error or returning root resources. Handled and awaited nested errors may still
be recovered by the executor; they are not retroactively treated as unhandled
failure. Retained callbacks reject after scope closure. Every dispatch batch joins sibling operations before returning a dispatch
rejection. Legacy calls also reject unresolved nested work rather than preserving
the previous premature-publication behavior; that safety change is intentional.
Legacy routing has a 1024-outstanding-call wrapper bound; explicit policies use
their captured maximumChildren. Same-scope recursion is rejected only in declared
independent-leaf envelope mode, not silently reinterpreted for legacy workloads.

No arbitrary timeout produces a refund. A child that ignores cancellation and
never settles keeps the relevant reservations and prevents that parent from
committing. This is conservative safety, not a finite shutdown/host-recovery
guarantee. The lifecycle covers both `runNestedAgent` and `runEmpiricalCell` through one
shared bounded scope. It does not intercept arbitrary background tasks, direct
provider calls, or asynchronous work that the executor never registers through
those ports; new task families need an explicit settlement contract. Parent execution and finalization still use the existing state,
workspace, usage, external-action and prepared-result gates. The new policy
never makes a local receipt qualify as a real provider execution.

The supervisor abort subscription now uses propagation-resistant disposable
listeners, and early acquisition/start paths release their own listener and
monitor. Parent and nested-agent resource-lease loss use the same propagation-resistant
subscription and dispose it after use. Lease loss cannot be suppressed by a
preceding ordinary abort listener or delayed until after parent completion.
A caller must have reconciled its physical/external work before resolving the
executor and release promises; the application cannot prove that fact solely
from Promise settlement.

`paper-core/tests/campaign-resource-envelope.test.mjs` executes the real engine,
real SQLite campaign store and native resource governors. Local callbacks prove
40 nested calls complete behind a blocked root competitor; policy drift,
missing declaration, local/global overflow, unsupported distributed governors,
undeclared/recursive nested work and action-gate denial fail closed. Deferred
children prove parent success/failure/shutdown cannot commit or refund early;
sibling joining and late callback rejection are checked. These are source
integration controls, not real model, host, storage-custody or cutover evidence.
Rollback must preserve the policy field's fail-closed handling: removing runtime
support while continuing a declared campaign is not a safe implicit downgrade.
This is a partial RES/NODE integration; no machine work-item or gate is closed
by this document or by the local tests alone.

### 15.1 Complete child lifetimes and monitor-failure cleanup

The shared execution scope binds both engine-exposed child runner functions.
Their calls count against one maximumOutstanding limit before either runner's
first asynchronous step; moving work from an agent to an empirical call cannot
bypass that bound. An empirical call includes its original budget reservation,
external-action gate and journal, callback and result checks. The wrapper adds
no provider permission, empirical concurrency capacity or scientific acceptance.
Parent return/error/shutdown joins outstanding calls of both kinds before parent
result preparation or resource release. A late retained empirical function is
closed before additional metering, gates or callbacks. Completed and handled
child failures remain recoverable by the parent; the scope is not a proof that
arbitrary ignored, already-settled errors were correctly handled.

The existing `campaign_nested_work_unsettled` disposition now covers outstanding
calls of either kind, preserving the original error domain. Scope finish seals
all ports before awaiting a snapshot of their pending operations. Their async
context is disabled after draining; no new scoped operation is then accepted.
Callbacks still have to settle honestly after actual execution/reconciliation.
A never-settling empirical call intentionally blocks parent publication; a timer
is not used to reinterpret ambiguous work as complete. Per-cell physical CPU/GPU
admission and arbitrary spawned process trees are separate, unproven boundaries.

Both original child runners recheck the execution signal at the final callback
boundary, after awaiting budget/external gates. A supervisor cancellation arriving
inside those gates cannot start the callback just because earlier checks passed.
Any durable intent already recorded keeps its original reconciliation semantics;
this guard never claims that previously started external work was undone.

Heartbeat setup is inside the acquired-resource lifetime. A failing interval
creation or unref prevents executor dispatch and uses the ordinary node failure
path, which releases logical reservations and supervisor monitors. A monitor
teardown exception does not skip the remaining cleanup attempts; it is propagated
after resource release rather than converted to success. An already-lost lease
at handoff raises a dispatch error while preserving the persisted lease for the
existing recovery mechanism, instead of silently spinning on an abandoned node.
These are application cleanup guarantees, not proof that a failing scheduler
actually stopped a timer or that a remote lease was reclaimed.

`paper-core/tests/campaign-child-lifetime.test.mjs` exercises both legacy and
envelope engine paths against real SQLite with explicitly local operations. It
covers empirical early return/failure/shutdown, mixed agent/cell draining, shared
limits, late callbacks, awaited recovery, final-gate cancellation, existing gate
denial, heartbeat construction/unref/teardown faults, suppressed parent/nested
lease-loss propagation, successful unsubscription and already-lost handoff.
No real provider, signed outcome or privileged host acceptance is asserted.
