# Native local state authority implementation

Status: source implementation and local contract tests; production installation,
independent acceptance, existing Node journal migration and Node retirement remain
open. This support daemon is a separate principal and executable in the intended
deployment. Adding it to `hepta-paper-service` does not increase the authority
ceiling of the control-plane module or prove that deployment separation exists.

## Entrypoints and ownership

- `hepta-paper-state-authority-daemon [--configuration PATH]` loads the default
  `/etc/hepta-paper/state-authority/daemon-config.json` when omitted. Strict
  parsing supports `--configuration=PATH`, parses every option before `--help`,
  rejects unknown, duplicate, missing and empty options, and resolves relative
  configuration paths lexically against the actual working directory.
- `hepta-paper-state-authority-client < request.json` uses only the fixed
  `/run/hepta-paper-state-authority/authority.sock`. Its binary exposes no socket,
  timeout, environment or runtime override. Library transport options are for
  explicit compositions and tests; they do not establish authority.
- `LocalStateAuthorityRuntimeV1::open`, `handle` and `inspect` own the authority
  SQLite connection. `LocalStateAuthorityServerV1::bind` and `serve` own its Unix
  listener. No public API takes an accept-all signer callback, a caller-supplied
  production flag, or arbitrary SQL. The runtime signs using its actual supplied
  private key. A process able to read that key can call the library; only real OS
  custody and qualified deployment can establish separation from a writer.

Implementation: [runtime](../../rust/crates/hepta-paper-service/src/local_state_authority.rs),
[storage](../../rust/crates/hepta-paper-service/src/local_state_authority/storage.rs),
[server](../../rust/crates/hepta-paper-service/src/local_state_authority/server.rs),
[client contract](../../rust/crates/hepta-paper-service/src/local_state_authority_client/HANDOFF.md).
The incumbent is `paper-adapters/automation/local-autonomous-research-state-authority-*.mjs`
and the two `paper-core/bin/hepta-paper-state-authority-*.mjs` entrypoints.

## Configuration and private-key boundary

The exact configuration has version `1`, kind
`HeptaLocalAutonomousResearchStateAuthorityConfiguration`, `authorityId`, `keyId`,
`scopeId`, `databaseScopeHash`, `writerManifestHash`, `privateKeyPath`,
`stateDatabasePath`, `socketPath`, `maximumReservationLeaseMs` and
`maximumObservationAgeMs`. Unknown fields are rejected. Hashes use `sha256:` plus
64 lowercase hexadecimal digits. Lease and observation bounds are integral
1000–900000 milliseconds. Three configured paths must be canonical absolute
paths without symlinks, NUL, dot traversal or duplicate separators.

The configuration is at most 1 MiB; the supplied PKCS8 Ed25519 private key is at
most 64 KiB and must belong to the actual effective UID with no group/other
permission. No private key is created. Input snapshots reject hard links,
writable-by-other files and changed identities. Private-key byte buffers are
zeroized after decoding while the original descriptor remains held. Configuration
and key snapshots are captured before SQLite and released after its connection.
The actual public-key hash is persisted separately from the caller's key ID.

Installation must create the authority state directory first, owned by its
effective UID with mode 0700. The database is one nonlinked regular file with
mode 0600. Directory and database identities are retained; all state-directory
ancestors are checked with `lstat` on subsequent use, including type, identity,
owner, group and mode. Checks do not open or clone a database descriptor and do
not release process-associated SQLite locks. Configuration and key retain their
existing snapshot ancestry checks. Parent or database replacement, including a
renamed ancestor redirected through a symlink to the same inode, fails closed.

## State and transaction contract

The native journal has user_version `1`, seven STRICT tables and the exact
[registered schema](../../rust/crates/hepta-paper-service/src/local_state_authority/schema.sql).
Startup accepts a new empty version-0 file or an exact native version-1 schema;
an existing Node version-0 journal requires explicit migration. A version-1 file
with missing tables is corruption, not a fresh genesis. WAL, synchronous FULL and
foreign keys are enabled; SQLite busy timeout is five seconds.

Every complete request runs inside one IMMEDIATE transaction. Before dispatch,
the current metadata must match the complete actual configuration, authority,
key, scope and writer manifest, and the stored key hash must match the loaded
key. Inputs and monotonic system time are checked before commit. Any error before
commit rolls back all state writes. Inspection also takes the owning transaction
and checks current identity. The runtime field order closes SQLite before any
held configuration, key or directory descriptor is released.

The state contains metadata/global head, per-database heads, initial schema
transition, pristine schema-rebind history, mutation history, backup reservations,
and actual native key identity. Stored receipts are revalidated with their
original requests, exact contracts and real signatures before reuse. The live
global-sequence uniqueness index excludes aborted mutations: abort preserves
signed evidence without consuming a finalized sequence.

## Request and receipt transitions

All 15 incumbent request kinds are dispatched explicitly; unknown kinds fail.
Version-2 rebind uses the same three schema request kinds with the version-2
contract. There is no generic mutation or arbitrary signing endpoint.

| Family | Actions | Transition and signed evidence |
|---|---|---|
| Online mutation | reserve, finalize, abort | Exact scope/head and global exclusion; request-bound reservation; finalized global/database chain; signed abort retaining history |
| Online observation | resolution, unresolved list, current head, active challenge, scope | Persisted reservation disposition and current authority facts, with existing protocol signatures |
| Schema transition | reserve, finalize, observe | Version-1 genesis installation or version-2 pristine rebind; request/installation hashes and exact signed preimage |
| Backup | reserve, finalize, current head, journal range | Live mutual exclusion, unchanged terminal head, genuine lease, verified continuous signed range |

