import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/;

function canonical(values) {
  return Object.freeze([...new Set((values || []).map(String).filter(Boolean))].sort());
}

function canonicalBuildResult(value = {}) {
  return Object.freeze({
    invocationId: String(value.invocationId || ''),
    isolatedBuildRootIdentityHash: String(value.isolatedBuildRootIdentityHash || '').toLowerCase(),
    buildInputClosureHash: String(value.buildInputClosureHash || '').toLowerCase(),
    cacheDisabled: value.cacheDisabled === true,
    imageDigest: String(value.imageDigest || '').toLowerCase(),
    rootfsChainHash: String(value.rootfsChainHash || '').toLowerCase(),
  });
}

export function buildRuntimeImageBitwiseRebuildEvidence({
  image,
  definitionManifestHash,
  firstBuild,
  secondBuild,
  observedAt,
} = {}) {
  const builds = Object.freeze([
    canonicalBuildResult(firstBuild),
    canonicalBuildResult(secondBuild),
  ]);
  const blockers = [];
  const normalizedDefinitionHash = String(definitionManifestHash || '').toLowerCase();
  const normalizedObservedAt = String(observedAt || '');
  if (!String(image || '').trim()) blockers.push('runtime_rebuild_image_required');
  if (!SHA256.test(normalizedDefinitionHash)) blockers.push('runtime_rebuild_definition_manifest_invalid');
  if (!Number.isFinite(Date.parse(normalizedObservedAt))
    || new Date(normalizedObservedAt).toISOString() !== normalizedObservedAt) {
    blockers.push('runtime_rebuild_observed_at_invalid');
  }
  for (const [index, build] of builds.entries()) {
    if (!SAFE_ID.test(build.invocationId)) blockers.push(`runtime_rebuild_invocation_id_invalid:${index + 1}`);
    if (![build.isolatedBuildRootIdentityHash, build.buildInputClosureHash,
      build.imageDigest, build.rootfsChainHash].every((value) => SHA256.test(value))) {
      blockers.push(`runtime_rebuild_result_hash_invalid:${index + 1}`);
    }
    if (build.cacheDisabled !== true) blockers.push(`runtime_rebuild_cache_not_disabled:${index + 1}`);
    if (build.buildInputClosureHash !== normalizedDefinitionHash) {
      blockers.push(`runtime_rebuild_input_closure_mismatch:${index + 1}`);
    }
  }
  if (builds[0].invocationId === builds[1].invocationId) blockers.push('runtime_rebuild_invocations_not_distinct');
  if (builds[0].isolatedBuildRootIdentityHash === builds[1].isolatedBuildRootIdentityHash) {
    blockers.push('runtime_rebuild_roots_not_isolated');
  }
  if (builds[0].imageDigest !== builds[1].imageDigest) blockers.push('runtime_rebuild_image_digest_mismatch');
  if (builds[0].rootfsChainHash !== builds[1].rootfsChainHash) blockers.push('runtime_rebuild_rootfs_chain_mismatch');
  const payload = Object.freeze({
    version: 1,
    kind: 'RuntimeImageRootfsRepeatabilityDiagnostic',
    image: String(image || ''),
    definitionManifestHash: normalizedDefinitionHash,
    builds,
    observedAt: normalizedObservedAt,
    status: blockers.length
      ? 'local_rootfs_repeatability_not_observed'
      : 'local_rootfs_repeatability_observed_untrusted',
    blockers: canonical([
      ...blockers,
      'local_docker_daemon_identity_not_independently_attested',
      'oci_blob_bitwise_identity_not_verified',
      'external_ed25519_verifier_attestation_required',
    ]),
    assurance: 'same-controller-same-daemon-rootfs-repeatability-diagnostic-only-v1',
  });
  return Object.freeze({
    ...payload,
    runtimeImageRootfsRepeatabilityDiagnosticHash: hashRecord(
      'RuntimeImageRootfsRepeatabilityDiagnostic',
      payload,
    ),
  });
}

export function verifyRuntimeImageBitwiseRebuildEvidence(evidence) {
  void evidence;
  /* A record hash produced by this process is intentionally never accepted as
     bitwise evidence. Production trust is provided only by the independent,
     signed RuntimeImageReproducibilityReceipt contract. */
  return false;
}

