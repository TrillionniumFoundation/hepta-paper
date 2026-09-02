# ADR 0001: Canonical one-way layering

Status: normative

## Scope

This record establishes the canonical source layering for the active production graph.

## Decision

Adopt `workflow-kernel`, `paper-domain`, `paper-ports`, `paper-application`, `paper-adapters`, `paper-composition`, and `paper-core` entrypoints as one-way layers. Composition is the only assembly layer. External effects enter application orchestration through explicit ports and exact execution profiles.

## Rationale

The system combines scientific execution, durable workflow state, authority verification, package lifecycle, and remote-submission risk. Keeping pure policy independent from effects makes invariants testable, prevents concrete infrastructure from becoming business authority, and enables adapter replacement through conformance contracts.

## Consequences

Architecture tests classify modules and reject cycles or illegal imports. New services require a port and profile decision. Compatibility and experimental graphs remain explicit and cannot become implicit fallbacks. Moving responsibility requires a new ADR and a migration/retirement plan.
