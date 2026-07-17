import fs from 'node:fs';
import path from 'node:path';
import { withArtifactWriteContext } from '../artifacts/artifact-write-context.mjs';
import { createResearchExecutionReleaseAttestor, runPackageAdapter } from '../build-package/index.mjs';
import { createPaperBuildArtifactAcceptance, createPaperTask } from '../../paper-domain/contracts/index.mjs';
import { createAutomationPromotionCandidate, createAutonomousResearchReleaseBinding, createCampaignReleaseBundle, verifyCampaignReleaseBundle } from '../../paper-domain/automation/campaign-release-contracts.mjs';
import { assertCampaignReleasePackagerPort } from '../../paper-ports/campaign-release-packager-port.mjs';
import { fileRecord } from '../../workflow-kernel/runtime/file-utils.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { workspaceExecutionMerkleHash } from '../../workflow-kernel/runtime/workspace-execution-identity.mjs';
import { inspectWorkspaceExecutionSnapshot, sourceTreeExcludedNames } from '../runtime/execution-snapshot.mjs';
import { verifyCampaignResearchSourceSnapshot } from '../../paper-domain/automation/campaign-research-contract.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { createTrustedExperimentRegistryAuthorityVerifier } from '../research-verify/experiment-registry-authority-verifier.mjs';
import { createOperatorDatasetHarnessAuthorityReceiptVerifier } from './operator-dataset-harness-authority-receipt-verifier.mjs';
import {
  assertImmutableCampaignPackageFilesSync,
  campaignReleaseRebuildRootFor,
  campaignReleaseRootFor,
  fsyncCampaignReleasePackageDirectorySync,
  initializeCampaignReleaseRootSync,
  persistCampaignReleaseMaterializationSync,
  readCampaignReleaseMaterializationSync,
} from './campaign-release-materialization.mjs';
import { executeIndependentCampaignPdfRebuild } from './campaign-release-independent-pdf-rebuild.mjs';

export { createResearchExecutionReleaseAttestor };

function manuscriptPath(workspace) {
  for (const name of ['main.tex', 'paper.tex', 'manuscript.tex']) if (fs.existsSync(path.join(workspace, name))) return name;
  return 'main.tex';
}

