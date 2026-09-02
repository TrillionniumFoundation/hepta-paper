# ADR 0002: Reference package boundary

Status: normative

## Scope

This record defines the role of the `core/` submodule.

## Decision

Treat `core/` as a pinned, baseline-bound reference package. Active production modules may inspect it only through approved verification or compatibility tooling and may not import `core/src` into a production executable graph.

## Rationale

The reference tree preserves historical implementation and differential evidence without allowing a second runtime authority to drift beside the native hepta-paper contracts. Exact superproject commit and baseline verification make its identity reviewable.

## Consequences

Changes to the submodule pointer require reference-integrity review. New functionality is implemented in the canonical active layers. Compatibility exceptions are hash-bound and retired explicitly. A green reference selftest does not grant current production, academic, or submission authority.
