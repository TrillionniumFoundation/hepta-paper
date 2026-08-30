# Rust rewrite executable backlog

This is the canonical human backlog. Stable IDs do not change. Status tokens are
machine-compared with `current-status.v1.json`; a stale table is a CI failure,
not advisory documentation.

`source_qualified` below is repository-local evidence only. It grants no live
provider, production writer, target-host, key-custody, release or submission
authority. Items whose acceptance requires a real external owner remain
`blocked_external` and point to an evidence-collector issue.

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
| RUST-FND-011 | P0 | source_qualified | Dependency lock and provenance | committed lock; exact internal path versions; locked commands |
| RUST-FND-012 | P0 | source_qualified | Machine-readable program truth | CI validates IDs, status, evidence and canonical-document parity |
| RUST-FND-013 | P0 | source_qualified | Supply-chain assurance | pinned checksum-verified tools, cargo-deny, RustSec and CycloneDX evidence |

## Broker — identity, process and persistence

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-BRK-001 | P0 | source_qualified | Executable realpath/inode/mode/owner/hash | symlink/hardlink/replacement reject |
| RUST-BRK-002 | P0 | source_qualified | Private `CODEX_HOME` and config identity | cache churn allowed; authority drift rejects |
| RUST-BRK-003 | P0 | source_qualified | Non-secret credential-root identity | credential bytes never read/serialized |
| RUST-BRK-004 | P0 | blocked_external | Installed authenticated Codex version/flags/events | issue #21 signed executable/CLI and live canary evidence |
| RUST-BRK-005 | P0 | source_qualified | Environment allowlist/scrubber | provider/authority secrets absent |
| RUST-BRK-006 | P0 | source_qualified | Bounded process supervisor | timeout/output/descendant cleanup tests |
| RUST-BRK-007 | P0 | source_qualified | Output-schema authority contract | separate owner production contract and hosted negative tests |
| RUST-BRK-008 | P0 | source_qualified | Broker SQLite journal | atomic transitions and startup audit |
| RUST-BRK-009 | P0 | source_qualified | Idempotency/nonce index | duplicate never double-reserves/spawns |
| RUST-BRK-010 | P0 | source_qualified | Unix frame/size bounds | malformed/truncated/version cases reject |
| RUST-BRK-011 | P0 | source_qualified | Peer UID/GID plus signed capability | unauthorized peer cannot reserve |
| RUST-BRK-012 | P0 | source_qualified | Runtime pre/postflight | executable/config/schema drift blocks integration |
| RUST-BRK-013 | P0 | source_qualified | Execution/prepared receipt | exact event stream and subject binding |
| RUST-BRK-014 | P0 | source_qualified | Conservative cost settlement | missing usage never becomes zero; ambiguity remains bounded |
| RUST-BRK-015 | P1 | blocked_external | Scrubbed real-Codex fixtures | issue #21 independently controlled live evidence with redaction proof |
| RUST-BRK-016 | P0 | source_qualified | Durable pre-exec provider gate | target cannot run before link and release commits |
| RUST-BRK-017 | P0 | blocked_external | Independent gate/host qualification | issue #17 owner/ACL/mount/systemd/reboot review |
| RUST-BRK-018 | P0 | source_qualified | Authorized listener access modes | authorized separate UID succeeds; denied UID fails live fixture |
| RUST-BRK-019 | P0 | source_qualified | Exact-head/tree CI evidence | explicit head checkout, pre/post identity and retained manifest |
| RUST-BRK-020 | P0 | source_qualified | Production containment source contract | cgroup-v2 process set; process-group/fixture modes reject production |
| RUST-BRK-021 | P1 | source_qualified | Versioned telemetry/error registry | stable codes/counters; no sensitive fields |

## Workspace and mutation authority

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-WS-001 | P0 | source_qualified | Descriptor-relative root opener | symlink/path-race corpus rejects |
| RUST-WS-002 | P0 | source_qualified | COW attempt materialization | canonical source unchanged pre-integration |
| RUST-WS-003 | P0 | source_qualified | Deterministic tree inventory | byte/type/mode/uid/gid/link inventory |
| RUST-WS-004 | P0 | source_qualified | Before/after mutation manifest | every material change classified |
| RUST-WS-005 | P0 | source_qualified | Versioned role mutation policy | path/type/count/size limits exact |
| RUST-WS-006 | P0 | source_qualified | Read-only reviewer qualification | writes and authority reads fail |
| RUST-WS-007 | P0 | source_qualified | Prepared workspace result | writer integrates without rerun |
| RUST-WS-008 | P0 | source_qualified | Failed-attempt isolation/disposition | unpublished staging is reclaimed; published attempts cannot become canonical input implicitly |
| RUST-WS-009 | P1 | source_qualified | Crash/orphan reconciliation | incomplete staging is identity-checked and deterministically recovered |

