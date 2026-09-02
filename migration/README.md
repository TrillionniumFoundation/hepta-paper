# migration

Status: normative module guide

## Purpose

`migration` preserves and verifies the transition from retired legacy sources to the native hepta-paper architecture. It owns semantic disposition evidence, capability classification, immutable fixtures, differential replay, owner/observer evidence intake, and retirement audit. It is not a production workflow engine.

## Responsibilities

`legacy-semantic-migration-matrix.json` is the sole source of verified legacy semantic disposition claims. The matrix binds exact legacy source hashes/symbols, current target hashes/symbols, and behavior-test hashes.

The current matrix distinguishes behavioral replacements from explicit retirements. Capability matrices further distinguish permanent retirement, superseded coverage obligations, and reimplementation obligations. Technical implementation, local administrative acceptance, independent external-owner acceptance, source-bound conformance replay, and independent operational proof remain separate axes; current counts live in `paper-core/docs/CURRENT_STATUS.md`.

`bin/`, `tests/`, `fixtures/`, and `retirement/` build, verify, replay, and audit this evidence without entering the production graph.

## Dependencies

Migration tooling may read current canonical contracts and immutable legacy/reference evidence for verification. Production modules may not import migration retirement code. A migration helper cannot become a runtime store, worker registry, command router, or authority source.

## Contracts

Each matrix entry has a stable identity, source/target hashes and symbols, behavior tests, disposition, capability family, acceptance state, and retirement or replacement rationale. Hash drift invalidates the claim until the canonical refresh/review process updates it.

A retirement explicitly means no semantic parity. A local replay proves only the behavior and source snapshot it binds.

## Failure and recovery

Verification is read-only unless a command explicitly writes a refreshed generated artifact. A partial refresh must not be treated as current evidence. Generated matrices/receipts are deterministic and reviewed atomically with the source or test change that caused them.

Missing source, hash drift, duplicate identities, absent tests, unsupported capability, or missing external signature blocks the corresponding axis rather than being auto-accepted.

## Security

Legacy data, scripts, and fixtures are untrusted/read-only inputs. Tooling prevents path escape and does not execute arbitrary retired code outside isolated differential fixtures. Local administrators must not impersonate independent external owners or observers.

## Testing

Matrix integrity tests verify schema, uniqueness, exact hashes, target reachability, behavior-test execution, capability classification, and retirement isolation. Differential tests run from immutable minimal fixtures. Production architecture tests prove migration code is unreachable from active object graphs.

## Change rules

Use [`../docs/migrations/migration-policy.md`](../docs/migrations/migration-policy.md). New functionality is implemented against current domain contracts and ports. Update matrix evidence only through the deterministic tool, include the affected source/tests in the same review, and preserve historical receipts.
