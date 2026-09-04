# Change classification and delivery lanes

## 1. Impact axes

Classify each change along:

```text
public protocol
state/storage
runtime/process
resource/performance
security/authority
scientific/evidence
external effect
migration/cutover
documentation/machine truth
```

The highest applicable class determines review and CI.

## 2. Delivery lanes

### Module fast lane

Private compatible implementation, module tests, conformance, microbenchmark,
and direct-consumer contracts.

### Shared-contract lane

Protocol, schema, registry, module public interface, canonicalization, or shared
platform changes. Runs all consumers and compatibility vectors.

### Control-plane lane

Scheduler, allocator, writer, broker, workspace, qualification, or composition
changes. Runs canonical correctness/fault/performance workloads.

### Authority lane

Credentials, signing, release, storage custody, submission, protected-main, or
production activation. Requires independently controlled evidence and cannot be
closed by hosted CI alone.

### Migration/cutover lane

Shadow, canary, writer transfer, retirement, and rollback. Requires exact before
and after authority graphs.

## 3. Merge discipline

- one coherent authority candidate at a time;
- no old-head evidence reuse;
- no hidden generated source or self-modifying workflow;
- exact expected-head guard for integration;
- unresolved request changes block;
- documentation and machine truth updated in the same semantic change;
- rollback is executable, not prose-only.
