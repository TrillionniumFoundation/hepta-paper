import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

function inside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

export async function verifyEvidenceArtifact({
  sourceRoot,
  evidence,
  authorityVerifier = null,
  expectedSourceSnapshotHash = null,
} = {}) {
  const blockers = [];
  const absolutePath = path.resolve(sourceRoot || '.', evidence?.path || '');
  if (!sourceRoot || !inside(sourceRoot, absolutePath)) blockers.push('evidence_path_outside_source_root');
  let bytes = null;
  try {
    if (!blockers.length) bytes = await fsp.readFile(absolutePath);
  } catch {
    blockers.push('evidence_artifact_unreadable');
  }
  const verifiedHash = bytes ? hashBytes(bytes) : null;
  if (evidence?.hash && verifiedHash !== evidence.hash) blockers.push('evidence_artifact_hash_mismatch');
  if (!evidence?.provenance) blockers.push('evidence_provenance_missing');
  if (expectedSourceSnapshotHash && evidence?.sourceSnapshotHash !== expectedSourceSnapshotHash) {
    blockers.push('evidence_source_snapshot_mismatch');
  }
  let authorityReceipt = null;
  if (evidence?.authorityAttestation) {
    if (!authorityVerifier?.verifyAcademicEvidence) blockers.push('evidence_authority_verifier_missing');
    else authorityReceipt = await authorityVerifier.verifyAcademicEvidence(evidence.authorityAttestation);
    if (authorityReceipt && authorityReceipt.status !== 'academic_evidence_verified') {
      blockers.push('evidence_authority_not_verified');
    }
  }
  const record = {
    version: 1,
    kind: 'EvidenceArtifactVerificationReceipt',
    evidenceId: evidence?.id || null,
    path: evidence?.path || null,
    expectedHash: evidence?.hash || null,
    verifiedHash,
    sourceSnapshotHash: evidence?.sourceSnapshotHash || null,
    provenance: evidence?.provenance || null,
    authorityReceiptHash: authorityReceipt?.academicEvidenceAttestationHash || null,
    status: blockers.length ? 'evidence_artifact_blocked' : 'evidence_artifact_verified',
    blockers,
    externalActionPerformed: false,
  };
  return { ...record, provenanceReceiptHash: hashRecord('EvidenceArtifactVerificationReceipt', record) };
}

export async function verifyEvidenceBatch(options = {}) {
  const receipts = [];
  for (const evidence of options.evidenceItems || []) {
    receipts.push(await verifyEvidenceArtifact({ ...options, evidence }));
  }
  return receipts;
}
