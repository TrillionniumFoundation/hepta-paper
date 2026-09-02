# numerical-plugins

Status: normative module guide

## Purpose

`numerical-plugins` is the development and qualification area for advanced numerical methods used by research campaigns. The current `reference-candidates/` material is reference/candidate input; directory presence does not make a plugin production-reachable or academically promotable.

## Responsibilities

A plugin package defines its mathematical problem, input/output schema, algorithm, deterministic controls, resource profile, artifacts, diagnostics, independent oracle, and release replay requirements. Registration is split across domain contracts, execution ports, concrete runners, composition, and release verification rather than hidden in this directory.

## Dependencies

Candidate source may use its declared scientific runtime. Production JavaScript integration follows the normal domain/port/adapter/composition direction. Plugins may not import CLI or store internals, write arbitrary repository paths, acquire network access implicitly, or mint promotion authority.

## Contracts

Each plugin records equations and assumptions, units and domains, discretization or optimization method, initialization, stopping and convergence rules, precision, tolerance, error estimates, randomness, input/data identity, output artifact inventory, and known invalid regimes.

The campaign execution contract binds plugin version, runner, runtime digest, dataset/source snapshot, attempt, lease, resource limits, and receipt. The verifier independently recomputes the declared invariants or oracle.

## Failure and recovery

Invalid domain inputs, non-convergence, numerical instability, NaN/Inf, tolerance failure, resource exhaustion, timeout, and incomplete artifacts are distinct outcomes. A failed execution is immutable evidence. Retry requires policy authorization and a new attempt; changing tolerance or method creates a new protocol version.

Prepared artifacts survive process restart only through the campaign’s declared export and integration path.

## Security

Plugins run out of process with bounded argv, files, network, CPU, memory, PIDs, deadline, and optional GPU lease. Inputs and outputs are treated as untrusted. A GPU lease coordinates repository-owned processes but is not hostile same-UID isolation.

## Testing

Required tests include schema rejection, exact/reference cases, invariants, convergence or residual behavior, degenerate/adversarial inputs, deterministic replay, CPU/independent oracle comparison where required, archive replay after producer deletion, and resource/cancellation failure. Scientific claims follow the traceability guide.

## Change rules

Promotion requires reviewed domain registration, port and runner conformance, pinned runtime dependencies, reproducibility metadata, independent verification, composition wiring, release-package inclusion, and current authority evidence. Never infer qualification from a successful local candidate run.
