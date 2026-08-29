# Rust durable pre-exec gate and development-blocker status

Status: source implementation complete; protected exact-head qualification is
required for every published head. Independent installed-host qualification
remains a separate authority boundary.

## Implemented source boundaries

- stopped pre-exec gate in a fresh Linux session and process group;
- gate, target, envelope, process-start and boot identity binding;
- executable-object verification by device and inode rather than path spelling;
- atomic SQLite process linkage before target release;
- separate durable release authorization;
- exact target-object execution through an opened descriptor;
- inherited non-stdio descriptor closure;
- bounded termination, process-group cleanup and startup reconciliation;
- ambiguous provider outcomes force a new campaign attempt;
- stable `CODEX_HOME` directory-object identity with exact independent config and
  credential-material contracts;
- separate schema-authority production mode;
- signed Ed25519 capability bundles with generation chaining, rotation,
  revocation and rollback rejection;
- private role-specific listener lifecycle and recorded stale-socket recovery;
- existing broker databases undergo read-only, no-follow identity/schema
  preflight before any writer connection, persistent pragma or DDL;
- trust-bundle source bytes come from a bounded, canonical, single-link,
  authority-owned read-only file, with production authority distinct from the
  broker UID and descriptor/path object revalidation after reading.

## Qualification model

The Rust workflow is authoritative for the exact pull-request head and must pass:

```text
cargo metadata --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
RUSTDOCFLAGS=-D warnings cargo doc --workspace --all-features --locked --no-deps
```

The repository workflow must independently pass static/security gates, all
impacted-test shards and migration differentials on the same head. This update
is intentionally authored outside the restricted publishing workflow so GitHub
runs those protected checks for the source commit immediately preceding it.

## Boundaries not represented as source-development completion

The following require evidence from separately controlled infrastructure and are
not manufactured by repository code or GitHub permissions:

- independent review of the low-level Linux primitive;
- root/deployment-owned installed gate and schema objects distinct from broker
  and Codex service UIDs;
- installed ACL, mount, immutable-deployment and service-manager evidence;
- host reboot, broker crash, disk-full and corruption drills on the target host;
- authenticated live Codex completion under separate author/reviewer homes;
- KMS/HSM, WORM, release, portal and submission authorities.

Until those records exist, real provider credentials and production composition
remain disabled even when all source-development checks are green.
