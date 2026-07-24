import { verifyCampaignReleaseEvidenceCapsulePackageOutput } from './campaign-release-evidence-capsule-contract.mjs';
import { matchesRecordHash } from './campaign-release-contract-helpers.mjs';
import {
  campaignReleaseImmutablePackageLineageValid,
  campaignReleasePackageOutputFilesValid,
} from './campaign-release-package-output-policy.mjs';
import { verifyIndependentPdfRebuildVerificationReceipt } from './independent-pdf-rebuild-contract.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

function singleFileForRole(packageOutput, role) {
  const matches = (packageOutput?.files || []).filter((item) => item?.role === role);
  return matches.length === 1 ? matches[0] : null;
}

export function verifyCampaignReleasePackageBinding({
  packageOutput,
  artifactPackage,
  packageVerificationReceipt,
  paperId,
  sourcePackageContractHash,
  sourceTreeManifestHash,
  sourceMerkleHash,
  sourceWorkspaceManifestHash,
  researchEvidenceCapsuleManifest,
  researchExecutionReleaseAttestation = null,
} = {}) {
  const blockers = [];
  const rebuildVerification = verifyIndependentPdfRebuildVerificationReceipt(
    packageOutput?.independentPdfRebuildReceipt,
    {
      paperId,
      sourcePackageContractHash,
      sourceTreeManifestHash,
      sourceMerkleHash,
      sourceWorkspaceManifestHash,
      authoritativePdfHash: packageOutput?.authoritativeCompiledPdfHash,
    },
  );
  const compiledPdfFile = singleFileForRole(packageOutput, 'compiled_pdf');
  const rebuiltPdfFile = singleFileForRole(packageOutput, 'independent_rebuilt_pdf');
  const rebuildReceiptFile = singleFileForRole(packageOutput, 'independent_pdf_rebuild_receipt');
  const rebuildReceiptBytes = packageOutput?.independentPdfRebuildReceipt
    ? Buffer.from(`${JSON.stringify(packageOutput.independentPdfRebuildReceipt, null, 2)}\n`)
    : null;
  if (!rebuildVerification.valid
    || packageOutput?.independentPdfRebuildVerificationReceiptHash
      !== packageOutput?.independentPdfRebuildReceipt?.independentPdfRebuildVerificationReceiptHash
    || packageOutput?.independentRebuiltPdfHash !== packageOutput?.independentPdfRebuildReceipt?.rebuiltPdf?.hash
    || compiledPdfFile?.hash !== packageOutput?.authoritativeCompiledPdfHash
    || rebuiltPdfFile?.hash !== packageOutput?.independentRebuiltPdfHash
    || rebuildReceiptFile?.hash !== packageOutput?.independentPdfRebuildReceiptFileHash
    || !rebuildReceiptBytes || rebuildReceiptFile?.hash !== hashBytes(rebuildReceiptBytes)
    || Number(rebuildReceiptFile?.bytes) !== rebuildReceiptBytes.length) {
    blockers.push('campaign_release_independent_pdf_rebuild_invalid', ...rebuildVerification.blockers);
  }
  if (!matchesRecordHash(packageOutput, 'ImmutableCampaignPackageOutput', 'immutableCampaignPackageOutputHash')
    || !packageOutput?.immutable || !packageOutput?.releaseRoot || !packageOutput?.packageDir
    || !packageOutput?.artifactBaseRoot || !campaignReleasePackageOutputFilesValid(packageOutput)
    || !verifyCampaignReleaseEvidenceCapsulePackageOutput({
      packageOutput,
      manifest: researchEvidenceCapsuleManifest,
      executionAttestation: researchExecutionReleaseAttestation,
    })
    || !campaignReleaseImmutablePackageLineageValid({
      artifactPackage,
      packageVerificationReceipt,
      packageOutput,
      sourceTreeManifestHash,
    })
    || packageOutput?.packageVerificationReceiptHash
      !== packageVerificationReceipt?.packageVerificationReceiptHash) {
    blockers.push('campaign_release_package_output_binding_invalid');
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}