function fsyncFileSync(candidate) {
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function sourceSnapshotOptions({ workspace, campaign, campaignResearchSourceSnapshot = null } = {}) {
  if (campaignResearchSourceSnapshot) {
    const excludeRoots = (campaignResearchSourceSnapshot.excludedRelativeRoots || []).map((relative) => {
      const candidate = path.resolve(workspace, relative);
      if (!isPathWithin(workspace, candidate) || candidate === workspace) throw new Error('campaign_release_source_snapshot_exclusion_invalid');
      return candidate;
    });
    return Object.freeze({ excludeRoots, excludeNames: [...campaignResearchSourceSnapshot.excludedNames] });
  }
  const excludeRoots = (campaign?.spec?.datasetMounts || []).map((mount) => path.resolve(String(mount.source || '')))
    .filter((source) => source !== workspace && isPathWithin(workspace, source));
  return Object.freeze({ excludeRoots, excludeNames: sourceTreeExcludedNames(workspace) });
}

function inspectReleaseSourceSnapshot(workspace, options) {
  const snapshot = inspectWorkspaceExecutionSnapshot(workspace, options);
  if (snapshot.blockers.length) throw new Error(`campaign_release_source_snapshot_invalid:${snapshot.blockers.join(',')}`);
  return snapshot;
}

function assertSameSourceSnapshot(actual, expected, blocker) {
  if (actual.merkleHash !== expected.merkleHash || actual.manifestHash !== expected.manifestHash) throw new Error(blocker);
}

function sourceArchiveDefinition({ paperId, sourceSnapshot, lineageHash = null } = {}) {
  const files = (sourceSnapshot.fileRecords || []).map((record) => {
    if (/(^|\/)(?:\.env|id_rsa|credentials|secrets?)(?:\.|$)/i.test(record.path)) {
      throw new Error(`campaign_release_source_archive_secret_forbidden:${record.path}`);
    }
    return Object.freeze({ path: record.path, role: record.path === 'main.tex' ? 'main_tex' : 'source_file', required: true });
  });
  const contractSubject = {
    version: 1,
    kind: 'SourcePackageContract',
    paperId,
    files,
    contractFileHash: lineageHash,
  };
  const sourcePackageContractHash = hashRecord('SourcePackageContract', contractSubject);
  const sourcePackageContract = Object.freeze({
    ...contractSubject,
    status: 'source_package_contract_verified',
    blockers: Object.freeze([]),
    sourcePackageContractHash,
  });
  const rows = sourceSnapshot.fileRecords.map((record) => Object.freeze({
    path: record.path,
    role: record.path === 'main.tex' ? 'main_tex' : 'source_file',
    required: true,
    hash: record.hash,
    bytes: record.bytes,
    identityHash: null,
  }));
  const manifestPayload = {
    version: 1,
    kind: 'ScopedSourceTreeManifest',
    status: 'scoped_source_tree_verified',
    sourcePackageContractHash,
    fileCount: rows.length,
    totalBytes: rows.reduce((total, item) => total + item.bytes, 0),
    rows,
    blockers: Object.freeze([]),
  };
  const sourceTreeManifest = Object.freeze({
    ...manifestPayload,
    sourceTreeManifestHash: hashRecord('ScopedSourceTreeManifest', manifestPayload),
  });
  const archivedMerkleHash = workspaceExecutionMerkleHash(rows);
  if (archivedMerkleHash !== sourceSnapshot.merkleHash) throw new Error('campaign_release_source_archive_merkle_mismatch');
  return Object.freeze({
    sourcePackageContractHash,
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    archivedSourceMerkleHash: archivedMerkleHash,
    sourceWorkspaceManifestHash: sourceSnapshot.manifestHash,
    sourcePackageContract,
    sourceTreeManifest,
  });
}

async function compiledPdfRecord(workspace, finalCompileNode) {
  const candidates = [
    ...(finalCompileNode?.result?.materializedPaths || []),
    'main.pdf',
    'paper.pdf',
    'manuscript.pdf',
  ].filter((candidate) => /\.pdf$/i.test(String(candidate)));
  for (const relative of candidates) {
    const candidate = path.resolve(workspace, relative);
    if (!isPathWithin(workspace, candidate)) continue;
    if (!fs.existsSync(candidate)) continue;
    const record = await fileRecord(workspace, candidate, 'compiled_pdf');
    if (record) return record;
  }
  return null;
}

function packageNodeResult(releaseBundle, materializationReceipt) {
  const payload = {
    version: 1,
    kind: 'CampaignReleasePackageResult',
    status: 'campaign_release_prepared',
    campaignId: releaseBundle.campaignId,
    paperId: releaseBundle.paperId,
    packageNodeId: releaseBundle.packageNodeId,
    packageAttemptId: releaseBundle.packageAttemptId,
    campaignPlanHash: releaseBundle.campaignPlanHash,
    campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
    experimentRegistryHash: releaseBundle.experimentRegistryHash || null,
    empiricalAssertionAuthorityHash: releaseBundle.empiricalAssertionAuthorityHash || null,
    empiricalAssertionUniverseHash: releaseBundle.empiricalAssertionUniverseHash || null,
    empiricalAssertionUniverseBindingHash: releaseBundle.empiricalAssertionUniverseBindingHash || null,
    empiricalAssertionManuscriptCorpusHash: releaseBundle.empiricalAssertionManuscriptCorpusHash || null,
    releaseBundle,
    artifactPackage: releaseBundle.artifactPackage,
    packageVerificationReceipt: releaseBundle.packageVerificationReceipt,
    manuscriptPromotionGate: releaseBundle.manuscriptPromotionGate,
    campaignReleaseBundleMaterializationReceiptHash: materializationReceipt.campaignReleaseBundleMaterializationReceiptHash,
    materializationReceipt,
    submitReady: false,
    submissionConsumable: false,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, campaignReleasePackageResultHash: hashRecord('CampaignReleasePackageResult', payload) });
}

