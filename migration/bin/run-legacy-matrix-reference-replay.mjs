#!/usr/bin/env node

/**
 * Run migration replays from a trusted orchestration checkout after the
 * private tar has been verified and removed.  The candidate sees only the
 * 263-file, read-only extraction and a networkless bubblewrap namespace.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareIsolatedRuntimeStore } from '../../paper-core/bin/isolated-runtime-store.mjs';

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const EXPECTED_SCRIPTS = Object.freeze({
  matrix: 'node paper-core/bin/run-isolated-command.mjs node migration/tests/matrix-integrity.mjs',
  differential: 'node migration/tests/p0-production-core-differential.mjs && node migration/tests/p1-referee-revision-differential.mjs',
});

function fail(message) { throw new Error(message); }

function required(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length || argv[index + 1].startsWith('-')) {
    fail(`${name}_required`);
  }
  return argv[index + 1];
}

function absolute(value, name) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) fail(`${name}_absolute_required`);
  return value;
}

function directory(value, name) {
  const root = absolute(value, name);
  let stat;
  try { stat = fs.lstatSync(root); }
  catch (error) { fail(`${name}_not_found:${error.message}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${name}_directory_required`);
  return root;
}

function regularFile(value, name) {
  const file = absolute(value, name);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { fail(`${name}_not_found:${error.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${name}_regular_file_required`);
  return file;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally { fs.closeSync(descriptor); }
  return `sha256:${hash.digest('hex')}`;
}

function hashText(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) fail(`git_${args.join('_')}_failed:${String(result.stderr || '').trim()}`);
  return String(result.stdout || '').trim();
}

function parseArgs(argv) {
  const expectedSha = required(argv, '--expected-sha');
  const expectedTree = required(argv, '--expected-tree');
  const expectedArchiveSha = required(argv, '--expected-archive-sha256');
  const expectedMatrixSha = required(argv, '--expected-matrix-sha256');
  if (!SHA40.test(expectedSha) || !SHA40.test(expectedTree)
    || !SHA256.test(expectedArchiveSha) || !SHA256.test(expectedMatrixSha)) {
    fail('expected_identity_invalid');
  }
  return Object.freeze({
    candidateRoot: directory(required(argv, '--candidate-root'), 'candidate_root'),
    preparedRoot: directory(required(argv, '--prepared-root'), 'prepared_root'),
    matrix: regularFile(required(argv, '--matrix'), 'matrix'),
    expectedSha,
    expectedTree,
    expectedArchiveSha,
    expectedMatrixSha,
    output: absolute(required(argv, '--output'), 'output'),
    logDir: absolute(required(argv, '--log-dir'), 'log_dir'),
  });
}

function matrixEntries(matrixPath, expectedHash) {
  if (sha256File(matrixPath) !== expectedHash) fail('matrix_hash_mismatch');
  let matrix;
  try { matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8')); }
  catch (error) { fail(`matrix_json_invalid:${error.message}`); }
  if (!Array.isArray(matrix.entries) || matrix.entries.length !== 263) fail('matrix_entry_count_invalid');
  const entries = matrix.entries.map((entry) => {
    const relative = String(entry?.source?.path || '');
    const hash = String(entry?.source?.sha256 || '');
    if (!relative || path.posix.isAbsolute(relative) || relative.includes('\\')
      || path.posix.normalize(relative) !== relative || relative.split('/').includes('..')
      || !SHA256.test(hash.startsWith('sha256:') ? hash : `sha256:${hash}`)) {
      fail('matrix_entry_unsafe');
    }
    return { path: relative, sha256: hash.startsWith('sha256:') ? hash : `sha256:${hash}` };
  });
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) fail('matrix_paths_not_unique');
  return entries;
}

function assertScriptContracts(candidateRoot) {
  const packagePath = path.join(candidateRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  for (const [name, expected] of Object.entries({
    'migration:matrix-integrity': EXPECTED_SCRIPTS.matrix,
    'test:migration-differential': EXPECTED_SCRIPTS.differential,
  })) {
    if (packageJson?.scripts?.[name] !== expected) fail(`candidate_script_contract_mismatch:${name}`);
  }
  return Object.freeze({
    'migration:matrix-integrity': EXPECTED_SCRIPTS.matrix,
    'test:migration-differential': EXPECTED_SCRIPTS.differential,
  });
}

function packageLockHash(candidateRoot) {
  const lockPath = path.join(candidateRoot, 'package-lock.json');
  if (!fs.existsSync(lockPath)) fail('candidate_package_lock_missing');
  return sha256File(lockPath);
}

function assertCandidateCredentialFree(candidateRoot) {
  const forbidden = /(^|\/)(\.npmrc|\.yarnrc(?:\.yml)?|\.git-credentials|\.netrc|credentials(?:\.json)?|\.aws|\.config\/gcloud)(\/|$)/u;
  const listed = spawnSync('git', ['-C', candidateRoot, 'ls-files', '-z'], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  if (listed.status !== 0) fail('candidate_file_inventory_failed');
  for (const raw of String(listed.stdout || '').split('\0').filter(Boolean)) {
    if (forbidden.test(raw)) fail(`candidate_credential_path_forbidden:${raw}`);
  }
  const gitDir = git(candidateRoot, 'rev-parse', '--git-dir');
  const configPath = path.resolve(candidateRoot, gitDir, 'config');
  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, 'utf8');
    if (/\b(?:extraheader|credential|password|auth)\b\s*=/iu.test(config)
      || /https?:\/\/[^\s/@]+:[^\s/@]+@/u.test(config)) {
      fail('candidate_git_config_credential_forbidden');
    }
  }
}

function treeDigest(root) {
  const rows = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    const relative = path.relative(root, current).split(path.sep).join('/');
    if (stat.isSymbolicLink()) {
      rows.push(`${relative}\0symlink\0${fs.readlinkSync(current)}`);
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    } else if (stat.isFile()) {
      rows.push(`${relative}\0file\0${sha256File(current)}`);
    } else fail(`runtime_member_type_forbidden:${current}`);
  }
  return hashText(rows.sort().join('\n'));
}

function sourceSnapshot(root, entries) {
  const snapshot = {};
  for (const entry of entries) {
    const file = path.join(root, entry.path);
    const relative = path.relative(root, file);
    if (relative !== entry.path || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail(`prepared_path_escape:${entry.path}`);
    }
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { fail(`prepared_source_missing:${entry.path}:${error.message}`); }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) {
      fail(`prepared_source_not_readonly_regular:${entry.path}`);
    }
    const actual = sha256File(file);
    if (actual !== entry.sha256) fail(`prepared_source_hash_mismatch:${entry.path}`);
    snapshot[entry.path] = actual;
  }
  return Object.freeze(snapshot);
}

function pathContains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoEscapingSymlinks(root, name) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      let target;
      try { target = fs.realpathSync.native(current); }
      catch (error) { fail(`${name}_symlink_unresolvable:${current}:${error.message}`); }
      if (!pathContains(root, target)) fail(`${name}_symlink_escapes_root:${current}:${target}`);
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
    }
  }
}

function version(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return result.status === 0 ? String(result.stdout || '').trim().split('\n')[0] : 'unavailable';
}

function sandboxCommand({ candidateRoot, preparedRoot, runtimeRoot, command, env }) {
  const node = process.execPath;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 65534;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 65534;
  let nodeRoot = path.dirname(node);
  while (path.dirname(nodeRoot) !== nodeRoot
    && !fs.existsSync(path.join(nodeRoot, 'lib'))
    && !fs.existsSync(path.join(nodeRoot, 'lib64'))) {
    nodeRoot = path.dirname(nodeRoot);
  }
  const nodeRelative = path.relative(nodeRoot, node);
  if (!nodeRelative || nodeRelative.startsWith(`..${path.sep}`) || path.isAbsolute(nodeRelative)) {
    fail('node_runtime_path_invalid');
  }
  const bwrap = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
  if (bwrap.status !== 0) fail('bubblewrap_required');
  const args = [
    '--die-with-parent', '--new-session', '--as-pid-1',
    '--unshare-user', '--uid', String(uid), '--gid', String(gid),
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net',
    '--unshare-cgroup-try', '--disable-userns', '--assert-userns-disabled',
    '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', candidateRoot, '/candidate',
    '--ro-bind', preparedRoot, '/legacy-reference',
    '--ro-bind', runtimeRoot, '/runtime',
    '--ro-bind-try', '/usr', '/usr',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/sbin', '/sbin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/etc', '/etc',
    '--ro-bind-try', nodeRoot, '/node-runtime',
    '--proc', '/proc', '--dev', '/dev',
    '--size', '67108864', '--tmpfs', '/tmp', '--dir', '/tmp/home',
    '--chdir', '/candidate',
    '--setenv', 'PATH', '/node-runtime/bin:/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp/home',
    '--setenv', 'CI', '1',
    '--setenv', 'HEPTA_PAPER_RUNTIME_ROOT', '/runtime',
    '--setenv', 'HEPTA_PAPER_RUNTIME_ISOLATED', '1',
    '--setenv', 'HEPTA_LEGACY_REFERENCE_PREPARED', '1',
    '--setenv', 'HEPTA_LEGACY_REFERENCE_VERIFIED_ARCHIVE_SHA256', env.archiveSha256,
    '--setenv', 'HEPTA_LEGACY_REFERENCE_VERIFIED_MATRIX_SHA256', env.matrixSha256,
    '--setenv', 'PAPER_FACTORY_LEGACY_ROOT', '/legacy-reference',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'LC_ALL', 'C.UTF-8',
    '--setenv', 'npm_config_audit', 'false',
    '--setenv', 'npm_config_fund', 'false',
    '--setenv', 'npm_config_update_notifier', 'false',
    '--setenv', 'npm_config_offline', 'true',
    '--', ...command,
  ];
  return { command: 'bwrap', args, display: ['bwrap', ...args] };
}

function runCommand({ options, command, label, index, runtimeRoot, archiveSha256, matrixSha256, logDir }) {
  const stdoutPath = path.join(logDir, `${index}.stdout`);
  const stderrPath = path.join(logDir, `${index}.stderr`);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const env = { archiveSha256, matrixSha256 };
  const sandbox = sandboxCommand({
    candidateRoot: options.candidateRoot,
    preparedRoot: options.preparedRoot,
    runtimeRoot,
    command,
    env,
  });
  const result = spawnSync(sandbox.command, sandbox.args, {
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  fs.writeFileSync(stdoutPath, stdout, { mode: 0o600 });
  fs.writeFileSync(stderrPath, stderr, { mode: 0o600 });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const exitCode = timedOut ? null : (Number.isInteger(result.status) ? result.status : null);
  const record = {
    label,
    argv: command,
    sandbox: 'bubblewrap_network_none_readonly_candidate_readonly_reference_readonly_runtime',
    cwd: '/candidate',
    network: 'none',
    secrets: [],
    archivePresent: false,
    exitCode,
    signal: result.signal || null,
    timedOut,
    status: exitCode === 0 && !timedOut ? 'passed' : 'failed',
    durationMs: Date.now() - started,
    startedAt,
    endedAt: new Date().toISOString(),
    stdout: { bytes: Buffer.byteLength(stdout), sha256: hashText(stdout), path: path.basename(stdoutPath) },
    stderr: { bytes: Buffer.byteLength(stderr), sha256: hashText(stderr), path: path.basename(stderrPath) },
  };
  return Object.freeze({
    ...record,
    resultHash: hashText(JSON.stringify(record)),
  });
}

function prepareRuntime(logDir) {
  const runtimeRoot = path.join(logDir, 'runtime');
  const assetRoot = path.join(logDir, 'runtime-assets');
  const dbPath = path.join(runtimeRoot, 'hepta-paper.sqlite');
  fs.mkdirSync(runtimeRoot, { recursive: false, mode: 0o700 });
  fs.mkdirSync(assetRoot, { recursive: false, mode: 0o700 });
  // The runtime database is initialized by the trusted orchestration tree,
  // while candidate commands receive only the already-closed database through
  // the read/write runtime bind.  No candidate module participates in setup.
  prepareIsolatedRuntimeStore({ root: assetRoot, runtimeRoot, dbPath });
  return runtimeRoot;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.logDir, { recursive: true, mode: 0o700 });
  const candidateSha = git(options.candidateRoot, 'rev-parse', 'HEAD');
  const candidateTree = git(options.candidateRoot, 'rev-parse', 'HEAD^{tree}');
  if (candidateSha !== options.expectedSha || candidateTree !== options.expectedTree) {
    fail(`candidate_identity_mismatch:${candidateSha}/${candidateTree}`);
  }
  const entries = matrixEntries(options.matrix, options.expectedMatrixSha);
  assertNoEscapingSymlinks(options.candidateRoot, 'candidate_root');
  const scriptContracts = assertScriptContracts(options.candidateRoot);
  assertCandidateCredentialFree(options.candidateRoot);
  const lockHash = packageLockHash(options.candidateRoot);
  const before = sourceSnapshot(options.preparedRoot, entries);
  const preparedRootTreeSha256 = hashText(JSON.stringify(before));
  const runtimeRoot = prepareRuntime(options.logDir);
  const runtimeBefore = treeDigest(runtimeRoot);
  const commands = [
    runCommand({ options, label: 'migration:matrix-integrity', command: ['npm', '--ignore-scripts', '--offline', 'run', 'migration:matrix-integrity'], index: 0, runtimeRoot, archiveSha256: options.expectedArchiveSha, matrixSha256: options.expectedMatrixSha, logDir: options.logDir }),
    runCommand({ options, label: 'test:migration-differential', command: ['npm', '--ignore-scripts', '--offline', 'run', 'test:migration-differential'], index: 1, runtimeRoot, archiveSha256: options.expectedArchiveSha, matrixSha256: options.expectedMatrixSha, logDir: options.logDir }),
  ];
  const after = sourceSnapshot(options.preparedRoot, entries);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('prepared_source_mutated');
  const runtimeAfter = treeDigest(runtimeRoot);
  const runtimeMutated = runtimeBefore !== runtimeAfter;
  const overallExitCode = commands.every((item) => item.status === 'passed') ? 0 : 1;
  const report = {
    version: 1,
    kind: 'LegacyMatrixReferenceReplay',
    status: overallExitCode === 0 ? 'legacy_matrix_reference_replay_verified' : 'legacy_matrix_reference_replay_failed',
    candidate: { sha: candidateSha, tree: candidateTree },
    archiveSha256: options.expectedArchiveSha,
    matrixSha256: options.expectedMatrixSha,
    preparedRoot: '/legacy-reference',
    archivePresentDuringCandidateExecution: false,
    candidateNetwork: 'none',
    candidateSecrets: [],
    candidateUid: typeof process.getuid === 'function' ? process.getuid() : null,
    candidateGid: typeof process.getgid === 'function' ? process.getgid() : null,
    namespacePolicy: {
      user: 'unshare',
      pid: 'unshare',
      ipc: 'unshare',
      uts: 'unshare',
      network: 'unshare-required',
      cgroup: 'unshare-try',
      nestedUserns: 'disabled',
    },
    sourceMutation: false,
    runtimeMutation: runtimeMutated,
    runtimeBefore,
    runtimeAfter,
    preparedRootTreeSha256,
    scriptContracts,
    packageLockSha256: lockHash,
    commands,
    overallExitCode,
    tools: { node: process.version, bwrap: version('bwrap') },
    authority: 'non_authorizing_migration_replay_evidence',
  };
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o444 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = overallExitCode;
}

try { main(); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // Preserve a machine-readable blocked result even when setup fails before
  // the normal report can be assembled. The workflow can therefore bind a
  // failed attempt instead of losing the evidence object entirely.
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (output && path.isAbsolute(output) && path.resolve(output) === output) {
    try {
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      fs.writeFileSync(output, `${JSON.stringify({
        version: 1,
        kind: 'LegacyMatrixReferenceReplay',
        status: 'legacy_matrix_reference_replay_blocked',
        blocker: message,
        overallExitCode: 125,
        commands: [],
        archivePresentDuringCandidateExecution: null,
        candidateNetwork: 'not_executed',
        candidateSecrets: [],
        sourceMutation: null,
        authority: 'non_authorizing_migration_replay_evidence',
      }, null, 2)}\n`, { mode: 0o444 });
    } catch { /* retain the original diagnostic below */ }
  }
  process.stderr.write(`legacy migration replay blocked: ${message}\n`);
  process.exitCode = 1;
}
