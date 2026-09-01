# Global executable backlog

The machine work graph is `docs/system/truth/work-items.v2.json`. This projection
summarizes current closure order; scoped Rust implementation items remain in
`docs/rust/RUST_REWRITE_BACKLOG.md` to avoid a second copy of the same detailed
status.

## Gate order

| Gate | Priority work | Current static state |
|---|---|---|
| G0 | QUAL-001…005: exact base/head/merge and complete eligible-run history | design ready; independent decision blocked |
| G1 | SYS-001…006: singular truth, schemas, evidence bindings, history cleanup | source implemented; fresh exact-head qualification required |
| G2 | MOD-001…008: module registry, protocol, SDK and conformance | design ready; real team identities pending |
| G3 | CTL-001…008: Rust composition root, policy, dispatch, verification and sequencer | design ready |
| G4 | RES-001…007: hierarchical accounting, DRF, aging, reservations and bounded blocking | design ready |
| G5 | MIG/NODE/domain module items: capability inventory, adapters, shadow and cutover | current Node modules registered; migration implementation pending |
| G6 | SCH-001…007: deterministic scheduler, optimizer certificate, fallback and calibration | design ready |
| G7 | PERF/OBS/ORG: canonical workloads, SLOs, ownership and affected CI | design ready |
| G8 | governance, host, storage, key, Codex, release and legacy replay packages | blocked external |
| G9 | production-shaped shadow, canary and rollback | not started |
| G10 | atomic Rust authority transfer and Node retirement | not started |

## Status meanings

```text
not_started       no accepted design or implementation
design_ready      current contract and acceptance criteria exist
source_implemented source/tests or documentation control exist, but effective qualification is separate
blocked_external  repository work cannot manufacture the required fact
retired           intentionally removed with migration evidence
```

No gate closes because a source file exists. Closure requires the milestone's
exact evidence package, dependency closure, latest required review, and current
rollback/recovery disposition.

## Definition of done

Every applicable work item supplies:

```text
implementation or executable external package
positive, negative, adversarial and fault tests
capability, module and milestone links
authority and non-authority statement
protocol/state compatibility decision
resource, SLO and canonical workload impact
failure, reconciliation and rollback behavior
operator/observability impact
exact evidence tier and reviewer domain
remaining blockers and true owners
```

Validate the current global graph with:

```bash
node docs/tools/validate-development-docs.mjs
```
