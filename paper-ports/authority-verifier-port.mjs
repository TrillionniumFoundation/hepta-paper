export function assertAuthorityVerifierPort(verifier) {
  for (const method of ['verifyAcademicEvidence', 'verifyIndependentReferee', 'verifyLiveAuthorization']) {
    if (typeof verifier?.[method] !== 'function') throw new Error(`AuthorityVerifierPort.${method} is required`);
  }
  return verifier;
}
