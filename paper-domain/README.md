# paper-domain

Status: normative module guide

## Purpose

`paper-domain` is the pure policy layer for papers, research, evidence, campaigns, governance, journals, operations, quality, repair, submission, and workflow vocabulary. It defines what values mean and which state combinations are valid without performing external effects.

## Responsibilities

The current families are `automation/`, `contracts/`, `evidence/`, `governance/`, `journal/`, `operations/`, `quality/`, `repair/`, `research/`, `submission/`, and `workflow/`.

`contracts/` is the sole implementation owner for cross-cutting paper contracts. Automation owns campaign, analysis, execution-admission, scientific-lineage, and authority-binding policy. Research and evidence own formal/empirical verification values. Submission owns provider-neutral intent, handoff, authorization, and result policy. Workflow owns supported mode and transition vocabulary.

## Dependencies

Domain code may depend on `workflow-kernel` and pure domain files. It may not import ports, adapters, application, composition, CLI, SQL, provider SDKs, filesystem/process/network code, mutable runtime roots, `core/src`, or migration retirement code.

A domain contract never obtains the current time, identity, key, file, or database connection implicitly; those values arrive as validated inputs.

## Contracts

Every persisted, signed, hashed, or cross-process value declares `version`, `kind`, exact required fields, normalization, canonical identity, and verification rules. Constructors validate invariants and return immutable values. Unknown fields are rejected for exact and authority-sensitive records.

Domain state distinguishes generated, executed, verified, qualified, accepted, released, and submitted evidence classes. No constructor promotes between classes without the exact required receipt and authority.

## Failure and recovery

Domain failures identify violated invariants and are deterministic. The domain does not retry effects or repair malformed external data. Recovery policy is expressed as valid transition predicates and typed replacement/supersession records; execution belongs to application and adapters.

## Security

Treat all decoded JSON and model/tool output as untrusted until validated. Signature verification policy binds exact payload purpose, identity, trust epoch, and expiry. Caller-supplied booleans or issuer metadata never create authority. Local evidence remains labeled local.

## Testing

Unit tests cover positive and adversarial invariants, exact-object rejection, identity binding, state transitions, downgrade/replay attempts, and scientific negative boundaries. Architecture tests prove domain purity. Property and differential tests are required where canonicalization or numerical policy makes them useful.

## Change rules

Add behavior to the narrow owning family and export it through the canonical contract index where appropriate. A schema or authority change requires versioning, compatibility/migration analysis, negative tests, threat-model review, and documentation. Do not duplicate a contract in `paper-core`, an adapter, or a migration helper.
