import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { receiptIssuerPolicies } from '../persistence/receipt-issuer-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  descriptorAccessPathSync,
  descriptorSha256HashSync,
  fileSha256HashSync,
  readRegularJsonFileSync,
  samePinnedFileIdentity,
} from '../runtime/pinned-file-reader.mjs';

const VERIFIER_POLICY = receiptIssuerPolicies()['workspace-snapshot-verifier'];
const WORKSPACE_INTERNAL_EXCLUDED_NAMES = new Set(['.hepta-materialization-recovery']);

const within = pathWithin;
const sameIdentity = samePinnedFileIdentity;
const descriptorHash = descriptorSha256HashSync;

function descriptorPath(descriptor) {
  return descriptorAccessPathSync(descriptor, { errorCode: 'workspace_descriptor_root_unavailable' });
}

/**
 * Reads the live workspace through pinned, no-follow descriptors. The returned
 * file rows intentionally match the v1 export manifest (directories are not
 * materialized as rows) so existing persisted receipts remain verifiable.
 */
export function inspectLiveWorkspaceManifest({ workspacePath } = {}) {
  const root = path.resolve(workspacePath || '');
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const directoryOnly = fs.constants.O_DIRECTORY || 0;
  let rootDescriptor = null;
  try {
    const before = fs.lstatSync(root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('workspace_root_not_regular_directory');
    rootDescriptor = fs.openSync(root, fs.constants.O_RDONLY | directoryOnly | noFollow);
    const opened = fs.fstatSync(rootDescriptor, { bigint: true });
    if (!opened.isDirectory() || !sameIdentity(before, opened)) throw new Error('workspace_root_identity_changed');
    const rootDescriptorPath = descriptorPath(rootDescriptor);
    const rootRealPath = fs.realpathSync.native(rootDescriptorPath);
    if (fs.realpathSync.native(root) !== rootRealPath) throw new Error('workspace_root_realpath_changed');

    const entries = [];
    const walk = (directoryDescriptor, relativeDirectory = '') => {
      const directoryFdPath = descriptorPath(directoryDescriptor);
      const directoryBefore = fs.fstatSync(directoryDescriptor, { bigint: true });
      const directoryRealPath = fs.realpathSync.native(directoryFdPath);
      if (!directoryBefore.isDirectory() || !within(rootRealPath, directoryRealPath)) throw new Error('workspace_directory_outside_root');
      for (const name of fs.readdirSync(directoryFdPath).sort()) {
        if (WORKSPACE_INTERNAL_EXCLUDED_NAMES.has(name)) continue;
        const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        const candidate = path.join(directoryFdPath, name);
        const observed = fs.lstatSync(candidate, { bigint: true });
        if (observed.isSymbolicLink()) throw new Error(`workspace_symlink_forbidden:${relative}`);
        if (observed.isDirectory()) {
          const childDescriptor = fs.openSync(candidate, fs.constants.O_RDONLY | directoryOnly | noFollow);
          try {
            const childOpened = fs.fstatSync(childDescriptor, { bigint: true });
            if (!sameIdentity(observed, childOpened)) throw new Error(`workspace_directory_identity_changed:${relative}`);
            walk(childDescriptor, relative);
            if (!sameIdentity(childOpened, fs.fstatSync(childDescriptor, { bigint: true }))) throw new Error(`workspace_directory_changed_while_reading:${relative}`);
          } finally { fs.closeSync(childDescriptor); }
          continue;
        }
        if (!observed.isFile()) throw new Error(`workspace_special_file_forbidden:${relative}`);
        const fileDescriptor = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
        try {
          const openedFile = fs.fstatSync(fileDescriptor, { bigint: true });
          const fileRealPath = fs.realpathSync.native(descriptorPath(fileDescriptor));
          if (!openedFile.isFile() || !sameIdentity(observed, openedFile) || !within(rootRealPath, fileRealPath)) {
            throw new Error(`workspace_file_identity_changed:${relative}`);
          }
          const hash = descriptorHash(fileDescriptor);
          const afterFile = fs.fstatSync(fileDescriptor, { bigint: true });
          if (!sameIdentity(openedFile, afterFile)) throw new Error(`workspace_file_changed_while_reading:${relative}`);
          entries.push({ path: relative.replace(/\\/g, '/'), hash, bytes: Number(afterFile.size) });
        } finally { fs.closeSync(fileDescriptor); }
      }
      if (!sameIdentity(directoryBefore, fs.fstatSync(directoryDescriptor, { bigint: true }))) throw new Error(`workspace_directory_changed_while_reading:${relativeDirectory || '.'}`);
    };
    walk(rootDescriptor);
    const finalPath = fs.lstatSync(root, { bigint: true });
    const finalDescriptor = fs.fstatSync(rootDescriptor, { bigint: true });
    if (!sameIdentity(opened, finalDescriptor) || !sameIdentity(finalDescriptor, finalPath)) throw new Error('workspace_root_changed_while_reading');
    return Object.freeze(entries.sort((left, right) => left.path.localeCompare(right.path)).map(Object.freeze));
  } finally {
    if (rootDescriptor !== null) fs.closeSync(rootDescriptor);
  }
}

function safeRelative(value) {
  return Boolean(value
    && !path.isAbsolute(value)
    && !String(value).replace(/\\/g, '/').split('/').some((part) => part === '..' || !part));
}

const fileHash = fileSha256HashSync;
const jsonFile = readRegularJsonFileSync;

function receiptJson(row) {
  try { return JSON.parse(row?.receipt_json || ''); } catch { return null; }
}

export function workspaceExternalContentHash(entries = []) {
  const bindings = entries.filter((entry) => entry?.externalContent).map((entry) => ({
    path: entry.path,
    externalPath: entry.externalContent.path,
    hash: entry.externalContent.hash,
    bytes: Number(entry.externalContent.bytes || 0),
  }));
  return hashRecord('WorkspaceSnapshotExternalContentBindings', bindings);
}

export function workspaceRestoredManifestHash(entries = []) {
  return hashRecord('WorkspaceSnapshotRestoredManifest', entries.map(({ externalContent: _externalContent, ...entry }) => entry));
}

function archiveBlockers(archivePath, archiveHash) {
  const blockers = [];
  let stat = null;
  try { stat = fs.lstatSync(archivePath); } catch { blockers.push('workspace_snapshot_archive_missing'); }
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) blockers.push('workspace_snapshot_archive_not_regular_file');
  if (!blockers.length) {
    try {
      if (fileHash(archivePath) !== archiveHash) blockers.push('workspace_snapshot_archive_hash_mismatch');
    } catch { blockers.push('workspace_snapshot_archive_unreadable'); }
  }
  if (!blockers.length) {
    const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    if (listing.status !== 0) blockers.push('workspace_snapshot_archive_unreadable');
    else {
      const unsafe = String(listing.stdout || '').split(/\r?\n/)
        .filter(Boolean)
        .map((item) => item.replace(/^\.\//, '').replace(/\/$/, ''))
        .filter(Boolean)
        .find((item) => !safeRelative(item));
      if (unsafe) blockers.push('workspace_snapshot_archive_member_unsafe');
    }
  }
  return blockers;
}

function trustedRestoreLedgerEvidence(receiptLedger, restoreReceipt, restoreLedgerReceiptId) {
  const blockers = [];
  const restoreReceiptHash = restoreReceipt?.restoreReceiptHash || null;
  const expectedId = restoreReceiptHash ? `workspace-snapshot-restore:${restoreReceiptHash}` : null;
  if (!restoreLedgerReceiptId || restoreLedgerReceiptId !== expectedId) blockers.push('workspace_restore_ledger_receipt_id_invalid');
  const row = expectedId && receiptLedger?.get ? receiptLedger.get(expectedId) : null;
  const ledgerJson = receiptJson(row);
  if (!row || Number(row.effective_receipt_usable) !== 1) blockers.push('workspace_restore_effective_ledger_receipt_missing');
  const trusted = Boolean(row
    && row.receipt_id === expectedId
    && row.receipt_sha256 === restoreReceiptHash
    && row.stream === 'workspace-snapshot-restore'
    && row.kind === 'WorkspaceSnapshotRestoreReceipt'
    && row.status === 'workspace_snapshot_restore_verified'
    && row.environment === 'administrative'
    && row.evidence_class === 'workspace_snapshot_restore'
    && Number(row.writer_trusted) === 1
    && row.writer_id === VERIFIER_POLICY.writerId
    && row.writer_kind === VERIFIER_POLICY.writerKind
    && row.issuer_policy_id === 'workspace-snapshot-verifier'
    && row.issuer_policy_hash === VERIFIER_POLICY.issuerPolicyHash
    && row.issuer_assurance === VERIFIER_POLICY.assurance);
  if (row && !trusted) blockers.push('workspace_restore_effective_ledger_receipt_mismatch');
  if (row && !ledgerJson) blockers.push('workspace_restore_effective_ledger_json_invalid');
  if (ledgerJson && JSON.stringify(ledgerJson) !== JSON.stringify(restoreReceipt)) blockers.push('workspace_restore_effective_ledger_json_mismatch');
  return blockers;
}

export function verifyWorkspaceRetentionEvidence(record = {}, receiptLedger = null) {
  const blockers = [];
  let restoreReceipt = null;
  try { restoreReceipt = JSON.parse(record.restore_receipt_json || record.restoreReceiptJson || ''); } catch { blockers.push('workspace_restore_receipt_json_invalid'); }
  const workspaceId = record.workspace_id || record.workspaceId || null;
  const manifestHash = record.manifest_sha256 || record.manifestHash || null;
  const archivePath = record.archive_path || record.archivePath || null;
  const archiveHash = record.archive_sha256 || record.archiveHash || null;
  const manifestPath = record.manifest_path || record.manifestPath || null;
  const externalContentHash = record.external_content_sha256 || record.externalContentHash || null;
  const restoreReceiptHash = record.restore_receipt_sha256 || record.restoreReceiptHash || null;
  const restoreLedgerReceiptId = record.restore_ledger_receipt_id || record.restoreLedgerReceiptId || null;
  const exportReceiptHash = record.export_receipt_sha256 || record.exportReceiptHash || null;
  const workspacePath = record.workspace_path || record.workspacePath || null;
  const { restoreReceiptHash: embeddedRestoreHash = null, ...restorePayload } = restoreReceipt || {};
  const receiptValid = restoreReceipt?.version === 1
    && restoreReceipt.kind === 'WorkspaceSnapshotRestoreReceipt'
    && restoreReceipt.status === 'workspace_snapshot_restore_verified'
    && restoreReceipt.workspaceId === workspaceId
    && restoreReceipt.manifestHash === manifestHash
    && restoreReceipt.archivePath === archivePath
    && restoreReceipt.archiveHash === archiveHash
    && restoreReceipt.exportReceiptHash === exportReceiptHash
    && restoreReceipt.externalContentHash === externalContentHash
    && typeof restoreReceipt.restoredManifestHash === 'string'
    && restoreReceipt.restoredManifestHash.startsWith('sha256:')
    && Array.isArray(restoreReceipt.blockers)
    && restoreReceipt.blockers.length === 0
    && embeddedRestoreHash === restoreReceiptHash
    && hashRecord('WorkspaceSnapshotRestoreReceipt', restorePayload) === embeddedRestoreHash;
  if (!receiptValid) blockers.push('workspace_restore_receipt_binding_invalid');

  if (!archivePath || !archiveHash) blockers.push('workspace_snapshot_archive_binding_missing');
  else blockers.push(...archiveBlockers(archivePath, archiveHash));

  const exportReceipt = manifestPath ? jsonFile(manifestPath) : null;
  if (!exportReceipt) blockers.push('workspace_snapshot_manifest_receipt_missing_or_invalid');
  else {
    const { exportReceiptHash: embeddedExportHash = null, manifestPath: _manifestPath, ...exportPayload } = exportReceipt;
    if (embeddedExportHash !== exportReceiptHash
      || exportReceipt.manifestHash !== manifestHash
      || exportReceipt.archivePath !== archivePath
      || exportReceipt.archiveHash !== archiveHash
      || exportReceipt.externalContentHash !== externalContentHash
      || hashRecord('WorkspaceSnapshotExportReceipt', exportPayload) !== embeddedExportHash) {
      blockers.push('workspace_snapshot_manifest_receipt_binding_invalid');
    }
    if (workspaceExternalContentHash(exportReceipt.entries || []) !== externalContentHash) blockers.push('workspace_snapshot_external_content_binding_hash_invalid');
    for (const entry of exportReceipt.entries || []) {
      if (!entry.externalContent) continue;
      const external = entry.externalContent;
      let valid = false;
      try {
        const stat = fs.lstatSync(external.path);
        valid = stat.isFile() && !stat.isSymbolicLink() && stat.size === Number(external.bytes) && fileHash(external.path) === external.hash;
      } catch { valid = false; }
      if (!valid) blockers.push(`workspace_snapshot_external_content_invalid:${entry.path}`);
    }
    if (workspacePath) {
      try {
        const liveEntries = inspectLiveWorkspaceManifest({ workspacePath });
        const qualifiedEntries = (exportReceipt.entries || []).map(({ externalContent: _externalContent, ...entry }) => entry);
        if (JSON.stringify(liveEntries) !== JSON.stringify(qualifiedEntries)
          || workspaceRestoredManifestHash(liveEntries) !== restoreReceipt?.restoredManifestHash) {
          blockers.push('workspace_live_manifest_changed_after_qualification');
        }
      } catch {
        blockers.push('workspace_live_manifest_unsafe');
      }
    }
  }
  blockers.push(...trustedRestoreLedgerEvidence(receiptLedger, restoreReceipt, restoreLedgerReceiptId));
  const uniqueBlockers = [...new Set(blockers)];
  const evidence = {
    version: 1,
    kind: 'WorkspaceRetentionEvidenceVerification',
    workspaceId,
    workspacePath,
    archivePath,
    archiveHash,
    manifestHash,
    manifestPath,
    externalContentHash,
    restoreReceiptHash,
    restoreLedgerReceiptId,
    verified: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
  };
  return Object.freeze({ ...evidence, workspaceRetentionEvidenceHash: hashRecord('WorkspaceRetentionEvidenceVerification', evidence) });
}
