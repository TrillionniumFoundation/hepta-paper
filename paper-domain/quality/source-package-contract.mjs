import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';

function safeRelative(value) {
  const normalized = String(value || '').replace(/\\/g, '/').trim();
  return normalized && !path.posix.isAbsolute(normalized) && !normalized.split('/').some((part) => !part || part === '.' || part === '..');
}

export function resolveSourcePackageContract({ sourceRoot, paperTask, contract = null } = {}) {
  const contractPath = sourceRoot ? path.join(sourceRoot, 'SOURCE_PACKAGE_CONTRACT.json') : null;
  let declared = contract || paperTask?.registry?.sourcePackageContract || null;
  let contractFileHash = null;
  if (!declared && contractPath && fs.existsSync(contractPath)) {
    const read = readScopedFileSync({ scopeRoot: sourceRoot, candidate: contractPath, maximumBytes: 1024 * 1024 });
    if (read.status === 'scoped_file_read_verified') {
      try { declared = JSON.parse(read.content.toString('utf8')); contractFileHash = read.hash; } catch { declared = null; }
    }
  }
  const files = Array.isArray(declared?.files) ? declared.files.map((item) => ({
    path: String(item?.path || '').replace(/\\/g, '/'),
    role: String(item?.role || 'source_file'),
    required: item?.required !== false,
  })) : [];
  const blockers = [];
  if (declared?.version !== 1 || declared?.kind !== 'SourcePackageContract') blockers.push('source_package_contract_missing_or_invalid');
  if (declared?.paperId && declared.paperId !== paperTask?.paperId) blockers.push('source_package_contract_paper_id_mismatch');
  if (!files.length) blockers.push('source_package_contract_files_empty');
  for (const item of files) if (!safeRelative(item.path)) blockers.push(`source_package_contract_path_unsafe:${item.path || 'missing'}`);
  for (const item of files) if (/(^|\/)(?:\.env|id_rsa|credentials|secrets?)(?:\.|$)/i.test(item.path)) blockers.push(`source_package_contract_secret_forbidden:${item.path}`);
  const paths = files.map((item) => item.path);
  if (new Set(paths).size !== paths.length) blockers.push('source_package_contract_path_duplicate');
  const rawMainTex = String(paperTask?.mainTex || 'main.tex');
  const parentRelativeMain = path.resolve(path.dirname(sourceRoot || '.'), rawMainTex);
  const absoluteMainTex = path.isAbsolute(rawMainTex)
    ? path.resolve(rawMainTex)
    : (parentRelativeMain.startsWith(`${path.resolve(sourceRoot || '.')}${path.sep}`) ? parentRelativeMain : path.resolve(sourceRoot || '.', rawMainTex));
  const mainTex = path.relative(sourceRoot || '.', absoluteMainTex).replace(/\\/g, '/');
  if (!files.some((item) => item.path === mainTex && item.required)) blockers.push('source_package_contract_main_tex_required');
  const subject = { version: 1, kind: 'SourcePackageContract', paperId: paperTask?.paperId || null, files, contractFileHash };
  return Object.freeze({
    ...subject,
    status: blockers.length ? 'source_package_contract_blocked' : 'source_package_contract_verified',
    blockers: [...new Set(blockers)],
    sourcePackageContractHash: hashRecord('SourcePackageContract', subject),
  });
}

export function buildSourcePackageManifest({ sourceRoot, sourcePackageContract } = {}) {
  const blockers = [...(sourcePackageContract?.blockers || [])];
  const rows = [];
  for (const item of sourcePackageContract?.files || []) {
    if (!safeRelative(item.path)) continue;
    const candidate = path.join(sourceRoot, item.path);
    const read = readScopedFileSync({ scopeRoot: sourceRoot, candidate, maximumBytes: 256 * 1024 * 1024 });
    if (read.status !== 'scoped_file_read_verified') {
      blockers.push(...(read.blockers || []).map((blocker) => `source_package_file:${item.path}:${blocker}`));
      if (item.required) blockers.push(`source_package_required_file_unavailable:${item.path}`);
      continue;
    }
    rows.push({ path: item.path, role: item.role, required: item.required, hash: read.hash, bytes: read.bytes, identityHash: read.afterIdentityHash });
  }
  const requiredPaths = (sourcePackageContract?.files || []).filter((item) => item.required).map((item) => item.path);
  for (const required of requiredPaths) if (!rows.some((row) => row.path === required)) blockers.push(`source_package_required_file_missing:${required}`);
  const payload = {
    version: 1,
    kind: 'ScopedSourceTreeManifest',
    status: blockers.length ? 'scoped_source_tree_blocked' : 'scoped_source_tree_verified',
    sourcePackageContractHash: sourcePackageContract?.sourcePackageContractHash || null,
    fileCount: rows.length,
    totalBytes: rows.reduce((total, item) => total + item.bytes, 0),
    rows: rows.sort((left, right) => left.path.localeCompare(right.path)),
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, sourceTreeManifestHash: hashRecord('ScopedSourceTreeManifest', payload) });
}
