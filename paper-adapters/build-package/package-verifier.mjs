import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';

function sha256File(candidate) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')}`;
}

function safeRelative(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\*+/, '').trim();
  return Boolean(normalized && !path.posix.isAbsolute(normalized) && !normalized.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('-')));
}

function defaultArchiveInspector(candidate) {
  const result = spawnSync('zipinfo', ['-l', candidate], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) return { ok: false, entries: [], blocker: 'zipinfo_failed' };
  const entries = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[dl-][rwx-]{9}\s/.test(line)).map((line) => {
    const fields = line.split(/\s+/);
    return { mode: fields[0], uncompressedBytes: Number(fields[3] || 0), compressedBytes: Number(fields[5] || 0), name: fields.slice(9).join(' ') };
  });
  return { ok: true, entries };
}

export function verifyPackageBundle({
  scopeRoot,
  packageDir,
  archiveInspector = defaultArchiveInspector,
  limits = {},
  expectedArtifactPackageHash = null,
  expectedArtifacts = [],
  expectedArchivePath = null,
  expectedArchiveManifest = null,
  artifactBaseRoot = null,
  artifactScopeRoots = [],
} = {}) {
  const root = path.resolve(scopeRoot || '.');
  const bundle = path.resolve(packageDir || '.');
  const configured = {
    maximumArchiveEntries: Number(limits.maximumArchiveEntries ?? 10_000),
    maximumEntryBytes: Number(limits.maximumEntryBytes ?? 256 * 1024 * 1024),
    maximumUncompressedBytes: Number(limits.maximumUncompressedBytes ?? 1024 * 1024 * 1024),
    maximumCompressionRatio: Number(limits.maximumCompressionRatio ?? 200),
  };
  const blockers = [];
  if (expectedArchiveManifest && expectedArchiveManifest.status !== 'scoped_source_tree_verified') {
    blockers.push('package_source_tree_manifest_not_verified', ...(expectedArchiveManifest.blockers || []));
  }
  if (bundle !== root && !bundle.startsWith(`${root}${path.sep}`)) blockers.push('package_directory_outside_scope');
  const recordPath = path.join(bundle, 'PACKAGE_RECORD.json');
  const sumsPath = path.join(bundle, 'SHA256SUMS.txt');
  if (!fs.existsSync(recordPath)) blockers.push('package_record_missing');
  if (!fs.existsSync(sumsPath)) blockers.push('package_sums_missing');
  let record = null;
  try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); } catch { blockers.push('package_record_invalid_json'); }
  if (expectedArtifactPackageHash && record?.artifactPackageHash !== expectedArtifactPackageHash) {
    blockers.push('package_record_artifact_package_hash_mismatch');
  }
  const declaredArtifacts = Array.isArray(record?.artifacts) ? record.artifacts : [];
  if (!declaredArtifacts.length) blockers.push('package_record_artifact_set_empty');
  const verifiedFiles = [];
  if (fs.existsSync(sumsPath)) {
    for (const raw of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(raw);
      if (!match) { blockers.push('package_sums_line_invalid'); continue; }
      const relative = match[2].trim();
      if (!safeRelative(relative)) { blockers.push(`package_path_unsafe:${relative}`); continue; }
      const candidate = path.resolve(root, relative);
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) { blockers.push(`package_path_outside_scope:${relative}`); continue; }
      if (!fs.existsSync(candidate) || !fs.lstatSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()) { blockers.push(`package_file_missing_or_unsafe:${relative}`); continue; }
      const actual = sha256File(candidate);
      if (actual !== `sha256:${match[1].toLowerCase()}`) blockers.push(`package_file_hash_mismatch:${relative}`);
      verifiedFiles.push({ path: relative, hash: actual, bytes: fs.statSync(candidate).size });
    }
  }
  const archives = verifiedFiles.filter((item) => /\.(?:zip|jar)$/i.test(item.path));
  const verifiedByPath = new Map(verifiedFiles.map((item) => [item.path, item]));
  for (const expected of expectedArtifacts || []) {
    if (!expected?.path || !expected?.hash) continue;
    const verified = verifiedByPath.get(expected.path);
    if (!verified) blockers.push(`package_expected_artifact_unverified:${expected.path}`);
    else if (verified.hash !== expected.hash) blockers.push(`package_expected_artifact_hash_mismatch:${expected.path}`);
  }
  const allowedArtifactRoots = [...new Set([root, ...(artifactScopeRoots || [])]
    .filter(Boolean).map((item) => path.resolve(item)))];
  const artifactBase = path.resolve(artifactBaseRoot || root);
  const settledArtifacts = [];
  for (const artifact of declaredArtifacts) {
    const identity = `${artifact?.id || ''}:${artifact?.role || ''}:${artifact?.path || ''}`;
    if (!artifact?.path || !artifact?.hash) {
      blockers.push(`package_artifact_binding_missing:${identity}`);
      continue;
    }
    const candidate = path.isAbsolute(artifact.path)
      ? path.resolve(artifact.path)
      : path.resolve(artifactBase, artifact.path);
    const scope = allowedArtifactRoots.find((candidateRoot) => candidate === candidateRoot || candidate.startsWith(`${candidateRoot}${path.sep}`));
    if (!scope) {
      blockers.push(`package_artifact_outside_authorized_scope:${artifact.path}`);
      continue;
    }
    const read = readScopedFileSync({ scopeRoot: scope, candidate, maximumBytes: configured.maximumEntryBytes });
    if (read.status !== 'scoped_file_read_verified') {
      blockers.push(`package_artifact_unreadable_or_unsafe:${artifact.path}`);
      continue;
    }
    if (read.hash !== artifact.hash) blockers.push(`package_artifact_hash_mismatch:${artifact.path}`);
    if (artifact.sizeBytes !== null && artifact.sizeBytes !== undefined && Number(artifact.sizeBytes) !== Number(read.bytes)) {
      blockers.push(`package_artifact_size_mismatch:${artifact.path}`);
    }
    settledArtifacts.push({ id: artifact.id || null, role: artifact.role || null, path: artifact.path, hash: read.hash, bytes: read.bytes });
  }
  const declaredArtifactKeys = declaredArtifacts.map((item) => `${item?.id || ''}\0${item?.role || ''}\0${item?.path || ''}\0${item?.hash || ''}`).sort();
  if (new Set(declaredArtifactKeys).size !== declaredArtifactKeys.length) blockers.push('package_artifact_set_duplicate');
  if (settledArtifacts.length !== declaredArtifacts.length) blockers.push('package_artifact_set_not_fully_settled');
  const artifactSettlementSubject = {
    artifactPackageHash: record?.artifactPackageHash || null,
    declaredArtifactCount: declaredArtifacts.length,
    settledArtifactCount: settledArtifacts.length,
    artifacts: settledArtifacts.sort((left, right) => String(left.id || left.path).localeCompare(String(right.id || right.path))),
  };
  const artifactSettlementHash = hashRecord('ArtifactSettlementSubject', artifactSettlementSubject);
  const archiveResults = archives.map((archive) => {
    const inspection = archiveInspector(path.resolve(root, archive.path));
    const issues = [];
    if (!inspection?.ok) issues.push(inspection?.blocker || 'archive_inspection_failed');
    const entries = inspection?.entries || [];
    if (entries.length > configured.maximumArchiveEntries) issues.push('archive_entry_count_exceeded');
    let total = 0;
    for (const entry of entries) {
      total += Number(entry.uncompressedBytes || 0);
      if (!safeRelative(entry.name)) issues.push(`archive_member_path_unsafe:${entry.name}`);
      if (String(entry.mode || '').startsWith('l')) issues.push(`archive_symlink_forbidden:${entry.name}`);
      if (!/^[-d]/.test(String(entry.mode || '-'))) issues.push(`archive_special_file_forbidden:${entry.name}`);
      if (Number(entry.uncompressedBytes || 0) > configured.maximumEntryBytes) issues.push(`archive_entry_size_exceeded:${entry.name}`);
      const ratio = Number(entry.uncompressedBytes || 0) / Math.max(1, Number(entry.compressedBytes || 0));
      if (ratio > configured.maximumCompressionRatio) issues.push(`archive_compression_ratio_exceeded:${entry.name}`);
      if (/(^|\/)(?:\.env|id_rsa|credentials|secrets?)(?:\.|$)/i.test(entry.name)) issues.push(`archive_secret_file_forbidden:${entry.name}`);
    }
    if (total > configured.maximumUncompressedBytes) issues.push('archive_total_size_exceeded');
    const expectedManifest = archive.path === expectedArchivePath ? expectedArchiveManifest : null;
    if (expectedManifest) {
      if (expectedManifest.status !== 'scoped_source_tree_verified') issues.push('archive_source_manifest_not_verified');
      const actualFiles = entries.filter((entry) => !String(entry.mode || '').startsWith('d'));
      const actualNames = actualFiles.map((entry) => entry.name).sort();
      const expectedRows = Array.isArray(expectedManifest.rows) ? expectedManifest.rows : [];
      const expectedNames = expectedRows.map((entry) => entry.path).sort();
      for (const name of expectedNames.filter((item) => !actualNames.includes(item))) issues.push(`archive_expected_member_missing:${name}`);
      for (const name of actualNames.filter((item) => !expectedNames.includes(item))) issues.push(`archive_unexpected_member:${name}`);
      if (!issues.length) {
        for (const expected of expectedRows) {
          const extracted = spawnSync('unzip', ['-p', path.resolve(root, archive.path), expected.path], {
            encoding: null,
            timeout: 30_000,
            maxBuffer: Math.min(configured.maximumEntryBytes + 1, 256 * 1024 * 1024),
          });
          if (extracted.status !== 0) { issues.push(`archive_member_read_failed:${expected.path}`); continue; }
          const content = Buffer.isBuffer(extracted.stdout) ? extracted.stdout : Buffer.from(extracted.stdout || '');
          const hash = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
          if (hash !== expected.hash) issues.push(`archive_member_hash_mismatch:${expected.path}`);
          if (content.length !== Number(expected.bytes)) issues.push(`archive_member_size_mismatch:${expected.path}`);
        }
      }
    }
    blockers.push(...issues.map((issue) => `${archive.path}:${issue}`));
    return { path: archive.path, entryCount: entries.length, uncompressedBytes: total, sourceTreeManifestHash: expectedManifest?.sourceTreeManifestHash || null, issues };
  });
  const payload = {
    version: 1,
    kind: 'PackageVerificationReceipt',
    status: blockers.length ? 'package_verification_blocked' : 'package_verification_passed',
    packageRecordHash: fs.existsSync(recordPath) ? sha256File(recordPath) : null,
    verifiedArtifactPackageHash: record?.artifactPackageHash || null,
    sourceTreeManifestHash: record?.sourceTreeManifestHash || null,
    paperId: record?.paperId || record?.slug || null,
    verifiedFiles,
    artifactSettlement: {
      ...artifactSettlementSubject,
      status: settledArtifacts.length === declaredArtifacts.length && !blockers.some((item) => item.startsWith('package_artifact_'))
        ? 'artifact_settlement_verified'
        : 'artifact_settlement_blocked',
      artifactSettlementHash,
    },
    archives: archiveResults,
    limits: configured,
    blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, packageVerificationReceiptHash: hashRecord('PackageVerificationReceipt', payload) });
}
