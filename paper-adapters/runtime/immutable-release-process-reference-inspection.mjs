import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  IMMUTABLE_RELEASE_LIVE_ROOT,
  IMMUTABLE_RELEASE_STORE_ROOT,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function decodeMountPath(value) {
  return String(value).replace(/\\([0-7]{3})/gu, (_match, octal) => (
    String.fromCharCode(Number.parseInt(octal, 8))
  ));
}

function parseMountInfo(text) {
  return String(text).trim().split('\n').filter(Boolean).map((line) => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields.length < separator + 4) {
      throw codedError('immutable_release_mountinfo_invalid');
    }
    return Object.freeze({
      root: decodeMountPath(fields[3]),
      mountPoint: decodeMountPath(fields[4]),
      source: decodeMountPath(fields[separator + 2]),
    });
  });
}

function withinOrSame(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function parseProcCommandLine(commandLine) {
  if (commandLine.length === 0) return [];
  if (commandLine.at(-1) !== 0) {
    throw codedError('immutable_release_proc_cmdline_invalid', {
      reason: 'missing_nul_terminator',
    });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(commandLine.subarray(0, -1)).split('\0');
  } catch (error) {
    throw codedError('immutable_release_proc_cmdline_invalid', {
      reason: 'invalid_utf8',
      cause: error,
    });
  }
}

export function defaultImmutableReleaseProcessReferenceInspection(
  releasePath,
  procRoot = '/proc',
) {
  if (typeof releasePath !== 'string' || path.dirname(releasePath) !== IMMUTABLE_RELEASE_STORE_ROOT
    || !/^[0-9a-f]{40}$/u.test(path.basename(releasePath))
    || typeof procRoot !== 'string' || !path.isAbsolute(procRoot)) {
    throw codedError('immutable_release_reference_scan_options_invalid');
  }
  const references = [];
  const processRace = (error) => ['ENOENT', 'ESRCH'].includes(error?.code);
  const inspectOrFail = (operation, callback) => {
    try { return callback(); } catch (error) {
      if (processRace(error)) return null;
      throw codedError(`immutable_release_proc_inspection_failed:${operation}`, { cause: error });
    }
  };
  const record = (pid, kind, target) => {
    const normalized = String(target).replace(/ \(deleted\)$/u, '');
    if (withinOrSame(releasePath, normalized)
      || withinOrSame(IMMUTABLE_RELEASE_LIVE_ROOT, normalized)) {
      references.push(`${pid}:${kind}`);
    }
  };
  const deploymentMountNamespace = inspectOrFail('self:ns:mnt',
    () => fs.readlinkSync(path.join(procRoot, 'self', 'ns', 'mnt')));
  if (deploymentMountNamespace === null) {
    throw codedError('immutable_release_proc_self_mount_namespace_missing');
  }
  for (const pid of fs.readdirSync(procRoot).filter((name) => /^[0-9]+$/u.test(name))) {
    const processRoot = path.join(procRoot, pid);
    for (const kind of ['cwd', 'exe', 'root']) {
      const target = inspectOrFail(`${pid}:${kind}`,
        () => fs.readlinkSync(path.join(processRoot, kind)));
      if (target !== null) record(pid, kind, target);
    }
    const descriptors = inspectOrFail(`${pid}:fd`,
      () => fs.readdirSync(path.join(processRoot, 'fd')));
    if (descriptors !== null) {
      for (const descriptor of descriptors) {
        const target = inspectOrFail(`${pid}:fd:${descriptor}`,
          () => fs.readlinkSync(path.join(processRoot, 'fd', descriptor)));
        if (target !== null) record(pid, `fd:${descriptor}`, target);
      }
    }
    const commandLine = inspectOrFail(`${pid}:cmdline`,
      () => fs.readFileSync(path.join(processRoot, 'cmdline')));
    if (commandLine !== null) {
      if (!Buffer.isBuffer(commandLine) || commandLine.length > 4 * 1024 * 1024) {
        throw codedError('immutable_release_proc_cmdline_too_large');
      }
      const rawArguments = parseProcCommandLine(commandLine);
      const trustedExecutorArguments = new Set([
        `${IMMUTABLE_RELEASE_LIVE_ROOT}/paper-core/bin/immutable-release-deploy.mjs`,
        `${releasePath}/paper-core/bin/immutable-release-deploy.mjs`,
      ]);
      for (const argument of rawArguments) {
        if (!argument.startsWith('/')) continue;
        if (pid === String(process.pid) && trustedExecutorArguments.has(argument)) continue;
        record(pid, 'cmdline', argument);
      }
    }
    const maps = inspectOrFail(`${pid}:maps`,
      () => fs.readFileSync(path.join(processRoot, 'maps'), 'utf8'));
    if (maps !== null) {
      if (maps.length > 64 * 1024 * 1024) {
        throw codedError('immutable_release_proc_maps_too_large');
      }
      for (const line of maps.split('\n')) {
        const mapped = line.slice(line.indexOf('/') >= 0 ? line.indexOf('/') : line.length);
        if (mapped) record(pid, 'maps', mapped);
      }
    }
    const processMountNamespaceBefore = inspectOrFail(`${pid}:ns:mnt:before`,
      () => fs.readlinkSync(path.join(processRoot, 'ns', 'mnt')));
    if (processMountNamespaceBefore === null) continue;
    const mountInfo = inspectOrFail(`${pid}:mountinfo`,
      () => fs.readFileSync(path.join(processRoot, 'mountinfo'), 'utf8'));
    const processMountNamespaceAfter = inspectOrFail(`${pid}:ns:mnt:after`,
      () => fs.readlinkSync(path.join(processRoot, 'ns', 'mnt')));
    if (processMountNamespaceAfter === null) continue;
    if (processMountNamespaceBefore !== processMountNamespaceAfter) {
      throw codedError(`immutable_release_proc_mount_namespace_changed:${pid}`);
    }
    if (mountInfo !== null) {
      for (const mount of parseMountInfo(mountInfo)) {
        const canonicalSharedLiveMount = processMountNamespaceAfter === deploymentMountNamespace
          && mount.mountPoint === IMMUTABLE_RELEASE_LIVE_ROOT
          && mount.root === releasePath;
        if (!canonicalSharedLiveMount) {
          record(pid, 'mountinfo:root', mount.root);
          record(pid, 'mountinfo:mount-point', mount.mountPoint);
          record(pid, 'mountinfo:source', mount.source);
        }
      }
    }
  }
  const completedDeploymentMountNamespace = inspectOrFail('self:ns:mnt:after',
    () => fs.readlinkSync(path.join(procRoot, 'self', 'ns', 'mnt')));
  if (completedDeploymentMountNamespace === null
    || completedDeploymentMountNamespace !== deploymentMountNamespace) {
    throw codedError('immutable_release_proc_self_mount_namespace_changed');
  }
  return Object.freeze([...new Set(references)].sort());
}

export function inspectImmutableReleaseProcessReferences({
  releasePath,
  procRoot = '/proc',
} = {}) {
  return defaultImmutableReleaseProcessReferenceInspection(releasePath, procRoot);
}
