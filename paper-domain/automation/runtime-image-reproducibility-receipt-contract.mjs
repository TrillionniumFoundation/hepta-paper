import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  matchesRuntimeImageReproducibilityCanonicalContextTarMetadataPolicy,
  matchesRuntimeImageReproducibilityDockerfileFrontend,
  matchesRuntimeImageReproducibilityCanonicalBuild,
} from './runtime-image-reproducibility-build-policy.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
  AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES,
} from './autonomous-empirical-family-plugin-registry.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const PROFILE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const MAXIMUM_AGE_MS = 24 * 60 * 60 * 1000;
const MAXIMUM_RECEIPT_ISSUANCE_LAG_MS = 60_000;

const SUPPORTED_RUNTIME_IMAGE_PROFILES = new Set(['python', 'pythonGpu', 'r']);

export const REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES = Object.freeze(
  [...new Set([
    ...AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES,
    'pythonGpu',
  ])].sort(),
);

if (REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES.length < 1
  || REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES
    .some((profile) => !SUPPORTED_RUNTIME_IMAGE_PROFILES.has(profile))
  || AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES
    .some((profile) => profile.executionProfile.requiresGpu === true)) {
  throw new Error('runtime_reproducibility_active_plugin_profile_scope_invalid');
}

const ACTIVE_PLUGIN_SCOPE_PAYLOAD = Object.freeze({
  version: 1,
  kind: 'RuntimeImageReproducibilityActivePluginScope',
  empiricalFamilyPluginPackageHash:
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
      .autonomousEmpiricalFamilyPluginPackageHash,
  empiricalFamilyPluginRegistryHash:
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY
      .autonomousEmpiricalFamilyPluginRegistryHash,
  empiricalFamilyPluginStartupInspectionHash:
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
      .autonomousEmpiricalFamilyPluginStartupInspectionHash,
  activeProductionProfileHashes: Object.freeze(
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES
      .map((profile) => profile.autonomousEmpiricalFamilyPluginProfileHash),
  ),
  requiredProfiles: REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  requiredScientificRuntimeProfiles: Object.freeze(['pythonGpu']),
  productionGpuProfileCount: 0,
});

export const RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE = Object.freeze({
  ...ACTIVE_PLUGIN_SCOPE_PAYLOAD,
  runtimeImageReproducibilityActivePluginScopeHash: hashRecord(
    'RuntimeImageReproducibilityActivePluginScope',
    ACTIVE_PLUGIN_SCOPE_PAYLOAD,
  ),
});

function activePluginScopeFields() {
  return Object.freeze({
    empiricalFamilyPluginPackageHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginStartupInspectionHash,
    activeProductionProfileHashes:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.activeProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .runtimeImageReproducibilityActivePluginScopeHash,
  });
}

function activePluginScopeMatches(value) {
  const expected = activePluginScopeFields();
  return expected.empiricalFamilyPluginPackageHash
      === value?.empiricalFamilyPluginPackageHash
    && expected.empiricalFamilyPluginRegistryHash
      === value?.empiricalFamilyPluginRegistryHash
    && expected.empiricalFamilyPluginStartupInspectionHash
      === value?.empiricalFamilyPluginStartupInspectionHash
    && JSON.stringify(expected.activeProductionProfileHashes)
      === JSON.stringify(value?.activeProductionProfileHashes)
    && expected.runtimeImageReproducibilityActivePluginScopeHash
      === value?.runtimeImageReproducibilityActivePluginScopeHash;
}

