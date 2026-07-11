# Automation Plane

## Product boundary

The default product is an automated research and paper factory, not a live
submission authority system. Local research, code generation, empirical
execution, manuscript writing, referee review, revision and validation must
continue without public keys or signatures. The separate submission plane may
require explicit authorization only when an external upload, email or portal
mutation is requested.

## Campaign DAG

Each paper campaign persists a dependency DAG in schema v4. The initial plan
runs research planning, then writer and coder nodes in parallel, followed by
empirical execution, manuscript integration and LaTeX compilation. Each review
round runs multiple independent referees, revision, then code, empirical and
compile revalidation in parallel before evaluating convergence. Campaigns may
run concurrently and use leases, bounded attempts, idempotent completion,
event records and expired-lease recovery.

## Executors

- `AgentExecutorPort` supports authenticated Codex and structured local Ollama
  adapters. Local model output is constrained by a JSON Schema, per-role token
  budgets, workspace containment and atomic full-file replacements.
- `EmpiricalExecutorPort` maps Python, Node, R, Julia, Lean and LaTeX to the OS
  sandbox runner. Availability is reported honestly per installed runtime.
- Generated Python and LaTeX are executed, not trusted. A failed command may
  invoke one bounded diagnostic repair step and must pass a fresh isolated run.
- LaTeX has a deterministic sanitizer for common model serialization defects
  before an agent repair is attempted.

## TaskFlow boundary

TaskFlow is optional outer coordination for cross-session waiting, resume,
cancel and child-task links. It stores only campaign identity, checkpoints,
receipt hashes and blocker codes. It does not decide DAG readiness, referee
convergence, evidence validity or submission authorization.

## Readiness

`automation:status` reports Automation Plane readiness independently from Live
Submission readiness. Missing R, Julia or Lean blocks only campaigns that
request those runtimes. Missing cold data blocks only papers that depend on
that data. Authority keys, owner signatures, WORM custody and legacy deletion
do not block local automation.
