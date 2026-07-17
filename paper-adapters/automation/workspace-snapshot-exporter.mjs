import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectLiveWorkspaceManifest,
  workspaceExternalContentHash,
  workspaceRestoredManifestHash,
} from './workspace-retention-evidence.mjs';
import {
  WORKSPACE_SNAPSHOT_RESOURCE_LIMITS,
  archiveStagedWorkspace,
  assertPublicDirectoryBinding,
  copyExternalContentToStage,
  createControlledDirectory,
  descriptorPath,
  extractArchive,
  fileHash,
  fsyncStagedTree,
  hashDescriptor,
  identityRecord,
  openOrCreateDirectory,
  openPinnedRegularFile,
  readPinnedJson,
  removeControlledDirectory,
  safeControlName,
  sameIdentity,
  stagePinnedWorkspace,
  validateArchiveMembers,
  validateEntryResourceBounds,
  validateExternalBinding,
  writeDurableFile,
} from './workspace-snapshot-staging-repository.mjs';
import {
  publicationIntentName,
  publishStage,
  readPublicationIntent,
  recoverPublication,
} from './workspace-snapshot-publication-repository.mjs';

export { WORKSPACE_SNAPSHOT_RESOURCE_LIMITS };

function manifestFor(root) {
  return inspectLiveWorkspaceManifest({ workspacePath: root });
}

function buildRestoreReceipt({ receipt, workspaceId, verifiedAt, restored, blockers }) {
  const payload = {
    version: 1,
    kind: 'WorkspaceSnapshotRestoreReceipt',
    status: blockers.length ? 'workspace_snapshot_restore_blocked' : 'workspace_snapshot_restore_verified',
    workspaceId: workspaceId || receipt.workspaceId || null,
    manifestHash: receipt.manifestHash,
    archivePath: receipt.archivePath,
    archiveHash: receipt.archiveHash,
    exportReceiptHash: receipt.exportReceiptHash,
    externalContentHash: receipt.externalContentHash,
    restoredManifestHash: workspaceRestoredManifestHash(restored),
    restoredEntryCount: restored.length,
    verifiedAt: verifiedAt || new Date().toISOString(),
    blockers,
  };
  return Object.freeze({ ...payload, restoreReceiptHash: hashRecord('WorkspaceSnapshotRestoreReceipt', payload) });
}

function qualifyRestore({ restoreReceipt, blockers, registry, restoreReceiptLedger, workspaceId, receipt }) {
  const ledgerReceipt = !blockers.length && restoreReceiptLedger?.record
    ? restoreReceiptLedger.record(restoreReceipt, {
      stream: 'workspace-snapshot-restore',
      paperId: null,
      environment: 'administrative',
      evidenceClass: 'workspace_snapshot_restore',
    })
    : null;
  if (ledgerReceipt && (ledgerReceipt.writerTrusted !== true || ledgerReceipt.issuerPolicyId !== 'workspace-snapshot-verifier')) {
    throw new Error('workspace snapshot retention qualification requires trusted restore ledger');
  }
  if (!blockers.length && registry) {
    const effectiveWorkspaceId = workspaceId || receipt.workspaceId;
    if (!effectiveWorkspaceId) throw new Error('workspace snapshot retention qualification requires workspaceId');
    if (!ledgerReceipt) throw new Error('workspace snapshot retention qualification requires trusted restore ledger');
    registry.qualifyForRetention(effectiveWorkspaceId, {
      manifestHash: receipt.manifestHash,
      archiveHash: receipt.archiveHash,
      restoreReceipt,
      restoreLedgerReceiptId: ledgerReceipt.receiptId,
    });
  }
}

