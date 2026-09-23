import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPackageDeletionWriterScopedFilesystemArtifactRepositoryFactory }
  from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { writeJsonFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import { createCampaignReleasePackager } from '../../paper-adapters/automation/campaign-release-packager.mjs';
import {
  campaignReleasePackageRootFor,
  campaignReleaseRebuildRootFor,
  campaignReleaseRootFor,
} from '../../paper-adapters/automation/campaign-release-materialization.mjs';
import { createRuntimeRetentionPackageDeletionFenceRepository }
  from '../../paper-adapters/automation/runtime-retention-package-deletion-fence-repository.mjs';
import { createRuntimeRetentionPackageDeletionWriterBoundary }
  from '../../paper-adapters/automation/runtime-retention-package-deletion-writer-boundary.mjs';
import { inspectWorkspaceExecutionSnapshot, sourceTreeExcludedNames } from '../../paper-adapters/runtime/execution-snapshot.mjs';
import {
  buildIndependentPdfRebuildCommand,
  buildIndependentPdfRebuildToolIdentity,
  buildIndependentPdfRebuildVerificationReceipt,
} from '../../paper-domain/automation/independent-pdf-rebuild-contract.mjs';
import { createIndependentPdfRebuildVerifierCapability }
  from '../../paper-ports/independent-pdf-rebuild-verifier-port.mjs';
import { buildCampaignResearchSourceSnapshot, verifyCampaignResearchSourceSnapshot } from '../../paper-domain/automation/campaign-research-contract.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectDeterministicPdfPageTree }
  from '../../paper-domain/automation/deterministic-pdf-page-tree-parser.mjs';
import { buildDeterministicPdfFixture }
  from './support/deterministic-pdf-fixture.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-source-lineage-'));
  const workspace = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(workspace, 'automation-results', 'final'), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), '\\documentclass{article}\\begin{document}Lineage.\\end{document}\n');
  fs.writeFileSync(path.join(workspace, 'analysis-config.json'), '{"threshold":1}\n');
  fs.writeFileSync(
    path.join(workspace, 'automation-results', 'final', 'main.pdf'),
    buildDeterministicPdfFixture({ marker: 'source-lineage-authoritative' }),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { workspace, runtimeRoot };
}

function workspaceSnapshot(workspace) {
  const snapshot = inspectWorkspaceExecutionSnapshot(workspace, { excludeNames: sourceTreeExcludedNames(workspace) });
  assert.deepEqual(snapshot.blockers, []);
  return snapshot;
}

function finalCompileNode(snapshot) {
  const result = {
    status: 'empirical_execution_completed',
    materializedPaths: ['automation-results/final/main.pdf'],
    sourceMerkleHash: snapshot.merkleHash,
    sourceWorkspaceManifestHash: snapshot.manifestHash,
  };
  return {
    nodeId: 'campaign:final-compile', kind: 'final-compile', status: 'completed',
    result, resultSha256: hashRecord('PaperCampaignNodeResult', result),
  };
}

function packageNode(finalNode, researchNode = null) {
  return {
    nodeId: 'campaign:package', kind: 'package', status: 'running',
    attemptId: `package-${researchNode ? 'profiled' : 'plain'}`,
    leaseGeneration: 1,
    dependencies: [finalNode.nodeId, ...(researchNode ? [researchNode.nodeId] : [])],
  };
}

function profiledResearch({ profile, snapshot, finalCompileNodeId = 'campaign:final-compile' }) {
  const sourceSnapshot = buildCampaignResearchSourceSnapshot({
    campaignId: 'campaign', paperId: 'paper',
    researchNodeId: 'campaign:research-verify',
    researchAttemptId: 'research-attempt-1',
    researchLeaseGeneration: 1,
    verifiedSourceMerkleHash: snapshot.merkleHash,
    verifiedSourceWorkspaceManifestHash: snapshot.manifestHash,
    excludedNames: sourceTreeExcludedNames('.'),
    fileRecords: snapshot.fileRecords,
    directoryRecords: snapshot.directoryRecords,
  });
  const reportPayload = {
    version: 1, kind: 'PaperResearchVerifyReport', paperId: 'paper', taskKey: 'paper:campaign', status: 'verified',
    promotionEligibility: { status: 'research_promotion_ready', blockers: [] },
    researchNodeId: sourceSnapshot.researchNodeId,
    researchAttemptId: sourceSnapshot.researchAttemptId,
    researchLeaseGeneration: sourceSnapshot.researchLeaseGeneration,
    verifiedSourceMerkleHash: sourceSnapshot.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: sourceSnapshot.verifiedSourceWorkspaceManifestHash,
    campaignResearchSourceSnapshotHash: sourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot: sourceSnapshot,
    profile,
  };
  const report = Object.freeze({ ...reportPayload, researchReportHash: hashPaperRecord('PaperResearchVerifyReport', reportPayload) });
  const result = {
    version: 1, kind: 'CampaignResearchVerificationResult', status: 'campaign_research_verification_completed',
    campaignId: 'campaign', paperId: 'paper', researchReportHash: report.researchReportHash,
    researchPromotionStatus: 'research_promotion_ready',
    researchNodeId: sourceSnapshot.researchNodeId,
    researchAttemptId: sourceSnapshot.researchAttemptId,
    researchLeaseGeneration: sourceSnapshot.researchLeaseGeneration,
    verifiedSourceMerkleHash: sourceSnapshot.verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash: sourceSnapshot.verifiedSourceWorkspaceManifestHash,
    campaignResearchSourceSnapshotHash: sourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot: sourceSnapshot,
    report,
  };
  return {
    report,
    node: {
      nodeId: 'campaign:research-verify', kind: 'research-verify', status: 'completed',
      attemptId: 'research-attempt-1', leaseGeneration: 1, result,
      dependencies: [finalCompileNodeId],
      resultSha256: hashRecord('PaperCampaignNodeResult', result),
    },
  };
}

