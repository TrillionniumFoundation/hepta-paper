# Module conformance

## 1. Purpose

Conformance proves that a module obeys the common control-plane contract. It does
not prove target-host installation, scientific correctness, provider quality,
or external authority unless the corresponding independent evidence is present.

## 2. Mandatory suites

### Identity and manifest

- valid stable module/capability IDs;
- exact source/runtime/configuration identity;
- no unknown fields or duplicate declarations;
- protocol and state-version range checks;
- authority/side-effect ceiling checks;
- owner, reviewer, SLO, and rollback fields present.

### Planning

- bounded candidate count/bytes;
- deterministic candidate hashes where declared;
- singleton reason enforcement;
- dominated-candidate handling;
- invalid resource, expiry, dependency, side-effect, and confidence rejection;
- no central authority or secret material in planning output.

### Execution

- exact plan/candidate/snapshot binding;
- idempotent duplicate and conflicting replay behavior;
- deadline, cancellation, and lease loss;
- resource envelope and child concurrency limits;
- bounded stdout/stderr/event streams;
- no inherited forbidden descriptors or environment;
- process/container cleanup and recovery.

### Prepared results

- schema and canonical payload;
- artifact and workspace inventory;
- resource/cost settlement;
- provider/external-effect classification;
- stale attempt/generation rejection;
- prepared-result restart recovery;
- no direct central commit.

### Security and privacy

- credential, token, key, prompt, manuscript, and private path redaction;
- symlink/hardlink/path replacement tests where files are used;
- capability audience and expiry;
- untrusted module inability to read other module homes/journals;
- log and telemetry field allowlist.

### Compatibility

- golden vectors;
- N/N-1 behavior where declared;
- unknown future version failure;
- state migration and rollback;
- Node/Rust differential or evaluation contract.

### Performance

- declared concurrency and queue bounds;
- latency/throughput/memory floors on a canonical workload;
- overload/backpressure behavior;
- starvation contribution and resource settlement;
- no safety-invariant regression under load.

## 3. Evidence binding

Every conformance artifact binds:

```text
repository/source commit/tree
module id/version/runtime digest/config digest
protocol and schema digests
test-suite and workload digests
host/runtime identity where applicable
result and raw-artifact digests
authority and non-authority statement
producer and independent reviewer identity
expiry or revalidation rule
```

## 4. Capability-specific coverage

Global CI success cannot promote every module. A machine mapping associates each
module/capability with the exact suites and workloads that exercise it.

A module with an empty mapping remains `source_implemented` or
`contract_ready`, regardless of repository-wide green checks.

## 5. Test doubles

Fakes may establish protocol and deterministic behavior only. They cannot
establish:

- real credential custody;
- provider availability/quality;
- target-host ownership or filesystem behavior;
- KMS/HSM non-exportability;
- WORM custody;
- portal mutation or submission authority;
- independent scientific or governance review.

## 6. Continuous revalidation

Conformance becomes stale when any bound source, runtime, configuration, schema,
dependency, workflow, workload, host, review, or module-registry subject changes.

Operational health does not extend expired conformance; a fresh module must not
inherit its predecessor's evidence.
