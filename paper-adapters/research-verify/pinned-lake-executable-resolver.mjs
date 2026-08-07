import fs from 'node:fs';
import path from 'node:path';

import {
  PRODUCTION_LEAN_RUNTIME_LAYOUTS,
  PRODUCTION_LEAN_TOOLCHAIN,
  PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  createLeanToolchainIdentityProvider,
  inspectNoExtendedAttributes,
} from './lean-toolchain-identity.mjs';

function unique(values) {
  return [...new Set(values)];
}

function stablePathIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    ownerUid: Number(stat.uid),
    ownerGid: Number(stat.gid),
    linkCount: Number(stat.nlink),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function rootOwnedPathBlockers(candidate, { expect = 'directory', executable = false } = {}) {
  const absolute = path.resolve(candidate);
  const blockers = [];
  const components = [];
  let cursor = absolute;
  while (true) {
    components.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const component of components.reverse()) {
    let stat;
    try { stat = fs.lstatSync(component); }
    catch {
      blockers.push(`formal_pinned_runtime_path_unreadable:${component}`);
      break;
    }
    if (stat.isSymbolicLink()) {
      blockers.push(`formal_pinned_runtime_symlink_forbidden:${component}`);
      break;
    }
    const selected = component === absolute;
    if (selected && expect === 'file' && !stat.isFile()) {
      blockers.push(`formal_pinned_runtime_regular_file_required:${component}`);
    } else if ((!selected || expect === 'directory') && !stat.isDirectory()) {
      blockers.push(`formal_pinned_runtime_directory_required:${component}`);
    }
    if (stat.uid !== 0 || stat.gid !== 0) {
      blockers.push(`formal_pinned_runtime_root_ownership_required:${component}`);
    }
    if ((stat.mode & 0o022) !== 0) {
      blockers.push(`formal_pinned_runtime_group_or_other_writable:${component}`);
    }
    if ((stat.mode & 0o7000) !== 0) {
      blockers.push(`formal_pinned_runtime_special_mode_bits_forbidden:${component}`);
    }
    if (selected && expect === 'file' && stat.nlink !== 1) {
      blockers.push(`formal_pinned_runtime_hardlink_forbidden:${component}`);
    }
    if (selected && expect === 'file' && stat.size <= 0) {
      blockers.push(`formal_pinned_runtime_nonempty_file_required:${component}`);
    }
    if (selected && executable && (stat.mode & 0o111) === 0) {
      blockers.push(`formal_pinned_runtime_executable_mode_required:${component}`);
    }
  }
  return blockers;
}

