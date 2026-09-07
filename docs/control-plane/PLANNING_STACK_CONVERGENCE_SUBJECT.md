# Planning stack convergence subject

This document binds the downstream planning-stack candidate to a fresh exact source subject after its canonical-convergence base changes.

## Scope

The stack composes only bounded, non-activating planning stages:

```text
candidate disposition collection
bounded snapshot read session
qualified producer collection
bounded plan selection
independent plan verification
planning pipeline composition
non-activating execution-command construction
```

Each stage consumes the exact protocol emitted by its predecessor. A stage may reject, quarantine or return an incomplete disposition; it may not repair authoritative state, invent producer currentness, reserve undeclared resources, execute a command, commit campaign state, contact a provider or grant authority.

## Exact identity

Qualification is valid only for one repository, pull request, base commit/tree, head commit/tree, tested prospective merge commit/tree/parents, workflow-definition set, complete run/attempt/job/step/artifact history and current non-author review. Any base or head movement invalidates prior CI, review and evidence.

## Required composition properties

The complete stack must prove:

- one immutable snapshot transaction, consistency epoch and component generation set;
- exact qualified producer identity, version, capability and currentness metadata;
- bounded producer count, candidate count, payload bytes, aggregate nodes, depth, queue and deadline;
- deterministic canonical ordering and hash domains over Unicode-scalar data;
- complete disposition for missing, stale, duplicate, late, malformed, oversize or conflicting producer output;
- selector feasibility under hard policy and declared resource envelopes;
- independent verifier recomputation from the same immutable inputs;
- no selection or verification result can become an execution effect without a later authority gate;
- every result fixes provider, writer, release, submission, production and external-authority flags to false.

## Failure and recovery

A timeout, cancellation, producer crash, snapshot-currentness failure, qualification drift, resource-price change, objective change or verifier disagreement invalidates the candidate plan and requires a new attempt bound to a new immutable subject. Partial output is never combined across attempts. Retry identity changes when any semantic input changes.

## Integration discipline

This source candidate is admitted only after the unchanged exact base/head/prospective-merge object passes focused planning controls, complete portable tests, static architecture, Rust checks, documentation and supply-chain gates and receives fresh independent review. Parent-branch evidence does not transfer.

Source integration remains non-activating. Target-host qualification, distributed recovery, objective calibration, shadow/canary, writer-generation transfer and final production authority are separate gates.
