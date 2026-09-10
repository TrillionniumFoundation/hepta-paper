# ADR-0008: preserve concurrency through a single-writer commit sequencer

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

Parallel modules must not become parallel authoritative writers. Serializing all
work would be safe but unnecessarily slow; allowing direct writes would create
unrecoverable authority and consistency ambiguity.

## Decision

All expensive research, model, empirical, numerical, build, and verification
work runs concurrently and returns immutable prepared results. One fenced commit
sequencer performs only short authoritative transactions after checking plan,
snapshot, campaign revision, attempt, lease, writer generation, resource
settlement, and verified-result identity.

Module-private journals may support recovery but never become campaign-state
authority. Direct production database access outside the sequencer is forbidden.

## Consequences

Exactly-once integration and high execution concurrency coexist. The writer is
a capacity dimension with explicit queue/SLO/backpressure. Prepared results can
survive restart without repeating provider work.

## Adoption gates

Reachability tests, OS/database authority tests, stale-commit adversarial tests,
writer throughput workloads, and cutover fencing must all pass.
