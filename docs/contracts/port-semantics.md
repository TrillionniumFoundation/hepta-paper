# Port semantics and adapter conformance

Status: normative

## Scope

This contract applies to every boundary exported from `paper-ports/`, every service admitted to an application `ExecutionContext`, and every concrete adapter that implements such a boundary.

## Structural contract

A port exposes the smallest capability required by one use case. Its assertion function validates required operations and rejects ambiguous or extra authority where the contract requires an exact surface. Ports accept validated, versioned values rather than raw environment, CLI, or provider objects.

The application service catalog names every service-locator dependency. Adding a service requires a port decision, an execution-profile decision, a composition binding, an adapter conformance test, and documentation.

## Common semantic fields

Each operation must define:

- preconditions and postconditions;
- result and error variants;
- idempotency key or explicit non-idempotence;
- ordering and consistency guarantees;
- cancellation observation points;
- deadline and timeout ownership;
- retry ownership and retryable failures;
- transaction or unit-of-work boundary;
- concurrency and fencing behavior;
- data-size and resource limits;
- persistence and durability level;
- sensitive-data and logging policy;
- receipt fields and authority required by downstream gates.

An adapter must not strengthen its marketing claim beyond the weakest verified semantic field.

## Failure, retry, and cancellation

Validation failures are deterministic and not retryable. Contention, transient provider failure, or unavailable runtime may be retryable only when the port says so and the operation is idempotent or fenced. Unknown external outcomes are reconciled against the remote system; they are never blindly retried.

Cancellation is advisory before an external action and must become a recorded outcome once the action may have occurred. A timeout does not prove that a provider did nothing. Prepared results and externally visible side effects survive process cancellation and must be recovered or reconciled.

## Stores and ledgers

Store operations define transaction isolation, compare-and-set or generation conditions, uniqueness, read consistency, and durability. Receipt ledgers are append-only; correction occurs through replacement, qualification, supersession, or tombstone records defined by the owning contract. A caller-supplied boolean cannot grant trusted-writer status.

File and SQLite adapters must use no-follow path validation, exclusive creation or atomic replacement where required, descriptor/inode rechecks across sensitive windows, and durable directory synchronization for publication operations.

## Workers and runtimes

Worker execution binds one single-use execution identity to the declared command, runtime image or host runtime, input snapshot, dataset snapshot, resource limits, network policy, attempt, and artifact export list. Tags resolve to digests before execution. Unsupported isolation or resource controls fail closed.

Worker success means the declared process and artifact contract passed. It does not establish the scientific meaning of the result; formal, empirical, reproducibility, and promotion verifiers remain separate.

## Submission and remote mutation

Submission ports are split into query, handoff/export, durable outbox, provider action, reconciliation, and live authorization capabilities. A local package or approval packet cannot be cast into provider authority. Remote mutation requires exact package, venue, provider, account, authorization, challenge, and current trust bindings at action time.

## Conformance suite

Every adapter must run the shared positive and negative contract cases plus adapter-specific fault injection. Required negative cases include malformed values, duplicate invocation, stale generation, cancellation before and after preparation, timeout with unknown outcome, partial persistence, restart recovery, path substitution, authority rotation, and unsupported capability.

A new implementation is not production eligible until composition selects it only for profiles whose required semantics it demonstrably satisfies.
