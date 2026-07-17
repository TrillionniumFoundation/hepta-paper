import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspectReleaseState } from '../src/release-state-contract.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package-lock.json'), 'utf8'));

const documents = (version, state = 'development') => state === 'development' ? {
  currentStatus: `This is the normative status for the unreleased v${version} development candidate.`,
  releaseDocument: `Version ${version} is an unreleased candidate.`,
  changelog: `## Unreleased (${version} development)`,
} : {
  currentStatus: `This is the normative status for the v${version} architecture release.`,
  releaseDocument: `Version ${version} is the current release.`,
  changelog: `## ${version}`,
};

const input = ({ version = '0.21.0', state = 'development', headTags = [], allTags = [] } = {}) => ({
  packageJson: {
    name: 'hepta-paper-workspace',
    version,
    engines: { node: '>=22.23.1 <23' },
    packageManager: 'npm@10.9.8',
  },
  packageLock: {
    name: 'hepta-paper-workspace',
    version,
    packages: { '': { name: 'hepta-paper-workspace', version } },
  },
  ...documents(version, state),
  headTags,
  allTags,
});

test('development candidate is consistent when its version has not been tagged', () => {
  assert.deepEqual(inspectReleaseState(input({ allTags: ['v0.20.4'] })).errors, []);
});

test('tagged release requires released documentation and untagged candidate rejects a reused tag', () => {
  assert.deepEqual(inspectReleaseState(input({
    state: 'released',
    headTags: ['v0.21.0'],
    allTags: ['v0.21.0'],
  })).errors, []);
  assert.deepEqual(inspectReleaseState(input({ allTags: ['v0.21.0'] })).errors, [
    'development_version_tag_already_exists',
  ]);
});

test('version, package-manager, documentation and tag drift are reported together', () => {
  const candidate = input({ allTags: ['v0.22.0'] });
  candidate.packageLock.version = '0.20.4';
  candidate.packageJson.packageManager = 'npm@latest';
  candidate.currentStatus = 'stale';
  assert.deepEqual(inspectReleaseState(candidate).errors, [
    'package_lock_version_mismatch',
    'package_manager_policy_mismatch',
    'development_release_documentation_mismatch',
    'repository_tag_newer_than_package:v0.22.0',
  ]);
});

test('repository release-state command verifies the checked-out development candidate', () => {
  const result = spawnSync(process.execPath, ['paper-core/bin/release-state-check.mjs'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.version, packageJson.version);
  assert.equal(packageLock.version, packageJson.version);
});
