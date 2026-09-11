# Global system invariants

These invariants apply across languages, modules, processes, deployments, and
migration phases. A violation is not an optimizer tradeoff.

## Authority and state

| ID | Invariant |
|---|---|
| INV-001 | Exactly one authoritative campaign writer is active. |
| INV-002 | Every state mutation is fenced by campaign revision, attempt ID, and writer/lease generation. |
| INV-003 | Provider execution cannot write campaign state, qualification ledgers, release state, or submission outboxes. |
| INV-004 | Reviewer roles cannot mutate author attempt state or canonical source. |
| INV-005 | Release and submission authority remain outside model execution and the central scheduler. |
| INV-006 | Only the commit sequencer may perform authoritative campaign-state commits. |
| INV-007 | A module cannot increase its authority through its manifest, output, health report, or self-issued evidence. |
| INV-008 | Read access, prepared-result creation, central write, and external-effect authority are distinct capabilities. |

## Planning and optimization

| ID | Invariant |
|---|---|
| INV-009 | Every plan binds an immutable state snapshot, candidate set, constraint set, objective, module-version set, and plan hash. |
| INV-010 | Hard constraints are validated independently of the selected optimizer. |
| INV-011 | Identical deterministic inputs produce an identical plan hash; stochastic planning binds an explicit seed. |
| INV-012 | Modules submit feasible candidates or a justified singleton; a local preferred action is never automatically selected. |
| INV-013 | Module-reported value, cost, duration, and risk remain predictions until independently observed and reconciled. |
| INV-014 | A claim of model-global optimality includes the best bound and zero gap; near-optimality includes a nonzero explicit gap. |
| INV-015 | Optimizer timeout or failure enters a deterministic safe fallback and never bypasses policy. |
| INV-016 | Plan execution after snapshot drift requires validation or re-planning; stale plans cannot commit. |

## Resource and concurrency

| ID | Invariant |
|---|---|
| INV-017 | CPU, GPU, memory, storage, token, provider, and external-action use is reserved before execution. |
| INV-018 | Module child concurrency is bounded by its declared and admitted resource envelope. |
| INV-019 | No canonical workload permits indefinite starvation. |
| INV-020 | Resource loss, lease loss, pause, cancellation, or generation replacement prevents late integration. |
| INV-021 | Backpressure is explicit; overload returns a bounded machine disposition rather than unbounded queues or threads. |
| INV-022 | Central writer serialization covers only short authoritative transactions, not expensive module execution. |

## Execution and recovery

| ID | Invariant |
|---|---|
| INV-023 | Every external operation has durable identity and idempotency before its irreversible effect. |
| INV-024 | Unknown post-release outcome is treated conservatively and does not blindly repeat provider or external work. |
| INV-025 | Prepared results survive restart and integrate without repeating provider work. |
| INV-026 | Unknown terminal-like events, unclassified residue, and identity mismatches fail closed. |
| INV-027 | Cancellation reaches the complete qualified execution boundary and stale completion cannot commit. |
| INV-028 | Recovery disposition is derived from durable facts, not process absence or agent self-report. |

## Workspace, artifacts, and compatibility

| ID | Invariant |
|---|---|
| INV-029 | Mutable work executes in attempt-owned isolated workspaces; canonical source changes only through fenced integration. |
| INV-030 | Actual filesystem inventory and bytes, not an agent report, define mutation truth. |
| INV-031 | Historical V1 canonicalization and hashes remain immutable. |
| INV-032 | Language migration never upgrades scientific assurance or evidence tier. |
| INV-033 | Compatibility, migration, experimental, and historical code cannot enter a production authority graph implicitly. |
| INV-034 | Every protocol/schema change has an explicit compatibility and retirement decision. |

## Modules and organization

| ID | Invariant |
|---|---|
| INV-035 | Every production module is registered with a stable ID, exact version, capabilities, authority, protocol range, SLO, and rollback. |
| INV-036 | Every module has primary and secondary ownership plus an independent reviewer for authority-bearing changes. |
| INV-037 | Module implementations depend on public contracts, not another module's private source. |
| INV-038 | Module qualification binds module-specific tests and workloads; global CI success alone is not module qualification. |
| INV-039 | A missing owner, expired qualification, incompatible protocol, or unknown version removes the module from admission. |

## Evidence and documentation

| ID | Invariant |
|---|---|
| INV-040 | Source, hosted, target-host, and external-authority evidence tiers are never substituted for one another. |
| INV-041 | Effective qualification binds exact repository, base, head, merge subject, workflow definitions, complete eligible run history, jobs, steps, artifacts, and current review. |
| INV-042 | Any mutation of the bound qualification subject or evidence invalidates the prior artifact until fresh derivation succeeds. |
| INV-043 | Committed documents record static truth only; they do not self-qualify or activate production. |
| INV-044 | Every retained development document is declared in the document manifest; superseded development documents are absent from the working tree. |
| INV-045 | Git history is the archive. Historical prose cannot override current machine truth. |

## Automatic P0 incidents

Regardless of likelihood score, the following are P0:

- credential or private-key disclosure;
- duplicate provider, release, deletion, portal, or submission effect;
- stale-generation or out-of-plan authoritative commit;
- second active campaign writer;
- historical hash drift;
- signal sent to an unproven process identity;
- unreserved resource execution;
- hard-constraint bypass by an optimizer or module;
- module gaining undeclared authority;
- source or fixture evidence being labeled target-host or external authority;
- stale qualification remaining current after base/head/merge/run/review mutation;
- production use of an unregistered, unowned, incompatible, or expired module;
- a superseded document being treated as current development truth.
