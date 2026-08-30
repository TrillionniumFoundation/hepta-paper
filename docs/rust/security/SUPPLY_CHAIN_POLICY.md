# Rust supply-chain policy

Status: repository-local source gate. This policy does not authorize production activation, release promotion, external credentials, target-host custody, or submission.

## Required source controls

The Rust workspace must satisfy all of the following on the exact pull-request head or protected-branch commit:

1. `Cargo.lock` is committed and every Cargo command used by the gate preserves it byte-for-byte.
2. Dependency sources are restricted to the canonical crates.io registry. Git dependencies and unknown registries fail closed.
3. Wildcard version requirements fail closed. Internal path dependencies bind the exact workspace version. Duplicate external versions are reported for review but do not silently change resolution.
4. Every non-private dependency has an explicitly accepted SPDX license expression. Per-crate exceptions require a reason, owner, expiry, and dedicated review; the baseline `cargo-deny` policy contains no exceptions.
5. RustSec vulnerability and yanked-package findings fail the gate. The advisory database commit used by the run is retained in evidence; the baseline policy contains no ignored advisory.
6. `cargo-deny` and `cargo-cyclonedx` are downloaded only from their official release repositories, pinned to immutable versions, and verified against checked-in SHA-256 values in the workflow before execution.
7. CycloneDX 1.5 JSON SBOMs are generated with all workspace features and all target-specific dependency edges. `SOURCE_DATE_EPOCH` is bound to the source commit time so the same source and tool versions produce stable documents.
8. CycloneDX license parsing remains strict. The sole accepted named-license compatibility string is the historical upstream literal `MIT/Apache-2.0`; it is a serialization alias for legacy crate metadata, not a new license approval or a `cargo-deny` exception. Any other non-SPDX named license fails generation.
9. The gate recognizes the pinned generator's documented default output pattern, `<crate>.cdx.json`, rather than assuming the obsolete `bom.json` name. Every generated document must be CycloneDX 1.5 JSON and contain a component list.
10. The evidence bundle binds the Git commit, Git tree, manifest hash, lockfile hash, policy hash, tool versions, tool binary hashes, advisory database commit, generation settings, every SBOM hash, workflow identity, run identity, and the exact bounded SBOM compatibility allowance.
11. Generation must leave the checked-out tree clean even on failure. Generated `*.cdx.json`, `*.cdx.xml`, `bom.json`, and `bom.xml` outputs are removed by an exit trap after being copied to the evidence directory. The lockfile hash is checked before and after generation, and unexpected postflight status is retained as diagnostic evidence.
12. A failed policy check still uploads the available diagnostic evidence, but failure evidence never qualifies the source.

## Accepted license classes

The global allowlist is intentionally limited to commonly used permissive and weak-copyleft licenses already represented by the locked dependency graph. Adding another license is a policy change and must not be hidden in a package update.

Workspace crates are unpublished and are excluded from third-party license evaluation; this does not change the repository's own licensing obligations.

The legacy literal `MIT/Apache-2.0` is accepted only by the SBOM serializer because several locked upstream packages still publish that deprecated separator. `cargo-deny` independently resolves and validates those packages against the SPDX allowlist, so this compatibility alias cannot admit an unapproved license.

## Evidence and freshness

A successful artifact is valid only for the exact commit/tree named inside it. A new dependency resolution, policy change, workflow change, tool-version change, advisory database update, generation-setting change, or compatibility-allowance change requires a new run. The artifact is source evidence only; target-host and external-authority evidence remain separate gates under the Rust master plan.
