import {
  autonomousSubmissionCompletedReceiptVerificationPolicyHash,
  buildCryptographicAutonomousSubmissionReceipt,
  verifyCryptographicAutonomousSubmissionReceiptStructure,
} from '../../paper-domain/automation/autonomous-submission-contract.mjs';
import {
  assertPinnedExternalEvidenceVerificationReceipt,
  inspectPinnedExternalEvidenceTrustStore,
  verifyPinnedExternalEvidenceEnvelope,
} from '../authority/pinned-external-evidence-verifier.mjs';
import {
  assertAutonomousSubmissionCompletedReceiptVerifierPort,
} from '../../paper-ports/autonomous-submission-completed-receipt-verifier-port.mjs';

const SUBJECT_KIND = 'AutonomousSubmissionReceiptV5';
const REQUIRED_ROLE = 'autonomous_submission_portal';

function configurationReady(configuration) {
  const trust = inspectPinnedExternalEvidenceTrustStore(
    configuration?.receiptTrustStore,
    {
      requiredRole: configuration?.receiptSignerRole,
      expectedKeyIds: configuration?.receiptSignerKeyIds,
    },
  );
  return [2, 3].includes(configuration?.version)
    && [
      'AutonomousSubmissionPortalConfiguration',
      'AutonomousSubmissionPortalPublicConfiguration',
    ].includes(configuration?.kind)
    && configuration?.receiptSignerRole === REQUIRED_ROLE
    && trust.ready === true
    && trust.trustStoreHash === configuration?.receiptTrustStoreHash
    ? trust : null;
}

export function createAutonomousSubmissionCompletedReceiptVerifier({
  configuration = null,
} = {}) {
  const configuredTrust = configuration ? configurationReady(configuration) : null;
  if (configuration && !configuredTrust) {
    throw new Error('autonomous_submission_completed_receipt_trust_invalid');
  }
  const api = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionCompletedReceiptVerifier',
    cryptographicAuthorityReady: Boolean(configuredTrust),
    configurationHash: configuration?.configurationHash || null,
    trustSetHash: configuredTrust?.trustStoreHash || null,
    signatureVerificationPolicyHash: configuration
      ? autonomousSubmissionCompletedReceiptVerificationPolicyHash(configuration) : null,
    wrapVerifiedReceipt({
      request,
      requestVerifier,
      legacyReceipt,
      authorityEnvelope,
      signatureVerificationReceipt,
    } = {}) {
      if (!configuredTrust) {
        throw new Error('autonomous_submission_completed_receipt_trust_required');
      }
      assertPinnedExternalEvidenceVerificationReceipt(signatureVerificationReceipt, {
        subjectKind: SUBJECT_KIND,
        subjectHash: legacyReceipt?.autonomousSubmissionReceiptHash,
        requiredRole: REQUIRED_ROLE,
      });
      return buildCryptographicAutonomousSubmissionReceipt({
        request,
        requestVerifier,
        legacyReceipt,
        authorityEnvelope,
        signatureVerificationReceipt,
        portalVerificationConfiguration: configuration,
      });
    },
    verify({ receipt, request, requestVerifier } = {}) {
      if (!verifyCryptographicAutonomousSubmissionReceiptStructure(receipt, {
        request,
        requestVerifier,
      })) return false;
      const embeddedConfiguration = receipt.portalVerificationConfiguration;
      if (configuration
        && JSON.stringify(embeddedConfiguration) !== JSON.stringify(configuration)) return false;
      const trust = configurationReady(embeddedConfiguration);
      if (!trust
        || receipt.receiptTrustStoreHash !== trust.trustStoreHash
        || receipt.signatureVerificationPolicyHash
          !== autonomousSubmissionCompletedReceiptVerificationPolicyHash(
            embeddedConfiguration,
          )) return false;
      const replayed = verifyPinnedExternalEvidenceEnvelope({
        envelope: receipt.authorityEnvelope,
        subjectKind: SUBJECT_KIND,
        subjectHash: receipt.legacyReceiptHash,
        trustStore: trust.canonicalTrustStore,
        requiredRole: embeddedConfiguration.receiptSignerRole,
        expectedKeyIds: embeddedConfiguration.receiptSignerKeyIds,
        now: new Date(receipt.signatureVerificationReceipt.verifiedAt),
        maximumLifetimeMs: embeddedConfiguration.receiptMaximumLifetimeMs,
      });
      return replayed.cryptographicAuthorityReady === true
        && JSON.stringify(replayed)
          === JSON.stringify(receipt.signatureVerificationReceipt);
    },
  });
  return assertAutonomousSubmissionCompletedReceiptVerifierPort(api);
}
