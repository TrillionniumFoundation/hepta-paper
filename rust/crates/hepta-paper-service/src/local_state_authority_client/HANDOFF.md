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