function independentPdfRebuildVerifier() {
  return createIndependentPdfRebuildVerifierCapability(async ({
    sourceWorkspace,
    sourceArchiveDefinition,
    rebuildRoot,
    paperId,
    mainTex,
    authoritativePdf,
    createdAt,
  }) => {
    const output = path.join(rebuildRoot, 'output', path.basename(mainTex, '.tex') + '.pdf');
    const rebuiltPdfBytes = buildDeterministicPdfFixture({
      marker: 'source-lineage-independent-rebuild',
    });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, rebuiltPdfBytes, { flag: 'wx' });
    const rebuiltPdfInspection = inspectDeterministicPdfPageTree(rebuiltPdfBytes);
    const authoritativePdfInspection = inspectDeterministicPdfPageTree(
      fs.readFileSync(path.resolve(sourceWorkspace, authoritativePdf.path)),
    );
    assert.equal(rebuiltPdfInspection.pageCount, authoritativePdfInspection.pageCount);
    const receipt = buildIndependentPdfRebuildVerificationReceipt({
      paperId,
      sourcePackageContractHash: sourceArchiveDefinition.sourcePackageContractHash,
      sourceTreeManifestHash: sourceArchiveDefinition.sourceTreeManifestHash,
      sourceMerkleHash: sourceArchiveDefinition.archivedSourceMerkleHash,
      sourceWorkspaceManifestHash: sourceArchiveDefinition.sourceWorkspaceManifestHash,
      materializedSourceWorkspaceManifestHash: sourceArchiveDefinition.sourceWorkspaceManifestHash,
      mainTex,
      command: buildIndependentPdfRebuildCommand(mainTex),
      toolIdentity: buildIndependentPdfRebuildToolIdentity({
        runnerId: 'source-lineage-fixture-runner',
        runtimeIdentityHash: hashRecord('SourceLineageRuntimeIdentity', {}),
        runtimeType: 'fixture',
        executionClass: 'fixture',
        latexmkExecutableHash: hashRecord('SourceLineageLatexmkExecutable', {}),
      }),
      workerReceiptHash: hashRecord('SourceLineageWorkerReceipt', {}),
      executionProcessIdentityHash: hashRecord('SourceLineageProcessIdentity', {}),
      limits: {
        timeoutMs: 1,
        memoryBytes: 1,
        cpuSeconds: 1,
        maximumPids: 1,
        maximumOutputBytes: 1,
      },
      rebuiltPdf: {
        path: path.basename(output),
        hash: hashBytes(rebuiltPdfBytes),
        bytes: rebuiltPdfBytes.length,
        pageCount: rebuiltPdfInspection.pageCount,
      },
      authoritativePdfHash: authoritativePdf.hash,
      authoritativePdfPageCount: authoritativePdfInspection.pageCount,
      createdAt,
    });
    return Object.freeze({
      version: 1,
      kind: 'IndependentPdfRebuildVerificationResult',
      status: 'independent_pdf_rebuild_verified',
      receipt,
      rebuiltPdfPath: output,
      blockers: Object.freeze([]),
    });
  });
}

function packager(packageAdapter) {
  return createCampaignReleasePackager({
    artifactRepositoryFactory: () => Object.freeze({}),
    independentPdfRebuildVerifier: independentPdfRebuildVerifier(),
    packageAdapter,
  });
}

function academicAuthorityProbeExperiment() {
  const run = (executionRole) => ({
    academicPromotionEligible: true,
    rawArtifactWriteReceipt: null,
    harnessExecutionReceipt: {
      cells: [{ cellId: `${executionRole}-cell` }],
      benchmarkSelector: {
        selectorType: 'authorized_dataset_mount',
        datasetMountName: 'hidden-dataset',
      },
      datasetAuthorizations: [],
      operatorDatasetHarnessAuthority: null,
    },
  });
  return {
    experimentId: 'authority-composition-probe',
    evidenceBinding: {
      kind: 'CampaignExperimentEvidenceBinding',
      authorityEvidence: {
        kind: 'CampaignExperimentEvidenceAuthorityEvidence',
        experimentRunReceipt: run('original'),
        experimentReplayReceipt: { replayRunReceipt: run('independent-replay') },
      },
    },
  };
}

