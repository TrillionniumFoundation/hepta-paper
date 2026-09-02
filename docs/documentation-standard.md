# Documentation standard

Status: normative

## Scope

This standard applies to the root README, all active runtime roots declared in `package.json`, the support roots listed in the documentation matrix, and the normative guides under `docs/`.

## Required module structure

Every active or support root must contain a `README.md` with these sections:

- `Purpose`: why the module exists and what it does not own;
- `Responsibilities`: the behavior and data it owns;
- `Dependencies`: allowed and forbidden dependency directions;
- `Contracts`: public values, ports, invariants, receipts, or schemas;
- `Failure and recovery`: error, retry, cancellation, idempotency, persistence, and restart behavior;
- `Security`: trust assumptions, sensitive data, and fail-closed requirements;
- `Testing`: unit, conformance, architecture, and operational checks;
- `Change rules`: completion criteria and compatibility obligations.

A module README must name its important submodule families or entrypoints. Source-file comments are useful but do not replace a module contract.

## Normative guide structure

Each normative guide begins with `Status: normative` and contains `## Scope`. It must distinguish verified behavior from goals, local evidence from external authority, and current policy from historical rationale.

Numbers that change during operation belong in `paper-core/docs/CURRENT_STATUS.md` or a machine-generated report. Other guides link to that source rather than copying counts that will drift.

## Links and examples

Local Markdown links must resolve inside the repository and must not traverse above the workspace root. Command examples must use the supported command registry or clearly identify internal verification commands. Examples must not imply that a local fixture, deterministic persona, self-signature, or dry run confers academic, production, or submission authority.

## Review and ownership

The pull-request template records documentation impact. Reviewers must reject changes that introduce a new module, port, adapter, execution profile, migration, external effect, scientific claim class, or trust boundary without updating the owning documentation and tests.

## Machine enforcement

`paper-core/bin/documentation-integrity.mjs` verifies required files, headings, minimum substantive size, active-root coverage, documentation-matrix coverage, local links, submodule URL policy, the pull-request checklist, and the documentation CI workflow. Its own tests exercise both negative fixtures and the live repository.

The checker is deliberately bounded: it proves repository documentation structure and link integrity, not prose correctness. Contract reviews and tests remain responsible for semantic accuracy.
