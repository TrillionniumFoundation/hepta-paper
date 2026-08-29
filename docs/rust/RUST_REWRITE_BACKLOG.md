# Rust rewrite executable backlog

This is the canonical human backlog. Stable IDs never change. Status and
evidence tier use the vocabulary in `CURRENT_STATUS.md`; exact gap state is also
recorded in `current-status.v1.json`.

## Foundation — contracts and protocol

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-FND-001 | P0 | source_qualified | Pinned Rust workspace and isolated CI | exact toolchain, lock, fmt/clippy/test/docs |
| RUST-FND-002 | P0 | source_qualified | `CodexExecutionRequestV1` | deny unknown fields; role/task/sandbox invariants |
| RUST-FND-003 | P0 | source_qualified | `CodexExecutionReceiptV1` | usage/cost/spawn/ambiguity invariants |
| RUST-FND-004 | P0 | source_qualified | Canonical SHA-256 digest | algorithm/case/length negative tests |
| RUST-FND-005 | P0 | source_qualified | Bounded JSONL decoder | byte/line/event bounds before trust |
| RUST-FND-006 | P0 | source_qualified | Terminal/event ordering | missing/duplicate/late/unknown terminal reject |
| RUST-FND-007 | P0 | source_qualified | Fault-injecting fake Codex | malformed/UTF-8/oversize/hang fixtures |
| RUST-FND-008 | P0 | source_qualified | Operation state machine | illegal/terminal transitions reject |
| RUST-FND-009 | P0 | source_qualified | Recovery classification | pre-spawn/resume/ambiguous/prepared rules |
| RUST-FND-010 | P0 | source_qualified | TCB/parity/protocol docs | explicit authority and non-authority |
| RUST-FND-011 | P0 | source_qualified | Dependency lock and provenance | committed lock; all commands `--locked` |
| RUST-FND-012 | P0 | source_implemented | Machine-readable program truth | CI validates IDs/status/evidence/canonical docs |
| RUST-FND-013 | P0 | design_ready | Supply-chain assurance | cargo-deny/audit/vet policy, SBOM, provenance |

## Broker — identity, process and persistence

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-BRK-001 | P0 | source_qualified | Executable realpath/inode/mode/owner/hash | symlink/hardlink/replacement reject |
| RUST-BRK-002 | P0 | source_qualified | Private `CODEX_HOME` and config identity | cache churn allowed; authority drift rejects |
| RUST-BRK-003 | P0 | source_qualified | Non-secret credential-root identity | credential bytes never read/serialized |
| RUST-BRK-004 | P0 | blocked_external | Installed Codex version/flags/events | signed installed qualification and golden transcript |
| RUST-BRK-005 | P0 | source_qualified | Environment allowlist/scrubber | provider/authority secrets absent |
| RUST-BRK-006 | P0 | source_qualified | Bounded process supervisor | timeout/output/descendant cleanup tests |
| RUST-BRK-007 | P0 | source_qualified | Output-schema authority contract | separate owner production mode |
| RUST-BRK-008 | P0 | source_qualified | Broker SQLite journal | atomic transitions and startup audit |
| RUST-BRK-009 | P0 | source_qualified | Idempotency/nonce index | duplicate never double-reserves/spawns |
| RUST-BRK-010 | P0 | source_qualified | Unix frame/size bounds | malformed/truncated/version cases reject |
| RUST-BRK-011 | P0 | source_qualified | Peer UID/GID + signed capability | unauthorized peer cannot reserve |
| RUST-BRK-012 | P0 | source_qualified | Runtime pre/postflight | executable/config/schema drift blocks integration |
| RUST-BRK-013 | P0 | source_qualified | Execution/prepared receipt | exact event stream and subject binding |
| RUST-BRK-014 | P0 | design_ready | Conservative cost settlement | missing usage never becomes zero |
| RUST-BRK-015 | P1 | blocked_external | Scrubbed real-Codex fixtures | no prompts/credentials/private content retained |
| RUST-BRK-016 | P0 | source_qualified | Durable pre-exec provider gate | target cannot run before link+release commits |
| RUST-BRK-017 | P0 | blocked_external | Independent gate/host qualification | owner/ACL/mount/systemd/reboot review |
| RUST-BRK-018 | P0 | design_ready | Authorized listener access modes | authorized separate UID succeeds; denied UID fails live |
| RUST-BRK-019 | P0 | design_ready | Exact-head/tree CI evidence | explicit head checkout and machine manifest |
| RUST-BRK-020 | P0 | design_ready | Production process containment | cgroup-v2/pidfd defeats setsid/double-fork escape |
| RUST-BRK-021 | P1 | design_ready | Versioned telemetry/error registry | stable codes/counters; no sensitive fields |