test('release packager rejects missing mandatory adapter dependencies', () => {
  assert.throws(
    () => createCampaignReleasePackager(),
    /Campaign release packager requires ArtifactRepositoryFactory/,
  );
  assert.throws(
    () => createCampaignReleasePackager({
      artifactRepositoryFactory: () => Object.freeze({}),
      packageAdapter: null,
    }),
    /Campaign release packager requires runPackageAdapter/,
  );
});

test('release packager validates lineage, topology, time, and runtime before side effects', async (t) => {
  const campaign = {
    campaignId: 'campaign',
    paperId: 'paper',
    spec: { campaignPlanHash: hashRecord('Plan', { boundary: true }) },
  };
  const finalNode = {
    nodeId: 'campaign:final-compile',
    kind: 'final-compile',
    status: 'completed',
  };
  const researchNode = {
    nodeId: 'campaign:research-verify',
    kind: 'research-verify',
    status: 'completed',
    attemptId: 'research-attempt-1',
    leaseGeneration: 1,
    dependencies: [finalNode.nodeId],
  };
  const releaseNode = {
    nodeId: 'campaign:package',
    kind: 'package',
    attemptId: 'package-attempt-1',
    leaseGeneration: 1,
    dependencies: [researchNode.nodeId],
  };
  const researchReport = {
    kind: 'PaperResearchVerifyReport',
    researchReportHash: hashRecord('BoundaryResearchReport', {}),
    promotionEligibility: { status: 'research_promotion_ready' },
  };
  const validInput = {
    campaign,
    packageNode: releaseNode,
    finalCompileNode: finalNode,
    researchVerifyNode: researchNode,
    researchReport,
    sourceWorkspace: process.cwd(),
    runtimeRoot: path.join(process.cwd(), '.runtime-not-created'),
    createdAt: '2026-07-15T00:00:00.000Z',
  };
  const cases = [
    {
      name: 'pre-aborted execution',
      input: { executionSignal: { aborted: true } },
      error: /campaign_release_packaging_cancelled/,
    },
    {
      name: 'missing campaign plan lineage',
      input: { campaign: { campaignId: 'campaign', spec: {} } },
      error: /campaign_release_campaign_lineage_required/,
    },
    {
      name: 'wrong package node kind',
      input: { packageNode: { ...releaseNode, kind: 'formal' } },
      error: /campaign_release_package_node_required/,
    },
    {
      name: 'unfinished final compile',
      input: { finalCompileNode: { ...finalNode, status: 'running' } },
      error: /campaign_release_final_compile_not_completed/,
    },
    {
      name: 'package dependency omitted',
      input: { packageNode: { ...releaseNode, dependencies: undefined } },
      error: /campaign_release_research_verification_dependency_required/,
    },
    {
      name: 'research dependency omitted',
      input: { researchVerifyNode: { ...researchNode, dependencies: undefined } },
      error: /campaign_release_research_verification_dependency_required/,
    },
    {
      name: 'research attempt identity omitted',
      input: { researchVerifyNode: { ...researchNode, attemptId: null } },
      error: /campaign_release_research_attempt_identity_required/,
    },
    {
      name: 'research report is not promotion ready',
      input: {
        researchReport: {
          ...researchReport,
          promotionEligibility: { status: 'research_promotion_blocked' },
        },
      },
      error: /campaign_release_research_report_not_promotion_ready/,
    },
    {
      name: 'created-at is absent',
      input: { createdAt: null },
      error: /campaign_release_created_at_required/,
    },
    {
      name: 'runtime root is absent',
      input: { runtimeRoot: null },
      error: /campaign_release_runtime_root_required/,
    },
    {
      name: 'runtime root conflicts with configured root',
      configuredRuntimeRoot: path.join(process.cwd(), '.configured-runtime-not-created'),
      input: { runtimeRoot: path.join(process.cwd(), '.other-runtime-not-created') },
      error: /campaign_release_runtime_root_mismatch/,
    },
  ];
  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      let packageCalls = 0;
      const releasePackager = createCampaignReleasePackager({
        artifactRepositoryFactory: () => Object.freeze({}),
        runtimeRoot: candidate.configuredRuntimeRoot,
        async packageAdapter() {
          packageCalls += 1;
          return {};
        },
      });
      await assert.rejects(
        releasePackager.packageRelease({ ...validInput, ...candidate.input }),
        candidate.error,
      );
      assert.equal(packageCalls, 0);
    });
  }
});

