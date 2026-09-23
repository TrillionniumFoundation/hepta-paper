# Rust broker source closure status

Status: source-development and GitHub-hosted installed-qualification blockers are
closed for the bounded broker slice. Independent target-host, live-provider and
external-authority qualification remain separate hard gates.

Qualified implementation head:

```text
75c4f4d03b7f1694d63faff655115c26cb6b9cad
```

Protected exact-head workflow record for that implementation head:

```text
rust-foundation                         33245708143  success
hepta-paper-ci                          33245708157  success
rust-qualification-artifacts            33245708144  success
rust-broker-installed-qualification     33245708158  success
rust-broker-installed-qualification-v2  33245708549  success
```

The five runs used Ubuntu 24.04. The Rust source gate used Rust 1.98.0 and
completed locked metadata, rustfmt, workspace/all-target Clippy with
`-D warnings`, all-feature workspace tests, and rustdoc with warnings denied.
The repository workflow independently completed static/security gates, the
impact-selected test plan and migration differential policy. The qualification
workflows built the checked-in preflight binaries and exercised real Unix users,
groups, ownership, modes and installed executable paths on the hosted machine.

This file records the code-bearing implementation head immediately before this
closure-record update. It does not self-qualify later commits: every later PR
head must obtain its own protected exact-head conclusions.

## Closed source and hosted-CI boundaries

- existing broker databases are verified through a read-only, no-follow preflight
  before any writer connection or persistent pragma is permitted;
- unmarked empty and foreign populated SQLite files are rejected byte-identically
  without WAL or SHM creation;
- duplicate admission ignores later broker-observation time while preserving the
  original reservation, nonce count and transition count across restart;
- SIGKILL subprocess tests exercise open reservation and transition transactions
  and prove recovery exposes only the pre-transaction or committed state;
- corrupt database, invalid sidecar and permission drift fail closed;
- signed Ed25519 trust bundles can be loaded only from a canonical, single-link,
  separately owned, authority-controlled read-only source;
- corrupt, noncanonical, symlinked, writable or rejected refresh sources disable
  new admission instead of retaining stale authority;
- installed qualification materializes distinct broker, author and reviewer
  principals plus separate trust and schema reader groups;
- root-owned `0440` trust/schema files and the root-owned `0555` pre-exec gate are
  readable only by the intended principals and are not chmod/rewrite/replace/link
  mutable by the broker or Codex role principals;
- the broker-private listener root remains `0700`, the socket identity is captured
  by the broker principal, cross-role connection fails, and lifecycle tests execute
  as the installed broker UID against the canonical installed gate;
- qualification evidence is uploaded for the exact workflow SHA rather than used
  as a substitute for protected checks.

## Authority retained outside this repository slice

GitHub-hosted root and UID tests are strong regression evidence, but they do not
constitute independent acceptance of a production host. This code and its hosted
workflows do not establish:

- an independent low-level Linux review;
- target-host ancestor ACL, mount, immutable-deployment, systemd and reboot state;
- target-host disk-full, destructive storage and long-running crash drills;
- production capability key-owner rotation/revocation evidence;
- real Codex credentials or authenticated live author/reviewer completions;
- campaign-writer, release, KMS/HSM/WORM, portal or submission authority.

Those records must come from separately controlled infrastructure. Until they
exist, credential-bearing provider execution and production composition remain
disabled even though the repository and hosted-CI development blockers are green.
