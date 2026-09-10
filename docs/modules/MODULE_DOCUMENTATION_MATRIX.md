# Module documentation matrix

This matrix is generated from the canonical static module registry and the committed one-to-one documentation index. A `complete` row means the module has a normative specification and machine manifest with all required sections; it does **not** mean the module is target-host qualified, externally authorized, or production activated.

| Module | Kind | Static state | Activation | Authority | Qualification | Specification | Manifest |
|---|---|---|---|---|---|---|---|
| `module.author-node` | `isolated_process` | `source_implemented` | `authoritative` | `prepared_result_only` | `source` | [spec](specs/author-node.md) | [manifest](manifests/author-node.v1.json) |
| `module.build-package` | `isolated_process` | `source_implemented` | `authoritative` | `prepared_result_only` | `source` | [spec](specs/build-package.md) | [manifest](manifests/build-package.v1.json) |
| `module.candidate-router` | `trusted_in_process` | `design_ready` | `disabled` | `pure` | `source` | [spec](specs/candidate-router.md) | [manifest](manifests/candidate-router.v1.json) |
| `module.codex-broker` | `host_service` | `source_implemented` | `disabled` | `prepared_result_only` | `target_host` | [spec](specs/codex-broker.md) | [manifest](manifests/codex-broker.v1.json) |
| `module.commit-sequencer` | `host_service` | `source_implemented` | `disabled` | `central_state_write` | `target_host` | [spec](specs/commit-sequencer.md) | [manifest](manifests/commit-sequencer.v1.json) |
| `module.compatibility-kernel` | `pure_library` | `source_implemented` | `disabled` | `read_only` | `source` | [spec](specs/compatibility-kernel.md) | [manifest](manifests/compatibility-kernel.v1.json) |
| `module.cutover-controller` | `trusted_in_process` | `source_implemented` | `disabled` | `prepared_result_only` | `source` | [spec](specs/cutover-controller.md) | [manifest](manifests/cutover-controller.v1.json) |
| `module.empirical-node` | `isolated_process` | `source_implemented` | `authoritative` | `prepared_result_only` | `source` | [spec](specs/empirical-node.md) | [manifest](manifests/empirical-node.v1.json) |
| `module.execution-dispatcher` | `trusted_in_process` | `source_implemented` | `disabled` | `prepared_result_only` | `source` | [spec](specs/execution-dispatcher.md) | [manifest](manifests/execution-dispatcher.v1.json) |
| `module.external-authority-verifier` | `trusted_in_process` | `source_implemented` | `disabled` | `read_only` | `source` | [spec](specs/external-authority-verifier.md) | [manifest](manifests/external-authority-verifier.v1.json) |
| `module.formal-node` | `isolated_process` | `source_implemented` | `authoritative` | `prepared_result_only` | `source` | [spec](specs/formal-node.md) | [manifest](manifests/formal-node.v1.json) |
| `module.module-registry` | `trusted_in_process` | `source_implemented` | `disabled` | `read_only` | `source` | [spec](specs/module-registry.md) | [manifest](manifests/module-registry.v1.json) |
| `module.node-control-plane` | `legacy_in_process` | `source_implemented` | `authoritative` | `central_state_write` | `target_host` | [spec](specs/node-control-plane.md) | [manifest](manifests/node-control-plane.v1.json) |
| `module.node-legacy-adapter` | `legacy_adapter` | `design_ready` | `disabled` | `prepared_result_only` | `source` | [spec](specs/node-legacy-adapter.md) | [manifest](manifests/node-legacy-adapter.v1.json) |
| `module.numerical-node` | `isolated_process` | `source_implemented` | `authoritative` | `prepared_result_only` | `source` | [spec](specs/numerical-node.md) | [manifest](manifests/numerical-node.v1.json) |
| `module.observability` | `trusted_in_process` | `source_implemented` | `disabled` | `read_only` | `source` | [spec](specs/observability.md) | [manifest](manifests/observability.v1.json) |
| `module.performance-qualification` | `isolated_process` | `design_ready` | `disabled` | `read_only` | `target_host` | [spec](specs/performance-qualification.md) | [manifest](manifests/performance-qualification.v1.json) |
| `module.policy-engine` | `pure_library` | `source_implemented` | `disabled` | `pure` | `source` | [spec](specs/policy-engine.md) | [manifest](manifests/policy-engine.v1.json) |
| `module.program-truth` | `pure_library` | `source_implemented` | `disabled` | `pure` | `source` | [spec](specs/program-truth.md) | [manifest](manifests/program-truth.v1.json) |
| `module.protocol-kernel` | `pure_library` | `source_implemented` | `authoritative` | `pure` | `source` | [spec](specs/protocol-kernel.md) | [manifest](manifests/protocol-kernel.v1.json) |
| `module.qualification-ingest` | `host_service` | `source_implemented` | `disabled` | `read_only` | `source` | [spec](specs/qualification-ingest.md) | [manifest](manifests/qualification-ingest.v1.json) |
| `module.readonly-control` | `trusted_in_process` | `source_implemented` | `disabled` | `read_only` | `source` | [spec](specs/readonly-control.md) | [manifest](manifests/readonly-control.v1.json) |
| `module.resource-allocator` | `trusted_in_process` | `source_implemented` | `authoritative` | `read_only` | `source` | [spec](specs/resource-allocator.md) | [manifest](manifests/resource-allocator.v1.json) |
| `module.reviewer-node` | `isolated_process` | `source_implemented` | `authoritative` | `prepared_result_only` | `source` | [spec](specs/reviewer-node.md) | [manifest](manifests/reviewer-node.v1.json) |
| `module.rust-control-plane-service` | `host_service` | `design_ready` | `disabled` | `prepared_result_only` | `source` | [spec](specs/rust-control-plane-service.md) | [manifest](manifests/rust-control-plane-service.v1.json) |
| `module.rust-local-vertical` | `trusted_in_process` | `source_implemented` | `disabled` | `prepared_result_only` | `source` | [spec](specs/rust-local-vertical.md) | [manifest](manifests/rust-local-vertical.v1.json) |
| `module.scheduler-core` | `pure_library` | `source_implemented` | `disabled` | `pure` | `source` | [spec](specs/scheduler-core.md) | [manifest](manifests/scheduler-core.v1.json) |
| `module.scientific-evidence` | `trusted_in_process` | `source_implemented` | `disabled` | `read_only` | `source` | [spec](specs/scientific-evidence.md) | [manifest](manifests/scientific-evidence.v1.json) |
| `module.snapshot-builder` | `trusted_in_process` | `design_ready` | `disabled` | `read_only` | `source` | [spec](specs/snapshot-builder.md) | [manifest](manifests/snapshot-builder.v1.json) |
| `module.source-qualification` | `trusted_in_process` | `source_implemented` | `disabled` | `read_only` | `source` | [spec](specs/source-qualification.md) | [manifest](manifests/source-qualification.v1.json) |
| `module.submission-port` | `external_service` | `source_implemented` | `disabled` | `external_effect` | `external_authority` | [spec](specs/submission-port.md) | [manifest](manifests/submission-port.v1.json) |
| `module.workspace-authority` | `host_service` | `source_implemented` | `disabled` | `prepared_result_only` | `target_host` | [spec](specs/workspace-authority.md) | [manifest](manifests/workspace-authority.v1.json) |

Validate with:

```bash
node docs/tools/validate-module-documentation.mjs
```

The validator fails on missing/orphan specifications or manifests, registry drift, missing required headings, placeholder language, missing implementation roots, and absent authority-specific safety contracts.
