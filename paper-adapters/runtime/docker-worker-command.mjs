import {
  dockerWorkerContainerOwnershipArguments,
} from './docker-worker-container-recovery.mjs';

const NVIDIA_GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeNvidiaGpuDeviceSelector(value) {
  const candidate = String(value || '').trim();
  if (!NVIDIA_GPU_UUID.test(candidate)) return null;
  return `GPU-${candidate.slice(4).toLowerCase()}`;
}

export function parseNvidiaGpuDeviceSelectorList(value) {
  return Object.freeze([...new Set(String(value || '').split(/\r?\n/)
    .map(normalizeNvidiaGpuDeviceSelector).filter(Boolean))].sort());
}

export function buildDockerWorkerCommand({
  limits, uid, gid, environment, requiresGpu, systemMounts, workRoot, outputRoot, supervisorRoot,
  runtimeExecutableSnapshot, runtimeExecutableOverlayTarget, mountedDatasets, relativeCwd,
  containerImageDigest, datasetSupervisor, executable, arguments: workerArguments,
  immutableWorkRoot = false, containerOwnership = null, attachStandardInput = false,
  gpuDeviceSelector = null,
} = {}) {
  const selectedGpu = normalizeNvidiaGpuDeviceSelector(gpuDeviceSelector);
  if (requiresGpu && !selectedGpu) throw new Error('docker_worker_gpu_device_selector_invalid');
  if (!requiresGpu && gpuDeviceSelector !== null && gpuDeviceSelector !== undefined) {
    throw new Error('docker_worker_gpu_device_selector_without_gpu_request');
  }
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
    ...(requiresGpu ? [
      '--gpus', `device=${selectedGpu}`,
      '--env', `NVIDIA_VISIBLE_DEVICES=${selectedGpu}`,
      '--env', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility',
    ] : []),
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
  runtimeExecutableOverlayTarget, relativeCwd, mountedDatasets, requiresGpu,
  environment, executable, arguments: workerArguments,
  immutableWorkRoot = false,
} = {}) {
  if (requiresGpu) throw new Error('bubblewrap_gpu_device_isolation_unsupported');
  return [
    `--as=${limits.memory}`, `--cpu=${limits.cpu}`, `--nproc=${limits.pids}:${limits.pids}`, '--', bubblewrap,
    '--unshare-user-try', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--unshare-net', '--die-with-parent', '--new-session',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    ...texMounts, ...runtimeMounts,
    '--ro-bind', workRoot, '/source', immutableWorkRoot ? '--ro-bind' : '--bind', workRoot, '/work', '--bind', outputRoot, '/output',
    ...(runtimeExecutableSnapshot ? ['--ro-bind', runtimeExecutableSnapshot.path, runtimeExecutableOverlayTarget] : []),
    '--chdir', `/work${relativeCwd ? `/${relativeCwd}` : ''}`,
    ...mountedDatasets.flatMap((mount) => ['--ro-bind', mount.mountSource, mount.target]),
    '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
    ...environment.flatMap(([key, value]) => ['--setenv', key, String(value)]),
    executable, ...workerArguments,
  ];
}