export function exportWorkspaceSnapshot({
  registry,
  workspaceId,
  workspacePath,
  exportRoot,
  externalContentBindings = {},
  stageFaultInjector = null,
} = {}) {
  if (!registry || !workspaceId || !workspacePath || !exportRoot) throw new Error('registry, workspaceId, workspacePath and exportRoot are required');
  const source = path.resolve(workspacePath);
  const destination = path.resolve(exportRoot);
  const destinationDescriptor = openOrCreateDirectory(destination);
  let stage = null;
  try {
    assertPublicDirectoryBinding(destination, destinationDescriptor, 'workspace_snapshot_export_parent_identity_changed');
    stage = createControlledDirectory(destinationDescriptor, '.workspace-snapshot-stage-');
    const stagedEntries = stagePinnedWorkspace({ source, stagePath: stage.candidate, externalContentBindings });
    stageFaultInjector?.('after_source_staged');
    const entries = stagedEntries.map((entry) => {
      const externalPath = Object.hasOwn(externalContentBindings, entry.path)
        ? path.resolve(externalContentBindings[entry.path])
        : null;
      if (!externalPath) return entry;
      validateExternalBinding(entry, externalPath);
      return { ...entry, externalContent: { path: externalPath, hash: entry.hash, bytes: entry.bytes } };
    });
    validateEntryResourceBounds(entries, 'workspace_snapshot_source');
    const manifestPayload = { version: 1, kind: 'WorkspaceExportManifest', workspaceId, entries };
    const manifestHash = hashRecord('WorkspaceExportManifest', manifestPayload);
    const externalContentHash = workspaceExternalContentHash(entries);
    const stem = manifestHash.replace(/^sha256:/, '');
    const archiveName = `${stem}.tar.gz`;
    const manifestName = `${stem}.manifest.json`;
    const archivePath = path.join(destination, archiveName);
    const manifestPath = path.join(destination, manifestName);
    archiveStagedWorkspace({ destinationDescriptor, stageDescriptor: stage.descriptor, archiveName });
    assertPublicDirectoryBinding(destination, destinationDescriptor, 'workspace_snapshot_export_parent_identity_changed');
    const archiveHash = fileHash(path.join(descriptorPath(destinationDescriptor), archiveName));
    const bytes = Number(fs.lstatSync(path.join(descriptorPath(destinationDescriptor), archiveName), { bigint: true }).size);
    if (bytes > WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxArchiveBytes) throw new Error('workspace_snapshot_archive_bytes_exceeded');
    const receiptPayload = {
      ...manifestPayload,
      manifestHash,
      archivePath,
      archiveHash,
      externalContentHash,
      bytes,
      status: 'workspace_snapshot_exported',
      externalActionPerformed: false,
    };
    const exportReceiptHash = hashRecord('WorkspaceSnapshotExportReceipt', receiptPayload);
    const result = Object.freeze({ ...receiptPayload, manifestPath, exportReceiptHash });
    writeDurableFile(destinationDescriptor, manifestName, `${JSON.stringify(result, null, 2)}\n`);
    assertPublicDirectoryBinding(destination, destinationDescriptor, 'workspace_snapshot_export_parent_identity_changed');
    registry.recordSnapshot(workspaceId, {
      manifestHash,
      manifestPath,
      archivePath,
      archiveHash,
      externalContentHash,
      bytes,
      status: 'exported_unverified',
      exportReceiptHash,
    });
    registry.transition(workspaceId, {
      status: 'exported',
      retentionState: 'protected',
      retentionReason: 'exported_unverified',
      exportReceiptHash,
    });
    return result;
  } finally {
    if (stage) {
      fs.closeSync(stage.descriptor);
      try { removeControlledDirectory(destinationDescriptor, stage.name, stage.identity); } catch { /* fail closed artifacts remain diagnosable */ }
    }
    fs.closeSync(destinationDescriptor);
  }
}