export function buildRuntimeImageReproducibilityAssessment({
  image,
  imageDigest,
  definitionManifestHash,
  baseImageDigestPinned = false,
  osPackageSnapshotPinned = false,
  dependencyVersionsPinned = false,
  dependencyArtifactsContentHashed = false,
  sourceArchivesContentHashed = false,
  bitwiseRebuildEvidence = null,
  additionalBlockers = [],
} = {}) {
  void bitwiseRebuildEvidence;
  const blockers = [
    ...(!SHA256.test(String(imageDigest || '')) ? ['runtime_image_content_digest_missing'] : []),
    ...(!SHA256.test(String(definitionManifestHash || '')) ? ['runtime_build_definition_manifest_missing'] : []),
    ...(!baseImageDigestPinned ? ['runtime_base_image_digest_unpinned'] : []),
    ...(!osPackageSnapshotPinned ? ['runtime_os_package_snapshot_unpinned'] : []),
    ...(!dependencyVersionsPinned ? ['runtime_dependency_versions_unpinned'] : []),
    ...(!dependencyArtifactsContentHashed ? ['runtime_dependency_artifact_hashes_incomplete'] : []),
    ...(!sourceArchivesContentHashed ? ['runtime_source_archive_hashes_incomplete'] : []),
    ...additionalBlockers,
  ];
  const bitwiseRebuildVerified = false;
  if (!bitwiseRebuildVerified) blockers.push('bitwise_rebuild_not_verified');
  const payload = Object.freeze({
    version: 2,
    kind: 'RuntimeImageBuildReproducibilityAssessment',
    image: String(image || ''),
    imageDigest: String(imageDigest || '').toLowerCase(),
    definitionManifestHash: String(definitionManifestHash || '').toLowerCase(),
    baseImageDigestPinned: baseImageDigestPinned === true,
    osPackageSnapshotPinned: osPackageSnapshotPinned === true,
    dependencyVersionsPinned: dependencyVersionsPinned === true,
    dependencyArtifactsContentHashed: dependencyArtifactsContentHashed === true,
    sourceArchivesContentHashed: sourceArchivesContentHashed === true,
    runtimeContentIdentityPinned: SHA256.test(String(imageDigest || '')),
    bitwiseRebuildVerified,
    bitwiseRebuildEvidenceHash: bitwiseRebuildVerified
      ? bitwiseRebuildEvidence.runtimeImageBitwiseRebuildEvidenceHash : null,
    bitwiseRebuildEvidence: bitwiseRebuildVerified ? bitwiseRebuildEvidence : null,
    status: bitwiseRebuildVerified
      ? 'bitwise_rebuild_verified'
      : SHA256.test(String(imageDigest || ''))
        ? 'runtime_content_identity_pinned_rebuild_not_verified'
        : 'build_reproducibility_unverified',
    blockers: canonical(blockers),
    assurance: 'runtime_content_digest_and_verified_build_inputs_with_explicit_dual_build_evidence-v2',
  });
  return Object.freeze({
    ...payload,
    runtimeImageBuildReproducibilityAssessmentHash: hashRecord('RuntimeImageBuildReproducibilityAssessment', payload),
  });
}

export function verifyRuntimeImageReproducibilityAssessment(assessment) {
  if (!assessment || assessment.version !== 2 || assessment.kind !== 'RuntimeImageBuildReproducibilityAssessment'
    || assessment.assurance !== 'runtime_content_digest_and_verified_build_inputs_with_explicit_dual_build_evidence-v2') return false;
  const { runtimeImageBuildReproducibilityAssessmentHash, ...payload } = assessment;
  if (!SHA256.test(String(runtimeImageBuildReproducibilityAssessmentHash || ''))
    || hashRecord('RuntimeImageBuildReproducibilityAssessment', payload) !== runtimeImageBuildReproducibilityAssessmentHash
    || JSON.stringify(assessment.blockers) !== JSON.stringify(canonical(assessment.blockers))) return false;
  if (assessment.runtimeContentIdentityPinned !== SHA256.test(String(assessment.imageDigest || ''))) return false;
  if (assessment.bitwiseRebuildVerified) {
    return assessment.status === 'bitwise_rebuild_verified'
      && assessment.blockers.length === 0
      && SHA256.test(String(assessment.bitwiseRebuildEvidenceHash || ''))
      && verifyRuntimeImageBitwiseRebuildEvidence(assessment.bitwiseRebuildEvidence)
      && assessment.bitwiseRebuildEvidence.status === 'bitwise_rebuild_verified'
      && assessment.bitwiseRebuildEvidenceHash
        === assessment.bitwiseRebuildEvidence.runtimeImageBitwiseRebuildEvidenceHash
      && assessment.bitwiseRebuildEvidence.image === assessment.image
      && assessment.bitwiseRebuildEvidence.definitionManifestHash === assessment.definitionManifestHash
      && assessment.bitwiseRebuildEvidence.builds.every((build) => build.imageDigest === assessment.imageDigest)
      && assessment.baseImageDigestPinned === true
      && assessment.osPackageSnapshotPinned === true
      && assessment.dependencyVersionsPinned === true
      && assessment.dependencyArtifactsContentHashed === true
      && assessment.sourceArchivesContentHashed === true;
  }
  return assessment.bitwiseRebuildEvidenceHash === null
    && assessment.bitwiseRebuildEvidence === null
    && assessment.status !== 'bitwise_rebuild_verified'
    && assessment.blockers.includes('bitwise_rebuild_not_verified');
}

export function environmentBomBuildAssessment(assessment) {
  if (!verifyRuntimeImageReproducibilityAssessment(assessment)) return null;
  return Object.freeze({
    status: assessment.status,
    runtimeContentIdentityPinned: assessment.runtimeContentIdentityPinned,
    bitwiseRebuildVerified: assessment.bitwiseRebuildVerified,
    definitionHash: assessment.definitionManifestHash,
    evidenceHash: assessment.bitwiseRebuildEvidenceHash,
    blockers: assessment.blockers,
  });
}
