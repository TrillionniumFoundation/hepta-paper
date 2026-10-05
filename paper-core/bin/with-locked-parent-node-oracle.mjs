#!/usr/bin/env node
// An exclusive oracle installation outside the candidate. The strict source
// ignored-input rule remains unchanged; dependencies are independent inputs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildProductionStrictNpmAuditInvocation } from '../../paper-composition/bootstrap/strict-npm-audit-composition.mjs';

const FIELDS = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const MAX_FILE = 16 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024, MAX_ENTRIES = 16384;
function fail(code) { throw new Error(`parent_node_oracle_${code}`); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function identity(info) { return FIELDS.map(key => String(info[key])); }
function regular(file, limit = MAX_FILE) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) fail('file_policy');
    const raw = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    if (raw.length > limit || raw.length !== Number(before.size)
        || JSON.stringify(identity(before)) !== JSON.stringify(identity(after))
        || JSON.stringify(identity(before)) !== JSON.stringify(identity(named))) fail('file_changed');
    return { path: file, identity: identity(before), sha256: digest(raw), limit, raw };
  } finally { fs.closeSync(fd); }
}
function closure(directory) {
  const rows = [], pending = [directory]; let total = 0;
  while (pending.length) {
    const named = pending.pop(), info = fs.lstatSync(named, { bigint: true });
    if (rows.length >= MAX_ENTRIES) fail('entry_limit');
    const row = { path: path.relative(directory, named), identity: identity(info) };
    if (info.isDirectory()) {
      if (fs.realpathSync(named) !== named) fail('directory_alias');
      row.entries = fs.readdirSync(named).sort();
      for (const child of [...row.entries].reverse()) pending.push(path.join(named, child));
    } else if (info.isSymbolicLink()) {
      const target = fs.realpathSync(named);
      if (!target.startsWith(directory + path.sep) || !fs.lstatSync(target).isFile()) fail('symlink_escape');
      row.target = fs.readlinkSync(named); row.sha256 = digest(Buffer.from(row.target));
    } else {
      const file = regular(named); total += file.raw.length;
      if (total > MAX_TOTAL) fail('total_byte_limit');
      row.sha256 = file.sha256;
    }
    rows.push(row);
  }
  return { rows, totalBytes: total };
}
function sameFile(pin) {
  const current = regular(pin.path, pin.limit);
  if (JSON.stringify(current.identity) !== JSON.stringify(pin.identity) || current.sha256 !== pin.sha256) fail('input_changed');
}
function create(file, raw) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return regular(file);
}

// Explicit CI split-installation binding. PATH never selects an npm implementation.
export function lockedParentOracleRuntimePaths({ execPath, nodeVersion, architecture, npmExecPath = null }) {
  if (npmExecPath === null) return { node: execPath,
    npm: path.join(path.dirname(execPath), '../lib/node_modules/npm/bin/npm-cli.js'), copiedSystemNode: false };
  const installation = path.join('/opt/hostedtoolcache/node', nodeVersion, architecture);
  const npm = path.join(installation, 'lib/node_modules/npm/bin/npm-cli.js');
  if (execPath !== '/usr/bin/node' || nodeVersion !== '22.23.1'
      || !['x64', 'arm64'].includes(architecture) || npmExecPath !== npm) fail('explicit_ci_runtime_not_approved');
  return { node: path.join(installation, 'bin/node'), npm, copiedSystemNode: true };
}
export function assertLockedParentOracleNodeCopy(system, installation) {
  if (system.path !== '/usr/bin/node' || system.identity[3] !== '0' || system.identity[4] !== '0'
      || (BigInt(system.identity[2]) & 0o022n) !== 0n || system.sha256 !== installation.sha256) fail('system_node_copy_not_bound');
}

