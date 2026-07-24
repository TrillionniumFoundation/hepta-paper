import {
  buildCryptographicAutonomousSubmissionAuthoritativeNotFoundReceipt,
  buildAutonomousSubmissionDispatchPermit,
  verifyAutonomousSubmissionAuthoritativeNotFoundReceipt,
  verifyAutonomousSubmissionDispatchPermit,
} from '../../paper-domain/automation/autonomous-submission-delivery-contract.mjs';
import {
  assertPinnedExternalEvidenceVerificationReceipt,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';

// These records remain self-describing for audit and persistence diagnostics, but
// authorization comes from object identity in the private WeakSets below. A caller
// cannot mint a usable capability by recomputing a public record hash.
export function createAutonomousSubmissionDispatchAuthority() {
  const dispatchPermits = new WeakSet();
  const authoritativeNotFoundReceipts = new WeakSet();

  const outbox = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionOutboxDispatchCapabilityAuthority',
    issueDispatchPermit(input = {}) {
      const permit = buildAutonomousSubmissionDispatchPermit(input);
      dispatchPermits.add(permit);
      return permit;
    },
    consumeAuthoritativeNotFoundReceipt({ receipt, request, portalId } = {}) {
      if (!receipt || !authoritativeNotFoundReceipts.has(receipt)) {
        throw new Error('autonomous_submission_authoritative_lookup_capability_invalid');
      }
      authoritativeNotFoundReceipts.delete(receipt);
      if (!verifyAutonomousSubmissionAuthoritativeNotFoundReceipt(receipt, {
        request, portalId,
      })) {
        throw new Error('autonomous_submission_authoritative_lookup_capability_invalid');
      }
      return true;
    },
  });

  const portal = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionPortalDispatchCapabilityAuthority',
    issueAuthoritativeNotFoundReceipt(input = {}) {
      const outcomeHash = input?.remoteLookupOutcome
        ?.autonomousSubmissionPortalLookupOutcomeHash || null;
      assertPinnedExternalEvidenceVerificationReceipt(
        input?.signatureVerificationReceipt,
        {
          subjectKind: 'AutonomousSubmissionPortalLookupOutcome',
          subjectHash: outcomeHash,
          requiredRole: 'autonomous_submission_portal',
        },
      );
      const receipt = buildCryptographicAutonomousSubmissionAuthoritativeNotFoundReceipt(input);
      authoritativeNotFoundReceipts.add(receipt);
      return receipt;
    },
    consumeDispatchPermit({ permit, request, portalId } = {}) {
      if (!permit || !dispatchPermits.has(permit)) {
        throw new Error('autonomous_submission_dispatch_capability_invalid');
      }
      dispatchPermits.delete(permit);
      if (!verifyAutonomousSubmissionDispatchPermit(permit, { request, portalId })) {
        throw new Error('autonomous_submission_dispatch_capability_invalid');
      }
      return true;
    },
  });

  return Object.freeze({ version: 1, kind: 'AutonomousSubmissionDispatchAuthority', outbox, portal });
}
