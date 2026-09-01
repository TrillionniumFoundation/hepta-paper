# hepta-paper

`hepta-paper` is a concurrent, automation-first research and paper-production
system. It coordinates research planning, evidence generation, code and
empirical work, manuscript production, independent review, revision, packaging,
and optional externally authorized release/submission handoff.

## Development documentation

The single current development-document entry point is
[`docs/README.md`](docs/README.md).

Global status, plan, architecture, capability/module truth, scheduling,
performance, qualification, security, and team governance live under
`docs/system` and its machine records. `paper-core/docs` describes the current
Node implementation; `docs/rust` describes the Rust control-plane migration.
Neither subsystem is a competing global source of truth.

Superseded plans, dated status snapshots, trigger notes, and remediation diaries
are not retained in the working tree. Git history, pull requests, issues, and
retained evidence artifacts remain the audit archive.

## Current authority boundary

The existing Node control plane remains authoritative under its current gates
until capability-by-capability cutover is independently accepted. The Rust
control-plane work is an additive source candidate and is not a production
writer.

Repository source or hosted CI does not authorize:

```text
real Codex credentials or live provider calls
production Rust campaign writes or writer cutover
release signing or promotion
KMS/HSM or immutable-storage mutation
portal credentials or submission actions
```

Those effects remain behind separately controlled target-host and external-
authority evidence.

## Capability coverage boundary

The current operator-facing Node capability catalog has source-bound conformance
coverage of **16/16**. Independently controlled production operational proof
remains **0/16** until the mapped external capability owners and operational
observers provide accepted evidence. These counts describe capability coverage,
not production activation.

## Target architecture

The target is a modular monorepo with explicit authority/process boundaries:

```text
immutable state snapshot
-> hard policy and authority constraints
-> bounded module candidate frontiers
-> global scheduler / optimizer
-> hierarchical resource allocation
-> isolated module execution
-> prepared results and content-addressed artifacts
-> independent verification
-> single-writer commit sequencer
-> event/read-model and calibration feedback
```

Modules may optimize their internals but cannot select their own global priority,
self-qualify, or commit central state directly. Expensive work remains parallel;
only the short authoritative state transition is serialized.

## Validation

From the repository root:

```bash
node docs/tools/validate-development-docs.mjs
python3 docs/rust/tools/validate-program-truth.py
npm run scripts:check
npm run security:source-gate
npm run release:state-check
```

The full locked Node/Rust test matrix and exact-head workflow evidence remain
required for qualification. A local validation result is not a merge,
production, provider, release, or submission authorization.

## Main implementation roots

```text
workflow-kernel/        domain-neutral identities and runtime primitives
paper-domain/           pure research, evidence, campaign and submission policy
paper-ports/            typed infrastructure boundaries
paper-application/      use-case and campaign orchestration
paper-adapters/         persistence, runtime and external adapters
paper-composition/      current Node composition roots
paper-core/             CLI, verification and compatibility surfaces
rust/                   additive Rust control-plane implementation
numerical-plugins/      bounded numerical extensions
runtime-images/         pinned execution-image definitions
```

See [`docs/system/CURRENT_STATUS.md`](docs/system/CURRENT_STATUS.md) before
planning or implementing a change.
