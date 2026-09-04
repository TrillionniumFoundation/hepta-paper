# ADR-0017: use deterministic fallback and side-effect-aware replanning

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

An optimizer can time out, return an invalid plan, encounter stale state, or be
operationally unavailable. Control progress must continue safely without
pretending that a fallback is globally optimal or repeating irreversible work.

## Decision

A deterministic baseline scheduler is always available. It applies hard policy,
critical path, deadline, priority class, DRF, aging, reservations, and budgets.
Invalid/timeout optimizer output is discarded and recorded with a bounded reason.

Replanning uses a fresh snapshot. Tasks before an irreversible boundary may be
cancelled/released according to policy. Tasks whose provider or external effect
may have started are reconciled from durable intent and authoritative receipts;
they are never blindly rescheduled.

## Consequences

The optimizer is not an availability or security single point of failure.
Fallback efficiency has explicit SLOs and alerts. Replanning remains compatible
with exactly-once prepared-result integration.

## Adoption gates

`SCH-001`, `SCH-004`, `CTL-005`, `RES-005`, and workloads `PERF-WL-008`,
`PERF-WL-012`, and `PERF-WL-013` must pass.
