import fs from 'node:fs';
import path from 'node:path';

import {
  PRODUCTION_AUTONOMOUS_RESEARCH_RUNTIME_ROOT,
  PRODUCTION_AUTONOMOUS_SUBMISSION_HANDOFF_LAYOUT_RECEIPT_PATH,
  verifyAutonomousSubmissionHandoffLayoutReceipt,
} from '../automation/autonomous-submission-handoff-layout-receipt-repository.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY || 0;

export const RUNTIME_PERMISSION_PROTECTED_SHARED_LAYOUT_POLICY = Object.freeze({
  version: 1,
  kind: 'RuntimePermissionProtectedSharedLayoutPolicy',
  anchorRelativePath: 'autonomous-research/submission-handoff',
  preserveExactRelativePaths: Object.freeze(['.', 'autonomous-research']),
  preservePrefixRelativePaths: Object.freeze([
    'autonomous-research/submission-handoff',
  ]),
  requiredEntries: Object.freeze([
    Object.freeze({ relativePath: '.', type: 'directory', mode: '0710' }),
    Object.freeze({
      relativePath: 'autonomous-research', type: 'directory', mode: '0710',
    }),
    Object.freeze({
      relativePath: 'autonomous-research/submission-handoff',
      type: 'directory',
      mode: '3770',
    }),
    Object.freeze({
      relativePath: 'autonomous-research/submission-handoff/submission-handoff.sqlite',
      type: 'regular_file',
      mode: '0660',
    }),
    Object.freeze({
      relativePath: 'autonomous-research/submission-handoff/dispatcher-challenges',
      type: 'directory',
      mode: '2750',
    }),
    Object.freeze({
      relativePath: 'autonomous-research/submission-handoff/dispatcher-cycles',
      type: 'directory',
      mode: '2750',
    }),
  ]),
  descendantRegularFileModeRule:
    'owner_read_required_subset_of_0660_without_special_or_other_bits',
  descendantDirectoryModeRule:
    'owner_read_execute_required_subset_of_2770_without_setuid_sticky_or_other_bits',
  groupRule: 'every_protected_entry_uses_detected_common_layout_group',
  productionIdentityRule:
    'supervisor_owns_runtime_research_database_challenges_root_owns_handoff_dispatcher_owns_cycles',
  productionRuntimeRoot: PRODUCTION_AUTONOMOUS_RESEARCH_RUNTIME_ROOT,
});

export function verifyRuntimePermissionProductionSharedLayoutAuthority({
  runtimeRoot,
  verifier = verifyAutonomousSubmissionHandoffLayoutReceipt,
} = {}) {
  if (runtimeRoot !== PRODUCTION_AUTONOMOUS_RESEARCH_RUNTIME_ROOT
    || typeof verifier !== 'function') {
    return false;
  }
  try {
    const receipt = verifier({
      runtimeRoot,
      receiptPath: PRODUCTION_AUTONOMOUS_SUBMISSION_HANDOFF_LAYOUT_RECEIPT_PATH,
    });
    return receipt?.status
        === 'autonomous_submission_handoff_layout_receipt_verified'
      && receipt.ready === true
      && receipt.databaseOpenedReadOnly === true
      && receipt.databaseContentCreated === false
      && receipt.credentialContentCreated === false
      && receipt.authorityContentCreated === false
      && /^sha256:[0-9a-f]{64}$/.test(String(receipt.databaseSha256 || ''));
  } catch {
    return false;
  }
}

function typeOf(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'regular_file';
  if (stat.isSymbolicLink()) return 'symbolic_link';
  if (stat.isSocket()) return 'socket';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isBlockDevice()) return 'block_device';
  if (stat.isCharacterDevice()) return 'character_device';
  return 'unknown';
}

function modeNumber(stat) {
  return Number(stat.mode & 0o7777n);
}

function octalMode(stat) {
  return modeNumber(stat).toString(8).padStart(4, '0');
}

function identityOf(stat) {
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    type: typeOf(stat),
    linkCount: Number(stat.nlink),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
  });
}