function canonicalIso(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

export function runtimeImageReproducibilityReceiptExpiresAt({
  issuedAt,
  maximumReceiptAgeMs,
} = {}) {
  const issuedAtMs = canonicalIso(issuedAt);
  if (issuedAtMs === null || !Number.isSafeInteger(maximumReceiptAgeMs)
    || maximumReceiptAgeMs < 60_000 || maximumReceiptAgeMs > MAXIMUM_AGE_MS) {
    throw new Error('runtime_reproducibility_receipt_lifetime_invalid');
  }
  return new Date(issuedAtMs + maximumReceiptAgeMs).toISOString();
}

function canonical(values) {
  return Object.freeze([...new Set((values || []).filter(Boolean).map(String))].sort());
}

function canonicalOrganization(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sameHashRecord(kind, value, hashField) {
  if (!SHA256.test(String(value?.[hashField] || ''))) return false;
  const { [hashField]: _hash, ...payload } = value;
  return hashRecord(kind, payload) === value[hashField];
}

function contextEntryValid(entry) {
  if (entry?.type === 'directory') {
    return exactKeys(entry, ['mode', 'path', 'type']) && entry.path.endsWith('/')
      && Number.isSafeInteger(entry.mode);
  }
  if (entry?.type === 'file') {
    return exactKeys(entry, ['bytes', 'contentHash', 'mode', 'path', 'type'])
      && Number.isSafeInteger(entry.mode) && Number.isSafeInteger(entry.bytes)
      && entry.bytes >= 0 && SHA256.test(String(entry.contentHash || ''));
  }
  return entry?.type === 'symlink'
    && exactKeys(entry, ['mode', 'path', 'target', 'type'])
    && Number.isSafeInteger(entry.mode) && typeof entry.target === 'string' && entry.target.length > 0;
}

function canonicalOciExporterValid(value) {
  return exactKeys(value, ['provenance', 'rewriteTimestamp', 'sbom', 'type'])
    && value.type === 'oci' && value.rewriteTimestamp === true
    && value.provenance === false && value.sbom === false;
}

function canonicalContextTarMetadataPolicyValid(value, sourceDateEpoch) {
  return matchesRuntimeImageReproducibilityCanonicalContextTarMetadataPolicy(value)
    && value.mtime === sourceDateEpoch;
}

function inputClosureValid(input) {
  if (!exactKeys(input, [
    'baseImageReferences', 'buildArgs', 'cachePolicy', 'contextManifest',
    'contextManifestHash', 'contextPath', 'contextTarMetadataPolicy',
    'contextTarMetadataPolicyHash', 'definitionManifestHash', 'dockerfile',
    'dockerfileContentHash', 'dockerfileFrontend', 'dockerfileFrontendDigest', 'image', 'kind',
    'networkPolicy',
    'ociExporter', 'outputFormat', 'platform', 'profile', 'registeredImageDigest',
    'reproducibleOciMetadataRequired', 'runtimeImageCanonicalBuildInputClosureHash',
    'sourceDateEpoch', 'version',
  ]) || input.version !== 1 || input.kind !== 'RuntimeImageCanonicalBuildInputClosure'
    || !PROFILE.test(String(input.profile || '')) || !String(input.image || '').trim()
    || !SHA256.test(String(input.registeredImageDigest || ''))
    || !SHA256.test(String(input.definitionManifestHash || ''))
    || !SHA256.test(String(input.contextManifestHash || ''))
    || !SHA256.test(String(input.dockerfileContentHash || ''))
    || !SHA256.test(String(input.dockerfileFrontendDigest || ''))
    || !String(input.dockerfileFrontend || '').endsWith(`@${input.dockerfileFrontendDigest}`)
    || !matchesRuntimeImageReproducibilityDockerfileFrontend(input.dockerfileFrontend)
    || !Array.isArray(input.contextManifest) || !input.contextManifest.length
    || input.contextManifest.some((entry) => !contextEntryValid(entry))
    || JSON.stringify(input.contextManifest.map((entry) => entry.path))
      !== JSON.stringify([...input.contextManifest].map((entry) => entry.path).sort())
    || hashRecord('RuntimeImageCanonicalDockerContextManifest', input.contextManifest)
      !== input.contextManifestHash
    || !SHA256.test(String(input.contextTarMetadataPolicyHash || ''))
    || !canonicalContextTarMetadataPolicyValid(
      input.contextTarMetadataPolicy,
      input.sourceDateEpoch,
    )
    || hashRecord(
      'RuntimeImageCanonicalContextTarMetadataPolicy',
      input.contextTarMetadataPolicy,
    ) !== input.contextTarMetadataPolicyHash
    || !Array.isArray(input.baseImageReferences) || !input.baseImageReferences.length
    || input.baseImageReferences.some((value) => !/@sha256:[0-9a-f]{64}$/i.test(value))
    || !matchesRuntimeImageReproducibilityCanonicalBuild(input)
    || input.cachePolicy !== 'cache-disabled' || input.outputFormat !== 'oci-layout-v1'
    || !canonicalOciExporterValid(input.ociExporter)
    || input.reproducibleOciMetadataRequired !== true
    || !sameHashRecord(
      'RuntimeImageCanonicalBuildInputClosure',
      input,
      'runtimeImageCanonicalBuildInputClosureHash',
    )) return false;
  return true;
}

export function runtimeImageReproducibilityCodeProvenanceHash(codeProvenance) {
  if (!codeProvenance || typeof codeProvenance !== 'object') return null;
  return hashRecord('RuntimeImageReproducibilityCodeProvenance', codeProvenance);
}

export function runtimeImageReproducibilityReleaseIdentityHash(codeProvenance) {
  if (!codeProvenance || typeof codeProvenance !== 'object') return null;
  return hashRecord('RuntimeImageReproducibilityReleaseIdentity', {
    packageVersion: codeProvenance.packageVersion || null,
    commit: codeProvenance.commit || null,
    commitTree: codeProvenance.commitTree || null,
    treeDirty: codeProvenance.treeDirty === true,
    repositoryContentHash: codeProvenance.repositoryContentHash || null,
    worktreeStateHash: codeProvenance.worktreeStateHash || null,
  });
}

export function buildRuntimeImageReproducibilityRequest({
  nonce,
  requestedAt,
  expiresAt,
  configurationIdentityHash,
  trustIdentityHash,
  codeProvenanceHash,
  releaseIdentityHash,
  inputs,
  empiricalFamilyPluginPackageHash = RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
    .empiricalFamilyPluginPackageHash,
  empiricalFamilyPluginRegistryHash = RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
    .empiricalFamilyPluginRegistryHash,
  empiricalFamilyPluginStartupInspectionHash =
    RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
      .empiricalFamilyPluginStartupInspectionHash,
  activeProductionProfileHashes = RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
    .activeProductionProfileHashes,
  runtimeImageReproducibilityActivePluginScopeHash =
    RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
      .runtimeImageReproducibilityActivePluginScopeHash,
} = {}) {
  const profiles = (inputs || []).map((input) => input.profile);
  if (!SAFE_ID.test(String(nonce || '')) || canonicalIso(requestedAt) === null
    || canonicalIso(expiresAt) === null || Date.parse(expiresAt) <= Date.parse(requestedAt)
    || !SHA256.test(String(configurationIdentityHash || ''))
    || !SHA256.test(String(trustIdentityHash || ''))
    || !SHA256.test(String(codeProvenanceHash || ''))
    || !SHA256.test(String(releaseIdentityHash || ''))
    || JSON.stringify(profiles) !== JSON.stringify(REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES)
    || !activePluginScopeMatches({
      empiricalFamilyPluginPackageHash,
      empiricalFamilyPluginRegistryHash,
      empiricalFamilyPluginStartupInspectionHash,
      activeProductionProfileHashes,
      runtimeImageReproducibilityActivePluginScopeHash,
    })
    || inputs.some((input) => !inputClosureValid(input))) {
    throw new Error('runtime_reproducibility_request_invalid');
  }
  const payload = Object.freeze({
    version: 2,
    kind: 'RuntimeImageReproducibilityVerificationRequest',
    nonce: String(nonce),
    requestedAt,
    expiresAt,
    configurationIdentityHash,
    trustIdentityHash,
    codeProvenanceHash,
    releaseIdentityHash,
    requiredProfiles: REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
    empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash,
    activeProductionProfileHashes: Object.freeze([...activeProductionProfileHashes]),
    runtimeImageReproducibilityActivePluginScopeHash,
    inputs: Object.freeze([...inputs]),
  });
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('RuntimeImageReproducibilityVerificationRequest', payload),
  });
}

