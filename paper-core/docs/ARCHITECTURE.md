# hepta-paper Node implementation architecture

This document describes the **current Node implementation**. The normative
whole-system target architecture is
[`../../docs/system/ARCHITECTURE.md`](../../docs/system/ARCHITECTURE.md), and the
Rust migration plan is
[`../../docs/rust/RUST_REWRITE_MASTER_PLAN.md`](../../docs/rust/RUST_REWRITE_MASTER_PLAN.md).
This scoped projection cannot override global capability, module, milestone, or
authority truth.

## Source layers

- `workflow-kernel/` owns domain-neutral identity, canonical hashing, time,
  process, filesystem, and small runtime protocols.
- `paper-domain/` owns pure paper, research, evidence, campaign, journal, and
  submission policy.
- `paper-ports/` defines typed capabilities and contains no concrete adapter.
- `paper-application/` orchestrates use cases over injected ports and does not
  import SQL, CLI, or concrete adapters.
- `paper-adapters/` implements persistence, filesystems, runtimes, providers,
  artifacts, and external integrations.
- `paper-composition/` is the current Node composition boundary.
- `paper-core/bin/` and `paper-core/src/` expose CLI, verification, and bounded
  compatibility surfaces rather than a second policy layer.

The vendored `core/` tree is a hash-bound reference package. Production graphs
must not import `core/src`.

## Current authority

The Node campaign store and composition graph remain authoritative until a
specific capability completes registered shadow, canary, rollback, and cutover.
SQLite state changes flow through injected store capabilities with campaign
revision, attempt, lease-generation, and prepared-result fencing.

Release and submission are separately authorized. Research execution receives
no writable release, immutable-storage, portal, or submission capability.

## Campaign and execution model

The campaign DAG is the sole automation authority. Ready nodes are claimed with
bounded leases and may execute concurrently under campaign and global resource
limits. Mutable work occurs in attempt-owned workspaces; actual before/after
filesystem inventory determines mutation truth. Prepared results survive crash
and are integrated only by a current fenced state transition.

Generated Python, Node, R, Julia, Lean, and LaTeX are executed in bounded
runtimes and verified rather than trusted from prose. Author and reviewer roles
use separated process/workspace/credential identities where the selected
backend supports the required boundary.

## Resource model: current and target

The current Node resource governor limits agent, CPU, GPU, and memory capacity
and supports cancellation. It is a capacity control, not the final global
scheduler. The target adds hierarchical accounting, dominant-resource fairness,
aging, large-job reservations, starvation bounds, provider/token/cost quotas,
and a central candidate-based planner. See
[`../../docs/control-plane/RESOURCE_MODEL.md`](../../docs/control-plane/RESOURCE_MODEL.md).

## Evidence and external effects

Generated claims are distinct from verified evidence. Formal, empirical,
numerical, release, and submission results bind exact campaign, attempt, source,
runtime, artifact, and authority identities. A local verifier or fixture cannot
self-upgrade its evidence tier.

External effects use durable intent, idempotency, bounded authorization, and
remote reconciliation after ambiguity. A timeout does not prove that no effect
occurred.

## Migration boundary

Current Node capabilities are registered behind the common module model before
replacement. Rust implementations proceed through:

```text
contract ready -> source implemented -> qualified -> shadow -> canary
-> authoritative -> Node path retired
```

At most one implementation may own a central-write or external-effect mutual-
exclusion group. The Node path is retired only after its service, credentials,
queues, schedules, imports, and write authority are mechanically unreachable.

## Architecture gates

The current Node graph remains subject to:

```bash
node --test paper-core/tests/architecture-conformance.test.mjs
node --test paper-core/tests/repository-module-imports.test.mjs
npm run static:check
npm run safety:all
node docs/tools/validate-development-docs.mjs
```

The full locked environment and exact-head evidence are required before any
qualification claim.
