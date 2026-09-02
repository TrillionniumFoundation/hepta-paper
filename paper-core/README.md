# paper-core

Status: normative module guide

## Purpose

`paper-core` owns supported executables, verification entrypoints, configuration and deployment assets, repository-level tests, normative operational/status documents, and bounded compatibility facades. It exposes the product; it does not own a second copy of domain or application policy.

## Responsibilities

- `bin/`: `hepta-paper`, production-core compatibility, verification, maintenance, migration-support, and operational commands;
- `src/`: command registry, entrypoint manifests, compatibility exports, and CLI-facing orchestration helpers;
- `docs/`: current status, architecture, command surface, operations, authority, automation, and focused technical protocols;
- `config/`: machine-readable policies, manifests, runtime and asset contracts;
- `deploy/`: source deployment templates and host assets;
- `tests/` and `verification/`: architecture, contract, safety, migration, release, and isolated operational verification;
- `experimental/`: explicitly non-production pilots;
- `fixtures/`: bounded test evidence, never production authority.

## Dependencies

Entrypoints may invoke composition and lower-layer public contracts. `paper-core/src` must not become a dependency of domain, ports, application, adapters, or composition. Contract implementations remain in `paper-domain/contracts`; compatibility re-exports are narrow and retirement-bound.

## Contracts

The declarative command registry is the supported command surface and classifies operator, verification, maintenance, retirement, compatibility, experimental, and internal commands. Unknown scripts and options fail closed. Current readiness counts have one source: `docs/CURRENT_STATUS.md`.

Verification commands state their evidence boundary. A source check, fixture replay, live-model canary, external trust receipt, and production qualification are different results.

## Failure and recovery

CLI errors use non-zero exit status and structured blockers. Commands do not convert missing prerequisites into warnings when the requested gate requires them. Mutating commands persist intent and rely on the selected composition’s recovery protocol.

Verification entrypoints run in isolated roots when required and must not consume stale mutable reports as current evidence.

## Security

Workflow actions, runtime images, lockfile dependencies, tracked secrets, bounded SAST, submodule identity, trust policies, and release documents are checked by repository gates. Deployment placeholders are never reported as deployable identities. CLI compatibility cannot bypass authority verification.

## Testing

`static:check` covers command registration, source supply-chain policy, syntax, lint, release-state consistency, architecture, imports, and focused repository tests. Safety and isolated CI/release lanes add persistence, campaign, package, scientific, authority, migration, and operational checks. Documentation has a dedicated independent workflow.

## Change rules

A new command must be classified in the declarative registry, specify mutability/effects, validate forwarded arguments, have negative tests, and update command documentation. A new compatibility facade needs a manifest entry and retirement condition. Do not place reusable business policy in `paper-core`.
