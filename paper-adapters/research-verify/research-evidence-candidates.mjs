import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import { resolveRepoPath } from '../../workflow-kernel/runtime/path-utils.mjs';
import { buildEvidenceIntake } from '../../paper-domain/research/evidence-ingestor.mjs';

export function buildEvidenceVerificationCandidates({ root, sourceRoot, structured } = {}) {
  return structured.evidenceItems.map((item) => ({
    id: item.id,
    path: resolveRepoPath(root, item.sourceLocator || item.evidenceRefs?.[0]?.ref || null),
    hash: item.evidenceRefs?.find((ref) => ref.hash)?.hash || null,
    provenance: item.kind || 'observed_evidence',
  })).filter((item) => item.path && item.hash && sourceRoot && pathWithin(sourceRoot, item.path));
}

function buildAttestedEvidenceItems({ academicEvidenceAttestation, now }) {
  if (!academicEvidenceAttestation.academicEvidenceEligible) return [];
  return (academicEvidenceAttestation.verifiedArtifacts || [])
    .filter((item) => item.verified === true)
    .map((item, index) => ({
      id: `attested:${index + 1}:${item.path}`,
      kind: item.kind || 'attested_academic_evidence',
      claimIds: item.claimIds || [],
      path: `${item.scope || 'source'}:${item.path}`,
      hash: item.currentHash,
      verificationStatus: 'evidence_artifact_verified',
      verifiedHash: item.currentHash,
      provenanceReceiptHash:
        academicEvidenceAttestation.academicEvidenceAttestationVerificationHash,
      createdAt: now.toISOString(),
      verificationReceipt: {
        kind: 'EvidenceArtifactVerificationReceipt',
        status: 'evidence_artifact_verified',
        hash: academicEvidenceAttestation.academicEvidenceAttestationVerificationHash,
        createdAt: now.toISOString(),
        claimIds: item.claimIds || [],
        path: `${item.scope || 'source'}:${item.path}`,
      },
    }));
}

function buildCandidateEvidenceItems({ structured, evidenceVerificationReceipts }) {
  const verificationById = new Map(evidenceVerificationReceipts.map(
    (receipt) => [receipt.evidenceId, receipt],
  ));
  return structured.evidenceItems.map((item) => ({
    ...item,
    claimIds: item.claimIds || item.claim_ids || [],
    path: item.sourceLocator || item.evidenceRefs?.[0]?.ref || null,
    hash: item.evidenceRefs?.find((ref) => ref.hash)?.hash || null,
    verificationStatus: verificationById.get(item.id)?.status || 'unverified',
    verifiedHash: verificationById.get(item.id)?.verifiedHash || null,
    provenanceReceiptHash: verificationById.get(item.id)?.provenanceReceiptHash || null,
    createdAt: verificationById.get(item.id)?.createdAt || null,
    verificationReceipt: verificationById.get(item.id) || null,
  }));
}

export function buildResearchEvidenceIntake({
  paperTask,
  structured,
  academicEvidenceAttestation,
  evidenceVerificationReceipts,
  now,
} = {}) {
  const attested = buildAttestedEvidenceItems({ academicEvidenceAttestation, now });
  const candidates = buildCandidateEvidenceItems({ structured, evidenceVerificationReceipts });
  return buildEvidenceIntake({
    paperTask,
    evidenceItems: attested.length ? attested : candidates,
    nowMs: now.getTime(),
  });
}
