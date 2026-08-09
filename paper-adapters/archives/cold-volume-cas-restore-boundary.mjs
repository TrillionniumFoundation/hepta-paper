import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  assertPinnedCasFileCurrent,
  duplicatePinnedCasFileForRead,
} from './cold-volume-cas-path-boundary.mjs';

function unique(values) { return [...new Set(values)]; }

export function inspectPinnedCasArchiveListing(pinned, relative) {
  let listed;
  try {
    listed = duplicatePinnedCasFileForRead(
      pinned,
      'cold_volume_cas_archive_descriptor_invalid',
    );
    const listing = spawnSync('tar', [
      '--list', '--verbose', '--gzip', '--file=/proc/self/fd/3',
      '--numeric-owner', '--quoting-style=escape',
    ], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe', listed.descriptor],
    });
    assertPinnedCasFileCurrent(listed, 'cold_volume_cas_object_changed_during_listing');
    assertPinnedCasFileCurrent(pinned, 'cold_volume_cas_object_changed_during_listing');
    const rows = String(listing.stdout || '').split(/\r?\n/u).filter(Boolean);
    if (listing.status !== 0 || !rows.length) {
      return [`cold_volume_cas_restore_archive_listing_failed:${relative}`];
    }
    if (rows.some((row) => row[0] !== '-' && row[0] !== 'd')) {
      return [`cold_volume_cas_restore_archive_entry_type_unsafe:${relative}`];
    }
    return [];
  } catch {
    return [`cold_volume_cas_restore_archive_listing_failed:${relative}`];
  } finally {
    if (listed?.descriptor !== undefined) fs.closeSync(listed.descriptor);
  }
}

export function inspectRestoredCasEntryInventory(root, relative) {
  const blockers = [];
  const rows = [];
  let payloadCount = 0;
  function visit(current, relativeRoot = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      const stat = fs.lstatSync(absolute, { bigint: true });
      const regularFile = stat.isFile() && !stat.isSymbolicLink();
      const directory = stat.isDirectory() && !stat.isSymbolicLink();
      rows.push(relativePath);
      if (!regularFile && !directory) blockers.push('cold_volume_cas_restore_inventory_type_unsafe');
      if (regularFile && stat.nlink !== 1n) blockers.push('cold_volume_cas_restore_inventory_hardlink_unsafe');
      if (relativePath.startsWith(`${relative}/`) && (regularFile || directory)) payloadCount += 1;
      if (directory) visit(absolute, relativePath);
    }
  }
  try { visit(root); } catch { blockers.push('cold_volume_cas_restore_inventory_unreadable'); }
  let declaredRoot;
  try { declaredRoot = fs.lstatSync(path.join(root, ...relative.split('/')), { bigint: true }); }
  catch { declaredRoot = null; }
  if (!declaredRoot?.isDirectory() || declaredRoot.isSymbolicLink()) {
    blockers.push('cold_volume_cas_restore_declared_root_not_directory');
  }
  if (!rows.every((row) => row === relative
    || row.startsWith(`${relative}/`)
    || relative.startsWith(`${row}/`))) {
    blockers.push('cold_volume_cas_restore_inventory_mismatch');
  }
  if (payloadCount === 0) blockers.push('cold_volume_cas_restore_payload_empty');
  return unique(blockers).map((blocker) => `${blocker}:${relative}`);
}
