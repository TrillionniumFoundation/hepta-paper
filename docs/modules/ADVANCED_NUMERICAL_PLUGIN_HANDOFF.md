# Native advanced numerical routes

The ordinary operator entry and the standalone reference candidate have distinct
contracts. Their remaining command gaps are recorded in the [canonical route
ledger](../migration/NODE_RUST_GAP_CLOSURE.md); that generated ledger derives
from the digest-bound command map.

## Ordinary status and CPU run

`hepta-paper-rust operator advanced-numerical-plugin -- --config PATH` uses
[the ordinary route owner](../../rust/crates/hepta-paper-service/src/ordinary_advanced_numerical_plugin.rs)
and defaults to status. It inspects the signed plugin descriptor, current trust
and revocation inputs, source/runtime identity and qualification evidence.
Status supports the bounded V1 CPU and V2 CPU/GPU inspection contracts.

The ordinary CPU entry is:

```text
hepta-paper-rust operator advanced-numerical-plugin -- --config PATH --action run --request PATH --output-directory PATH
```

[The CPU owner](../../rust/crates/hepta-paper-service/src/ordinary_advanced_numerical_plugin/cpu/mod.rs)
accepts the signed V1 Python CPU domain. It borrows the original cancellation
object and absolute deadline from the ordinary route. The request retains the
incumbent hash and assurance contracts. Source and runtime observations remain
held through final serialization.

The existing signed configuration selects a separate allowed output root.
The existing local report directory owner and process supervisor prepare a
private work copy, readonly source/runtime mounts and the bubblewrap worker.
The worker gets the explicit dataset authorization binding and permitted
environment. Descriptor timeout, memory, CPU, process, declared output and
combined captured-output limits are validated before execution. An insufficient
remaining deadline refuses before spawn; the signed timeout is not clamped.

The process supervisor retains actual PID, exit/signal, cancellation, deadline,
capture and cleanup observations. CPU receipts use those observations, request
and runtime hashes, real environment observations, and declared artifacts.
Successful result publication uses exclusive no-replace writes and file/directory
syncs. A failed final check retains observed process/publication facts instead
of inventing success. A fresh invocation observes a preexisting target result
under the current request contract and never overwrites or automatically reexecutes
it.

Before spawning the worker, the
[diagnostic association owner](../../rust/crates/hepta-paper-service/src/ordinary_advanced_numerical_plugin/cpu/association.rs)
exclusively writes a mode-0600 association and syncs its file and target directory.
It binds the actual request, descriptor, signed bundle, source/runtime hashes and
held private directory identities. A fresh invocation with no published target
validates that association and inspects the retained private result or its absence.
It reports an unknown outcome, retains the result bytes and never automatically
executes the worker again. Malformed, unsafe, mismatched or rebound associations
refuse. The association is diagnostic data and grants no execution authority.

The environment BOM currently observes host Python/package/BLAS metadata before
worker execution. Its fixed bounded host probes do not establish complete
restricted worker package closure. Their probe caps are not a worker execution
permit. V1 input/resource domains, all ten families, GPU run, external providers,
complete failure-wire parity, current-subject normal/recovery acceptance,
installed canary/rollback and Node retirement remain open. In
particular, Node and Rust capture-limit failures can retain different amounts
of output; positive bounded execution does not accept that failure domain.

## Standalone reference candidate

`hepta-paper-rust advanced-numerical-plugin REQUEST` calls
[execute_advanced_numerical_plugin_v1](../../rust/crates/hepta-paper-service/src/advanced_numerical.rs).
It reads one bounded JSON request and executes only the three implemented
reference families: linear algebra, Monte Carlo and optimization. Linear solves
use bounded pivoting, Monte Carlo a deterministic SplitMix64 stream, and convex
quadratic optimization bounded gradient descent.

Its request is an `AdvancedNumericalPluginRequest` with a matching request hash,
bounded object input, JavaScript-safe integer seed and three assurance contract
hashes. Invalid hashes, nonfinite values, oversized budgets and unsupported
families refuse. The result is a self-hashed `AdvancedNumericalPluginResult`
with `nativeExecution: true`, `productionQualified: false` and
`qualificationStatus: reference_candidate_unqualified`.

This standalone candidate does not verify the ordinary signed plugin bundle or
execute its sandboxed worker. Its native random stream is not claimed to match
the Python reference stream byte for byte.

## Verification and authority

Run the actual owners on the selected source:

```bash
cargo +1.98.0 test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --lib ordinary_advanced_numerical_plugin:: -- --nocapture --test-threads=1
cargo +1.98.0 test --manifest-path rust/Cargo.toml --locked -p hepta-codex-runtime \
  --lib process::tests:: -- --nocapture --test-threads=1
cargo +1.98.0 test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --test advanced_numerical_plugin -- --nocapture --test-threads=1
```

The ordinary owners compare complete Node request/result/BOM/receipt values and
exercise inherited controls, captured limits, source modes and actual signals.
The standalone integration owner covers deterministic unqualified output,
tampering and unsupported families. Ordinary default-binary CLI and restart/
crash observations must be regenerated for each composed candidate; a private
source receipt does not qualify a later head.

Neither route grants campaign commit, release, submission, installation,
credential custody or Node retirement authority. Local fixture signing material
does not establish independently administered runtime authority.

