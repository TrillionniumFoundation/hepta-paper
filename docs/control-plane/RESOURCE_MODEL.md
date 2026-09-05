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
a barrier immediately reconsiders remaining requests. Abort after grant does
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