export function resolvePinnedLakeExecutable({
  toolchain = PRODUCTION_LEAN_TOOLCHAIN,
  environment = process.env,
  forceContentRehash = false,
} = {}) {
  const blockers = [];
  const codeAuthorizedToolchain = toolchain === PRODUCTION_LEAN_TOOLCHAIN;
  const layout = codeAuthorizedToolchain
    ? PRODUCTION_LEAN_RUNTIME_LAYOUTS[PRODUCTION_LEAN_TOOLCHAIN] : null;
  const expectedToolchainRootMerkleHash = codeAuthorizedToolchain
    ? PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[PRODUCTION_LEAN_TOOLCHAIN]
    : null;
  const configuredHome = String(environment?.ELAN_HOME || '').trim();
  if (!codeAuthorizedToolchain || !layout || !expectedToolchainRootMerkleHash) {
    blockers.push('formal_pinned_toolchain_not_code_authorized');
  }
  if (!configuredHome || !path.isAbsolute(configuredHome)) {
    blockers.push('formal_pinned_elan_home_absolute_required');
  }
  const home = configuredHome ? path.resolve(configuredHome) : null;
  const toolchainRoot = home && layout
    ? path.join(home, ...layout.toolchainRootRelative.split('/')) : null;
  const lakeExecutable = toolchainRoot && layout
    ? path.join(toolchainRoot, ...layout.lakeRelative.split('/')) : null;
  const leanExecutable = toolchainRoot && layout
    ? path.join(toolchainRoot, ...layout.leanRelative.split('/')) : null;
  if (home && toolchainRoot && (!isPathWithin(home, toolchainRoot)
    || !isPathWithin(toolchainRoot, lakeExecutable)
    || !isPathWithin(toolchainRoot, leanExecutable))) {
    blockers.push('formal_pinned_runtime_layout_escape');
  }
  if (home) blockers.push(...rootOwnedPathBlockers(home));
  if (toolchainRoot) blockers.push(...rootOwnedPathBlockers(toolchainRoot));
  if (lakeExecutable) {
    blockers.push(...rootOwnedPathBlockers(lakeExecutable, {
      expect: 'file', executable: true,
    }));
  }
  if (leanExecutable) {
    blockers.push(...rootOwnedPathBlockers(leanExecutable, {
      expect: 'file', executable: true,
    }));
  }
  if (!blockers.length) {
    const selectedPaths = [
      home,
      path.join(home, 'toolchains'),
      toolchainRoot,
      path.dirname(lakeExecutable),
      lakeExecutable,
      leanExecutable,
    ];
    const selectedAndAncestors = unique(selectedPaths.flatMap((candidate) => {
      const chain = [];
      let cursor = path.resolve(candidate);
      while (true) {
        chain.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      return chain;
    }));
    blockers.push(...inspectNoExtendedAttributes(selectedAndAncestors).blockers);
  }
  let identity = null;
  let identityProvider = null;
  if (!blockers.length) {
    try {
      const selectedPaths = [
        home,
        path.join(home, 'toolchains'),
        toolchainRoot,
        path.dirname(lakeExecutable),
        lakeExecutable,
        leanExecutable,
      ];
      const before = selectedPaths.map(stablePathIdentity);
      identityProvider = createLeanToolchainIdentityProvider({
        toolchain,
        toolchainRoot,
        leanExecutable,
        lakeExecutable,
        expectedToolchainRootMerkleHash,
        requiredOwnerUid: 0,
        requiredOwnerGid: 0,
        forbidGroupOrOtherWrite: true,
      });
      identity = identityProvider.inspect({ forceContentRehash });
      const after = selectedPaths.map(stablePathIdentity);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        blockers.push('formal_pinned_runtime_identity_changed_during_inspection');
      }
      if (identity.status !== 'lean_toolchain_identity_verified'
        || identity.toolchainRootMerkleHash !== expectedToolchainRootMerkleHash
        || identity.lakeExecutableHash !== layout.lakeExecutableHash
        || identity.leanExecutableHash !== layout.leanExecutableHash) {
        blockers.push(...(identity.blockers || [
          'formal_pinned_toolchain_content_identity_required',
        ]));
        if (identity.lakeExecutableHash !== layout.lakeExecutableHash) {
          blockers.push('formal_pinned_lake_executable_hash_mismatch');
        }
        if (identity.leanExecutableHash !== layout.leanExecutableHash) {
          blockers.push('formal_pinned_lean_executable_hash_mismatch');
        }
      }
    } catch (error) {
      blockers.push(`formal_pinned_toolchain_inspection_failed:${String(
        error?.message || error,
      )}`);
    }
  }
  const resolved = blockers.length === 0;
  return Object.freeze({
    status: resolved
      ? 'formal_pinned_lake_resolved'
      : 'formal_pinned_lake_resolution_blocked',
    toolchain,
    elanHome: resolved ? home : null,
    executable: resolved ? lakeExecutable : null,
    lakeExecutable: resolved ? lakeExecutable : null,
    leanExecutable: resolved ? leanExecutable : null,
    toolchainRoot: resolved ? toolchainRoot : null,
    expectedToolchainRootMerkleHash,
    lakeExecutableHash: resolved ? identity.lakeExecutableHash : null,
    leanExecutableHash: resolved ? identity.leanExecutableHash : null,
    toolchainIdentity: resolved ? identity : null,
    blockers: Object.freeze(unique(blockers)),
  });
}
