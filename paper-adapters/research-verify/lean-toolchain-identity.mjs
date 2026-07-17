import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectScopedPathSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

const identityCache = new Map();

function stableStat(stat) {
  return {
    device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
    size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), linkCount: Number(stat.nlink),
  };
}

function stableFileHash(absolute) {
  const before = fs.lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('formal_toolchain_regular_file_required');
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (String(opened.dev) !== String(before.dev) || String(opened.ino) !== String(before.ino)) {
      throw new Error('formal_toolchain_file_identity_changed');
    }
    let offset = 0;
    while (offset < Number(opened.size)) {
      const bytes = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, Number(opened.size) - offset), offset);
      if (bytes <= 0) throw new Error('formal_toolchain_file_short_read');
      digest.update(buffer.subarray(0, bytes));
      offset += bytes;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (JSON.stringify(stableStat(opened)) !== JSON.stringify(stableStat(after))) {
      throw new Error('formal_toolchain_file_changed_during_hash');
    }
  } finally { fs.closeSync(descriptor); }
  const afterPath = fs.lstatSync(absolute, { bigint: true });
  if (JSON.stringify(stableStat(before)) !== JSON.stringify(stableStat(afterPath))) {
    throw new Error('formal_toolchain_file_changed_during_hash');
  }
  return `sha256:${digest.digest('hex')}`;
}

function scanMetadata(root, { maximumFiles = 50000, maximumBytes = 8 * 1024 * 1024 * 1024 } = {}) {
  const records = [];
  let bytes = 0;
  const blockers = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (stat.isDirectory()) {
        records.push({ path: relative, type: 'directory', stat: stableStat(stat) });
        walk(absolute);
      } else if (stat.isFile()) {
        bytes += Number(stat.size);
        records.push({ path: relative, type: 'file', stat: stableStat(stat) });
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        let resolved = null;
        try { resolved = fs.realpathSync.native(absolute); } catch { /* blocker below */ }
        if (!resolved || !isPathWithin(root, resolved)) blockers.push(`formal_toolchain_symlink_escape:${relative}`);
        records.push({ path: relative, type: 'symlink', target, stat: stableStat(stat) });
      } else blockers.push(`formal_toolchain_special_file_forbidden:${relative}`);
      if (records.length > maximumFiles) throw new Error('formal_toolchain_file_count_exceeded');
      if (bytes > maximumBytes) throw new Error('formal_toolchain_total_bytes_exceeded');
    }
  };
  walk(root);
  return { records, bytes, blockers, metadataManifestHash: hashRecord('LeanToolchainMetadataManifest', records) };
}

function contentRecord(root, metadata) {
  if (metadata.type === 'directory') return Object.freeze({ path: metadata.path, type: metadata.type, mode: Number(metadata.stat.mode) & 0o777 });
  if (metadata.type === 'symlink') return Object.freeze({ path: metadata.path, type: metadata.type, target: metadata.target });
  return Object.freeze({
    path: metadata.path,
    type: metadata.type,
    mode: Number(metadata.stat.mode) & 0o777,
    bytes: metadata.stat.size,
    hash: stableFileHash(path.join(root, metadata.path)),
  });
}

function relativeExecutable(root, executable) {
  const resolved = path.resolve(executable || '');
  return isPathWithin(root, resolved) ? path.relative(root, resolved).replace(/\\/g, '/') : null;
}

