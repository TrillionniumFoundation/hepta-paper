# Service propagation of control-plane inspection failures

The three concrete `ControlPlaneV1::run` consumers are `run_service_v1`,
`run_production_service_v1`, and local maintenance's cached-result-only
`commit_prepared`. Each now maps the actual core `RunRequiresInspection` into
`ServiceError::ControlRequiresInspection { inspection }` before its local runtime
is dropped. The optional boxed `ControlPlaneRunInspectionV1` is cloned from that
runtime's actual record. If a diagnostic is unexpectedly absent, the service
still reports inspection required. Other control errors remain `ServiceError::Control`
with their original message. Success receipts and their hashes are unchanged.

The original bounded core cause, last phase, snapshot/plan hashes and all retained
reservation IDs remain accessible through the typed error. The diagnostic does
not claim that a business commit succeeded or failed, prove worker termination,
or authorize capacity release. `ServiceExecutorV1` still reduces its own worker
errors to `ControlPlaneError::ExecutionInvalid`; this change does not recover
worker details discarded at that earlier boundary.

`WorkflowError::Service` already retains its service error as the real `Error::source`.
The new `service_control_inspection_report_v1` follows at most 32 typed source
nodes, including the supplied error, and recognizes only the actual service
inspection variant. Matching error strings or JSON do not trigger projection.
A cyclic caller-defined source chain therefore cannot cause an unbounded loop.
The API is a diagnostic projector and grants no authority.

The `hepta-paper-rust`, `hepta-local-workflow` and `hepta-local-maintenance` binaries
print the following new error shape to stderr only for that typed failure, and
exit with the existing status 1:

- `version: 1`, `kind: HeptaServiceControlInspectionRequiredV1` and
  `code: service_control_requires_inspection`;
- `inspectionRequired: true`, `retryable: false`;
- `diagnostic`: the actual hashes, reservation IDs, `execution`/`finalization`
  phase and original core cause's fixed error string, or `null` when unavailable;
- `scope: in_memory_runtime_diagnostic_not_durable_resource_recovery`.

No worker output, private path, secret, `committed` field or inferred authority
outcome is emitted. All other CLI errors retain their prior bytes. The `serve`
loop still stops on its first error; it does not consume the next request after
an inspection failure. Workflow advancement also stops on its first error.

## Remaining ownership and recovery boundary

Each service call still constructs a fresh allocator and runtime. After return,
the error retains a diagnostic, not that runtime's resource owner. This change
therefore does not persist the whole plan's charged capacity or block a new plan,
a new service call, or a restart. The worker's existing synced `started` record
prevents an identical unresolved attempt from running again, and its validated
`prepared` cache permits result replay. Those identities and records are not a
durable global resource gate or an authority certificate. Changing a plan or
worker binding creates another identity; this projector cannot authorize doing
so to bypass unresolved consumption.

Maintenance reconciliation remains an explicit operation over already cached
prepared output. Its executor has no callable worker. A previously committed
matching request still returns the original durable receipt through the existing
read-only recovery path; the error projector does not disable or bypass that
path. The production API's opaque qualification/cutover inputs are unchanged.
No production authority fixture or acceptance claim is added.

The new public ServiceError variant affects exhaustive downstream matches. Its
boxed diagnostic does not implement deserialization or expose a guard reset.

## Source validation

New `tests/durable_service/inspection.rs` regressions execute a private pinned
Rust test worker that writes a marker and exits without a prepared result. They
check actual service diagnostics, repeat-call worker count, the entire selected
plan's diagnostic IDs, `serve` stopping before its second input, and original
pre-dispatch/noninspection CLI errors. The local-workflow inspection regression
exercises both the real binary and typed WorkflowError source chain with a real
marker worker. Private projector tests cover unavailable diagnostics, copied
error text and a cyclic source chain.

Run from `rust`, alongside the existing cached-reconciliation regression:

```sh
cargo test -p hepta-paper-service --lib control_error --locked
cargo test -p hepta-paper-service --test durable_service --test local_workflow --locked
cargo test -p hepta-paper-service --test local_recovery_gc prepared_reconciliation_commits_actual_cached_output_once_without_execution --locked
```

These are bounded local source fixtures, not durable resource accounting,
independent host qualification or complete Rust production replacement.
