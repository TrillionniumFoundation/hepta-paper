#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES } from '../../paper-domain/automation/dataset-access-supervisor-policy.mjs';
import {
  buildAcademicDockerOperationalEnvironment,
  inspectAcademicDockerOperationalPrerequisites,
} from '../src/academic-docker-operational-prerequisites.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeImages = Object.freeze({
  python: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python,
  r: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.r,
});
const prerequisites = inspectAcademicDockerOperationalPrerequisites({ runtimeImages });
process.stdout.write(`${JSON.stringify(prerequisites, null, 2)}\n`);

if (prerequisites.status !== 'academic_docker_operational_prerequisites_ready') {
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, [
    '--test',
    '--test-concurrency=1',
    '--test-name-pattern=^academic-docker-operational:',
    'paper-core/tests/docker-dataset-access-supervisor.test.mjs',
  ], {
    cwd: workspaceRoot,
    env: buildAcademicDockerOperationalEnvironment(process.env),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
