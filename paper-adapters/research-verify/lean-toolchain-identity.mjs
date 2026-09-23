import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectScopedPathSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

const identityCache = new Map();
const rootContentCache = new Map();
const EXTENDED_ATTRIBUTE_INSPECTOR = String.raw`
import os
import stat
import sys

recursive = sys.argv[1] == "recursive"
stack = list(sys.argv[2:])
try:
    while stack:
        selected = stack.pop()
        if os.listxattr(selected, follow_symlinks=False):
            raise SystemExit(3)
        if recursive and stat.S_ISDIR(os.lstat(selected).st_mode):
            with os.scandir(selected) as entries:
                stack.extend(entry.path for entry in entries)
except SystemExit:
    raise
except BaseException:
    raise SystemExit(4)
`;

export function inspectNoExtendedAttributes(paths, { recursive = false } = {}) {
  const selected = [...new Set((paths || []).map((candidate) => path.resolve(candidate)))];
  if (!selected.length) return Object.freeze({ ready: false, blockers: [
    'formal_toolchain_extended_attribute_paths_required',
  ] });
  const result = spawnSync('/usr/bin/python3', [
    '-I', '-c', EXTENDED_ATTRIBUTE_INSPECTOR,
    recursive ? 'recursive' : 'selected',
    ...selected,
  ], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    timeout: 60_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  let blocker = null;
  if (result.error?.code === 'ENOENT') {
    blocker = 'formal_toolchain_extended_attribute_inspector_unavailable';
  } else if (result.error || result.status === null || result.signal) {
    blocker = 'formal_toolchain_extended_attribute_inspection_failed';
  } else if (result.status === 3) {
    blocker = 'formal_toolchain_extended_attributes_forbidden';
  } else if (result.status !== 0) {
    blocker = 'formal_toolchain_extended_attribute_inspection_failed';
  }
  return Object.freeze({
    ready: blocker === null,
    blockers: Object.freeze(blocker ? [blocker] : []),
  });
}

function stableStat(stat) {
  return {
    device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
    ownerUid: Number(stat.uid), ownerGid: Number(stat.gid),
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

function scanMetadata(root, {
  maximumFiles = 50000,
  maximumBytes = 8 * 1024 * 1024 * 1024,
  requiredOwnerUid = null,
  requiredOwnerGid = null,
  forbidGroupOrOtherWrite = false,
} = {}) {
  const records = [];
  let bytes = 0;
  const blockers = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      const stat = fs.lstatSync(absolute, { bigint: true });
      if (requiredOwnerUid !== null && Number(stat.uid) !== requiredOwnerUid) {
        blockers.push(`formal_toolchain_entry_owner_uid_mismatch:${relative}`);
      }
      if (requiredOwnerGid !== null && Number(stat.gid) !== requiredOwnerGid) {
        blockers.push(`formal_toolchain_entry_owner_gid_mismatch:${relative}`);
      }
      if (forbidGroupOrOtherWrite && !stat.isSymbolicLink()
        && (Number(stat.mode) & 0o022) !== 0) {
        blockers.push(`formal_toolchain_entry_group_or_other_writable:${relative}`);
      }
      if (forbidGroupOrOtherWrite && (Number(stat.mode) & 0o7000) !== 0) {
        blockers.push(`formal_toolchain_entry_special_mode_bits_forbidden:${relative}`);
      }
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

export function inspectLeanToolchainRootContent({
  toolchain,
  toolchainRoot,
  leanExecutable,
  lakeExecutable,
  expectedToolchainRootMerkleHash = null,
  requiredOwnerUid = null,
  requiredOwnerGid = null,
  forbidGroupOrOtherWrite = false,
  forceContentRehash = false,
} = {}) {
  const root = path.resolve(toolchainRoot || '.');
  const leanPath = relativeExecutable(root, leanExecutable);
  const lakePath = relativeExecutable(root, lakeExecutable);
  const blockers = [];
  const rootIdentity = inspectScopedPathSync({
    scopeRoot: root,
    candidate: root,
    expect: 'directory',
    forbidHardlinks: false,
  });
  if (rootIdentity.status !== 'scoped_file_identity_verified') {
    blockers.push('formal_toolchain_root_unsafe');
  }
  let rootStat = null;
  try { rootStat = fs.lstatSync(root, { bigint: true }); }
  catch { blockers.push('formal_toolchain_root_unreadable'); }
  if (rootStat && requiredOwnerUid !== null
    && Number(rootStat.uid) !== requiredOwnerUid) {
    blockers.push('formal_toolchain_root_owner_uid_mismatch');
  }
  if (rootStat && requiredOwnerGid !== null
    && Number(rootStat.gid) !== requiredOwnerGid) {
    blockers.push('formal_toolchain_root_owner_gid_mismatch');
  }
  if (rootStat && forbidGroupOrOtherWrite
    && (Number(rootStat.mode) & 0o022) !== 0) {
    blockers.push('formal_toolchain_root_group_or_other_writable');
  }
  if (rootStat && forbidGroupOrOtherWrite
    && (Number(rootStat.mode) & 0o7000) !== 0) {
    blockers.push('formal_toolchain_root_special_mode_bits_forbidden');
  }
  if (!leanPath) blockers.push('formal_lean_executable_outside_toolchain_root');
  if (!lakePath) blockers.push('formal_lake_executable_outside_toolchain_root');
  let metadata = null;
  try {
    metadata = blockers.length ? null : scanMetadata(root, {
      requiredOwnerUid,
      requiredOwnerGid,
      forbidGroupOrOtherWrite,
    });
  } catch (error) {
    blockers.push(error?.message || 'formal_toolchain_manifest_failed');
  }
  blockers.push(...(metadata?.blockers || []));
  if (!blockers.length && forbidGroupOrOtherWrite) {
    blockers.push(...inspectNoExtendedAttributes([root], {
      recursive: true,
    }).blockers);
  }
  if (blockers.length) {
    return Object.freeze({
      status: 'lean_toolchain_root_content_blocked',
      blockers: Object.freeze([...new Set(blockers)]),
    });
  }
  const cacheKey = [
    toolchain || '',
    root,
    leanPath,
    lakePath,
    expectedToolchainRootMerkleHash || '',
    requiredOwnerUid ?? '',
    requiredOwnerGid ?? '',
    forbidGroupOrOtherWrite ? 'forbid-022-xattr' : 'allow-022-xattr',
  ].join('\0');
  const cached = rootContentCache.get(cacheKey);
  if (!forceContentRehash
    && cached?.metadataManifestHash === metadata.metadataManifestHash) {
    return cached.summary;
  }
  let contentRecords = [];
  try {
    contentRecords = metadata.records.map((record) => contentRecord(root, record));
  } catch (error) {
    return Object.freeze({
      status: 'lean_toolchain_root_content_blocked',
      blockers: Object.freeze([
        error?.message || 'formal_toolchain_content_hash_failed',
      ]),
    });
  }
  const byPath = new Map(contentRecords.map((record) => [record.path, record]));
  const leanRecord = byPath.get(leanPath);
  const lakeRecord = byPath.get(lakePath);
  if (leanRecord?.type !== 'file' || lakeRecord?.type !== 'file') {
    return Object.freeze({
      status: 'lean_toolchain_root_content_blocked',
      blockers: Object.freeze(['formal_toolchain_executable_manifest_missing']),
    });
  }
  const stdlibRecords = contentRecords.filter((record) => (
    record.path.startsWith('lib/lean/')
  ));
  const runtimeLibraryRecords = contentRecords.filter((record) => (
    record.path.startsWith('lib/') && !record.path.startsWith('lib/lean/')
  ));
  if (!stdlibRecords.length || !runtimeLibraryRecords.length) {
    return Object.freeze({
      status: 'lean_toolchain_root_content_blocked',
      blockers: Object.freeze(['formal_toolchain_runtime_closure_incomplete']),
    });
  }
  const toolchainRootMerkleHash = hashRecord(
    'LeanToolchainRootMerkle',
    contentRecords,
  );
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(expectedToolchainRootMerkleHash || ''))) {
    return Object.freeze({
      status: 'lean_toolchain_root_content_blocked',
      measuredToolchainRootMerkleHash: toolchainRootMerkleHash,
      blockers: Object.freeze(['formal_toolchain_trust_anchor_required']),
    });
  }
  if (toolchainRootMerkleHash !== expectedToolchainRootMerkleHash) {
    return Object.freeze({
      status: 'lean_toolchain_root_content_blocked',
      measuredToolchainRootMerkleHash: toolchainRootMerkleHash,
      trustedToolchainRootMerkleHash: expectedToolchainRootMerkleHash,
      blockers: Object.freeze(['formal_toolchain_trust_anchor_mismatch']),
    });
  }
  const summary = Object.freeze({
    status: 'lean_toolchain_root_content_verified',
    toolchain,
    leanExecutablePath: leanPath,
    leanExecutableHash: leanRecord.hash,
    lakeExecutablePath: lakePath,
    lakeExecutableHash: lakeRecord.hash,
    toolchainFileCount: contentRecords.filter((record) => record.type === 'file').length,
    toolchainTotalBytes: metadata.bytes,
    toolchainMetadataManifestHash: metadata.metadataManifestHash,
    toolchainContentManifestHash: hashRecord(
      'LeanToolchainContentManifest',
      contentRecords,
    ),
    toolchainRootMerkleHash,
    trustedToolchainRootMerkleHash: expectedToolchainRootMerkleHash,
    stdlibManifestHash: hashRecord('LeanToolchainStdlibManifest', stdlibRecords),
    runtimeLibraryManifestHash: hashRecord(
      'LeanToolchainRuntimeLibraryManifest',
      runtimeLibraryRecords,
    ),
    blockers: Object.freeze([]),
  });
  rootContentCache.set(cacheKey, {
    metadataManifestHash: metadata.metadataManifestHash,
    summary,
  });
  return summary;
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
  inspectExternalRuntime = externalDynamicRuntimeClosure,
  requiredOwnerUid = null,
  requiredOwnerGid = null,
  forbidGroupOrOtherWrite = false,
} = {}) {
  const root = path.resolve(toolchainRoot || '.');
  const leanPath = relativeExecutable(root, leanExecutable);
  const lakePath = relativeExecutable(root, lakeExecutable);
  return Object.freeze({
    inspect({ forceContentRehash = false } = {}) {
      const content = inspectLeanToolchainRootContent({
        toolchain,
        toolchainRoot: root,
        leanExecutable,
        lakeExecutable,
        expectedToolchainRootMerkleHash,
        requiredOwnerUid,
        requiredOwnerGid,
        forbidGroupOrOtherWrite,
        forceContentRehash,
      });
      if (content.status !== 'lean_toolchain_root_content_verified') {
        return Object.freeze({
          status: 'lean_toolchain_identity_blocked',
          ...(content.measuredToolchainRootMerkleHash ? {
            measuredToolchainRootMerkleHash:
              content.measuredToolchainRootMerkleHash,
          } : {}),
          ...(content.trustedToolchainRootMerkleHash ? {
            trustedToolchainRootMerkleHash:
              content.trustedToolchainRootMerkleHash,
          } : {}),
          blockers: content.blockers,
        });
      }
      const cacheKey = [
        toolchain,
        root,
        leanPath || '',
        lakePath || '',
        expectedToolchainRootMerkleHash || '',
        requiredOwnerUid ?? '',
        requiredOwnerGid ?? '',
        forbidGroupOrOtherWrite ? 'forbid-022-xattr' : 'allow-022-xattr',
      ].join('\0');
      const cached = identityCache.get(cacheKey);
      if (!forceContentRehash
        && cached?.metadataManifestHash === content.toolchainMetadataManifestHash) {
        const externalRuntime = inspectExternalRuntime({
          root, executables: [leanExecutable, lakeExecutable],
        });
        if (!externalRuntime.blockers.length
          && externalRuntime.records.length > 0
          && externalRuntime.metadataManifestHash === cached.identity.externalDynamicRuntimeMetadataManifestHash
          && hashRecord('LeanExternalDynamicRuntimeManifest', externalRuntime.records) === cached.identity.externalDynamicRuntimeManifestHash) {
          return cached.identity;
        }
      }
      const externalRuntime = inspectExternalRuntime({
        root, executables: [leanExecutable, lakeExecutable],
      });
      if (externalRuntime.blockers.length || !externalRuntime.records.length) {
        return Object.freeze({ status: 'lean_toolchain_identity_blocked', blockers: [...new Set(externalRuntime.blockers)] });
      }
      const payload = {
        version: 1,
        kind: 'LeanToolchainContentIdentity',
        status: 'lean_toolchain_identity_verified',
        toolchain,
        leanExecutablePath: content.leanExecutablePath,
        leanExecutableHash: content.leanExecutableHash,
        lakeExecutablePath: content.lakeExecutablePath,
        lakeExecutableHash: content.lakeExecutableHash,
        toolchainFileCount: content.toolchainFileCount,
        toolchainTotalBytes: content.toolchainTotalBytes,
        toolchainMetadataManifestHash: content.toolchainMetadataManifestHash,
        toolchainContentManifestHash: content.toolchainContentManifestHash,
        toolchainRootMerkleHash: content.toolchainRootMerkleHash,
        trustedToolchainRootMerkleHash: expectedToolchainRootMerkleHash,
        toolchainTrustAnchorStatus: 'pinned_toolchain_root_allowlist_verified',
        trustedOwnerUid: requiredOwnerUid,
        trustedOwnerGid: requiredOwnerGid,
        groupOrOtherWriteForbidden: forbidGroupOrOtherWrite,
        extendedAttributesForbidden: forbidGroupOrOtherWrite,
        stdlibManifestHash: content.stdlibManifestHash,
        runtimeLibraryManifestHash: content.runtimeLibraryManifestHash,
        externalDynamicRuntimeFileCount: externalRuntime.records.length,
        externalDynamicRuntimeMetadataManifestHash: externalRuntime.metadataManifestHash,
        externalDynamicRuntimeManifestHash: hashRecord('LeanExternalDynamicRuntimeManifest', externalRuntime.records),
        blockers: [],
      };
      const identity = Object.freeze({ ...payload, leanToolchainContentIdentityHash: hashRecord('LeanToolchainContentIdentity', payload) });
      identityCache.set(cacheKey, {
        metadataManifestHash: content.toolchainMetadataManifestHash,
        identity,
      });
      return identity;
    },
  });
}
