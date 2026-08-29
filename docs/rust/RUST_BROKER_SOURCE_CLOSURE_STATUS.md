# Rust broker source closure status

Status: source-level development blockers closed for the bounded broker slice;
installed-host and live-provider qualification remain separate hard gates.

## Closed source boundaries

- existing broker databases are verified through a read-only, no-follow preflight
  before any writer connection or persistent pragma is permitted;
- unmarked empty and foreign populated SQLite files are rejected byte-identically
  without WAL or SHM creation;
- duplicate admission ignores later broker-observation time while preserving the
  original reservation, nonce count and transition count across restart;
- SIGKILL subprocess tests exercise open reservation and transition transactions and
  prove recovery exposes only the pre-transaction or committed state;
- corrupt database, invalid sidecar and permission drift fail closed;
- signed Ed25519 trust bundles can be loaded only from a canonical, single-link,
  separately owned, authority-controlled read-only source;
- corrupt, noncanonical, symlinked, writable or rejected refresh sources disable new
  admission instead of retaining stale authority.

## Authority retained outside this source slice

This code does not establish installed ACL/mount/systemd evidence, an independent
low-level Unix review, real Codex credentials, live provider compatibility, campaign
writer authority, release authority, KMS/HSM/WORM authority or submission authority.
