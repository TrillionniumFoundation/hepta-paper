import path from 'node:path';
import { assertArtifactRepository } from '../../paper-ports/artifact-repository-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { verifyCampaignReleaseBundleForSubmission } from './campaign-release-bundle-consumer.mjs';

function safeName(value) {
  return String(value || 'artifact').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160) || 'artifact';
}

function resolveArtifact(artifact, baseRoot, scopeRoots) {
  const candidate = path.resolve(path.isAbsolute(artifact.path) ? artifact.path : path.join(baseRoot, artifact.path));
  const scopeRoot = scopeRoots.find((root) => isPathWithin(root, candidate));
  return { candidate, scopeRoot: scopeRoot || null };
}

export async function exportSubmissionHandoffBundle({
  artifactRepository,
  bundleRoot,
  artifactPackage,
  packageVerificationReceipt,
  manifest,
  handoff,
  replayGuard,
  reviewedSubmitPreflightPacket,
  dispatchAuthorization,
  submissionDecisionPacket,
  artifactBaseRoot,
  artifactScopeRoots = [],
  campaignReleaseBundle = null,
  campaignReleaseAuthority = null,
} = {}) {
  assertArtifactRepository(artifactRepository);
  const blockers = [];
  if (campaignReleaseBundle) {
    const releaseRoot = path.resolve(campaignReleaseBundle.packageOutput?.releaseRoot || '.');
    const releaseRuntimeRoot = artifactScopeRoots.map((item) => path.resolve(item)).find((item) => isPathWithin(item, releaseRoot)) || null;
    const releaseVerification = verifyCampaignReleaseBundleForSubmission({
      releaseAuthority: campaignReleaseAuthority,
      releaseBundle: campaignReleaseBundle,
      runtimeRoot: releaseRuntimeRoot,
      sourceScopeRoots: [artifactBaseRoot, ...artifactScopeRoots].filter(Boolean),
    });
    if (releaseVerification.status !== 'submission_campaign_release_verified') blockers.push(...releaseVerification.blockers);
    if (campaignReleaseBundle.artifactPackageHash !== artifactPackage?.artifactPackageHash) blockers.push('campaign_release_handoff_artifact_package_mismatch');
    if (campaignReleaseBundle.packageVerificationReceiptHash !== packageVerificationReceipt?.packageVerificationReceiptHash) blockers.push('campaign_release_handoff_package_verification_mismatch');
  }
  if (!bundleRoot) blockers.push('handoff_bundle_root_missing');
  if (artifactPackage?.submitReady !== true || !artifactPackage?.artifactPackageHash) blockers.push('artifact_package_not_submit_ready');
  if (packageVerificationReceipt?.status !== 'package_verification_passed') blockers.push('package_verification_not_ready');
  if (packageVerificationReceipt?.verifiedArtifactPackageHash !== (artifactPackage?.candidateArtifactPackageHash || artifactPackage?.artifactPackageHash)) blockers.push('package_verification_artifact_package_mismatch');
  if (artifactPackage?.packageVerificationReceiptHash !== packageVerificationReceipt?.packageVerificationReceiptHash) blockers.push('artifact_package_verification_receipt_mismatch');
  if (manifest?.status !== 'ready_for_adapter') blockers.push('submission_manifest_not_ready');
  if (manifest?.payload?.artifactPackageHash !== artifactPackage?.artifactPackageHash) blockers.push('manifest_artifact_package_mismatch');
  if (handoff?.status !== 'dry_run_ready') blockers.push('handoff_envelope_not_ready');
  if (handoff?.manifestHash !== manifest?.manifestHash) blockers.push('handoff_manifest_mismatch');
  if (replayGuard?.status !== 'dry_run_replay_allowed') blockers.push('submission_replay_guard_not_ready');
  if (replayGuard?.manifestHash !== manifest?.manifestHash) blockers.push('replay_guard_manifest_mismatch');
  if (reviewedSubmitPreflightPacket?.status !== 'reviewed_submit_preflight_ready_for_external_executor') {
    blockers.push('reviewed_submit_preflight_not_ready');
  }
  if (dispatchAuthorization?.status !== 'submission_dispatch_authorization_ready') blockers.push('dispatch_authorization_not_ready');
  if (dispatchAuthorization?.artifactPackageHash !== artifactPackage?.artifactPackageHash) blockers.push('dispatch_artifact_package_mismatch');
  if (dispatchAuthorization?.preflightHash !== reviewedSubmitPreflightPacket?.reviewedSubmitPreflightPacketHash) blockers.push('dispatch_preflight_mismatch');
  if (dispatchAuthorization?.outboxHash !== reviewedSubmitPreflightPacket?.outboxHash) blockers.push('dispatch_outbox_mismatch');
  if (submissionDecisionPacket?.status !== 'reviewed_submission_decision_verified') blockers.push('reviewed_submission_decision_not_verified');
  if (dispatchAuthorization?.reviewedSubmissionDecisionPacketHash !== submissionDecisionPacket?.reviewedSubmissionDecisionPacketHash) blockers.push('dispatch_submission_decision_mismatch');
  const baseRoot = path.resolve(artifactBaseRoot || '.');
  const scopes = [...new Set([baseRoot, ...artifactScopeRoots].filter(Boolean).map((root) => path.resolve(root)))];
  const artifactReads = [];
  for (const [index, artifact] of (artifactPackage?.artifacts || []).entries()) {
    if (!artifact?.path || !artifact?.hash) { blockers.push(`handoff_artifact_binding_missing:${index}`); continue; }
    const { candidate, scopeRoot } = resolveArtifact(artifact, baseRoot, scopes);
    if (!scopeRoot) { blockers.push(`handoff_artifact_outside_scope:${artifact.path}`); continue; }
    const read = readScopedFileSync({ scopeRoot, candidate });
    if (read.status !== 'scoped_file_read_verified') {
      blockers.push(`handoff_artifact_read_blocked:${artifact.path}`);
      continue;
    }
    if (read.hash !== artifact.hash) blockers.push(`handoff_artifact_hash_mismatch:${artifact.path}`);
    if (artifact.sizeBytes !== null && artifact.sizeBytes !== undefined && Number(artifact.sizeBytes) !== read.bytes) {
      blockers.push(`handoff_artifact_size_mismatch:${artifact.path}`);
    }
    artifactReads.push({ index, artifact, read });
  }
  if (blockers.length) {
    const blocked = {
      version: 1,
      kind: 'SubmissionHandoffBundleExportReceipt',
      status: 'submission_handoff_bundle_blocked',
      paperId: manifest?.paperId || null,
      blockers: [...new Set(blockers)],
      externalActionPerformed: false,
    };
    return Object.freeze({ ...blocked, submissionHandoffBundleExportReceiptHash: hashRecord('SubmissionHandoffBundleExportReceipt', blocked) });
  }
  const copiedArtifacts = [];
  for (const { index, artifact, read } of artifactReads) {
    const target = path.join(bundleRoot, 'artifacts', `${String(index + 1).padStart(3, '0')}-${safeName(path.basename(artifact.path))}`);
    const write = await artifactRepository.writeBytes(target, read.content, { role: `submission_handoff:${artifact.role || 'artifact'}` });
    copiedArtifacts.push({
      id: artifact.id || null,
      role: artifact.role || null,
      sourcePath: artifact.path,
      bundlePath: path.relative(bundleRoot, target).replace(/\\/g, '/'),
      hash: write.hash,
      bytes: write.bytes,
      sourceReadReceiptHash: read.scopedFileReadReceiptHash,
      writeReceiptHash: write.writeReceiptHash,
    });
  }
  const bundleManifest = {
    version: 1,
    kind: 'SubmissionHandoffBundleManifest',
    paperId: manifest.paperId,
    taskKey: manifest.taskKey,
    artifactPackageHash: artifactPackage.artifactPackageHash,
    packageVerificationReceiptHash: packageVerificationReceipt.packageVerificationReceiptHash,
    manifestHash: manifest.manifestHash,
    handoffEnvelopeHash: handoff.envelopeHash,
    replayGuardHash: replayGuard.submissionReplayGuardHash,
    reviewedSubmitPreflightPacketHash: reviewedSubmitPreflightPacket.reviewedSubmitPreflightPacketHash,
    dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
    provider: dispatchAuthorization.provider,
    accountId: dispatchAuthorization.accountId,
    nonce: dispatchAuthorization.nonce,
    reviewedSubmissionDecisionPacketHash: submissionDecisionPacket.reviewedSubmissionDecisionPacketHash,
    campaignReleaseBundleHash: campaignReleaseBundle?.campaignReleaseBundleHash || null,
    submissionMetadata: submissionDecisionPacket.metadata,
    artifacts: copiedArtifacts,
    artifactCount: copiedArtifacts.length,
    externalActionPerformed: false,
  };
  const submissionHandoffBundleManifestHash = hashRecord('SubmissionHandoffBundleManifest', bundleManifest);
  const manifestWrite = await artifactRepository.writeJson(path.join(bundleRoot, 'SUBMISSION_HANDOFF_MANIFEST.json'), {
    ...bundleManifest,
    submissionHandoffBundleManifestHash,
  }, { role: 'submission_handoff_manifest' });
  const receipt = {
    version: 1,
    kind: 'SubmissionHandoffBundleExportReceipt',
    status: 'submission_handoff_bundle_exported',
    paperId: manifest.paperId,
    bundleRoot,
    artifactCount: copiedArtifacts.length,
    submissionHandoffBundleManifestHash,
    manifestWriteReceiptHash: manifestWrite.writeReceiptHash,
    artifactWriteReceiptHashes: copiedArtifacts.map((item) => item.writeReceiptHash),
    blockers: [],
    externalActionPerformed: false,
  };
  return Object.freeze({ ...receipt, submissionHandoffBundleExportReceiptHash: hashRecord('SubmissionHandoffBundleExportReceipt', receipt) });
}
