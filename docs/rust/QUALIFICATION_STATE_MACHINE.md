# Rust rewrite qualification state machine

## Purpose

This document defines the only permitted promotion, invalidation and demotion
rules for the `hepta-paper` Rust control-plane rewrite. It prevents committed
source prose from granting itself a stronger status than the evidence actually
establishes.

The static source is `current-status.v1.json`. Exact-head workflows may derive
an `effective-status.v1.json` artifact for one immutable commit/tree. The
derived artifact never edits source and never grants production authority.

## State dimensions

Capability status and evidence tier are independent.

| Capability status | Meaning |
|---|---|
| `not_started` | No accepted implementation exists. |
| `design_ready` | A reviewed contract and acceptance criteria exist. |
| `source_implemented` | Source and tests exist; exact-head qualification is still required. |
| `source_qualified` | A derived artifact proves the complete required source matrix on one exact head/tree. |
| `hosted_installed_qualified` | Disposable hosted installation tests passed with real OS objects and principals. |
| `target_host_qualified` | A separately controlled target host passed the required drill. |
| `external_authority_qualified` | A separately controlled authority issued accepted evidence. |
| `blocked_external` | Repository work cannot manufacture the missing fact. |
| `retired` | The behavior is intentionally absent and retirement evidence exists. |

| Evidence tier | Establishes | Does not establish |
|---|---|---|
| `none` | no accepted evidence | any executable or authority claim |
| `design` | reviewed contract | implementation |
| `source` | exact source behavior under deterministic gates | target-host or credential custody |
| `hosted_installed` | installed behavior on a disposable hosted runner | production host ownership |
| `target_host` | named host and service behavior | unrelated external authority |
| `external_authority` | separately controlled authority decision | unrelated capabilities |

## Static versus effective truth

The repository may commit only static facts:

```text
source_implemented
blocked_external
retired
```

A committed document must not self-promote an implementation to
`source_qualified`. Promotion is derived from check-run and exact-source
evidence after the commit exists.

The effective artifact contains:

```text
schemaVersion
kind
repository
commit
tree
workflow
runId
runAttempt
requiredContexts
observedChecks
staticTruthSha256
effectiveCapabilityStatus
effectiveBacklogStatus
effectiveParityStatus
authority
```

`authority.productionAuthorized` and
`authority.externalAuthorityClaimed` must remain `false`.

## Promotion rules

### `source_implemented` → `source_qualified`

Promotion is permitted only when all conditions hold for the exact same
commit/tree:

1. The checked-out commit equals the pull-request head SHA.
2. The worktree is clean before and after validation.
3. Every required context appears at least once.
4. The latest completed run for every required context concludes `success`.
5. No required context concludes `skipped`, `neutral`, `cancelled`,
   `timed_out`, `action_required`, `failure` or `stale`.
6. Program truth, backlog, parity and external-package maps are semantically
   consistent.
7. Rust format, Clippy, tests, rustdoc, supply-chain, Node static gates,
   impacted tests and installed qualification gates are represented.
8. The result artifact binds the exact workflow/run/head/tree and the digest of
   static machine truth.

A zero-job check-run collection is failure, not absence of evidence.

### `source_qualified` → `hosted_installed_qualified`

This requires an installed test package that additionally binds the disposable
host image, kernel, UID/GID topology, filesystem objects, service configuration
and produced artifact hashes. It never establishes production target-host
custody.

### `hosted_installed_qualified` → `target_host_qualified`

This requires the issue-specific target-host evidence package, exact installed
artifacts, destructive/fault drills where required and an independent reviewer.
Repository CI cannot perform this promotion.

### `blocked_external` → external qualified state

Only the mapped external package and its named independent authority can
promote an external gap. A repository fixture, administrator prose, screenshot,
self-signed key or implementation-author approval is never sufficient.

## Invalidation and demotion

An effective source qualification is invalid immediately when any of the
following occurs:

- the branch head, commit tree or relevant workflow changes;
- a required check is rerun and no longer succeeds;
- a required job is absent or skipped;
- an artifact, lockfile, schema, policy or dependency digest changes;
- the worktree is dirty after a gate;
- a new P0 defect is accepted against the qualified capability;
- a review is dismissed, becomes stale or requests changes;
- retained evidence expires or becomes unavailable;
- an external package is revoked, superseded or fails re-verification.

The static source remains `source_implemented`; the effective status falls back
to that static state. External states fall back to `blocked_external` unless a
different accepted state is explicitly supported by the package lifecycle.

Demotion is not a failure of governance. Refusing to demote after invalidation
is a governance failure.

## Dependency closure

A capability or parity row may be promoted only when all declared dependencies
are promotable on the same exact head. Dependencies are stored in
`current-status.v1.json`.

The following are prohibited:

```text
qualified parent with unimplemented dependency
qualified parity row with blocked deterministic dependency
production cutover with an open external prerequisite
inheriting a predecessor PR's checks after a head change
combining evidence from different source trees
```

## Review rule

A workflow artifact establishes mechanical evidence only. Merge and external
promotion still require the reviewer roles fixed by the merge contract.

The implementation author may explain or repair a result but cannot supply the
independent review, target-host operator, credential owner, key owner, release
authority or submission authority required by an external gap.

## Effective artifact acceptance

An effective artifact is accepted only when:

```text
artifact commit == live PR head
artifact tree == live PR head tree
artifact staticTruthSha256 == current machine truth digest
every required context is successful
no later run invalidates a required context
latest-push review requirements are satisfied
```

The artifact is informational until branch protection and the merge authority
accept it. It cannot merge a pull request, load credentials, write production
state, sign a release or submit a paper.

## Supplemental migration blockers

`LEGACY-REPLAY-001` is tracked separately from the authority package map because
it is a confidential historical replay dependency, not a production authority.
It is nevertheless release blocking. It closes only with a retained
secret-gated hosted replay receipt/index for the exact 263-file archive and
candidate, plus independent acknowledgement.

## Stop conditions

Stop promotion and retain fail-closed status when:

- any identity cannot be proven;
- a required check reports no job;
- exact source and evidence do not match;
- a failure residue has no deterministic recovery state;
- a proposed fix would create dual writers;
- a local fixture would be used to impersonate an external authority;
- the evidence package cannot be independently reviewed.
