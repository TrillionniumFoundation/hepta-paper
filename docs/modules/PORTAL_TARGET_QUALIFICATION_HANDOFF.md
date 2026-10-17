# Portal target qualification operator handoff

Status: Rust source candidate with locally exercised Node parity. The operator
performs local verification and registry import only. This status is not external
portal acceptance, provider production activation, scientific acceptance, or a
human-reviewed live commit permit.

## Owned source and original behavior

The native binary is `hepta-portal-target-qualification`. It implements the original
`paper-core/bin/portal-target-qualification.mjs` flags and the composition/repository
chain through `paper-composition/submission/portal-target-qualification-composition.mjs`
and `paper-adapters/submission/portal-target-qualification-registry-repository.mjs`.
The preflight policies come from the domain preflight contract and continuity
module. No Node process is invoked by the Rust operator.

| Rust source | Responsibility |
| --- | --- |
| `rust/crates/hepta-paper-service/src/portal_target_qualification.rs` | Public options, four operations, plan hash, monotonic generations, revocations, post-import verification |
| `src/portal_target_qualification/cli.rs` under the same crate | Original strict flags, repeated targets/bindings, environment defaults, exit gates |
| `src/portal_target_qualification/preflight.rs` | Redacted source, pin, authority, target, evidence, time and continuity diagnostics |
| `src/portal_target_qualification/files.rs` | Bounded secure file snapshots, descriptor-relative exclusive lock, atomic publication, rollback |
| `src/journal_connector_coverage/qualification/operator_support.rs` | Read-only internal bridge to the existing qualification structure and real signature validators; ordered publication encoding |
| `src/bin/hepta-portal-target-qualification.rs` | Clock/environment acquisition, JSON stdout and process exit status |

Public library entry points in `portal_target_qualification` are:

- `PortalTargetQualificationOperatorOptionsV1`: paths, expected hashes, explicit
  `now_unix_ms`, target selection, qualification level and expected target bindings.
- `inspect_portal_target_qualification_v1(&options)`.
- `preflight_portal_target_qualification_v1(&options)`.
- `plan_portal_target_qualification_import_v1(&options)`.
- `execute_portal_target_qualification_import_v1(&options)`.
- `portal_target_qualification_cli_at_v1(argv, environment, now_unix_ms)`, returning
  `PortalTargetQualificationCliOutputV1 { report, exit_code }`.

Failures return `PortalTargetQualificationError`; operational rejection is never
converted to a ready report. The existing opaque journal inspection remains
opaque. The internal bridge cannot fabricate one from arbitrary JSON.

## CLI and modes

`--action` is `status` by default. Supported actions are `status`, `preflight`,
`import-plan`, and `import-execute`. The complete original help JSON is available
with `--help`.

Common pins and paths are `--registry`, `--registry-hash`, `--trust-store`, and
`--trust-store-hash`. Their fallback environment variables are respectively:

- `HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY`
- `HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH`
- `HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE`
- `HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH`

| Mode | Inputs and output | Mutation |
| --- | --- | --- |
| `status` | Exact semantic registry hash; byte-pinned trust; actual signatures and current validity; full inspection | None |
| `preflight` | Exactly one or two `--target VENUE`; active registry or `--candidate` with `--candidate-hash`; optional `--qualification-level sandbox\|production`; typed redacted lint | None |
| `import-plan` | Candidate/trust byte pins; current registry signature validation; generation, predecessor and explicit revocations; deterministic `planHash` | None |
| `import-execute` | Same import inputs, `--execute`, and `--plan-hash`; one local publication; fully verified import receipt | Local registry and transaction files only |

Preflight accepts repeated `--expected-subject-hash VENUE=HASH`,
`--expected-route-hash VENUE=HASH`, and `--expected-schema-hash VENUE=HASH`.
The venue must already occur in the selected targets. A repeated field for the
same venue is rejected. Subject, route and schema drift is reported separately.
A signed successor revocation does not suppress preflight diagnostics for a
changed stable binding. Import continuity itself retains the original Node
semantics; it does not silently add preflight requirements to import-plan.

Unknown flags, duplicate scalar/boolean flags, positional arguments, missing or
empty values, values on boolean flags, and `--` are rejected. `--name=value`
syntax remains supported for value flags. A blocked status/preflight still emits
its report; `--require-ready` makes that report exit 2. Other successful calls
exit 0. Contract/IO/argument failures write stderr and exit 1. Import execution
requires `--execute`; status, preflight and planning never create a registry or
its parent directory.

## Verification and continuity

The operator reuses the journal qualification library rather than substituting
claimed `verified` flags. It checks the exact rebuilt registry and entry contract,
ordered JSON structure, semantic hashes, typed expiring evidence, authority-role
coverage, minimal signature sets and real Ed25519 signatures. The owner, observer
and production authorizer must meet the existing distinct-subject, distinct
organization and distinct-SPKI policies. Evidence signer identity must agree with
the corresponding registry authority. Trust-store pins hash raw file bytes;
registry pins hash the semantic registry contract; candidate pins hash raw bytes.