test('release packager rejects every research receipt and node binding drift before packaging', async (t) => {
  const { workspace, runtimeRoot } = fixture(t);
  const snapshot = workspaceSnapshot(workspace);
  const finalNode = finalCompileNode(snapshot);
  const baseline = profiledResearch({
    profile: null,
    snapshot,
    finalCompileNodeId: finalNode.nodeId,
  });
  const wrongHash = hashRecord('WrongResearchBinding', {});

  function reboundResearch({
    reportChanges = {},
    resultChanges = {},
    nestedReportChanges = null,
    corruptResultHash = false,
  } = {}) {
    const { researchReportHash: _ignored, ...baselinePayload } = baseline.report;
    const reportPayload = { ...baselinePayload, ...reportChanges };
    const report = {
      ...reportPayload,
      researchReportHash: hashPaperRecord('PaperResearchVerifyReport', reportPayload),
    };
    const result = {
      ...baseline.node.result,
      researchReportHash: report.researchReportHash,
      report: nestedReportChanges ? { ...report, ...nestedReportChanges } : report,
      ...resultChanges,
    };
    return {
      report,
      node: {
        ...baseline.node,
        result,
        resultSha256: corruptResultHash
          ? wrongHash
          : hashRecord('PaperCampaignNodeResult', result),
      },
    };
  }

  const cases = [
    {
      name: 'node result report hash',
      change: { resultChanges: { researchReportHash: wrongHash } },
    },
    {
      name: 'nested report hash',
      change: { nestedReportChanges: { researchReportHash: wrongHash } },
    },
    {
      name: 'snapshot verification',
      change: {
        reportChanges: {
          campaignResearchSourceSnapshot: {
            ...baseline.report.campaignResearchSourceSnapshot,
            campaignId: 'other-campaign',
          },
        },
      },
    },
    {
      name: 'report research node',
      change: { reportChanges: { researchNodeId: 'other:research-verify' } },
    },
    {
      name: 'report research attempt',
      change: { reportChanges: { researchAttemptId: 'other-attempt' } },
    },
    {
      name: 'report research generation',
      change: { reportChanges: { researchLeaseGeneration: 2 } },
    },
    {
      name: 'result research node',
      change: { resultChanges: { researchNodeId: 'other:research-verify' } },
    },
    {
      name: 'result research attempt',
      change: { resultChanges: { researchAttemptId: 'other-attempt' } },
    },
    {
      name: 'result research generation',
      change: { resultChanges: { researchLeaseGeneration: 2 } },
    },
    {
      name: 'report snapshot hash',
      change: { reportChanges: { campaignResearchSourceSnapshotHash: wrongHash } },
    },
    {
      name: 'result snapshot hash',
      change: { resultChanges: { campaignResearchSourceSnapshotHash: wrongHash } },
    },
    {
      name: 'result source merkle hash',
      change: { resultChanges: { verifiedSourceMerkleHash: wrongHash } },
    },
    {
      name: 'result workspace manifest hash',
      change: { resultChanges: { verifiedSourceWorkspaceManifestHash: wrongHash } },
    },
    {
      name: 'result record hash',
      change: { corruptResultHash: true },
    },
  ];

  for (const candidate of cases) {
    await t.test(candidate.name, async () => {
      const research = reboundResearch(candidate.change);
      let packageCalls = 0;
      const releasePackager = packager(async () => {
        packageCalls += 1;
        return {};
      });
      await assert.rejects(releasePackager.packageRelease({
        campaign: {
          campaignId: 'campaign',
          paperId: 'paper',
          spec: {
            campaignPlanHash: hashRecord('Plan', { binding: candidate.name }),
            sourceWorkspace: workspace,
          },
        },
        packageNode: packageNode(finalNode, research.node),
        finalCompileNode: finalNode,
        researchVerifyNode: research.node,
        researchReport: research.report,
        sourceWorkspace: workspace,
        runtimeRoot,
        createdAt: '2026-07-15T00:00:00.000Z',
      }), /campaign_release_research_source_snapshot_invalid/);
      assert.equal(packageCalls, 0);
    });
  }
});

test('release packager fails closed across post-build package boundaries', async (t) => {
  const cases = [
    {
      name: 'compiled PDF is missing',
      beforeCall({ workspace }) {
        fs.unlinkSync(path.join(workspace, 'automation-results', 'final', 'main.pdf'));
      },
      expected: /campaign_release_compiled_pdf_required/,
    },
    {
      name: 'execution is cancelled by the package adapter',
      executionSignal: { aborted: false },
      packageResult(input, executionSignal) {
        executionSignal.aborted = true;
        return {
          status: 'package_ready',
          sourceTreeManifest: input.sourceArchiveDefinition.sourceTreeManifest,
        };
      },
      expected: /campaign_release_packaging_cancelled/,
    },
    {
      name: 'adapter returns a different source archive identity',
      packageResult() {
        return {
          status: 'package_ready',
          sourceTreeManifest: {
            sourceTreeManifestHash: hashRecord('WrongSourceTreeManifest', {}),
            sourcePackageContractHash: hashRecord('WrongSourcePackageContract', {}),
          },
        };
      },
      expected: /campaign_release_source_archive_definition_mismatch/,
    },
    {
      name: 'adapter returns a blocked package',
      packageResult(input) {
        return {
          status: 'package_blocked',
          sourceTreeManifest: input.sourceArchiveDefinition.sourceTreeManifest,
          artifactPackage: { submitReady: false },
          blockers: ['fixture_package_blocker'],
        };
      },
      expected: /campaign_release_package_blocked:fixture_package_blocker/,
    },
  ];
  for (const candidate of cases) {
    await t.test(candidate.name, async (nested) => {
      const { workspace, runtimeRoot } = fixture(nested);
      const snapshot = workspaceSnapshot(workspace);
      const finalNode = finalCompileNode(snapshot);
      const research = profiledResearch({
        profile: null,
        snapshot,
        finalCompileNodeId: finalNode.nodeId,
      });
      candidate.beforeCall?.({ workspace });
      let packageCalls = 0;
      const executionSignal = candidate.executionSignal
        ? { ...candidate.executionSignal }
        : null;
      const releasePackager = createCampaignReleasePackager({
        artifactRepositoryFactory: () => Object.freeze({}),
        independentPdfRebuildVerifier: independentPdfRebuildVerifier(),
        runtimeRoot,
        async packageAdapter(input) {
          packageCalls += 1;
          return candidate.packageResult(input, executionSignal);
        },
      });
      await assert.rejects(releasePackager.packageRelease({
        campaign: {
          campaignId: 'campaign',
          paperId: 'paper',
          spec: {
            campaignPlanHash: hashRecord('Plan', { boundary: candidate.name }),
            sourceWorkspace: workspace,
          },
        },
        packageNode: packageNode(finalNode, research.node),
        finalCompileNode: finalNode,
        researchVerifyNode: research.node,
        researchReport: research.report,
        createdAt: '2026-07-15T00:00:00.000Z',
        executionSignal,
      }), candidate.expected);
      assert.equal(packageCalls, candidate.packageResult ? 1 : 0);
    });
  }
});

