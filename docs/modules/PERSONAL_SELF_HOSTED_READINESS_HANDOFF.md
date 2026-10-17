# Personal self-hosted readiness handoff

This handoff records the bounded Rust source slice for
`operator/personal-self-hosted-readiness`. It is a read-only local observer;
it does not establish production activation, external authority, distribution
or retirement of the incumbent Node route.

## Source and call chain

The incumbent command is `paper-core/bin/personal-self-hosted-readiness.mjs`.
Its local observer composes provenance, formal evidence, source security,
runtime boundary, personal SQLite state, scientific receipts and the
profile evaluator. The native chain is:

| Rust source | Symbol | Responsibility |
|---|---|---|
| `rust/crates/hepta-paper-service/src/bin/hepta-paper-rust.rs` | `command` | Parses the closed route options, emits help/report JSON and applies the `--require-ready` exit gate. |
| `rust/crates/hepta-paper-service/src/personal_self_hosted_readiness.rs` | `inspect_personal_self_hosted_readiness_v1` | Composes the seven local controls, scientific capability projection, not-applicable controls and production-compatible report hash. |
| the same module | `inspect_provenance` / `inspect_formal` | Reads exact repository provenance and the canonical zero-skip formal receipt without accepting caller-supplied status. |
| the same module | `inspect_source_security` / `inspect_runtime_boundary` | Scans tracked source policy and checks a private runtime root physically separated from the workspace. |
| the same module | `inspect_database` | Checks the owner-only SQLite file, sidecars, immutable SQLite state, schema floor, leases, snapshot hash, anti-rollback ledger, backup receipt and restore-drill receipt. |
| the same module | `inspect_cpu` / `inspect_gpu` | Validates fresh process-isolated CPU evidence and optional same-device GPU evidence, including commit, IR and external-action constraints. |
| `rust/crates/hepta-paper-service/tests/personal_self_hosted_readiness_parity.rs` | five parity tests | Compares help, missing evidence, missing runtime-root catch behavior, GPU opt-in blocking and a valid local database ledger/backup/restore fixture with the pinned Node oracle. |

The route accepts `--root`/`--workspace-root`, `--runtime-root`, optional
`--cpu-receipt` and `--gpu-receipt`, `--gpu-enabled`, `--require-ready`,
`--now ISO|UNIX_MILLIS` and `--help`. Defaults are taken from
`HEPTA_WORKSPACE_ROOT` and `HEPTA_PAPER_RUNTIME_ROOT`, with the runtime
defaulting to the Node-compatible sibling
`../hepta-paper-runtime/native-runtime` when the environment variable is
absent.

## Local evidence contract

Every path is absolute and checked without following a final symlink. Receipt
files are owner-only private regular files with one link, bounded size and
stable metadata during the read. The provenance control binds the repository
commit, tree and content hash. The formal control accepts only the canonical
zero-skip receipt shape and binds its commit. Source security scans tracked
repository bytes for the checked-in high-confidence secret policy; it does not
claim a complete host filesystem or credential-store audit.

The runtime boundary requires an owner-only directory that is physically
decoupled from the source workspace. The database control opens the personal
SQLite store read-only, checks quick-check, foreign keys, schema version 25 or
newer, active leases and unsafe sidecars, then hashes a temporary SQLite
consistent snapshot. Because the Rust and Node SQLite builds stamp different
engine-version bytes into an online backup, the temporary digest restores the
source header stamp before hashing; metadata identity is checked before and
after, and the image is deleted. This is a canonical cross-runtime digest,
not a persisted Rust backup file. The anti-rollback ledger is checked for canonical entry
sequence, previous-entry links, unique database heads and its record hash. A
latest private backup must have a matching content hash and receipt, and its
restore-drill receipt must prove that the production database was not mutated.
Missing or invalid evidence remains blocked.

CPU is always enabled and requires the process-isolated PDE and deep-learning
oracle fields, a current workspace commit, deterministic replay and safe IR
flags. CPU/GPU receipt consumption now checks the original JSON field order
before projecting values, so reordered top-level/policy/release objects cannot
pass readiness with an otherwise valid hash. Invalid receipt projections remain
available for blocked diagnostics. GPU is opt-in and additionally requires its same-device replay fields.
Neither path calls a provider, network, signer, KMS/HSM, portal or release
attestor. The `--require-ready` switch changes only the process exit status;
it never turns a blocked report into authority.

## Report and failure boundary

The JSON report retains the Node profile identifiers, profile hash, control
results, scientific capability projection, optional diagnostic and
`personalSelfHostedProductionReadinessHash`. A missing native database follows
the incumbent catch boundary and reports the native-store blocker before
ledger or backup inspection. A safe database with missing ledger, backup or
restore evidence reports those individual blockers. The route exits zero for
an observed report and exits two only when `--require-ready` is supplied and
the report is blocked; malformed arguments or invalid observation clocks are
argument failures.

## Remaining implementation and acceptance

This slice is source-level local parity evidence. The formal receipt verifier
covers the exact canonical zero-skip receipt shape and hash/provenance binding,
rather than every external formal runner implementation. The tracked-source scanner is intentionally narrower
than a host-wide credential audit. Real CPU/GPU hardware execution, external
authority roles, target-host deployment, independent acceptance, distribution
qualification, production activation and Node retirement remain outside this
read-only adapter. Those boundaries keep a local report from being mistaken
for a release or submission authorization.

## Verification

Use Node 22.23.1 from the repository toolchain and Rust 1.98.0:

```sh
export PATH="$PWD/../toolchains/node-npm/node_modules/node-linux-x64/bin:$PATH"
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --test personal_self_hosted_readiness_parity --locked
```

The command map remains `partial_local_source` with `compatibilityDecision`
`candidate`. This handoff does not mark accepted parity, production
activation or Node retirement.
