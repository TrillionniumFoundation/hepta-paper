import { verifyAuthoritySignatures, verifyAuthorityTimeWindow } from '../authority/authority-signatures.mjs';
import { verifyOperatorDatasetHarnessAuthorityReceiptStructure } from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const MAXIMUM_AUTHORITY_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;

function currentTime(clock) {
  try {
    const value = clock?.now?.();
    const resolved = value instanceof Date ? value : new Date(value);
    if (Number.isFinite(resolved.getTime())) return resolved;
  } catch { /* fail closed below */ }
  return null;
}

export function createOperatorDatasetHarnessAuthorityReceiptVerifier({
  trustStoreProvider = null,
  clock = Object.freeze({ now: () => new Date() }),
} = {}) {
  return (receipt, { dataset = null, selector = null } = {}) => {
    const blockers = [];
    if (!verifyOperatorDatasetHarnessAuthorityReceiptStructure(receipt, { dataset, selector })) {
      blockers.push('operator_dataset_harness_authority_receipt_structure_invalid');
    }
    let trustStore = null;
    try {
      trustStore = typeof trustStoreProvider === 'function' ? trustStoreProvider() : null;
    } catch {
      blockers.push('operator_dataset_authority_trust_store_unreadable');
    }
    const signatureVerification = verifyAuthoritySignatures({
      document: receipt?.authority || null,
      trustStore,
      requiredRoles: ['dataset_harness_operator'],
      minSignatures: 1,
    });
    blockers.push(...signatureVerification.blockers.map((blocker) => `operator_dataset_authority:${blocker}`));
    const now = currentTime(clock);
    if (!now) blockers.push('operator_dataset_authority_verification_time_invalid');
    const timeVerification = verifyAuthorityTimeWindow({
      signedAt: receipt?.authority?.signedAt,
      expiresAt: receipt?.authority?.expiresAt,
      now: now || new Date(Number.NaN),
      maximumLifetimeMs: MAXIMUM_AUTHORITY_LIFETIME_MS,
    });
    blockers.push(...timeVerification.blockers.map((blocker) => `operator_dataset_authority:${blocker}`));
    const authorityVerification = Object.freeze({
      status: blockers.some((blocker) => blocker.startsWith('operator_dataset_authority:'))
        ? 'operator_dataset_authority_blocked'
        : 'operator_dataset_authority_verified',
      cryptographicSignaturesVerified: signatureVerification.cryptographicSignaturesVerified,
      verifiedSignatures: signatureVerification.verifiedSignatures,
      verifiedRoles: signatureVerification.verifiedRoles,
      verifiedSubjectIds: signatureVerification.verifiedSubjectIds,
      timeWindowValid: timeVerification.valid && Boolean(now),
      signedAt: timeVerification.signedAt,
      expiresAt: timeVerification.expiresAt,
    });
    if (receipt?.operatorDatasetAuthorityVerificationHash
      !== hashRecord('OperatorDatasetAuthorityVerification', authorityVerification)
      || JSON.stringify(receipt?.authorityVerification) !== JSON.stringify(authorityVerification)) {
      blockers.push('operator_dataset_authority_verification_summary_invalid');
    }
    const uniqueBlockers = [...new Set(blockers)];
    return Object.freeze({
      status: uniqueBlockers.length
        ? 'operator_dataset_harness_authority_receipt_blocked'
        : 'operator_dataset_harness_authority_receipt_verified',
      verified: uniqueBlockers.length === 0,
      operatorDatasetHarnessAuthorityReceiptHash: receipt?.operatorDatasetHarnessAuthorityReceiptHash || null,
      operatorDatasetAuthorityDocumentHash: receipt?.operatorDatasetAuthorityDocumentHash || null,
      analysisProtocolHash: receipt?.analysisProtocolHash || null,
      verifiedAt: now?.toISOString() || null,
      blockers: uniqueBlockers,
    });
  };
}