test('formal and empirical profile releases reject non-output source mutation after research', async (t) => {
  for (const profile of ['formal_theorem_or_proof', 'empirical_or_experiment']) {
    const { workspace, runtimeRoot } = fixture(t);
    const snapshot = workspaceSnapshot(workspace);
    const research = profiledResearch({ profile, snapshot });
    const finalNode = finalCompileNode(snapshot);
    const node = packageNode(finalNode, research.node);
    fs.writeFileSync(path.join(workspace, 'analysis-config.json'), `{"threshold":2,"profile":"${profile}"}\n`);
    let packageCalls = 0;
    await assert.rejects(packager(async () => { packageCalls += 1; return {}; }).packageRelease({
      campaign: { campaignId: 'campaign', paperId: 'paper', spec: { campaignPlanHash: hashRecord('Plan', { profile }), sourceWorkspace: workspace, paperQualityProfile: profile } },
      packageNode: node, finalCompileNode: finalNode, researchVerifyNode: research.node, researchReport: research.report,
      sourceWorkspace: workspace, runtimeRoot, createdAt: '2026-07-15T00:00:00.000Z',
    }), /campaign_release_source_changed_after_research/);
    assert.equal(packageCalls, 0);
  }
});

test('release rejects final-compile source identity mismatch before packaging', async (t) => {
  const { workspace, runtimeRoot } = fixture(t);
  const snapshot = workspaceSnapshot(workspace);
  const finalNode = finalCompileNode(snapshot);
  const research = profiledResearch({ profile: null, snapshot, finalCompileNodeId: finalNode.nodeId });
  finalNode.result = { ...finalNode.result, sourceMerkleHash: hashRecord('WrongSource', {}) };
  finalNode.resultSha256 = hashRecord('PaperCampaignNodeResult', finalNode.result);
  let packageCalls = 0;
  await assert.rejects(packager(async () => { packageCalls += 1; return {}; }).packageRelease({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { campaignPlanHash: hashRecord('Plan', {}), sourceWorkspace: workspace } },
    packageNode: packageNode(finalNode, research.node), finalCompileNode: finalNode,
    researchVerifyNode: research.node, researchReport: research.report,
    sourceWorkspace: workspace, runtimeRoot, createdAt: '2026-07-15T00:00:00.000Z',
  }), /campaign_release_final_compile_source_identity_mismatch/);
  assert.equal(packageCalls, 0);
});

test('release recomputes the full workspace after package adapter execution', async (t) => {
  const { workspace, runtimeRoot } = fixture(t);
  const snapshot = workspaceSnapshot(workspace);
  const finalNode = finalCompileNode(snapshot);
  const research = profiledResearch({ profile: null, snapshot, finalCompileNodeId: finalNode.nodeId });
  await assert.rejects(packager(async () => {
    fs.writeFileSync(path.join(workspace, 'analysis-config.json'), '{"threshold":3}\n');
    return { status: 'package_ready' };
  }).packageRelease({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { campaignPlanHash: hashRecord('Plan', { during: true }), sourceWorkspace: workspace } },
    packageNode: packageNode(finalNode, research.node), finalCompileNode: finalNode,
    researchVerifyNode: research.node, researchReport: research.report,
    sourceWorkspace: workspace, runtimeRoot, createdAt: '2026-07-15T00:00:00.000Z',
  }), /campaign_release_source_changed_during_packaging/);
});

