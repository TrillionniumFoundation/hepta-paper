import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const SAFE_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,512}$/;

function relativeBasename(value, suffix = '') {
  const parts = String(value || '').split('/');
  const name = parts[parts.length - 1] || '';
  return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function commandPayload(mainTex) {
  return Object.freeze({
    version: 1,
    kind: 'IndependentPdfRebuildCommand',
    executable: 'latexmk',
    arguments: Object.freeze([
      '-gg',
      '-pdf',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-outdir=/output',
      mainTex,
    ]),
  });
}

export function buildIndependentPdfRebuildCommand(mainTex) {
  const normalized = String(mainTex || '').replace(/\\/g, '/');
  if (!SAFE_RELATIVE.test(normalized) || normalized.startsWith('-') || !/\.tex$/i.test(normalized)) {
    throw new Error('independent_pdf_rebuild_main_tex_invalid');
  }
  const payload = commandPayload(normalized);
  return Object.freeze({
    ...payload,
    independentPdfRebuildCommandHash: hashRecord('IndependentPdfRebuildCommand', payload),
  });
}

function toolIdentityPayload(value) {
  return {
    version: 1,
    kind: 'IndependentPdfRebuildToolIdentity',
    runnerId: String(value?.runnerId || ''),
    runtimeIdentityHash: value?.runtimeIdentityHash || null,
    runtimeType: value?.runtimeType || null,
    executionClass: value?.executionClass || null,
    latexmkExecutableHash: value?.latexmkExecutableHash || null,
    runtimeExecutableSnapshotHash: value?.runtimeExecutableSnapshotHash || null,
    containerImageDigest: value?.containerImageDigest || null,
    identityScope: 'latexmk-entrypoint-and-sandbox-runtime-identity-v1',
    transitiveTexToolchainClosureVerified: false,
  };
}

export function buildIndependentPdfRebuildToolIdentity(value = {}) {
  const payload = toolIdentityPayload(value);
  if (!payload.runnerId || !SHA256.test(String(payload.runtimeIdentityHash || ''))
    || !SHA256.test(String(payload.latexmkExecutableHash || payload.runtimeExecutableSnapshotHash || ''))
    || (payload.containerImageDigest && !SHA256.test(String(payload.containerImageDigest)))) {
    throw new Error('independent_pdf_rebuild_tool_identity_invalid');
  }
  return Object.freeze({
    ...payload,
    independentPdfRebuildToolIdentityHash: hashRecord('IndependentPdfRebuildToolIdentity', payload),
  });
}

export function buildIndependentPdfRebuildVerificationReceipt({
  paperId,
  sourcePackageContractHash,
  sourceTreeManifestHash,
  sourceMerkleHash,
  sourceWorkspaceManifestHash,
  materializedSourceWorkspaceManifestHash,
  mainTex,
  command,
  toolIdentity,
  workerReceiptHash,
  executionProcessIdentityHash,
  limits,
  rebuiltPdf,
  authoritativePdfHash,
  createdAt,
} = {}) {
  const payload = {
    version: 1,
    kind: 'IndependentPdfRebuildVerificationReceipt',
    status: 'independent_pdf_rebuild_verified',
    paperId: String(paperId || ''),
    sourcePackageContractHash,
    sourceTreeManifestHash,
    sourceMerkleHash,
    sourceWorkspaceManifestHash,
    materializedSourceWorkspaceManifestHash,
    mainTex: String(mainTex || ''),
    command,
    toolIdentity,
    workerReceiptHash,
    executionProcessIdentityHash,
    exitCode: 0,
    limits: Object.freeze({
      timeoutMs: Number(limits?.timeoutMs),
      memoryBytes: Number(limits?.memoryBytes),
      cpuSeconds: Number(limits?.cpuSeconds),
      maximumPids: Number(limits?.maximumPids),
      maximumOutputBytes: Number(limits?.maximumOutputBytes),
    }),
    rebuiltPdf: Object.freeze({
      path: String(rebuiltPdf?.path || ''),
      hash: rebuiltPdf?.hash || null,
      bytes: Number(rebuiltPdf?.bytes),
    }),
    authoritativePdfHash,
    comparisonPolicy: 'record-both-content-hashes-no-bitwise-equality-requirement-v1',
    bitwiseEqualityAssessed: false,
    bitwiseEqualityClaimed: false,
    rebuildOperation: 'forced-latexmk-source-compilation-in-isolated-workspace-v1',
    finalCompileArtifactUsedAsRebuildOutputSource: false,
    independentProcessExecutionVerified: true,
    sourceReadOnlyVerified: true,
    networkIsolationVerified: true,
    separateOutputRootVerified: true,
    resourceLimitsVerified: true,
    transitiveTexToolchainClosureVerified: false,
    unverifiedClaims: Object.freeze([
      'bitwise_pdf_equality',
      'transitive_tex_toolchain_closure',
    ]),
    createdAt: new Date(createdAt).toISOString(),
    blockers: Object.freeze([]),
    externalActionPerformed: false,
  };
  const verification = verifyIndependentPdfRebuildVerificationReceipt({
    ...payload,
    independentPdfRebuildVerificationReceiptHash: hashRecord('IndependentPdfRebuildVerificationReceipt', payload),
  });
  if (!verification.valid) throw new Error(`independent_pdf_rebuild_receipt_invalid:${verification.blockers.join(',')}`);
  return verification.receipt;
}

export function verifyIndependentPdfRebuildVerificationReceipt(receipt, expected = {}) {
  const blockers = [];
  const command = receipt?.command;
  const toolIdentity = receipt?.toolIdentity;
  const expectedCommand = (() => {
    try { return buildIndependentPdfRebuildCommand(receipt?.mainTex); } catch { return null; }
  })();
  const toolPayload = toolIdentityPayload(toolIdentity);
  if (receipt?.version !== 1 || receipt?.kind !== 'IndependentPdfRebuildVerificationReceipt'
    || receipt?.status !== 'independent_pdf_rebuild_verified') blockers.push('independent_pdf_rebuild_receipt_shape_invalid');
  if (!receipt?.paperId || !SHA256.test(String(receipt?.sourcePackageContractHash || ''))
    || !SHA256.test(String(receipt?.sourceTreeManifestHash || ''))
    || !SHA256.test(String(receipt?.sourceMerkleHash || ''))
    || !SHA256.test(String(receipt?.sourceWorkspaceManifestHash || ''))
    || !SHA256.test(String(receipt?.materializedSourceWorkspaceManifestHash || ''))) {
    blockers.push('independent_pdf_rebuild_source_binding_invalid');
  }
  if (!expectedCommand || command?.independentPdfRebuildCommandHash !== expectedCommand.independentPdfRebuildCommandHash
    || JSON.stringify(command) !== JSON.stringify(expectedCommand)) blockers.push('independent_pdf_rebuild_command_invalid');
  if (!toolIdentity || toolIdentity.independentPdfRebuildToolIdentityHash
      !== hashRecord('IndependentPdfRebuildToolIdentity', toolPayload)
    || toolIdentity.identityScope !== 'latexmk-entrypoint-and-sandbox-runtime-identity-v1'
    || toolIdentity.transitiveTexToolchainClosureVerified !== false
    || !toolIdentity.runnerId || !SHA256.test(String(toolIdentity.runtimeIdentityHash || ''))
    || !SHA256.test(String(toolIdentity.latexmkExecutableHash || toolIdentity.runtimeExecutableSnapshotHash || ''))
    || (toolIdentity.containerImageDigest && !SHA256.test(String(toolIdentity.containerImageDigest)))) {
    blockers.push('independent_pdf_rebuild_tool_identity_invalid');
  }
  if (!SHA256.test(String(receipt?.workerReceiptHash || ''))
    || !SHA256.test(String(receipt?.executionProcessIdentityHash || ''))
    || receipt?.exitCode !== 0) blockers.push('independent_pdf_rebuild_execution_receipt_invalid');
  const limits = receipt?.limits || {};
  if (![limits.timeoutMs, limits.memoryBytes, limits.cpuSeconds, limits.maximumPids, limits.maximumOutputBytes]
    .every((value) => Number.isSafeInteger(value) && value > 0)) blockers.push('independent_pdf_rebuild_limits_invalid');
  const rebuilt = receipt?.rebuiltPdf;
  if (!SAFE_RELATIVE.test(String(rebuilt?.path || '')) || relativeBasename(rebuilt?.path)
      !== `${relativeBasename(receipt?.mainTex, '.tex')}.pdf`
    || !SHA256.test(String(rebuilt?.hash || '')) || !Number.isSafeInteger(rebuilt?.bytes) || rebuilt.bytes < 5) {
    blockers.push('independent_pdf_rebuild_pdf_invalid');
  }
  if (!SHA256.test(String(receipt?.authoritativePdfHash || ''))
    || receipt?.comparisonPolicy !== 'record-both-content-hashes-no-bitwise-equality-requirement-v1'
    || receipt?.bitwiseEqualityAssessed !== false || receipt?.bitwiseEqualityClaimed !== false
    || receipt?.rebuildOperation !== 'forced-latexmk-source-compilation-in-isolated-workspace-v1'
    || receipt?.finalCompileArtifactUsedAsRebuildOutputSource !== false
    || receipt?.independentProcessExecutionVerified !== true
    || receipt?.sourceReadOnlyVerified !== true || receipt?.networkIsolationVerified !== true
    || receipt?.separateOutputRootVerified !== true || receipt?.resourceLimitsVerified !== true
    || receipt?.transitiveTexToolchainClosureVerified !== false
    || JSON.stringify(receipt?.unverifiedClaims) !== JSON.stringify(['bitwise_pdf_equality', 'transitive_tex_toolchain_closure'])
    || receipt?.externalActionPerformed !== false || (receipt?.blockers || []).length !== 0
    || !Number.isFinite(Date.parse(receipt?.createdAt))) blockers.push('independent_pdf_rebuild_assurance_scope_invalid');
  const { independentPdfRebuildVerificationReceiptHash: claimedHash, ...payload } = receipt || {};
  if (!claimedHash || hashRecord('IndependentPdfRebuildVerificationReceipt', payload) !== claimedHash) {
    blockers.push('independent_pdf_rebuild_receipt_hash_invalid');
  }
  for (const [field, blocker] of [
    ['paperId', 'independent_pdf_rebuild_paper_mismatch'],
    ['sourcePackageContractHash', 'independent_pdf_rebuild_source_contract_mismatch'],
    ['sourceTreeManifestHash', 'independent_pdf_rebuild_source_manifest_mismatch'],
    ['sourceMerkleHash', 'independent_pdf_rebuild_source_merkle_mismatch'],
    ['sourceWorkspaceManifestHash', 'independent_pdf_rebuild_source_workspace_manifest_mismatch'],
    ['mainTex', 'independent_pdf_rebuild_main_tex_mismatch'],
    ['authoritativePdfHash', 'independent_pdf_rebuild_authoritative_pdf_mismatch'],
  ]) if (expected[field] && receipt?.[field] !== expected[field]) blockers.push(blocker);
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    receipt: blockers.length ? null : Object.freeze(receipt),
  });
}
