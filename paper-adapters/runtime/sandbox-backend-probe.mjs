import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  SYSTEM_DATASET_ACCESS_SUPERVISOR,
  trustedSystemDatasetAccessRuntimeImageByDigest,
} from '../../paper-domain/automation/dataset-access-supervisor-policy.mjs';
import { DATASET_ACCESS_SUPERVISOR_TRACER } from './dataset-runtime-access-receipt.mjs';
import {
  createDockerDatasetSupervisorProbeWorkspace,
  readDockerDatasetSupervisorProbeEvidence,
  removeDockerDatasetSupervisorProbeWorkspace,
} from './docker-dataset-supervisor-probe-repository.mjs';
import { restrictedChildEnvironment } from '../automation/bounded-child-process.mjs';

const PROBE_CACHE = new Map();
const OCI_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const OCI_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const GENERIC_MANIFEST_MEDIA_TYPES = new Set([
  OCI_MANIFEST_MEDIA_TYPE,
  OCI_INDEX_MEDIA_TYPE,
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const LOCAL_DOCKER_HOST = 'unix:///var/run/docker.sock';

function controlledProbeEnvironment(environment, { docker = false } = {}) {
  if (environment?.DOCKER_CONTEXT
    || (environment?.DOCKER_HOST && environment.DOCKER_HOST !== LOCAL_DOCKER_HOST)) {
    throw new Error('sandbox_remote_docker_endpoint_forbidden');
  }
  return restrictedChildEnvironment({
    source: environment,
    overrides: docker ? { DOCKER_HOST: LOCAL_DOCKER_HOST } : {},
  });
}

export function dockerManifestMediaTypeAccepted(mediaType, { canonicalOci = false } = {}) {
  return canonicalOci
    ? mediaType === OCI_MANIFEST_MEDIA_TYPE
    : GENERIC_MANIFEST_MEDIA_TYPES.has(String(mediaType || ''));
}
export function resolveExecutableInvocationPath(executable, {
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const value = String(executable || '');
  if (!value) return null;
  if (path.isAbsolute(value)) return path.resolve(value);
  const located = spawnSyncImpl('which', [value], {
    encoding: 'utf8', timeout: 3000,
    env: { ...controlledProbeEnvironment(environment) },
  });
  const candidate = String(located.stdout || '').trim();
  if (!candidate) return null;
  return path.resolve(candidate);
}

export function resolveExecutable(executable, options = {}) {
  const candidate = resolveExecutableInvocationPath(executable, options);
  if (!candidate) return null;
  try { return fs.realpathSync(candidate); } catch { return candidate; }
}

export function probeProcessLimit(prlimit, {
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const childEnvironment = controlledProbeEnvironment(environment);
  const cacheKey = `prlimit-nproc:${prlimit}`;
  const cacheAllowed = spawnSyncImpl === spawnSync;
  if (cacheAllowed && PROBE_CACHE.has(cacheKey)) return PROBE_CACHE.get(cacheKey);
  const resolved = resolveExecutable(prlimit, { spawnSyncImpl, environment });
  if (!resolved || (typeof process.geteuid === 'function' && process.geteuid() === 0)) {
    const unavailable = Object.freeze({ available: false, mechanism: 'rlimit-nproc', executable: resolved, detail: resolved ? 'rlimit_nproc_not_enforced_for_root' : 'prlimit_not_found' });
    if (cacheAllowed) PROBE_CACHE.set(cacheKey, unavailable);
    return unavailable;
  }
  const result = spawnSyncImpl(resolved, ['--nproc=17:17', '--', resolved, '--nproc', '--noheadings', '--output', 'SOFT,HARD'], {
    encoding: 'utf8', timeout: 3000,
    env: { ...childEnvironment },
  });
  const available = result.status === 0 && /^17\s+17$/.test(String(result.stdout || '').trim());
  const probe = Object.freeze({
    available,
    mechanism: 'rlimit-nproc',
    executable: resolved,
    detail: available ? 'kernel_rlimit_nproc_verified' : String(result.stderr || result.error?.message || 'rlimit_nproc_probe_failed').trim(),
  });
  if (cacheAllowed) PROBE_CACHE.set(cacheKey, probe);
  return probe;
}

function probeBubblewrap(bubblewrap, prlimit, { spawnSyncImpl, environment }) {
  const result = spawnSyncImpl(bubblewrap, ['--unshare-user-try', '--unshare-net', '--die-with-parent', '--ro-bind', '/', '/', '/bin/true'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...controlledProbeEnvironment(environment) },
  });
  const processLimit = probeProcessLimit(prlimit, { spawnSyncImpl, environment });
  const available = result.status === 0 && processLimit.available;
  return {
    available,
    backend: 'bubblewrap',
    status: available ? 'os_sandbox_available' : 'os_sandbox_unavailable',
    detail: result.status === 0 ? processLimit.detail : String(result.stderr || result.error?.message || '').trim(),
    processLimit,
  };
}

function executableFileAvailable(candidate) {
  try {
    const stat = fs.statSync(candidate);
    fs.accessSync(candidate, fs.constants.X_OK);
    return stat.isFile();
  } catch {
    return false;
  }
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function inspectDockerManifest(docker, image, {
  canonicalOci = false,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  const inspection = spawnSyncImpl(docker, ['image', 'inspect', image], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    env: { ...controlledProbeEnvironment(environment, { docker: true }) },
  });
  let document = null;
  try {
    const parsed = JSON.parse(String(inspection.stdout || ''));
    document = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  } catch { document = null; }
  const digest = normalizeContainerImageDigest(document?.Descriptor?.digest);
  const mediaType = String(document?.Descriptor?.mediaType || '');
  const mediaTypeVerified = dockerManifestMediaTypeAccepted(mediaType, { canonicalOci });
  const platformVerified = document?.Os === 'linux' && document?.Architecture === 'amd64';
  return Object.freeze({
    document,
    digest,
    mediaType,
    available: inspection.status === 0 && Boolean(digest)
      && mediaTypeVerified && platformVerified,
  });
}

function probeTrustedDockerDatasetSupervisor({ docker, profile, spawnSyncImpl, environment }) {
  const image = String(profile?.image || '');
  const expectedImageDigest = normalizeContainerImageDigest(profile?.imageDigest);
  const executable = String(profile?.containerExecutable || '');
  const supervisor = profile?.supervisor || null;
  const systemImage = trustedSystemDatasetAccessRuntimeImageByDigest(expectedImageDigest);
  if (!image || !expectedImageDigest || !systemImage
    || image !== systemImage.image || executable !== systemImage.containerExecutable
    || supervisor?.version !== 1
    || supervisor.protocol !== SYSTEM_DATASET_ACCESS_SUPERVISOR.protocol
    || supervisor.path !== SYSTEM_DATASET_ACCESS_SUPERVISOR.path
    || supervisor.sha256 !== SYSTEM_DATASET_ACCESS_SUPERVISOR.sha256
    || supervisor.workloadUid !== SYSTEM_DATASET_ACCESS_SUPERVISOR.workloadUid) {
    return Object.freeze({ image, available: false, detail: 'trusted_dataset_supervisor_profile_invalid' });
  }
  const manifestInspection = inspectDockerManifest(docker, image, {
    canonicalOci: true, spawnSyncImpl, environment,
  });
  const imageDocument = manifestInspection.document;
  const observedImageDigest = manifestInspection.digest;
  if (!manifestInspection.available || observedImageDigest !== expectedImageDigest) {
    return Object.freeze({ image, expectedImageDigest, observedImageDigest, available: false, detail: 'trusted_dataset_supervisor_image_digest_mismatch' });
  }
  const labels = imageDocument?.Config?.Labels || {};
  if (labels['io.hepta.dataset-supervisor.protocol'] !== supervisor.protocol
    || labels['io.hepta.dataset-supervisor.sha256'] !== supervisor.sha256) {
    return Object.freeze({ image, expectedImageDigest, observedImageDigest, available: false, detail: 'trusted_dataset_supervisor_image_label_mismatch' });
  }
  const workspace = createDockerDatasetSupervisorProbeWorkspace();
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 65534;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 65534;
    const pythonProbe = `import os,pathlib\ncontent=pathlib.Path('/datasets/probe').read_bytes()\ndenied=False\ntry: pathlib.Path('/hepta-supervisor/dataset-access.trace').write_text('FORGED')\nexcept PermissionError: denied=True\nstatus=pathlib.Path('/proc/self/status').read_text().splitlines()\ncap=next(x.split()[1] for x in status if x.startswith('CapEff:'))\npathlib.Path('/output/probe.txt').write_text(f'bytes={len(content)}\\nuid={os.getuid()}\\ntrace_overwrite_denied={str(denied).lower()}\\ncap_eff={cap}\\n')`;
    const rProbe = `x <- readBin('/datasets/probe', 'raw', n=file.info('/datasets/probe')$size); denied <- inherits(try(writeLines('FORGED', '/hepta-supervisor/dataset-access.trace'), silent=TRUE), 'try-error'); status <- readLines('/proc/self/status'); cap <- sub('^CapEff:[[:space:]]*', '', status[grepl('^CapEff:', status)]); uid <- as.integer(strsplit(sub('^Uid:[[:space:]]*', '', status[grepl('^Uid:', status)]), '[[:space:]]+')[[1]][1]); writeLines(sprintf('bytes=%d\\nuid=%d\\ntrace_overwrite_denied=%s\\ncap_eff=%s', length(x), uid, tolower(as.character(denied)), cap), '/output/probe.txt')`;
    const result = spawnSyncImpl(docker, [
      'run', '--pull', 'never', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--cap-add', 'SYS_PTRACE', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'SETPCAP', '--cap-add', 'DAC_OVERRIDE',
      '--security-opt', 'no-new-privileges', '--memory', '256m', '--cpus', '1', '--pids-limit', '64', '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
      '--volume', `${workspace.datasetPath}:/datasets/probe:ro`, '--volume', `${workspace.outputRoot}:/output:rw`, '--volume', `${workspace.supervisorRoot}:/hepta-supervisor:rw`,
      expectedImageDigest,
      supervisor.path,
      '--expected-supervisor-sha256', supervisor.sha256,
      '--trace-owner-uid', String(uid), '--trace-owner-gid', String(gid),
      '--workload-uid', String(supervisor.workloadUid), '--workload-gid', String(gid), '--',
      executable, ...(executable === 'python3' ? ['-c', pythonProbe] : ['-e', rProbe]),
    ], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      env: { ...controlledProbeEnvironment(environment, { docker: true }) },
    });
    if (result.status !== 0) {
      return Object.freeze({ image, expectedImageDigest, observedImageDigest, available: false, detail: `trusted_dataset_supervisor_probe_failed:${String(result.stderr || result.error?.message || '').trim().slice(-512)}` });
    }
    const { outputIdentity, output, traceIdentity, identityIdentity, trace, identity } = readDockerDatasetSupervisorProbeEvidence(workspace);
    const verified = outputIdentity.uid === supervisor.workloadUid
      && output.includes(`uid=${supervisor.workloadUid}\n`)
      && output.includes('trace_overwrite_denied=true\n')
      && output.includes('cap_eff=0000000000000000\n')
      && /read\([^\n]*<\/datasets\/probe>/.test(trace)
      && /\/hepta-supervisor\/dataset-access\.trace[^\n]*EACCES/.test(trace)
      && traceIdentity.uid === uid && traceIdentity.gid === gid && (traceIdentity.mode & 0o777) === 0o600 && traceIdentity.nlink === 1
      && identityIdentity.uid === uid && identityIdentity.gid === gid && (identityIdentity.mode & 0o777) === 0o600 && identityIdentity.nlink === 1
      && identity.version === '1'
      && identity.protocol === supervisor.protocol
      && identity.supervisor_sha256 === supervisor.sha256
      && identity.tracer_sha256 === systemImage.tracerSha256
      && identity.setpriv_sha256 === systemImage.setprivSha256
      && identity.trace_sha256 === sha256(Buffer.from(trace))
      && Number(identity.trace_bytes) === Buffer.byteLength(trace)
      && Number(identity.trace_owner_uid) === uid && Number(identity.trace_owner_gid) === gid
      && Number(identity.workload_uid) === supervisor.workloadUid && Number(identity.workload_gid) === gid
      && Number(identity.workload_exit_code) === 0;
    return Object.freeze({
      image,
      expectedImageDigest,
      observedImageDigest,
      supervisorProtocol: supervisor.protocol,
      supervisorSha256: supervisor.sha256,
      available: verified,
      detail: verified ? 'trusted_dataset_supervisor_end_to_end_verified' : 'trusted_dataset_supervisor_evidence_mismatch',
    });
  } catch (error) {
    return Object.freeze({ image, expectedImageDigest, observedImageDigest, available: false, detail: `trusted_dataset_supervisor_probe_error:${error?.code || error?.message || 'unknown'}` });
  } finally {
    removeDockerDatasetSupervisorProbeWorkspace(workspace);
  }
}

export function probeTrustedDockerDatasetSupervisors({
  docker = 'docker', profiles = [], refresh = false,
  spawnSyncImpl = spawnSync, environment = process.env,
} = {}) {
  controlledProbeEnvironment(environment, { docker: true });
  const cacheKey = `dataset-supervisor:${docker}:${JSON.stringify(profiles)}`;
  const cacheAllowed = spawnSyncImpl === spawnSync;
  if (cacheAllowed && !refresh && PROBE_CACHE.has(cacheKey)) return PROBE_CACHE.get(cacheKey);
  const results = profiles.map((profile) => probeTrustedDockerDatasetSupervisor({
    docker, profile, spawnSyncImpl, environment,
  }));
  const available = results.length > 0 && results.every((result) => result.available);
  const probe = Object.freeze({
    available,
    backend: available ? 'docker' : null,
    status: available ? 'academic_empirical_dataset_supervisor_available' : 'academic_empirical_dataset_supervisor_unavailable',
    detail: available ? 'all_trusted_dataset_supervisors_end_to_end_verified' : results.find((result) => !result.available)?.detail || 'trusted_dataset_supervisor_profiles_missing',
    results: Object.freeze(results),
  });
  if (cacheAllowed && available) PROBE_CACHE.set(cacheKey, probe);
  return probe;
}

export function evaluateAcademicEmpiricalReadiness({
  bubblewrapProbe = null,
  datasetAccessTracer = DATASET_ACCESS_SUPERVISOR_TRACER,
  dockerSupervisorProbe = null,
} = {}) {
  const bubblewrapReady = bubblewrapProbe?.available === true && bubblewrapProbe?.backend === 'bubblewrap';
  const datasetAccessTracerReady = executableFileAvailable(datasetAccessTracer);
  const bubblewrapDatasetProofReady = bubblewrapReady && datasetAccessTracerReady;
  const dockerDatasetProofReady = dockerSupervisorProbe?.available === true && dockerSupervisorProbe?.backend === 'docker';
  const academicEmpiricalReady = bubblewrapDatasetProofReady || dockerDatasetProofReady;
  const academicEmpiricalReadinessReason = academicEmpiricalReady
    ? 'academic_empirical_dataset_access_ready'
    : bubblewrapReady && !datasetAccessTracerReady
      ? 'academic_empirical_dataset_access_tracer_unavailable'
      : dockerSupervisorProbe?.detail && dockerSupervisorProbe.detail !== 'trusted_dataset_supervisor_profiles_missing'
        ? dockerSupervisorProbe.detail
        : 'academic_empirical_bubblewrap_backend_unavailable';
  return Object.freeze({
    academicEmpiricalReady,
    academicEmpiricalReadinessReason,
    academicEmpiricalReadinessDetail: academicEmpiricalReady
      ? (dockerDatasetProofReady ? dockerSupervisorProbe.detail : 'bubblewrap_and_host_supervisor_tracer_verified')
      : `${String(bubblewrapProbe?.detail || 'bubblewrap_unavailable')};${String(dockerSupervisorProbe?.detail || 'docker_supervisor_unavailable')}`,
    academicEmpiricalDatasetProofBackend: dockerDatasetProofReady
      ? 'docker-trusted-container-supervisor-v1'
      : bubblewrapDatasetProofReady ? 'bubblewrap-host-supervised-strace-v2' : null,
    datasetAccessTracer,
    datasetAccessTracerReady,
    dockerDatasetSupervisorReady: dockerDatasetProofReady,
    dockerDatasetSupervisorProbe: dockerSupervisorProbe,
  });
}

export function probeDocker({
  docker, image, refresh = false,
  spawnSyncImpl = spawnSync, environment = process.env,
}) {
  controlledProbeEnvironment(environment, { docker: true });
  const cacheKey = `docker:${docker}:${image}`;
  const cacheAllowed = spawnSyncImpl === spawnSync;
  if (cacheAllowed && !refresh && PROBE_CACHE.has(cacheKey)) return PROBE_CACHE.get(cacheKey);
  const imageInspection = inspectDockerManifest(docker, image, { spawnSyncImpl, environment });
  const imageDigest = imageInspection.available ? imageInspection.digest : null;
  if (!imageDigest) return { available: false, backend: 'docker', status: 'os_sandbox_unavailable', detail: 'sandbox_image_not_present_locally', image, imageDigest: null };
  const result = spawnSyncImpl(docker, ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...controlledProbeEnvironment(environment, { docker: true }) },
  });
  const probe = Object.freeze({ available: result.status === 0, backend: 'docker', status: result.status === 0 ? 'os_sandbox_available' : 'os_sandbox_unavailable', detail: String(result.stderr || result.error?.message || '').trim(), image, imageDigest, readinessCheck: 'image_identity_and_daemon_info' });
  if (cacheAllowed && probe.available) PROBE_CACHE.set(cacheKey, probe);
  return probe;
}

export function inspectDockerImageDigest(docker, image, options = {}) {
  const inspection = inspectDockerManifest(docker, image, options);
  return inspection.available ? inspection.digest : null;
}

export function normalizeContainerImageDigest(value) {
  const digest = String(value || '').trim().toLowerCase();
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
}

export function probeDockerDaemon({
  docker, image, spawnSyncImpl = spawnSync, environment = process.env,
}) {
  const result = spawnSyncImpl(docker, ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...controlledProbeEnvironment(environment, { docker: true }) },
  });
  return Object.freeze({
    available: result.status === 0,
    backend: 'docker',
    status: result.status === 0 ? 'os_sandbox_available' : 'os_sandbox_unavailable',
    detail: String(result.stderr || result.error?.message || '').trim(),
    image,
    readinessCheck: 'resolved_image_identity_and_daemon_info',
  });
}

