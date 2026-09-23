import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyPackageBundle } from '../../paper-adapters/build-package/package-verifier.mjs';
import { runPackageAdapter } from '../../paper-adapters/build-package/index.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function readyResearchReport() {
  return {
    researchReportHash: 'sha256:research',
    capabilities: {
      claimRegistry: { status: 'claim_graph_valid', claimRegistryHash: 'sha256:claims' },
      evidenceQualityGate: { status: 'evidence_quality_ready', blockers: [], evidenceQualityGateHash: 'sha256:evidence' },
      experimentRegistry: { status: 'experiment_registry_ready', experiments: [], experimentRegistryHash: 'sha256:experiments' },
      researchGapPlan: { jobs: [], researchGapPlanHash: 'sha256:gaps' },
      promotionInputSnapshot: { status: 'promotion_input_snapshot_frozen', researchGapPlanHash: 'sha256:gaps', promotionInputSnapshotHash: 'sha256:inputs' },
      researchGapClosureReceipt: { status: 'research_gap_closure_verified', promotionInputSnapshotHash: 'sha256:inputs', researchGapClosureReceiptHash: 'sha256:closure' },
    },
    typedContracts: {
      reproducibilityContract: { status: 'reproducibility_evidence_present', reproducibilityContractHash: 'sha256:reproduction' },
    },
    nativeResearchWorkerExecution: { workerReceipts: [] },
  };
}

test('package verifier re-reads hashes and rejects unsafe or explosive archive members', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-package-verifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'package');
  fs.mkdirSync(bundle);
  const archive = Buffer.from('fixture archive');
  fs.writeFileSync(path.join(bundle, 'source.zip'), archive);
  fs.writeFileSync(path.join(bundle, 'PACKAGE_RECORD.json'), JSON.stringify({ paperId: 'paper', artifacts: [{ id: 'source', role: 'generated_source_zip', path: 'package/source.zip', hash: `sha256:${digest(archive)}`, sizeBytes: archive.length }] }));
  fs.writeFileSync(path.join(bundle, 'SHA256SUMS.txt'), `${digest(archive)}  package/source.zip\n`);
  const safe = verifyPackageBundle({ scopeRoot: root, packageDir: bundle, archiveInspector: () => ({ ok: true, entries: [{ mode: '-rw-r--r--', name: 'main.tex', compressedBytes: 100, uncompressedBytes: 200 }] }) });
  assert.equal(safe.status, 'package_verification_passed');
  const unsafe = verifyPackageBundle({ scopeRoot: root, packageDir: bundle, archiveInspector: () => ({ ok: true, entries: [
    { mode: 'lrwxrwxrwx', name: '../.env', compressedBytes: 1, uncompressedBytes: 1000 },
  ] }), limits: { maximumCompressionRatio: 10 } });
  assert.equal(unsafe.status, 'package_verification_blocked');
  assert.ok(unsafe.blockers.some((item) => item.includes('archive_member_path_unsafe')));
  assert.ok(unsafe.blockers.some((item) => item.includes('archive_symlink_forbidden')));
  assert.ok(unsafe.blockers.some((item) => item.includes('archive_compression_ratio_exceeded')));
});

test('package verifier settles every declared artifact and rejects a missing compiled PDF', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-package-settlement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'package');
  fs.mkdirSync(bundle);
  const archive = Buffer.from('fixture archive');
  fs.writeFileSync(path.join(bundle, 'source.zip'), archive);
  fs.writeFileSync(path.join(bundle, 'PACKAGE_RECORD.json'), JSON.stringify({ paperId: 'paper', artifactPackageHash: 'sha256:candidate', artifacts: [
    { id: 'source', role: 'generated_source_zip', path: 'package/source.zip', hash: `sha256:${digest(archive)}`, sizeBytes: archive.length },
    { id: 'pdf', role: 'compiled_pdf', path: 'build/paper.pdf', hash: 'sha256:missing', sizeBytes: 100 },
  ] }));
  fs.writeFileSync(path.join(bundle, 'SHA256SUMS.txt'), `${digest(archive)}  package/source.zip\n`);
  const result = verifyPackageBundle({ scopeRoot: root, packageDir: bundle, artifactBaseRoot: root, artifactScopeRoots: [root], expectedArtifactPackageHash: 'sha256:candidate', archiveInspector: () => ({ ok: true, entries: [] }) });
  assert.equal(result.status, 'package_verification_blocked');
  assert.ok(result.blockers.includes('package_artifact_unreadable_or_unsafe:build/paper.pdf'));
  assert.equal(result.artifactSettlement.status, 'artifact_settlement_blocked');
});