export function verifyRuntimeImageReproducibilityRequest(request) {
  if (!exactKeys(request, [
    'activeProductionProfileHashes', 'codeProvenanceHash', 'configurationIdentityHash',
    'empiricalFamilyPluginPackageHash', 'empiricalFamilyPluginRegistryHash',
    'empiricalFamilyPluginStartupInspectionHash', 'expiresAt', 'inputs', 'kind',
    'nonce', 'releaseIdentityHash', 'requestHash', 'requestedAt', 'requiredProfiles',
    'runtimeImageReproducibilityActivePluginScopeHash', 'trustIdentityHash', 'version',
  ])) return false;
  try {
    const expected = buildRuntimeImageReproducibilityRequest(request);
    return hashRecord('RuntimeImageReproducibilityRequestEquality', request)
      === hashRecord('RuntimeImageReproducibilityRequestEquality', expected);
  } catch { return false; }
}

function ociIdentityValid(value) {
  if (!exactKeys(value, [
    'allBlobDigests', 'configDigest', 'indexDigest', 'layerBlobDigests',
    'manifestDigest', 'ociDigestSetHash',
  ])) return false;
  const fields = [value.indexDigest, value.manifestDigest, value.configDigest];
  if (!fields.every((item) => SHA256.test(String(item || '')))
    || !Array.isArray(value.layerBlobDigests) || !value.layerBlobDigests.length
    || value.layerBlobDigests.some((item) => !SHA256.test(String(item || '')))
    || !Array.isArray(value.allBlobDigests)
    || JSON.stringify(value.allBlobDigests)
      !== JSON.stringify(canonical([value.manifestDigest, value.configDigest, ...value.layerBlobDigests]))) {
    return false;
  }
  return value.ociDigestSetHash === hashRecord('RuntimeImageOciDigestSet', {
    indexDigest: value.indexDigest,
    manifestDigest: value.manifestDigest,
    configDigest: value.configDigest,
    layerBlobDigests: value.layerBlobDigests,
    allBlobDigests: value.allBlobDigests,
  });
}

