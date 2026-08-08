import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertWorkspaceLayoutPhysicallyDecoupled,
  defaultPaperAssetRoot,
} from '../src/workspace-layout.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';
import { signReleasePayload } from './release-integrity-signing.mjs';
import {
  assertReleaseEvidenceInputSnapshotUnchanged,
  assertValidReleaseEvidenceInputSnapshot,
  captureReleaseEvidenceInputSnapshot,
} from './release-evidence-input-snapshot.mjs';

const defaultWorkspaceRoot =
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  ensurePrivateDirectoryWithinRuntime,
  loadExistingReleaseSigningKey,
  publishJsonArtifactSet,
  verifyReleaseIntegritySignature,
} = releaseIntegrityEvidence;

export function retirementLifecycleStatus({
  legacyRoot,
  liveLegacyRootPresent: capturedLiveLegacyRootPresent,
  deletionDrill = null,
  deletionDrillEvidence = null,
  immutableReceipt = null,
  immutableSnapshotEvidence = null,
} = {}) {
  const liveLegacyRootPresent = capturedLiveLegacyRootPresent === undefined
    ? Boolean(legacyRoot && fs.existsSync(legacyRoot))
    : capturedLiveLegacyRootPresent === true;
  const immutableReferenceReady = immutableSnapshotEvidence?.status
      === 'legacy_immutable_snapshot_current_evidence_verified'
    && immutableSnapshotEvidence.releaseEvidenceReady === true
    && immutableSnapshotEvidence.receipt === immutableReceipt
    && immutableReceipt?.status === 'legacy_reference_ext4_inode_immutable';
  const physicalDeletionObserved = !liveLegacyRootPresent && immutableReferenceReady;
  const currentAuthorization = deletionDrillEvidence?.status === 'legacy_deletion_drill_current_evidence_verified'
    && Boolean(deletionDrill?.physicalDeletionAllowed);
  return Object.freeze({
    restoreDrillStatus: deletionDrill?.status || deletionDrillEvidence?.status || 'missing',
    restoreDrillEvidenceStatus: deletionDrillEvidence?.status || 'missing',
    restoreDrillEvidenceBlockers: deletionDrillEvidence?.blockers || [],
    currentPhysicalDeletionAuthorization: currentAuthorization,
    physicalDeletionAllowed: currentAuthorization,
    liveLegacyRootPresent,
    physicalDeletionObserved,
    destructiveDeletionPerformed: physicalDeletionObserved,
    deletionLifecycleStatus: physicalDeletionObserved
      ? (currentAuthorization ? 'legacy_root_deleted_with_current_authorization' : 'legacy_root_deleted_under_prior_authorization_current_gate_blocked')
      : liveLegacyRootPresent ? 'legacy_root_present' : 'legacy_root_absence_unverified',
    immutableSnapshotStatus: immutableReceipt?.status || 'missing',
    immutableSnapshotEvidenceStatus: immutableSnapshotEvidence?.status || 'missing',
    immutableSnapshotEvidenceBlockers: immutableSnapshotEvidence?.blockers || [],
    immutableContentObjectClaimed: immutableReceipt?.immutableContentObjectClaimed === true,
  });
}

