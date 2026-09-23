import { spawnSync } from 'node:child_process';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OCI_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';

function invoke(spawnProcess, executable, args, timeout) {
  try {
    return spawnProcess(executable, args, { encoding: 'utf8', timeout });
  } catch (error) {
    return { status: null, stdout: '', stderr: String(error?.message || error), error };
  }
}

export function buildAcademicDockerOperationalEnvironment(environment = {}) {
  const operationalEnvironment = {
    ...environment,
    HEPTA_ACADEMIC_DOCKER_OPERATIONAL_MODE: 'strict',
  };
  delete operationalEnvironment.HEPTA_SUPERVISOR_TEST_LANGUAGE;
  return Object.freeze(operationalEnvironment);
}

export function inspectAcademicDockerOperationalPrerequisites({
  runtimeImages,
  dockerExecutable = 'docker',
  spawnProcess = spawnSync,
  timeoutMs = 15_000,
} = {}) {
  const profiles = Object.entries(runtimeImages || {}).map(([language, runtime]) => ({
    language,
    image: String(runtime?.image || ''),
    expectedDigest: String(runtime?.imageDigest || '').toLowerCase(),
  }));
  const blockers = [];
  if (profiles.length !== 2) blockers.push('academic_docker_operational_two_runtime_profiles_required');
  for (const profile of profiles) {
    if (!profile.image || !SHA256.test(profile.expectedDigest)) {
      blockers.push(`academic_docker_operational_runtime_profile_invalid:${profile.language}`);
    }
  }

  const daemonProbe = invoke(
    spawnProcess,
    dockerExecutable,
    ['info', '--format', '{{.ServerVersion}}'],
    timeoutMs,
  );
  const daemonAvailable = daemonProbe.status === 0 && Boolean(String(daemonProbe.stdout || '').trim());
  if (!daemonAvailable) blockers.push('academic_docker_operational_daemon_unavailable');

  const images = profiles.map((profile) => {
    const inspection = daemonAvailable && profile.image
      ? invoke(
        spawnProcess,
        dockerExecutable,
        ['image', 'inspect', profile.image],
        timeoutMs,
      )
      : { status: null, stdout: '', stderr: '' };
    let document = null;
    try {
      const parsed = JSON.parse(String(inspection.stdout || ''));
      document = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
    } catch { document = null; }
    const observedDigest = String(document?.Descriptor?.digest || '').trim().toLowerCase() || null;
    const present = inspection.status === 0 && SHA256.test(String(observedDigest || ''))
      && document?.Descriptor?.mediaType === OCI_MANIFEST_MEDIA_TYPE
      && document?.Os === 'linux' && document?.Architecture === 'amd64';
    const digestMatches = present && observedDigest === profile.expectedDigest;
    if (daemonAvailable && !present) blockers.push(`academic_docker_operational_pinned_image_missing:${profile.language}`);
    else if (daemonAvailable && !digestMatches) blockers.push(`academic_docker_operational_pinned_image_digest_mismatch:${profile.language}`);
    return Object.freeze({ ...profile, observedDigest, present, digestMatches });
  });

  const uniqueBlockers = [...new Set(blockers)];
  return Object.freeze({
    version: 1,
    kind: 'AcademicDockerOperationalPrerequisiteReport',
    status: uniqueBlockers.length
      ? 'academic_docker_operational_prerequisites_blocked'
      : 'academic_docker_operational_prerequisites_ready',
    dockerExecutable,
    daemonAvailable,
    daemonVersion: daemonAvailable ? String(daemonProbe.stdout || '').trim() : null,
    images: Object.freeze(images),
    blockers: Object.freeze(uniqueBlockers),
  });
}
