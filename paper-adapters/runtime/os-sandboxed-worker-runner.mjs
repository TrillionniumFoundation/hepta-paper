import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertWorkerRunnerPort } from '../../paper-ports/worker-runner-port.mjs';
import { buildExecutorCapabilities, evaluateExecutorCapabilityRequest } from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PROBE_CACHE = new Map();
const SOURCE_EXCLUDED_NAMES = new Set(['.git', 'node_modules', 'runtime', 'automation-results', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);

function sourceExcludedName(name) {
  return SOURCE_EXCLUDED_NAMES.has(name) || /^\.venv(?:-|$)/.test(name) || name === 'venv';
}

export function sourceTreeExcludedNames(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [...SOURCE_EXCLUDED_NAMES];
  return [...new Set([...SOURCE_EXCLUDED_NAMES, ...fs.readdirSync(root, { withFileTypes: true }).filter((entry) => sourceExcludedName(entry.name)).map((entry) => entry.name)])];
}

function resolveExecutable(executable) {
  const value = String(executable || '');
  if (!value) return null;
  if (path.isAbsolute(value)) {
    try { return fs.realpathSync(value); } catch { return value; }
  }
  const located = spawnSync('which', [value], { encoding: 'utf8', timeout: 3000 });
  const candidate = String(located.stdout || '').trim();
  if (!candidate) return null;
  try { return fs.realpathSync(candidate); } catch { return candidate; }
}

function probeBubblewrap(bubblewrap) {
  const result = spawnSync(bubblewrap, ['--unshare-user-try', '--unshare-net', '--die-with-parent', '--ro-bind', '/', '/', '/bin/true'], { encoding: 'utf8', timeout: 5000 });
  return { available: result.status === 0, backend: 'bubblewrap', status: result.status === 0 ? 'os_sandbox_available' : 'os_sandbox_unavailable', detail: String(result.stderr || result.error?.message || '').trim() };
}

function probeDocker({ docker, image, refresh = false }) {
  const cacheKey = `docker:${docker}:${image}`;
  if (!refresh && PROBE_CACHE.has(cacheKey)) return PROBE_CACHE.get(cacheKey);
  const imageCheck = spawnSync(docker, ['image', 'inspect', image], { encoding: 'utf8', timeout: 15000 });
  if (imageCheck.status !== 0) return { available: false, backend: 'docker', status: 'os_sandbox_unavailable', detail: 'sandbox_image_not_present_locally', image };
  const result = spawnSync(docker, ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 15000 });
  const probe = Object.freeze({ available: result.status === 0, backend: 'docker', status: result.status === 0 ? 'os_sandbox_available' : 'os_sandbox_unavailable', detail: String(result.stderr || result.error?.message || '').trim(), image, readinessCheck: 'image_inspect_and_daemon_info' });
  if (probe.available) PROBE_CACHE.set(cacheKey, probe);
  return probe;
}

export function probeOsSandbox({ bubblewrap = 'bwrap', docker = 'docker', dockerImage = 'alpine:3.20', refresh = false } = {}) {
  const cacheKey = `${bubblewrap}:${docker}:${dockerImage}`;
  if (!refresh && PROBE_CACHE.has(cacheKey)) return PROBE_CACHE.get(cacheKey);
  const bubblewrapProbe = probeBubblewrap(bubblewrap);
  const result = bubblewrapProbe.available ? bubblewrapProbe : { ...probeDocker({ docker, image: dockerImage, refresh }), fallbackReason: bubblewrapProbe.detail || 'bubblewrap_unavailable' };
  if (result.available) PROBE_CACHE.set(cacheKey, Object.freeze(result));
  return result;
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function directoryMerkleHash(root, { excludeRoots = [], excludeNames = [] } = {}) {
  const excluded = excludeRoots.map((candidate) => path.resolve(candidate));
  const names = new Set(excludeNames);
  const records = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (names.has(entry.name)) continue;
      const candidate = path.join(current, entry.name);
      if (excluded.some((blocked) => candidate === blocked || candidate.startsWith(`${blocked}${path.sep}`))) continue;
      const relative = path.relative(root, candidate).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile()) records.push(`${relative}\0${fileSha256Hash(candidate).slice('sha256:'.length)}`);
      else if (entry.isSymbolicLink()) records.push(`${relative}\0link:${fs.readlinkSync(candidate)}`);
    }
  };
  walk(root);
  return `sha256:${crypto.createHash('sha256').update(records.join('\n')).digest('hex')}`;
}

