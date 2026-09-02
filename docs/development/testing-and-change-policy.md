# Testing and change policy

Status: normative

## Scope

This policy defines the evidence required to change source, contracts, adapters, composition, storage, scientific behavior, security boundaries, documentation, and releases.

## Local validation lanes

Use the smallest lane that proves the change while iterating:

- syntax and lint for source shape;
- architecture and repository-import tests for dependency ownership;
- focused unit or contract tests for behavior;
- port conformance tests for adapter substitutions;
- impacted-test planning for a pull request;
- safety P0/P1/P2 for integrity, typed handoff, and architecture policy;
- repository and system coverage for release-affecting changes;
- operational tests only on hosts that satisfy their declared prerequisites.

Before review, run `npm run static:check`, `npm run security:npm-audit`, the impacted suite, and the documentation integrity command. Before release, run the documented isolated release path; do not replace an unavailable operational prerequisite with a fixture.

## Change evidence

A complete change includes:

1. owning contract or policy;
2. implementation in the canonical layer;
3. positive, negative, concurrency, and recovery tests appropriate to risk;
4. migration or compatibility plan for persisted/external consumers;
5. documentation and examples;
6. security and scientific traceability updates where relevant;
7. a clear statement of evidence class and remaining external blockers.

Generated files or hashes are refreshed by their canonical tool and reviewed in the same change.

## Risk-specific requirements

- A new domain invariant needs adversarial validation and architecture purity coverage.
- A new port needs full semantic fields and a shared conformance suite.
- A new adapter needs fault injection, resource cleanup, and unsupported-capability tests.
- A new external action needs durable intent/outbox, single-use authority, timeout ambiguity, and reconciliation.
- A new migration needs forward application, idempotent detection, backup, restore, and old/new reader tests.
- A new numerical or scientific path needs assumptions, tolerance, independent oracle or justified alternative, reproducibility manifest, and claim traceability.
- A new trust boundary needs threat-model updates and negative authority tests.

## Pull-request review

The pull-request template records architecture, contract, documentation, migration, security, scientific, and operational impact. Reviewers verify that no compatibility facade, fixture, self-signed record, local admin, or test name is presented as stronger authority.

Changes to required checks, workflow permissions, trust stores, release gates, deletion, submission, key handling, runtime images, or migration evidence require an explicit rationale and focused review.

## Completion criteria

A code change is not complete merely because tests pass. It is complete when the canonical owner is unambiguous, all affected consumers are handled, failure/recovery behavior is specified, documentation links resolve, the relevant CI checks pass on the exact head commit, and remaining blockers are accurately reported.

External evidence that is unavailable is not a software gap to be closed by fabrication. The implementation must instead provide a precise intake contract and remain fail closed.
