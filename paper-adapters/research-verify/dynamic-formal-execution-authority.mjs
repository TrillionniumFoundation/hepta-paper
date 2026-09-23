import {
  PRODUCTION_LEAN_TOOLCHAIN,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyProductionMathlibBuildAuthority,
} from './production-mathlib-build-authority.mjs';
import {
  verifyProductionMathlibReleaseIdentity,
} from './production-mathlib-release-provenance.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

const DYNAMIC_FORMAL_EXECUTION_AUTHORITY_KEYS = Object.freeze([
  'dynamicFormalExecutionAuthorityHash',
  'dynamicFormalProjectClosureReadinessHash',
  'formalProjectClosureHash',
  'formalProjectManifestHash',
  'formalSandboxRuntimeConfigurationHash',
  'formalSandboxRuntimeImage',
  'formalSandboxRuntimeImageDigest',
  'formalSandboxProbeReceiptHash',
  'formalSandboxProbeRuntimeIdentityHash',
  'formalSandboxProbeExecutionProcessIdentityHash',
  'formalSandboxProbeSnapshotSealReceiptHash',
  'imports',
  'kind',
  'mathlibPackageSourcePath',
  'productionMathlibBuildAuthority',
  'productionMathlibBuildAuthorityHash',
  'productionMathlibReleaseIdentity',
  'productionMathlibReleaseIdentityHash',
  'probeRelativePath',
  'projectRoot',
  'projectScopeRoot',
  'status',
  'toolchain',
  'toolchainContentIdentityHash',
  'toolchainRootMerkleHash',
  'version',
]);

export function buildDynamicFormalExecutionAuthority(inspection) {
  if (inspection?.status !== 'dynamic_formal_project_closure_ready'
    || inspection.ready !== true
    || inspection.postProbeReinspectionVerified !== true
    || JSON.stringify(inspection.imports) !== JSON.stringify(['Mathlib'])
    || !SHA256.test(String(inspection.dynamicFormalProjectClosureReadinessHash || ''))
    || !SHA256.test(String(inspection.formalProjectClosureHash || ''))
    || !SHA256.test(String(inspection.formalProjectManifestHash || ''))
    || !SHA256.test(String(inspection.toolchainRootMerkleHash || ''))
    || !SHA256.test(String(inspection.toolchainContentIdentityHash || ''))
    || !SHA256.test(String(inspection.formalSandboxRuntimeConfigurationHash || ''))
    || !String(inspection.formalSandboxRuntimeImage || '')
    || !SHA256.test(String(inspection.formalSandboxRuntimeImageDigest || ''))
    || !SHA256.test(String(inspection.formalSandboxProbeReceiptHash || ''))
    || !SHA256.test(String(inspection.formalSandboxProbeRuntimeIdentityHash || ''))
    || !SHA256.test(String(
      inspection.formalSandboxProbeExecutionProcessIdentityHash || '',
    ))
    || !SHA256.test(String(
      inspection.formalSandboxProbeSnapshotSealReceiptHash || '',
    ))
    || !verifyProductionMathlibReleaseIdentity(
      inspection.productionMathlibReleaseIdentity,
    )
    || inspection.productionMathlibReleaseIdentityHash
      !== inspection.productionMathlibReleaseIdentity
        .productionMathlibReleaseIdentityHash
    || !verifyProductionMathlibBuildAuthority(
      inspection.productionMathlibBuildAuthority,
    )
    || inspection.productionMathlibBuildAuthorityHash
      !== inspection.productionMathlibBuildAuthority
        .productionMathlibBuildAuthorityHash
    ) {
    throw new Error('dynamic_formal_execution_authority_inspection_not_ready');
  }
  const payload = {
    version: 1,
    kind: 'DynamicFormalExecutionAuthority',
    status: 'dynamic_formal_execution_authority_verified',
    imports: Object.freeze(['Mathlib']),
    projectRoot: inspection.projectRoot,
    projectScopeRoot: inspection.projectScopeRoot,
    probeRelativePath: inspection.probeRelativePath,
    mathlibPackageSourcePath: inspection.mathlibPackageSourcePath,
    productionMathlibReleaseIdentity:
      inspection.productionMathlibReleaseIdentity,
    productionMathlibReleaseIdentityHash:
      inspection.productionMathlibReleaseIdentityHash,
    productionMathlibBuildAuthority:
      inspection.productionMathlibBuildAuthority,
    productionMathlibBuildAuthorityHash:
      inspection.productionMathlibBuildAuthorityHash,
    toolchain: inspection.toolchain,
    formalProjectClosureHash: inspection.formalProjectClosureHash,
    formalProjectManifestHash: inspection.formalProjectManifestHash,
    toolchainRootMerkleHash: inspection.toolchainRootMerkleHash,
    toolchainContentIdentityHash: inspection.toolchainContentIdentityHash,
    formalSandboxRuntimeConfigurationHash:
      inspection.formalSandboxRuntimeConfigurationHash,
    formalSandboxRuntimeImage: inspection.formalSandboxRuntimeImage,
    formalSandboxRuntimeImageDigest: inspection.formalSandboxRuntimeImageDigest,
    formalSandboxProbeReceiptHash: inspection.formalSandboxProbeReceiptHash,
    formalSandboxProbeRuntimeIdentityHash:
      inspection.formalSandboxProbeRuntimeIdentityHash,
    formalSandboxProbeExecutionProcessIdentityHash:
      inspection.formalSandboxProbeExecutionProcessIdentityHash,
    formalSandboxProbeSnapshotSealReceiptHash:
      inspection.formalSandboxProbeSnapshotSealReceiptHash,
    dynamicFormalProjectClosureReadinessHash:
      inspection.dynamicFormalProjectClosureReadinessHash,
  };
  return Object.freeze({
    ...payload,
    dynamicFormalExecutionAuthorityHash: hashRecord(
      'DynamicFormalExecutionAuthority', payload,
    ),
  });
}

