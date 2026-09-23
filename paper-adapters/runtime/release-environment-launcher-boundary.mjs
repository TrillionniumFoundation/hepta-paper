import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEPLOYMENT_LOCK = '/run/hepta-paper-deployment/deployment.lock';
const DEPLOYMENT_LOCK_DESCRIPTOR = 9;
const LAUNCHER_MARKER = 'sealed-v1';
const DOCKER_SOCKET = '/var/run/docker.sock';
const HANDOFF_ROOT =
  '/var/lib/hepta-paper/runtime/autonomous-research/submission-handoff';
const DOCKER_ACTIONS = new Set(['formal:gate', 'release:verify']);
const HANDOFF_ACTIONS = new Set(['release:verify', 'store:trust-gate']);

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function exactIdentity(stat) {
  return JSON.stringify({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    uid: String(stat.uid),
    gid: String(stat.gid),
  });
}

function validLock(stat, { expectedUid, expectedGid }) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.uid === BigInt(expectedUid)
    && stat.gid === BigInt(expectedGid)
    && (Number(stat.mode) & 0o7777) === 0o600
    && stat.nlink === 1n
    && stat.size === 0n;
}

function validLockRoot(stat, { expectedUid, expectedGid }) {
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && stat.uid === BigInt(expectedUid)
    && stat.gid === BigInt(expectedGid)
    && (Number(stat.mode) & 0o7777) === 0o711;
}

function requiredExecutionGroups({
  action,
  executionUser,
  dockerSocket,
  dockerGroupGid,
  handoffRoot,
  handoffGroupGid,
}) {
  const required = [executionUser?.gid];
  if (DOCKER_ACTIONS.has(action)) {
    let selectedDockerGid = dockerGroupGid;
    if (selectedDockerGid === null) {
      let socketStat;
      try {
        socketStat = fs.lstatSync(dockerSocket);
      } catch {
        throw codedError('release_environment_docker_socket_invalid');
      }
      if (!socketStat.isSocket()
        || socketStat.uid !== 0
        || (socketStat.mode & 0o7777) !== 0o660
        || socketStat.nlink !== 1) {
        throw codedError('release_environment_docker_socket_invalid');
      }
      selectedDockerGid = socketStat.gid;
    }
    if (!Number.isSafeInteger(selectedDockerGid)
      || selectedDockerGid < 1
      || required.includes(selectedDockerGid)) {
      throw codedError('release_environment_docker_group_invalid');
    }
    required.push(selectedDockerGid);
  }

  if (HANDOFF_ACTIONS.has(action)) {
    let selectedHandoffGid = handoffGroupGid;
    if (selectedHandoffGid === null) {
      let handoffStat;
      try {
        handoffStat = fs.lstatSync(handoffRoot);
        if (fs.realpathSync(handoffRoot) !== handoffRoot) {
          throw codedError('release_environment_handoff_root_invalid');
        }
      } catch (error) {
        if (error?.code === 'release_environment_handoff_root_invalid') throw error;
        throw codedError('release_environment_handoff_root_invalid');
      }
      if (!handoffStat.isDirectory()
        || handoffStat.isSymbolicLink()
        || handoffStat.uid !== 0
        || (handoffStat.mode & 0o7777) !== 0o3770) {
        throw codedError('release_environment_handoff_root_invalid');
      }
      selectedHandoffGid = handoffStat.gid;
    }
    if (!Number.isSafeInteger(selectedHandoffGid)
      || selectedHandoffGid < 1
      || required.includes(selectedHandoffGid)) {
      throw codedError('release_environment_handoff_group_invalid');
    }
    required.push(selectedHandoffGid);
  }
  return required;
}

export function inspectReleaseEnvironmentLauncherBoundary({
  action = null,
  environment = process.env,
  deploymentLock = DEPLOYMENT_LOCK,
  descriptor = DEPLOYMENT_LOCK_DESCRIPTOR,
  expectedUid = 0,
  expectedGid = 0,
  executionUser = os.userInfo(),
  effectiveUid = process.getuid?.(),
  effectiveGid = process.getgid?.(),
  supplementaryGroups = process.getgroups?.(),
  expectedExecutionUsername = 'hepta-paper',
  processStatus = fs.readFileSync('/proc/self/status', 'utf8'),
  dockerSocket = DOCKER_SOCKET,
  dockerGroupGid = null,
  handoffRoot = HANDOFF_ROOT,
  handoffGroupGid = null,
} = {}) {
  if (environment?.HEPTA_RELEASE_ENV_LAUNCHER !== LAUNCHER_MARKER) {
    throw codedError('release_environment_launcher_required');
  }
  let before;
  let opened;
  let after;
  let rootBefore;
  let rootAfter;
  try {
    rootBefore = fs.lstatSync(path.dirname(deploymentLock), { bigint: true });
    before = fs.lstatSync(deploymentLock, { bigint: true });
    opened = fs.fstatSync(descriptor, { bigint: true });
    after = fs.lstatSync(deploymentLock, { bigint: true });
    rootAfter = fs.lstatSync(path.dirname(deploymentLock), { bigint: true });
  } catch {
    throw codedError('release_environment_deployment_lock_invalid');
  }
  if (!validLockRoot(rootBefore, { expectedUid, expectedGid })
    || !validLockRoot(rootAfter, { expectedUid, expectedGid })
    || !validLock(before, { expectedUid, expectedGid })
    || !validLock(opened, { expectedUid, expectedGid })
    || !validLock(after, { expectedUid, expectedGid })) {
    throw codedError('release_environment_deployment_lock_invalid');
  }
  if (exactIdentity(rootBefore) !== exactIdentity(rootAfter)
    || before.dev !== opened.dev || before.ino !== opened.ino
    || exactIdentity(before) !== exactIdentity(after)) {
    throw codedError('release_environment_deployment_lock_identity_mismatch');
  }
  const actualGroups = Array.isArray(supplementaryGroups)
    ? [...new Set(supplementaryGroups)].sort((left, right) => left - right) : [];
  const requiredGroups = [...new Set(requiredExecutionGroups({
    action,
    executionUser,
    dockerSocket,
    dockerGroupGid,
    handoffRoot,
    handoffGroupGid,
  }))].sort((left, right) => left - right);
  if (executionUser?.username !== expectedExecutionUsername
    || !Number.isSafeInteger(executionUser?.uid)
    || !Number.isSafeInteger(executionUser?.gid)
    || effectiveUid !== executionUser.uid
    || effectiveGid !== executionUser.gid
    || JSON.stringify(actualGroups) !== JSON.stringify(requiredGroups)) {
    throw codedError('release_environment_execution_principal_invalid');
  }
  const noNewPrivileges = String(processStatus).match(/^NoNewPrivs:\s*([01])$/mu);
  if (!noNewPrivileges || noNewPrivileges[1] !== '1') {
    throw codedError('release_environment_no_new_privileges_required');
  }
  return Object.freeze({
    status: 'release_environment_launcher_boundary_verified',
    deploymentLock,
    descriptor,
  });
}