function profileResultValid(result, input, backendIdentityHash) {
  if (!exactKeys(result, [
    'backendIdentityHash', 'buildExecutionClosureHash', 'cacheDisabled', 'inputClosureHash',
    'contextTarMetadataPolicy', 'contextTarMetadataPolicyApplied',
    'contextTarMetadataPolicyHash', 'dockerfileFrontend', 'dockerfileFrontendDigest',
    'oci', 'ociExporter', 'platform', 'profile',
    'registeredImage', 'registeredImageDigest', 'sourceDateEpoch',
    'sourceDateEpochAppliedToBuildkit',
  ]) || result.profile !== input.profile || result.registeredImage !== input.image
    || result.registeredImageDigest !== input.registeredImageDigest
    || result.inputClosureHash !== input.runtimeImageCanonicalBuildInputClosureHash
    || result.dockerfileFrontend !== input.dockerfileFrontend
    || result.dockerfileFrontendDigest !== input.dockerfileFrontendDigest
    || result.contextTarMetadataPolicyApplied !== true
    || result.contextTarMetadataPolicyHash !== input.contextTarMetadataPolicyHash
    || !canonicalContextTarMetadataPolicyValid(
      result.contextTarMetadataPolicy,
      result.sourceDateEpoch,
    )
    || hashRecord(
      'RuntimeImageCanonicalContextTarMetadataPolicyEquality',
      result.contextTarMetadataPolicy,
    ) !== hashRecord(
      'RuntimeImageCanonicalContextTarMetadataPolicyEquality',
      input.contextTarMetadataPolicy,
    )
    || result.platform !== input.platform || result.sourceDateEpoch !== input.sourceDateEpoch
    || result.cacheDisabled !== true || result.sourceDateEpochAppliedToBuildkit !== true
    || !canonicalOciExporterValid(result.ociExporter)
    || hashRecord('RuntimeImageCanonicalOciExporterEquality', result.ociExporter)
      !== hashRecord('RuntimeImageCanonicalOciExporterEquality', input.ociExporter)
    || result.backendIdentityHash !== backendIdentityHash
    || !ociIdentityValid(result.oci) || result.oci.manifestDigest !== input.registeredImageDigest) return false;
  return result.buildExecutionClosureHash === hashRecord(
    'RuntimeImageExternalBuildExecutionClosure',
    { inputClosureHash: result.inputClosureHash, backendIdentityHash },
  );
}

function signerTupleMatches(observed, expected) {
  return exactKeys(observed, [
    'algorithm', 'effectiveFrom', 'expiresAt', 'keyId', 'keyVersion', 'organization',
    'revokedAt', 'role', 'status', 'subjectId',
  ]) && ['keyId', 'keyVersion', 'subjectId', 'organization', 'role', 'algorithm',
    'status', 'effectiveFrom', 'expiresAt', 'revokedAt']
    .every((field) => (observed?.[field] ?? null) === (expected?.[field] ?? null));
}