test('manually composed release packager adopts the artifact factory writer scope for CAS and receipts', async (t) => {
  const { workspace, runtimeRoot } = fixture(t);
  const snapshot = workspaceSnapshot(workspace);
  const finalNode = finalCompileNode(snapshot);
  const research = profiledResearch({
    profile: null,
    snapshot,
    finalCompileNodeId: finalNode.nodeId,
  });
  const campaign = {
    campaignId: 'campaign',
    paperId: 'paper',
    spec: {
      campaignPlanHash: hashRecord('Plan', { writer: 'reentrant' }),
      sourceWorkspace: workspace,
    },
  };
  const node = packageNode(finalNode, research.node);
  const boundary = createRuntimeRetentionPackageDeletionWriterBoundary({ runtimeRoot });
  const receipts = [];
  const receiptLedger = Object.freeze({
    record(receipt, context) {
      receipts.push({ receipt, context });
      return Object.freeze({ receiptId: `writer-receipt-${receipts.length}` });
    },
  });
  const clock = Object.freeze({
    now: () => new Date('2026-08-20T08:30:00.000Z'),
    nowIso: () => '2026-08-20T08:30:00.000Z',
  });
  const operationId = 'manual-release-packager:test-process';
  const artifactRepositoryFactory =
    createPackageDeletionWriterScopedFilesystemArtifactRepositoryFactory({
      casRoot: path.join(runtimeRoot, 'artifact-cas'),
      receiptLedger,
      clock,
      runtimeRoot,
      packageDeletionWriterBoundary: boundary,
      packageDeletionWriterOperationId: operationId,
    });
  let nestedTarget = null;
  const releasePackager = createCampaignReleasePackager({
    artifactRepositoryFactory,
    receiptLedger,
    independentPdfRebuildVerifier: independentPdfRebuildVerifier(),
    clock,
    async packageAdapter(input) {
      fs.mkdirSync(input.packageOutputDir, { recursive: true });
      nestedTarget = path.join(input.packageOutputDir, 'WRITER_BOUNDARY_PROBE.json');
      await writeJsonFile(nestedTarget, { nested: true }, {
        scopeRoot: input.packageOutputDir,
        role: 'writer-boundary-probe',
      });
      throw new Error('campaign_release_writer_boundary_probe_complete');
    },
  });
  await assert.rejects(releasePackager.packageRelease({
    campaign,
    packageNode: node,
    finalCompileNode: finalNode,
    researchVerifyNode: research.node,
    researchReport: research.report,
    sourceWorkspace: workspace,
    runtimeRoot,
    createdAt: '2026-08-20T08:30:00.000Z',
  }), /campaign_release_writer_boundary_probe_complete/);
  assert.equal(fs.existsSync(nestedTarget), true);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].context.stream, 'artifact-writes');
});

test('release packaging leaves no materialization residue under active or deleted package fences', async (t) => {
  for (const terminal of [false, true]) {
    await t.test(terminal ? 'deleted fence' : 'active fence', async (nested) => {
      const { workspace, runtimeRoot } = fixture(nested);
      const snapshot = workspaceSnapshot(workspace);
      const finalNode = finalCompileNode(snapshot);
      const research = profiledResearch({
        profile: null,
        snapshot,
        finalCompileNodeId: finalNode.nodeId,
      });
      const campaign = {
        campaignId: 'campaign',
        paperId: 'paper',
        spec: {
          campaignPlanHash: hashRecord('Plan', { terminal }),
          sourceWorkspace: workspace,
        },
      };
      const node = packageNode(finalNode, research.node);
      const packagePath = campaignReleasePackageRootFor(runtimeRoot, campaign, node);
      const rebuildRoot = campaignReleaseRebuildRootFor(runtimeRoot, campaign, node);
      const releaseRoot = campaignReleaseRootFor(runtimeRoot, campaign, node);
      const lifecycleHash = hashRecord('PackageLifecycleReceipt', { terminal });
      const fence = createRuntimeRetentionPackageDeletionFenceRepository({
        runtimeRoot,
        randomToken: () => 'opaque-packager-writer-fence-token-0000000000000001',
      });
      const prepared = fence.prepare({
        packageLifecycleReceiptHash: lifecycleHash,
        packagePath,
        packageContentHash: hashRecord('PackageContent', { terminal }),
        deletionIntentHash: hashRecord('DeletionIntent', { terminal }),
        recoveryBindingHash: hashRecord('RecoveryBinding', { terminal }),
        authoritySnapshotHash: hashRecord('AuthoritySnapshot', { terminal }),
        operationId: `packager-writer:${terminal}`,
        transitionId: hashRecord('FenceTransition', { terminal, status: 'prepared' }),
        preparedAt: '2026-08-20T09:00:00.000Z',
        expectedPreviousFenceHash: null,
        fenceToken: 'opaque-packager-writer-fence-token-0000000000000001',
      });
      if (terminal) {
        const deleting = fence.transition(prepared.handle, {
          expectedRecordHash: prepared.record.runtimeRetentionPackageDeletionFenceHash,
          status: 'deleting',
          transitionedAt: '2026-08-20T09:01:00.000Z',
          transitionId: hashRecord('FenceTransition', { terminal, status: 'deleting' }),
        });
        fence.transition(deleting.handle, {
          expectedRecordHash: deleting.record.runtimeRetentionPackageDeletionFenceHash,
          status: 'deleted',
          transitionedAt: '2026-08-20T09:02:00.000Z',
          transitionId: hashRecord('FenceTransition', { terminal, status: 'deleted' }),
        });
      }
      let packageCalls = 0;
      const writerBoundary =
        createRuntimeRetentionPackageDeletionWriterBoundary({ runtimeRoot });
      const artifactRepositoryFactory =
        createPackageDeletionWriterScopedFilesystemArtifactRepositoryFactory({
          casRoot: path.join(runtimeRoot, 'artifact-cas'),
          receiptLedger: Object.freeze({ record() { return {}; } }),
          clock: Object.freeze({ now: () => new Date(), nowIso: () => new Date().toISOString() }),
          runtimeRoot,
          packageDeletionWriterBoundary: writerBoundary,
          packageDeletionWriterOperationId: `manual-release-packager:${terminal}`,
        });
      const releasePackager = createCampaignReleasePackager({
        artifactRepositoryFactory,
        independentPdfRebuildVerifier: independentPdfRebuildVerifier(),
        async packageAdapter() {
          packageCalls += 1;
          return {};
        },
      });
      await assert.rejects(releasePackager.packageRelease({
        campaign,
        packageNode: node,
        finalCompileNode: finalNode,
        researchVerifyNode: research.node,
        researchReport: research.report,
        sourceWorkspace: workspace,
        runtimeRoot,
        createdAt: '2026-08-20T09:00:00.000Z',
      }), terminal ? /package_deleted/ : /reachability_mutation_blocked/);
      assert.equal(packageCalls, 0);
      assert.equal(fs.existsSync(packagePath), false);
      assert.equal(fs.existsSync(rebuildRoot), false);
      assert.equal(fs.existsSync(releaseRoot), false);
    });
  }
});