function sameObject(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && typeOf(left) === typeOf(right);
}

function productionRuntimeRootIdentityRequired(root) {
  const productionRoot =
    RUNTIME_PERMISSION_PROTECTED_SHARED_LAYOUT_POLICY.productionRuntimeRoot;
  const exactProductionPath = root.resolved === productionRoot;
  let productionDescriptor;
  let productionPathObserved = false;
  try {
    const observed = fs.lstatSync(productionRoot, { bigint: true });
    productionPathObserved = true;
    if (observed.isSymbolicLink() || !observed.isDirectory()
      || fs.realpathSync.native(productionRoot) !== productionRoot) {
      throw new Error('runtime_permission_production_root_noncanonical');
    }
    productionDescriptor = fs.openSync(
      productionRoot,
      fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW,
    );
    const pinned = fs.fstatSync(productionDescriptor, { bigint: true });
    const current = fs.lstatSync(productionRoot, { bigint: true });
    if (!pinned.isDirectory() || !sameObject(observed, pinned)
      || !sameObject(pinned, current)) {
      throw new Error('runtime_permission_production_root_identity_changed');
    }
    const runtimeStat = fs.fstatSync(root.descriptor, { bigint: true });
    const sameProductionObject = sameObject(runtimeStat, pinned);
    if (!exactProductionPath && sameProductionObject) {
      throw new Error('runtime_permission_production_root_alias_forbidden');
    }
    if (exactProductionPath && (!sameProductionObject || root.realPath !== root.resolved)) {
      throw new Error('runtime_permission_production_root_identity_changed');
    }
    return exactProductionPath;
  } catch (error) {
    if (exactProductionPath || productionPathObserved
      || error?.message === 'runtime_permission_production_root_alias_forbidden') {
      throw error;
    }
    return false;
  } finally {
    if (productionDescriptor !== undefined) fs.closeSync(productionDescriptor);
  }
}

function descriptorAccessPath(descriptor, { directory = false } = {}) {
  const expected = fs.fstatSync(descriptor, { bigint: true });
  for (const base of ['/proc/self/fd', '/dev/fd']) {
    const candidate = path.join(base, String(descriptor));
    let probe;
    try {
      probe = fs.openSync(
        directory ? path.join(candidate, '.') : candidate,
        fs.constants.O_RDONLY | (directory ? DIRECTORY_ONLY : 0),
      );
      if (sameObject(expected, fs.fstatSync(probe, { bigint: true }))) return candidate;
    } catch {
      // Descriptor namespace candidates are used only after identity proof.
    } finally {
      if (probe !== undefined) fs.closeSync(probe);
    }
  }
  throw new Error('descriptor_relative_runtime_permission_io_unsupported');
}

function descriptorEntryPath(descriptor, name) {
  if (!name || name === '.' || name === '..' || name.includes('/')
    || name.includes('\\') || name.includes('\0')) {
    throw new Error('runtime_permission_entry_name_invalid');
  }
  return path.join(descriptorAccessPath(descriptor, { directory: true }), name);
}

