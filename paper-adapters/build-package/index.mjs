import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDir,
  fileExists,
  fileRecord,
  pathWithin,
  relativePath,
  sha256Text,
  walkFiles,
} from '../../workflow-kernel/runtime/file-utils.mjs';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import { writeJsonFile, writeTextFile } from '../artifacts/write-artifact.mjs';
import {
  createPaperBuildArtifactAcceptance,
  createPaperArtifactPackage,
} from '../../paper-domain/contracts/index.mjs';
import { sqlEscape } from '../../paper-ports/store-port.mjs';
import { verifyPackageBundle } from './package-verifier.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectScopedPathSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { runTheoremManuscriptReadinessCheck } from '../automation/theorem-manuscript-readiness-check.mjs';
import { evaluateManuscriptPromotion, explicitPaperQualityProfile } from '../../paper-domain/quality/manuscript-promotion-gate.mjs';
import { buildSourcePackageManifest, resolveSourcePackageContract } from '../../paper-domain/quality/source-package-contract.mjs';

function repoPath(root, value) {
  const text = normalizeText(value);
  if (!text) return null;
  return path.isAbsolute(text) ? text : path.join(root, text);
}

function sourceWorkspaceAuthority({ root, runtimeRoot, row, sourceDir, mainTex }) {
  if (!sourceDir) return { scopeRoot: null, blockers: ['source_workspace_missing'] };
  const proposalRoot = path.join(runtimeRoot, 'proposals');
  const proposalStaging = row?.task?.registry?.inventorySource === 'proposal_staging';
  const scopeRoot = pathWithin(root, sourceDir)
    ? root
    : proposalStaging && pathWithin(proposalRoot, sourceDir)
      ? proposalRoot
      : null;
  if (!scopeRoot) return { scopeRoot: null, blockers: ['source_workspace_outside_authorized_scope'] };
  const sourceIdentity = inspectScopedPathSync({ scopeRoot, candidate: sourceDir, expect: 'directory', forbidHardlinks: false });
  const mainIdentity = mainTex
    ? inspectScopedPathSync({ scopeRoot: sourceDir, candidate: mainTex, expect: 'file' })
    : null;
  const blockers = [
    ...(sourceIdentity.status === 'scoped_file_identity_verified' ? [] : sourceIdentity.blockers.map((item) => `source_workspace:${item}`)),
    ...(mainIdentity && mainIdentity.status !== 'scoped_file_identity_verified' ? mainIdentity.blockers.map((item) => `main_tex:${item}`) : []),
  ];
  return { scopeRoot, blockers };
}

async function scopedLogicalFileRecord(scopeRoot, logicalRoot, candidate, role, extra = {}) {
  const record = await fileRecord(scopeRoot, candidate, role);
  return record ? { ...record, path: relativePath(logicalRoot, candidate), ...extra } : null;
}

function commandExists(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
  return result.status === 0 ? normalizeText(result.stdout) : null;
}

function sqliteJson(store, sql) {
  return store.query(sql).rows;
}

async function fileRecordFromRepoPath(root, value, role) {
  const candidate = repoPath(root, value);
  if (!candidate || !(await fileExists(candidate))) return null;
  return fileRecord(root, candidate, role);
}

async function sqlitePackageArtifacts(root, paperId, store) {
  if (!store) return [];
  const slug = sqlEscape(paperId);
  const submissionRows = sqliteJson(store, [
    'select package_dir,pdf_path,source_zip_path,created_at',
    `from submissions where slug='${slug}' and status='local_package'`,
    'order by created_at desc limit 6',
  ].join(' '));
  const artifactRows = sqliteJson(store, [
    'select kind,path,sha256,bytes,created_at',
    `from artifacts where slug='${slug}'`,
    "and (kind like '%pdf%' or kind like '%zip%' or kind like '%package%')",
    'order by created_at desc limit 32',
  ].join(' '));
  const records = [];
  for (const row of submissionRows) {
    const pdf = await fileRecordFromRepoPath(root, row.pdf_path, 'compiled_pdf');
    if (pdf) records.push({ ...pdf, source: 'sqlite_submissions' });
    const sourceZip = await fileRecordFromRepoPath(root, row.source_zip_path, 'source_or_submission_zip');
    if (sourceZip) records.push({ ...sourceZip, source: 'sqlite_submissions' });
  }
  for (const row of artifactRows) {
    const kind = normalizeText(row.kind).toLowerCase();
    const role = kind.includes('zip') || kind.includes('package') ? 'source_or_submission_zip' : 'compiled_pdf';
    const record = await fileRecordFromRepoPath(root, row.path, role);
    if (record) records.push({ ...record, source: 'sqlite_artifacts' });
  }
  return uniqueArtifactRecords(records);
}

