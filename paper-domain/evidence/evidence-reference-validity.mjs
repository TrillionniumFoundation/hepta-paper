import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function evaluateEvidenceReferenceValidity({
  reference = {},
  expected = {},
  nowMs = Date.now(),
  maximumClockSkewMs = 5 * 60 * 1000,
  maximumAgeMs = null,
} = {}) {
  const blockers = [];
  const warnings = [];
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) blockers.push('evidence_reference_missing');
  const kind = reference?.kind || null;
  const status = reference?.status || null;
  const hash = reference?.hash || reference?.receiptHash || reference?.receipt_sha256 || reference?.provenanceReceiptHash || null;
  const inputHash = reference?.inputHash || reference?.input_hash || null;
  const sourceRevision = reference?.sourceRevision || reference?.source_revision || null;
  const lineageId = reference?.lineageId || reference?.lineage_id || null;
  const environment = reference?.environment || null;
  const releaseCommit = reference?.releaseCommit || reference?.release_commit || null;
  if (expected.kind && kind !== expected.kind) blockers.push('evidence_kind_mismatch');
  if (list(expected.acceptedStatuses).length && !expected.acceptedStatuses.includes(status)) blockers.push('evidence_status_not_accepted');
  if (expected.hash && hash !== expected.hash) blockers.push('evidence_hash_mismatch');
  if (expected.inputHash && inputHash !== expected.inputHash) blockers.push('evidence_input_hash_mismatch');
  if (expected.sourceRevision && sourceRevision !== expected.sourceRevision) blockers.push('evidence_source_revision_mismatch');
  if (expected.lineageId && lineageId !== expected.lineageId) blockers.push('evidence_lineage_mismatch');
  if (expected.environment && environment !== expected.environment) blockers.push('evidence_environment_mismatch');
  if (expected.releaseCommit && releaseCommit !== expected.releaseCommit) blockers.push('evidence_release_commit_mismatch');
  if (!hash) blockers.push('evidence_hash_missing');
  const createdAtMs = Date.parse(reference?.createdAt || reference?.created_at || '');
  if (!Number.isFinite(createdAtMs)) warnings.push('evidence_created_at_missing_or_invalid');
  else {
    if (createdAtMs - nowMs > Math.max(0, Number(maximumClockSkewMs))) blockers.push('evidence_future_dated');
    if (maximumAgeMs !== null && nowMs - createdAtMs > Math.max(0, Number(maximumAgeMs))) blockers.push('evidence_ttl_expired');
  }
  const payload = {
    version: 1,
    kind: 'EvidenceReferenceValidityReport',
    status: blockers.length ? 'evidence_reference_invalid' : 'evidence_reference_valid',
    evidenceKind: kind,
    evidenceStatus: status,
    evidenceHash: hash,
    blockers,
    warnings,
    ttlApplied: maximumAgeMs !== null,
  };
  return Object.freeze({ ...payload, evidenceReferenceValidityHash: hashRecord('EvidenceReferenceValidityReport', payload) });
}