test('release fails closed before packaging when no independent PDF rebuild verifier is composed', async (t) => {
  const { workspace, runtimeRoot } = fixture(t);
  const snapshot = workspaceSnapshot(workspace);
  const finalNode = finalCompileNode(snapshot);
  const research = profiledResearch({ profile: null, snapshot, finalCompileNodeId: finalNode.nodeId });
  let packageCalls = 0;
  const releasePackager = createCampaignReleasePackager({
    artifactRepositoryFactory: () => Object.freeze({}),
    async packageAdapter() {
      packageCalls += 1;
      return { status: 'package_ready' };
    },
  });
  await assert.rejects(releasePackager.packageRelease({
    campaign: {
      campaignId: 'campaign',
      paperId: 'paper',
      spec: { campaignPlanHash: hashRecord('Plan', { verifier: false }), sourceWorkspace: workspace },
    },
    packageNode: packageNode(finalNode, research.node),
    finalCompileNode: finalNode,
    researchVerifyNode: research.node,
    researchReport: research.report,
    sourceWorkspace: workspace,
    runtimeRoot,
    createdAt: '2026-07-15T00:00:00.000Z',
  }), /campaign_release_independent_pdf_rebuild_verifier_required/);
  assert.equal(packageCalls, 0);
});

test('default release packager composes runtime trust and dataset verification without registry-verifier injection', async (t) => {
  const { workspace, runtimeRoot } = fixture(t);
  const snapshot = workspaceSnapshot(workspace);
  const finalNode = finalCompileNode(snapshot);
  const research = profiledResearch({ profile: null, snapshot, finalCompileNodeId: finalNode.nodeId });
  const trustStore = Object.freeze({ version: 1, kind: 'AuthorityTrustStore', keys: Object.freeze([]) });
  const clock = Object.freeze({ now: () => new Date('2026-07-15T00:00:00.000Z') });
  let trustStoreReads = 0;
  let datasetVerifierCalls = 0;
  const releasePackager = createCampaignReleasePackager({
    artifactRepositoryFactory: () => Object.freeze({}),
    independentPdfRebuildVerifier: independentPdfRebuildVerifier(),
    runtimeRoot,
    clock,
    operatorDatasetAuthorityTrustStoreProvider(context) {
      assert.equal(context.runtimeRoot, runtimeRoot);
      trustStoreReads += 1;
      return trustStore;
    },
    operatorDatasetHarnessAuthorityVerifier() {
      datasetVerifierCalls += 1;
      return Object.freeze({
        status: 'operator_dataset_harness_authority_receipt_blocked',
        verified: false,
        blockers: Object.freeze(['probe_authority_receipt_expected_invalid']),
      });
    },
    async packageAdapter(options) {
      assert.equal(options.operatorDatasetAuthorityTrustStore, trustStore);
      const verification = options.experimentRegistryAuthorityVerifier(
        academicAuthorityProbeExperiment(),
        { expectedPaperId: 'paper', campaignId: 'campaign' },
      );
      assert.equal(verification.verified, false);
      assert.equal(verification.blockers.some((blocker) => blocker.includes('trusted_verifier_required')), false);
      assert.equal(verification.blockers.some((blocker) => blocker.includes('primitive_fixture_private_resolver_context_required')), false);
      throw new Error('campaign_release_authority_composition_probe_complete');
    },
  });
  await assert.rejects(releasePackager.packageRelease({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { campaignPlanHash: hashRecord('Plan', { authority: true }), sourceWorkspace: workspace } },
    packageNode: packageNode(finalNode, research.node), finalCompileNode: finalNode,
    researchVerifyNode: research.node, researchReport: research.report,
    sourceWorkspace: workspace, runtimeRoot, createdAt: '2026-07-15T00:00:00.000Z',
  }), /campaign_release_authority_composition_probe_complete/);
  assert.equal(datasetVerifierCalls, 2);
  assert.ok(trustStoreReads >= 3);
});

