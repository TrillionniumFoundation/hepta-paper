import fs from 'node:fs';
import path from 'node:path';

import {
  assertPinnedDirectoryCurrent,
  campaignReleasePackageTransactionError,
  descriptorEntryPath,
  durableIdentity,
  openPinnedScopedDirectory,
  pathEntryExistsNoFollow,
  sameDurableIdentity,
} from './campaign-release-package-transaction-repository.mjs';
import { fsyncDirectorySync } from '../runtime/durable-json-repository.mjs';

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const BUILDING_MARKER_TEMPORARY_NAME =
  /^\.\.CAMPAIGN_RELEASE_PACKAGE_BUILDING\.json\.tmp-[1-9][0-9]*-[0-9a-f]{24}$/;
const BUILDING_MARKER_NAME = '.CAMPAIGN_RELEASE_PACKAGE_BUILDING.json';
const INVALID = 'campaign_release_package_building_staging_invalid';

function invalid(details = {}) {
  return campaignReleasePackageTransactionError(INVALID, details);
}

function exactDirectoryEntryNames(descriptorRoot) {
  return fs.readdirSync(descriptorRoot, { encoding: 'buffer' })
    .sort((left, right) => Buffer.compare(left, right))
    .map((rawName) => {
      const name = rawName.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(rawName)
        || name === '.' || name === '..' || name.includes('/')
        || name.includes('\0')) throw invalid();
      return name;
    });
}

export function removeExactUnpublishedCampaignReleasePackageBuildingMarkerTemporarySync({
  runtimeRoot,
  parent,
  expectedBytes,
} = {}) {
  if (!Buffer.isBuffer(expectedBytes) || expectedBytes.length < 1) throw invalid();
  let openedParent;
  let descriptor;
  try {
    openedParent = openPinnedScopedDirectory(runtimeRoot, parent, INVALID);
    const descriptorRoot = `/proc/self/fd/${openedParent.descriptor}`;
    const names = exactDirectoryEntryNames(descriptorRoot);
    if (names.length !== 1
      || !BUILDING_MARKER_TEMPORARY_NAME.test(names[0])) return false;

    const candidate = descriptorEntryPath(openedParent.descriptor, names[0]);
    const parentIdentity = fs.fstatSync(openedParent.descriptor, { bigint: true });
    const before = fs.lstatSync(candidate, { bigint: true });
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const content = fs.readFileSync(descriptor);
    const selected = fs.lstatSync(candidate, { bigint: true });
    const owner = typeof process.geteuid === 'function' ? process.geteuid() : null;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || !opened.isFile() || opened.nlink !== 1n
      || opened.dev !== parentIdentity.dev
      || (opened.mode & 0o7777n) !== 0o444n
      || opened.size !== BigInt(expectedBytes.length)
      || (owner !== null && Number(opened.uid) !== owner)
      || !sameDurableIdentity(before, durableIdentity(opened))
      || !sameDurableIdentity(selected, durableIdentity(opened))
      || !content.equals(expectedBytes)) throw invalid();

    assertPinnedDirectoryCurrent(openedParent, INVALID);
    fs.unlinkSync(candidate);
    fs.fsyncSync(openedParent.descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    if (completed.nlink !== 0n
      || pathEntryExistsNoFollow(candidate)
      || exactDirectoryEntryNames(descriptorRoot).length !== 0) throw invalid();
    assertPinnedDirectoryCurrent(openedParent, INVALID);
    return true;
  } catch (error) {
    if (error?.code === INVALID) throw error;
    throw invalid({ cause: error });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (openedParent?.descriptor !== undefined) {
      fs.closeSync(openedParent.descriptor);
    }
  }
}

function exactMarker(openedParent, expectedBytes) {
  let descriptor;
  try {
    const candidate = descriptorEntryPath(
      openedParent.descriptor,
      BUILDING_MARKER_NAME,
    );
    const parent = fs.fstatSync(openedParent.descriptor, { bigint: true });
    const before = fs.lstatSync(candidate, { bigint: true });
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const content = fs.readFileSync(descriptor);
    const selected = fs.lstatSync(candidate, { bigint: true });
    const owner = typeof process.geteuid === 'function' ? process.geteuid() : null;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || !opened.isFile() || opened.nlink !== 1n || opened.dev !== parent.dev
      || (opened.mode & 0o7777n) !== 0o444n
      || opened.size !== BigInt(expectedBytes.length)
      || (owner !== null && Number(opened.uid) !== owner)
      || !sameDurableIdentity(before, durableIdentity(opened))
      || !sameDurableIdentity(selected, durableIdentity(opened))
      || !content.equals(expectedBytes)) throw invalid();
    return { descriptor, identity: durableIdentity(opened) };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code === INVALID) throw error;
    throw invalid({ cause: error });
  }
}

export function removeExactCampaignReleasePackageAbortedStagingSync({
  runtimeRoot,
  parent,
  expectedMarkerBytes,
} = {}) {
  if (!Buffer.isBuffer(expectedMarkerBytes) || expectedMarkerBytes.length < 1) {
    throw invalid();
  }
  let openedParent;
  let marker;
  try {
    openedParent = openPinnedScopedDirectory(runtimeRoot, parent, INVALID);
    const descriptorRoot = `/proc/self/fd/${openedParent.descriptor}`;
    let names = exactDirectoryEntryNames(descriptorRoot);
    if (names.length > 0) {
      if (!names.includes(BUILDING_MARKER_NAME)) throw invalid();
      marker = exactMarker(openedParent, expectedMarkerBytes);
      for (const name of names.filter((entry) => entry !== BUILDING_MARKER_NAME)) {
        fs.rmSync(descriptorEntryPath(openedParent.descriptor, name), {
          recursive: true,
          force: false,
        });
        fs.fsyncSync(openedParent.descriptor);
      }
      const current = exactMarker(openedParent, expectedMarkerBytes);
      fs.closeSync(current.descriptor);
      assertPinnedDirectoryCurrent(openedParent, INVALID);
      fs.unlinkSync(descriptorEntryPath(
        openedParent.descriptor,
        BUILDING_MARKER_NAME,
      ));
      fs.fsyncSync(openedParent.descriptor);
      const removed = fs.fstatSync(marker.descriptor, { bigint: true });
      if (!sameDurableIdentity(removed, marker.identity)
        || removed.nlink !== 0n) throw invalid();
      names = exactDirectoryEntryNames(descriptorRoot);
    }
    if (names.length !== 0) throw invalid();
    assertPinnedDirectoryCurrent(openedParent, INVALID);
  } catch (error) {
    if (error?.code === INVALID) throw error;
    throw invalid({ cause: error });
  } finally {
    if (marker?.descriptor !== undefined) fs.closeSync(marker.descriptor);
    if (openedParent?.descriptor !== undefined) {
      fs.closeSync(openedParent.descriptor);
    }
  }
  fs.rmdirSync(parent);
  fsyncDirectorySync(path.dirname(parent));
}
