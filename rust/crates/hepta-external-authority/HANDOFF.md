# External authority ports and verifier responsibility

[`lib.rs`](src/lib.rs) defines four external ports and a request/receipt shape
validator. It provides no production signer, credential loader, network client,
nonce store or independent cryptographic verifier. `Send + Sync` constrains an
implementation's Rust type; it does not impose a timeout or establish independence.

## Inputs and exact responsibility split

`ExternalAuthorityRequestV1` contains version, authority kind, operation ID,
request/subject hashes, nonce and deadline. The four closed kinds are release
signer, WORM custody, backup/restore and submission dispatcher. Identifiers use
1–128 ASCII bytes from letters, digits, `-_.:`; digests are lower-case
`sha256:` plus 64 hexadecimal characters. Version must be 1 and the supplied
deadline must be later than the caller's supplied time.

| Boundary | Checks performed here | Required external owner |
|---|---|---|
| `validate_external_request_v1` | Shape, operation/nonce syntax, hash syntax and supplied deadline. | Actual request/subject bytes, authenticated clock, uniqueness and durable nonce reservation. |
| `verify_external_receipt_v1` before callback | Request validation, receipt version/kind/operation/request-hash equality, domain/key-ID syntax, nonempty signature string, nonzero issue time no later than now, expiry later than now and result-hash syntax. | Actual signature bytes/encoding, signed body, trust root and signer/key custody. |
| `ExternalReceiptVerifierV1::verify` | The wrapper passes the entire request, receipt and supplied time to this implementation, then propagates its result. | Cryptography; exact subject/nonce/result binding; trust generation/revocation; issue/expiry policy; anti-replay storage and currentness. |
| `validate_distinct_authority_domains_v1` | Exactly one of each kind and four unequal domain strings. | Verify each receipt first, then establish that the four domains represent independently controlled real authorities. |

The receipt has no direct subject-hash or nonce field. The verifier must
establish those through the exact authenticated request/signature contract;
checking `requestHash` text alone does not recompute that binding. The wrapper
does not even decode `signatureBase64`; a nonempty string passes its shape test.
It also places no byte ceiling on that string. An untrusted intake must impose
total bytes, count and signature-encoding bounds before constructing the values.

`verify_external_receipt_v1` returns `Result<(), ExternalAuthorityError>`, not a
durably accepted or opaque receipt. An always-successful callback defeats the
intended verification boundary. Neither a Rust trait implementation, a fixture
nor four different domain names is independent qualification. The real
[qualification ingest contract](../hepta-qualification-ingest/HANDOFF.md) has a
separate verified-package and durable acceptance boundary; these ports cannot
manufacture its opaque objects.

## External operation and recovery ownership

| Port | Method | Effect which its implementation must control |
|---|---|---|
| `ReleaseSignerPortV1` | `sign_release` | One exact independently controlled release signature. |
| `WormCustodyPortV1` | `retain_object` | Immutable object retention and custody evidence. |
| `BackupRestorePortV1` | `prove_restore` | Independently controlled restore proof. |
| `SubmissionDispatcherPortV1` | `dispatch` | One exact portal/API submission or its reconciliation. |

The crate supplies no ordering, retry loop, process isolation or transaction
around those methods. The caller must validate before dispatch, retain the exact
request and durable operation/nonce identity, enforce the deadline, then verify
the response and reconcile the result before granting any permission.

`externalActionMayHaveStarted` is data passed to the verifier; the wrapper does
not reject or resolve it automatically. `ResultAmbiguous` must lead to external
status/recovery under the original operation identity, not another effectful
attempt. Even `Unavailable` cannot by itself prove that no bytes were sent or
that the provider did not commit. Only a concrete adapter's delivery evidence
can classify a safe retry. Malformed/bad-bound/expired receipts and rejected
verification do not become successful actions by retrying signature checks.

## Development and tests

From `rust`, run `cargo test -p hepta-external-authority --locked`. Existing tests
check domain-set separation and propagation of a rejecting verifier. They do not
test an HSM, remote WORM retention, real restore, portal operation, signature
encoding, revocation or durable replay rejection. A production adapter must add
those acceptance and interrupted/ambiguous-operation cases with independently
controlled evidence; it must not replace missing effects with a success callback.
