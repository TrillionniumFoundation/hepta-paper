# hepta-paper

`hepta-paper` is a concurrent, automation-first research and paper-production system. It coordinates research planning, evidence generation, code and empirical work, manuscript production, independent review, revision, packaging, and optional externally authorized release/submission handoff.

## Development documentation

The single current development-document entry point is [`docs/README.md`](docs/README.md). Continue Rust delivery through the [single current candidate](docs/migration/BRANCH_CONSOLIDATION.md#current-candidate-and-callable-entrypoints), which also defines its integration base and signed delivery contract.

Global status, plan, architecture, capability/module truth, scheduling, performance, qualification, security, and team governance live under `docs/system` and its machine records. `paper-core/docs` describes the current Node implementation; `docs/rust` describes the Rust control-plane migration. Neither subsystem is a competing global source of truth.

Every registered module now has a one-to-one normative specification and machine manifest linked from [`docs/modules/MODULE_DOCUMENTATION_MATRIX.md`](docs/modules/MODULE_DOCUMENTATION_MATRIX.md). Completeness is enforced by `node docs/tools/validate-module-documentation.mjs`; documentation completeness does not imply production qualification or activation.

Superseded plans, dated status snapshots, trigger notes, and remediation diaries are not retained in the working tree. Git history, pull requests, issues, and retained evidence artifacts remain the audit archive.

## Current authority boundary

The existing Node control plane remains authoritative for the distribution and
multi-capability campaign lane until capability-by-capability cutover is
independently accepted. The Rust control-plane work is an additive source
candidate for that lane; a private single-user installation has the separate
profile-scoped readiness result below.

Repository source or hosted CI does not authorize:

```text
real Codex credentials or live provider calls
production Rust campaign writes or writer cutover
release signing or promotion
KMS/HSM or immutable-storage mutation
portal credentials or submission actions
```

Those effects remain behind separately controlled target-host and external-authority evidence.

For a single-user private installation, use the scoped `personal-self-hosted-v1`
lane instead of the distribution qualification lane:

```bash
cargo run --locked -p hepta-paper-service -- personal-self-hosted-readiness --require-ready
```

The Node command `npm run personal:readiness -- --require-ready` remains the
differential oracle. The Rust profile removes distribution-only external gates
while keeping local provenance, owner-only runtime permissions, database/WAL
integrity, crash/restore recovery, anti-rollback and deterministic replay for
enabled local capabilities. This replay covers enabled local capabilities, not
the full hosted 263-file Node matrix, and the profile does not claim unsupported
Node routes. Its result does not authorize external actions,
publication, submission or distribution.

## Capability coverage boundary

The current operator-facing Node capability catalog has source-bound conformance coverage of **16/16**. Independently controlled production operational proof remains **0/16** until the mapped external capability owners and operational observers provide accepted evidence. These counts describe capability coverage, not production activation.

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

Modules may optimize their internals but cannot select their own global priority, self-qualify, or commit central state directly. Expensive work remains parallel; only the short authoritative state transition is serialized.

## Validation

From the repository root:

```bash
node docs/tools/validate-development-docs.mjs
node docs/tools/validate-module-documentation.mjs
python3 docs/rust/tools/validate-program-truth.py
npm run scripts:check
npm run security:source-gate
npm run release:state-check
```

The full locked Node/Rust test matrix and exact-head workflow evidence remain required for qualification. A local validation result is not a merge, production, provider, release, or submission authorization.

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

See [`docs/system/CURRENT_STATUS.md`](docs/system/CURRENT_STATUS.md) before planning or implementing a change.
