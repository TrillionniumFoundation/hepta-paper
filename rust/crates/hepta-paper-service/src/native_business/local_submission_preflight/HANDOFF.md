# Local CAS submission preparation

`PrepareLocalSubmissionFromCasV1` is dispatched by `ServiceExecutorV1` through
`execute_native_business_with_objects_for_capability_v1`. The request has a
closed version/kind, local-dry-run preflight, typed artifact roles, CAS digests,
cover letter and explicit reference time. There must be one UTF-8 manuscript
and one verified native source bundle containing the same manuscript bytes.
The CAS reader rehashes objects, applies existing bounded object/text limits,
checks cancellation between reads, and reads the inputs again before returning.

`cas.rs` binds real bytes to the artifact package; `records.rs` and `semantic.rs`
build the venue/approval/freshness/promotion records; `workflow.rs`, `delivery.rs`
and `lifecycle.rs` calculate the local manifest, handoff and dry-run receipt.
These calculations invoke no Node process in production. The differential
owners independently run the original Node contract/lifecycle functions and
compare complete values, including hashes derived from original artifact bytes.

The existing worker owns CAS output publication, prepared results and SQLite
sequencer commits. Its existing started-attempt rule preserves an unknown
result after failure; restoring a corrupt input does not authorize automatic
reexecution. A committed result replays through the same store without another
commit or source-candidate tariff debit. That tariff is defined by the existing
source configuration; it is not a measurement of provider billing.

The job uses the existing `CAP-SUBMIT` admission boundary. Restricted research
admission rejects it. Local record readiness grants no external action, and
neither `reviewed_submit` nor live authority fields are accepted. Ordinary
canonical batch enqueue/consumer integration and compatibility acceptance are
tracked in the [machine command ledger](../../../../../../docs/migration/node-rust-command-map.v2.json),
which remains the source of current route status.

Run the actual local record and CAS differential owners with qualified Node
available through `HEPTA_TEST_NODE`, then run the existing worker composition:

```sh
cargo test --manifest-path rust/Cargo.toml --locked --all-features -p hepta-paper-service --lib native_business::local_submission_preflight::tests:: -- --nocapture
cargo test --manifest-path rust/Cargo.toml --locked --all-features -p hepta-paper-service --test native_business_service -- --nocapture
```

The service owners cover capability refusal with a legal retry, retained unknown
starts, actual committed artifacts and cost replay, and two independently
started flat frontend processes. Their source fixtures do not supply installed
principals, independent reviewer accounts or external submission authority.
