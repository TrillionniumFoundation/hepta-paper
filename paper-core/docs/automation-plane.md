# Automation Plane

## Product boundary

The default product is an automated research and paper factory, not a live
submission authority system. Local research, code generation, empirical
execution, manuscript writing, referee review, revision and validation must
continue without public keys or signatures. The separate submission plane may
require explicit authorization only when an external upload, email or portal
mutation is requested.

## Campaign DAG

Each paper campaign persists a dependency DAG in schema v5. The initial plan
runs research planning, then writer and coder nodes in parallel, followed by
empirical execution, manuscript integration and LaTeX compilation. Each review
round runs multiple independent referees, revision, impact-selected code,
empirical, compile, citation and table/figure validation, then a fresh set of
independent referees bound to the revised manuscript hash before convergence.
Campaigns may
run concurrently and use leases, bounded attempts, idempotent completion,
event records and expired-lease recovery. A final non-converged round stops
without packaging.

## Executors

- `AgentExecutorPort` defaults to an unbound OpenClaw worker and a unique child
  session per node. Every mutable node works in a reflink/copy-on-write tree;
  changed paths merge only if their source preimages still match. Structured
  local Ollama is the offline circuit-breaker fallback and authenticated Codex
  CLI is optional.
- `EmpiricalExecutorPort` maps Python, Node, R, Julia, Lean and LaTeX to the OS
  sandbox runner. Availability is reported honestly per installed runtime.
- Generated Python and LaTeX are executed, not trusted. A failed command may
  invoke one bounded diagnostic repair step and must pass a fresh isolated run.
- LaTeX has a deterministic sanitizer for common model serialization defects
  before an agent repair is attempted.
- A global resource governor limits agent, CPU, GPU and memory slots across all
  papers. Campaign wall-time, agent-call, CPU/GPU-job, token and cost budgets,
  usage and stop reasons are persisted. Named datasets mount read-only with a
  manifest hash. Successful empirical outputs may enter a source/runtime/data-
  bound cache; every replay rechecks artifact hashes. Executed outputs are
  materialized under `automation-results/` before a writer may consume them.

## TaskFlow boundary

TaskFlow is optional outer coordination for cross-session waiting, resume,
cancel and child-task links. It stores only campaign identity, checkpoints,
receipt hashes and blocker codes. It does not decide DAG readiness, referee
convergence, evidence validity or submission authorization.

## Operations

`paper:campaign -- --action list|status|events|pause|resume|cancel|cancel-node|retry`
provides native operations. `automation:dashboard` reports node states,
latest events, stop reasons and time/token/model-resource usage. Cancel is
immediate for child agents and cooperative/bounded for synchronous empirical
workers. Cancelling one node recursively skips only its dependency subtree;
if that subtree contains the required package path, the campaign stops with an
explicit operator-cancellation reason.

## Readiness

`automation:status` reports Automation Plane readiness independently from Live
Submission readiness. Missing R, Julia or Lean blocks only campaigns that
request those runtimes. Missing cold data blocks only papers that depend on
that data. Authority keys, owner signatures, WORM custody and legacy deletion
do not block local automation.
