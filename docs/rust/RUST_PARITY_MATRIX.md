# Node-to-Rust parity and cutover matrix

This file is the canonical human parity projection of `current-status.v1.json`.
Every row has a stable `PAR-*` ID and its status is machine-compared with
`parityItemStatus`. Repository-authored source may declare
`source_implemented`; only exact-head retained evidence may derive
`source_qualified`. External/live-evaluation rows remain `blocked_external`.

Parity classifications:

- `exact` — bytes, hashes, rows, statuses and accept/reject decisions match;
- `semantic` — the versioned representation may differ but the invariant and effect class match;
- `evaluation` — non-deterministic model output is assessed with bound metrics, not text equality;
- `retire` — the behavior has no Rust target and requires retirement evidence.

## Deterministic capabilities

| ID | Capability | Node anchor | Rust target | Strategy | Static status | Effective cutover evidence |
|---|---|---|---|---|---|---|
| PAR-DET-001 | Record hashing | `workflow-kernel/record-hash.mjs` + call sites | compatibility kernel | exact | `source_implemented` | byte corpus + dual verifier |
| PAR-DET-002 | Stable JSON | historical serializers | `LegacyStableJsonV1` | exact | `source_implemented` | adversarial number/string/object corpus |
| PAR-DET-003 | Contract decode | `paper-domain`, `paper-ports` | protocol/domain contracts | exact V1 / semantic V2 | `source_implemented` | round-trip + unknown-field matrix |
| PAR-DET-004 | Error/status values | distributed constants | versioned registry | exact | `source_implemented` | generated inventory diff |
| PAR-DET-005 | SQLite schema 1–25 | store/migration modules | read-only projection + writer compatibility | exact logical state | `source_implemented` | normalized production-shaped DB diff |
| PAR-DET-006 | Campaign transitions | application/composition | campaign writer | semantic + exact effects | `source_implemented` | transition table + simulation |
| PAR-DET-007 | Lease/generation fencing | campaign repositories | writer store | exact invariant | `source_implemented` | stale-generation stress |
| PAR-DET-008 | Prepared results | attempt journals | broker/writer integration | semantic | `source_implemented` | crash recovery + exactly-once integration |
| PAR-DET-009 | Workspace inventory | attempts/snapshots | workspace authority | exact | `source_implemented` | cross-language tree corpus |
| PAR-DET-010 | Release receipt verification | release/authority modules | external-authority verifier | exact | `source_implemented` | old/new accept/reject matrix |
| PAR-DET-011 | Submission idempotency | outbox/dispatcher | submission authority port | exact identity | `source_implemented` | replay/ambiguity matrix |

## Codex execution behavior

| ID | Behavior | Node anchor | Rust strategy | Classification | Static status |
|---|---|---|---|---|---|
| PAR-CODEX-001 | Executable/config/auth-root identity | Node runtime preflight | filesystem/content identity pre/postflight | semantic, stricter V2 | `source_implemented` |
| PAR-CODEX-002 | Fresh sessions | Node capability/executor args | mandatory ephemeral new thread | exact invariant | `source_implemented` |
| PAR-CODEX-003 | Author/reviewer separation | Node principal pool | separate principals/sockets/homes | semantic, stronger | `source_implemented` |
| PAR-CODEX-004 | Bounded execution | Node bounded child process | durable gate + cgroup containment + supervisor | semantic | `source_implemented` |
| PAR-CODEX-005 | Mutation detection | Node workspace tracker | descriptor-bound before/after inventory | semantic, stronger | `source_implemented` |
| PAR-CODEX-006 | Structured final output | Node permissive result scans | bounded JSONL + output schema | fix-v2 | `source_implemented` |
| PAR-CODEX-007 | OpenClaw runtime | Managed OpenClaw paths | no Rust target | retire | `retired` |
| PAR-CODEX-008 | Model prose/code | Model-dependent output | live evaluation | evaluation | `blocked_external` |
| PAR-CODEX-009 | Reviewer narrative | Model-dependent output | structured verdict + live evaluation | evaluation | `blocked_external` |

## Dependency binding

Each parity row is bound to implementation backlog IDs in
`current-status.v1.json.parityDependencies`. A parity row cannot be effectively
promoted when any dependency is `not_started`, `design_ready`,
`source_implemented` without a successful exact-head result, or
`blocked_external` unless the parity row itself is explicitly external.

Rows with no implementation dependency are authority-bound ports or retired
behaviors. Their closure evidence is supplied by the external-package or
retirement contract, never by a self-signed source fixture.

## Behavior record required before porting or correction

```text
parity_id
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

## Legacy full-matrix rule

The public deterministic corpus is sufficient only for repository-local source
checks. Full historical migration acceptance additionally requires issue #28:
the secret-gated private companion must replay the exact 263-file archive
against the exact public candidate, retain its receipt and artifact index, prove
network isolation and cleanup, and receive independent acknowledgement.

## Never byte-difference

Manuscript prose, generated code, reviewer narrative, provider timing,
reasoning traces and token counts across model/runtime versions are evaluated
by bound inputs, permissions, schema validity, deterministic downstream checks
and quality metrics. They are never promoted by textual equality.

## Cutover rule

A Rust capability becomes authoritative only after:

1. its parity strategy and known defects are classified;
2. the exact source head passes the complete non-empty source matrix;
3. required full-matrix or live evaluation evidence is accepted;
4. production-shaped shadow evidence is accepted;
5. writer ownership is transferred atomically where applicable;
6. rollback has been exercised;
7. the Node authority path is disabled, not merely unused.

A source commit, GitHub-hosted fixture or implementation-author review cannot
cross an external authority boundary.
