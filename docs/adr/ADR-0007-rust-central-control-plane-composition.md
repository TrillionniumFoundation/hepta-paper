# ADR-0007: introduce one Rust central control-plane composition root

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

The Rust workspace contains hardened protocol, broker, workspace, read-only,
writer, evidence, and cutover crates, but no production composition root. A set
of source-qualified crates is not an operable control plane.

## Decision

Create one production Rust composition root that assembles:

```text
snapshot builder -> hard policy -> candidate router -> scheduler
-> resource allocator -> execution dispatcher -> result verifier
-> commit sequencer -> event/read-model projection
```

The root holds orchestration capabilities only. It does not receive release,
KMS/HSM, WORM, portal, submission, or model credential authority. External work
passes through role-specific brokers and external authority ports.

## Consequences

Integration dependencies become explicit. End-to-end fake-provider, crash, and
replay tests can validate the actual target graph. Existing isolated crates that
are not reachable from the composition root cannot be described as an integrated
product capability.

## Adoption gates

`CTL-001` through `CTL-008`, module-registry admission, and exact-subject source
qualification must pass before production-host qualification begins.