function buildCommand({ tool, mainTex, buildDir }) {
  if (tool === 'latexmk') {
    return ['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-outdir=' + buildDir, mainTex];
  }
  return [tool, '-interaction=nonstopmode', '-halt-on-error', '-output-directory', buildDir, mainTex];
}

export async function runLatexBuildAdapter({ root, row, runtimeRoot, execute = false } = {}) {
  const sourceDir = repoPath(root, row.task.sourceWorkspace);
  const mainTex = repoPath(root, row.task.mainTex);
  const blockers = [];
  const warnings = [];
  if (!sourceDir) blockers.push('source_workspace_missing');
  if (!mainTex || !(await fileExists(mainTex))) blockers.push('main_tex_missing');
  const sourceAuthority = sourceWorkspaceAuthority({ root, runtimeRoot, row, sourceDir, mainTex });
  blockers.push(...sourceAuthority.blockers);
  const latexmk = commandExists('latexmk');
  const pdflatex = commandExists('pdflatex');
  const xelatex = commandExists('xelatex');
  const tool = latexmk ? 'latexmk' : (pdflatex ? 'pdflatex' : (xelatex ? 'xelatex' : null));
  if (!tool) blockers.push('latex_engine_missing');
  const buildDir = path.join(runtimeRoot, 'builds', row.task.paperId);
  const buildCwd = mainTex ? path.dirname(mainTex) : sourceDir;
  const command = tool && mainTex ? buildCommand({ tool, mainTex, buildDir }) : [];
  let execution = null;
  let builtPdf = null;
  if (!blockers.length && execute) {
    await ensureDir(buildDir);
    const result = spawnSync(command[0], command.slice(1), {
      cwd: buildCwd,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 8,
    });
    execution = {
      executed: true,
      status: result.status,
      signal: result.signal || null,
      stdoutTail: String(result.stdout || '').slice(-4000),
      stderrTail: String(result.stderr || '').slice(-4000),
    };
    if (result.status !== 0) blockers.push('latex_build_failed');
    const expectedPdf = path.join(buildDir, path.basename(mainTex, '.tex') + '.pdf');
    if (await fileExists(expectedPdf)) builtPdf = await scopedLogicalFileRecord(runtimeRoot, root, expectedPdf, 'compiled_pdf');
  }
  const buildArtifactAcceptance = createPaperBuildArtifactAcceptance({
    paperTask: row.task,
    execute,
    command,
    buildDir: relativePath(root, buildDir),
    sourceWorkspace: row.task.sourceWorkspace,
    mainTex: row.task.mainTex,
    builtPdf,
    execution,
    blockers,
    warnings,
  });
  let buildArtifactAcceptanceRecord = null;
  if (execute && buildArtifactAcceptance.accepted) {
    const acceptancePath = path.join(buildDir, 'BUILD_ARTIFACT_ACCEPTANCE.json');
    await writeJsonFile(acceptancePath, buildArtifactAcceptance);
    buildArtifactAcceptanceRecord = await scopedLogicalFileRecord(runtimeRoot, root, acceptancePath, 'build_artifact_acceptance');
  }
  return {
    version: 1,
    kind: 'PaperLatexBuildAdapterResult',
    paperId: row.task.paperId,
    status: blockers.length ? 'blocked' : (execute ? 'build_passed' : 'dry_run_ready'),
    execute: Boolean(execute),
    command,
    commandPreview: command.map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' '),
    buildCwd: buildCwd ? relativePath(root, buildCwd) : null,
    buildDir: relativePath(root, buildDir),
    builtPdf,
    buildArtifactAcceptance,
    buildArtifactAcceptanceRecord,
    blockers,
    warnings,
    execution,
    safety: {
      sourceMutation: false,
      outputUnderRuntime: true,
      externalActionPerformed: false,
    },
  };
}