export function runtimeImageReproducibilityResponseSigningPayloadHash(response) {
  if (!response || typeof response !== 'object') return null;
  const { signature: _signature, responseHash: _hash, ...payload } = response;
  return hashRecord('RuntimeImageReproducibilityVerifierResponseSigningPayload', payload);
}

export function verifyRuntimeImageReproducibilityVerifierResponse(response, {
  request,
  verifier,
  verifySignature,
} = {}) {
  if (!verifyRuntimeImageReproducibilityRequest(request)
    || !exactKeys(response, [
      'backend', 'backendIdentityHash', 'completedAt', 'kind', 'nonce', 'profileResults',
      'requestHash', 'responseHash', 'signature', 'signer', 'startedAt', 'status', 'verifierId',
      'verifierServiceIdentityHash', 'version',
    ]) || response.version !== 1 || response.kind !== 'RuntimeImageReproducibilityVerifierResponse'
    || response.status !== 'runtime_image_oci_bitwise_rebuild_attested'
    || response.verifierId !== verifier?.serviceId
    || response.verifierServiceIdentityHash !== verifier?.serviceIdentityHash
    || response.requestHash !== request.requestHash || response.nonce !== request.nonce
    || response.backendIdentityHash !== verifier?.backend?.backendIdentityHash
    || !sameHashRecord('RuntimeImageReproducibilityBackendIdentity', response.backend, 'backendIdentityHash')
    || hashRecord('RuntimeImageReproducibilityBackendIdentityEquality', response.backend)
      !== hashRecord('RuntimeImageReproducibilityBackendIdentityEquality', verifier?.backend)
    || !signerTupleMatches(response.signer, verifier?.signer)
    || !Array.isArray(response.profileResults)
    || response.profileResults.length !== request.inputs.length
    || response.profileResults.some((result, index) => !profileResultValid(
      result,
      request.inputs[index],
      response.backendIdentityHash,
    ))) return false;
  const startedAt = canonicalIso(response.startedAt);
  const completedAt = canonicalIso(response.completedAt);
  const requestedAt = canonicalIso(request.requestedAt);
  const requestExpiresAt = canonicalIso(request.expiresAt);
  const keyEffectiveFrom = canonicalIso(response.signer.effectiveFrom);
  const keyExpiresAt = canonicalIso(response.signer.expiresAt);
  if ([startedAt, completedAt, requestedAt, requestExpiresAt, keyEffectiveFrom, keyExpiresAt]
    .some((value) => value === null)
    || startedAt < requestedAt || completedAt < startedAt || completedAt >= requestExpiresAt
    || completedAt < keyEffectiveFrom || completedAt >= keyExpiresAt
    || response.signer.algorithm !== 'ed25519' || response.signer.revokedAt !== null) return false;
  const { signature, responseHash, ...payload } = response;
  return responseHash === hashRecord('RuntimeImageReproducibilityVerifierResponse', payload)
    && typeof signature === 'string' && signature.length > 0
    && typeof verifySignature === 'function'
    && verifySignature({
      signingPayloadHash: runtimeImageReproducibilityResponseSigningPayloadHash(response),
      signature,
      signer: response.signer,
      verifier,
    }) === true;
}

function externalResponsesAgree(responses, request) {
  if (responses.length !== 2
    || responses[0].verifierId === responses[1].verifierId
    || responses[0].verifierServiceIdentityHash === responses[1].verifierServiceIdentityHash
    || responses[0].backendIdentityHash === responses[1].backendIdentityHash
    || responses[0].signer.subjectId === responses[1].signer.subjectId
    || canonicalOrganization(responses[0].signer.organization)
      === canonicalOrganization(responses[1].signer.organization)) return false;
  return request.inputs.every((_, index) => {
    const left = responses[0].profileResults[index];
    const right = responses[1].profileResults[index];
    return hashRecord('RuntimeImageOciBitwiseIdentityEquality', left.oci)
      === hashRecord('RuntimeImageOciBitwiseIdentityEquality', right.oci);
  });
}

