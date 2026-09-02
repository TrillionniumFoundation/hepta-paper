# paper-application

Status: normative module guide

## Purpose

`paper-application` coordinates use cases over validated domain values and injected ports. It owns execution contexts, persistent campaign orchestration, bounded planning, and pure reporting projections. It does not implement external infrastructure.

## Responsibilities

- `execution-context.mjs` validates roots, mode, execution flags, service profile, exact service set, and derived capabilities;
- `automation/` coordinates campaign DAG planning, admission, execution integration, review/revision, and release handoff;
- `orchestration/` coordinates bounded use cases outside the core campaign family;
- `reporting/` projects state into read-only reports;
- `experimental/` contains explicitly non-production application experiments.

Supported service profiles are `handoff`, `handoff-export`, `inventory`, `automation`, `batch`, `submission`, and bounded `legacy`.

## Dependencies

Application code may import domain, ports, and kernel modules. It may not import concrete adapters, composition roots, SQL, provider SDKs, CLI parsing, `core/src`, or migration retirement modules.

All effects arrive through `ExecutionContext.services`. The declared capability list must exactly match the services validated for the selected profile.

## Contracts

Each use case defines input validation, required capabilities, unit-of-work boundary, state preconditions, emitted receipts/events, and result projection. Reporting functions are pure and do not acquire hidden write capabilities.

The context safety contract forbids external action and legacy control-plane imports by default, requires writes through declared ports, and exposes a raw store only to the legacy profile.

## Failure and recovery

Application orchestration persists intent before irreversible work, uses generation/attempt fencing, integrates durable prepared results, and reconciles unknown external outcomes. It owns bounded retry policy and budget accounting; adapters report facts rather than deciding campaign success.

Cancellation and deadlines propagate through ports. A caught error cannot be converted to success without the domain-defined replacement or recovery receipt.

## Security

Profiles follow least authority. Submission handoff receives query-only current-release access; automation cannot acquire live provider mutation merely because a provider adapter exists. Untrusted worker/model output is validated before it enters domain state.

## Testing

Tests cover each profile’s exact required services and capabilities, missing/extra authority, orchestration success, domain rejection, retries, budget exhaustion, cancellation, stale attempts, prepared-result recovery, reporting purity, and restart behavior. Architecture tests reject adapter/SQL/CLI imports.

## Change rules

Place reusable policy in domain, boundary semantics in ports, and I/O in adapters. A new use case needs a named profile impact, transaction and recovery design, tests, documentation, and composition wiring. Experimental code never becomes production-reachable through fallback.
