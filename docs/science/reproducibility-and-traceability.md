# Scientific reproducibility and traceability

Status: normative

## Scope

This policy applies to formal claims, empirical claims, numerical plugins, datasets, analysis protocols, manuscript statements, tables, figures, and release packages.

## Claim graph

Every promotable scientific statement must have a stable claim identity and a typed edge to:

1. its natural-language statement and bounded interpretation;
2. assumptions, quantifiers, domain, exclusions, and falsifiers;
3. source files and exact source snapshot;
4. implementation or formal theorem identity;
5. dataset and license/provenance identity;
6. analysis protocol and statistical decision rule;
7. runtime and dependency identity;
8. raw observations and derived artifacts;
9. verifier, reviewer, and authority receipts;
10. manuscript locations, tables, figures, and release bundle.

A generated claim, successful process, local deterministic persona, or local signature is not sufficient evidence for semantic truth or independent acceptance.

## Reproducibility manifest

Each execution intended to support a claim records at least:

- repository commit and tree state;
- relevant submodule commits;
- package-lock hash;
- runtime image digest or exact host runtime identity;
- operating system and architecture where material;
- input, source, dataset, configuration, and environment hashes;
- random seeds and deterministic-mode settings;
- command and resource limits;
- network policy and retrieved snapshot identities;
- start/end and monotonic timing evidence;
- stdout, stderr, exit status, and artifact inventory;
- numerical precision, units, tolerances, and convergence criteria;
- executor, verifier, reviewer, and trust epochs;
- output and receipt hashes.

Mutable URLs, image tags, implicit “latest” dependencies, and undocumented local files are not reproducibility identities.

## Numerical methods

A numerical plugin documents the mathematical problem, assumptions, units, discretization, solver, initialization, stopping rule, conditioning, error estimate, reference values, and known failure regimes. Tests include exact invariants where available, convergence or residual checks, adversarial and degenerate inputs, deterministic replay, and an independent oracle when promotion requires it.

Tolerance is part of the claim. It cannot be enlarged after observing a failing result without a new protocol version and review.

## Formal evidence

Formal verification binds the exact theorem statement, imported axioms, toolchain, project dependency graph, source snapshot, and proof artifact. It proves the machine statement under its assumptions. A separate binding is required between that statement and the manuscript claim.

## Empirical evidence

Empirical promotion requires an authorized dataset/harness, declared protocol, pre-specified primary outcomes, complete execution receipts, independent recomputation where required, and a release attestor. Synthetic or simulator-generated data may test the pipeline but cannot masquerade as academic evidence.

Negative, null, excluded, and failed results remain traceable. The workflow must not select only successful attempts or silently rewrite the claim after evidence is observed.

## Release verification

A release package carries the exact claim graph, source, data/protocol identities, executable bodies required for replay, tables/figures, proof artifacts, and verification receipts. Fresh rebuild and off-host or independent replay requirements are evaluated separately. Local reproducibility does not substitute for an authority explicitly required to be external.
