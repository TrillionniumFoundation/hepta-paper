# hepta-paper

`hepta-paper` is an automation-first research and paper-production workspace. It coordinates persistent paper campaigns that plan research, produce manuscript and code artifacts, run empirical and formal verification, compile LaTeX, obtain independent reviews, revise affected artifacts, and prepare a local submission handoff.

This repository is the workspace for the unreleased `v0.21.0` development candidate. The current status is normative in [`paper-core/docs/CURRENT_STATUS.md`](paper-core/docs/CURRENT_STATUS.md); the architecture rules are normative in [`paper-core/docs/ARCHITECTURE.md`](paper-core/docs/ARCHITECTURE.md). Historical plans do not override those two documents.

The system separates local automation from academic and submission authority. A successful local run does not establish scientific truth, novelty, venue acceptance, production qualification, or permission to perform a live submission. Missing external trust is reported as a blocker and must never be fabricated locally.

## Canonical architecture

The active production graph is layered in one direction:

`workflow-kernel → paper-domain → paper-ports → paper-application → paper-adapters → paper-composition → paper-core entrypoints`

The arrow describes increasing access to effects and assembly, not permission for arbitrary reverse imports.

- [`workflow-kernel/`](workflow-kernel/) owns domain-neutral identity, exact-object, hashing, time, process, filesystem, and small runtime utilities.
- [`paper-domain/`](paper-domain/) owns pure paper, research, evidence, campaign, journal, repair, quality, governance, and submission policy.
- [`paper-ports/`](paper-ports/) owns typed boundaries for stores, workers, artifacts, authority verification, scheduling, runtime execution, packaging, and submission.
- [`paper-application/`](paper-application/) owns use-case orchestration over injected ports and validated execution contexts.
- [`paper-adapters/`](paper-adapters/) implements persistence, artifacts, research workers, providers, packaging, review, and other external effects.
- [`paper-composition/`](paper-composition/) is the only layer that binds concrete adapters into application contexts.
- [`paper-core/`](paper-core/) owns supported CLI entrypoints, verification entrypoints, configuration, deployment assets, and bounded compatibility facades. It is not a second domain layer.
- [`core/`](core/) is a pinned, baseline-bound reference submodule. Production code must not import `core/src`.
- [`runtime-images/`](runtime-images/) contains reproducible scientific runtime definitions; the R source CAS is a separately pinned submodule.
- [`store/`](store/) owns the ordered native SQLite migrations.
- [`migration/`](migration/) owns immutable legacy disposition, replay, and retirement evidence; it is not a production control plane.
- [`numerical-plugins/`](numerical-plugins/) contains candidate numerical plugin material and qualification guidance, not automatic promotion authority.

The cross-module source-of-truth table and dependency rules are in [`docs/architecture/source-of-truth.md`](docs/architecture/source-of-truth.md) and [`docs/architecture/dependency-rules.md`](docs/architecture/dependency-rules.md).

## Requirements and checkout

The workspace requires Node.js `>=22.23.1 <23` and npm `10.9.8`.

Clone with submodules so the reference package and R source CAS are pinned to the commits recorded by this repository:

```bash
git clone --recurse-submodules https://github.com/TrillionniumFoundation/hepta-paper.git
cd hepta-paper
git submodule update --init --recursive
npm ci --ignore-scripts --no-audit --no-fund
```

Do not replace a pinned submodule commit, runtime-image digest, lockfile, trust document, or migration in order to make a gate green. Update the corresponding authority record and verification evidence through its documented process.

## Supported command surface

The supported CLI surface is the declarative `hepta-paper` command registry:

```bash
npm run hepta-paper -- operator store-migrate
npm run hepta-paper -- operator automation
npm run hepta-paper -- operator research-readiness
npm run hepta-paper -- operator campaign -- --help
npm run hepta-paper -- operator autonomous-research -- --help
npm run hepta-paper -- verify architecture
npm run scripts:surface
```

Only commands classified by the registry are supported operator, verification, maintenance, or retirement entrypoints. Unregistered npm scripts are internal and fail the command-surface check. Forwarded command arguments require the explicit `--` separator.

Live portal mutation is not implied by a campaign, package, review, or handoff result. It remains behind separate provider qualification and a human-reviewed, hash-bound, single-use authorization for the exact package, venue, provider, and account.

## Development validation

Run the inexpensive source and architecture checks before a focused change:

```bash
npm run static:check
npm run security:npm-audit
npm run test:impacted:plan
```

Run the complete portable verification path before proposing a release-affecting change:

```bash
npm test
npm run safety:all
npm run ci:selftest
```

Operational, external-trust, GPU, formal-runtime, cold-volume, provider, and release checks have additional prerequisites. Use [`paper-core/docs/OPERATIONS.md`](paper-core/docs/OPERATIONS.md) rather than weakening or skipping a fail-closed gate.

Documentation is executable repository policy. The independent documentation workflow runs:

```bash
node paper-core/bin/documentation-integrity.mjs
node --test paper-core/tests/documentation-integrity.test.mjs
```

It rejects an empty root README, missing module guides, missing normative guides, broken local Markdown links, undocumented active runtime roots, non-HTTPS submodule sources, and removal of the documentation review checklist.

## Runtime and data boundaries

Repository source, externally managed assets, mutable runtime/store state, and retired references are separate trust and lifecycle domains. Production defaults and permissions are defined by the operations documentation. Do not place a writable runtime root inside the repository, the asset root, or a retirement/reference tree. All writes must pass through the declared port and composition boundary for the selected execution profile.

The native campaign store is the sole operational DAG authority. Prepared results, lease generations, attempts, artifact identities, release identities, and receipts are persisted so stale workers cannot complete a newer attempt. Recovery integrates only evidence that remains bound to the exact campaign, node, attempt, source snapshot, runtime, and authority state.

## Documentation map

Start with [`docs/README.md`](docs/README.md). The main normative guides are:

- architecture ownership, module map, dependency rules, and compatibility;
- port semantics and adapter conformance;
- campaign state, cancellation, retry, recovery, and side-effect fencing;
- scientific reproducibility and claim-to-evidence traceability;
- threat model and trust boundaries;
- configuration, runtime layout, storage, backup, and recovery;
- testing, change policy, review requirements, and migration policy.

Each active or support root has a module README with responsibilities, dependencies, contracts, failure behavior, security, tests, and change rules. The machine-audited coverage matrix is [`docs/module-documentation-matrix.md`](docs/module-documentation-matrix.md).

## Contribution rules

A change is incomplete when it changes behavior without changing the owning contract, tests, and documentation. In particular:

1. Domain changes must preserve purity and document new invariants.
2. Port changes must define idempotency, ordering, cancellation, error, retry, and conformance semantics.
3. Adapter changes must state external assumptions and pass the shared port contract.
4. Composition changes must preserve least-capability execution profiles.
5. Store migrations are append-only; applied migrations are never edited.
6. Scientific changes must bind claims, assumptions, implementation, data, runtime, tolerance, and verification.
7. Security or authority changes must update the threat model and fail closed on missing evidence.
8. Compatibility exceptions need an owner, a hash-bound manifest entry, and a retirement condition.

See [`docs/development/testing-and-change-policy.md`](docs/development/testing-and-change-policy.md) and the pull-request template for the required evidence.