See [mutation source and tests](../../rust/crates/hepta-paper-service/src/local_state_authority/mutation.rs),
[backup contract](../../rust/crates/hepta-paper-service/src/local_state_authority/backup/HANDOFF.md)
and [schema-rebind contract](../../rust/crates/hepta-paper-service/src/local_state_authority/schema_rebind/HANDOFF.md)
for exact guards and failure cases. Signature domains, original request hashes,
receipt fields and statuses use the existing protocol implementations. UUIDv4
reservation identities come from OS randomness. An actual monotonic observation
of system time controls issuance and expiry; the binary has no injected clock.

Version-2 finalization leaves activation pending. Only reopening under the full
exact target configuration and same actual key activates the signed transition,
atomically replacing all ten heads and metadata. A still-running source instance
then fails its transaction identity gate even if its old configuration file and
held descriptors remain unchanged. Source `inspect` is fenced as well.

## Socket framing, resources and shutdown

Requests are JSON objects terminated by EOF after the client half-closes its
write side. Responses are one newline-terminated `{ok:true,receipt}` or
`{ok:false,error}` envelope followed by EOF. Strict JSON rejects duplicate keys,
invalid UTF-8, lone surrogates, excessive depth and nonfinite numbers. Native
object ordering follows the Rust JSON representation; wire-byte equality with
all JavaScript JSON inputs is not claimed.

The server multiplexes up to 64 nonblocking connections with a 64 KiB I/O quantum
per peer. Only complete requests enter the single state owner. An idle writer or
blocked response reader cannot reserve the whole authority queue. Each request
and response is limited to 256 MiB, with a shared 256 MiB retained wire-buffer
budget; parsed values and SQLite work require additional qualified host memory.
Excess connections, wire-budget overflow and transport failure close the affected
connection. The absolute per-connection deadline is 120 seconds, rather than the
incumbent's idle-timeout behavior. Backpressure or a lost response never converts
a committed transition into a safe retry: callers must use the persisted
idempotency/resolution protocol.

The socket parent and its ancestry must be trusted directories owned by root or
the actual authority principal, with sticky protection where a shared ancestor
is writable. The immediate parent belongs to the effective UID/GID and excludes
other-user access and group writes. A fresh 0700 staging directory prevents a
permissive process umask from exposing an unprotected provisional socket. The
0660 socket is published with an atomic no-clobber hard link, then its temporary
name is removed. Ownership, mode, link count, parent and ancestor identities are
checked while serving. Cleanup removes only names that still identify the
service's own socket. Live, uncertain, aliased or unrelated existing names are
not overwritten. Stale-socket recovery requires an actual refused connection
and fresh identity/owner/namespace checks before unlinking.

The daemon handles SIGINT/SIGTERM by stopping admission, dropping incomplete peers,
closing the listener/runtime and removing its own socket name. Abrupt process
death leaves SQLite recovery and a possibly stale socket; successful socket
reclamation does not establish independent production recovery qualification.
Daemon errors emit one code line, whereas the Node executable includes a stack.
Tests compare strict parser messages and successful help output, not stack bytes.

## Intentional corrections to incumbent behavior

Two defects were reproduced against the original Node code. Its unconditional
global-sequence UNIQUE constraint prevented a new reservation after an abort
because the aborted row retained the unconsumed sequence. Its backup lease did
not block a mutation, and backup finalize could subsequently sign an obsolete
head with `allRegisteredMutationsFencedThroughFinalize=true`.

The native partial index preserves abort evidence and allows the still-unconsumed
sequence. Live backup reservations block new mutations; new backup finalization
requires the still-valid lease, unchanged actual head and no pending mutation.
Completed results remain idempotent after expiry only after verifying their
stored signed bindings. Journal-range responses must end at the actual current
head and verify each stored chain link. These are reviewed correctness changes,
not claims that every incumbent behavior is byte-identical.

An unfinished backup row, even expired, still blocks pristine schema rebind as
in the incumbent. No automatic deletion fabricates completion. Explicit recovery
of abandoned rows is a remaining protocol-policy task.

## Validation and remaining integration

Local tests use supplied isolated fixture keys, actual SQLite files and
transactions, real Unix sockets and actual Node 22.23.1 contract verifiers. They
cover genesis/restart, all mutation and backup actions, Node client to Rust server,
Rust client to Node server, exact successful backup signatures, genuine pristine
rebind/restart, old-instance fencing, failure rollback, expiry, tampering, two
competing connections, DELETE/WAL lock retention, path replacement, strict CLI,
permissive-umask startup and signal shutdown. They do not fabricate a deployment
qualification, cutover authority, external signature or live provider result.

Run from `rust/` with the repository-pinned Rust toolchain and Node 22.23.1 on PATH:

```sh
cargo test -p hepta-paper-service --lib local_state_authority
cargo test -p hepta-paper-service --test local_state_authority_client_cli --test local_state_authority_daemon_cli
cargo clippy -p hepta-paper-service --lib --tests -- -D warnings
```

The daemon and client are source executables. Remaining work includes explicit
authenticated Node-journal migration and recovery, real old-process stop/restart
fencing, installed executable/key/configuration custody, pinned process-adapter
and deployment-topology binding, an actual qualified native writable composition,
external host/crash/retention evidence, full command-mode acceptance and removal
of every remaining Node dependency. Defaulting to a fresh empty journal must never
be treated as migration or recovery of a lost production journal. Source tests,
an ELF header and this document cannot authorize that deployment or retire Node.

The [explicit journal migration design](../../rust/crates/hepta-paper-service/src/local_state_authority/JOURNAL_MIGRATION_DESIGN.md)
records the observed Node/native DDL differences, exact history-validation
requirements, archive and transaction order, and the still-required real
maintenance barrier. In particular, the old Node runtime ignores user_version
and can open a native-format journal. A database version or successful SQLite
lock cannot prove that old authority writers have stopped.
