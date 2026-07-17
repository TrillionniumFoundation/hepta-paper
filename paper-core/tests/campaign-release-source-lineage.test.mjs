import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCampaignReleasePackager } from '../../paper-adapters/automation/campaign-release-packager.mjs';
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
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-source-lineage-'));
  const workspace = path.join(root, 'source');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(workspace, 'automation-results', 'final'), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), '\\documentclass{article}\\begin{document}Lineage.\\end{document}\n');
  fs.writeFileSync(path.join(workspace, 'analysis-config.json'), '{"threshold":1}\n');
  fs.writeFileSync(path.join(workspace, 'automation-results', 'final', 'main.pdf'), '%PDF-1.4\nlineage\n');
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
    nodeId: 'campaign:package', kind: 'package', status: 'running', attemptId: `package-${researchNode ? 'profiled' : 'plain'}`,
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
    sourceArchiveDefinition,
    rebuildRoot,
    paperId,
    mainTex,
    authoritativePdf,
    createdAt,
  }) => {
    const output = path.join(rebuildRoot, 'output', path.basename(mainTex, '.tex') + '.pdf');
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
        hash: hashRecord('SourceLineageRebuiltPdf', {}),
        bytes: 5,
      },
      authoritativePdfHash: authoritativePdf.hash,
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
