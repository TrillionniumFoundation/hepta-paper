# Rust durable pre-exec gate status

Status: source implementation complete; independent and installed-host
qualification pending.

Source implementation commits:

```text
7f97c1c0a6f3fecc5763cd94412d3753a4f74ebf  durable gate and recovery implementation
56362a1255e576b7b8450c61b12a0f2b298643c2  canonical gate observation path fix
```

The second commit closes a cross-host path-alias defect exposed by GitHub-hosted
runners: Linux `/proc/<pid>/exe` is compared with the already inspected canonical
gate path rather than the caller's lexical policy path. Its focused 9-case
durable process journal suite passed on the publishing runner before the commit
was pushed.

This record update creates a human-authored PR head so protected GitHub Actions
execute normally after source commits published by a restricted `GITHUB_TOKEN`
workflow.

## Implemented

- stopped Rust gate in a fresh Linux session/process group;
- exact gate, target, envelope, process-start and boot identity;
- atomic SQLite process linkage plus `process_spawned` projection;
- separate durable release authorization;
- exact target-object execution through an opened file descriptor;
- inherited non-stdio descriptor closure;
- bounded termination and process-group cleanup;
- startup reconciliation before listener Ready;
- ambiguity-to-new-attempt retry classification;
- local-fixture and separate-owner production authority modes;
- schema-v2 integrity checks and fault injection;
- canonical observation of the launched gate object across host path aliases.

## Deterministic source evidence

Before publication, the fixed Rust 1.98.0 locked/offline suite completed:

```text
cargo metadata --locked --offline
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked --offline -- -D warnings
cargo test --workspace --all-features --locked --offline -- --test-threads=1
RUSTDOCFLAGS=-D warnings cargo doc --workspace --all-features --locked --offline --no-deps
```

The source suite covers pre-release non-execution, commit/release transaction
faults, replacement resistance, blocked/released/absent/orphaned recovery,
identity mismatch, FD leakage and new-attempt recovery disposition. Node impacted
selection and all four selected-test shards also passed before publication.

Remote protected-check run IDs and conclusions remain authoritative and are
recorded on the pull request after completion; local evidence does not replace
those checks.

## Remaining qualification gates

- independent review of the low-level Linux process primitive;
- root/deployment-controlled gate and schema owners distinct from broker UID;
- ACL, mount, immutable deployment and service-manager evidence;
- host restart and broker-crash drill against the installed service;
- authenticated Codex provider completion under separate author/reviewer homes;
- external release/submission authorities where applicable.

Until those records exist, the implementation remains unavailable to real
provider composition even when all source checks are green.
