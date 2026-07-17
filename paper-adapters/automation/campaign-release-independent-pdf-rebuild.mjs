import { verifyIndependentPdfRebuildVerificationReceipt } from '../../paper-domain/automation/independent-pdf-rebuild-contract.mjs';
import { assertIndependentPdfRebuildVerifierPort } from '../../paper-ports/independent-pdf-rebuild-verifier-port.mjs';

export async function executeIndependentCampaignPdfRebuild({
  verifier,
  sourceWorkspace,
  sourceArchiveDefinition,
  rebuildRoot,
  paperId,
  mainTex,
  authoritativePdf,
  createdAt,
  signal = null,
} = {}) {
  if (!verifier) throw new Error('campaign_release_independent_pdf_rebuild_verifier_required');
  const trustedVerifier = assertIndependentPdfRebuildVerifierPort(verifier);
  const result = await trustedVerifier.rebuild({
    sourceWorkspace,
    sourceArchiveDefinition,
    rebuildRoot,
    paperId,
    mainTex,
    authoritativePdf,
    createdAt,
    signal,
  });
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