export function withLockedParentNodeOracle({ root, receipt, command, npmExecPath = null, budgetProfile = 'default' }) {
  if (process.version !== 'v22.23.1' || !Array.isArray(command) || !command.length) fail('runtime_or_command');
  if (budgetProfile !== 'default' && budgetProfile !== 'functional-ci') fail('budget_profile');
  // Preserve the 30-minute default; only functional CI opts into 85 minutes.
  // Installation and verification share this requested subprocess deadline, not a provider/oracle timeout.
  const deadline = performance.now() + (budgetProfile === 'functional-ci' ? 85 : 30) * 60 * 1000;
  const remaining = () => {
    const timeout = Math.floor(deadline - performance.now());
    if (timeout <= 0) fail('job_timeout');
    return timeout;
  };
  root = fs.realpathSync(root);
  const parent = path.dirname(root), dependencies = path.join(parent, 'node_modules');
  if (fs.realpathSync(parent) !== parent || fs.lstatSync(parent).uid !== process.getuid()
      || fs.existsSync(path.join(root, 'node_modules'))) fail('exclusive_parent_required');
  const source = [regular(path.join(root, 'package.json'), 1024 * 1024), regular(path.join(root, 'package-lock.json'), 8 * 1024 * 1024)];
  const manifest = JSON.parse(source[0].raw), lock = JSON.parse(source[1].raw);
  if (manifest.packageManager !== 'npm@10.9.8' || lock.lockfileVersion !== 3) fail('lock_or_npm_version');
  for (const file of ['package.json', 'package-lock.json', 'node_modules', '.npmrc', '.hepta-npm-user', '.hepta-npm-global']) {
    try { fs.lstatSync(path.join(parent, file)); fail('parent_input_collision'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  const copied = [create(path.join(parent, 'package.json'), source[0].raw), create(path.join(parent, 'package-lock.json'), source[1].raw),
    create(path.join(parent, '.hepta-npm-user'), Buffer.alloc(0)), create(path.join(parent, '.hepta-npm-global'), Buffer.alloc(0))];
  const runtime = lockedParentOracleRuntimePaths({ execPath: process.execPath,
    nodeVersion: process.versions.node, architecture: process.arch, npmExecPath });
  const currentNode = regular(fs.realpathSync(process.execPath), 512 * 1024 * 1024);
  // Reuse the original CI-pair file identity, realpath and toolcache-root checks.
  const inspectRuntimeBinding = () => runtime.copiedSystemNode
    ? buildProductionStrictNpmAuditInvocation({ workspaceRoot: root, nodeExecPath: runtime.node,
      npmExecPath: runtime.npm, environment: process.env }) : null;
  const runtimeBinding = inspectRuntimeBinding();
  const assertRuntimeBinding = () => {
    if (JSON.stringify(inspectRuntimeBinding()) !== JSON.stringify(runtimeBinding)) fail('runtime_installation_changed');
  };
  const oracleNodePath = fs.realpathSync(runtime.node);
  const oracleNode = oracleNodePath === currentNode.path ? currentNode : regular(oracleNodePath, 512 * 1024 * 1024);
  if (runtime.copiedSystemNode) assertLockedParentOracleNodeCopy(currentNode, oracleNode);
  const npm = fs.realpathSync(runtime.npm);
  const tools = [...new Set([currentNode, oracleNode]), regular(npm)];
  const npmRoot = fs.realpathSync(path.join(path.dirname(npm), '..'));
  const npmBefore = closure(npmRoot);
  const version = spawnSync(oracleNode.path, [npm, '--version'], { encoding: 'utf8', shell: false, timeout: remaining(), maxBuffer: 1024 * 1024 });
  if (version.status !== 0 || version.stdout.trim() !== '10.9.8') fail('actual_npm_version');
  const install = spawnSync(oracleNode.path, [npm, 'ci', '--prefix', parent, '--ignore-scripts', '--no-audit', '--no-fund',
    `--userconfig=${copied[2].path}`, `--globalconfig=${copied[3].path}`],
  { cwd: parent, shell: false, stdio: 'inherit', timeout: remaining() });
  for (const input of [...source, ...copied, ...tools]) sameFile(input);
  assertRuntimeBinding();
  if (install.status !== 0 || install.error) fail('install_failed');
  const before = closure(dependencies);
  let result;
  try {
    result = spawnSync(command[0], command.slice(1), { cwd: root, env: process.env, shell: false, stdio: 'inherit', timeout: remaining() });
  } finally {
    const after = closure(dependencies);
    for (const input of [...source, ...copied, ...tools]) sameFile(input);
    assertRuntimeBinding();
    if (JSON.stringify(before) !== JSON.stringify(after)) fail('dependency_drift');
    const npmAfter = closure(npmRoot);
    if (JSON.stringify(npmBefore) !== JSON.stringify(npmAfter)) fail('npm_tool_drift');
    const raw = Buffer.from(JSON.stringify({ version: 1, kind: 'LockedParentNodeOracleObservation',
      candidate: root, source: source.map(({ path: file, identity, sha256 }) => ({ path: file, identity, sha256 })),
      tools: tools.map(({ path: file, identity, sha256 }) => ({ path: file, identity, sha256 })),
      lockfileVersion: lock.lockfileVersion, dependencyBefore: before, dependencyAfter: after,
      npmBefore, npmAfter,
      actualExitCode: result?.status ?? null, actualSignal: result?.signal ?? null, executionError: result?.error?.code ?? null,
      candidateDependenciesInstalled: false, lifecycleScriptsExecuted: false, sourceQualificationClaimed: false }, null, 2) + '\n');
    create(path.resolve(receipt), raw);
  }
  if (!Number.isInteger(result.status)) fail('command_not_terminal');
  return result.status;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const selectedProfile = args[2] === '--budget-profile';
  const commandOffset = selectedProfile ? 5 : 3;
  if (args[0] !== '--receipt' || !args[1] || args[commandOffset - 1] !== '--' || args.length <= commandOffset
      || (selectedProfile && args[3] !== 'functional-ci')) fail('arguments');
  process.exitCode = withLockedParentNodeOracle({ root: process.cwd(), receipt: args[1], command: args.slice(commandOffset),
    budgetProfile: selectedProfile ? args[3] : 'default' });
}
