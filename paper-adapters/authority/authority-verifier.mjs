import { assertAuthorityVerifierPort } from '../../paper-ports/authority-verifier-port.mjs';
import { verifyAcademicEvidenceAttestation } from '../research-verify/academic-evidence.mjs';
import { verifyIndependentRefereeAuthority } from '../referee-review/independent-authority.mjs';
import { verifyLiveSubmissionAuthorization } from '../submission/live-authorization.mjs';

export function createAuthorityVerifier() {
  return assertAuthorityVerifierPort(Object.freeze({
    version: 1,
    kind: 'AuthorityVerifierAdapter',
    verifyAcademicEvidence: verifyAcademicEvidenceAttestation,
    verifyIndependentReferee: verifyIndependentRefereeAuthority,
    verifyLiveAuthorization: verifyLiveSubmissionAuthorization,
  }));
}
