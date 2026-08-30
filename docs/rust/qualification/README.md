# Installed and external qualification

This directory contains evidence-producing work that cannot be inferred from
source compilation alone. Repository-local schemas, validators and harnesses may
reach `package_ready`; only separately controlled execution and signed review may
reach `externally_accepted`.

## Canonical package authority

- `external-package-map.v1.json` is the machine-readable mapping from every
  external gap in `docs/rust/current-status.v1.json` to its package ID, issue,
  schema set and executor domain.
- `PLAN_V3_EXTERNAL_PACKAGE_INDEX.md` is the reviewer-facing index.
- `PLAN_V3_EXTERNAL_GAP_EXECUTION.md` is the normative execution and ingestion
  protocol.
- `protected-main-ruleset-evidence-v1.schema.json` defines the no-bypass
  `refs/heads/main` ruleset and seven-denial-test evidence for `GAP-GOV-003`.

An unmapped external gap, unknown package, missing schema, mismatched issue or
`automaticActivation: true` is a source-governance failure and is rejected by
`rust-plan-v3-external-contracts`.

## Installed broker artifacts

- `hepta-broker-host-qualification-v2.sh` runs against a **dedicated,
  non-production qualification instance** on the target host.
- `hepta-broker-qualification-evidence-v1.schema.json` defines the immutable
  machine record emitted by the harness.
- `hepta-broker-host-qualification.sh` is retained only as the original draft;
  use v2. It will be removed after downstream operators have moved to the
  syntax-checked v2 entry point.

The repository binaries used by the harness are:

```text
hepta-broker-journal-preflight
hepta-trust-bundle-preflight
hepta-codex-preexec-gate
```

## Required topology

The authority, broker and Codex principals must have distinct UIDs. The broker
database must live on a dedicated qualification mount owned by the broker. Gate,
schema and trust-bundle files must be installed from the exact source commit and
owned by their separately controlled authority.

The harness refuses to start when:

- any required path is relative or missing;
- any principal is absent or two authority domains share a UID;
- the database is outside the dedicated qualification mount;
- the evidence directory already exists;
- the current user is not root.

## Normal run

The normal run collects object identity, hashes, mount options and systemd
hardening, then performs a real broker-main `SIGKILL`, bounded restart, journal
preflight and corruption-on-copy rejection. It never corrupts the live journal.

## Destructive storage run

Read-only remount and disk-exhaustion drills are disabled by default. They are
unlocked only with:

```text
HEPTA_DESTRUCTIVE_STORAGE_DRILL=YES
```

The database is still required to be under `HEPTA_TEST_MOUNT`, which must be a
separate mount dedicated to the qualification instance. Production data must
never be placed there.

## Evidence closure

The harness writes canonical JSON plus per-file SHA-256 hashes and makes the
evidence tree read-only. A separately controlled reviewer must inspect the
source commit, service unit, object identities, logs and drill outcomes, then
change `independentReview` from `pending` to `approved` in a separately signed
review record. The harness deliberately cannot self-approve that field.

A successful source or GitHub-hosted run does not authorize real Codex
credentials, live provider calls, release signing or submission. External
package acceptance never merges a pull request or activates production
automatically.

## Aggregate trust and replay boundary

The aggregate verifier uses `qualification-trust-store-v1.schema.json`, immutable
payload hash binding and a private durable SQLite nonce/trust-generation ledger.
See `EXTERNAL_QUALIFICATION_CLOSURE.md`.
