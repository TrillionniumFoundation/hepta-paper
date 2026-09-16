# Native online authority evidence cache

This ports the original cache contract and repository adapters in
`paper-domain/automation/autonomous-research-online-authority-evidence-cache-contract.mjs`
and `paper-adapters/automation/autonomous-research-online-authority-evidence-cache-repository.mjs`.
The cache role is always `passive-status-only-never-mutation-authorization`.

## APIs and evidence ownership

`online_authority_evidence_cache::contract` implements the exact record keys,
hash domains, contract hash, active-refresh shape, subject, sequence and expiry
checks. A structural check does not verify embedded signatures.
`record_passive_authority_evidence_cache_v1` writes the actual cache and returns
the Node-compatible write receipt. `read_passive_authority_evidence_cache_v1`
returns the complete passive evidence projection with
`externalActionPerformed: false`. Both use ordinary JSON, which cannot be passed
as an active mutation permit.

`verified::record_verified_authority_evidence_cache_v1` additionally requires
an opaque real database inventory, complete writer source proof and three real
signed authority observations. It returns a private `VerifiedAuthorityCacheWriteV1`
only after the write and currentness checks. Its `assert_current` requires the
original evidence and pinned authority again, rechecks actual inventory and source,
compares the on-disk cache hash, and samples the clock after those checks. Reading
cached JSON cannot reconstruct this type. It is one activation dependency, not a
complete runtime activation or mutation capability.

## Actual storage and replacement

The fixed path is `automation-cache/online-authority-evidence-v1/current.json`.
All directory traversal uses held descriptors and refuses symlinks. Parent names
are checked against retained identities. The cache parents reject group/other
write permission. Existing cache files must be regular, have exactly one link,
be owned by root or the current user, have mode 0400, and contain 2 bytes–4 MiB.
Reads reject duplicate JSON members, malformed UTF-8, FIFOs and oversized inputs.
These are intentionally stricter input limits than incidental Node parsing.

The writer uses the incumbent canonical lock name and v4/v5/v6 immutable owner
record protocol. It records the actual Linux process start identity, atomically
links the canonical lock, binds an empty 0600 temporary inode before writing, then
publishes its completed 0400 identity in a new immutable owner record. Owner
replacement uses a staged hard link and atomic rename. A directory-sync error
after publication does not imply that the previous lock remains current.

The cache replacement is monotonic: a different cache cannot lower global
sequence, change the hash at the same sequence, reuse an earlier/equal recorded
time, or reuse an earlier/equal expiry. Identical hashes are idempotent. The writer
rechecks the exact old file snapshot before replacing it, syncs data and final
mode, renames inside the held directory, syncs the directory and reads back the
published document before returning its receipt.

## Crash and cleanup

Live or unprovably stale owners remain blocked. Stale recovery compares actual
process start identity, verifies the canonical and owner hard-link pair twice,
and removes only the bound one-link temporary inode. It also examines orphaned
owner/publish records on both sides of the canonical rename. Enumeration is
bounded to 4,096 entries and rejects invalid UTF-8 names. Unknown/unbound files
are retained instead of guessed deleted. Temporary creation and lock ownership
have RAII cleanup for errors and Rust unwinding.

Cleanup metadata checks and unlink operations both use the same held directory.
A rebinding of the textual parent path cannot make cleanup inspect one directory
and delete from another. These are current filesystem observations and cooperating
cross-process ownership, not a claim to exclude every future modification by a
fully compromised same-user process.

## Verification

`tests/online_authority_evidence_cache_parity.rs` invokes the real Node contract
and file repository. It compares complete records, hashes, passive reads and
replacement failures, including integer-valued JSON number spellings. It writes
and reads each implementation's actual files, checks live Node locks block Rust,
and kills real Node v4/v5/v6 owners before native recovery. Negative fixtures
cover unsafe permissions, symbolic/hard links, duplicate JSON, size bounds and
FIFOs without overwriting the rejected input.

Module-local storage tests reproduce directory rebinding, verify foreign inode
preservation, exercise empty-stage binding/error/unwind and use a fresh held
directory cursor for each bounded enumeration. Lock tests cover native-to-Node
ownership and crash recovery. The verified wrapper test creates ten real SQLite
databases, performs the actual writer scan and Ed25519 observation chain, writes
the cache, and rejects expiry, clock rollback, wrong root, replaced cache and
changed database inventory. Cache operations make no new authority RPC.

```bash
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --test online_authority_evidence_cache_parity --locked
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --test online_runtime_active_refresh_parity verified_cache_write --locked
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --lib online_authority_evidence_cache:: --locked
```

## Remaining integration

The full activation assembly must combine this dependency with actual startup
recovery, finalized heads, schema-transition readiness, restore/recoverability
evidence and the real authority challenge. No cache hit, local fixture signature
or caller readiness boolean substitutes for that assembly or its independent
production qualification.

Final clock checks enforce both exclusive receipt expiry and the inclusive `maximumObservationAgeMs` limit of every signed head/challenge/scope receipt. A still-unexpired receipt is rejected when source/cache I/O crosses its observation-age limit. The real-signature cache regression uses a 1000 ms observation limit and 60000 ms expiry, accepts the exact 1000 ms boundary, and rejects 1001 ms at both retained-proof reuse and the final write sample.