## Compatibility kernel

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-CMP-001 | P0 | source_qualified | Inventory hash/canonicalization callsites | disposition ledger and domain separation |
| RUST-CMP-002 | P0 | source_qualified | `LegacyStableJsonV1` specification | immutable byte-level semantics |
| RUST-CMP-003 | P0 | source_qualified | Bounded Node oracle | frozen runtime/lock, no network/secrets |
| RUST-CMP-004 | P0 | source_qualified | Rust V1 encoder/verifier | corpus byte parity |
| RUST-CMP-005 | P0 | source_qualified | Historical receipt/hash corpus | provenance and expected values bound |
| RUST-CMP-006 | P0 | source_qualified | `HeptaCanonicalJsonV2` source contract | number/Unicode/key/null semantics explicit |
| RUST-CMP-007 | P0 | source_qualified | Error/status/exit registry | no implicit string drift |
| RUST-CMP-008 | P1 | source_qualified | Differential/property corpus | deterministic minimized counterexamples retained |

## Read-only control plane

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-RO-001 | P0 | source_qualified | Immutable SQLite open | no WAL, sidecar or byte mutation |
| RUST-RO-002 | P0 | source_qualified | Decode schema 1–25 | supported-version fixture matrix |
| RUST-RO-003 | P0 | source_qualified | Campaign DAG/state inspection | deterministic normalized projection |
| RUST-RO-004 | P0 | source_qualified | Ledger/receipt verification | old/new cross-verification contracts |
| RUST-RO-005 | P0 | source_qualified | Artifact/CAS inventory verification | identity and logical-hash verification |
| RUST-RO-006 | P1 | source_qualified | Parity mismatch bundle | every mismatch remains offline reproducible |

## Local vertical slice

The source slice uses a fake provider. Real authenticated author/reviewer
qualification remains exclusively under issue #21 and cannot be inferred from
these rows.

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-MVP-001 | P0 | source_qualified | One-paper deterministic plan | stable source and mutation hashes |
| RUST-MVP-002 | P0 | source_qualified | Author draft node | schema plus mutation allowlist |
| RUST-MVP-003 | P0 | source_qualified | Deterministic build boundary | bounded prepared-result receipt |
| RUST-MVP-004 | P0 | source_qualified | Frozen reviewer bundle | no author home/session authority |
| RUST-MVP-005 | P0 | source_qualified | Reviewer node | structured read-only proof |
| RUST-MVP-006 | P0 | source_qualified | Revision node contract | attempt and issue identity bind exact input |
| RUST-MVP-007 | P0 | source_qualified | Rebuild/regression contract | accepted checks cannot disappear silently |
| RUST-MVP-008 | P0 | source_qualified | Local package/replay receipt | input/output inventory and hashes |
| RUST-MVP-009 | P0 | source_qualified | Cancellation/crash matrix | no pollution or duplicate integration/provider replay |

## Persistent campaign writer

The rows below are source contracts and deterministic simulations. The real
72-hour production-topology soak, reboot and destructive storage drill remain
under issue #12.

| ID | P | Status | Work item | Acceptance |
|---|---:|---|---|---|
| RUST-DB-001 | P0 | source_qualified | Writer ownership lease | Node/Rust dual writer mechanically fenced |
| RUST-DB-002 | P0 | source_qualified | Create/claim/heartbeat | transactional invariants |
| RUST-DB-003 | P0 | source_qualified | Generation fencing | stale commit count zero in source suites |
| RUST-DB-004 | P0 | source_qualified | Prepared-result integration | exactly once and replay-idempotent |
| RUST-DB-005 | P0 | source_qualified | Retry/pause/resume/cancel | deterministic transition table |
| RUST-DB-006 | P0 | source_qualified | Budget reserve/settle | no unexplained refund/overrun |
| RUST-DB-007 | P0 | source_qualified | Resource governor contract | bounded reservation and oversubscription rejection |
| RUST-DB-008 | P0 | source_qualified | Writer backup/restore | integrity-bound backup and restore source drill |
| RUST-DB-009 | P0 | source_qualified | Scale/soak source harness | 10k deterministic simulation and bounded soak contract; real 72h run is issue #12 |

## External qualification ledger

| Gap | Status | Issue | Closure authority |
|---|---|---:|---|
| GAP-HOST-001 | blocked_external | #17 | target-host operator plus independent Linux reviewer |
| GAP-HOST-002 | blocked_external | #12 | target storage/host operator plus independent reviewer |
| GAP-KEY-001 | blocked_external | #14 | external capability-key owner |
| GAP-CODEX-001 | blocked_external | #21 | credential owner, target-host operator and reviewer |
| GAP-REL-001 | blocked_external | #22 | KMS/HSM, WORM, release, portal and submission owners |

## Evidence, release and cutover

Scientific-evidence, external-authority port and cutover crates are
repository-local source contracts. They may verify independently issued
receipts and mechanically fence cutover, but they do not possess the external
secrets or production authority needed to satisfy the external ledger.

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
