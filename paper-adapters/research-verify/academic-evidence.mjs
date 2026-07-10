import fs from 'node:fs';
import path from 'node:path';
import { fileRecord } from '../../paper-core/src/utils.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contracts.mjs';

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function verifyAcademicEvidenceAttestation({ root, sourceRoot }) {
  const attestationPath = sourceRoot ? path.join(sourceRoot, 'ACADEMIC_EVIDENCE_ATTESTATION.json') : null;
  if (!attestationPath || !fs.existsSync(attestationPath)) {
    const missing = {
      version: 1,
      kind: 'AcademicEvidenceAttestationVerification',
      status: 'academic_evidence_attestation_missing',
      academicEvidenceEligible: false,
      attestationPath: attestationPath ? path.relative(root, attestationPath).replace(/\\/g, '/') : null,
      verifiedArtifacts: [],
      blockers: ['academic_evidence_attestation_missing'],
    };
    return {
      ...missing,
      academicEvidenceAttestationVerificationHash: hashPaperRecord(
        'AcademicEvidenceAttestationVerification',
        missing,
      ),
    };
  }
  let attestation = null;
  const blockers = [];
  try {
    attestation = JSON.parse(fs.readFileSync(attestationPath, 'utf8'));
  } catch {
    blockers.push('academic_evidence_attestation_invalid_json');
    attestation = {};
  }
  if (attestation.version !== 1) blockers.push('academic_evidence_attestation_version_unsupported');
  if (attestation.classification !== 'research_evidence') blockers.push('academic_evidence_classification_invalid');
  if (attestation.syntheticOrGenerated !== false) blockers.push('synthetic_or_generated_evidence_not_eligible');
  if (attestation.outcomesPreprogrammed !== false) blockers.push('preprogrammed_outcomes_not_eligible');
  const artifacts = Array.isArray(attestation.artifacts) ? attestation.artifacts : [];
  if (!artifacts.length) blockers.push('academic_evidence_artifacts_missing');
  const verifiedArtifacts = [];
  for (const artifact of artifacts) {
    const relativeArtifact = String(artifact?.path || '');
    const absoluteArtifact = path.resolve(sourceRoot, relativeArtifact);
    const artifactBlockers = [];
    if (!relativeArtifact || !within(sourceRoot, absoluteArtifact)) artifactBlockers.push('artifact_path_outside_source_workspace');
    if (!artifact?.kind) artifactBlockers.push('artifact_kind_missing');
    if (!Array.isArray(artifact?.claimIds) || !artifact.claimIds.length) artifactBlockers.push('artifact_claim_ids_missing');
    const record = artifactBlockers.length ? null : await fileRecord(root, absoluteArtifact, 'attested_academic_evidence');
    if (!record) artifactBlockers.push('artifact_file_missing');
    if (record && artifact.sha256 !== record.hash) artifactBlockers.push('artifact_hash_mismatch');
    blockers.push(...artifactBlockers.map((blocker) => `${relativeArtifact || 'unknown'}:${blocker}`));
    verifiedArtifacts.push({
      path: relativeArtifact || null,
      kind: artifact?.kind || null,
      claimIds: Array.isArray(artifact?.claimIds) ? artifact.claimIds : [],
      currentHash: record?.hash || null,
      expectedHash: artifact?.sha256 || null,
      verified: artifactBlockers.length === 0,
      blockers: artifactBlockers,
    });
  }
  const report = {
    version: 1,
    kind: 'AcademicEvidenceAttestationVerification',
    status: blockers.length ? 'academic_evidence_attestation_blocked' : 'academic_evidence_verified',
    academicEvidenceEligible: blockers.length === 0,
    attestationPath: path.relative(root, attestationPath).replace(/\\/g, '/'),
    attestationHash: (await fileRecord(root, attestationPath, 'academic_evidence_attestation'))?.hash || null,
    verifiedArtifacts,
    blockers,
  };
  return {
    ...report,
    academicEvidenceAttestationVerificationHash: hashPaperRecord(
      'AcademicEvidenceAttestationVerification',
      report,
    ),
  };
}
