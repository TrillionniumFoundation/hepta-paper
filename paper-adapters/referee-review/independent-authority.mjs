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

function authorityInbox(runtimeRoot, paperId) {
  return runtimeRoot && paperId
    ? path.join(runtimeRoot, 'authority-inbox', paperId)
    : null;
}

function blockedReceipt({ paperTask, verdictPath, blocker }) {
  const report = {
    version: 1,
    kind: 'IndependentRefereeAuthorityReceipt',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: 'independent_referee_authority_blocked',
    verdict: null,
    acceptanceAuthorityReady: false,
    cryptographicSignaturesVerified: false,
    verdictPath,
    reviewerSubjectIds: [],
    blockers: [blocker],
    safety: {
      independentReviewPerformed: false,
      academicAcceptanceAuthority: false,
      deterministicLocalReview: false,
      externalActionPerformed: false,
    },
  };
  return {
    ...report,
    independentRefereeAuthorityReceiptHash: hashPaperRecord('IndependentRefereeAuthorityReceipt', report),
  };
}

export async function verifyIndependentRefereeAuthority({
  root,
  runtimeRoot,
  sourceRoot,
  paperTask,
  researchReport = null,
  artifactPackage = null,
  venuePlan = null,
  trustStoreOverride = null,
  now = new Date(),
} = {}) {
  const inbox = authorityInbox(runtimeRoot, paperTask?.paperId);
  const verdictFile = inbox ? path.join(inbox, 'INDEPENDENT_REFEREE_VERDICT.json') : null;
  const verdictPath = verdictFile ? path.relative(root, verdictFile).replace(/\\/g, '/') : null;
  const verdictDocument = verdictFile ? await readJsonIfExists(verdictFile) : null;
  if (!verdictDocument) {
    return blockedReceipt({
      paperTask,
      verdictPath,
      blocker: 'independent_referee_verdict_missing',
    });
  }
  const blockers = [];
  if (verdictDocument.version !== 1 || verdictDocument.kind !== 'IndependentRefereeVerdict') {
    blockers.push('independent_referee_verdict_schema_invalid');
  }
  if (verdictDocument.paperId !== paperTask?.paperId) blockers.push('independent_referee_paper_id_mismatch');
  if (verdictDocument.taskKey !== paperTask?.taskKey) blockers.push('independent_referee_task_key_mismatch');
  if (!['accept', 'revise', 'reject'].includes(verdictDocument.verdict)) blockers.push('independent_referee_verdict_invalid');
  if (verdictDocument.reviewer?.independentFromAuthors !== true) blockers.push('referee_not_independent_from_authors');
  if (verdictDocument.reviewer?.conflictOfInterest !== false) blockers.push('referee_conflict_of_interest_not_cleared');
  const trustStore = await loadAuthorityTrustStore({ runtimeRoot, trustStoreOverride });
  const signatureVerification = verifyAuthoritySignatures({
    document: verdictDocument,
    trustStore,
    requiredRoles: ['independent_referee'],
    minSignatures: 1,
  });
  blockers.push(...signatureVerification.blockers);
  const reviewerSubjectIds = signatureVerification.verifiedSubjectIds;
  if (!reviewerSubjectIds.includes(String(verdictDocument.reviewer?.subjectId || ''))) {
    blockers.push('referee_subject_not_bound_to_verified_signature');
  }
  const evidenceSignerIds = new Set(researchReport?.academicEvidenceAttestation?.signerSubjectIds || []);
  if (reviewerSubjectIds.some((subjectId) => evidenceSignerIds.has(subjectId))) {
    blockers.push('referee_not_independent_from_academic_evidence_authority');
  }
  const timeWindow = verifyAuthorityTimeWindow({
    signedAt: verdictDocument.signedAt,
    validFrom: verdictDocument.validFrom,
    expiresAt: verdictDocument.expiresAt,
    now,
    maximumLifetimeMs: 90 * 24 * 60 * 60 * 1000,
  });
  blockers.push(...timeWindow.blockers);
  const sourcePath = sourceRoot && paperTask?.mainTex
    ? path.resolve(root, paperTask.mainTex)
    : null;
  if (!sourcePath || !sourceRoot || !pathWithin(sourceRoot, sourcePath)) {
    blockers.push('independent_referee_source_path_invalid');
  }
  const sourceRecord = sourcePath && sourceRoot && pathWithin(sourceRoot, sourcePath)
    ? await fileRecord(root, sourcePath, 'independent_referee_source_snapshot')
    : null;
  const scope = verdictDocument.reviewScope || {};
  if (!sourceRecord) blockers.push('independent_referee_source_snapshot_missing');
  if (sourceRecord && scope.sourceSha256 !== sourceRecord.hash) blockers.push('independent_referee_source_hash_mismatch');
  const evidenceVerificationHash = researchReport?.academicEvidenceAttestation
    ?.academicEvidenceAttestationVerificationHash || null;
  if (!evidenceVerificationHash || scope.academicEvidenceVerificationHash !== evidenceVerificationHash) {
    blockers.push('independent_referee_academic_evidence_hash_mismatch');
  }
  if (!artifactPackage?.artifactPackageHash
    || scope.artifactPackageHash !== artifactPackage.artifactPackageHash) {
    blockers.push('independent_referee_artifact_package_hash_mismatch');
  }
  if (!venuePlan?.venueSubmissionPlanHash
    || scope.venueSubmissionPlanHash !== venuePlan.venueSubmissionPlanHash) {
    blockers.push('independent_referee_venue_plan_hash_mismatch');
  }
  const reviewArtifact = verdictDocument.reviewArtifact || {};
  const reviewArtifactPath = inbox ? path.resolve(inbox, String(reviewArtifact.path || '')) : null;
  if (!reviewArtifact.path || !reviewArtifactPath || !inbox || !pathWithin(inbox, reviewArtifactPath)) {
    blockers.push('independent_referee_review_artifact_path_invalid');
  }
  const reviewArtifactRecord = reviewArtifactPath && inbox && pathWithin(inbox, reviewArtifactPath)
    ? await fileRecord(root, reviewArtifactPath, 'independent_referee_review_artifact')
    : null;
  if (!reviewArtifactRecord) blockers.push('independent_referee_review_artifact_missing');
  if (reviewArtifactRecord && reviewArtifact.sha256 !== reviewArtifactRecord.hash) {
    blockers.push('independent_referee_review_artifact_hash_mismatch');
  }
  if (verdictDocument.verdict === 'accept' && Number(verdictDocument.blockingFindingCount || 0) !== 0) {
    blockers.push('independent_referee_accept_has_blocking_findings');
  }
  const acceptanceAuthorityReady = blockers.length === 0 && verdictDocument.verdict === 'accept';
  const report = {
    version: 1,
    kind: 'IndependentRefereeAuthorityReceipt',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length
      ? 'independent_referee_authority_blocked'
      : acceptanceAuthorityReady
        ? 'independent_referee_acceptance_verified'
        : 'independent_referee_verdict_verified',
    verdict: verdictDocument.verdict || null,
    acceptanceAuthorityReady,
    cryptographicSignaturesVerified: signatureVerification.cryptographicSignaturesVerified,
    verdictPath,
    verdictDocumentHash: (await fileRecord(root, verdictFile, 'independent_referee_verdict'))?.hash || null,
    reviewerSubjectIds,
    sourceSnapshotHash: sourceRecord?.hash || null,
    academicEvidenceVerificationHash: evidenceVerificationHash,
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
    reviewArtifact: {
      path: reviewArtifact.path || null,
      expectedHash: reviewArtifact.sha256 || null,
      currentHash: reviewArtifactRecord?.hash || null,
      verified: Boolean(reviewArtifactRecord && reviewArtifact.sha256 === reviewArtifactRecord.hash),
    },
    blockingFindingCount: Number(verdictDocument.blockingFindingCount || 0),
    signatureVerification,
    timeWindow,
    blockers: [...new Set(blockers)],
    safety: {
      independentReviewPerformed: blockers.length === 0,
      academicAcceptanceAuthority: acceptanceAuthorityReady,
      deterministicLocalReview: false,
      modelCallPerformed: verdictDocument.reviewer?.reviewMethod === 'external_model',
      humanReviewPerformed: verdictDocument.reviewer?.reviewMethod === 'human',
      sourceMutation: false,
      externalActionPerformed: false,
    },
  };
  return {
    ...report,
    independentRefereeAuthorityReceiptHash: hashPaperRecord('IndependentRefereeAuthorityReceipt', report),
  };
}
