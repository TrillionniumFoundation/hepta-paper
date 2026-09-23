import fs from 'node:fs';
import path from 'node:path';

import {
  assertImmutableReleaseDeploymentPlan,
  IMMUTABLE_RELEASE_ABSENT_UNIT_TARGET_ENABLEMENT,
  IMMUTABLE_RELEASE_CONSUMER_UNITS,
  IMMUTABLE_RELEASE_LIVE_ROOT,
  IMMUTABLE_RELEASE_MOUNT_UNIT,
  IMMUTABLE_RELEASE_RECOVERY_UNIT,
  IMMUTABLE_RELEASE_STORE_ROOT,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';

const SYSTEMCTL = '/usr/bin/systemctl';
const SHELL = '/usr/bin/dash';
const INSTALLER_RELATIVE_PATH = 'paper-core/deploy/install-hepta-paper-systemd-host.sh';
const SYSTEMCTL_UNIT_ALLOWLIST = new Set([
  ...IMMUTABLE_RELEASE_CONSUMER_UNITS,
  IMMUTABLE_RELEASE_MOUNT_UNIT,
]);
const SYSTEMCTL_INSPECTION_UNIT_ALLOWLIST = new Set([
  ...SYSTEMCTL_UNIT_ALLOWLIST,
  IMMUTABLE_RELEASE_RECOVERY_UNIT,
]);

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

export function immutableReleaseDeploymentCleanEnvironment() {
  return Object.freeze({
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
    SYSTEMD_COLORS: '0',
    SYSTEMD_PAGER: 'cat',
  });
}

function exactAllowedUnits(units, allowlist = SYSTEMCTL_UNIT_ALLOWLIST) {
  return Array.isArray(units) && units.length > 0
    && units.every((unit) => typeof unit === 'string' && allowlist.has(unit))
    && new Set(units).size === units.length;
}

export function immutableReleaseSystemctlInvocation({
  operation,
  units = [],
  runtime = false,
  property = null,
  noBlock = false,
} = {}) {
  if (operation === 'daemon-reload') {
    if (units.length !== 0 || runtime || property !== null || noBlock) {
      throw codedError('immutable_release_systemctl_invocation_invalid');
    }
    return Object.freeze({ executable: SYSTEMCTL, arguments: Object.freeze(['daemon-reload']) });
  }
  if (!['disable', 'enable', 'mask', 'restart', 'show', 'start', 'stop', 'unmask']
    .includes(operation) || !exactAllowedUnits(
      units,
      operation === 'show' ? SYSTEMCTL_INSPECTION_UNIT_ALLOWLIST : SYSTEMCTL_UNIT_ALLOWLIST,
    )) {
    throw codedError('immutable_release_systemctl_invocation_invalid');
  }
  if (runtime && !['disable', 'enable', 'mask', 'unmask'].includes(operation)) {
    throw codedError('immutable_release_systemctl_invocation_invalid');
  }
  if (noBlock && !['start', 'stop'].includes(operation)) {
    throw codedError('immutable_release_systemctl_invocation_invalid');
  }
  const argumentsList = [operation];
  if (runtime) argumentsList.push('--runtime');
  if (noBlock) argumentsList.push('--no-block');
  if (operation === 'show') {
    if (noBlock || units.length !== 1
      || ![
        'ActiveState', 'After', 'DropInPaths', 'FragmentPath', 'Job', 'LoadState',
        'NeedDaemonReload', 'Requires', 'UnitFileState',
      ].includes(property)) {
      throw codedError('immutable_release_systemctl_invocation_invalid');
    }
    argumentsList.push(`--property=${property}`, '--value');
  } else if (property !== null) {
    throw codedError('immutable_release_systemctl_invocation_invalid');
  }
  argumentsList.push('--', ...units);
  return Object.freeze({
    executable: SYSTEMCTL,
    arguments: Object.freeze(argumentsList),
  });
}

export function immutableReleaseSystemctlJobInspectionInvocation({
  jobId,
  property,
} = {}) {
  if (!/^[1-9][0-9]*$/u.test(String(jobId || ''))
    || !['JobType', 'Unit'].includes(property)) {
    throw codedError('immutable_release_systemctl_job_inspection_invalid');
  }
  return Object.freeze({
    executable: SYSTEMCTL,
    arguments: Object.freeze([
      'show', `--property=${property}`, '--value', '--', String(jobId),
    ]),
  });
}

export function immutableReleaseInstallerInvocation({ plan, installRoot = '/' } = {}) {
  assertImmutableReleaseDeploymentPlan(plan);
  if (installRoot !== '/') throw codedError('immutable_release_installer_root_unpinned');
  const installer = path.join(plan.target.releasePath, INSTALLER_RELATIVE_PATH);
  if (installer !== `${IMMUTABLE_RELEASE_STORE_ROOT}/${plan.commit}/${INSTALLER_RELATIVE_PATH}`) {
    throw codedError('immutable_release_installer_path_invalid');
  }
  return Object.freeze({
    executable: SHELL,
    arguments: Object.freeze([
      installer, '--root', '/', '--no-systemctl', '--preserve-deployment-bootstrap',
    ]),
  });
}

export function immutableReleaseMountUnit({ releasePath } = {}) {
  if (typeof releasePath !== 'string'
    || path.dirname(releasePath) !== IMMUTABLE_RELEASE_STORE_ROOT
    || !/^[0-9a-f]{40}$/u.test(path.basename(releasePath))) {
    throw codedError('immutable_release_mount_source_invalid');
  }
  return [
    '[Unit]',
    'Description=Hepta Paper sealed immutable release mount',
    'Before=hepta-paper-host-bootstrap.service autonomous-research-supervisor.service autonomous-submission-dispatcher.service strict-full-auto-acceptance.service',
    'After=local-fs.target',
    '',
    '[Mount]',
    `What=${releasePath}`,
    `Where=${IMMUTABLE_RELEASE_LIVE_ROOT}`,
    'Type=none',
    'Options=bind,ro,nosuid,nodev',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export function immutableReleaseTargetUnitStates(unitStates) {
  if (!Array.isArray(unitStates)
    || JSON.stringify(unitStates.map(({ name }) => name))
      !== JSON.stringify(IMMUTABLE_RELEASE_CONSUMER_UNITS)) {
    throw codedError('immutable_release_target_unit_states_invalid');
  }
  return Object.freeze(unitStates.map((unit) => Object.freeze(unit.enablement === 'not-found'
    ? { ...unit, enablement: IMMUTABLE_RELEASE_ABSENT_UNIT_TARGET_ENABLEMENT[unit.name] }
    : { ...unit })));
}

export function executeImmutableReleaseHostCommand(runner, command, {
  allowedStatuses = [0],
  maxBuffer = 4 * 1024 * 1024,
} = {}) {
  const result = runner(command.executable, [...command.arguments], {
    encoding: 'utf8',
    env: immutableReleaseDeploymentCleanEnvironment(),
    maxBuffer,
    shell: false,
    timeout: 120_000,
  });
  if (result?.error || result?.signal || !allowedStatuses.includes(result?.status)) {
    throw codedError('immutable_release_host_command_failed', {
      executable: command.executable,
      exitStatus: result?.status ?? null,
      signal: result?.signal ?? null,
    });
  }
  return String(result.stdout || '').trim();
}

export function assertTrustedImmutableReleaseHostExecutable(executable) {
  const stat = fs.lstatSync(executable, { bigint: true });
  if (!path.isAbsolute(executable) || fs.realpathSync(executable) !== executable
    || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0n || stat.gid !== 0n
    || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n) {
    throw codedError('immutable_release_host_executable_untrusted');
  }
}

export const IMMUTABLE_RELEASE_HOST_EXECUTABLES = Object.freeze({
  shell: SHELL,
  systemctl: SYSTEMCTL,
});
