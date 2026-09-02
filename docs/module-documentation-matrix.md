# Module documentation matrix

Status: normative

## Scope

This matrix records the required top-level development guides. `paper-core/bin/documentation-integrity.mjs` verifies that every listed active/support root has a substantive README and that every active runtime root declared by `package.json` appears here.

| Root | Class | Canonical responsibility | Guide |
|---|---|---|---|
| `workflow-kernel` | active | neutral identity, hashing, runtime primitives | [`../workflow-kernel/README.md`](../workflow-kernel/README.md) |
| `paper-domain` | active | pure paper and research policy | [`../paper-domain/README.md`](../paper-domain/README.md) |
| `paper-ports` | active | typed external capability boundaries | [`../paper-ports/README.md`](../paper-ports/README.md) |
| `paper-application` | active | use-case orchestration and execution contexts | [`../paper-application/README.md`](../paper-application/README.md) |
| `paper-adapters` | active | concrete I/O and runtime implementations | [`../paper-adapters/README.md`](../paper-adapters/README.md) |
| `paper-composition` | active | object graphs and profile bootstraps | [`../paper-composition/README.md`](../paper-composition/README.md) |
| `paper-core` | active | CLI, verification, config, deploy, compatibility | [`../paper-core/README.md`](../paper-core/README.md) |
| `runtime-images` | support | pinned scientific runtime definitions | [`../runtime-images/README.md`](../runtime-images/README.md) |
| `store` | support | ordered native SQLite migrations | [`../store/README.md`](../store/README.md) |
| `migration` | support | legacy disposition and replay evidence | [`../migration/README.md`](../migration/README.md) |
| `numerical-plugins` | support | numerical plugin candidates and qualification | [`../numerical-plugins/README.md`](../numerical-plugins/README.md) |
| `core` | reference | baseline-bound historical implementation | [`architecture/source-of-truth.md`](architecture/source-of-truth.md) |

Nested source families are documented by their owning root README and focused normative guides. A nested family that acquires an independent public contract, persistence schema, external effect, release lifecycle, or separate owner must add its own README and be promoted into this matrix.