Initial import requires generation 1, null predecessor, and no revoked hashes.
A successor must be exactly generation + 1, name the current semantic registry
hash as predecessor, and have a strictly newer issue instant. Every changed or
removed prior entry must be explicitly revoked, unchanged entries must not be
revoked, revocations must refer to the current registry, and revoked entries must
not be reused. A properly signed expired current registry can be replaced; the
candidate must be current. The plan binds current/candidate semantic hashes,
candidate generation and byte hash, trust byte hash, paths and target venue IDs.

Qualification never changes `liveCommitAuthorized` or `liveSubmissionReady` to
true. Registry/import outputs retain human single-use authorization requirements
and never produce or consume a commit permit. The fixtures contain locally
invented evidence labels and ephemeral test authorities; their ready state has
no authority outside the isolated test directories.

## Local storage transaction and recovery

Inputs are bounded to 4 MiB, regular files with one hard link, owned by the current
user or root, and not writable by group/other. Every path component is opened
relative to a held directory descriptor with symlink traversal prohibited.
Metadata and path identity are checked around reads and again before accepting
a plan. Relative paths are normalized in the original CLI manner.

Execution validates the plan first, creates any missing parent directories with
mode 0700, checks the parent ownership/mode, then creates a mode-0600 exclusive
`REGISTRY.lock` containing the exact plan hash and syncs it. The plan is rebuilt
under the lock and pinned input snapshots are checked again. The candidate's
ordered pretty JSON matches the original Node publication bytes.

The publisher creates a private exclusive temporary file, writes and syncs it,
then uses Linux `renameat2`: `NOREPLACE` for an absent registry, or `EXCHANGE` for
a successor. The latter retains the old inode at the temporary name for rollback.
The displaced inode is checked against the prior snapshot. Directory state is
synced and the actual resulting registry is verified again with exact semantic
and trust pins. A successful import removes the retained backup and lock. Normal
failure/scope exit restores the old inode or removes only the just-created
registry. Path/parent replacement and an uncoordinated new output writer are
rejected; rollback does not overwrite a different writer's replacement. Failed
rollback preserves prior data for inspection.

An abrupt process exit does not run destructors. The registry is a complete old
or new file, and the lock and any old-inode backup remain as recovery evidence.
The importer deliberately does not expire, steal or delete a foreign/stale lock;
this matches the original fail-closed lock policy. Recovery requires local
operator inspection of the lock's plan hash, the current registry, candidate,
trust pins and retained backup before an explicit filesystem repair. There is no
automatic crash-recovery command and no assumption that a missing import receipt
means publication did not occur. Run read-only status/preflight while investigating.

Atomic publication uses the repository's Linux runtime boundary and safe `nix`
APIs; there is no project-local unsafe code. The transaction coordinates this
operator's writers. A process with the same filesystem owner privileges can
modify files outside that protocol; replacement checks reject observed conflicts
and preserve recovery evidence instead of granting authority from them.

## Validation and regression work

`rust/oracle/portal-target-qualification-v1.mjs` calls the actual Node CLI and
repository implementations, with the production oracle profile verified as Node
22.23.1 and the actual production record-hash source. It generates ephemeral
Ed25519 authorities and never contacts a portal. The integration test is
`rust/crates/hepta-paper-service/tests/portal_target_qualification_parity.rs`.

The seven integration groups cover signed initial/sandbox/two-target/empty and
successor registries; exact status, preflight and plan outputs; current expiration;
missing/incorrect revocations, predecessor and generation failures; invalid and
revoked signers; authority independence and PEM/base64 policies; evidence and
binding diagnostics; pin drift and time boundaries; strict flags/environment
fallback; report-before-exit-2 and actual binary exit-0/1 behavior. Seven successful
import scenarios compare both full receipts and exact disk bytes against Node.
Parallel import, foreign locks, tampered candidates, hard links, writable trust
files and path aliases are rejected without clobbering existing data.

Four internal transaction tests cover absent/replaced registry rollback, pathname
and parent replacement, preservation of an unrelated writer and prior backup,
and a real child process abruptly exiting after atomic publication. All seven
integration groups and four transaction tests passed in the local validation
run. The strict production lint gate also passed with warnings, unsafe code,
unwrap, expect, panic, todo and unimplemented denied.

Reproduce with the pinned Node binary first in `PATH`:

```sh
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service --test portal_target_qualification_parity --locked
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service --lib portal_target_qualification --locked
rustup run 1.98.0 cargo clippy --manifest-path rust/Cargo.toml --workspace --lib --bins --all-features --locked -- -D warnings -D unsafe-code -D clippy::todo -D clippy::unimplemented -D clippy::unwrap_used -D clippy::expect_used -D clippy::panic
```

Changes to authority rules require rerunning journal qualification parity as well.
Changes to serialization, continuity or filesystem publication require rerunning
both operator suites. Public registry schemas and Node command flags remain the
compatibility contract; a local candidate/test pass is not an external production
acceptance event.
