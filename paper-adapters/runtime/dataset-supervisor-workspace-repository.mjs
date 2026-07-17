import fs from 'node:fs';
import path from 'node:path';

function makeTreeReadableByHostGroup(candidate) {
  const identity = fs.lstatSync(candidate);
  if (identity.isSymbolicLink()) return;
  if (identity.isDirectory()) {
    fs.chmodSync(candidate, 0o750);
    for (const name of fs.readdirSync(candidate)) makeTreeReadableByHostGroup(path.join(candidate, name));
  } else if (identity.isFile()) fs.chmodSync(candidate, identity.mode & 0o111 ? 0o750 : 0o640);
}

function createEvidenceFile(candidate) {
  const descriptor = fs.openSync(candidate, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  fs.closeSync(descriptor);
  fs.chmodSync(candidate, 0o600);
}

export function createDatasetSupervisorEvidenceFiles({ tracePath, identityPath }) {
  createEvidenceFile(tracePath);
  createEvidenceFile(identityPath);
}

export function prepareUnprivilegedDatasetWorkspace({ outputRoot, workRoot, mountedDatasets }) {
  fs.chmodSync(outputRoot, 0o770);
  makeTreeReadableByHostGroup(workRoot);
  for (const mount of mountedDatasets) makeTreeReadableByHostGroup(mount.mountSource);
}