function externalDynamicRuntimeClosure({ root, executables }) {
  const blockers = [];
  const lddPath = fs.existsSync('/usr/bin/ldd') ? fs.realpathSync.native('/usr/bin/ldd') : null;
  if (!lddPath) return { records: [], blockers: ['formal_dynamic_link_inspector_missing'], metadataManifestHash: null };
  const paths = new Set([lddPath]);
  if (fs.existsSync('/etc/ld.so.cache')) paths.add(fs.realpathSync.native('/etc/ld.so.cache'));
  for (const executable of executables) {
    const result = spawnSync(lddPath, [executable], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
      timeout: 10000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      blockers.push(`formal_dynamic_link_closure_unreadable:${path.basename(executable)}`);
      continue;
    }
    for (const line of String(result.stdout || '').split(/\r?\n/)) {
      const match = line.match(/(?:=>\s*)?(\/[A-Za-z0-9_+.,:@%/=-]+)(?:\s|$|\()/);
      if (!match) continue;
      let resolved = null;
      try { resolved = fs.realpathSync.native(match[1]); } catch { blockers.push('formal_dynamic_link_target_missing'); }
      if (!resolved || isPathWithin(root, resolved)) continue;
      if (!['/lib', '/lib64', '/usr/lib', '/usr/lib64', '/etc'].some((allowed) => resolved === allowed || isPathWithin(allowed, resolved))) {
        blockers.push(`formal_dynamic_link_target_outside_system_roots:${resolved}`);
      } else paths.add(resolved);
    }
  }
  const records = [];
  for (const absolute of [...paths].sort()) {
    try {
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not_regular');
      records.push(Object.freeze({
        path: absolute,
        mode: Number(stat.mode) & 0o777,
        bytes: Number(stat.size),
        hash: stableFileHash(absolute),
        stat: stableStat(stat),
      }));
    } catch { blockers.push(`formal_dynamic_link_target_unsafe:${absolute}`); }
  }
  return {
    records,
    blockers,
    metadataManifestHash: hashRecord('LeanExternalDynamicRuntimeMetadataManifest', records.map(({ hash: _hash, ...record }) => record)),
  };
}

export function createLeanToolchainIdentityProvider({
  toolchain,
  toolchainRoot,
  leanExecutable,
  lakeExecutable,
  expectedToolchainRootMerkleHash = null,
} = {}) {
  const root = path.resolve(toolchainRoot || '.');
  const leanPath = relativeExecutable(root, leanExecutable);
  const lakePath = relativeExecutable(root, lakeExecutable);
  return Object.freeze({
    inspect({ forceContentRehash = false } = {}) {
      const blockers = [];
      const rootIdentity = inspectScopedPathSync({ scopeRoot: root, candidate: root, expect: 'directory', forbidHardlinks: false });
      if (rootIdentity.status !== 'scoped_file_identity_verified') blockers.push('formal_toolchain_root_unsafe');
      if (!leanPath) blockers.push('formal_lean_executable_outside_toolchain_root');
      if (!lakePath) blockers.push('formal_lake_executable_outside_toolchain_root');
      let metadata = null;
      try { metadata = blockers.length ? null : scanMetadata(root); }
      catch (error) { blockers.push(error?.message || 'formal_toolchain_manifest_failed'); }
      blockers.push(...(metadata?.blockers || []));
      if (blockers.length) return Object.freeze({ status: 'lean_toolchain_identity_blocked', blockers: [...new Set(blockers)] });
      const cacheKey = `${toolchain}\0${root}\0${expectedToolchainRootMerkleHash || ''}`;
      const cached = identityCache.get(cacheKey);
      if (!forceContentRehash && cached?.metadataManifestHash === metadata.metadataManifestHash) {
        const externalRuntime = externalDynamicRuntimeClosure({ root, executables: [leanExecutable, lakeExecutable] });
        if (!externalRuntime.blockers.length
          && externalRuntime.records.length > 0
          && externalRuntime.metadataManifestHash === cached.identity.externalDynamicRuntimeMetadataManifestHash
          && hashRecord('LeanExternalDynamicRuntimeManifest', externalRuntime.records) === cached.identity.externalDynamicRuntimeManifestHash) {
          return cached.identity;
        }
      }
      let contentRecords = [];
      try { contentRecords = metadata.records.map((record) => contentRecord(root, record)); }
      catch (error) {
        return Object.freeze({ status: 'lean_toolchain_identity_blocked', blockers: [error?.message || 'formal_toolchain_content_hash_failed'] });
      }
      const byPath = new Map(contentRecords.map((record) => [record.path, record]));
      const leanRecord = byPath.get(leanPath);
      const lakeRecord = byPath.get(lakePath);
      if (leanRecord?.type !== 'file' || lakeRecord?.type !== 'file') {
        return Object.freeze({ status: 'lean_toolchain_identity_blocked', blockers: ['formal_toolchain_executable_manifest_missing'] });
      }
      const stdlibRecords = contentRecords.filter((record) => record.path.startsWith('lib/lean/'));
      const runtimeLibraryRecords = contentRecords.filter((record) => record.path.startsWith('lib/') && !record.path.startsWith('lib/lean/'));
      if (!stdlibRecords.length || !runtimeLibraryRecords.length) {
        return Object.freeze({ status: 'lean_toolchain_identity_blocked', blockers: ['formal_toolchain_runtime_closure_incomplete'] });
      }
      const toolchainRootMerkleHash = hashRecord('LeanToolchainRootMerkle', contentRecords);
      if (!/^sha256:[0-9a-f]{64}$/i.test(String(expectedToolchainRootMerkleHash || ''))) {
        return Object.freeze({
          status: 'lean_toolchain_identity_blocked',
          measuredToolchainRootMerkleHash: toolchainRootMerkleHash,
          blockers: ['formal_toolchain_trust_anchor_required'],
        });
      }
      if (toolchainRootMerkleHash !== expectedToolchainRootMerkleHash) {
        return Object.freeze({
          status: 'lean_toolchain_identity_blocked',
          measuredToolchainRootMerkleHash: toolchainRootMerkleHash,
          trustedToolchainRootMerkleHash: expectedToolchainRootMerkleHash,
          blockers: ['formal_toolchain_trust_anchor_mismatch'],
        });
      }
      const externalRuntime = externalDynamicRuntimeClosure({ root, executables: [leanExecutable, lakeExecutable] });
      if (externalRuntime.blockers.length || !externalRuntime.records.length) {
        return Object.freeze({ status: 'lean_toolchain_identity_blocked', blockers: [...new Set(externalRuntime.blockers)] });
      }
      const payload = {
        version: 1,
        kind: 'LeanToolchainContentIdentity',
        status: 'lean_toolchain_identity_verified',
        toolchain,
        leanExecutablePath: leanPath,
        leanExecutableHash: leanRecord.hash,
        lakeExecutablePath: lakePath,
        lakeExecutableHash: lakeRecord.hash,
        toolchainFileCount: contentRecords.filter((record) => record.type === 'file').length,
        toolchainTotalBytes: metadata.bytes,
        toolchainMetadataManifestHash: metadata.metadataManifestHash,
        toolchainContentManifestHash: hashRecord('LeanToolchainContentManifest', contentRecords),
        toolchainRootMerkleHash,
        trustedToolchainRootMerkleHash: expectedToolchainRootMerkleHash,
        toolchainTrustAnchorStatus: 'pinned_toolchain_root_allowlist_verified',
        stdlibManifestHash: hashRecord('LeanToolchainStdlibManifest', stdlibRecords),
        runtimeLibraryManifestHash: hashRecord('LeanToolchainRuntimeLibraryManifest', runtimeLibraryRecords),
        externalDynamicRuntimeFileCount: externalRuntime.records.length,
        externalDynamicRuntimeMetadataManifestHash: externalRuntime.metadataManifestHash,
        externalDynamicRuntimeManifestHash: hashRecord('LeanExternalDynamicRuntimeManifest', externalRuntime.records),
        blockers: [],
      };
      const identity = Object.freeze({ ...payload, leanToolchainContentIdentityHash: hashRecord('LeanToolchainContentIdentity', payload) });
      identityCache.set(cacheKey, { metadataManifestHash: metadata.metadataManifestHash, identity });
      return identity;
    },
  });
}