function openPinnedEntry(root, parentDescriptor, name, expectedType) {
  const candidate = descriptorEntryPath(parentDescriptor, name);
  const observed = fs.lstatSync(candidate, { bigint: true });
  if (observed.isSymbolicLink() || typeOf(observed) !== expectedType) {
    throw new Error('runtime_permission_protected_shared_layout_entry_invalid');
  }
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | NO_FOLLOW | (expectedType === 'directory' ? DIRECTORY_ONLY : 0),
  );
  try {
    const pinned = fs.fstatSync(descriptor, { bigint: true });
    const realPath = fs.realpathSync.native(descriptorAccessPath(
      descriptor, { directory: pinned.isDirectory() },
    ));
    if (!sameObject(observed, pinned) || !isPathWithin(root.realPath, realPath)) {
      throw new Error('runtime_permission_protected_shared_layout_identity_changed');
    }
    return Object.freeze({ descriptor, stat: pinned });
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function absentRuntimePermissionProtectedSharedLayout() {
  return Object.freeze({
    policy: RUNTIME_PERMISSION_PROTECTED_SHARED_LAYOUT_POLICY,
    status: 'absent',
    detected: false,
    commonGroupId: null,
    entries: Object.freeze([]),
  });
}

function layoutEntryEvidence(relativePath, stat) {
  return Object.freeze({
    relativePath,
    type: typeOf(stat),
    mode: octalMode(stat),
    groupId: String(stat.gid),
    ownerId: String(stat.uid),
    identity: identityOf(stat),
  });
}

export function inspectRuntimePermissionProtectedSharedLayout(root) {
  let research;
  let handoff;
  let database;
  let challenges;
  let cycles;
  try {
    const productionIdentityRequired = productionRuntimeRootIdentityRequired(root);
    try {
      research = openPinnedEntry(root, root.descriptor, 'autonomous-research', 'directory');
    } catch (error) {
      if (error?.code === 'ENOENT') return absentRuntimePermissionProtectedSharedLayout();
      throw error;
    }
    try {
      handoff = openPinnedEntry(root, research.descriptor, 'submission-handoff', 'directory');
    } catch (error) {
      if (error?.code === 'ENOENT') return absentRuntimePermissionProtectedSharedLayout();
      throw error;
    }
    database = openPinnedEntry(
      root, handoff.descriptor, 'submission-handoff.sqlite', 'regular_file',
    );
    challenges = openPinnedEntry(
      root, handoff.descriptor, 'dispatcher-challenges', 'directory',
    );
    cycles = openPinnedEntry(root, handoff.descriptor, 'dispatcher-cycles', 'directory');
    const entries = Object.freeze([
      Object.freeze({ relativePath: '.', stat: fs.fstatSync(root.descriptor, { bigint: true }) }),
      Object.freeze({ relativePath: 'autonomous-research', stat: research.stat }),
      Object.freeze({
        relativePath: 'autonomous-research/submission-handoff', stat: handoff.stat,
      }),
      Object.freeze({
        relativePath:
          'autonomous-research/submission-handoff/submission-handoff.sqlite',
        stat: database.stat,
      }),
      Object.freeze({
        relativePath:
          'autonomous-research/submission-handoff/dispatcher-challenges',
        stat: challenges.stat,
      }),
      Object.freeze({
        relativePath: 'autonomous-research/submission-handoff/dispatcher-cycles',
        stat: cycles.stat,
      }),
    ]);
    const expectedByPath = new Map(
      RUNTIME_PERMISSION_PROTECTED_SHARED_LAYOUT_POLICY.requiredEntries.map(
        (entry) => [entry.relativePath, entry],
      ),
    );
    const groupIds = new Set(entries.map(({ stat }) => String(stat.gid)));
    const byPath = new Map(entries.map((entry) => [entry.relativePath, entry.stat]));
    const supervisorOwnerId = String(byPath.get('.')?.uid);
    const productionRoleRelationshipValid = (
      groupIds.size === 1 && !groupIds.has('0')
      && supervisorOwnerId !== '0'
      && [
        'autonomous-research',
        'autonomous-research/submission-handoff/submission-handoff.sqlite',
        'autonomous-research/submission-handoff/dispatcher-challenges',
      ].every((relativePath) => String(byPath.get(relativePath)?.uid) === supervisorOwnerId)
      && String(byPath.get('autonomous-research/submission-handoff')?.uid) === '0'
      && !['0', supervisorOwnerId].includes(String(
        byPath.get('autonomous-research/submission-handoff/dispatcher-cycles')?.uid,
      ))
    );
    const productionAuthorityVerified = !productionIdentityRequired
      || verifyRuntimePermissionProductionSharedLayoutAuthority({
        runtimeRoot: root.resolved,
      });
    const productionIdentityValid = !productionIdentityRequired || (
      productionRoleRelationshipValid && productionAuthorityVerified
    );
    const mismatches = entries.flatMap(({ relativePath, stat }) => {
      const expected = expectedByPath.get(relativePath);
      return typeOf(stat) === expected.type && octalMode(stat) === expected.mode
        ? [] : [relativePath];
    });
    const evidence = Object.freeze(entries.map(
      ({ relativePath, stat }) => layoutEntryEvidence(relativePath, stat),
    ));
    if (groupIds.size !== 1 || mismatches.length !== 0 || !productionIdentityValid) {
      return Object.freeze({
        policy: RUNTIME_PERMISSION_PROTECTED_SHARED_LAYOUT_POLICY,
        status: 'invalid',
        detected: false,
        commonGroupId: groupIds.size === 1 ? [...groupIds][0] : null,
        mismatchedRelativePaths: Object.freeze(mismatches),
        identityQualification: productionIdentityRequired
          ? 'production_roles_invalid' : 'non_production_mode_and_group_only',
        productionLayoutAuthorityVerified: productionIdentityRequired
          ? productionAuthorityVerified : null,
        entries: evidence,
      });
    }
    return Object.freeze({
      policy: RUNTIME_PERMISSION_PROTECTED_SHARED_LAYOUT_POLICY,
      status: 'protected',
      detected: true,
      commonGroupId: [...groupIds][0],
      identityQualification: productionIdentityRequired
        ? 'production_roles_verified' : 'non_production_mode_and_group_only',
      productionLayoutAuthorityVerified: productionIdentityRequired
        ? true : null,
      entries: evidence,
    });
  } catch (error) {
    return Object.freeze({
      policy: RUNTIME_PERMISSION_PROTECTED_SHARED_LAYOUT_POLICY,
      status: 'invalid',
      detected: false,
      commonGroupId: null,
      failure: error?.message || 'runtime_permission_protected_shared_layout_inspection_failed',
      entries: Object.freeze([]),
    });
  } finally {
    for (const entry of [cycles, challenges, database, handoff, research]) {
      if (entry?.descriptor !== undefined) fs.closeSync(entry.descriptor);
    }
  }
}

function protectedPath(relativePath) {
  const policy = RUNTIME_PERMISSION_PROTECTED_SHARED_LAYOUT_POLICY;
  return policy.preserveExactRelativePaths.includes(relativePath)
    || policy.preservePrefixRelativePaths.some((prefix) => (
      relativePath === prefix || relativePath.startsWith(`${prefix}/`)
    ));
}

export function classifyRuntimePermissionProtectedSharedLayoutEntry(
  relativePath,
  stat,
  layout,
) {
  if (!layout.detected || !protectedPath(relativePath)) {
    return Object.freeze({ protected: false, valid: true });
  }
  const mode = modeNumber(stat);
  const expected = RUNTIME_PERMISSION_PROTECTED_SHARED_LAYOUT_POLICY.requiredEntries.find(
    (entry) => entry.relativePath === relativePath,
  );
  const commonGroup = String(stat.gid) === layout.commonGroupId;
  let valid;
  if (expected) {
    const inspected = layout.entries.find((entry) => entry.relativePath === relativePath);
    valid = commonGroup && typeOf(stat) === expected.type
      && octalMode(stat) === expected.mode
      && JSON.stringify(layoutEntryEvidence(relativePath, stat)) === JSON.stringify(inspected);
  } else if (stat.isFile()) {
    valid = commonGroup && (mode & ~0o660) === 0 && (mode & 0o400) === 0o400;
  } else if (stat.isDirectory()) {
    valid = commonGroup && (mode & ~0o2770) === 0 && (mode & 0o500) === 0o500;
  } else {
    valid = false;
  }
  return Object.freeze({
    protected: true,
    valid,
    reason: valid ? 'protected_shared_layout'
      : 'runtime_permission_protected_shared_layout_entry_mode_invalid',
    details: valid ? null : Object.freeze({
      type: typeOf(stat), mode: octalMode(stat), groupId: String(stat.gid),
    }),
  });
}
