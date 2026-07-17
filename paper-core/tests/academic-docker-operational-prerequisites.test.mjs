import assert from 'node:assert/strict';
import test from 'node:test';
import { SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES } from '../../paper-domain/automation/dataset-access-supervisor-policy.mjs';
import {
  buildAcademicDockerOperationalEnvironment,
  inspectAcademicDockerOperationalPrerequisites,
} from '../src/academic-docker-operational-prerequisites.mjs';

const runtimeImages = Object.freeze({
  python: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python,
  r: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.r,
});

function inspectedImage(digest, { mediaType = 'application/vnd.oci.image.manifest.v1+json' } = {}) {
  return {
    status: 0,
    stdout: JSON.stringify([{
      Id: `sha256:${'0'.repeat(64)}`,
      Descriptor: { digest, mediaType },
      Os: 'linux',
      Architecture: 'amd64',
    }]),
    stderr: '',
  };
}

function dockerFixture({
  daemon = { status: 0, stdout: '27.5.1\n', stderr: '' },
  images = {},
} = {}) {
  const calls = [];
  const spawnProcess = (executable, args, options) => {
    calls.push({ executable, args: [...args], options: { ...options } });
    if (args[0] === 'info') return daemon;
    const image = args.at(-1);
    return images[image] || { status: 1, stdout: '', stderr: 'not found' };
  };
  return { calls, spawnProcess };
}

test('academic Docker prerequisites fail closed when the daemon is unavailable', () => {
  const docker = dockerFixture({ daemon: { status: 1, stdout: '', stderr: 'offline' } });
  const report = inspectAcademicDockerOperationalPrerequisites({
    runtimeImages,
    spawnProcess: docker.spawnProcess,
  });
  assert.equal(report.status, 'academic_docker_operational_prerequisites_blocked');
  assert.deepEqual(report.blockers, ['academic_docker_operational_daemon_unavailable']);
  assert.equal(report.daemonAvailable, false);
  assert.equal(docker.calls.length, 1);
});

test('academic Docker prerequisites report each missing pinned image', () => {
  const docker = dockerFixture();
  const report = inspectAcademicDockerOperationalPrerequisites({
    runtimeImages,
    spawnProcess: docker.spawnProcess,
  });
  assert.deepEqual(report.blockers, [
    'academic_docker_operational_pinned_image_missing:python',
    'academic_docker_operational_pinned_image_missing:r',
  ]);
  assert.ok(report.images.every((image) => image.present === false));
});

test('academic Docker prerequisites reject an observed digest mismatch', () => {
  const docker = dockerFixture({ images: {
    [runtimeImages.python.image]: {
      ...inspectedImage(runtimeImages.python.imageDigest),
    },
    [runtimeImages.r.image]: inspectedImage(`sha256:${'f'.repeat(64)}`),
  } });
  const report = inspectAcademicDockerOperationalPrerequisites({
    runtimeImages,
    spawnProcess: docker.spawnProcess,
  });
  assert.deepEqual(report.blockers, [
    'academic_docker_operational_pinned_image_digest_mismatch:r',
  ]);
  assert.equal(report.images.find((image) => image.language === 'python').digestMatches, true);
  assert.equal(report.images.find((image) => image.language === 'r').digestMatches, false);
});

test('academic Docker prerequisites accept both exact pinned image digests', () => {
  const docker = dockerFixture({ images: Object.fromEntries(
    Object.values(runtimeImages).map((runtime) => [runtime.image, {
      ...inspectedImage(runtime.imageDigest),
    }]),
  ) });
  const report = inspectAcademicDockerOperationalPrerequisites({
    runtimeImages,
    spawnProcess: docker.spawnProcess,
  });
  assert.equal(report.status, 'academic_docker_operational_prerequisites_ready');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.daemonVersion, '27.5.1');
  assert.ok(report.images.every((image) => image.present && image.digestMatches));
  assert.ok(docker.calls.every((call) => call.executable === 'docker'));
});

test('strict academic Docker gate clears developer-only language filtering', () => {
  const source = {
    KEEP_ME: 'yes',
    HEPTA_ACADEMIC_DOCKER_OPERATIONAL_MODE: 'diagnostic',
    HEPTA_SUPERVISOR_TEST_LANGUAGE: 'python',
  };
  const environment = buildAcademicDockerOperationalEnvironment(source);
  assert.equal(environment.KEEP_ME, 'yes');
  assert.equal(environment.HEPTA_ACADEMIC_DOCKER_OPERATIONAL_MODE, 'strict');
  assert.equal(environment.HEPTA_SUPERVISOR_TEST_LANGUAGE, undefined);
  assert.equal(source.HEPTA_SUPERVISOR_TEST_LANGUAGE, 'python');
  assert.equal(Object.isFrozen(environment), true);
});
