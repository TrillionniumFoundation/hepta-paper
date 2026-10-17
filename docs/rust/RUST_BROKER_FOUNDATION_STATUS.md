# Rust Broker Foundation Slice status

Base: `codex/rust-foundation-20260828@7c0ee455429c43cd0e453e1177343635110c0cf4`  
Branch: `codex/rust-broker-foundation-20260828`  
Authority introduced: **local test process execution only**

## Implemented source

- `hepta-codex-runtime` crate;
- executable realpath, metadata, owner, mode, link and content identity;
- private Codex home/config identity;
- credential material metadata identity without opening credential bytes;
- parent/model-child environment policies with secret-pattern rejection;
- environment and policy hashes;
- bounded process-group supervisor;
- concurrent exact-byte stdout/stderr hashing and bounded tails;
- timeout/output-limit TERM-to-KILL cleanup;
- descendant-survival detection and group cleanup verification;
- runtime preflight/postflight drift report and combined failure semantics;
- negative tests and broker Foundation design document.

## Backlog mapping

| Work item | Source status | Qualification status |
|---|---|---|
| RUST-BRK-001 executable identity | implemented | blocked on Rust runner |
| RUST-BRK-002 `CODEX_HOME`/config identity | implemented | blocked on Rust runner |
| RUST-BRK-003 metadata-only credential identity | implemented | blocked on Rust runner |
| RUST-BRK-005 environment scrubber | implemented | blocked on Rust runner |
| RUST-BRK-006 bounded process supervisor | implemented with local shell fixtures | blocked on Rust runner and extended fault suite |
| runtime preflight/postflight comparison | implemented | blocked on Rust runner |
| RUST-BRK-004 real Codex version/flag/event qualification | not enabled | intentionally blocked |

## Validation available in the current environment

```text
TOML parsing
Rust lexical/string/comment scan
balanced delimiter scan
workspace member/path consistency
OpenClaw source/manifest exclusion
system kill process-group syntax probe
```

No Rust compiler is available locally, and GitHub-hosted jobs have continued to
fail before runner assignment. Therefore this branch is not compile-qualified
and must not be merged or given real credentials.

## Next safe work

After source review, continue with tests and adapters that use only local fake
executables:

1. simultaneous stdout/stderr saturation and pipe-inheritance tests;
2. bounded fork/descendant fixtures;
3. runtime replacement stress fixtures;
4. Unix-socket framing and peer authorization contracts;
5. isolated SQLite operation-journal persistence.

Real `codex exec`, login status, provider credentials, campaign writes and
workspace integration remain hard-disabled.
