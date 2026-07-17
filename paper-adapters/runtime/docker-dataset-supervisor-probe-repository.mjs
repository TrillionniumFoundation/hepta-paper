import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createDockerDatasetSupervisorProbeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dataset-supervisor-probe-'));
  const datasetPath = path.join(root, 'dataset');
  const outputRoot = path.join(root, 'output');
  const supervisorRoot = path.join(root, 'supervisor');
  const tracePath = path.join(supervisorRoot, 'dataset-access.trace');
  const identityPath = path.join(supervisorRoot, 'supervisor-identity');
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
  return Object.freeze({ root, datasetPath, outputRoot, supervisorRoot, tracePath, identityPath });
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

export function removeDockerDatasetSupervisorProbeWorkspace(workspace) {
  fs.rmSync(workspace?.root, { recursive: true, force: true });
}
