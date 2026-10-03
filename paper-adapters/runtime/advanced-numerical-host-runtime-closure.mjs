import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/;

// Convert the legacy signed descriptor hint only after the existing engine
// has materialized the actual executable and matched both source snapshots.
// This manifest observes executable/plugin content; it does not establish a
// complete host system package closure or scientific authority.
export function observeAdvancedNumericalHostRuntimeClosure({
  runtimePackageClosure,
  runtimeExecutableSnapshot,
  sourceExecutionSnapshot,
  workExecutionSnapshot,
} = {}) {
  if (runtimePackageClosure?.basis !== 'signed-plugin-descriptor') {
    return runtimePackageClosure;
  }
  if (!HASH.test(String(runtimePackageClosure.identityHash || ''))
    || runtimePackageClosure.manifestHash !== runtimePackageClosure.identityHash
    || runtimePackageClosure.observedPackageCount !== 0
    || !HASH.test(String(runtimeExecutableSnapshot?.hash || ''))
    || !HASH.test(String(sourceExecutionSnapshot?.merkleHash || ''))
    || !HASH.test(String(sourceExecutionSnapshot?.manifestHash || ''))
    || sourceExecutionSnapshot?.blockers?.length !== 0
    || workExecutionSnapshot?.blockers?.length !== 0
    || sourceExecutionSnapshot.merkleHash !== workExecutionSnapshot?.merkleHash
    || sourceExecutionSnapshot.manifestHash !== workExecutionSnapshot?.manifestHash) {
    throw new Error('worker_advanced_numerical_observed_runtime_closure_invalid');
  }
  const manifest = Object.freeze({
    version: 1,
    kind: 'AdvancedNumericalObservedHostRuntimeContentManifest',
    assurance: 'observed_executable_and_plugin_source_not_complete_system_package_closure',
    executableHash: runtimeExecutableSnapshot.hash,
    sourceMerkleHash: sourceExecutionSnapshot.merkleHash,
    sourceWorkspaceManifestHash: sourceExecutionSnapshot.manifestHash,
    signedDescriptorPackageClosureHash: runtimePackageClosure.identityHash,
    observedPackageCount: 0,
  });
  const manifestHash = hashRecord('AdvancedNumericalObservedHostRuntimeContentManifest', manifest);
  return Object.freeze({
    basis: 'content_manifest',
    identityHash: hashRecord('RuntimePackageClosureIdentity', {
      manifestHash,
      observedPackageCount: 0,
    }),
    manifestHash,
    observedPackageCount: 0,
  });
}