export function createCampaignReleasePackager({
  artifactRepositoryFactory,
  store = null,
  receiptLedger = null,
  experimentRegistryAuthorityVerifier: suppliedAuthorityVerifier = null,
  operatorDatasetHarnessAuthorityVerifier: suppliedDatasetAuthorityVerifier = null,
  runtimeRoot: configuredRuntimeRoot = null,
  operatorDatasetAuthorityTrustStoreProvider = null,
  clock = null,
  researchExecutionReleaseAttestor = null,
  independentPdfRebuildVerifier: suppliedPdfRebuildVerifier = null,
  packageAdapter = runPackageAdapter,
} = {}) {
  if (typeof artifactRepositoryFactory !== 'function') throw new Error('Campaign release packager requires ArtifactRepositoryFactory');
  if (typeof packageAdapter !== 'function') throw new Error('Campaign release packager requires runPackageAdapter');
  const configuredReleaseRuntimeRoot = configuredRuntimeRoot
    ? path.resolve(String(configuredRuntimeRoot))
    : null;
  const port = {
    version: 1,
    kind: 'CampaignReleasePackagerPort',
    async packageRelease({ campaign, packageNode, finalCompileNode, researchVerifyNode = null, researchReport = null, sourceWorkspace, runtimeRoot, createdAt, executionSignal = null } = {}) {
      if (executionSignal?.aborted) throw new Error('campaign_release_packaging_cancelled');
      if (!campaign?.campaignId || !campaign?.spec?.campaignPlanHash) throw new Error('campaign_release_campaign_lineage_required');
      if (packageNode?.kind !== 'package') throw new Error('campaign_release_package_node_required');
      if (finalCompileNode?.kind !== 'final-compile' || finalCompileNode.status !== 'completed') throw new Error('campaign_release_final_compile_not_completed');
      const researchVerificationRequired = true;
      const paperQualityProfiles = campaign.spec.paperQualityProfiles || [campaign.spec.paperQualityProfile].filter(Boolean);
      if (researchVerificationRequired) {
        if (researchVerifyNode?.kind !== 'research-verify' || researchVerifyNode.status !== 'completed'
          || !(packageNode.dependencies || []).includes(researchVerifyNode.nodeId)
          || !(researchVerifyNode.dependencies || []).includes(finalCompileNode.nodeId)) throw new Error('campaign_release_research_verification_dependency_required');
        if (!researchVerifyNode.attemptId || !Number.isInteger(researchVerifyNode.leaseGeneration) || researchVerifyNode.leaseGeneration < 1) throw new Error('campaign_release_research_attempt_identity_required');
        if (researchReport?.kind !== 'PaperResearchVerifyReport' || !researchReport.researchReportHash || researchReport.promotionEligibility?.status !== 'research_promotion_ready') throw new Error('campaign_release_research_report_not_promotion_ready');
      }
      if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error('campaign_release_created_at_required');
      const workspace = path.resolve(sourceWorkspace || campaign.spec.sourceWorkspace || '');
      const requestedRuntimeRoot = runtimeRoot
        ? path.resolve(String(runtimeRoot))
        : configuredReleaseRuntimeRoot;
      if (!requestedRuntimeRoot) throw new Error('campaign_release_runtime_root_required');
      if (configuredReleaseRuntimeRoot && requestedRuntimeRoot !== configuredReleaseRuntimeRoot) {
        throw new Error('campaign_release_runtime_root_mismatch');
      }
      const resolvedRuntimeRoot = requestedRuntimeRoot;
      const runtimeTrustStoreProvider = typeof operatorDatasetAuthorityTrustStoreProvider === 'function'
        ? () => operatorDatasetAuthorityTrustStoreProvider({ runtimeRoot: resolvedRuntimeRoot })
        : null;
      const operatorDatasetHarnessAuthorityVerifier = suppliedDatasetAuthorityVerifier
        || (runtimeTrustStoreProvider && typeof clock?.now === 'function'
          ? createOperatorDatasetHarnessAuthorityReceiptVerifier({
            trustStoreProvider: runtimeTrustStoreProvider,
            clock,
          })
          : null);
      const experimentRegistryAuthorityVerifier = suppliedAuthorityVerifier
        || createTrustedExperimentRegistryAuthorityVerifier({
          receiptLedger,
          operatorDatasetHarnessAuthorityVerifier,
          runtimeRoot: resolvedRuntimeRoot,
          operatorDatasetAuthorityTrustStoreProvider: runtimeTrustStoreProvider,
          clock,
        });
      const campaignResearchSourceSnapshot = researchReport?.campaignResearchSourceSnapshot || null;
      if (researchVerificationRequired) {
        const { researchReportHash: claimedResearchReportHash, ...researchReportPayload } = researchReport || {};
        const snapshotVerification = verifyCampaignResearchSourceSnapshot(campaignResearchSourceSnapshot, {
          campaignId: campaign.campaignId,
          paperId: campaign.paperId,
          researchNodeId: researchVerifyNode.nodeId,
          researchAttemptId: researchVerifyNode.attemptId,
          researchLeaseGeneration: researchVerifyNode.leaseGeneration,
          verifiedSourceMerkleHash: researchReport?.verifiedSourceMerkleHash,
          verifiedSourceWorkspaceManifestHash: researchReport?.verifiedSourceWorkspaceManifestHash,
        });
        if (!claimedResearchReportHash || hashPaperRecord('PaperResearchVerifyReport', researchReportPayload) !== claimedResearchReportHash
          || researchVerifyNode?.result?.researchReportHash !== claimedResearchReportHash
          || researchVerifyNode?.result?.report?.researchReportHash !== claimedResearchReportHash
          || !snapshotVerification.valid
          || researchReport?.researchNodeId !== researchVerifyNode.nodeId
          || researchReport?.researchAttemptId !== researchVerifyNode.attemptId
          || researchReport?.researchLeaseGeneration !== researchVerifyNode.leaseGeneration
          || researchVerifyNode?.result?.researchNodeId !== researchVerifyNode.nodeId
          || researchVerifyNode?.result?.researchAttemptId !== researchVerifyNode.attemptId
          || researchVerifyNode?.result?.researchLeaseGeneration !== researchVerifyNode.leaseGeneration
          || researchReport?.campaignResearchSourceSnapshotHash !== campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash
          || researchVerifyNode?.result?.campaignResearchSourceSnapshotHash !== campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash
          || researchVerifyNode?.result?.verifiedSourceMerkleHash !== campaignResearchSourceSnapshot?.verifiedSourceMerkleHash
          || researchVerifyNode?.result?.verifiedSourceWorkspaceManifestHash !== campaignResearchSourceSnapshot?.verifiedSourceWorkspaceManifestHash
          || hashRecord('PaperCampaignNodeResult', researchVerifyNode?.result) !== researchVerifyNode?.resultSha256) {
          throw new Error(`campaign_release_research_source_snapshot_invalid:${snapshotVerification.blockers.join(',')}`);
        }
      }
      const snapshotOptions = sourceSnapshotOptions({ workspace, campaign, campaignResearchSourceSnapshot });
      const packageStartSourceSnapshot = inspectReleaseSourceSnapshot(workspace, snapshotOptions);
      if (campaignResearchSourceSnapshot) {
        if (packageStartSourceSnapshot.merkleHash !== campaignResearchSourceSnapshot.verifiedSourceMerkleHash
          || packageStartSourceSnapshot.manifestHash !== campaignResearchSourceSnapshot.verifiedSourceWorkspaceManifestHash) {
          throw new Error('campaign_release_source_changed_after_research');
        }
      }
      if (!finalCompileNode?.resultSha256 || hashRecord('PaperCampaignNodeResult', finalCompileNode.result) !== finalCompileNode.resultSha256
        || finalCompileNode.result?.sourceMerkleHash !== packageStartSourceSnapshot.merkleHash
        || finalCompileNode.result?.sourceWorkspaceManifestHash !== packageStartSourceSnapshot.manifestHash) {
        throw new Error('campaign_release_final_compile_source_identity_mismatch');
      }
      const archiveDefinition = sourceArchiveDefinition({
        paperId: campaign.paperId,
        sourceSnapshot: packageStartSourceSnapshot,
        lineageHash: campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash || null,
      });
      const releaseRoot = campaignReleaseRootFor(resolvedRuntimeRoot, campaign, packageNode);
      const autonomousResearchReleaseBinding = createAutonomousResearchReleaseBinding({
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        campaignPlanHash: campaign.spec.campaignPlanHash,
        preparation: campaign.spec.autonomousResearchPreparation || null,
        machineIntake: campaign.spec.autonomousResearchMachineIntake || null,
        machineIntakeAdmission:
          campaign.spec.autonomousResearchMachineIntakeAdmission || null,
      });
      const expected = {
        campaignId: campaign.campaignId,
        campaignPlanHash: campaign.spec.campaignPlanHash,
        paperId: campaign.paperId,
        venueTarget: campaign.spec.venueTarget || null,
        packageNodeId: packageNode.nodeId,
        packageAttemptId: packageNode.attemptId,
        researchReportHash: researchReport?.researchReportHash || null,
        proposalClaimToTheoremBindingHash:
          researchReport?.proposalClaimToTheoremBindingHash || null,
        experimentRegistryHash: researchReport?.experimentRegistryHash || null,
        empiricalAssertionAuthorityHash: researchReport?.empiricalAssertionAuthorityHash || null,
        empiricalAssertionUniverseHash: researchReport?.empiricalAssertionUniverseHash || null,
        empiricalAssertionUniverseBindingHash: researchReport?.empiricalAssertionUniverseBindingHash || null,
        empiricalAssertionManuscriptCorpusHash: researchReport?.empiricalAssertionManuscriptCorpusHash || null,
        researchVerifyNodeId: researchVerifyNode?.nodeId || null,
        researchVerifyAttemptId: researchVerifyNode?.attemptId || null,
        researchVerifyLeaseGeneration: researchVerifyNode?.leaseGeneration || null,
        verifiedSourceMerkleHash: packageStartSourceSnapshot.merkleHash,
        verifiedSourceWorkspaceManifestHash: packageStartSourceSnapshot.manifestHash,
        ...(autonomousResearchReleaseBinding ? {
          autonomousResearchReleaseBindingHash:
            autonomousResearchReleaseBinding.autonomousResearchReleaseBindingHash,
        } : {}),
      };
      const existing = readCampaignReleaseMaterializationSync({ runtimeRoot: resolvedRuntimeRoot, releaseRoot });
      if (existing) {
        const verification = verifyCampaignReleaseBundle(existing.bundle, expected, { experimentRegistryAuthorityVerifier });
        if (!verification.valid) throw new Error(`campaign_release_immutable_bundle_invalid:${verification.blockers.join(',')}`);
        assertImmutableCampaignPackageFilesSync(existing.bundle.packageOutput, resolvedRuntimeRoot);
        const materializationReceipt = persistCampaignReleaseMaterializationSync({ runtimeRoot: resolvedRuntimeRoot, releaseRoot, bundle: existing.bundle });
        return packageNodeResult(existing.bundle, materializationReceipt);
      }
      initializeCampaignReleaseRootSync(resolvedRuntimeRoot, releaseRoot);
      const mainTex = manuscriptPath(workspace);
      const builtPdf = await compiledPdfRecord(workspace, finalCompileNode);
      if (!builtPdf) throw new Error('campaign_release_compiled_pdf_required');
      const independentPdfRebuild = await executeIndependentCampaignPdfRebuild({
        verifier: suppliedPdfRebuildVerifier,
        sourceWorkspace: workspace,
        sourceArchiveDefinition: archiveDefinition,
        rebuildRoot: campaignReleaseRebuildRootFor(resolvedRuntimeRoot, campaign, packageNode),
        paperId: campaign.paperId,
        mainTex,
        authoritativePdf: builtPdf,
        createdAt,
        signal: executionSignal,
      });
      const paperTask = createPaperTask({
        paperId: campaign.paperId,
        title: campaign.spec.title || campaign.paperId,
        venueTarget: campaign.spec.venueTarget || null,
        sourceWorkspace: workspace,
        mainTex: path.join(workspace, mainTex),
        paperQualityProfile: campaign.spec.paperQualityProfile || null,
        paperQualityProfiles,
        createdAt,
      });
      const buildArtifactAcceptance = createPaperBuildArtifactAcceptance({
        paperTask,
        execute: true,
        command: [],
        buildDir: path.dirname(path.resolve(workspace, builtPdf.path)),
        sourceWorkspace: workspace,
        mainTex: path.join(workspace, mainTex),
        builtPdf,
        execution: { executed: true, status: 0, signal: null },
        blockers: [],
        warnings: [],
        createdAt,
      });
      const row = {
        task: paperTask,
        state: { compileStatus: 'build_passed' },
        artifacts: { pdfs: [builtPdf] },
      };
      const packageDir = path.join(releaseRoot, 'package');
      const packageResult = await withArtifactWriteContext({ artifactRepositoryFactory }, () => packageAdapter({
        root: workspace,
        row,
        buildResult: { status: 'build_passed', builtPdf, buildArtifactAcceptance },
        researchReport,
        runtimeRoot: resolvedRuntimeRoot,
        execute: true,
        store,
        packageOutputDir: packageDir,
        immutableOutput: true,
        createdAt,
        requirePaperQuality: paperQualityProfiles.length > 0,
        experimentRegistryAuthorityVerifier,
        expectedCampaignId: campaign.campaignId,
        receiptLedger,
        operatorDatasetAuthorityTrustStore: runtimeTrustStoreProvider
          ? runtimeTrustStoreProvider()
          : null,
        researchExecutionReleaseAttestor,
        independentPdfRebuild,
        sourceArchiveDefinition: archiveDefinition,
      }));
      if (executionSignal?.aborted) throw new Error('campaign_release_packaging_cancelled');
      const packageEndSourceSnapshot = inspectReleaseSourceSnapshot(workspace, snapshotOptions);
      assertSameSourceSnapshot(packageEndSourceSnapshot, packageStartSourceSnapshot, 'campaign_release_source_changed_during_packaging');
      if (packageResult?.sourceTreeManifest?.sourceTreeManifestHash !== archiveDefinition.sourceTreeManifestHash
        || packageResult?.sourceTreeManifest?.sourcePackageContractHash !== archiveDefinition.sourcePackageContractHash) {
        throw new Error('campaign_release_source_archive_definition_mismatch');
      }
      if (packageResult.status !== 'package_ready' || packageResult.artifactPackage?.submitReady !== true) {
        const error = new Error(`campaign_release_package_blocked:${(packageResult.blockers || []).join(',')}`);
        error.retryable = false;
        error.receipt = packageResult.packageVerificationReceipt || packageResult.manuscriptPromotionGate || packageResult;
        throw error;
      }
      for (const candidate of [
        packageResult.sourceZip?.path ? path.resolve(packageResult.artifactBaseRoot, packageResult.sourceZip.path) : null,
        packageResult.immutableCompiledPdf?.path ? path.resolve(packageResult.artifactBaseRoot, packageResult.immutableCompiledPdf.path) : null,
        packageResult.packageRecord?.path ? path.join(packageDir, 'PACKAGE_RECORD.json') : null,
        packageResult.sha256Sums?.path ? path.join(packageDir, 'SHA256SUMS.txt') : null,
        packageResult.independentRebuiltPdf?.path
          ? path.resolve(packageResult.artifactBaseRoot, packageResult.independentRebuiltPdf.path) : null,
        packageResult.independentPdfRebuildReceiptRecord?.path
          ? path.resolve(packageResult.artifactBaseRoot, packageResult.independentPdfRebuildReceiptRecord.path) : null,
        ...(packageResult.researchEvidenceCapsule?.allFiles || []).map((file) => path.join(packageDir, file.path)),
      ]) {
        if (candidate) {
          fsyncFileSync(candidate);
          fs.chmodSync(candidate, 0o444);
        }
      }
      fsyncCampaignReleasePackageDirectorySync(packageDir);
      const promotionCandidate = createAutomationPromotionCandidate({
        campaignPlanHash: campaign.spec.campaignPlanHash,
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        venueTarget: campaign.spec.venueTarget || null,
        packageNode,
        finalCompileNode,
        researchVerifyNode,
        researchReport,
        campaignResearchSourceSnapshot,
        verifiedSourceMerkleHash: packageStartSourceSnapshot.merkleHash,
        verifiedSourceWorkspaceManifestHash: packageStartSourceSnapshot.manifestHash,
        sourceWorkspace: workspace,
        sourceSnapshotHash: packageResult.sourceTreeManifest.sourceTreeManifestHash,
        sourceTreeManifest: packageResult.sourceTreeManifest,
        researchEvidenceCapsuleManifest: packageResult.researchEvidenceCapsule?.manifest || null,
        researchExecutionReleaseAttestation:
          packageResult.researchEvidenceCapsule?.researchExecutionReleaseAttestation || null,
        autonomousResearchReleaseBinding,
        createdAt,
        experimentRegistryAuthorityVerifier,
      });
      const packageOutputFiles = [
        ['generated_source_zip', packageResult.sourceZip, packageResult.sourceZip?.path ? path.resolve(packageResult.artifactBaseRoot, packageResult.sourceZip.path) : null],
        ['compiled_pdf', packageResult.immutableCompiledPdf, packageResult.immutableCompiledPdf?.path ? path.resolve(packageResult.artifactBaseRoot, packageResult.immutableCompiledPdf.path) : null],
        ['package_record', packageResult.packageRecord, path.join(packageDir, 'PACKAGE_RECORD.json')],
        ['sha256sums', packageResult.sha256Sums, path.join(packageDir, 'SHA256SUMS.txt')],
        ['independent_rebuilt_pdf', packageResult.independentRebuiltPdf, packageResult.independentRebuiltPdf?.path
          ? path.resolve(packageResult.artifactBaseRoot, packageResult.independentRebuiltPdf.path) : null],
        ['independent_pdf_rebuild_receipt', packageResult.independentPdfRebuildReceiptRecord,
          packageResult.independentPdfRebuildReceiptRecord?.path
            ? path.resolve(packageResult.artifactBaseRoot, packageResult.independentPdfRebuildReceiptRecord.path) : null],
      ].filter(([, record, candidate]) => record?.path && record?.hash && candidate).map(([role, record, candidate]) => Object.freeze({
        role,
        path: candidate,
        hash: record.hash,
        bytes: Number(record.sizeBytes),
      }));
      packageOutputFiles.push(...(packageResult.researchEvidenceCapsule?.allFiles || []).map((record) => Object.freeze({
        role: record.role === 'research_evidence_capsule_manifest'
          ? 'research_evidence_capsule_manifest'
          : record.role === 'research_execution_release_attestation'
            ? 'research_execution_release_attestation'
            : 'research_evidence_capsule_file',
        capsuleRole: record.role,
        executionRole: record.executionRole,
        experimentId: record.experimentId,
        path: path.join(packageDir, record.path),
        packageRelativePath: record.path,
        hash: record.hash,
        bytes: Number(record.bytes),
      })));
      const packageOutputPayload = {
        version: 1,
        kind: 'ImmutableCampaignPackageOutput',
        immutable: true,
        releaseRoot,
        packageDir: packageResult.packageDirAbsolute,
        artifactBaseRoot: packageResult.artifactBaseRoot,
        sourceZipPath: packageResult.sourceZip?.path || null,
        sourceZipHash: packageResult.sourceZip?.hash || null,
        packageRecordPath: packageResult.packageRecord?.path || null,
        packageRecordHash: packageResult.packageRecord?.hash || null,
        sha256SumsPath: packageResult.sha256Sums?.path || null,
        sha256SumsHash: packageResult.sha256Sums?.hash || null,
        authoritativeCompiledPdfHash: packageResult.immutableCompiledPdf?.hash || null,
        independentRebuiltPdfHash: packageResult.independentRebuiltPdf?.hash || null,
        independentPdfRebuildVerificationReceiptHash:
          packageResult.independentPdfRebuildReceipt?.independentPdfRebuildVerificationReceiptHash || null,
        independentPdfRebuildReceiptFileHash: packageResult.independentPdfRebuildReceiptRecord?.hash || null,
        independentPdfRebuildReceipt: packageResult.independentPdfRebuildReceipt || null,
        packageVerificationReceiptHash: packageResult.packageVerificationReceipt.packageVerificationReceiptHash,
        researchEvidenceCapsuleManifestHash: packageResult.researchEvidenceCapsule?.researchEvidenceCapsuleManifestHash || null,
        researchEvidenceCapsuleManifestFileHash: packageResult.researchEvidenceCapsule?.manifestFile?.hash || null,
        researchExecutionReleaseAttestationHash:
          packageResult.researchEvidenceCapsule?.researchExecutionReleaseAttestationHash || null,
        researchExecutionReleaseAttestationFileHash:
          packageResult.researchEvidenceCapsule?.executionAttestationFile?.hash || null,
        files: packageOutputFiles,
        fileCount: packageOutputFiles.length,
        externalActionPerformed: false,
      };
      const packageOutput = Object.freeze({
        ...packageOutputPayload,
        immutableCampaignPackageOutputHash: hashRecord('ImmutableCampaignPackageOutput', packageOutputPayload),
      });
      const releaseBundle = createCampaignReleaseBundle({
        promotionCandidate,
        artifactPackage: packageResult.artifactPackage,
        packageVerificationReceipt: packageResult.packageVerificationReceipt,
        manuscriptPromotionGate: packageResult.manuscriptPromotionGate,
        researchReport,
        researchEvidenceCapsuleManifest: packageResult.researchEvidenceCapsule?.manifest || null,
        researchExecutionReleaseAttestation:
          packageResult.researchEvidenceCapsule?.researchExecutionReleaseAttestation || null,
        packageOutput,
        createdAt,
        experimentRegistryAuthorityVerifier,
      });
      const verification = verifyCampaignReleaseBundle(releaseBundle, expected, { experimentRegistryAuthorityVerifier });
      if (!verification.valid) throw new Error(`campaign_release_bundle_self_verification_failed:${verification.blockers.join(',')}`);
      assertImmutableCampaignPackageFilesSync(releaseBundle.packageOutput, resolvedRuntimeRoot);
      const materializationReceipt = persistCampaignReleaseMaterializationSync({ runtimeRoot: resolvedRuntimeRoot, releaseRoot, bundle: releaseBundle });
      return packageNodeResult(releaseBundle, materializationReceipt);
    },
  };
  return assertCampaignReleasePackagerPort(port);
}
