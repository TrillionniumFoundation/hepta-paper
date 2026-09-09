# Supply-chain policy

The Rust-specific policy remains in `docs/rust/security/SUPPLY_CHAIN_POLICY.md`.
This document defines the global cross-language and module requirements.

## 1. Source and dependency controls

- exact lockfiles and toolchain versions;
- immutable action/tool downloads by digest;
- allowlisted registries/sources and licenses;
- no unreviewed git/path/network dependency in production graphs;
- generated source and bindings reproducible from committed schemas;
- SBOM covers all features, targets, modules, images, and external runtime
  descriptors;
- vulnerability/advisory policy has severity, applicability, owner, and expiry.

## 2. Module artifacts

A qualified module artifact binds:

```text
source commit/tree
build workflow and toolchain
lockfiles/dependency graph
binary/image digest
configuration schema/version
module manifest and capabilities
SBOM/provenance
signature/attestation where required
```

Mutable tags and filenames are not identities.

## 3. Runtime closure

Pinning a top-level executable alone does not prove interpreter, dynamic library,
CA store, plugins, model, or credential-helper closure. Production qualification
states exactly which transitive runtime identity is established and which
remains an external prerequisite.

## 4. Upgrade

Dependency/toolchain/module upgrades require:

- behavior and protocol impact analysis;
- compatibility and golden replay;
- vulnerability/license/provenance checks;
- performance regression workload;
- rollout/rollback;
- exact-head evidence.

## 5. Secrets

Build and CI environments do not expose production provider, KMS/HSM, storage,
portal, or submission credentials. Secret-gated external evidence workflows
publish only approved bounded receipts and hashes.
