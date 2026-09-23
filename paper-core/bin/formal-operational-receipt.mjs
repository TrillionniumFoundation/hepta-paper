#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  currentCodeProvenance,
  resolvePinnedLakeExecutable,
} from '../../paper-composition/automation/formal-operational-receipt-composition.mjs';
import {
  verifyFormalOperationalReceipt,
} from './dynamic-formal-kernel-operational.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const emptySha256 = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function safeToken(value) {
  return String(value?.code || value?.message || value || 'unknown')
    .replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 240);
}

function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function cleanProvenance(provenance) {
  return provenance?.kind === 'CodeProvenance'
    && provenance.treeDirty === false
    && provenance.indexStateHash === emptySha256;
}

/** Parse the single machine-readable receipt line emitted after the TAP log. */
export function parseFormalOperationalReceiptOutput(output) {
  const line = String(output || '').split(/\r?\n/u)
    .find((candidate) => candidate.startsWith('formal_operational_summary='));
  if (!line) throw new Error('formal_operational_receipt_summary_missing');
  let receipt;
  try {
    receipt = JSON.parse(line.slice('formal_operational_summary='.length));
  } catch (error) {
    throw new Error(`formal_operational_receipt_summary_invalid:${safeToken(error)}`);
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('formal_operational_receipt_summary_object_required');
  }
  return Object.freeze(receipt);
}

/**
 * Run the reviewed zero-skip formal gate and bind its receipt to a clean,
 * exact source snapshot.  This function is intentionally side-effect free;
 * callers must explicitly opt into publication with writeFormalReceipt().
 */
export function captureFormalOperationalReceipt({
  root = workspaceRoot,
  environment = process.env,
  run = spawnSync,
  provenance = currentCodeProvenance,
  lakeResolver = resolvePinnedLakeExecutable,
} = {}) {
  const selectedRoot = path.resolve(root);
  const before = provenance({
    workspaceRoot: selectedRoot,
    allowReleaseCommitEnvironment: false,
  });
  if (!cleanProvenance(before)) {
    throw new Error('formal_operational_receipt_clean_commit_required');
  }
  const lake = lakeResolver({ environment, forceContentRehash: false });
  if (lake.status !== 'formal_pinned_lake_resolved') {
    throw new Error(`formal_operational_receipt_pinned_runtime_invalid:${lake.blockers.join(',')}`);
  }
  const selectedRunner = path.resolve(selectedRoot, 'paper-core/bin/dynamic-formal-kernel-operational.mjs');
  const result = run(process.execPath, [selectedRunner], {
    cwd: selectedRoot,
    encoding: 'utf8',
    env: { ...environment },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
    windowsHide: true,
  });
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.stdout || '').trim().split(/\r?\n/u).at(-1);
    throw new Error(`formal_operational_receipt_gate_failed:${safeToken(detail || result?.status)}`);
  }
  const receipt = parseFormalOperationalReceiptOutput(result.stdout);
  const after = provenance({
    workspaceRoot: selectedRoot,
    allowReleaseCommitEnvironment: false,
  });
  if (!cleanProvenance(after)) {
    throw new Error('formal_operational_receipt_postflight_dirty');
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('formal_operational_receipt_provenance_changed');
  }
  if (!verifyFormalOperationalReceipt(receipt, { expectedCodeProvenance: after })) {
    throw new Error('formal_operational_receipt_verification_failed');
  }
  return receipt;
}

function ensureDirectory(directory) {
  const selected = path.resolve(directory);
  // Do not let recursive mkdir follow a symlink in any component of the
  // runtime path.  A release receipt is code-bound evidence; publishing it
  // through an attacker-controlled link would silently move custody outside
  // the operator-selected root.  Create missing components one at a time so
  // every component can be lstat'd before it is trusted.
  const parsed = path.parse(selected);
  let current = parsed.root;
  const components = path.relative(parsed.root, selected)
    .split(path.sep)
    .filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('formal_operational_receipt_runtime_directory_unsafe');
    }
  }
  const stat = fs.lstatSync(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (stat.mode & 0o022) !== 0) {
    throw new Error('formal_operational_receipt_runtime_directory_unsafe');
  }
  return selected;
}

/** Atomically publish a clean receipt below the explicitly selected runtime root. */
export function writeFormalReceipt({
  receipt,
  runtimeRoot,
  receiptPath = null,
} = {}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new Error('formal_operational_receipt_required');
  }
  const selectedRuntime = ensureDirectory(runtimeRoot);
  const target = path.resolve(
    receiptPath || path.join(selectedRuntime, 'formal-operational', 'formal-operational-receipt.json'),
  );
  if (!pathWithin(selectedRuntime, target) || path.dirname(target) === selectedRuntime) {
    throw new Error('formal_operational_receipt_path_outside_runtime');
  }
  const parent = ensureDirectory(path.dirname(target));
  try {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
      throw new Error('formal_operational_receipt_target_unsafe');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const staging = fs.mkdtempSync(path.join(parent, `.formal-operational-${process.pid}-`));
  const temporary = path.join(staging, 'receipt.json');
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(temporary, 0o444);
    fs.renameSync(temporary, target);
    try { fs.chmodSync(target, 0o444); } catch { /* immutable deployments may reject chmod */ }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return Object.freeze({ path: target, bytes: fs.statSync(target).size });
}

function usage() {
  return Object.freeze({
    version: 1,
    kind: 'FormalOperationalReceiptUsage',
    usage: 'formal-operational-receipt [--root PATH] [--runtime-root PATH] [--receipt PATH] [--write]',
    effects: 'read-only unless --write; --write only publishes a code-bound local receipt below runtime-root',
    externalAction: false,
  });
}

function main() {
  const args = parseStrictCliArguments(process.argv.slice(2), {
    booleanFlags: ['help', 'write'],
    valueFlags: ['root', 'runtime-root', 'receipt'],
    positional: false,
  });
  if (args.help) {
    process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
    return;
  }
  const root = path.resolve(args.root || workspaceRoot);
  const runtimeRoot = path.resolve(
    args['runtime-root'] || process.env.HEPTA_PAPER_RUNTIME_ROOT || path.join(root, 'runtime'),
  );
  const receipt = captureFormalOperationalReceipt({ root, environment: process.env });
  const publication = args.write
    ? writeFormalReceipt({ receipt, runtimeRoot, receiptPath: args.receipt || null })
    : null;
  process.stdout.write(`${JSON.stringify({ receipt, publication }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
const invokedAsScript = invokedPath && (() => {
  try {
    return invokedPath === path.resolve(modulePath)
      || fs.realpathSync(invokedPath) === fs.realpathSync(modulePath);
  } catch {
    return invokedPath === path.resolve(modulePath);
  }
})();
if (invokedAsScript) {
  try { main(); } catch (error) {
    process.stderr.write(`${safeToken(error)}\n`);
    process.exitCode = 1;
  }
}

export { cleanProvenance };
