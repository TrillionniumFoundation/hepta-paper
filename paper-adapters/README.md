# paper-adapters

Status: normative module guide

## Purpose

`paper-adapters` implements the external effects declared by `paper-ports`: persistence, artifact and archive storage, workers and runtimes, authority verification, packaging, inventory, journal policy, proposal and review flows, submission infrastructure, and workspace access. Adapters report verifiable facts; they do not own domain acceptance policy.

## Responsibilities

Major families include:

- `archives/` and `artifacts/`: no-follow, hash-bound storage and immutable inventories;
- `persistence/`: native SQLite stores, sessions, ledgers, and repositories;
- `automation/` and `runtime/`: campaign workers, resource/runtime integration, and recovery support;
- `research-verify/` and `empirical-analysis/`: formal/empirical execution and bounded compatibility analysis;
- `build-package/`: LaTeX build, package construction, and local acceptance receipts;
- `authority/` and `governance/`: trust-store and authority evidence verification;
- `proposal/`, `inventory/`, `journal-manage/`, `referee-review/`, and `referee-revise/`: native paper lifecycle adapters;
- `submission/`: durable handoff, outbox, provider result intake, and reconciliation boundaries;
- `experimental/`: explicitly non-production implementations.

The legacy empirical adapter is compatibility-only. Deterministic proposal and referee personas are local workflow tools, not academic or submission authorities.

## Dependencies

Adapters may import ports, domain, and kernel modules. Production adapters may not import application or composition policy. They may not use `paper-core` or `core/src` as hidden contract owners. Compatibility imports are explicit, manifest-bound, and unreachable from the production graph.

## Contracts

Every adapter implements the full semantics in [`../docs/contracts/port-semantics.md`](../docs/contracts/port-semantics.md), including idempotency, ordering, cancellation, timeout ambiguity, retry ownership, transaction/fencing behavior, durability, limits, security, and receipts.

Filesystem implementations pin paths and inodes across sensitive windows. SQLite implementations preserve typed state and append-only ledgers. Worker implementations bind exact runtime/input identities and resource policy. Provider implementations separate local preparation from remote mutation and reconciliation.

## Failure and recovery

Adapters return typed failure evidence. They preserve prepared results and partial durable state needed for restart. Unknown remote outcomes remain unknown until reconciled. Cleanup operates only on attempt-owned or lifecycle-authorized paths and fails closed on substitution or ambiguity.

A local build, simulated experiment, deterministic review, or provider sandbox result cannot be promoted by an adapter beyond its verified evidence class.

## Security

Untrusted paths, archives, JSON, model output, datasets, commands, and provider responses are validated and bounded. Network access, command execution, credentials, and writable roots are explicit. Runtime images and dependencies use immutable identities. Same-UID writers with access to protected roots remain part of the trusted computing base.

## Testing

Each adapter runs its shared port conformance suite plus implementation-specific fault injection: malformed input, duplicate invocation, stale lease, interrupted write, restart, path race, authority rotation, resource exhaustion, network ambiguity, and cleanup failure. Production composition wiring has dedicated reachability tests.

## Change rules

A new adapter needs an existing or new precise port, documented external assumptions, conformance tests, composition selection rules, observability, and a security review. Do not import old workers or report-control-plane code as runtime authority. New features are forbidden in frozen compatibility adapters except security and migration fixes.