export function fileSha256Hash(candidate) {
  const descriptor = fs.openSync(candidate, 'r');
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${digest.digest('hex')}`;
}

function datasetManifestHash(source) {
  if (!fs.existsSync(source)) return null;
  if (fs.statSync(source).isDirectory()) return directoryMerkleHash(source);
  return fileSha256Hash(source);
}

function mapWorkArgument(argument, sourceRoot) {
  const value = String(argument);
  if (!path.isAbsolute(value)) return value;
  const resolved = path.resolve(value);
  return within(sourceRoot, resolved) ? `/work${resolved.slice(sourceRoot.length)}` : value;
}

function dockerSystemMounts(executable) {
  const mounts = ['/usr', '/bin', '/lib', '/lib64', '/var/lib/texmf', '/etc/texmf']
    .filter((candidate) => fs.existsSync(candidate))
    .flatMap((candidate) => ['--volume', `${candidate}:${candidate}:ro`]);
  const markerIndex = executable.indexOf(`${path.sep}.elan${path.sep}`);
  if (markerIndex >= 0) {
    const elanRoot = executable.slice(0, markerIndex + '/.elan'.length);
    if (fs.existsSync(elanRoot)) mounts.push('--volume', `${elanRoot}:${elanRoot}:ro`);
  }
  return mounts;
}

export function createOsSandboxedWorkerRunner({
  allowedExecutables = [], allowedRoots = [], allowedOutputRoots = [], allowGpu = false, bubblewrap = 'bwrap', prlimit = 'prlimit', docker = 'docker', dockerImage = 'alpine:3.20',
  allowedContainerImages = [], allowedDatasetRoots = [],
  maximumTimeoutMs = 120000, maximumMemoryBytes = 1024 * 1024 * 1024, maximumCpuSeconds = 120, maximumPids = 128,
  executor = spawnSync, probe = null,
} = {}) {
  const executableMap = new Map(allowedExecutables.map((value) => [String(value), resolveExecutable(value)]));
  const executableSet = new Set([...executableMap.values()].filter(Boolean));
  const roots = allowedRoots.map((root) => path.resolve(root));
  const outputRoots = allowedOutputRoots.map((root) => path.resolve(root));
  const datasetRoots = allowedDatasetRoots.map((root) => path.resolve(root));
  const containerImages = new Set(allowedContainerImages.map(String));
  const availability = probe || probeOsSandbox({ bubblewrap, docker, dockerImage });
  const backend = availability.backend || 'bubblewrap';
  const runnerId = `${backend}-kernel-isolation-worker-v3`;
  const capabilities = buildExecutorCapabilities({
    executorId: runnerId,
    sandboxModes: ['kernel-isolated'],
    networkPolicy: 'none',
    workspaceIsolation: true,
    languages: ['*'],
    gpu: allowGpu,
    maximumTimeoutMs,
    receiptKinds: ['OsSandboxWorkerReceipt'],
    provider: backend,
  });

  return assertWorkerRunnerPort({
    version: 3,
    kind: 'OsSandboxedWorkerRunner',
    runnerId,
    capabilities: () => capabilities,
    availability,
    isolation: Object.freeze({ backend, sourceReadOnly: true, ephemeralWorkRoot: true, separateOutputRoot: true, hostEtcMounted: false, userNamespace: backend === 'bubblewrap', mountNamespace: true, pidNamespace: true, networkNamespace: true, readOnlyRuntime: true, memoryLimit: true, cpuLimit: true, processLimit: true }),
    run({ executable, args = [], cwd, sourceRoot = null, timeoutMs = 30000, outputPaths = [], outputDirectory = null, requiresGpu = false, env = {}, containerImage = null, containerExecutable = null, datasetMounts = [], memoryBytes = null, cpuSeconds = null, maximumProcesses = null } = {}) {
      const capabilityPreflight = evaluateExecutorCapabilityRequest({
        capabilities,
        request: { sandbox: 'kernel-isolated', requiresGpu, requiresWorkspaceIsolation: true, requiresNetworkIsolation: true, timeoutMs },
      });
      if (capabilityPreflight.blockers.length) return { ok: false, status: 'os_sandbox_worker_blocked', blockers: capabilityPreflight.blockers, availability, isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false } };
      const selectedImage = containerImage ? String(containerImage) : dockerImage;
      const executionAvailability = containerImage ? probeDocker({ docker, image: selectedImage }) : (availability.available ? availability : probeOsSandbox({ bubblewrap, docker, dockerImage, refresh: true }));
      const executionBackend = containerImage ? 'docker' : (executionAvailability.backend || backend);
      const resolvedExecutable = executableMap.get(String(executable)) || resolveExecutable(executable);
      const resolvedCwd = path.resolve(cwd || '.');
      const allowedRoot = roots.find((root) => within(root, resolvedCwd));
      const resolvedSourceRoot = path.resolve(sourceRoot || allowedRoot || resolvedCwd);
      const blockers = [];
      if (!executionAvailability.available) blockers.push('os_sandbox_runtime_unavailable');
      if (containerImage) {
        if (!containerImages.has(selectedImage)) blockers.push('worker_container_image_not_allowlisted');
        if (!containerExecutable || path.isAbsolute(String(containerExecutable))) blockers.push('worker_container_executable_invalid');
      } else if (!resolvedExecutable || !executableSet.has(resolvedExecutable)) blockers.push('worker_executable_not_allowlisted');
      if (!allowedRoot) blockers.push('worker_cwd_outside_allowed_roots');
      if (!allowedRoot || !within(allowedRoot, resolvedSourceRoot) || !within(resolvedSourceRoot, resolvedCwd)) blockers.push('worker_source_root_invalid');
      if (outputPaths.some((candidate) => path.isAbsolute(String(candidate)) || String(candidate).split(/[\\/]+/).includes('..'))) blockers.push('worker_output_path_not_relative');
      const resolvedOutputDirectory = outputDirectory ? path.resolve(outputDirectory) : null;
      if (outputPaths.length && (!resolvedOutputDirectory || !outputRoots.some((root) => within(root, resolvedOutputDirectory)))) blockers.push('worker_output_directory_not_allowlisted');
      const gpuDevices = fs.existsSync('/dev') ? fs.readdirSync('/dev').filter((name) => /^nvidia(?:\d+|ctl|uvm|uvm-tools|modeset)$/.test(name)).map((name) => `/dev/${name}`) : [];
      if (requiresGpu && (!allowGpu || gpuDevices.length === 0)) blockers.push('worker_gpu_not_available_or_not_allowed');
      const normalizedDatasets = datasetMounts.map((mount, index) => {
        const source = path.resolve(String(mount?.source || ''));
        const name = String(mount?.name || `dataset-${index + 1}`).replace(/[^A-Za-z0-9_.-]/g, '_');
        return { source, target: `/datasets/${name}`, name, readOnly: mount?.readOnly === true, manifestHash: mount?.manifestHash || null, licenseId: mount?.licenseId || null };
      });
      if (normalizedDatasets.some((mount) => !fs.existsSync(mount.source) || !datasetRoots.some((root) => within(root, mount.source)) || !mount.readOnly)) blockers.push('worker_dataset_mount_invalid_or_not_read_only');
      if (normalizedDatasets.some((mount) => !mount.licenseId)) blockers.push('worker_dataset_license_missing');
      if (normalizedDatasets.some((mount) => !mount.manifestHash || datasetManifestHash(mount.source) !== mount.manifestHash)) blockers.push('worker_dataset_manifest_hash_mismatch');
      if (blockers.length) return { ok: false, status: 'os_sandbox_worker_blocked', blockers, availability: executionAvailability, isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false } };

      const sourceDatasetRoots = normalizedDatasets.map((mount) => mount.source).filter((source) => source !== resolvedSourceRoot && within(resolvedSourceRoot, source));
      const sourceExcludedNames = sourceTreeExcludedNames(resolvedSourceRoot);
      const sourceMerkleHashBefore = directoryMerkleHash(resolvedSourceRoot, { excludeRoots: sourceDatasetRoots, excludeNames: sourceExcludedNames });
      const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-os-sandbox-'));
      const workRoot = path.join(sandboxRoot, 'work');
      const outputRoot = path.join(sandboxRoot, 'output');
      const mountedDatasets = normalizedDatasets.map((mount) => {
        if (!fs.statSync(mount.source).isFile()) return { ...mount, bindSource: mount.source, sourceType: 'directory', fileName: null };
        const bindSource = path.join(sandboxRoot, 'datasets', mount.name);
        const fileName = path.basename(mount.source);
        fs.mkdirSync(bindSource, { recursive: true });
        fs.copyFileSync(mount.source, path.join(bindSource, fileName), fs.constants.COPYFILE_FICLONE);
        return { ...mount, bindSource, sourceType: 'file', fileName };
      });
      fs.cpSync(resolvedSourceRoot, workRoot, {
        recursive: true,
        dereference: false,
        filter: (candidate) => {
          if (sourceDatasetRoots.some((blocked) => candidate === blocked || candidate.startsWith(`${blocked}${path.sep}`))) return false;
          const relative = path.relative(resolvedSourceRoot, candidate);
          const first = relative.split(path.sep)[0];
          return !sourceExcludedNames.includes(first);
        },
      });
      fs.mkdirSync(outputRoot, { recursive: true });
      const relativeCwd = path.relative(resolvedSourceRoot, resolvedCwd);
      const boundedTimeout = Math.max(1, Math.min(Number(timeoutMs || 30000), maximumTimeoutMs));
      const boundedMemory = Math.max(64 * 1024 * 1024, Math.min(Number(memoryBytes || maximumMemoryBytes), maximumMemoryBytes));
      const boundedCpu = Math.max(1, Math.min(Number(cpuSeconds || maximumCpuSeconds), maximumCpuSeconds));
      const boundedPids = Math.max(8, Math.min(Number(maximumProcesses || maximumPids), maximumPids));
      const permittedEnvironment = Object.entries(env).filter(([key]) => ['ELAN_HOME', 'ELAN_TOOLCHAIN', 'LEAN_PATH', 'LAKE_HOME', 'HEPTA_SEED', 'HEPTA_OUTPUT_DIR', 'PYTHONHASHSEED', 'OMP_NUM_THREADS', 'CUDA_VISIBLE_DEVICES', 'R_ENVIRON_USER', 'RENV_PATHS_CACHE'].includes(key) || key.startsWith('HEPTA_DATASET_'));
      let launcher = prlimit;
      let command = [
        `--as=${boundedMemory}`, `--cpu=${boundedCpu}`, bubblewrap,
        '--unshare-user-try', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--unshare-net', '--die-with-parent', '--new-session',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
        ...(fs.existsSync('/var/lib/texmf') ? ['--ro-bind', '/var/lib/texmf', '/var/lib/texmf'] : []),
        ...(fs.existsSync('/etc/texmf') ? ['--ro-bind', '/etc/texmf', '/etc/texmf'] : []),
        '--ro-bind', resolvedSourceRoot, '/source', '--bind', workRoot, '/work', '--bind', outputRoot, '/output', '--chdir', `/work${relativeCwd ? `/${relativeCwd}` : ''}`,
        ...mountedDatasets.flatMap((mount) => ['--ro-bind', mount.bindSource, mount.target]),
        ...(requiresGpu ? gpuDevices.flatMap((device) => ['--dev-bind', device, device]) : []),
        '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', ...permittedEnvironment.flatMap(([key, value]) => ['--setenv', key, String(value)]), resolvedExecutable, ...args.map((argument) => mapWorkArgument(argument, resolvedSourceRoot)),
      ];
      if (executionBackend === 'docker') {
        launcher = docker;
        const uid = typeof process.getuid === 'function' ? process.getuid() : 65534;
        const gid = typeof process.getgid === 'function' ? process.getgid() : 65534;
        const dockerExecutable = !containerImage && within(resolvedSourceRoot, resolvedExecutable)
          ? `/work${resolvedExecutable.slice(resolvedSourceRoot.length)}`
          : (containerImage ? containerExecutable : resolvedExecutable);
        command = [
          'run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--memory', String(boundedMemory), '--cpus', '1', '--pids-limit', String(boundedPids), '--ulimit', `cpu=${boundedCpu}`,
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--user', `${uid}:${gid}`, '--env', 'HOME=/tmp', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
          ...permittedEnvironment.flatMap(([key, value]) => ['--env', `${key}=${String(value)}`]),
          ...(requiresGpu ? ['--runtime', 'nvidia', '--env', 'NVIDIA_VISIBLE_DEVICES=all', '--env', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility'] : []), ...(containerImage ? [] : dockerSystemMounts(resolvedExecutable)),
          '--volume', `${resolvedSourceRoot}:/source:ro`, '--volume', `${workRoot}:/work:rw`, '--volume', `${outputRoot}:/output:rw`,
          ...mountedDatasets.flatMap((mount) => ['--volume', `${mount.bindSource}:${mount.target}:ro`]),
          '--workdir', `/work${relativeCwd ? `/${relativeCwd}` : ''}`, selectedImage, dockerExecutable,
          ...args.map((argument) => mapWorkArgument(argument, resolvedSourceRoot)),
        ];
      }

      let result;
      try {
        result = executor(launcher, command, { encoding: 'utf8', timeout: boundedTimeout, maxBuffer: 4 * 1024 * 1024 });
      } finally {
        // Hash the immutable source while the ephemeral work/output roots still exist.
      }
      const sourceMerkleHashAfter = directoryMerkleHash(resolvedSourceRoot, { excludeRoots: sourceDatasetRoots, excludeNames: sourceExcludedNames });
      const sourceMutationDetected = sourceMerkleHashAfter !== sourceMerkleHashBefore;
      const commandPassed = result.status === 0 && !result.error;
      const passed = commandPassed && !sourceMutationDetected;
      const artifacts = [];
      if (passed && resolvedOutputDirectory) {
        fs.mkdirSync(resolvedOutputDirectory, { recursive: true });
        for (const declared of outputPaths.map(String)) {
          const source = [path.join(outputRoot, declared), path.join(workRoot, declared)].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
          if (!source) continue;
          const destination = path.join(resolvedOutputDirectory, declared);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(source, destination);
          artifacts.push({ path: declared, sha256: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')}`, bytes: fs.statSync(destination).size });
        }
      }
      const receiptPayload = {
        version: 3,
        kind: 'OsSandboxWorkerReceipt',
        runnerId: `${executionBackend}-kernel-isolation-worker-v3`,
        backend: executionBackend,
        status: passed ? 'os_sandbox_worker_passed' : 'os_sandbox_worker_failed',
        exitCode: result.status,
        signal: result.signal || null,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || result.error?.message || ''),
        sourceMerkleHashBefore,
        sourceMerkleHashAfter,
        sourceMutationDetected,
        declaredOutputPaths: outputPaths.map(String),
        limits: { timeoutMs: boundedTimeout, memoryBytes: boundedMemory, cpuSeconds: boundedCpu, maximumPids: boundedPids },
        containerImage: containerImage ? selectedImage : null,
        datasetMounts: mountedDatasets.map((mount) => ({ name: mount.name, target: mount.target, sourceType: mount.sourceType, fileName: mount.fileName, readOnly: true, manifestHash: mount.manifestHash, licenseId: mount.licenseId })),
        isolation: { kernelNetworkIsolationVerified: true, filesystemNamespaceVerified: true, sourceReadOnlyVerified: !sourceMutationDetected, sourceReadOnlyMount: true, ephemeralWorkRootVerified: true, separateOutputRootVerified: true, hostEtcMounted: false, readOnlyRuntimeVerified: true, resourceLimitsVerified: true, gpuAccessRequested: Boolean(requiresGpu), gpuDeviceIsolationVerified: !requiresGpu || gpuDevices.length > 0 },
        externalActionPerformed: false,
      };
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
      return { ok: passed, ...receiptPayload, artifacts, receiptHash: hashRecord('OsSandboxWorkerReceipt', receiptPayload), blockers: [...(!commandPassed ? ['os_sandbox_command_failed'] : []), ...(sourceMutationDetected ? ['source_mutation_detected'] : [])] };
    },
  });
}
