# Node-to-Rust parity matrix

Parity is not a single equality relation. Each behavior is assigned one of four
strategies before implementation.

- **exact** — bytes, hashes, rows, statuses and authority must match;
- **semantic** — invariant and outcome class must match, representation may
  change under a versioned contract;
- **evaluation** — non-deterministic model output is assessed by quality and
  safety metrics, never text equality;
- **retire** — legacy behavior has no target implementation and receives an
  explicit retirement/migration plan.

## Deterministic parity

| Capability | Current Node anchors | Rust target | Strategy | Required evidence |
|---|---|---|---|---|
| Record hashing | `workflow-kernel/record-hash.mjs` and callsites | compatibility kernel | exact | byte corpus and Node oracle |
| Stable JSON | historical serialization callsites | `LegacyStableJsonV1` | exact | adversarial number/string/object fixtures |
| Contract decode | `paper-domain`, `paper-ports` | versioned domain crates | exact for V1; semantic for V2 | round-trip and unknown-field tests |
| Error/status values | distributed string constants | registry crate | exact | generated inventory diff |
| SQLite schema 1–25 | persistence/migration modules | read-only then writer store | exact logical state | normalized DB fixture diff |
| Campaign transitions | application/composition state machines | campaign engine | semantic + exact status effects | transition table and simulation |
| Lease/generation fencing | campaign/repository modules | writer store | exact invariant | stale-generation stress tests |
| Prepared results | one-shot attempt journals | campaign integration | semantic | crash recovery and exactly-once tests |
| Workspace inventory | workspace attempt/snapshot modules | workspace/CAS crates | exact bytes and node types | tree corpus and cross-verification |
| Release receipt verification | release/authority modules | release verifier | exact acceptance/rejection | old/new cross-verifier matrix |
| Submission idempotency | submission outbox/dispatcher | dispatcher port | exact side-effect identity | replay/ambiguity test matrix |

## Codex execution parity

| Behavior | Current Node anchors | Rust strategy | Classification |
|---|---|---|---|
| Executable/config/auth-root identity | `codex-runtime-preflight.mjs`, capability binding | content and filesystem identity with pre/postflight | semantic, stricter V2 |
| Fresh ephemeral sessions | capability receipts and executor args | mandatory `EphemeralNewThread` | exact invariant |
| Author/reviewer separation | capability receipt fields, principal pool | distinct broker principals and role profiles | semantic, stronger isolation |
| Bounded process execution | `bounded-child-process.mjs` | process-group supervisor | semantic |
| Workspace mutation detection | workspace change tracker | before/after inventory verifier | semantic, stronger evidence |
| Structured final output | permissive stdout scan plus managed path | JSONL terminal item + output schema | deliberate fix-v2 |
| OpenClaw managed runtime | `codex-openclaw-managed-*` | no target runtime | retire |
| Model prose/code | model-dependent | live evaluation | evaluation |
| Reviewer narrative | model-dependent | issue/recommendation schema plus evaluation | evaluation |

## Behaviors that must never be byte-differenced

- manuscript prose;
- generated source code;
- reviewer natural-language comments;
- model reasoning traces;
- provider event timing;
- token counts across different model/runtime versions.

For these, compare bound inputs, permissions, schema validity, mutation policy,
deterministic downstream checks and quality metrics.

## Known behavior disposition process

Before porting a Node behavior, record:

```text
behavior ID
source entrypoint and tests
current observed behavior
required invariant
strategy: exact | semantic | evaluation | retire
known defects
versioning decision
Rust owner
cutover gate
rollback path
```

A known Node defect must not be smuggled into “parity.” It is either preserved
only for read compatibility or corrected under a new contract/version.

## Oracle design

The Node oracle is a bounded, read-only process:

- immutable baseline commit and lockfile;
- no network and no production secrets;
- bounded input, output and execution time;
- canonical fixtures only;
- exact executable/runtime identity recorded;
- output includes algorithm version and input hash.

The oracle is not a production dependency after cutover. It is retained as a
historical compatibility verifier until its fixture corpus is independently
reproduced and archived.

## Differential failure classes

| Class | Meaning | Disposition |
|---|---|---|
| `encoding_byte_drift` | deterministic serialized bytes differ | blocker |
| `hash_drift` | record/receipt hash differs | blocker |
| `logical_state_drift` | normalized SQLite state differs | blocker |
| `authority_drift` | one side accepts an authority the other rejects | blocker and security review |
| `known_defect_correction` | approved V2 correction | allowed only with ADR/migration |
| `representation_only` | versioned internal shape differs, invariant equal | allowed with semantic proof |
| `model_nondeterminism` | generated content differs | evaluation suite, not blocker by itself |
| `legacy_retirement` | behavior intentionally absent | migration/retirement gate |

## Initial mapping backlog

The following Node areas require detailed callsite inventory before writer work:

1. `workflow-kernel` canonicalization and record hashes;
2. campaign one-shot attempt journals and external-action recovery;
3. SQLite mutation coordinator and schema transition modules;
4. workspace attempt, change tracker, snapshot and release package transaction;
5. Codex direct executor/capability/runtime preflight;
6. reviewer principal pool and recoverable reviewer adapter;
7. formal/empirical evidence and independent recomputation;
8. release attestation, backup, WORM and submission outbox.

OpenClaw-managed files are inventoried only to identify consumers and retirement
requirements. They do not generate Rust implementation tasks.
