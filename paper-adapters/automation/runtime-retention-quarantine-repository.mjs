import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  openPinnedRetentionCategory,
  pinnedRetentionMemberPath,
  retentionMemberHash,
  retentionMemberIdentity,
  retentionPathExists,
} from './runtime-retention-scope-repository.mjs';

const QUARANTINE_NAME = /^\.hepta-retention-[a-f0-9]{40}\.quarantine$/;
const STABLE_IDENTITY_FIELDS = Object.freeze([
  'dev', 'ino', 'mode', 'size', 'mtimeNs', 'nlink', 'entryKind',
]);

function quarantineName(operationId, memberPath, index) {
  const digest = hashRecord('RuntimeRetentionQuarantineMember', {
    operationId,
    memberPath: path.resolve(memberPath),
    index,
  }).slice(7, 47);
  return `.hepta-retention-${digest}.quarantine`;
}

function sameStableIdentity(left, right) {
  return Boolean(left && right && STABLE_IDENTITY_FIELDS.every((field) =>
    String(left[field]) === String(right[field])));
}

function inspectStableMember(candidate) {
  if (!retentionPathExists(candidate)) {
    return Object.freeze({ exists: false, contentHash: null, identity: null });
  }
  const before = retentionMemberIdentity(candidate);
  const firstHash = retentionMemberHash(candidate);
  const secondHash = retentionMemberHash(candidate);
  const after = retentionMemberIdentity(candidate);
  if (!sameStableIdentity(before, after)
    || before.realPath !== after.realPath
    || firstHash !== secondHash) {
    throw new Error('runtime_retention_member_changed_during_inspection');
  }
  return Object.freeze({ exists: true, contentHash: firstHash, identity: before });
}

function assertExpectedMember(observed, member, expectedRealPath) {
  if (!observed.exists
    || observed.contentHash !== member.contentHash
    || !sameStableIdentity(observed.identity, member.identity)
    || path.resolve(observed.identity.realPath) !== path.resolve(expectedRealPath)) {
    throw new Error('runtime_retention_member_preimage_changed');
  }
}

function assertLiveCategoryScope(intent, entry) {
  const live = openPinnedRetentionCategory(
    intent.runtimeRoot,
    entry.category,
    entry.categoryScope,
  );
  live.close();
}

function memberPaths(pinned, runtimeRoot, category, member) {
  if (!QUARANTINE_NAME.test(String(member.quarantineName || ''))) {
    throw new Error('runtime_retention_quarantine_name_invalid');
  }
  return Object.freeze({
    source: pinnedRetentionMemberPath(
      pinned,
      runtimeRoot,
      category,
      member.path,
    ),
    quarantine: path.join(pinned.categoryDescriptorPath, member.quarantineName),
    sourceRealPath: path.resolve(member.identity?.realPath || ''),
    quarantineRealPath: path.join(
      path.resolve(pinned.scope.categoryRoot.realPath),
      member.quarantineName,
    ),
  });
}

function revalidateQuarantinedAuthority({
  intent,
  entry,
  entryIndex,
  pinned,
  revalidateAuthority,
}) {
  if (typeof revalidateAuthority !== 'function') return;
  const restored = [];
  for (let memberIndex = 0; memberIndex < entry.members.length; memberIndex += 1) {
    const member = entry.members[memberIndex];
    const locations = memberPaths(pinned, intent.runtimeRoot, entry.category, member);
    const source = inspectStableMember(locations.source);
    const quarantined = inspectStableMember(locations.quarantine);
    if (source.exists && quarantined.exists) {
      throw new Error('runtime_retention_quarantine_source_collision');
    }
    if (!quarantined.exists) continue;
    assertExpectedMember(quarantined, member, locations.quarantineRealPath);
    fs.renameSync(locations.quarantine, locations.source);
    fs.fsyncSync(pinned.categoryDescriptor);
    assertExpectedMember(inspectStableMember(locations.source), member, locations.sourceRealPath);
    restored.push({ member, memberIndex, locations });
  }
  revalidateAuthority({ intent, entry, entryIndex });
  for (const { member, locations } of restored) {
    if (inspectStableMember(locations.quarantine).exists) {
      throw new Error('runtime_retention_quarantine_source_collision');
    }
    assertExpectedMember(inspectStableMember(locations.source), member, locations.sourceRealPath);
    fs.renameSync(locations.source, locations.quarantine);
    fs.fsyncSync(pinned.categoryDescriptor);
    assertExpectedMember(
      inspectStableMember(locations.quarantine),
      member,
      locations.quarantineRealPath,
    );
  }
}

export function bindRetentionQuarantineMembers(entries, operationId) {
  return entries.map((entry, entryIndex) => ({
    ...entry,
    members: entry.members.map((member, memberIndex) => ({
      ...member,
      quarantineName: quarantineName(
        operationId,
        member.path,
        entryIndex * 1000 + memberIndex,
      ),
    })),
  }));
}

export function verifyRetentionQuarantineMemberBinding(
  operationId,
  member,
  entryIndex,
  memberIndex,
) {
  const expectedName = quarantineName(
    operationId,
    member?.path,
    entryIndex * 1000 + memberIndex,
  );
  return Boolean(member?.identity
    && STABLE_IDENTITY_FIELDS.every((field) =>
      typeof member.identity[field] === 'string' && member.identity[field].length > 0)
    && typeof member.identity.realPath === 'string'
    && path.isAbsolute(member.identity.realPath)
    && member.quarantineName === expectedName);
}

