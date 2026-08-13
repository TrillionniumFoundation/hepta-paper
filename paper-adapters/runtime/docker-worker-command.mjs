import {
  dockerWorkerContainerOwnershipArguments,
} from './docker-worker-container-recovery.mjs';

export function buildDockerWorkerCommand({
  limits, uid, gid, environment, requiresGpu, systemMounts, workRoot, outputRoot, supervisorRoot,
  runtimeExecutableSnapshot, runtimeExecutableOverlayTarget, mountedDatasets, relativeCwd,
  containerImageDigest, datasetSupervisor, executable, arguments: workerArguments,
  immutableWorkRoot = false, containerOwnership = null, attachStandardInput = false,
} = {}) {
  return [
    'run',
    ...(containerOwnership
      ? dockerWorkerContainerOwnershipArguments(containerOwnership) : []),
    ...(attachStandardInput ? ['--interactive'] : []),
    '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    ...(datasetSupervisor ? ['--cap-add', 'SYS_PTRACE', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'SETPCAP', '--cap-add', 'DAC_OVERRIDE'] : []),
    '--security-opt', 'no-new-privileges', '--memory', String(limits.memory), '--cpus', '1',
    '--pids-limit', String(limits.pids), '--ulimit', `cpu=${limits.cpu}`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', ...(datasetSupervisor ? [] : ['--user', `${uid}:${gid}`]),
    '--env', 'HOME=/tmp', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
    ...environment.flatMap(([key, value]) => ['--env', `${key}=${String(value)}`]),
    ...(requiresGpu ? ['--runtime', 'nvidia', '--env', 'NVIDIA_VISIBLE_DEVICES=all', '--env', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility'] : []),
    ...systemMounts,
    '--volume', `${workRoot}:/source:ro`, '--volume', `${workRoot}:/work:${datasetSupervisor || immutableWorkRoot ? 'ro' : 'rw'}`, '--volume', `${outputRoot}:/output:rw`,
    ...(datasetSupervisor ? ['--volume', `${supervisorRoot}:/hepta-supervisor:rw`] : []),
    ...(runtimeExecutableSnapshot ? ['--volume', `${runtimeExecutableSnapshot.path}:${runtimeExecutableOverlayTarget}:ro`] : []),
    ...mountedDatasets.flatMap((mount) => ['--volume', `${mount.mountSource}:${mount.target}:ro`]),
    '--workdir', `/work${relativeCwd ? `/${relativeCwd}` : ''}`, containerImageDigest,
    ...(datasetSupervisor ? [datasetSupervisor.path, '--expected-supervisor-sha256', datasetSupervisor.sha256,
      '--trace-owner-uid', String(uid), '--trace-owner-gid', String(gid), '--workload-uid', String(datasetSupervisor.workloadUid),
      '--workload-gid', String(gid), '--'] : []),
    executable, ...workerArguments,
  ];
}

export function buildBubblewrapWorkerCommand({
  limits, bubblewrap, texMounts, runtimeMounts, workRoot, outputRoot, runtimeExecutableSnapshot,
  runtimeExecutableOverlayTarget, relativeCwd, mountedDatasets, requiresGpu, gpuDevices,
  environment, executable, arguments: workerArguments,
  immutableWorkRoot = false,
} = {}) {
  return [
    `--as=${limits.memory}`, `--cpu=${limits.cpu}`, `--nproc=${limits.pids}:${limits.pids}`, '--', bubblewrap,
    '--unshare-user-try', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--unshare-net', '--die-with-parent', '--new-session',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    ...texMounts, ...runtimeMounts,
    '--ro-bind', workRoot, '/source', immutableWorkRoot ? '--ro-bind' : '--bind', workRoot, '/work', '--bind', outputRoot, '/output',
    ...(runtimeExecutableSnapshot ? ['--ro-bind', runtimeExecutableSnapshot.path, runtimeExecutableOverlayTarget] : []),
    '--chdir', `/work${relativeCwd ? `/${relativeCwd}` : ''}`,
    ...mountedDatasets.flatMap((mount) => ['--ro-bind', mount.mountSource, mount.target]),
    ...(requiresGpu ? gpuDevices.flatMap((device) => ['--dev-bind', device, device]) : []),
    '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
    ...environment.flatMap(([key, value]) => ['--setenv', key, String(value)]),
    executable, ...workerArguments,
  ];
}