export function restoreWorkspaceSnapshot({
  receipt,
  restoreRoot,
  registry = null,
  restoreReceiptLedger = null,
  workspaceId = null,
  verifiedAt = null,
  publishFaultInjector = null,
} = {}) {
  if (!receipt?.archivePath || !receipt?.archiveHash || !Array.isArray(receipt?.entries) || !restoreRoot) {
    throw new Error('workspace snapshot receipt is incomplete');
  }
  validateEntryResourceBounds(receipt.entries);
  const { exportReceiptHash = null, manifestPath = null, ...exportPayload } = receipt;
  if (!exportReceiptHash || hashRecord('WorkspaceSnapshotExportReceipt', exportPayload) !== exportReceiptHash) throw new Error('workspace snapshot export receipt hash mismatch');
  if (workspaceExternalContentHash(receipt.entries) !== receipt.externalContentHash) throw new Error('workspace snapshot external content binding hash mismatch');
  if (!manifestPath) throw new Error('workspace snapshot manifest receipt missing');
  const persistedExport = readPinnedJson(manifestPath, 'workspace snapshot manifest receipt missing');
  if (JSON.stringify(persistedExport) !== JSON.stringify(receipt)) throw new Error('workspace snapshot manifest receipt mismatch');

  const archive = openPinnedRegularFile(receipt.archivePath, 'workspace snapshot archive missing or unsafe');
  let parentDescriptor = null;
  let stage = null;
  try {
    if (archive.opened.size > BigInt(WORKSPACE_SNAPSHOT_RESOURCE_LIMITS.maxArchiveBytes)) throw new Error('workspace_snapshot_archive_bytes_exceeded');
    if (hashDescriptor(archive.descriptor) !== receipt.archiveHash) throw new Error('workspace snapshot archive hash mismatch');
    try {
      validateArchiveMembers(archive.descriptor, receipt.entries);
    } catch (error) {
      if (error?.message !== 'workspace_snapshot_archive_file_manifest_mismatch') throw error;
      return buildRestoreReceipt({
        receipt,
        workspaceId,
        verifiedAt,
        restored: [],
        blockers: ['workspace_snapshot_archive_file_manifest_mismatch'],
      });
    }
    if (!sameIdentity(archive.opened, fs.fstatSync(archive.descriptor, { bigint: true }))) throw new Error('workspace snapshot archive changed while reading');

    const destination = path.resolve(restoreRoot);
    const parentPath = path.dirname(destination);
    const destinationName = path.basename(destination);
    if (!safeControlName(destinationName) || destination === parentPath) throw new Error('workspace_snapshot_restore_destination_unsafe');
    parentDescriptor = openOrCreateDirectory(parentPath);
    assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
    const operationHash = hashRecord('WorkspaceSnapshotRestorePublication', {
      version: 1,
      destination,
      workspaceId: workspaceId || receipt.workspaceId || null,
      manifestHash: receipt.manifestHash,
      archiveHash: receipt.archiveHash,
      exportReceiptHash: receipt.exportReceiptHash,
      externalContentHash: receipt.externalContentHash,
    });
    const recovered = recoverPublication({ parentDescriptor, parentPath, destinationName, operationHash });
    if (recovered) {
      const restored = manifestFor(path.join(descriptorPath(parentDescriptor), destinationName));
      const expected = JSON.stringify(receipt.entries.map(({ externalContent: _externalContent, ...entry }) => entry));
      if (JSON.stringify(restored) !== expected) throw new Error('workspace_snapshot_recovered_publication_manifest_mismatch');
      const restoreReceipt = buildRestoreReceipt({ receipt, workspaceId, verifiedAt, restored, blockers: [] });
      qualifyRestore({ restoreReceipt, blockers: [], registry, restoreReceiptLedger, workspaceId, receipt });
      return restoreReceipt;
    }

    stage = createControlledDirectory(parentDescriptor, `.workspace-snapshot-restore-${destinationName}-`);
    extractArchive(archive.descriptor, stage.descriptor);
    fs.fchmodSync(stage.descriptor, 0o700);
    fs.fsyncSync(stage.descriptor);
    stage.identity = identityRecord(fs.fstatSync(stage.descriptor, { bigint: true }));
    if (!sameIdentity(archive.opened, fs.fstatSync(archive.descriptor, { bigint: true }))) throw new Error('workspace snapshot archive changed while restoring');
    const expectedWithoutExternal = receipt.entries
      .filter((entry) => !entry.externalContent)
      .map(({ externalContent: _externalContent, ...entry }) => entry);
    let restored = manifestFor(stage.candidate);
    let blockers = JSON.stringify(restored) === JSON.stringify(expectedWithoutExternal)
      ? []
      : ['workspace_snapshot_restore_manifest_mismatch'];
    if (!blockers.length) {
      for (const entry of receipt.entries.filter((item) => item.externalContent)) copyExternalContentToStage(entry, stage.candidate);
      restored = manifestFor(stage.candidate);
      const expected = receipt.entries.map(({ externalContent: _externalContent, ...entry }) => entry);
      blockers = JSON.stringify(restored) === JSON.stringify(expected) ? [] : ['workspace_snapshot_restore_manifest_mismatch'];
    }
    if (blockers.length) return buildRestoreReceipt({ receipt, workspaceId, verifiedAt, restored, blockers });

    fsyncStagedTree(stage.descriptor);
    assertPublicDirectoryBinding(parentPath, parentDescriptor, 'workspace_snapshot_restore_parent_identity_changed');
    publishStage({
      parentDescriptor,
      parentPath,
      destinationName,
      stage,
      operationHash,
      faultInjector: publishFaultInjector,
    });
    const published = manifestFor(path.join(descriptorPath(parentDescriptor), destinationName));
    const expected = receipt.entries.map(({ externalContent: _externalContent, ...entry }) => entry);
    if (JSON.stringify(published) !== JSON.stringify(expected)) throw new Error('workspace_snapshot_published_manifest_mismatch');
    const restoreReceipt = buildRestoreReceipt({ receipt, workspaceId, verifiedAt, restored: published, blockers: [] });
    qualifyRestore({ restoreReceipt, blockers: [], registry, restoreReceiptLedger, workspaceId, receipt });
    return restoreReceipt;
  } finally {
    if (stage) {
      fs.closeSync(stage.descriptor);
      if (parentDescriptor) {
        try {
          const intent = readPublicationIntent(parentDescriptor, publicationIntentName(path.basename(path.resolve(restoreRoot))));
          if (!intent) removeControlledDirectory(parentDescriptor, stage.name, stage.identity);
        } catch { /* an active durable intent owns staging */ }
      }
    }
    if (parentDescriptor !== null) fs.closeSync(parentDescriptor);
    fs.closeSync(archive.descriptor);
  }
}