test('release packager authority construction fails closed when machine trust inputs are absent', async (t) => {
  const { workspace, runtimeRoot } = fixture(t);
  const snapshot = workspaceSnapshot(workspace);
  const finalNode = finalCompileNode(snapshot);
  const research = profiledResearch({ profile: null, snapshot, finalCompileNodeId: finalNode.nodeId });
  const releasePackager = createCampaignReleasePackager({
    artifactRepositoryFactory: () => Object.freeze({}),
    independentPdfRebuildVerifier: independentPdfRebuildVerifier(),
    async packageAdapter(options) {
      assert.equal(options.operatorDatasetAuthorityTrustStore, null);
      const verification = options.experimentRegistryAuthorityVerifier(
        academicAuthorityProbeExperiment(),
        { expectedPaperId: 'paper', campaignId: 'campaign' },
      );
      assert.equal(verification.verified, false);
      assert.ok(verification.blockers.some((blocker) => blocker.includes('trusted_verifier_required')));
      assert.ok(verification.blockers.some((blocker) => blocker.includes('primitive_fixture_private_resolver_context_required')));
      throw new Error('campaign_release_missing_authority_context_probe_complete');
    },
  });
  await assert.rejects(releasePackager.packageRelease({
    campaign: { campaignId: 'campaign', paperId: 'paper', spec: { campaignPlanHash: hashRecord('Plan', { authority: false }), sourceWorkspace: workspace } },
    packageNode: packageNode(finalNode, research.node), finalCompileNode: finalNode,
    researchVerifyNode: research.node, researchReport: research.report,
    sourceWorkspace: workspace, runtimeRoot, createdAt: '2026-07-15T00:00:00.000Z',
  }), /campaign_release_missing_authority_context_probe_complete/);
});

test('automation bootstrap forwards the complete machine authority context to the release packager', () => {
  const bootstrapPath = new URL('../../paper-composition/bootstrap/automation-context-bootstrap.mjs', import.meta.url);
  const source = fs.readFileSync(bootstrapPath, 'utf8');
  const releasePackagerStart = source.indexOf('releasePackager:');
  const compositionStart = source.indexOf('createCampaignReleasePackager({', releasePackagerStart);
  const compositionEnd = source.indexOf('    }),', compositionStart);
  assert.ok(releasePackagerStart >= 0 && compositionStart > releasePackagerStart && compositionEnd > compositionStart);
  const composition = source.slice(compositionStart, compositionEnd);
  for (const input of [
    'operatorDatasetHarnessAuthorityVerifier',
    'runtimeRoot',
    'operatorDatasetAuthorityTrustStoreProvider',
    'clock',
    'researchExecutionReleaseAttestor',
  ]) assert.match(composition, new RegExp(`\\n\\s*${input},`), input);
  assert.doesNotMatch(composition, /\n\s*experimentRegistryAuthorityVerifier,/);
});

test('research snapshot rejects cross-campaign replay and record-level identity tampering', (t) => {
  const { workspace } = fixture(t);
  const snapshot = workspaceSnapshot(workspace);
  const research = profiledResearch({ profile: 'formal_theorem_or_proof', snapshot });
  const sourceSnapshot = research.report.campaignResearchSourceSnapshot;
  assert.deepEqual(verifyCampaignResearchSourceSnapshot(sourceSnapshot, {
    campaignId: 'other-campaign',
    paperId: 'paper',
    researchNodeId: 'campaign:research-verify',
    researchAttemptId: 'research-attempt-1',
    researchLeaseGeneration: 1,
  }), {
    valid: false,
    blockers: ['campaign_research_source_snapshot_campaign_mismatch'],
  });
  const tampered = {
    ...sourceSnapshot,
    fileRecords: sourceSnapshot.fileRecords.map((record, index) => index === 0
      ? { ...record, hash: hashRecord('TamperedResearchSourceFile', {}) }
      : record),
  };
  const verification = verifyCampaignResearchSourceSnapshot(tampered, {
    campaignId: 'campaign', paperId: 'paper', researchNodeId: 'campaign:research-verify',
    researchAttemptId: 'research-attempt-1', researchLeaseGeneration: 1,
  });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('campaign_research_source_snapshot_record_identity_mismatch'));
  assert.ok(verification.blockers.includes('campaign_research_source_snapshot_hash_invalid'));
});
