import fs from 'node:fs';
import path from 'node:path';
import {
  fileRecord,
  pathWithin,
  readJsonIfExists,
} from '../../paper-core/src/runtime/file-utils.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';
import {
  loadAuthorityTrustStore,
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../../paper-core/src/authority-signatures.mjs';

function missingReport({ root, sourceRoot }) {
  const attestationPath = sourceRoot ? path.join(sourceRoot, 'ACADEMIC_EVIDENCE_ATTESTATION.json') : null;
  const report = {
    version: 2,
    kind: 'AcademicEvidenceAttestationVerification',
    status: 'academic_evidence_attestation_missing',
    academicEvidenceEligible: false,
    cryptographicSignaturesVerified: false,
    attestationPath: attestationPath ? path.relative(root, attestationPath).replace(/\\/g, '/') : null,
    verifiedArtifacts: [],
    verifiedWorkerReceiptCount: 0,
    signerSubjectIds: [],
    blockers: ['academic_evidence_attestation_missing'],
  };
  return {
    ...report,
    academicEvidenceAttestationVerificationHash: hashPaperRecord(
      'AcademicEvidenceAttestationVerification',
      report,
    ),
  };
}

function artifactBase({ scope, sourceRoot, runtimeRoot, paperId }) {
  if (scope === 'runtime') {
    return runtimeRoot && paperId ? path.join(runtimeRoot, 'research-workers', paperId) : null;
  }
  return sourceRoot;
}

export async function verifyAcademicEvidenceAttestation({
  root,
  sourceRoot,
  runtimeRoot = null,
  paperTask = null,
  workerExecutionReport = null,
  trustStoreOverride = null,
  now = new Date(),
} = {}) {
  const attestationPath = sourceRoot ? path.join(sourceRoot, 'ACADEMIC_EVIDENCE_ATTESTATION.json') : null;
  if (!attestationPath || !fs.existsSync(attestationPath)) return missingReport({ root, sourceRoot });
  const attestation = await readJsonIfExists(attestationPath);
  const blockers = [];
  if (!attestation) blockers.push('academic_evidence_attestation_invalid_json');
  if (attestation?.version !== 2 || attestation?.kind !== 'AcademicEvidenceAttestation') {
    blockers.push('academic_evidence_attestation_version_or_kind_unsupported');
  }
  if (attestation?.paperId !== paperTask?.paperId) blockers.push('academic_evidence_paper_id_mismatch');
  if (attestation?.taskKey !== paperTask?.taskKey) blockers.push('academic_evidence_task_key_mismatch');
  if (attestation?.classification !== 'research_evidence') blockers.push('academic_evidence_classification_invalid');
  if (attestation?.syntheticOrGenerated !== false) blockers.push('synthetic_or_generated_evidence_not_eligible');
  if (attestation?.outcomesPreprogrammed !== false) blockers.push('preprogrammed_outcomes_not_eligible');
  const trustStore = await loadAuthorityTrustStore({ runtimeRoot, trustStoreOverride });
  const signatureVerification = verifyAuthoritySignatures({
    document: attestation || {},
    trustStore,
    requiredRoles: ['academic_evidence_authority'],
    minSignatures: 1,
  });
  blockers.push(...signatureVerification.blockers);
  const timeWindow = verifyAuthorityTimeWindow({
    signedAt: attestation?.signedAt,
    validFrom: attestation?.validFrom,
    expiresAt: attestation?.expiresAt,
    now,
    maximumLifetimeMs: 366 * 24 * 60 * 60 * 1000,
  });
  blockers.push(...timeWindow.blockers);
  const sourceSnapshot = attestation?.sourceSnapshot || {};
  const sourceSnapshotPath = path.resolve(sourceRoot || root, String(sourceSnapshot.path || ''));
  if (!sourceSnapshot.path || !sourceRoot || !pathWithin(sourceRoot, sourceSnapshotPath)) {
    blockers.push('academic_evidence_source_snapshot_path_invalid');
  }
  const sourceSnapshotRecord = sourceRoot && pathWithin(sourceRoot, sourceSnapshotPath)
    ? await fileRecord(root, sourceSnapshotPath, 'academic_evidence_source_snapshot')
    : null;
  if (!sourceSnapshotRecord) blockers.push('academic_evidence_source_snapshot_missing');
  if (sourceSnapshotRecord && sourceSnapshot.sha256 !== sourceSnapshotRecord.hash) {
    blockers.push('academic_evidence_source_snapshot_hash_mismatch');
  }
  const artifacts = Array.isArray(attestation?.artifacts) ? attestation.artifacts : [];
  if (!artifacts.length) blockers.push('academic_evidence_artifacts_missing');
  const verifiedArtifacts = [];
  for (const artifact of artifacts) {
    const scope = artifact?.scope === 'runtime' ? 'runtime' : 'source';
    const base = artifactBase({ scope, sourceRoot, runtimeRoot, paperId: paperTask?.paperId });
    const relativeArtifact = String(artifact?.path || '');
    const absoluteArtifact = base ? path.resolve(base, relativeArtifact) : null;
    const artifactBlockers = [];
    if (!base || !relativeArtifact || !absoluteArtifact || !pathWithin(base, absoluteArtifact)) {
      artifactBlockers.push('artifact_path_outside_allowed_evidence_root');
    }
    if (!artifact?.kind || /smoke|synthetic|fixture/i.test(String(artifact.kind))) {
      artifactBlockers.push('artifact_kind_missing_or_ineligible');
    }
    if (!Array.isArray(artifact?.claimIds) || !artifact.claimIds.length) artifactBlockers.push('artifact_claim_ids_missing');
    const record = artifactBlockers.length
      ? null
      : await fileRecord(root, absoluteArtifact, 'attested_academic_evidence');
    if (!record) artifactBlockers.push('artifact_file_missing');
    if (record && artifact.sha256 !== record.hash) artifactBlockers.push('artifact_hash_mismatch');
    blockers.push(...artifactBlockers.map((blocker) => `${relativeArtifact || 'unknown'}:${blocker}`));
    verifiedArtifacts.push({
      scope,
      path: relativeArtifact || null,
      kind: artifact?.kind || null,
      claimIds: Array.isArray(artifact?.claimIds) ? artifact.claimIds : [],
      currentHash: record?.hash || null,
      expectedHash: artifact?.sha256 || null,
      verified: artifactBlockers.length === 0,
      blockers: artifactBlockers,
    });
  }
  const declaredWorkerReceiptHashes = Array.isArray(attestation?.workerExecutionReceiptHashes)
    ? attestation.workerExecutionReceiptHashes.map(String)
    : [];
  if (!declaredWorkerReceiptHashes.length) blockers.push('academic_evidence_worker_execution_receipts_missing');
  const verifiedWorkerReceipts = (workerExecutionReport?.workerReceipts || []).filter((receipt) => (
    receipt.status === 'native_research_worker_execution_verified'
    && receipt.academicEvidenceEligible === true
    && receipt.nativeResearchWorkerExecutionReceiptHash
  ));
  const verifiedWorkerReceiptHashes = new Set(
    verifiedWorkerReceipts.map((receipt) => receipt.nativeResearchWorkerExecutionReceiptHash),
  );
  for (const receiptHash of declaredWorkerReceiptHashes) {
    if (!verifiedWorkerReceiptHashes.has(receiptHash)) blockers.push(`academic_evidence_worker_receipt_not_verified:${receiptHash}`);
  }
  if (workerExecutionReport?.status !== 'native_research_workers_verified') {
    blockers.push('native_research_worker_execution_report_not_verified');
  }
  const claimIds = new Set(verifiedArtifacts.flatMap((artifact) => artifact.claimIds || []));
  const workerClaimIds = new Set(verifiedWorkerReceipts.flatMap((receipt) => receipt.claimIds || []));
  for (const claimId of claimIds) {
    if (!workerClaimIds.has(claimId)) blockers.push(`academic_evidence_claim_not_bound_to_worker:${claimId}`);
  }
  const report = {
    version: 2,
    kind: 'AcademicEvidenceAttestationVerification',
    status: blockers.length ? 'academic_evidence_attestation_blocked' : 'academic_evidence_verified',
    academicEvidenceEligible: blockers.length === 0,
    cryptographicSignaturesVerified: signatureVerification.cryptographicSignaturesVerified,
    attestationPath: path.relative(root, attestationPath).replace(/\\/g, '/'),
    attestationHash: (await fileRecord(root, attestationPath, 'academic_evidence_attestation'))?.hash || null,
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    sourceSnapshot: {
      path: sourceSnapshot.path || null,
      expectedHash: sourceSnapshot.sha256 || null,
      currentHash: sourceSnapshotRecord?.hash || null,
      verified: Boolean(sourceSnapshotRecord && sourceSnapshot.sha256 === sourceSnapshotRecord.hash),
    },
    workerExecutionReportHash: workerExecutionReport?.nativeResearchWorkerExecutionReportHash || null,
    declaredWorkerReceiptHashes,
    verifiedWorkerReceiptCount: declaredWorkerReceiptHashes.filter((hash) => verifiedWorkerReceiptHashes.has(hash)).length,
    verifiedArtifacts,
    verifiedClaimIds: [...claimIds].sort(),
    signerSubjectIds: signatureVerification.verifiedSubjectIds,
    signatureVerification,
    timeWindow,
    blockers: [...new Set(blockers)],
  };
  return {
    ...report,
    academicEvidenceAttestationVerificationHash: hashPaperRecord(
      'AcademicEvidenceAttestationVerification',
      report,
    ),
  };
}
