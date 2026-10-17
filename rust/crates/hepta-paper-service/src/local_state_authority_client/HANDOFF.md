# Native local authority client

`hepta-paper-state-authority-client` replaces the Unix **client** in
`paper-core/bin/hepta-paper-state-authority-client.mjs` and
`requestLocalAutonomousResearchStateAuthority` from
`paper-adapters/automation/local-autonomous-research-state-authority-socket.mjs`.
It is an untrusted transport proxy, not an authority server, receipt verifier,
signer, deployment proof, or permission to mutate state. Production receipt
verification remains the responsibility of the existing pinned authority clients.

The binary accepts no arguments or `--help`, reads one JSON object from stdin,
sends JSON plus a newline to `/run/hepta-paper-state-authority/authority.sock`,
half-closes the socket's write side, reads to EOF, and unwraps only an envelope
with `ok: true` and an object `receipt`. Success prints the receipt as JSON and a
newline; the original truthy `receipt.help` convention is retained. Failure
prints one error message to stderr and exits 1. All arguments are checked before
help or stdin. There is no socket, executable, environment, or runtime override.
The library's `LocalStateAuthorityClientOptionsV1` permits an explicit Unix socket
path and smaller limits for embedding and transport tests.

## Direct socket transport and origin lifetime

`LocalStateAuthoritySocketTransportV1::connect(&options)` is a concrete
in-process `MutationAuthorityTransportV1`. It can be supplied directly to
`PinnedMutationAuthorityV1::load` together with the genuine independently pinned
online authority configuration and public key. It executes no command and
creates no key. The existing generic client APIs, installed client binary, and
`ProcessMutationAuthorityTransportV1` retain their existing behavior.

Construction connects to the configured Unix socket without sending a request,
captures its kernel `SO_PEERCRED` and `SO_PEERPIDFD`, and closes that empty probe
connection while retaining the original creator's close-on-exec pidfd. Every
RPC uses a new connection for the existing EOF-delimited protocol. It captures
that socket's own peer pidfd, requires the original PID/UID/GID, and checks both
pidfds for exit before and after comparing credentials. The original pidfd
cannot become live again for a recycled PID. There is no `pidfd_open(pid)`
lookup, pidfd-inode assumption, caller-selected expected UID, `/proc/PID/exe`
access, regular-file descriptor, or subprocess in this observation. Kernels
without the actual socket pidfd operation are refused; this route does not
fall back to numeric PID checks.

The same checks run before each socket write/read attempt and immediately
before a successful return. A different process rebinding the same pathname
is refused even if the original process remains alive. An exited creator is
refused even when its descendant retains the listener or accepted descriptor.
The transport never silently adopts a new origin. Explicitly creating another
transport after a restart establishes only another untrusted observation;
the owning composition must independently rebuild any required evidence.

The same concrete transport implements `StateBackupAuthorityTransportV1` by
delegating to this exchange. The dedicated
[`load_socket_v1` backup constructor](../state_backup_authority/socket/HANDOFF.md)
creates it from a separately pinned socket profile after capturing all regular
inputs. It does not waive the original backup process command pins, accept an
arbitrary caller transport, or establish native installation authority.

The concrete socket recovery-service factory uses the crate-private
`connect_recovery_pair` producer. It makes one empty probe, then retains the
same original `SocketPeer` allocation in both transports. Dropping either
client leaves the original pidfd owned by the other; neither channel refreshes
its origin after a restart. This producer exposes no public arbitrary clone,
alternate endpoint or caller-supplied peer. Its service validates public pins,
options and actual database/writer scope before probing and releases temporary
inventory descriptors before returning.

These are connection-creator credentials, captured by the kernel at
connect/listen time. They do not identify which thread or descendant processes
each byte when a still-live creator passes or inherits sockets, detect every
credential change/exec, measure a Rust executable, qualify a service principal,
or prove membership in a systemd unit. A Node service with the same valid
protocol and key remains possible at this layer. Actual daemon installation,
manager/host qualification, full topology V2 and native admission remain
separate prerequisites. No proof is accepted as JSON or emitted as a permit.

Transport failures retain the original error code and add
`details.transport = "local-state-authority-socket-v1"`, exact
`requestBytesSent`, `requestDelivery`, `authorityOutcome`, and
`inspectionRequired`. Before any successful write these are `not_sent`,
`not_invoked`, and false. After even one byte they are `sent`, `unknown`, and
true: a timeout, truncated/invalid response, lost creator, or untrusted rejection
cannot establish whether the authority committed. These failures are not
retryable and never report `committed: false`. The transport performs no
automatic request retry. Recovery must use the existing journal/receipt
protocol. Receipt contract and signature verification remain in the pinned
authority; this concrete transport itself returns an untrusted semantic Value.

