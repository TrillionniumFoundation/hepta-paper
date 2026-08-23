# Advanced numerical plugins

The advanced numerical plugin boundary supports signed descriptors for causal
inference, time-series, Bayesian, survival, optimization, ODE, and PDE
computations. Descriptors pin the runtime executable, package closure,
entrypoint, source tree, resource limits, and oracle/replay/uncertainty
contracts.

`hepta-paper operator advanced-numerical-plugin` composes the descriptor with
the existing kernel-isolated worker runner. Execution is out of process,
network-isolated, read-only at the source boundary, and CPU/memory/PID/output
bounded. A successful execution receipt remains
`advanced_numerical_plugin_execution_completed_unqualified`: it cannot promote
a paper until independent oracle, replay, uncertainty, and scientific-review
authorities qualify the result.

No repository descriptor is treated as an external signature. Operators must
provide an immutable runtime configuration pointing to a signed bundle, trust
store, plugin root, and dedicated output root.

`numerical-plugins/reference-candidates` contains executable standard-library
reference candidates for linear algebra, Monte Carlo, and convex quadratic
optimization. They produce ABI-verifiable estimate, uncertainty, oracle, and
deterministic replay records, but remain
`reference_candidates_unqualified`. An independent authority must package,
sign, replay, review, and qualify them before production activation.

Production admission uses `AdvancedNumericalPluginQualificationStatement`.
The plugin-authority subject must be distinct from four qualification
subjects: numeric oracle, replay, uncertainty review, and scientific review.
The statement alone is not evidence. It must resolve to an
`AdvancedNumericalPluginQualificationEvidenceBundle` containing five actual,
currently valid Ed25519-signed receipts: plugin-authority reference execution,
independent replay, numeric oracle, typed uncertainty review, and scientific
review. The reference and replay receipts bind distinct process identities to
the same request corpus and result hash. Every review receipt binds those
execution receipts, the signed bundle, descriptor, assurance contract, result,
and an expiring validity window. Receipt subjects must match their statement
roles. All five subjects, normalized organizations, and Ed25519 public keys
must be pairwise distinct.

Production runtime configuration version 2 pins the bytes of the signed bundle,
plugin trust store, qualification statement, qualification evidence bundle,
and qualification trust store. The three bundled reference candidates are
admitted only through a version-2 registry whose own bytes match
`HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY_HASH`; that registry
then pins every per-family runtime configuration. Version-1 runtime
configuration remains available only for explicitly unqualified execution.
The runner reports `productionQualified=true` only after the complete evidence,
signature, freshness, identity, and independence chain succeeds.

The production dependency handoff revalidates that projection instead of
trusting a stale readiness boolean: all three families must carry their
registry/runtime/document hashes, expiring qualification, five distinct
authority identities (plugin plus oracle/replay/uncertainty/scientific roles),
the five signed evidence-receipt hashes (reference, replay, numeric oracle,
typed uncertainty, and scientific review), and distinct reference/replay
process identities. Missing detail remains a typed blocker for each family.
The same downstream handoff independently
revalidates the submission dispatcher snapshot, including its portal binding,
signed cycle, fresh expiry, no-side-effect canary, and canary-authority
independence; a local or fixture canary cannot satisfy either gate.
