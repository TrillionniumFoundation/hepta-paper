import { verifyIndependentPdfRebuildVerificationReceipt } from '../../paper-domain/automation/independent-pdf-rebuild-contract.mjs';
import { assertIndependentPdfRebuildVerifierPort } from '../../paper-ports/independent-pdf-rebuild-verifier-port.mjs';

export async function executeIndependentCampaignPdfRebuild({
  verifier,
  sourceWorkspace,
  sourceArchiveDefinition,
  campaignId = null,
  rebuildRoot,
  paperId,
  mainTex,
  authoritativePdf,
  createdAt,
  signal = null,
  assertExternalSideEffectReady = null,
} = {}) {
  if (!verifier) throw new Error('campaign_release_independent_pdf_rebuild_verifier_required');
  const trustedVerifier = assertIndependentPdfRebuildVerifierPort(verifier);
  const rebuildInput = {
    sourceWorkspace,
    sourceArchiveDefinition,
    rebuildRoot,
    paperId,
    mainTex,
    authoritativePdf,
    createdAt,
    signal,
  };
  const request = Object.freeze({
    action: 'campaign_independent_pdf_rebuild',
    campaignId,
    paperId,
    sourcePackageContractHash:
      sourceArchiveDefinition?.sourcePackageContractHash || null,
    sourceTreeManifestHash:
      sourceArchiveDefinition?.sourceTreeManifestHash || null,
    sourceWorkspaceManifestHash:
      sourceArchiveDefinition?.sourceWorkspaceManifestHash || null,
    authoritativePdfHash: authoritativePdf?.hash || null,
    mainTex,
  });
  let result;
  if (assertExternalSideEffectReady?.run) {
    result = await assertExternalSideEffectReady.run(
      request,
      ({ externalActionId }) => trustedVerifier.rebuild({
        ...rebuildInput,
        externalActionId,
        idempotencyKey: externalActionId,
      }),
    );
  } else {
    if (assertExternalSideEffectReady) {
      await assertExternalSideEffectReady(request);
      assertExternalSideEffectReady.assertCurrent?.(request);
      await assertExternalSideEffectReady.markStarted?.(request);
    }
    result = await trustedVerifier.rebuild(rebuildInput);
  }
  const verification = verifyIndependentPdfRebuildVerificationReceipt(result?.receipt, {
    paperId,
    sourcePackageContractHash: sourceArchiveDefinition?.sourcePackageContractHash,
    sourceTreeManifestHash: sourceArchiveDefinition?.sourceTreeManifestHash,
    sourceMerkleHash: sourceArchiveDefinition?.archivedSourceMerkleHash,
    sourceWorkspaceManifestHash: sourceArchiveDefinition?.sourceWorkspaceManifestHash,
    mainTex,
    authoritativePdfHash: authoritativePdf?.hash,
  });
  if (result?.status !== 'independent_pdf_rebuild_verified' || !verification.valid || !result?.rebuiltPdfPath) {
    const error = new Error(`campaign_release_independent_pdf_rebuild_blocked:${[
      ...(result?.blockers || []), ...verification.blockers,
    ].join(',')}`);
    error.retryable = false;
    error.receipt = result?.receipt || result;
    throw error;
  }
  return result;
}
