#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectReleaseState } from '../src/release-state-contract.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => fs.readFileSync(path.join(workspaceRoot, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const gitTags = (args) => {
  const result = spawnSync('git', ['tag', ...args], { cwd: workspaceRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git_tag_query_failed:${result.stderr.trim()}`);
  return result.stdout.split(/\r?\n/u).filter(Boolean);
};

const result = inspectReleaseState({
  packageJson: readJson('package.json'),
  packageLock: readJson('package-lock.json'),
  currentStatus: read('paper-core/docs/CURRENT_STATUS.md'),
  releaseDocument: read('RELEASE.md'),
  changelog: read('CHANGELOG.md'),
  headTags: gitTags(['--points-at', 'HEAD']),
  allTags: gitTags(['--list']),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