export function buildRuntimeImageReproducibilityReceipt({
  request,
  responses,
  issuedAt,
  expiresAt,
} = {}) {
  if (!verifyRuntimeImageReproducibilityRequest(request) || !Array.isArray(responses)
    || responses.length !== 2 || canonicalIso(issuedAt) === null || canonicalIso(expiresAt) === null) {
    throw new Error('runtime_reproducibility_receipt_input_invalid');
  }
  const payload = Object.freeze({
    version: 2,
    kind: 'RuntimeImageReproducibilityReceipt',
    status: 'runtime_image_reproducibility_external_attestations_recorded',
    request,
    contextTarMetadataPolicyHashes: Object.freeze(Object.fromEntries(
      request.inputs.map((input) => [input.profile, input.contextTarMetadataPolicyHash]),
    )),
    responseHashes: Object.freeze(responses.map((response) => response.responseHash)),
    responses: Object.freeze([...responses]),
    issuedAt,
    expiresAt,
    externalActionPerformed: true,
    privateSigningKeyLoadedByController: false,
    assurance: 'two-independent-ed25519-attested-oci-layout-rebuilds-v1',
  });
  return Object.freeze({
    ...payload,
    runtimeImageReproducibilityReceiptHash: hashRecord(
      'RuntimeImageReproducibilityReceipt',
      payload,
    ),
  });
}

