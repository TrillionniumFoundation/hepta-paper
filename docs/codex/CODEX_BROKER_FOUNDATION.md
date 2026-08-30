# Codex broker Foundation V1

Status: additive source slice; no real Codex credentials or production authority

## Scope

This slice implements the local security primitives required before a broker may
attempt real Codex qualification:

- executable content and Unix filesystem identity;
- private `CODEX_HOME` and `config.toml` identity;
- metadata-only inspection of known credential material;
- default-deny parent and model-child environments;
- bounded stdin/stdout/stderr and exact output hashes;
- new process-group creation, deadline termination, escalation and descendant
  cleanup verification;
- preflight/postflight runtime drift detection.

It does not implement the broker Unix socket, request signature verification,
SQLite operation persistence, real Codex login/status checks, model calls,
workspace mutation authority, campaign integration, release, or submission.

## Runtime filesystem contract

The Foundation V1 inspector rejects:

```text
relative or noncanonical executable/home paths
final or parent symlink aliases
non-regular executable/config/credential nodes
unexpected executable or credential hard links
group/world-writable executable files
group/world-visible Codex home/config/credential material
owner or optional group mismatch
size-limit violations
path replacement during content hashing
credential paths escaping CODEX_HOME
```

Executable and config bytes are SHA-256 hashed. Credential bytes are never
opened or hashed; only path hash, file type, device, inode, mode, UID, GID, link
count, size, and timestamps are bound.

Production composition must use a binary owned by a principal that the broker
cannot modify, normally root or a deployment authority. Preflight/postflight
identity detects ordinary replacement but does not by itself eliminate an
attacker that can replace and restore a writable executable between checks.
Writable runtime roots therefore fail deployment qualification.

## Environment contract

All supervised processes use `env_clear`. The environment is rebuilt from an
explicit versioned allowlist plus explicit overrides.

The model-child policy excludes:

```text
CODEX_HOME
OPENAI_*
AWS_*
GITHUB_*
KMS_*
PORTAL_*
SUBMISSION_*
WORM_*
BACKUP_*
*_KEY
*_TOKEN
*_SECRET
*_PASSWORD
*_CREDENTIAL
```

The environment policy and resulting environment are independently hashed.
Unknown, non-UTF-8, oversized, or secret-like allowed values fail closed.

## Process supervision contract

The supervisor:

1. accepts an absolute executable and absolute working directory only;
2. performs no shell interpolation;
3. creates a new Unix process group using PGID equal to the child PID;
4. writes bounded stdin on a dedicated thread;
5. drains stdout and stderr concurrently while hashing exact bytes;
6. retains only a bounded tail;
7. requests group termination on timeout or output-limit violation;
8. escalates to `SIGKILL` after a bounded grace period;
9. detects a leader that exits while descendants remain;
10. verifies the process group no longer exists before returning success.

Foundation V1 uses the absolute system `kill` utility for safe process-group
signals because the workspace forbids unsafe Rust. Absence or failure of that
utility is a hard error, not a best-effort success.

## Preflight/postflight binding

The qualified execution wrapper binds:

- the exact inspected executable path to the supervised process executable;
- `HOME` and `CODEX_HOME` to the inspected private home;
- the environment-policy hash to runtime identity;
- the transport-profile hash and model selector to runtime identity;
- executable, config, credential metadata and aggregate hashes before and after
  process cleanup.

A process error still triggers postflight inspection. When both execution and
identity drift fail, the combined error preserves both facts rather than hiding
runtime replacement behind the process failure.

## Negative tests

The source slice includes tests for:

- symlinked executable;
- hardlinked executable;
- group-writable executable;
- group-readable Codex home/config;
- symlinked credential material;
- provider secret exclusion from child environment;
- forbidden secret-like allowlist extension;
- stdout and stderr overflow termination;
- TERM-resistant process escalation;
- timeout and descendant cleanup on Linux;
- config mutation between preflight and postflight.

Additional qualification before real Codex:

- executable/config/auth replacement races under load;
- credential probes through `/proc`, shell startup files and inherited FDs;
- simultaneous stdout/stderr pressure;
- process-tree fork storms within resource controls;
- cancellation at every spawn/read/wait/cleanup boundary;
- exact runtime version/flag/event transcript qualification.

## Authority statement

The crate may inspect local files and launch only explicitly supplied local test
executables. It has no campaign database, provider network, credential
serialization, release, KMS, WORM, backup, portal, or submission capability.
Real Codex execution remains disabled until Foundation and broker qualification
checks run successfully on the pinned Rust toolchain.
