# Retained authority command prerequisites

The online mutation and state backup pinned process verifiers each expose the
crate-private `assert_native_process_command_v1(&self, expected_path: &Path,
expected_hash: &Sha256Digest) -> Result<()>`. Their concrete process transports
provide the same assertion. Generic loading and protocol invocation continue to
accept executable scripts for incumbent compatibility and differential fixtures.

The assertion matches the exact configured command path, rehashes the existing
held executable descriptor with `read_at`, requires the ELF header marker, and
checks root UID/GID, mode 0555 or 0755, one hard link, and safe root-owned ancestor
directories. It rechecks the original configuration, public-key and command
snapshot identities. The backup v2 verifier also checks its actual retained
online verifier, including that verifier's public key. It performs no RPC, raw
regular-file open, descriptor clone, or descriptor close, including on rejection.
Load every original snapshot before opening SQLite and retain the owning pinned
clients until that SQLite connection has closed.

These are necessary file and installation predicates. They do not prove ELF ABI
or loadability, adapter behavior, external linearizability, native provenance,
deployment qualification, or activation. Node and other interpreters can themselves
be ELF files. Expected command identities must come from a separately verified
closed adapter binding; arbitrary caller paths or hashes cannot grant authority.

The current eight-role deployment contract does not explicitly map the online
mutation and backup child commands. Reviewed adapter implementations, their role
mapping and signed qualification, and checks before every native RPC remain open.
No native-ready, production-activation, or Node-retirement flag is changed here.

The adjacent tests use a real installed `/usr/bin/true` ELF solely for these local
file predicates, real executable scripts to check generic compatibility, genuine
pinned public-key documents, and separate processes observing SQLite BUSY.
Negative replacement cases alias the DELETE main file or WAL SHM file while the
owning connection holds an IMMEDIATE transaction. User-owned copied ELF tests
exercise only the descriptor primitive and are explicitly denied the root-owned
installation check. No production deployment capability is manufactured.