export function probeOsSandbox({
  bubblewrap = 'bwrap',
  prlimit = 'prlimit',
  docker = 'docker',
  dockerImage = 'alpine:3.20',
  datasetAccessTracer = DATASET_ACCESS_SUPERVISOR_TRACER,
  trustedDatasetSupervisorImages = [],
  refresh = false,
  spawnSyncImpl = spawnSync,
  environment = process.env,
} = {}) {
  controlledProbeEnvironment(environment, { docker: true });
  const cacheKey = `${bubblewrap}:${prlimit}:${docker}:${dockerImage}:${datasetAccessTracer}:${JSON.stringify(trustedDatasetSupervisorImages)}`;
  const cacheAllowed = spawnSyncImpl === spawnSync;
  if (cacheAllowed && !refresh && PROBE_CACHE.has(cacheKey)) return PROBE_CACHE.get(cacheKey);
  const bubblewrapProbe = probeBubblewrap(bubblewrap, prlimit, {
    spawnSyncImpl, environment,
  });
  const selectedBackend = bubblewrapProbe.available
    ? bubblewrapProbe
    : { ...probeDocker({
      docker, image: dockerImage, refresh, spawnSyncImpl, environment,
    }), fallbackReason: bubblewrapProbe.detail || 'bubblewrap_unavailable' };
  const dockerSupervisorProbe = bubblewrapProbe.available ? null : probeTrustedDockerDatasetSupervisors({
    docker,
    profiles: trustedDatasetSupervisorImages,
    refresh,
    spawnSyncImpl,
    environment,
  });
  const result = Object.freeze({
    ...selectedBackend,
    ...evaluateAcademicEmpiricalReadiness({ bubblewrapProbe, datasetAccessTracer, dockerSupervisorProbe }),
  });
  if (cacheAllowed && result.available) PROBE_CACHE.set(cacheKey, result);
  return result;
}
