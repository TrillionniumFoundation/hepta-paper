# Rust Foundation Slice 1 status

Baseline: `main@d2868944ecc5a6c081bcb42d67fc0643ecbecd0f`  
Authority introduced: **none** — additive, test-only/read-contract foundation

## Implemented in this slice

- pinned Rust 1.98.0 workspace and independent CI;
- canonical lowercase `sha256:` digest type;
- deny-unknown-fields `CodexExecutionRequestV1`;
- deny-unknown-fields `CodexExecutionReceiptV1`;
- role/task/sandbox policy validation;
- bounded JSONL decoder with exact raw-stream hash;
- strict thread/turn/terminal ordering;
- preservation of unknown nonterminal events;
- fail-closed handling for unknown terminal-like events;
- external-operation transition and recovery model;
- fault-injecting `fake-codex` binary and integration tests;
- master plan, executable backlog, TCB, parity matrix, risk register, protocol,
  journal, role profiles, runtime identity and ADR.

## Explicitly not implemented yet

- real Codex process spawn;
- credential or executable inspection;
- Unix-socket broker server/client;
- SQLite journal persistence;
- output schema extraction from real Codex events;
- COW workspace and mutation verifier;
- canonical Node/Rust hash parity;
- campaign database reads or writes;
- live Codex tests;
- release or submission authority.

## Next merge slice

`RUST-BRK-001` through `RUST-BRK-006`:

1. executable and `CODEX_HOME` runtime identity;
2. non-secret credential-root inspection;
3. environment allowlist/scrubber;
4. bounded process-group supervisor;
5. runtime preflight/postflight identity comparison;
6. negative tests for symlinks, hard links, permissions, environment leakage,
   output overflow, timeout and descendant cleanup.

This slice may launch only `fake-codex`. Real Codex qualification begins after
those negative tests pass.
