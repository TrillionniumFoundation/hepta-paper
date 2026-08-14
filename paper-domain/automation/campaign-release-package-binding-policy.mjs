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

function gpuScientificV3PackageFilesBound({ packageOutput, manifest } = {}) {
  const gpu = manifest?.gpuScientificEvidence;
  if (manifest?.version !== 3 || manifest?.gpuScientificEvidenceIncluded !== true) {
    return manifest?.version === 2;
  }
  const capsuleFiles = (packageOutput?.files || []).filter((item) => (
    item?.role === 'research_evidence_capsule_file'
  ));
  const byCapsuleRole = new Map();
  for (const file of capsuleFiles) {
    if (!file?.capsuleRole || byCapsuleRole.has(file.capsuleRole)) return false;
    byCapsuleRole.set(file.capsuleRole, file);
  }
  const qualification = byCapsuleRole.get(
    'gpu_scientific_campaign_qualification_evidence',
  );
  const archiveManifest = byCapsuleRole.get(
    'gpu_scientific_artifact_body_archive_manifest',
  );
  return qualification?.packageRelativePath === gpu.qualificationEvidencePath
    && qualification?.hash === gpu.qualificationEvidenceFileHash
    && Number(qualification?.bytes) === Number(gpu.qualificationEvidenceFileBytes)
    && archiveManifest?.packageRelativePath
      === gpu.artifactArchiveManifestPath
    && archiveManifest?.hash === gpu.artifactArchiveManifestFileHash
    && Number(archiveManifest?.bytes)
      === Number(gpu.artifactArchiveManifestFileBytes)
    && Array.isArray(gpu.archiveEntries)
    && gpu.archiveEntries.length === 9
    && gpu.archiveEntries.every((entry) => {
      const file = byCapsuleRole.get(entry.role);
      return file?.packageRelativePath === entry.path
        && file?.hash === entry.hash
        && Number(file?.bytes) === Number(entry.bytes);
    });
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
    || !gpuScientificV3PackageFilesBound({
      packageOutput,
      manifest: researchEvidenceCapsuleManifest,
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
