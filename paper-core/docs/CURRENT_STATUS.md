# hepta-paper Node implementation status

This is the current scoped status for the Node implementation. Whole-system
status is [`../../docs/system/CURRENT_STATUS.md`](../../docs/system/CURRENT_STATUS.md).
Historical remediation notes and dated snapshots are available through Git
history and are not current development authority.

## Current role

The Node control plane remains the active campaign and automation authority under
its existing repository, runtime, evidence, and external-action gates. The Rust
work is additive and disabled for production authority until capability-specific
cutover is accepted.

## Current architecture

```text
workflow-kernel -> paper-domain -> paper-ports -> paper-application
                                      -> paper-adapters
                                      -> paper-composition
                                      -> paper-core entrypoints
```

`paper-composition` selects concrete adapters. Application/domain modules do not
import adapter or CLI policy. The vendored `core/` reference package is not a
production dependency.

## Campaign and concurrency state

- Campaign DAG state is the sole automation authority.
- Running work is fenced by campaign revision, attempt ID, lease generation, and
  worker identity.
- Ready nodes may execute concurrently through bounded claims and global
  agent/CPU/GPU/memory capacity.
- Provider, empirical, formal, numerical, build, and review work returns
  prepared results before authoritative integration.
- Pause, cancel, lease loss, process death, and stale completion prevent late
  integration.
- Startup reconciliation handles expired leases, outstanding reservations,
  prepared results, and known durable external-action states.

The current resource governor is intentionally described as capacity control,
not a proof of global optimization or starvation-free multi-resource fairness.
Those upgrades are tracked by the global RES/SCH/PERF workstreams.

## Workspace and artifact state

Mutable work uses private attempt workspaces and bounded runtime roots. Source,
dataset, image, executable, configuration, and artifact identities are checked
before trusted use. Actual filesystem inventories—not agent self-report—define
mutation. Publication and deletion paths use generation fencing, no-clobber
moves, durable intent, exact inventory, and recovery protection.

## Research and evidence state

The current system supports bounded research planning, authoring, code work,
formal and empirical orchestration, numerical/GPU execution, manuscript build,
independent review rounds, revision, and evidence/package validation.

Evidence promotion remains tiered:

```text
generated claim
-> deterministic/local verification
-> source or hosted qualification
-> target-host evidence where required
-> independently controlled external authority where required
```

A model narrative, local fixture, self-signed record, or repository-admin prose
cannot replace an independent verifier or authority.

## Release and submission boundary

Local package construction and a sealed submission handoff do not perform a live
submission. Live release signing, immutable-storage mutation, portal access, and
submission require separately provisioned and current external capabilities,
durable action journals, exact idempotency identity, and reconciliation after
uncertain outcomes.

No repository document or hosted CI result activates those effects.

## Migration status

The target migration is capability-based rather than a single rewrite
percentage. Current next steps are:

1. close exact qualification-subject defects for the Rust RC;
2. qualify the global documentation and machine-truth tree;
3. implement the module registry/protocol and Node legacy adapter;
4. assemble the Rust central control-plane vertical slice;
5. add hierarchical resource fairness and canonical performance workloads;
6. shadow and canary one capability at a time;
7. transfer writer/external authority atomically and retire the matching Node
   path only after rollback and independent evidence.

## External blockers

The following remain outside repository-local proof:

- protected-main policy export, denial probes, and independent decision;
- private 263-file legacy replay and acknowledgement;
- target-host listener, systemd, cgroup, storage, reboot, corruption, and soak;
- independent capability-key lifecycle;
- real separated Codex author/reviewer credential canaries;
- KMS/HSM, immutable-storage, release, portal, and submission receipts.

## Current validation surface

```bash
node docs/tools/validate-development-docs.mjs
npm run scripts:check
npm run security:source-gate
npm run release:state-check
npm run static:check
npm run safety:all
```

Local command success does not replace the full locked CI matrix, exact source
subject, latest-push review, target-host operation, or external-authority
evidence.
