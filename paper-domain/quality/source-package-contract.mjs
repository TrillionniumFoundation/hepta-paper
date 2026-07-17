import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function isSafeSourcePackageRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').trim();
  return normalized
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split('/').some((part) => !part || part === '.' || part === '..');
}

export function resolveSourcePackageContract({
  paperTask,
  contract = null,
  contractFileHash = null,
  mainTexRelative = null,
} = {}) {
  const declared = contract || paperTask?.registry?.sourcePackageContract || null;
  const files = Array.isArray(declared?.files) ? declared.files.map((item) => ({
    path: String(item?.path || '').replace(/\\/g, '/'),
    role: String(item?.role || 'source_file'),
    required: item?.required !== false,
  })) : [];
  const blockers = [];
  if (declared?.version !== 1 || declared?.kind !== 'SourcePackageContract') blockers.push('source_package_contract_missing_or_invalid');
  if (declared?.paperId && declared.paperId !== paperTask?.paperId) blockers.push('source_package_contract_paper_id_mismatch');
  if (!files.length) blockers.push('source_package_contract_files_empty');
  for (const item of files) if (!isSafeSourcePackageRelativePath(item.path)) blockers.push(`source_package_contract_path_unsafe:${item.path || 'missing'}`);
  for (const item of files) if (/(^|\/)(?:\.env|id_rsa|credentials|secrets?)(?:\.|$)/i.test(item.path)) blockers.push(`source_package_contract_secret_forbidden:${item.path}`);
  const paths = files.map((item) => item.path);
  if (new Set(paths).size !== paths.length) blockers.push('source_package_contract_path_duplicate');
  const mainTex = String(mainTexRelative || paperTask?.mainTex || '').replace(/\\/g, '/');
  if (!isSafeSourcePackageRelativePath(mainTex)
    || !files.some((item) => item.path === mainTex && item.required)) {
    blockers.push('source_package_contract_main_tex_required');
  }
  const subject = {
    version: 1,
    kind: 'SourcePackageContract',
    paperId: paperTask?.paperId || null,
    files,
    contractFileHash,
  };
  return Object.freeze({
    ...subject,
    status: blockers.length ? 'source_package_contract_blocked' : 'source_package_contract_verified',
    blockers: [...new Set(blockers)],
    sourcePackageContractHash: hashRecord('SourcePackageContract', subject),
  });
}

export function buildSourcePackageManifest({ sourcePackageContract, fileRecords = [] } = {}) {
  const blockers = [...(sourcePackageContract?.blockers || [])];
  const rows = [];
  const observations = new Map((Array.isArray(fileRecords) ? fileRecords : [])
    .map((item) => [String(item?.path || '').replace(/\\/g, '/'), item]));
  for (const item of sourcePackageContract?.files || []) {
    if (!isSafeSourcePackageRelativePath(item.path)) continue;
    const observation = observations.get(item.path);
    if (observation?.status !== 'source_package_file_verified') {
      blockers.push(...(observation?.blockers || []).map((blocker) => `source_package_file:${item.path}:${blocker}`));
      if (item.required) blockers.push(`source_package_required_file_unavailable:${item.path}`);
      continue;
    }
    rows.push({
      path: item.path,
      role: item.role,
      required: item.required,
      hash: observation.hash,
      bytes: observation.bytes,
      identityHash: observation.identityHash,
    });
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