export function verifyDynamicFormalExecutionAuthority(authority) {
  if (!authority || JSON.stringify(Object.keys(authority).sort())
      !== JSON.stringify([...DYNAMIC_FORMAL_EXECUTION_AUTHORITY_KEYS].sort())) return false;
  const { dynamicFormalExecutionAuthorityHash, ...payload } = authority;
  return authority.version === 1
    && authority.kind === 'DynamicFormalExecutionAuthority'
    && authority.status === 'dynamic_formal_execution_authority_verified'
    && JSON.stringify(authority.imports) === JSON.stringify(['Mathlib'])
    && authority.toolchain === PRODUCTION_LEAN_TOOLCHAIN
    && verifyProductionMathlibReleaseIdentity(
      authority.productionMathlibReleaseIdentity,
    )
    && authority.productionMathlibReleaseIdentityHash
      === authority.productionMathlibReleaseIdentity
        .productionMathlibReleaseIdentityHash
    && verifyProductionMathlibBuildAuthority(
      authority.productionMathlibBuildAuthority,
    )
    && authority.productionMathlibBuildAuthorityHash
      === authority.productionMathlibBuildAuthority
        .productionMathlibBuildAuthorityHash
    && authority.productionMathlibBuildAuthority.formalProjectClosureHash
      === authority.formalProjectClosureHash
    && authority.productionMathlibBuildAuthority
      .productionMathlibReleaseIdentityHash
      === authority.productionMathlibReleaseIdentityHash
    && SHA256.test(String(dynamicFormalExecutionAuthorityHash || ''))
    && SHA256.test(String(authority.formalProjectClosureHash || ''))
    && SHA256.test(String(authority.formalProjectManifestHash || ''))
    && SHA256.test(String(authority.toolchainRootMerkleHash || ''))
    && SHA256.test(String(authority.toolchainContentIdentityHash || ''))
    && SHA256.test(String(authority.formalSandboxRuntimeConfigurationHash || ''))
    && SHA256.test(String(authority.formalSandboxRuntimeImageDigest || ''))
    && String(authority.formalSandboxRuntimeImage || '').endsWith(
      `@${authority.formalSandboxRuntimeImageDigest}`,
    )
    && SHA256.test(String(authority.formalSandboxProbeReceiptHash || ''))
    && SHA256.test(String(authority.formalSandboxProbeRuntimeIdentityHash || ''))
    && SHA256.test(String(
      authority.formalSandboxProbeExecutionProcessIdentityHash || '',
    ))
    && SHA256.test(String(
      authority.formalSandboxProbeSnapshotSealReceiptHash || '',
    ))
    && hashRecord('DynamicFormalExecutionAuthority', payload)
      === dynamicFormalExecutionAuthorityHash;
}
