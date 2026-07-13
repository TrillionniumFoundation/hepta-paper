import { verifyAuthoritySignatures, verifyAuthorityTimeWindow } from '../../paper-core/src/authority-signatures.mjs';
import { verifyTrustedLedgerReceipt } from '../../paper-domain/evidence/trusted-ledger-receipt.mjs';
import { verifyArtifactWriteReceiptSource } from '../artifacts/artifact-write-receipt-verifier.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function evidenceRefs(observation = {}) {
  return (Array.isArray(observation?.evidenceRefs) ? observation.evidenceRefs : []).map((item) => ({
    path: item?.path || null,
    hash: item?.hash || null,
    manifestHash: item?.artifactWriteReceipt?.manifestHash || null,
    ledgerReceiptId: item?.ledgerReceiptId || null,
  })).sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

export function buildVenueObservationSubject({ paperTask, venuePlan, observation, purpose = observation?.purpose || 'submission_preflight' } = {}) {
  const subject = {
    version: 1,
    kind: 'ReviewedVenueObservationSubject',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
    provider: observation?.provider || null,
    portalRoute: observation?.portalRoute || null,
    purpose,
    venueTarget: observation?.venueTarget || null,
    track: observation?.track || null,
    deadlineState: observation?.deadlineState || null,
    observedState: observation?.observedState || null,
    observedAt: observation?.observedAt || null,
    expiresAt: observation?.expiresAt || null,
    fetchedPortalState: observation?.fetchedPortalState === true,
    reviewedBy: observation?.reviewedBy || null,
    evidenceHashes: [...new Set((observation?.evidenceHashes || []).map(String))].sort(),
    evidenceRefs: evidenceRefs(observation),
  };
  return Object.freeze({ ...subject, reviewedVenueObservationSubjectHash: hashRecord('ReviewedVenueObservationSubject', subject) });
}

export function verifyReviewedVenueObservationSource({
  paperTask,
  venuePlan,
  observation,
  signedObservation,
  receiptLedger,
  trustStore,
  now = new Date(),
  purpose = observation?.purpose || 'submission_preflight',
  artifactVerifier = verifyArtifactWriteReceiptSource,
} = {}) {
  const blockers = [];
  const subject = buildVenueObservationSubject({ paperTask, venuePlan, observation, purpose });
  if (signedObservation?.version !== 1 || signedObservation?.kind !== 'ReviewedVenueObservationAuthorization') {
    blockers.push('reviewed_venue_observation_authorization_invalid');
  }
  if (signedObservation?.observationSubjectHash !== subject.reviewedVenueObservationSubjectHash) {
    blockers.push('reviewed_venue_observation_subject_mismatch');
  }
  const refs = Array.isArray(observation?.evidenceRefs) ? observation.evidenceRefs : [];
  if (!refs.length) blockers.push('reviewed_venue_evidence_refs_missing');
  const declaredHashes = [...new Set((observation?.evidenceHashes || []).map(String))].sort();
  const referencedHashes = [...new Set(refs.map((item) => String(item?.hash || '')))].sort();
  if (declaredHashes.length !== referencedHashes.length || declaredHashes.some((value, index) => value !== referencedHashes[index])) blockers.push('reviewed_venue_evidence_hash_set_mismatch');
  const ledgerVerifications = refs.map((ref) => {
    const verification = verifyTrustedLedgerReceipt({
      receipt: ref?.artifactWriteReceipt,
      ledgerReceiptId: ref?.ledgerReceiptId,
      receiptLedger,
      expectedKinds: ['ArtifactWriteReceipt'],
      expectedStreams: ['artifact-writes'],
      expectedWriterKinds: ['content-addressed-repository'],
    });
    blockers.push(...verification.blockers.map((item) => `venue_evidence:${item}`));
    if (ref?.artifactWriteReceipt?.hash !== ref?.hash) blockers.push('venue_evidence_content_hash_mismatch');
    if (ref?.artifactWriteReceipt?.path !== ref?.path) blockers.push('venue_evidence_path_mismatch');
    const source = typeof artifactVerifier === 'function'
      ? artifactVerifier({ receipt: ref?.artifactWriteReceipt })
      : { status: 'artifact_write_receipt_source_blocked', blockers: ['artifact_source_verifier_required'] };
    blockers.push(...(source.blockers || []).map((item) => `venue_evidence:${item}`));
    return { ledger: verification, source };
  });
  const signatures = verifyAuthoritySignatures({
    document: signedObservation,
    trustStore,
    requiredRoles: ['venue_observer'],
    minSignatures: 1,
  });
  blockers.push(...signatures.blockers);
  if (!observation?.reviewedBy || !signatures.verifiedSubjectIds.includes(observation.reviewedBy)) blockers.push('reviewed_venue_observer_identity_mismatch');
  const timeWindow = verifyAuthorityTimeWindow({
    signedAt: signedObservation?.signedAt,
    validFrom: signedObservation?.validFrom,
    expiresAt: signedObservation?.expiresAt,
    now,
    maximumLifetimeMs: 24 * 60 * 60 * 1000,
  });
  blockers.push(...timeWindow.blockers);
  const payload = {
    version: 1,
    kind: 'ReviewedVenueObservationSourceVerificationReceipt',
    status: blockers.length ? 'reviewed_venue_observation_source_blocked' : 'reviewed_venue_observation_source_verified',
    paperId: paperTask?.paperId || null,
    observationSubjectHash: subject.reviewedVenueObservationSubjectHash,
    purpose,
    provider: observation?.provider || null,
    portalRoute: observation?.portalRoute || null,
    reviewedBy: observation?.reviewedBy || null,
    evidenceArtifactReceiptHashes: refs.map((item) => item?.artifactWriteReceipt?.writeReceiptHash).filter(Boolean).sort(),
    evidenceLedgerReceiptIds: refs.map((item) => item?.ledgerReceiptId).filter(Boolean).sort(),
    verifiedSubjectIds: signatures.verifiedSubjectIds,
    cryptographicSignaturesVerified: signatures.cryptographicSignaturesVerified,
    ledgerReceiptsVerified: ledgerVerifications.length > 0 && ledgerVerifications.every((item) => item.ledger.status === 'trusted_ledger_receipt_verified'),
    artifactSourcesVerified: ledgerVerifications.length > 0 && ledgerVerifications.every((item) => item.source.status === 'artifact_write_receipt_source_verified'),
    signedAt: timeWindow.signedAt,
    expiresAt: timeWindow.expiresAt,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, reviewedVenueObservationSourceVerificationReceiptHash: hashRecord('ReviewedVenueObservationSourceVerificationReceipt', payload) });
}
