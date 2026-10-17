# Native local authority and retained business integration fixture

This fixture exercises the actual Rust Unix server/runtime and native client
inside the existing, source-private retained reconciliation composition. It does
not construct a production deployment/native-process admission, external qualification, or
activated-runtime capability. Its supplied Ed25519
key belongs only to the isolated fixture. An executable's ELF format or fixture
hash is not evidence of independently reviewed adapter provenance.

`native-authority-business-composition-v1.mjs` uses the pinned original Node
22.23.1 implementation to create all ten source databases, the real schema25
campaign store and resident lease, and to execute the original schema transition.
Its original schema client receives every reserve/finalize/observe signature
from the actual running Rust authority. No hand-generated genesis, rewritten
signed receipt or fabricated marker/journal row substitutes for that protocol.
The Node fixture does not serve or proxy authority RPCs.

The normal process transports require empty arguments and clear the environment.
A dedicated Cargo **example**, `native-authority-fixture-client`, therefore runs
as the pinned process adapter. The test copies its ELF into a unique private
`/tmp/hepta-online-initial-composition-*` directory. The helper accepts no
arguments; its only socket binding is the exact three-field, bounded, private
`adapter.json` adjacent to that copy, naming that directory's `authority.sock`.
Requests cannot select a socket. Neither the production client default nor the
host's `/run/hepta-paper-state-authority/authority.sock` is modified or contacted.

The helper calls `request_local_state_authority_json_v1` with original bytes and
writes the returned strict-validated raw receipt to stdout. Parsed `Value`s are
used only in diagnostic logs; the log also retains the exact receipt JSON string
for truthful field-order diagnostics. This preserves the original Node schema
contract's order-sensitive `instances` and `installations` comparisons. The
oracle fails on any original verifier rejection. After the original schema
executor accepts its per-operation contracts, a separate pass verifies every
complete raw receipt signature with the original Node public-key verifier and
requires actual reservation, finalization and observation receipts. Its failure-only diagnostic
can determine whether instance property order alone explains rejection, but
never returns the projected object or changes authority state to make a test
pass.

Run from `rust/`, with the repository's pinned Node 22.23.1 on `PATH`:

```sh
cargo build -p hepta-paper-service --example native-authority-fixture-client
cargo test -p hepta-paper-service --lib \
  online_mutation_composition::activation::tests::native_authority_business \
  -- --nocapture
```

The system binutils `strip` tool is a test prerequisite. Debug examples can
exceed the real transport's 128 MiB command limit, so the test uses
`strip --strip-debug` on its fresh private copy **before** computing any pins or
opening the authority/composition. It never modifies the original build artifact
or raises a production resource limit. The example must be rebuilt when its
client dependencies change; the test never invokes nested Cargo.

The two primary scenarios run the real standard reconciliation. They inspect
actual business tables, receipt/event and SQLite changeset effects, real signed
authority journal/head progression, and the coordinator's original proof
invalidation after finalization. The refusal scenario rejects at the actual
post-reservation precommit boundary, expecting rollback of all business/marker
writes and a real authority abort. Separate-process SQLite probes verify that
retained checks preserve the writer lock and that closing the owning connection
releases it. A third test is the probe child entry point and has no standalone
production meaning.

Verified on 2026-09-21 with the pinned Node 22.23.1 toolchain: the three tests
above passed (455.84 seconds). This includes both real authority/business
scenarios and the lock-probe child. The original unsorted Node schema requests
passed the reservation, finalization and observation contracts after the native
wire layer preserved the two order-sensitive echo fields. Production admission,
installed adapter provenance and deployment/service cutover remain separate.