export function buildReleaseEvidenceBundle({
  runtimeRoot,
  legacyRoot,
  workspaceRoot = defaultWorkspaceRoot,
  environment = process.env,
  expectedReleaseStateSnapshotHash = null,
  inputSnapshot = null,
  now = new Date(),
} = {}) {
  const snapshot = assertValidReleaseEvidenceInputSnapshot(inputSnapshot
    || captureReleaseEvidenceInputSnapshot({
      runtimeRoot,
      legacyRoot,
      workspaceRoot,
      environment,
      expectedReleaseStateSnapshotHash,
      now,
    }));
  if (snapshot.inputs.workspaceRoot !== path.resolve(workspaceRoot)
    || snapshot.inputs.runtimeRoot !== path.resolve(runtimeRoot)
    || snapshot.inputs.legacyRoot.path !== path.resolve(legacyRoot)
    || (expectedReleaseStateSnapshotHash
      && snapshot.releaseStateSnapshot.workspaceReleaseStateSnapshotHash
        !== expectedReleaseStateSnapshotHash)) {
    throw new Error('release_evidence_input_snapshot_scope_mismatch');
  }
  const {
    releaseStateSnapshot,
    codeProvenance,
    verificationReceiptEvidence,
    capabilityManifestEvidence,
    deletionDrillEvidence,
    immutableSnapshotEvidence,
    coldVolumeStatus,
    minimalDifferentialFixture,
    immutableMatrixReference,
    productionStoreLogicalIntegrity,
    coldVolumeCas,
    offhostWormStatus,
    trustLayerGate,
    inputs,
  } = snapshot;
  const verificationReceipt = verificationReceiptEvidence.receipt;
  const deletionDrill = deletionDrillEvidence.receipt;
  const immutableReceipt = immutableSnapshotEvidence.receipt;
  const codeTrustLayersReady = trustLayerGate.status === 'code_release_trust_layers_ready';
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const payload = {
    version: 2,
    kind: 'ReleaseEvidenceBundle',
    status: !codeProvenance.treeDirty
      && verificationReceiptEvidence.releaseEvidenceReady === true
      && capabilityManifestEvidence.releaseEvidenceReady === true
      && Boolean(immutableSnapshotEvidence.currentArchive?.archiveHash)
      && deletionDrillEvidence.releaseEvidenceReady === true
      && immutableSnapshotEvidence.releaseEvidenceReady === true
      && coldVolumeStatus.contractValid
      && minimalDifferentialFixture.status === 'legacy_differential_reference_verified'
      && immutableMatrixReference.status === 'immutable_legacy_matrix_reference_ready'
      && productionStoreLogicalIntegrity?.status === 'sqlite_logical_integrity_verified'
      && codeTrustLayersReady
      ? 'code_release_evidence_ready'
      : 'code_release_evidence_blocked',
    releaseProfile: 'code_release',
    codeProvenance,
    releaseStateSnapshot,
    releaseStateSnapshotHash: releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    generatedAt,
    verificationReceipt,
    bindings: {
      releaseEvidenceInputSnapshotHash: snapshot.releaseEvidenceInputSnapshotHash,
      capabilityCatalogHash: snapshot.capabilityCatalogHash,
      implementationProofSetHash:
        snapshot.implementationProofSet.releaseEvidenceProofSetSnapshotHash,
      conformanceProofSetHash:
        snapshot.conformanceProofSet.releaseEvidenceProofSetSnapshotHash,
      operationalProofSetHash:
        snapshot.operationalProofSet.releaseEvidenceProofSetSnapshotHash,
      migrationMatrixHash: inputs.migrationMatrix.fileHash,
      legacyDatabaseHash: inputs.legacyDatabase.fileHash,
      capabilityVerificationManifestHash:
        capabilityManifestEvidence.pointer?.capabilityVerificationManifestHash || null,
      capabilityVerificationManifestFileHash:
        capabilityManifestEvidence.targetFileHash || null,
      capabilityVerificationManifestPath:
        capabilityManifestEvidence.targetRelativePath || null,
      capabilityVerificationCurrentPointerHash:
        capabilityManifestEvidence.pointer?.currentCapabilityVerificationManifestPointerHash || null,
      capabilityVerificationCurrentPointerFileHash:
        capabilityManifestEvidence.pointerFileHash || null,
      capabilityVerificationCurrentPointerPath:
        capabilityManifestEvidence.pointerRelativePath || null,
      capabilityVerificationCurrentPointerSigningKeyFingerprint:
        capabilityManifestEvidence.pinnedPublicKeyFingerprint || null,
      legacyReferenceArchiveHash: immutableSnapshotEvidence.currentArchive?.archiveHash || null,
      legacyReadOnlyReceiptHash: inputs.archiveReadOnlyReceipt.fileHash,
      deletionRestoreDrillReceiptHash: deletionDrillEvidence.receiptHash || null,
      deletionRestoreDrillClaimedReceiptHash: deletionDrillEvidence.claimedReceiptHash || null,
      deletionRestoreDrillReceiptFileHash: deletionDrillEvidence.candidateFileHash || null,
      deletionRestoreDrillReceiptPath: deletionDrillEvidence.candidateRelativePath || null,
      deletionRestoreDrillSigningKeyFingerprint: deletionDrillEvidence.pinnedPublicKeyFingerprint || null,
      isolatedVerificationReceiptHash: verificationReceiptEvidence.receiptHash || null,
      isolatedVerificationReceiptFileHash: verificationReceiptEvidence.candidateFileHash || null,
      isolatedVerificationReceiptPath: verificationReceiptEvidence.candidateRelativePath || null,
      isolatedVerificationSigningKeyFingerprint:
        verificationReceiptEvidence.pinnedPublicKeyFingerprint || null,
      legacyImmutableSnapshotReceiptHash: immutableSnapshotEvidence.receiptHash || null,
      legacyImmutableSnapshotReceiptFileHash:
        immutableSnapshotEvidence.candidateFileHash || null,
      legacyImmutableSnapshotReceiptPath: immutableSnapshotEvidence.candidatePath || null,
      legacyImmutableSnapshotSignatureFileHash:
        immutableSnapshotEvidence.signatureFileHash || null,
      legacyImmutableSnapshotSignaturePath: immutableSnapshotEvidence.signaturePath || null,
      legacyImmutableSnapshotSigningKeyFingerprint:
        immutableSnapshotEvidence.pinnedPublicKeyFingerprint || null,
      minimalLegacyDifferentialFixtureHash: minimalDifferentialFixture.archiveSha256,
      coldVolumeContractHash: coldVolumeStatus.contractHash,
      immutableLegacyMatrixReferenceHash: immutableMatrixReference.matrixSha256,
      productionStoreLogicalHash: productionStoreLogicalIntegrity?.logicalDatabaseHash || null,
      coldVolumeCasManifestHash: coldVolumeCas.manifestHash || null,
      offhostWormContractHash: snapshot.offhostWormContract.fileHash,
      runtimeHygieneExportHash: snapshot.runtimeHygieneExport.fileHash,
    },
    authorityStatus: {
      trustStorePresent: snapshot.authorityTrustStore.present,
      requiredRoles: ['academic_evidence_authority', 'independent_referee', 'submission_operator', 'live_executor_authorizer'],
      authorityInferredFromReleaseSignature: false,
    },
    deletionDrillEvidence: {
      status: deletionDrillEvidence.status,
      receiptHash: deletionDrillEvidence.receiptHash || null,
      receiptPath: deletionDrillEvidence.candidateRelativePath || null,
      receiptFileHash: deletionDrillEvidence.candidateFileHash || null,
      publicKeyFingerprint: deletionDrillEvidence.pinnedPublicKeyFingerprint || null,
      claimedReceiptHash: deletionDrillEvidence.claimedReceiptHash || null,
      blockers: deletionDrillEvidence.blockers,
      receiptBlockers: deletionDrillEvidence.receiptBlockers || [],
    },
    verificationReceiptEvidence: {
      status: verificationReceiptEvidence.status,
      receiptHash: verificationReceiptEvidence.receiptHash || null,
      receiptPath: verificationReceiptEvidence.candidateRelativePath || null,
      receiptFileHash: verificationReceiptEvidence.candidateFileHash || null,
      publicKeyFingerprint: verificationReceiptEvidence.pinnedPublicKeyFingerprint || null,
      blockers: verificationReceiptEvidence.blockers,
    },
    capabilityManifestEvidence: {
      status: capabilityManifestEvidence.status,
      semanticManifestHash:
        capabilityManifestEvidence.pointer?.capabilityVerificationManifestHash || null,
      targetPath: capabilityManifestEvidence.targetRelativePath || null,
      targetFileHash: capabilityManifestEvidence.targetFileHash || null,
      pointerPath: capabilityManifestEvidence.pointerRelativePath || null,
      pointerFileHash: capabilityManifestEvidence.pointerFileHash || null,
      pointerHash:
        capabilityManifestEvidence.pointer?.currentCapabilityVerificationManifestPointerHash
          || null,
      publicKeyFingerprint: capabilityManifestEvidence.pinnedPublicKeyFingerprint || null,
      blockers: capabilityManifestEvidence.blockers,
    },
    retirementStatus: retirementLifecycleStatus({
      legacyRoot,
      liveLegacyRootPresent: inputs.legacyRoot.present,
      deletionDrill,
      deletionDrillEvidence,
      immutableReceipt,
      immutableSnapshotEvidence,
    }),
    assetRecoveryStatus: {
      coldVolume: coldVolumeStatus,
      coldVolumeCas,
      offhostWorm: offhostWormStatus,
    },
    disasterRecoveryStatus: coldVolumeCas.status === 'cold_volume_cas_ready'
      && offhostWormStatus.offHostOrOffsiteCustodyQualified === true
      ? 'disaster_recovery_ready'
      : 'disaster_recovery_blocked',
    trustLayers: trustLayerGate,
    minimalDifferentialFixture,
    immutableMatrixReference,
    productionStoreLogicalIntegrity,
    evidenceClasses: {
      technical: 'isolated verification only',
      operational: 'requires production-bound receipts and is not inferred here',
      ownerAcceptance: 'requires an external capability owner signature and is not inferred here',
    },
    externalActionPerformed: false,
  };
  return { ...payload, releaseEvidenceBundleHash: hashRecord('ReleaseEvidenceBundle', payload) };
}