async function sourceFileArtifacts(root, sourceDir, sourceTreeManifest = null) {
  if (!sourceDir) return [];
  const files = (sourceTreeManifest?.rows || []).map((item) => ({ ...item, absolute: path.join(sourceDir, item.path) }));
  const artifacts = [];
  for (const item of files) {
    const file = item.absolute;
    const lower = path.basename(file).toLowerCase();
    let role = item.role || 'source_file';
    if (lower.endsWith('.pdf')) role = 'compiled_pdf';
    if (lower.endsWith('.tex')) role = lower === 'main.tex' ? 'main_tex' : 'tex_source';
    if (lower.endsWith('.bib')) role = 'bibliography';
    const record = await scopedLogicalFileRecord(sourceDir, root, file, role);
    if (record) artifacts.push(record);
  }
  return artifacts;
}

async function runtimeBuildArtifacts(root, runtimeRoot, paperId) {
  const buildDir = path.join(runtimeRoot, 'builds', paperId);
  const files = await walkFiles(buildDir, {
    maxDepth: 1,
    maxFiles: 64,
    match: (_full, name) => /\.pdf$/i.test(name) || name === 'BUILD_ARTIFACT_ACCEPTANCE.json',
  });
  const artifacts = [];
  for (const file of files) {
    const role = path.basename(file) === 'BUILD_ARTIFACT_ACCEPTANCE.json'
      ? 'build_artifact_acceptance'
      : 'compiled_pdf';
    const record = await scopedLogicalFileRecord(runtimeRoot, root, file, role, { source: 'runtime_build' });
    if (record) artifacts.push(record);
  }
  return artifacts;
}

function uniqueArtifactRecords(artifacts = []) {
  const out = [];
  const seen = new Set();
  for (const artifact of artifacts) {
    const key = artifact.hash || artifact.path || artifact.filename;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(artifact);
  }
  return out;
}

function sha256SumsText(artifacts = []) {
  return artifacts
    .filter((artifact) => artifact.hash && artifact.path)
    .map((artifact) => `${artifact.hash.replace(/^sha256:/, '')}  ${artifact.path}`)
    .join('\n') + '\n';
}

async function writePackageRecords({ root, runtimeRoot, packageDir, row, artifactPackage, verificationArtifacts = [], sourceTreeManifest = null, sourcePackageContract = null, execute }) {
  await ensureDir(packageDir);
  const packageRecord = {
    version: 1,
    kind: 'PaperPackageRecord',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    title: row.task.title,
    venueTarget: row.task.venueTarget || null,
    sourceWorkspace: row.task.sourceWorkspace || null,
    mainTex: row.task.mainTex || null,
    mode: execute ? 'local-package' : 'local-package-dry-run',
    sourceMutation: false,
    externalActionPerformed: false,
    artifactPackageHash: artifactPackage.artifactPackageHash,
    sourceTreeManifestHash: sourceTreeManifest?.sourceTreeManifestHash || null,
    sourcePackageContractHash: sourcePackageContract?.sourcePackageContractHash || null,
    sourceTreeManifest,
    artifactCount: artifactPackage.artifactCount,
    artifacts: artifactPackage.artifacts,
  };
  packageRecord.packageRecordHash = sha256Text(JSON.stringify(packageRecord));
  const recordPath = path.join(packageDir, 'PACKAGE_RECORD.json');
  const sumsPath = path.join(packageDir, 'SHA256SUMS.txt');
  await writeJsonFile(recordPath, packageRecord);
  await writeTextFile(sumsPath, sha256SumsText(verificationArtifacts));
  return {
    packageRecord: await scopedLogicalFileRecord(runtimeRoot, root, recordPath, 'package_record'),
    sha256Sums: await scopedLogicalFileRecord(runtimeRoot, root, sumsPath, 'sha256sums'),
  };
}

