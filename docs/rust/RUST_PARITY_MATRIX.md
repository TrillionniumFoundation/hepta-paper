# Node-to-Rust parity and cutover matrix

Parity is assigned before implementation. It is not a generic claim that Rust
“behaves the same”.

- `exact` — bytes, hashes, rows, statuses and acceptance/rejection match;
- `semantic` — invariant/outcome class match under a versioned representation;
- `evaluation` — non-deterministic output is judged by metrics, never text equality;
- `retire` — behavior has no Rust target and has migration evidence.

## Deterministic capabilities

| Capability | Node anchor | Rust target | Strategy | State | Cutover evidence |
|---|---|---|---|---|---|
| Record hashing | `workflow-kernel/record-hash.mjs` + callsites | compatibility kernel | exact | not_started | byte corpus + dual verifier |
| Stable JSON | historical serializers | `LegacyStableJsonV1` | exact | not_started | adversarial number/string/object corpus |
| Contract decode | `paper-domain`, `paper-ports` | domain crates | exact V1 / semantic V2 | partial | round-trip + unknown-field matrix |
| Error/status values | distributed constants | registry crate | exact | design_ready | generated inventory diff |
| SQLite schema 1–25 | store/migration modules | read-only then writer store | exact logical state | not_started | normalized production-shaped DB diff |
| Campaign transitions | application/composition | campaign engine | semantic + exact effects | not_started | transition table + simulation |
| Lease/generation fencing | campaign repositories | writer store | exact invariant | not_started | stale-generation stress |
| Prepared results | attempt journals | campaign integration | semantic | broker_partial | crash recovery + exactly-once integration |
| Workspace inventory | attempts/snapshots | workspace/CAS crates | exact | not_started | cross-language tree corpus |
| Release receipt verification | release/authority modules | release verifier | exact | not_started | old/new accept/reject matrix |
| Submission idempotency | outbox/dispatcher | dispatcher port | exact identity | not_started | replay/ambiguity matrix |

## Codex execution behavior

| Behavior | Node anchor | Rust strategy | Classification | State |
|---|---|---|---|---|
| Executable/config/auth-root identity | runtime preflight | filesystem/content identity pre/postflight | semantic, stricter V2 | source_qualified |
| Fresh sessions | capability/executor args | mandatory ephemeral new thread | exact invariant | source_qualified |
| Author/reviewer separation | principal pool | separate principals/sockets/homes | semantic, stronger | source_partial |
| Bounded execution | bounded child process | gate + containment + supervisor | semantic | process-group source_qualified; cgroup open |
| Mutation detection | workspace tracker | exact before/after inventory | semantic, stronger | not_started |
| Structured final output | permissive scans | terminal JSONL + output schema | fix-v2 | source_qualified |
| OpenClaw runtime | managed OpenClaw paths | no target | retire | design_ready |
| Model prose/code | model dependent | live evaluation | evaluation | not_started |
| Reviewer narrative | model dependent | structured verdict + evaluation | evaluation | not_started |

## Behavior record required before porting

```text
behavior_id
source_entrypoints
source_tests
observed_behavior
required_invariant
strategy
known_defects
versioning_decision
rust_owner
oracle_or_metric
cutover_gate
rollback_path
last_verified_commit/tree
```

## Differential failure classes

| Class | Meaning | Disposition |
|---|---|---|
| `encoding_byte_drift` | deterministic bytes differ | blocker |
| `hash_drift` | record/receipt hash differs | blocker |
| `logical_state_drift` | normalized SQLite differs | blocker |
| `authority_drift` | one side accepts authority rejected by the other | blocker + security review |
| `known_defect_correction` | approved V2 correction | ADR + migration required |
| `representation_only` | versioned internal shape differs, invariant equal | semantic proof required |
| `model_nondeterminism` | generated content differs | evaluation, not byte blocker |
| `legacy_retirement` | behavior intentionally absent | retirement evidence required |

## Never byte-difference

Manuscript prose, generated code, reviewer narrative, provider timing, reasoning
traces and token counts across different model/runtime versions are evaluated by
bound inputs, permissions, schema validity, deterministic downstream checks and
quality metrics.

## Cutover rule

A Rust capability becomes authoritative only after:

1. parity strategy and defects are classified;
2. the source gate passes;
3. production-shaped shadow evidence is accepted;
4. writer ownership is transferred atomically where applicable;
5. rollback has been exercised;
6. the Node authority path is disabled, not merely unused.