export function restoreRetentionQuarantines(intent, { faultInjector = null } = {}) {
  for (let entryIndex = 0; entryIndex < intent.entries.length; entryIndex += 1) {
    const entry = intent.entries[entryIndex];
    if (!entry.authorized) continue;
    const pinned = openPinnedRetentionCategory(
      intent.runtimeRoot,
      entry.category,
      entry.categoryScope,
    );
    try {
      for (let memberIndex = 0; memberIndex < entry.members.length; memberIndex += 1) {
        const member = entry.members[memberIndex];
        const locations = memberPaths(pinned, intent.runtimeRoot, entry.category, member);
        const source = inspectStableMember(locations.source);
        const quarantined = inspectStableMember(locations.quarantine);
        if (source.exists && quarantined.exists) {
          throw new Error('runtime_retention_quarantine_source_collision');
        }
        if (quarantined.exists) {
          assertExpectedMember(quarantined, member, locations.quarantineRealPath);
          if (source.exists) throw new Error('runtime_retention_quarantine_source_collision');
          faultInjector?.({
            stage: 'before_member_quarantine_restore', intent, entry, entryIndex,
            member, memberIndex,
          });
          fs.renameSync(locations.quarantine, locations.source);
          fs.fsyncSync(pinned.categoryDescriptor);
          assertExpectedMember(
            inspectStableMember(locations.source),
            member,
            locations.sourceRealPath,
          );
          if (retentionPathExists(locations.quarantine)) {
            throw new Error('runtime_retention_quarantine_restore_postimage_invalid');
          }
          faultInjector?.({
            stage: 'after_member_quarantine_restored', intent, entry, entryIndex,
            member, memberIndex,
          });
        } else if (source.exists) {
          assertExpectedMember(source, member, locations.sourceRealPath);
        }
      }
    } finally {
      pinned.close();
    }
  }
}

export function removeRetentionEntryThroughQuarantine(
  intent,
  entry,
  entryIndex,
  pinned,
  { faultInjector = null, revalidateAuthority = null } = {},
) {
  const quarantinedMembers = [];
  let alreadyAbsent = true;
  for (let memberIndex = 0; memberIndex < entry.members.length; memberIndex += 1) {
    const member = entry.members[memberIndex];
    const locations = memberPaths(pinned, intent.runtimeRoot, entry.category, member);
    let source = inspectStableMember(locations.source);
    let quarantined = inspectStableMember(locations.quarantine);
    if (source.exists && quarantined.exists) {
      throw new Error('runtime_retention_quarantine_source_collision');
    }
    if (!source.exists && !quarantined.exists) continue;
    alreadyAbsent = false;
    if (source.exists) {
      assertExpectedMember(source, member, locations.sourceRealPath);
      faultInjector?.({
        stage: 'before_member_quarantined', intent, entry, entryIndex,
        member, memberIndex,
      });
      revalidateQuarantinedAuthority({
        intent, entry, entryIndex, pinned, revalidateAuthority,
      });
      assertLiveCategoryScope(intent, entry);
      fs.renameSync(locations.source, locations.quarantine);
      fs.fsyncSync(pinned.categoryDescriptor);
      quarantined = inspectStableMember(locations.quarantine);
      assertExpectedMember(quarantined, member, locations.quarantineRealPath);
      source = inspectStableMember(locations.source);
      if (source.exists) throw new Error('runtime_retention_quarantine_source_advanced');
      faultInjector?.({
        stage: 'after_member_quarantined', intent, entry, entryIndex,
        member, memberIndex,
      });
    } else {
      assertExpectedMember(quarantined, member, locations.quarantineRealPath);
    }
    quarantinedMembers.push({ member, memberIndex, locations });
  }
  faultInjector?.({ stage: 'after_entry_quarantined', intent, entry, entryIndex });
  if (quarantinedMembers.length) {
    revalidateQuarantinedAuthority({
      intent, entry, entryIndex, pinned, revalidateAuthority,
    });
  }
  for (const { member, memberIndex } of quarantinedMembers) {
    faultInjector?.({
      stage: 'before_quarantined_member_removed', intent, entry, entryIndex,
      member, memberIndex,
    });
    revalidateQuarantinedAuthority({
      intent, entry, entryIndex, pinned, revalidateAuthority,
    });
  }
  for (const { member, memberIndex, locations } of quarantinedMembers) {
    if (inspectStableMember(locations.source).exists) {
      throw new Error('runtime_retention_quarantine_source_advanced');
    }
    assertExpectedMember(
      inspectStableMember(locations.quarantine),
      member,
      locations.quarantineRealPath,
    );
    assertLiveCategoryScope(intent, entry);
    if (inspectStableMember(locations.source).exists) {
      throw new Error('runtime_retention_quarantine_source_advanced');
    }
    assertExpectedMember(
      inspectStableMember(locations.quarantine),
      member,
      locations.quarantineRealPath,
    );
    fs.rmSync(locations.quarantine, { recursive: true, force: false });
    fs.fsyncSync(pinned.categoryDescriptor);
    if (retentionPathExists(locations.quarantine)) {
      throw new Error('runtime_retention_quarantine_removal_postimage_invalid');
    }
    faultInjector?.({
      stage: 'after_member_removed', intent, entry, entryIndex,
      member, memberIndex,
    });
  }
  return Object.freeze({ alreadyAbsent });
}
