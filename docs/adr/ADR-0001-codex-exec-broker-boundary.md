# ADR-0001: use a role-specific Codex exec broker boundary

Status: accepted for Foundation V1  
Date: 2026-08-28

## Context

The existing Node executor contains valuable runtime identity, fresh-session,
bounded-process and workspace-audit semantics, but those semantics are entangled
with `codex-openclaw-managed-*`. The Rust rewrite must integrate primarily with
Codex and must not preserve OpenClaw as a target dependency.

Current Codex automation options include non-interactive CLI execution, SDKs and
App Server. A Rust production control plane needs a narrow, testable boundary
without adding a Node/Python SDK sidecar or adopting an experimental broad
protocol surface.

## Decision

V1 uses a role-specific local broker that invokes a qualified Codex CLI with
non-interactive JSONL execution. The Rust campaign core communicates with the
broker using a versioned request/receipt protocol. Author, reviewer and formal
reviewer brokers have separate principals, homes, journals and role profiles.

V1 requires fresh ephemeral sessions, output schema, no model workspace network,
no interactive approval and actual workspace mutation verification.

OpenClaw, App Server, WebSocket, MCP, plugins, web search, session resume and
`danger-full-access` are outside the V1 production boundary.

## Consequences

Positive:

- Rust has no Node/Python SDK runtime dependency;
- provider protocol is isolated from domain contracts;
- role credentials and campaign authority are separated;
- JSONL and process failure modes can be exhaustively fault tested;
- Codex upgrades are explicit qualification events;
- OpenClaw retirement does not require a Rust adapter.

Costs:

- process supervision and durable operation reconciliation must be built;
- CLI event evolution requires qualification and conservative parsing;
- richer App Server features are unavailable in V1;
- every role needs deployment and credential isolation.

## Rejected alternatives

### Port OpenClaw integration to Rust

Rejected because it preserves an unwanted compatibility target, broadens the
TCB and delays the Codex-first vertical slice.

### Use the TypeScript/Python Codex SDK behind a sidecar

Rejected for V1 because it reintroduces another first-party language runtime and
moves rather than removes protocol/operations complexity.

### Embed App Server immediately

Rejected for V1 because it exposes a broader, evolving protocol surface before
basic execution, recovery and trust boundaries are qualified.

### Call Codex directly from the campaign writer

Rejected because it co-locates provider credentials, process compromise and
campaign write authority and makes post-spawn ambiguity harder to reconcile.

### Build a generic provider plug-in framework

Rejected because there is no second target provider and the abstraction would
front-load speculative complexity. Domain ports remain narrow enough to test
with deterministic fakes.

## Revisit conditions

A new ADR may evaluate another transport only after M4 and only with:

- independent threat model;
- versioned protocol and migration;
- role/credential isolation at least as strong as V1;
- fault/recovery parity;
- no regression in deterministic evidence or cutover safety.
