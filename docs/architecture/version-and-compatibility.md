# Version and compatibility

Status: normative

## Scope

This policy covers the workspace package version, boundary schemas, SQLite migrations, command surface, runtime images, reference submodules, and compatibility modules.

## Version domains

The workspace version identifies a reviewed source candidate; it does not by itself establish deployment readiness. Boundary documents and receipts carry their own explicit schema versions. SQLite uses ordered migrations. Runtime images are identified by immutable digests. Submodules are identified by exact commits plus repository-owned integrity policy.

A change is breaking when an existing valid caller, persisted record, receipt verifier, replay, or adapter becomes invalid or changes meaning. Renaming a field while accepting the old field ambiguously is also breaking.

## Reader and writer policy

Writers emit only the current canonical schema. Readers may support older schemas only through an explicit, tested compatibility path. Unknown fields are rejected when signatures, hashes, authority, or exact-object contracts are involved; permissive extension is allowed only where the owning schema explicitly declares it.

Conversions must report information loss. They may not silently drop signature-covered fields, change canonical serialization, or promote a lower evidence class.

## Command compatibility

The declarative command registry is the supported CLI. Deprecated aliases are bounded compatibility surfaces, not a second operator API. New npm scripts must be classified or they are blocked as internal. Forwarded arguments require the explicit separator.

## Database compatibility

Applied SQL migrations are never edited, reordered, or reused. A schema change adds the next migration, a compatibility test, restore coverage, and any required backfill command. Application access is gated by a schema-version receipt so partially migrated state fails closed.

## Submodules and images

`core/` and the R source CAS are fetched from HTTPS URLs and pinned by the superproject. Updating them requires reviewing their diff, updating integrity baselines or manifests, and rerunning reference and supply-chain gates. Runtime images must use digest-pinned bases and produce reproducible identity evidence; a mutable tag is never a release identity.

## Retirement

Compatibility ends only when the manifest retirement condition is met and all production import, data, test, command, and operational dependencies are removed. Historical evidence remains immutable after retirement.
