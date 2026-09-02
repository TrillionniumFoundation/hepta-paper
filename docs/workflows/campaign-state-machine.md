# Campaign state machine

Status: normative

## Scope

This guide defines the common lifecycle semantics of the persistent campaign DAG. Concrete node kinds and payload schemas remain in `paper-domain/automation` and application orchestration.

## Core identities

A campaign has a stable campaign identity and immutable plan hash for a given plan generation. Each node has a stable node identity. An execution claim creates an attempt with a monotonically fenced lease generation and opaque token. Results, artifacts, reviews, proofs, resource reservations, and receipts bind the exact campaign, node, plan generation, attempt, and source snapshot.

A stale attempt may not heartbeat, fail, prepare, complete, refund, publish, or mutate a newer generation.

## Node lifecycle

The common lifecycle is:

`blocked → ready → leased → running → prepared → completed`

Terminal alternatives are `failed`, `cancelled`, and `budget_stopped`. A retry creates a new attempt; it does not mutate the identity or evidence of an old attempt. Recovery may integrate a durable prepared result without rerunning its external executor.

`blocked` means dependencies or policy are unsatisfied. `ready` means admission may be attempted, not that resources or authority are guaranteed. `leased` means a generation-fenced claim exists. `running` means execution has begun. `prepared` means an immutable result is durable but not yet integrated. `completed` means the current generation accepted the prepared result and emitted the required state transition.

## Legal transitions

Only the campaign store changes operational DAG authority. Transitions require the expected state, generation, attempt token, plan hash, and dependency state. Completion is rejected when the lease is expired, superseded, or belongs to another attempt.

A node cannot skip from ready to completed. Packaging cannot bypass non-convergence. A budget stop can resume only through an explicit budget amendment. A non-budget operational stop is not silently reclassified as budget exhaustion.

## Cancellation and deadlines

Cancellation before any external action or durable prepared result may release the exact reservation defined by policy. Once an external action may have occurred or a prepared result exists, the system records and reconciles it rather than pretending cancellation erased it.

Every blocking acquisition and external operation has a hard deadline. Deadline expiry is an outcome, not proof of rollback. Resource governors, locks, and leases use bounded probes and observe abort signals at documented points.

## Retry and recovery

Retries are bounded by node policy and campaign budgets. A retry receives a new attempt identity and fencing generation. Deterministic validation failures are not retried. Unknown provider outcomes enter reconciliation. Code, LaTeX, or empirical repair nodes consume real diagnostics and generate a new bounded attempt rather than editing prior receipts.

On restart, recovery:

1. inspects durable leases and prepared results;
2. fences expired or superseded attempts;
3. integrates only a prepared result whose complete identity still matches;
4. reconciles external actions through their authority;
5. preserves immutable historical attempts and receipts;
6. schedules only dependency-ready work.

## Plan amendment

Resume or extension persists an amendment event, recomputes the plan hash, preserves completed nodes, and reopens or appends only policy-authorized work. An amendment cannot rewrite prior evidence or lower an acceptance threshold.

## Release handoff

Campaign completion yields a typed promotion candidate. Release packaging builds under a separate generation lock, publishes through a recoverable transaction, and then establishes current-release authority. Submission handoff consumes query-only current-release capability. Provider mutation remains a separate, freshly verified authority.

## Invariants

- one operational DAG authority;
- no stale-generation mutation;
- no completion without a durable result;
- no rerun when a valid prepared result can be integrated;
- no implicit authority promotion;
- no blind retry of unknown external outcomes;
- no deletion without exact recovery and restore evidence;
- no compatibility or experimental engine in the production campaign graph.
