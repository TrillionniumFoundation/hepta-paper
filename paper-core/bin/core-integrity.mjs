#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCoreIntegrityReport,
  writeCoreBaseline,
} from '../src/core-integrity.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const write = process.argv.includes('--write-baseline');
const fullJson = process.argv.includes('--json');

let acceptedFromGitCommit = null;
try {
  acceptedFromGitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  }).trim();
} catch {
  acceptedFromGitCommit = null;
}

if (write) await writeCoreBaseline({ workspaceRoot, acceptedFromGitCommit });
const report = buildCoreIntegrityReport({ workspaceRoot });
const output = fullJson ? report : {
  status: report.status,
  ok: report.ok,
  coreSnapshotModified: report.coreSnapshotModified,
  acceptedTreeHash: report.acceptedBaseline?.treeHash || null,
  currentTreeHash: report.current?.treeHash || null,
  acceptedFileCount: report.acceptedBaseline?.fileCount || 0,
  currentFileCount: report.current?.fileCount || 0,
  drift: {
    missing: report.drift.missing.length,
    extra: report.drift.extra.length,
    changed: report.drift.changed.length,
  },
  historicalUpstream: {
    exactMatch: report.upstream.exactMatch,
    total: report.upstream.total,
    matched: report.upstream.matched,
    changed: report.upstream.changed,
    missing: report.upstream.missing,
  },
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
