# Codex execution protocol v1

## Status and scope

This protocol defines the boundary between the Rust campaign core and a
role-specific Codex broker. It supports only non-interactive, one-shot CLI
execution. It does not support OpenClaw, App Server, WebSocket, MCP, plugins,
web search, persisted session resume or interactive approval.

## Transport

Qualified transport identifier:

```text
exec-jsonl-v1
```

Conceptual invocation:

```text
<pinned-codex> exec
  --json
  --ephemeral
  --output-schema <immutable-schema-file>
  --sandbox <read-only|workspace-write>
  --color never
  --skip-git-repo-check
  --cd <attempt-root>
  -
```

Controlled automation additionally ignores unqualified user/project rules and
uses a broker-generated configuration that sets approval to never, workspace
network access off, and a restrictive shell environment policy. The exact CLI
argv and config bytes are part of runtime qualification and receipt identity.

## Request framing

The future broker socket uses a length-prefixed binary frame containing canonical
JSON for `CodexExecutionRequestV1`.

```text
magic: 8 bytes = HEPTACX1
payload length: unsigned 64-bit big endian
payload: UTF-8 canonical JSON
maximum frame: policy bounded
```

A request is accepted only when:

- frame and JSON are complete and within limits;
- version and unknown-field checks pass;
- operation, campaign, node, attempt, revision and generation are bound;
- role/task/sandbox policy passes;
- runtime identity is qualified for the role;
- request capability is signed, unexpired and bound to the peer;
- the idempotency key is absent or matches the existing journal entry;
- deadline and budget remain positive.

## Request contract

`CodexExecutionRequestV1` binds:

```text
operationId + idempotencyKey
campaignId + nodeId + attemptId
leaseGeneration + campaignRevision
role + taskKind
codexRuntimeIdentityHash + modelSelector
transport + sessionPolicy
promptEnvelopeHash + inputManifestHash + workspaceIdentityHash
outputSchemaHash + mutationPolicyHash
sandboxPolicy + networkPolicy + approvalPolicy
deadline + output/event/cost/token limits
signed, expiring local request capability
```

The request contains hashes and capabilities, not arbitrary campaign database
access or secrets.

## Prompt input

The broker reads a pre-bound prompt envelope through a capability-owned file or
sealed descriptor. The envelope includes:

- role and task;
- immutable input manifest;
- exact instructions and structured context;
- required deterministic checks;
- mutation policy summary;
- output schema version;
- campaign/node/attempt identifiers;
- explicit statement that external messaging, submission and credential access
  are forbidden.

The receipt binds the prompt envelope hash. Raw prompts are not copied into
ordinary logs.

## JSONL stream rules

The decoder operates before event data can change broker state.

Resource limits:

- total stdout bytes;
- bytes per JSONL record;
- event count;
- stderr bytes;
- execution deadline;
- child process count and process group;
- final output bytes.

Protocol rules:

1. every record is non-empty UTF-8 JSON object;
2. `type` is a bounded non-empty string;
3. one `thread.started` must be the first event and carry a valid thread ID;
4. one `turn.started` follows it;
5. item events occur only after the turn starts;
6. exactly one `turn.completed` or `turn.failed` terminal event occurs;
7. no event follows terminal;
8. known usage fields must be non-negative integers;
9. unknown nonterminal events are retained and reported;
10. unknown terminal-like events (`*.completed`, `*.failed`, `*.cancelled`,
    etc.) fail closed;
11. the hash covers exact raw bytes including line endings.

An `error` event is diagnostic data, not sufficient terminal evidence by itself.
A stream ending without a recognized terminal turn is incomplete.

## Process lifecycle

```text
validate request
reserve journal operation
bind immutable inputs
preflight runtime identity
spawn new process group
record process-start identity
stream bounded stdout/stderr
observe terminal JSONL
wait for process exit and child cleanup
postflight runtime identity
capture final output
validate output schema
snapshot workspace
validate mutation policy
prepare receipt/result
acknowledge campaign integration
```

The broker never trusts exit code alone. Terminal JSONL, process outcome, schema,
runtime identity and workspace evidence are separate fields.

## Cancellation and deadline

Cancellation is delivered to the process group. The broker records whether the
provider may already have started. It waits only for a bounded cleanup window,
then escalates termination. Surviving descendants or uncertain provider outcome
produce an ambiguous result and require a new attempt.

## Output schema

The output schema is immutable for an operation and content-hashed. The final
structured result has role-specific fields plus common fields:

```text
status
summary
checksRun
blockers
evidence references
requested mutation summary
```

Schema-valid model output remains untrusted. It becomes usable only after
mutation and deterministic evidence checks.

## Receipt

`CodexExecutionReceiptV1` proves bounded local observations:

- request and runtime identity;
- process start identity and outcome;
- exact JSONL stream hash/count/thread/terminal;
- final output and schema status;
- workspace before/after and mutation manifest;
- usage and cost classification;
- whether provider action may have started;
- outcome certainty and safe retry disposition.

It does not prove scientific truth, novelty, reviewer independence, release
readiness or submission authority.

## Retry rules

| Observation | Treatment |
|---|---|
| Rejected or failed before spawn | same operation may retry after remediation |
| Process spawned, no trustworthy terminal | outcome ambiguous; new attempt required |
| Terminal failure | new attempt under campaign policy |
| Output schema invalid | current attempt fails; new attempt required |
| Mutation violation | current attempt is discarded and security event recorded |
| Prepared result exists, core crashed | integrate prepared result; do not rerun Codex |
| Usage absent after possible spawn | cost unknown/conservative, never zero |

## Version evolution

New request fields require a new protocol version because V1 denies unknown
fields. New nonterminal JSONL events may be preserved after qualification.
New terminal semantics, session resume, network authority, App Server transport
or interactive approval require a new protocol version and ADR.