export function verifyRuntimeImageReproducibilityReceipt(receipt, {
  now,
  currentCodeProvenanceHash,
  currentReleaseIdentityHash,
  currentInputs,
  configuration,
  profilePolicies,
  verifySignature,
} = {}) {
  const blockers = [];
  if (!exactKeys(receipt, [
    'assurance', 'contextTarMetadataPolicyHashes', 'expiresAt', 'externalActionPerformed',
    'issuedAt', 'kind',
    'privateSigningKeyLoadedByController', 'request', 'responseHashes', 'responses',
    'runtimeImageReproducibilityReceiptHash', 'status', 'version',
  ]) || receipt?.version !== 2 || receipt?.kind !== 'RuntimeImageReproducibilityReceipt'
    || receipt?.status !== 'runtime_image_reproducibility_external_attestations_recorded'
    || receipt?.externalActionPerformed !== true
    || receipt?.privateSigningKeyLoadedByController !== false
    || receipt?.assurance !== 'two-independent-ed25519-attested-oci-layout-rebuilds-v1'
    || hashRecord(
      'RuntimeImageCanonicalContextTarMetadataPolicyHashSet',
      receipt?.contextTarMetadataPolicyHashes,
    ) !== hashRecord(
      'RuntimeImageCanonicalContextTarMetadataPolicyHashSet',
      Object.fromEntries((receipt?.request?.inputs || []).map((input) => [
        input.profile,
        input.contextTarMetadataPolicyHash,
      ])),
    )
    || !sameHashRecord(
      'RuntimeImageReproducibilityReceipt',
      receipt,
      'runtimeImageReproducibilityReceiptHash',
    )) blockers.push('runtime_reproducibility_receipt_shape_or_hash_invalid');
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const issuedAt = canonicalIso(receipt?.issuedAt);
  const expiresAt = canonicalIso(receipt?.expiresAt);
  const configuredMaximumAgeMs = Number(configuration?.maximumReceiptAgeMs);
  const latestResponseCompletion = Math.max(...(Array.isArray(receipt?.responses)
    ? receipt.responses.map((response) => canonicalIso(response?.completedAt) ?? Infinity)
    : [Infinity]));
  const requestExpiresAt = canonicalIso(receipt?.request?.expiresAt);
  if (!Number.isFinite(nowMs) || issuedAt === null || expiresAt === null || expiresAt <= issuedAt
    || !Number.isSafeInteger(configuredMaximumAgeMs)
    || configuredMaximumAgeMs < 60_000 || configuredMaximumAgeMs > MAXIMUM_AGE_MS
    || expiresAt - issuedAt !== configuredMaximumAgeMs
    || !Number.isFinite(latestResponseCompletion) || issuedAt < latestResponseCompletion
    || issuedAt - latestResponseCompletion > MAXIMUM_RECEIPT_ISSUANCE_LAG_MS
    || requestExpiresAt === null || issuedAt >= requestExpiresAt
    || nowMs < issuedAt || nowMs >= expiresAt) {
    blockers.push('runtime_reproducibility_receipt_outside_time_window');
  }
  const request = receipt?.request;
  if (!verifyRuntimeImageReproducibilityRequest(request)) {
    blockers.push('runtime_reproducibility_request_invalid');
  } else {
    if (request.configurationIdentityHash !== configuration?.configurationIdentityHash
      || request.trustIdentityHash !== configuration?.trustIdentityHash) {
      blockers.push('runtime_reproducibility_configuration_or_trust_drift');
    }
    if (request.codeProvenanceHash !== currentCodeProvenanceHash
      || request.releaseIdentityHash !== currentReleaseIdentityHash) {
      blockers.push('runtime_reproducibility_code_or_release_drift');
    }
    if (!Array.isArray(currentInputs) || currentInputs.length !== request.inputs.length
      || hashRecord('RuntimeImageReproducibilityCurrentInputEquality', currentInputs)
        !== hashRecord('RuntimeImageReproducibilityCurrentInputEquality', request.inputs)) {
      blockers.push('runtime_reproducibility_build_input_closure_drift');
    }
    if (!activePluginScopeMatches(request)
      || JSON.stringify(request.requiredProfiles)
        !== JSON.stringify(REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES)) {
      blockers.push('runtime_reproducibility_active_plugin_scope_drift');
    }
  }
  const responses = Array.isArray(receipt?.responses) ? receipt.responses : [];
  if (responses.length !== 2 || !Array.isArray(receipt?.responseHashes)
    || JSON.stringify(receipt.responseHashes) !== JSON.stringify(responses.map((item) => item.responseHash))) {
    blockers.push('runtime_reproducibility_external_response_set_invalid');
  } else if (!configuration?.verifiers || responses.some((response, index) => (
    !verifyRuntimeImageReproducibilityVerifierResponse(response, {
      request,
      verifier: configuration.verifiers[index],
      verifySignature,
    })
  ))) {
    blockers.push('runtime_reproducibility_external_signature_or_binding_invalid');
  } else if (!externalResponsesAgree(responses, request)) {
    blockers.push('runtime_reproducibility_independent_oci_outputs_mismatch');
  }
  for (const profile of REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES) {
    const policy = profilePolicies?.[profile];
    if (policy?.dependencyArtifactsContentHashed !== true
      || policy?.sourceArchivesContentHashed !== true) {
      blockers.push(`runtime_reproducibility_source_content_hashes_incomplete:${profile}`);
    }
  }
  const uniqueBlockers = Object.freeze(canonical(blockers));
  return Object.freeze({
    version: 2,
    kind: 'RuntimeImageReproducibilityReceiptInspection',
    status: uniqueBlockers.length
      ? 'runtime_image_reproducibility_blocked'
      : 'runtime_image_reproducibility_verified',
    ready: uniqueBlockers.length === 0,
    receiptAccepted: uniqueBlockers.length === 0,
    receiptHash: uniqueBlockers.length ? null : receipt.runtimeImageReproducibilityReceiptHash,
    issuedAt: uniqueBlockers.length ? null : receipt.issuedAt,
    expiresAt: uniqueBlockers.length ? null : receipt.expiresAt,
    remainingValidityMs: uniqueBlockers.length ? 0 : expiresAt - nowMs,
    requiredProfiles: REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
    empiricalFamilyPluginPackageHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginStartupInspectionHash,
    activeProductionProfileHashes:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.activeProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .runtimeImageReproducibilityActivePluginScopeHash,
    definitionManifestHashes: uniqueBlockers.length ? null : Object.freeze(Object.fromEntries(
      request.inputs.map((input) => [input.profile, input.definitionManifestHash]),
    )),
    inputClosureHashes: uniqueBlockers.length ? null : Object.freeze(Object.fromEntries(
      request.inputs.map((input) => [
        input.profile,
        input.runtimeImageCanonicalBuildInputClosureHash,
      ]),
    )),
    registeredImageDigests: uniqueBlockers.length ? null : Object.freeze(Object.fromEntries(
      request.inputs.map((input) => [input.profile, input.registeredImageDigest]),
    )),
    privateSigningKeyLoadedByController: false,
    twoIndependentExternalVerifiersRequired: true,
    ociIndexManifestConfigAndLayerBlobDigestsCompared: true,
    canonicalContextTarMetadataPolicyRequired: true,
    canonicalContextTarMetadataAttested: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
  });
}

export const RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_AGE_MS = MAXIMUM_AGE_MS;
export const RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_ISSUANCE_LAG_MS =
  MAXIMUM_RECEIPT_ISSUANCE_LAG_MS;
