#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ignoredDirectories = new Set([
  '.git',
  '.nyc_output',
  'coverage',
  'node_modules',
]);

function moduleFilesUnder(directory, ignoredPaths) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()
      && (ignoredDirectories.has(entry.name) || ignoredPaths.has(absolute))) return [];
    if (entry.isDirectory()) return moduleFilesUnder(absolute, ignoredPaths);
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) return [];
    return [absolute];
  });
}

export function discoverMjsModuleFiles(root = workspaceRoot) {
  const resolvedRoot = path.resolve(root);
  const ignoredPaths = new Set([path.join(resolvedRoot, 'runtime')]);
  return moduleFilesUnder(resolvedRoot, ignoredPaths).sort();
}

function checkModule(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], {
      cwd: workspaceRoot,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ file, error: error.message }));
    child.once('close', (status) => resolve(status === 0 ? null : {
      file,
      error: stderr.trim() || `node_check_exit_${status}`,
    }));
  });
}

async function runBounded(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index]);
    }
  }));
  return results;
}

export async function runMjsSyntaxCheck({ root = workspaceRoot } = {}) {
  const files = discoverMjsModuleFiles(root);
  const failures = (await runBounded(
    files,
    Math.max(2, Math.min(8, os.availableParallelism())),
    checkModule,
  )).filter(Boolean);
  return Object.freeze({ files, failures });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  const { files, failures } = await runMjsSyntaxCheck();
  if (failures.length) {
    for (const failure of failures) {
      process.stderr.write(`${path.relative(workspaceRoot, failure.file)}\n${failure.error}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      kind: 'MjsSyntaxCheck',
      filesChecked: files.length,
      checker: process.execPath,
    })}\n`);
  }
}
