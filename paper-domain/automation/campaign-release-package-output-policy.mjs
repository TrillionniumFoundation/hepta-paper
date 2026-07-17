const REQUIRED_PACKAGE_OUTPUT_ROLES = Object.freeze([
  'compiled_pdf', 'generated_source_zip', 'package_record', 'sha256sums',
  'independent_rebuilt_pdf', 'independent_pdf_rebuild_receipt',
  'research_evidence_capsule_manifest',
]);

export function campaignReleasePackageOutputFilesValid(packageOutput) {
  const files = Array.isArray(packageOutput?.files) ? packageOutput.files : [];
  const requiredRoles = REQUIRED_PACKAGE_OUTPUT_ROLES
    .every((role) => files.filter((item) => item?.role === role).length === 1);
  const capsuleFiles = files.filter((item) => item?.role === 'research_evidence_capsule_file');
  const attestationFiles = files.filter((item) => item?.role === 'research_execution_release_attestation');
  const paths = files.map((item) => item?.path);
  return files.length === Number(packageOutput?.fileCount)
    && requiredRoles && capsuleFiles.length >= 4 && attestationFiles.length <= 1
    && files.every((item) => REQUIRED_PACKAGE_OUTPUT_ROLES.includes(item?.role)
      || item?.role === 'research_evidence_capsule_file'
      || item?.role === 'research_execution_release_attestation')
    && new Set(paths).size === files.length
    && files.every((item) => item?.role && item?.path && item?.hash
      && Number.isFinite(Number(item.bytes)));
}

export function campaignReleaseImmutablePackageLineageValid({
  artifactPackage,
  packageVerificationReceipt,
  packageOutput,
  sourceTreeManifestHash,
} = {}) {
  const files = Array.isArray(packageOutput?.files) ? packageOutput.files : [];
  const artifacts = Array.isArray(artifactPackage?.artifacts) ? artifactPackage.artifacts : [];
  const settlement = Array.isArray(packageVerificationReceipt?.artifactSettlement?.artifacts)
    ? packageVerificationReceipt.artifactSettlement.artifacts : [];
  const verifiedFiles = Array.isArray(packageVerificationReceipt?.verifiedFiles)
    ? packageVerificationReceipt.verifiedFiles : [];
  const archives = Array.isArray(packageVerificationReceipt?.archives)
    ? packageVerificationReceipt.archives : [];
  const fileByRole = new Map(files.map((item) => [item?.role, item]));
  const sourceFile = fileByRole.get('generated_source_zip');
  const compiledFile = fileByRole.get('compiled_pdf');
  const packageRecordFile = fileByRole.get('package_record');
  const sumsFile = fileByRole.get('sha256sums');
  const rebuiltPdfFile = fileByRole.get('independent_rebuilt_pdf');
  const rebuildReceiptFile = fileByRole.get('independent_pdf_rebuild_receipt');
  const sourceArtifacts = artifacts.filter((item) => item?.role === 'generated_source_zip');
  const compiledArtifacts = artifacts.filter((item) => item?.role === 'compiled_pdf');
  const rebuiltPdfArtifacts = artifacts.filter((item) => item?.role === 'independent_rebuilt_pdf');
  const rebuildReceiptArtifacts = artifacts.filter((item) => item?.role === 'independent_pdf_rebuild_receipt');
  const settledByRoleAndHash = new Map(settlement.map((item) => [`${item?.role || ''}\0${item?.hash || ''}`, item]));
  const verifiedByHash = new Map(verifiedFiles.map((item) => [item?.hash, item]));
  const verifiedByPath = new Map(verifiedFiles.map((item) => [item?.path, item]));
  const sourceArchive = archives.find((item) => item?.sourceTreeManifestHash === sourceTreeManifestHash);
  return Boolean(sourceFile?.hash && compiledFile?.hash && rebuiltPdfFile?.hash && rebuildReceiptFile?.hash
    && packageRecordFile?.hash === packageOutput?.packageRecordHash
    && sumsFile?.hash === packageOutput?.sha256SumsHash
    && sourceFile.hash === packageOutput?.sourceZipHash
    && sourceArtifacts.length === 1 && compiledArtifacts.length === 1
    && rebuiltPdfArtifacts.length === 1 && rebuildReceiptArtifacts.length === 1
    && sourceArtifacts[0].hash === sourceFile.hash && compiledArtifacts[0].hash === compiledFile.hash
    && rebuiltPdfArtifacts[0].hash === rebuiltPdfFile.hash
    && rebuildReceiptArtifacts[0].hash === rebuildReceiptFile.hash
    && settledByRoleAndHash.has(`generated_source_zip\0${sourceFile.hash}`)
    && settledByRoleAndHash.has(`compiled_pdf\0${compiledFile.hash}`)
    && settledByRoleAndHash.has(`independent_rebuilt_pdf\0${rebuiltPdfFile.hash}`)
    && settledByRoleAndHash.has(`independent_pdf_rebuild_receipt\0${rebuildReceiptFile.hash}`)
    && verifiedByHash.has(sourceFile.hash) && verifiedByHash.has(rebuiltPdfFile.hash)
    && verifiedByHash.has(rebuildReceiptFile.hash) && sourceArchive && sourceArchive.issues?.length === 0
    && packageVerificationReceipt?.artifactSettlement?.status === 'artifact_settlement_verified'
    && files.filter((item) => item?.packageRelativePath?.startsWith('evidence/'))
      .every((item) => verifiedByPath.get(item.packageRelativePath)?.hash === item.hash));
}
