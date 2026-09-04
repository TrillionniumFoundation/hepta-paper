# ADR-0014: assign primary, secondary, and independent reviewer ownership

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

Routing almost every high-risk path to one reviewer preserves consistency at
small scale but becomes a serialization point and knowledge single point of
failure for a dozens-person program.

## Decision

Every production module has a primary team, a secondary recovery-capable team,
and an independent reviewer team for authority, protocol, state, objective, and
quality changes. Ownership is stored in machine truth and generates CODEOWNERS
after real GitHub teams are provisioned. No nonexistent team handle is written
into active CODEOWNERS.

Ordinary private implementation changes stay within module owners. Public
protocol, authority, durable state, global objective, qualification, and release
changes require cross-team review according to change class.

## Consequences

Local iteration scales while TCB decisions retain independent scrutiny. A
module is not organizationally production-ready until roles are staffed and
denial/approval behavior is tested.

## Adoption gates

`ORG-001`, `ORG-002`, `MOD-007`, protected-main governance evidence, and team
availability drills must close.
