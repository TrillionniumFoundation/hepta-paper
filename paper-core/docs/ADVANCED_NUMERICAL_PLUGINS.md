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
The statement binds two distinct process receipts to an identical result hash,
all evidence hashes, the signed plugin bundle, and an expiring validity window.
The runner reports `productionQualified=true` only after every signature and
independence check succeeds; unsigned candidates continue to run only with the
explicit unqualified receipt status.
