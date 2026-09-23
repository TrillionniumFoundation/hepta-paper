import { hashBytes, hashRecord } from '../record-hash.mjs';

function sorted(values = []) {
  return [...values].sort((left, right) => String(left?.path || '').localeCompare(String(right?.path || '')));
}

export function workspaceExecutionMerkleHash(fileRecords = []) {
  return hashBytes(sorted(fileRecords).map((record) => `${record.path}\0${String(record.hash).slice('sha256:'.length)}`).join('\n'));
}

export function workspaceExecutionManifestHash(fileRecords = [], directoryRecords = []) {
  const records = [
    ...fileRecords.map((record) => ({ path: record.path, value: `file\0${record.path}\0${Number(record.mode)}\0${record.hash}\0${Number(record.bytes)}` })),
    ...directoryRecords.map((record) => ({ path: record.path, value: `directory\0${record.path}\0${Number(record.mode)}` })),
  ].sort((left, right) => left.path.localeCompare(right.path)).map((record) => record.value);
  return hashRecord('WorkspaceExecutionSnapshotManifest', {
    version: 1,
    kind: 'WorkspaceExecutionSnapshotManifest',
    records,
  });
}
