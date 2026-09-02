# paper-composition

Status: normative module guide

## Purpose

`paper-composition` is the sole concrete assembly layer. It validates configuration and filesystem roots, constructs adapters, selects exact application service profiles, and exposes bounded object graphs to CLI and verification entrypoints.

## Responsibilities

- `bootstrap/`: common configuration, path, schema, trust, and store initialization;
- `automation/`: campaign and autonomous-research object graphs;
- `batch/`: inventory, build, research, review, and package batch composition;
- `submission/`: handoff, delivery, and reconciliation compositions with separated authority;
- `runtime/`: runtime services and production host bindings;
- `reporting/`: read-only report persistence/projection wiring;
- `compat/`: explicit legacy compatibility roots;
- `pilots/`: explicitly bounded non-production pilots.

Composition selects implementations; it does not rewrite their contracts or introduce business rules.

## Dependencies

Composition may import all active lower layers to assemble them. Lower layers may not import composition. `paper-core` entrypoints may call composition. Production composition may not import `core/src`, migration retirement, or experimental modules except through an explicitly classified non-production root.

## Contracts

Each builder declares its execution profile, required services, derived capabilities, writable roots, trust inputs, external-action policy, and lifecycle cleanup. The resulting `ExecutionContext` must accept the exact service set; unused extra authority is rejected.

Configuration is parsed and validated before adapters are constructed. Writable roots are real-path-separated from source, assets, and retirement/reference roots.

## Failure and recovery

Bootstrap fails before exposing a partial object graph when schema, path, permissions, trust, runtime, or capability validation fails. Once durable work begins, recovery is delegated through the exact store, transaction, lease, outbox, and package lifecycle ports selected by the composition.

Shutdown is bounded and drains or records in-flight work according to the owning adapter contract. It does not delete durable prepared results.

## Security

Composition is the critical least-authority boundary. It withholds live submission, trusted writer, deletion, release, and signing capabilities from profiles that do not require them. Secrets remain references to protected services or roots and are not copied into application options or reports.

## Testing

Composition tests instantiate every profile, assert exact service/capability sets, reject missing and extra authority, verify production versus compatibility reachability, test root-overlap and symlink failures, and exercise startup/shutdown/recovery with adapter fakes or isolated stores.

## Change rules

Any new binding must identify the owning port, profile, configuration schema, trust boundary, lifecycle, and tests. Do not add convenience access to a broad container. Production and experimental roots stay physically and declaratively separate.
