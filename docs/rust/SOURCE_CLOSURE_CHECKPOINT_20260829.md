# Source closure checkpoint — 2026-08-29

This checkpoint triggers protected exact-head validation after the broker service
source closures were published.

The source head now includes:

- durable pre-exec gating before provider-target execution;
- executable object identity and bounded fork/exec race handling;
- startup reconciliation and new-attempt classification for ambiguous execution;
- read-only identity/schema preflight before any writer or WAL mutation of an
  existing broker database;
- byte-preserving rejection tests for foreign empty and populated SQLite files;
- authority-owned canonical JSON loading for externally signed capability trust
  bundles, including separate-authority production policy, exact owner/group/mode,
  single-link and no-symlink requirements, bounded bytes, descriptor identity
  revalidation, canonical serialization and content hashing;
- bounded listener, queue, response, recovery, backup/restore and acknowledgement
  source contracts already present in this stacked service slice.

This file does not grant live-provider, credential, campaign-writer, release or
submission authority. Protected Rust and repository CI on this exact head remain
the source qualification evidence. Installed-host, independent-review and
external-authority evidence remain separate deployment gates.
