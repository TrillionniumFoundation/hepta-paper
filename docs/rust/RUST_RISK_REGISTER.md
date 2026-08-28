# Rust rewrite risk register

Risk scores use likelihood and impact from 1 (low) to 5 (critical). The register
is reviewed at every milestone gate and whenever a TCB boundary changes.

| ID | Risk | L | I | Early signal | Mitigation | Gate owner |
|---|---|---:|---:|---|---|---|
| RR-001 | Untrusted Node baseline becomes a permanent oracle | 3 | 5 | fixture results change with baseline checkout | freeze signed commit, lockfile and oracle image; remove network/secrets | Compatibility |
| RR-002 | Canonical hash drift invalidates history | 4 | 5 | first adversarial fixtures mismatch | immutable V1 spec, byte corpus, dual verifier | Compatibility |
| RR-003 | Node and Rust become concurrent writers | 2 | 5 | both processes hold writer capabilities | explicit ownership lease and cutover migration; no dual-write tests | Database |
| RR-004 | Codex credential leaks into generated commands | 3 | 5 | `env` or `/proc` probe sees provider secret | parent/child environment separation, distinct UIDs, qualification attack suite | Security |
| RR-005 | Reviewer is only nominally independent | 4 | 4 | shared home/session/workspace or account claims | independence levels, frozen bundle, fresh session, truthful receipts | Evidence |
| RR-006 | Post-spawn crash causes duplicate paid calls | 4 | 4 | retry lacks durable operation lookup | broker journal, idempotency index, ambiguous result classification | Broker |
| RR-007 | Permissive JSONL parser treats protocol drift as success | 3 | 5 | new terminal event appears in logs | unknown terminal-like fail-closed, qualification fixtures | Broker |
| RR-008 | Agent self-report bypasses mutation policy | 3 | 5 | claimed paths differ from filesystem | authoritative before/after inventory | Workspace |
| RR-009 | Rust rewrite copies existing defects as “parity” | 4 | 4 | issue described only as matching Node | disposition ledger and ADR for V2 correction | Architecture |
| RR-010 | Generic provider abstraction delays usable system | 4 | 3 | provider plug-in work without second provider | narrow author/reviewer ports, Codex-only composition | Product |
| RR-011 | App Server experimental protocol expands TCB | 3 | 4 | production dependency on JSON-RPC/WebSocket | exec JSONL V1 only; separate future ADR/qualification | Broker |
| RR-012 | Hidden session state causes campaign drift | 3 | 4 | use of `resume` without snapshot binding | ephemeral one-shot default; resume forbidden in V1 | Broker |
| RR-013 | Shared Rust crate defeats independent verification | 4 | 5 | producer and verifier call same core function | independent implementation and cross-language/algorithm checks | Evidence |
| RR-014 | Filesystem crash recovery is assumed from unit tests | 4 | 5 | no kill points or restore drills | descriptor-relative I/O, crash journal, kill injection | Workspace |
| RR-015 | SQLite migration corrupts live state | 2 | 5 | migration tested only on synthetic DB | production-shaped copies, backup/restore and canary | Database |
| RR-016 | Rust CI is advisory and drifts red | 4 | 3 | unprotected workflow or ignored failures | required protected checks and milestone evidence | SRE |
| RR-017 | Dependency/toolchain upgrades silently alter behavior | 3 | 4 | floating `stable` or unlocked dependencies | exact toolchain, lockfile, qualification record, canary | SRE |
| RR-018 | Model quality regresses while deterministic tests pass | 4 | 4 | compile passes but evidence/citation quality falls | live evaluation set and acceptance thresholds | Product/Evidence |
| RR-019 | Cost accounting treats missing usage as zero | 3 | 4 | terminal without usage refunds budget | unknown/conservative classification and reconciliation | Campaign |
| RR-020 | OpenClaw remains through an indirect Rust dependency | 3 | 3 | source/config contains OpenClaw runtime path | dependency/source CI ban and runtime graph inspection | Architecture |
| RR-021 | Overlarge first PR cannot be reviewed or rolled back | 4 | 3 | mixed DB writer, broker and cutover changes | invariant-sized PRs and additive read-only stages | Program |
| RR-022 | Security logs capture prompts or private manuscripts | 3 | 5 | raw JSONL/prompts uploaded to CI artifacts | field-level redaction, bounded encrypted evidence, fixture scrubbing | Security |
| RR-023 | External submission is repeated after ambiguous response | 2 | 5 | retry based only on local timeout | external-action journal and portal reconciliation | Release |
| RR-024 | Timeline pressure converts milestone gates into checklists | 4 | 4 | “done” without attached evidence | hard exit metrics and independent gate reviewer | Program |

## Escalation rules

- Any score of 20 or more blocks the next milestone until reduced or formally
  accepted by the responsible authority.
- Credential disclosure, duplicate external side effect, stale-generation write,
  historical hash drift and unrecoverable state corruption are automatic P0
  incidents regardless of score.
- A mitigation is not complete until a negative test demonstrates the forbidden
  behavior is rejected.