## Workspace and mutation authority

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-WS-001 | P0 | not_started | Descriptor-relative root opener | symlink/path-race corpus rejects |
| RUST-WS-002 | P0 | not_started | COW attempt materialization | canonical source unchanged pre-integration |
| RUST-WS-003 | P0 | not_started | Deterministic tree inventory | byte/type/mode/uid/gid/link inventory |
| RUST-WS-004 | P0 | not_started | Before/after mutation manifest | every material change classified |
| RUST-WS-005 | P0 | not_started | Versioned role mutation policy | path/type/count/size limits exact |
| RUST-WS-006 | P0 | not_started | Read-only reviewer qualification | writes and authority reads fail |
| RUST-WS-007 | P0 | not_started | Prepared workspace result | writer integrates without rerun |
| RUST-WS-008 | P0 | not_started | Failed-attempt discard/retention | failed tree cannot become next input |
| RUST-WS-009 | P1 | not_started | Crash journal/orphan reconciliation | no unclassified workspace residue |

## Compatibility kernel

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-CMP-001 | P0 | design_ready | Inventory hash/canonicalization callsites | complete disposition ledger |
| RUST-CMP-002 | P0 | not_started | `LegacyStableJsonV1` specification | immutable byte-level semantics |
| RUST-CMP-003 | P0 | not_started | Bounded Node oracle | frozen runtime/lock, no network/secrets |
| RUST-CMP-004 | P0 | not_started | Rust V1 encoder/verifier | corpus byte parity 100% |
| RUST-CMP-005 | P0 | not_started | Historical receipt/hash corpus | provenance and expected values bound |
| RUST-CMP-006 | P0 | design_ready | `HeptaCanonicalJsonV2` | number/Unicode/key/null semantics |
| RUST-CMP-007 | P0 | design_ready | Error/status/exit registry | no implicit string drift |
| RUST-CMP-008 | P1 | not_started | Differential property/fuzz tests | minimized counterexamples retained |

## Read-only control plane

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-RO-001 | P0 | not_started | Immutable SQLite open | no WAL, sidecar or byte mutation |
| RUST-RO-002 | P0 | not_started | Decode schema 1–25 | production-shaped fixture matrix |
| RUST-RO-003 | P0 | not_started | Campaign DAG/state inspection | normalized Node diff zero |
| RUST-RO-004 | P0 | not_started | Ledger/receipt verification | old/new cross-verification |
| RUST-RO-005 | P0 | not_started | Artifact/CAS inventory verification | inventory diff zero |
| RUST-RO-006 | P1 | not_started | Parity dashboard/mismatch bundle | every mismatch offline reproducible |

## Local vertical slice

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-MVP-001 | P0 | not_started | One-paper deterministic plan | stable plan hash |
| RUST-MVP-002 | P0 | not_started | Author draft node | schema + mutation allowlist |
| RUST-MVP-003 | P0 | not_started | Deterministic LaTeX build | bounded build receipt/hash |
| RUST-MVP-004 | P0 | not_started | Frozen reviewer bundle | no author home/session visibility |
| RUST-MVP-005 | P0 | not_started | Reviewer node | structured verdict + read-only proof |
| RUST-MVP-006 | P0 | not_started | Revision node | issue IDs bind exact input |
| RUST-MVP-007 | P0 | not_started | Rebuild/regression | accepted checks cannot disappear |
| RUST-MVP-008 | P0 | not_started | Local package/replay receipt | complete input/output inventory |
| RUST-MVP-009 | P0 | not_started | Cancellation/crash matrix | no pollution or duplicate provider call |

## Persistent campaign writer

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-DB-001 | P0 | not_started | Writer ownership lease | Node/Rust dual writer impossible |
| RUST-DB-002 | P0 | not_started | Create/claim/heartbeat | transactional invariants |
| RUST-DB-003 | P0 | not_started | Generation fencing | stale commit count zero |
| RUST-DB-004 | P0 | not_started | Prepared-result integration | exactly once |
| RUST-DB-005 | P0 | not_started | Retry/pause/resume/cancel | deterministic transition table |
| RUST-DB-006 | P0 | not_started | Budget reserve/settle | no unexplained refund/overrun |
| RUST-DB-007 | P0 | not_started | Resource governor | starvation/oversubscription tests |
| RUST-DB-008 | P0 | not_started | Writer backup/restore | complete restore drill |
| RUST-DB-009 | P0 | not_started | 10k simulation + 72h soak | M5 metrics pass |

## Evidence, release and cutover

`RUST-EVD-*`, `RUST-REL-*` and `RUST-CUT-*` are expanded only after M4
architecture evidence is accepted. They cannot bypass M0–M6 by importing a
local fixture or self-signed authority.

## Definition of done for every item

An item changes status only when all applicable fields exist:

```text
implementation
positive and negative tests
crash/recovery behavior
threat-model delta
operator impact
exact commit/tree evidence
minimum evidence tier
rollback plan
named owner/reviewer
remaining non-authority statement
```