export function writeSignedReleaseEvidence({
  runtimeRoot,
  legacyRoot,
  workspaceRoot = defaultWorkspaceRoot,
  environment = process.env,
  expectedReleaseStateSnapshotHash = null,
} = {}) {
  assertWorkspaceLayoutPhysicallyDecoupled({
    assetRoot: defaultPaperAssetRoot(),
    runtimeRoot,
    legacyRoot,
  });
  const inputSnapshot = captureReleaseEvidenceInputSnapshot({
    runtimeRoot,
    legacyRoot,
    workspaceRoot,
    environment,
    expectedReleaseStateSnapshotHash,
  });
  const bundle = buildReleaseEvidenceBundle({
    runtimeRoot,
    legacyRoot,
    workspaceRoot,
    environment,
    expectedReleaseStateSnapshotHash:
      inputSnapshot.releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    inputSnapshot,
  });
  if (bundle.status !== 'code_release_evidence_ready') {
    throw new Error('release_evidence_bundle_not_ready');
  }
  const assertStableCandidate = () => {
    assertReleaseEvidenceInputSnapshotUnchanged({
      expectedSnapshotHash: inputSnapshot.releaseEvidenceInputSnapshotHash,
      capture: () => captureReleaseEvidenceInputSnapshot({
        runtimeRoot,
        legacyRoot,
        workspaceRoot,
        environment,
        expectedReleaseStateSnapshotHash:
          inputSnapshot.releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
      }),
    });
  };
  assertStableCandidate();
  const signature = signReleasePayload(bundle, runtimeRoot, { allowKeyCreation: false });
  const key = loadExistingReleaseSigningKey(runtimeRoot);
  const signatureVerified = verifyReleaseIntegritySignature(bundle, signature, {
    pinnedPublicKeyPem: key.publicKeyPem,
    pinnedPublicKeyFingerprint: key.publicKeyFingerprint,
  });
  if (!signatureVerified) throw new Error('release_evidence_signature_verification_failed');
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(bundle.codeProvenance.packageVersion)
    || !/^[a-f0-9]{40}$/.test(bundle.codeProvenance.commit)) {
    throw new Error('release_evidence_output_identity_invalid');
  }
  const root = path.join(runtimeRoot, 'release-evidence', bundle.codeProvenance.packageVersion, bundle.codeProvenance.commit || 'unknown');
  assertStableCandidate();
  ensurePrivateDirectoryWithinRuntime(runtimeRoot, root);
  const token = bundle.releaseEvidenceBundleHash.replace(/^sha256:/, '');
  const bundlePath = path.join(root, `RELEASE_EVIDENCE_BUNDLE_${token}.json`);
  const signaturePath = path.join(root, `RELEASE_EVIDENCE_SIGNATURE_${token}.json`);
  const pointerPayload = {
    version: 2,
    kind: 'CurrentReleaseEvidencePointer',
    packageVersion: bundle.codeProvenance.packageVersion,
    commit: bundle.codeProvenance.commit,
    bundlePath,
    bundleHash: bundle.releaseEvidenceBundleHash,
    signaturePath,
    signatureVerified,
    generatedAt: bundle.generatedAt,
    releaseStateSnapshotHash: bundle.releaseStateSnapshotHash,
    releaseEvidenceInputSnapshotHash: bundle.bindings.releaseEvidenceInputSnapshotHash,
  };
  const pointer = Object.freeze({
    ...pointerPayload,
    currentReleaseEvidencePointerHash: hashRecord('CurrentReleaseEvidencePointer', pointerPayload),
  });
  const publication = publishJsonArtifactSet({
    entries: [
      { path: bundlePath, value: bundle },
      { path: signaturePath, value: signature },
    ],
    pointerPath: path.join(root, 'CURRENT_RELEASE_EVIDENCE.json'),
    pointerValue: pointer,
    beforePointer: assertStableCandidate,
    afterPointer: assertStableCandidate,
  });
  return {
    bundle,
    signature,
    signatureVerified,
    bundlePath,
    signaturePath,
    root,
    pointer,
    publication,
  };
}
