import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDir,
  fileExists,
  fileRecord,
  relativePath,
  sha256Text,
  walkFiles,
} from '../../paper-core/src/runtime/file-utils.mjs';
import { normalizeText } from '../../paper-core/src/runtime/text-utils.mjs';
import { writeJsonFile, writeTextFile } from '../artifacts/write-artifact.mjs';
import {
  createPaperBuildArtifactAcceptance,
  createPaperArtifactPackage,
} from '../../paper-core/src/paper-contracts.mjs';
import { sqlEscape } from '../../paper-ports/store-port.mjs';

function repoPath(root, value) {
  const text = normalizeText(value);
  if (!text) return null;
  return path.isAbsolute(text) ? text : path.join(root, text);
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
    if (await fileExists(expectedPdf)) builtPdf = await fileRecord(root, expectedPdf, 'compiled_pdf');
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
    buildArtifactAcceptanceRecord = await fileRecord(root, acceptancePath, 'build_artifact_acceptance');
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

async function sourceFileArtifacts(root, sourceDir) {
  if (!sourceDir) return [];
  const files = await walkFiles(sourceDir, {
    maxDepth: 3,
    maxFiles: 4000,
    match: (_full, name) => /\.(tex|bib|bst|cls|sty|pdf|png|jpg|jpeg|csv|json|md)$/i.test(name)
      && !/(\.aux|\.log|\.fdb_latexmk|\.fls|\.synctex|\.out)$/i.test(name),
  });
  const artifacts = [];
  for (const file of files.slice(0, 256)) {
    const lower = path.basename(file).toLowerCase();
    let role = 'source_file';
    if (lower.endsWith('.pdf')) role = 'compiled_pdf';
    if (lower.endsWith('.tex')) role = lower === 'main.tex' ? 'main_tex' : 'tex_source';
    if (lower.endsWith('.bib')) role = 'bibliography';
    const record = await fileRecord(root, file, role);
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
    const record = await fileRecord(root, file, role);
    if (record) artifacts.push({ ...record, source: 'runtime_build' });
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

async function writePackageRecords({ root, packageDir, row, artifactPackage, execute }) {
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
    artifactCount: artifactPackage.artifactCount,
    artifacts: artifactPackage.artifacts,
  };
  packageRecord.packageRecordHash = sha256Text(JSON.stringify(packageRecord));
  const recordPath = path.join(packageDir, 'PACKAGE_RECORD.json');
  const sumsPath = path.join(packageDir, 'SHA256SUMS.txt');
  await writeJsonFile(recordPath, packageRecord);
  await writeTextFile(sumsPath, sha256SumsText(artifactPackage.artifacts));
  return {
    packageRecord: await fileRecord(root, recordPath, 'package_record'),
    sha256Sums: await fileRecord(root, sumsPath, 'sha256sums'),
  };
}

export async function runPackageAdapter({ root, row, buildResult = null, runtimeRoot, execute = false, store = null } = {}) {
  const sourceDir = repoPath(root, row.task.sourceWorkspace);
  const blockers = [];
  const warnings = [];
  if (!sourceDir) blockers.push('source_workspace_missing');
  const artifacts = uniqueArtifactRecords([
    ...(row.artifacts?.pdfs || []),
    ...(row.artifacts?.zips || []),
    ...(await sqlitePackageArtifacts(root, row.task.paperId, store)),
    ...(await runtimeBuildArtifacts(root, runtimeRoot, row.task.paperId)),
    ...(await sourceFileArtifacts(root, sourceDir)),
  ]);
  if (buildResult?.builtPdf) artifacts.unshift(buildResult.builtPdf);
  const hasPdf = artifacts.some((artifact) => artifact.role === 'compiled_pdf');
  const hasSource = artifacts.some((artifact) => ['main_tex', 'tex_source', 'source_file'].includes(artifact.role));
  if (!hasPdf) warnings.push('compiled_pdf_missing');
  if (!hasSource) blockers.push('source_files_missing');
  const packageDir = path.join(runtimeRoot, 'packages', row.task.paperId);
  let sourceZip = null;
  if (!blockers.length && execute) {
    await ensureDir(packageDir);
    const zipPath = path.join(packageDir, `${row.task.paperId}-source-workspace.zip`);
    const result = spawnSync('zip', ['-qr', zipPath, '.'], {
      cwd: sourceDir,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 4,
    });
    if (result.status !== 0) blockers.push('source_zip_failed');
    if (await fileExists(zipPath)) {
      sourceZip = await fileRecord(root, zipPath, 'generated_source_zip');
      artifacts.unshift(sourceZip);
    }
  }
  const packageStatus = blockers.length
    ? 'package_blocked'
    : (artifacts.some((artifact) => /zip/i.test(artifact.role)) || sourceZip) ? 'package_present' : 'package_ready';
  const artifactPackage = createPaperArtifactPackage({
    paperTask: row.task,
    mode: execute ? 'local-package' : 'local-package-dry-run',
    artifacts,
    packageStatus,
    buildStatus: buildResult?.status || row.state.compileStatus,
    submitReady: !blockers.length && hasPdf && hasSource,
    evidenceRefs: artifacts.slice(0, 32),
  });
  const packageRecords = await writePackageRecords({
    root,
    packageDir,
    row,
    artifactPackage,
    execute,
  });
  return {
    version: 1,
    kind: 'PaperPackageAdapterResult',
    paperId: row.task.paperId,
    status: blockers.length ? 'blocked' : 'package_ready',
    execute: Boolean(execute),
    packageDir: relativePath(root, packageDir),
    sourceZip,
    packageRecord: packageRecords.packageRecord,
    sha256Sums: packageRecords.sha256Sums,
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