export async function runPackageAdapter({ root, row, buildResult = null, researchReport = null, runtimeRoot, execute = false, store = null } = {}) {
  const sourceDir = repoPath(root, row.task.sourceWorkspace);
  const packageMainTex = repoPath(root, row.task.mainTex);
  const blockers = [];
  const warnings = [];
  if (!sourceDir) blockers.push('source_workspace_missing');
  if (!packageMainTex || !(await fileExists(packageMainTex))) blockers.push('main_tex_missing');
  const sourceAuthority = sourceWorkspaceAuthority({ root, runtimeRoot, row, sourceDir, mainTex: packageMainTex });
  blockers.push(...sourceAuthority.blockers);
  const sourcePackageContract = sourceDir
    ? resolveSourcePackageContract({ sourceRoot: sourceDir, paperTask: row.task })
    : null;
  const sourceTreeManifest = sourceDir
    ? buildSourcePackageManifest({ sourceRoot: sourceDir, sourcePackageContract })
    : null;
  if (sourceTreeManifest?.status !== 'scoped_source_tree_verified') {
    blockers.push(...(sourceTreeManifest?.blockers || ['source_tree_manifest_required']).map((item) => `source_tree:${item}`));
  }
  const runtimeArtifacts = await runtimeBuildArtifacts(root, runtimeRoot, row.task.paperId);
  const persistedArtifacts = await sqlitePackageArtifacts(root, row.task.paperId, store);
  const sourceArtifacts = await sourceFileArtifacts(root, sourceDir, sourceTreeManifest);
  const authoritativePdf = buildResult?.builtPdf
    || runtimeArtifacts.find((artifact) => artifact.role === 'compiled_pdf')
    || (row.artifacts?.pdfs || [])[0]
    || persistedArtifacts.find((artifact) => artifact.role === 'compiled_pdf')
    || null;
  const artifacts = uniqueArtifactRecords([
    ...sourceArtifacts,
    ...(authoritativePdf ? [authoritativePdf] : []),
    ...runtimeArtifacts.filter((artifact) => artifact.role === 'build_artifact_acceptance'),
  ]);
  const hasPdf = artifacts.some((artifact) => artifact.role === 'compiled_pdf');
  const hasSource = artifacts.some((artifact) => ['main_tex', 'tex_source', 'source_file'].includes(artifact.role));
  if (!hasPdf) warnings.push('compiled_pdf_missing');
  if (!hasSource) blockers.push('source_files_missing');
  const packageDir = path.join(runtimeRoot, 'packages', row.task.paperId);
  let sourceZip = null;
  let sourceZipVerification = null;
  if (!blockers.length && execute) {
    await ensureDir(packageDir);
    const zipPath = path.join(packageDir, `${row.task.paperId}-source-workspace.zip`);
    fs.rmSync(zipPath, { force: true });
    const result = spawnSync('zip', ['-q', '-X', zipPath, '--', ...sourceTreeManifest.rows.map((item) => item.path)], {
      cwd: sourceDir,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 4,
    });
    if (result.status !== 0) blockers.push('source_zip_failed');
    if (await fileExists(zipPath)) {
      sourceZip = await scopedLogicalFileRecord(runtimeRoot, root, zipPath, 'generated_source_zip');
      sourceZipVerification = await fileRecord(runtimeRoot, zipPath, 'generated_source_zip');
      artifacts.unshift(sourceZip);
    }
  }
  const packageStatus = blockers.length
    ? 'package_blocked'
    : (artifacts.some((artifact) => /zip/i.test(artifact.role)) || sourceZip) ? 'package_present' : 'package_ready';
  const sourceSnapshotHash = sourceTreeManifest?.sourceTreeManifestHash || null;
  const candidateArtifactPackage = createPaperArtifactPackage({
    paperTask: row.task,
    mode: execute ? 'local-package' : 'local-package-dry-run',
    artifacts,
    packageStatus,
    buildStatus: buildResult?.status || row.state.compileStatus,
    submitReady: false,
    evidenceRefs: artifacts.slice(0, 32),
    sourceSnapshotHash,
    sourceTreeManifestHash: sourceTreeManifest?.sourceTreeManifestHash || null,
    sourcePackageContractHash: sourcePackageContract?.sourcePackageContractHash || null,
  });
  const packageRecords = await writePackageRecords({
    root,
    runtimeRoot,
    packageDir,
    row,
    artifactPackage: candidateArtifactPackage,
    verificationArtifacts: sourceZipVerification ? [sourceZipVerification] : [],
    sourceTreeManifest,
    sourcePackageContract,
    execute,
  });
  const packageVerificationReceipt = execute
    ? verifyPackageBundle({
      scopeRoot: runtimeRoot,
      packageDir,
      expectedArtifactPackageHash: candidateArtifactPackage.artifactPackageHash,
      expectedArtifacts: sourceZipVerification ? [sourceZipVerification] : [],
      expectedArchivePath: sourceZipVerification?.path || null,
      expectedArchiveManifest: sourceTreeManifest,
      artifactBaseRoot: root,
      artifactScopeRoots: [root, runtimeRoot],
    })
    : null;
  if (packageVerificationReceipt && packageVerificationReceipt.status !== 'package_verification_passed') {
    blockers.push(...packageVerificationReceipt.blockers.map((blocker) => `package_verification:${blocker}`));
  }
  const sourceRelativeMain = sourceDir && packageMainTex
    ? path.relative(sourceDir, packageMainTex).replace(/\\/g, '/')
    : 'main.tex';
  const theoremReadiness = sourceDir && packageMainTex && await fileExists(packageMainTex)
    ? runTheoremManuscriptReadinessCheck({
      workspacePath: sourceDir,
      manuscriptPath: sourceRelativeMain,
      paperId: row.task.paperId,
      profile: explicitPaperQualityProfile(row.task),
    })
    : null;
  const manuscriptPromotionGate = evaluateManuscriptPromotion({
    paperTask: row.task,
    theoremReadiness,
    researchReport,
    packageVerificationReceipt,
    buildResult,
    requirePackageVerification: Boolean(execute),
    requireResearchQuality: Boolean(researchReport),
    requirePaperQuality: Boolean(execute),
    boundary: 'package',
  });
  if (manuscriptPromotionGate.status !== 'manuscript_promotion_ready') {
    blockers.push(...manuscriptPromotionGate.blockers.map((blocker) => `promotion:${blocker}`));
  }
  const artifactPackage = createPaperArtifactPackage({
    paperTask: row.task,
    mode: execute ? 'local-package' : 'local-package-dry-run',
    artifacts,
    packageStatus,
    buildStatus: buildResult?.status || row.state.compileStatus,
    submitReady: blockers.length === 0
      && hasPdf && hasSource
      && packageVerificationReceipt?.status === 'package_verification_passed'
      && manuscriptPromotionGate.status === 'manuscript_promotion_ready',
    evidenceRefs: artifacts.slice(0, 32),
    candidateArtifactPackageHash: candidateArtifactPackage.artifactPackageHash,
    packageVerificationReceipt,
    sourceSnapshotHash,
    sourceTreeManifestHash: sourceTreeManifest?.sourceTreeManifestHash || null,
    sourcePackageContractHash: sourcePackageContract?.sourcePackageContractHash || null,
    promotionGate: manuscriptPromotionGate,
  });
  return {
    version: 1,
    kind: 'PaperPackageAdapterResult',
    paperId: row.task.paperId,
    status: blockers.length ? 'blocked' : 'package_ready',
    submitReady: artifactPackage.submitReady,
    execute: Boolean(execute),
    packageDir: relativePath(root, packageDir),
    sourceZip,
    sourceTreeManifest,
    packageRecord: packageRecords.packageRecord,
    sha256Sums: packageRecords.sha256Sums,
    packageVerificationReceipt,
    theoremReadiness,
    manuscriptPromotionGate,
    candidateArtifactPackageHash: candidateArtifactPackage.artifactPackageHash,
    artifactPackage,
    blockers,
    warnings,
    safety: {
      sourceMutation: false,
      outputUnderRuntime: true,
      externalActionPerformed: false,
    },
  };
}
