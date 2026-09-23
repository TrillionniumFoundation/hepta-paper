import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE_PREFIX = 'hepta-dataset-supervisor-probe-';
const OWNERSHIP_FILE = '.hepta-dataset-supervisor-probe-ownership.json';
const OWNERSHIP_KIND = 'TrustedDatasetSupervisorProbeWorkspaceOwnership';

function ownershipDocument(root) {
  return Object.freeze({
    version: 1,
    kind: OWNERSHIP_KIND,
    probeId: path.basename(root),
  });
}

function exactOwnershipDocument(value, root) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify(['kind', 'probeId', 'version'])
    && value.version === 1 && value.kind === OWNERSHIP_KIND
    && value.probeId === path.basename(root)
    && value.probeId.startsWith(WORKSPACE_PREFIX);
}

export function createDockerDatasetSupervisorProbeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), WORKSPACE_PREFIX));
  const datasetPath = path.join(root, 'dataset');
  const outputRoot = path.join(root, 'output');
  const supervisorRoot = path.join(root, 'supervisor');
  const tracePath = path.join(supervisorRoot, 'dataset-access.trace');
  const identityPath = path.join(supervisorRoot, 'supervisor-identity');
  const ownershipPath = path.join(root, OWNERSHIP_FILE);
  fs.writeFileSync(ownershipPath, `${JSON.stringify(ownershipDocument(root))}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  fs.chmodSync(ownershipPath, 0o600);
  fs.writeFileSync(datasetPath, 'hepta-dataset-supervisor-probe\n', { mode: 0o640 });
  fs.mkdirSync(outputRoot, { mode: 0o770 });
  fs.chmodSync(outputRoot, 0o770);
  fs.mkdirSync(supervisorRoot, { mode: 0o700 });
  fs.chmodSync(supervisorRoot, 0o700);
  for (const candidate of [tracePath, identityPath]) {
    const descriptor = fs.openSync(candidate, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.closeSync(descriptor);
    fs.chmodSync(candidate, 0o600);
  }
  return Object.freeze({
    root, datasetPath, outputRoot, supervisorRoot, tracePath, identityPath, ownershipPath,
  });
}

export function readDockerDatasetSupervisorProbeEvidence(workspace) {
  const outputIdentity = fs.lstatSync(path.join(workspace.outputRoot, 'probe.txt'));
  const output = fs.readFileSync(path.join(workspace.outputRoot, 'probe.txt'), 'utf8');
  const traceIdentity = fs.lstatSync(workspace.tracePath);
  const identityIdentity = fs.lstatSync(workspace.identityPath);
  const trace = fs.readFileSync(workspace.tracePath, 'utf8');
  const identityContent = fs.readFileSync(workspace.identityPath, 'utf8');
  const identity = Object.fromEntries(identityContent.split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return Object.freeze({ outputIdentity, output, traceIdentity, identityIdentity, trace, identity });
}

export function verifyDockerDatasetSupervisorProbeWorkspace(workspace) {
  const root = path.resolve(String(workspace?.root || ''));
  if (path.dirname(root) !== path.resolve(os.tmpdir())
    || !path.basename(root).startsWith(WORKSPACE_PREFIX)) return false;
  try {
    const rootIdentity = fs.lstatSync(root);
    const ownershipPath = path.join(root, OWNERSHIP_FILE);
    const markerIdentity = fs.lstatSync(ownershipPath);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : rootIdentity.uid;
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()
      || rootIdentity.uid !== currentUid || (rootIdentity.mode & 0o777) !== 0o700
      || !markerIdentity.isFile() || markerIdentity.isSymbolicLink()
      || markerIdentity.uid !== currentUid || markerIdentity.nlink !== 1
      || (markerIdentity.mode & 0o777) !== 0o600 || markerIdentity.size > 512) return false;
    const value = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));
    return exactOwnershipDocument(value, root);
  } catch { return false; }
}

export function removeDockerDatasetSupervisorProbeWorkspace(workspace) {
  if (!verifyDockerDatasetSupervisorProbeWorkspace(workspace)) {
    throw new Error('docker_dataset_supervisor_probe_workspace_ownership_invalid');
  }
  fs.rmSync(path.resolve(workspace.root), { recursive: true, force: true });
  if (fs.existsSync(path.resolve(workspace.root))) {
    throw new Error('docker_dataset_supervisor_probe_workspace_removal_failed');
  }
  return true;
}
