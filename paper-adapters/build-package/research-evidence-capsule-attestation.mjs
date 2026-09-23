export async function attestResearchEvidenceCapsuleManifest({
  researchExecutionReleaseAttestor,
  assertExternalSideEffectReady = null,
  manifest,
  manifestFileHash,
  campaignId,
  paperId,
  signedAt,
} = {}) {
  if (!researchExecutionReleaseAttestor
    || typeof researchExecutionReleaseAttestor.attestCapsuleManifest !== 'function') {
    throw new Error('research_evidence_capsule_execution_release_attestor_required');
  }
  const request = Object.freeze({
    action: 'campaign_release_attestor_sign',
    campaignId,
    paperId,
    manifestFileHash,
    manifestHash: manifest?.researchEvidenceCapsuleManifestHash || null,
  });
  const attest = ({ externalActionId = null } = {}) => (
    researchExecutionReleaseAttestor.attestCapsuleManifest({
      manifest,
      manifestFileHash,
      signedAt,
      externalActionId,
      idempotencyKey: externalActionId,
    })
  );
  if (assertExternalSideEffectReady?.run) {
    return assertExternalSideEffectReady.run(request, attest);
  }
  if (assertExternalSideEffectReady) {
    await assertExternalSideEffectReady(request);
    assertExternalSideEffectReady.assertCurrent?.(request);
    await assertExternalSideEffectReady.markStarted?.(request);
  }
  return attest();
}