The wire implementation shares the original client's private byte-limited,
strict-JSON, absolute-deadline exchange. Its peer checks add no public callback
or configurable ready predicate. No new archive/source file is opened or closed
while a caller holds SQLite locks; only sockets and pidfds are owned here.

## Bounds and intentional compatibility limits

The default socket deadline is 120 seconds, absolute across nonblocking connect,
write, and read. Ongoing peer progress does not renew it. The incumbent uses an
idle timeout; this deliberate stricter behavior prevents an indefinitely active
peer from holding the client. Library timeouts must be 1–120 seconds, and message
limits must be 1 KiB–256 MiB. The incumbent library has no corresponding upper
bounds. Requests include the newline in their limit, and responses count every
received byte. Raw stdin is also limited before parsing. Its blocking EOF read
precedes the socket deadline, matching the incumbent's synchronous stdin read.

The existing repository strict JSON parser is reused; it has no 16 MiB sublimit.
It rejects duplicate keys, invalid UTF-8, lone UTF-16 surrogate escapes, nonfinite
numbers and inputs beyond serde's nesting limit. Node accepts some of those
forms. The native path intentionally fails closed rather than adding another
permissive parser. The installed CLI now uses
`run_local_state_authority_client_json_v1` and
`request_local_state_authority_json_v1`: strict validation happens first, then
the original request bytes and the checked envelope's raw receipt preserve
object member order. This is required because the original Node schema contract
compares echoed `instances` and `installations` using `JSON.stringify`.
`RawValue` retains syntax only; it never bypasses strict validation. The existing
Value APIs remain semantic interfaces and cannot recover an order already lost
when a caller constructed a sorted Value. There is no workspace-wide
`preserve_order` change or change to canonical signature hashing.

The raw path preserves whitespace and numeric spelling as provided instead of
claiming exact V8 stringify compaction/rounding for arbitrary input. Normal
authority protocol integers must
already satisfy their safe-integer contracts. No hash/signature verification is
performed on reserialized transport bytes here. Non-string error coercion is
retained where representable; an uncoercible object returns a controlled error
instead of the incumbent socket callback's uncaught exception.

## Verification

`local_state_authority_client/tests.rs` uses real Unix listeners and the actual
pinned Node 22.23.1 client/server via
`rust/oracle/local-state-authority-client-v1.mjs`. Coverage includes half-close
before response, fragmented envelopes, original error codes, server rejection,
CLI precedence, strict parser differences, exact byte boundaries, absent sockets,
full connect backlog, blocked writes and response progress beyond the absolute
deadline. `tests/local_state_authority_client_cli.rs` runs the actual native
executable for help and failures that cannot contact a production authority.
The Node server fixture echoes request data; it has no signing keys and is not
used to qualify an authority or claim production native admission.

Additional raw-wire tests capture exact request bytes after half-close, return
nested nonalphabetical receipt members in fragmented envelopes, check preserved
CLI output order, and refuse duplicate/invalid requests and responses before any
untrusted receipt is returned. Full signed schema interoperability is exercised
separately by the actual Rust authority/business composition fixture.

The direct transport's unit suite covers rejected requests before sending,
preservation of unknown outcomes after sending, strict output/byte bounds, and
the absolute deadline despite response progress. Actual independent SQLite
writer probes remain blocked by the caller's held `BEGIN IMMEDIATE` across
transport construction, error and destruction in both DELETE and WAL modes,
and succeed after rollback. `tests/local_state_authority_socket_transport.rs`
uses the real Rust daemon and provided fixture key with the existing pinned
verifier, plus separate listener processes for origin exit, inherited sockets,
and replacement while the original creator stays live. These are protocol and
authority-journal tests; they do not prove a business SQLite mutation or a
qualified production installation. All daemon/principal/key tests use isolated
fixtures and do not contact the installed host authority.

Primary contract references: Linux [Unix socket credentials](https://www.man7.org/linux/man-pages/man7/unix.7.html),
the kernel's [socket peer pidfd operation](https://raw.githubusercontent.com/torvalds/linux/master/net/core/sock.c),
and [pidfd poll semantics](https://www.man7.org/linux/man-pages/man2/pidfd_open.2.html).