test('package adapter generates then re-reads a real source archive before readiness', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-package-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.tex'), '\\documentclass{article}\\begin{document}\\section{Limitations}fixture\\end{document}\n');
  fs.writeFileSync(path.join(source, 'excluded-dataset.bin'), Buffer.alloc(1024, 7));
  fs.writeFileSync(path.join(source, 'SOURCE_PACKAGE_CONTRACT.json'), JSON.stringify({ version: 1, kind: 'SourcePackageContract', paperId: 'paper', files: [{ path: 'main.tex', role: 'main_tex', required: true }] }));
  const row = { task: { paperId: 'paper', taskKey: 'paper', title: 'Paper', sourceWorkspace: 'source', mainTex: 'source/main.tex', paperQualityProfile: 'systems_or_artifact' }, state: { compileStatus: 'not_built' }, artifacts: {} };
  const buildResult = { status: 'build_passed', buildArtifactAcceptance: { accepted: true, paperBuildArtifactAcceptanceHash: 'sha256:build' } };
  const result = await withArtifactWriteContext({ artifactRepositoryFactory: () => ({
    async writeJson(target, value) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`); return {}; },
    async writeText(target, value) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return {}; },
  }) }, () => runPackageAdapter({ root, row, buildResult, researchReport: readyResearchReport(), runtimeRoot: runtime, execute: true }));
  assert.equal(result.packageVerificationReceipt.status, 'package_verification_passed');
  assert.equal(result.status, 'package_ready');
  assert.equal(result.sourceZip.role, 'generated_source_zip');
  assert.deepEqual(result.sourceTreeManifest.rows.map((item) => item.path), ['main.tex']);
  assert.equal(result.packageVerificationReceipt.archives[0].issues.length, 0);
});

test('package source manifest rejects a symlink before zip can dereference it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-package-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const outside = path.join(root, 'outside.txt');
  fs.mkdirSync(source);
  fs.writeFileSync(outside, 'outside secret\n');
  fs.writeFileSync(path.join(source, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n');
  fs.writeFileSync(path.join(source, 'SOURCE_PACKAGE_CONTRACT.json'), JSON.stringify({ version: 1, kind: 'SourcePackageContract', paperId: 'paper', files: [{ path: 'main.tex', role: 'main_tex', required: true }, { path: 'linked.txt', role: 'source_file', required: true }] }));
  fs.symlinkSync(outside, path.join(source, 'linked.txt'));
  const row = { task: { paperId: 'paper', taskKey: 'paper', sourceWorkspace: 'source', mainTex: 'source/main.tex', paperQualityProfile: 'systems_or_artifact' }, state: { compileStatus: 'not_built' }, artifacts: {} };
  const result = await withArtifactWriteContext({ artifactRepositoryFactory: () => ({
    async writeJson(target, value) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`); return {}; },
    async writeText(target, value) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return {}; },
  }) }, () => runPackageAdapter({ root, row, runtimeRoot: path.join(root, 'runtime'), execute: true }));
  assert.equal(result.sourceZip, null);
  assert.equal(result.packageVerificationReceipt.status, 'package_verification_blocked');
  assert.ok(result.blockers.some((item) => item.includes('source_package_file:linked.txt:scoped_path_symlink_forbidden')));
  assert.equal(result.artifactPackage.submitReady, false);
});

test('package verification uses the authorized runtime scope when runtime is outside the asset root', async (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-package-split-roots-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'assets');
  const runtime = path.join(parent, 'runtime');
  const source = path.join(root, 'source');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'main.tex'), '\\documentclass{article}\\begin{document}\\section{Limitations}fixture\\end{document}\n');
  fs.writeFileSync(path.join(source, 'SOURCE_PACKAGE_CONTRACT.json'), JSON.stringify({ version: 1, kind: 'SourcePackageContract', paperId: 'paper', files: [{ path: 'main.tex', role: 'main_tex', required: true }] }));
  const row = { task: { paperId: 'paper', taskKey: 'paper', sourceWorkspace: 'source', mainTex: 'source/main.tex', paperQualityProfile: 'systems_or_artifact' }, state: { compileStatus: 'not_built' }, artifacts: {} };
  const buildResult = { status: 'build_passed', buildArtifactAcceptance: { accepted: true, paperBuildArtifactAcceptanceHash: 'sha256:build' } };
  const result = await withArtifactWriteContext({ artifactRepositoryFactory: () => ({
    async writeJson(target, value) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`); return {}; },
    async writeText(target, value) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); return {}; },
  }) }, () => runPackageAdapter({ root, row, buildResult, researchReport: readyResearchReport(), runtimeRoot: runtime, execute: true }));
  assert.equal(result.packageVerificationReceipt.status, 'package_verification_passed');
  assert.equal(result.status, 'package_ready');
  assert.ok(result.sourceZip.path.startsWith('../runtime/'));
});
