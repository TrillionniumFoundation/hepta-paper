import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { buildNativeOwners, safeEnvironment } from '../../docs/tools/node-rust-route-acceptance.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';

// These are bounded ordinary frontend observations, not complete route
// acceptance, release authority, or a target-host canary.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let fixture, root, caller, binary, unknown, graph, defaultRuntime, relativeRuntime, absoluteRuntime;
let keepFixture = false, shippedPin, unknownPin, markerPin;
const identity = s => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String);
function pin(file) {
  const before = fs.lstatSync(file, { bigint: true }); assert.ok(before.isFile()); assert.ok(before.size <= 512n * 1024n * 1024n, 'bounded input required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const held = fs.fstatSync(fd, { bigint: true }), hash = createHash('sha256'), block = Buffer.alloc(64 * 1024);
    assert.deepEqual(identity(held), identity(before));
    let readBytes = 0n;
    for (let n; (n = fs.readSync(fd, block)) !== 0;) {
      readBytes += BigInt(n);
      assert.ok(readBytes <= before.size && readBytes <= 512n * 1024n * 1024n, 'input grew during bounded pin read');
      hash.update(block.subarray(0, n));
    }
    for (const actual of [fs.fstatSync(fd, { bigint: true }), fs.lstatSync(file, { bigint: true })]) assert.deepEqual(identity(actual), identity(before));
    return { identity: identity(before), sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function env(additions = {}) {
  const selected = safeEnvironment(); delete selected.TZ;
  return { ...selected, PATH: `${path.dirname(process.execPath)}:${selected.PATH || '/usr/bin:/bin'}`,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', ...additions };
}
function copy(from, to, mode = 0o440) {
  const original = pin(from); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, mode);
  const copied = pin(to); assert.equal(copied.sha256, original.sha256); assert.equal(copied.identity[5], '1');
  assert.ok(copied.identity[0] !== original.identity[0] || copied.identity[1] !== original.identity[1]);
  assert.deepEqual(pin(from), original); return { source: original, copy: copied };
}
function run(engine, args, additions = {}, executable = binary) {
  const program = engine === 'node' ? process.execPath : executable;
  const argv = engine === 'node' ? [path.join(root, 'paper-core/bin/hepta-paper.mjs'), ...args] : args;
  const result = spawnSync(program, argv, { cwd: caller, env: env(additions), shell: false,
    encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null, result.stderr); return result;
}
function pair(name, additions = {}) {
  const args = ['verify', name], node = run('node', args, additions), native = run('native', args, additions);
  assert.equal(node.status, 0, node.stderr); assert.equal(native.status, 0, native.stderr);
  const expected = JSON.parse(node.stdout), actual = JSON.parse(native.stdout); assert.deepEqual(actual, expected); return actual;
}
function git(...args) {
  const result = spawnSync('/usr/bin/git', args, { cwd: root, env: env(), shell: false, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
}
function acceptance(mode, runtime) {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const result = spawnSync(process.execPath, [path.join(root, 'rust/oracle/owner-status-v1.mjs')], {
    cwd: root, env: env(), shell: false, input: JSON.stringify({ root: runtime, mode }), encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).profile.node, 'v22.23.1');
}
function authoritySnapshot(runtime) {
  return Object.fromEntries(['CAPABILITY_OWNER_ACCEPTANCE.json', 'OWNER_TRUST_STORE.json'].map(name => {
    const file = path.join(runtime, 'owner-acceptance', name); return [name, fs.existsSync(file) ? pin(file) : { absent: true }];
  }));
}
before(() => {
  const owners = buildNativeOwners().owners;
  fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.userInfo().homedir), '.hepta-governance-normal-'));
  root = path.join(fixture, 'deployment'); caller = path.join(fixture, 'caller');
  fs.mkdirSync(caller, { mode: 0o700 }); fs.mkdirSync(path.join(root, 'paper-core/config'), { recursive: true, mode: 0o700 });
  binary = path.join(root, 'bin/hepta-paper-rust'); const shipped = copy(owners['hepta-paper-rust'].path, binary, 0o550);
  assert.equal(`sha256:${shipped.copy.sha256}`, owners['hepta-paper-rust'].sha256); shippedPin = shipped.copy;
  unknown = path.join(fixture, 'unknown/debug/deps/hepta-paper-rust'); unknownPin = copy(binary, unknown, 0o550).copy;
  const pending = ['paper-core/bin/hepta-paper.mjs', 'paper-core/bin/owner-acceptance-status.mjs',
    'paper-core/bin/operational-proof-status.mjs', 'rust/oracle/owner-status-v1.mjs']; graph = new Map();
  while (pending.length) {
    const relative = pending.pop(); if (graph.has(relative)) continue;
    const from = path.join(source, relative), to = path.join(root, relative); graph.set(relative, copy(from, to));
    if (!relative.endsWith('.mjs')) continue;
    for (const match of fs.readFileSync(from, 'utf8').matchAll(/(?:from\s+|import\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)) {
      const name = match[1]; if (name.startsWith('node:')) continue; assert.ok(name.startsWith('.'), `unbound import: ${name}`);
      const selected = path.relative(source, path.resolve(path.dirname(from), name));
      assert.ok(selected && !selected.startsWith(`..${path.sep}`) && !path.isAbsolute(selected)); pending.push(selected);
    }
  }
  for (const relative of ['migration/legacy-semantic-migration-matrix.json',
    'paper-domain/governance/legacy-owner-acceptance-family-manifest.v1.json',
    ...Object.values(CAPABILITY_CATALOG).map(value => value.target),
    ...Object.keys(CAPABILITY_CATALOG).map(id => `migration/tests/capabilities/${id}.test.mjs`)]) {
    if (!graph.has(relative)) graph.set(relative, copy(path.join(source, relative), path.join(root, relative)));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'hepta-paper-workspace', version: '0.21.0' }), { flag: 'wx', mode: 0o440 });
  // The native executable is a deployment artifact, not part of this local
  // fixture source fingerprint. The same real Git exclusion applies to Node.
  markerPin = pin(path.join(root, 'package.json'));
  git('init'); fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n/bin/\n/relative-runtime/\n');
  git('add', '--all'); git('-c', 'user.name=Local governance test', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Local ordinary source fixture');
  defaultRuntime = path.join(fixture, 'hepta-paper-runtime/native-runtime'); relativeRuntime = path.join(root, 'relative-runtime'); absoluteRuntime = path.join(fixture, 'absolute-runtime');
  acceptance('none', defaultRuntime); acceptance('none', relativeRuntime); acceptance('none', absoluteRuntime);
  // A caller cwd containing a conflicting package and receipt layout must not
  // replace the physical frontend workspace or the wrapper worker cwd.
  fs.writeFileSync(path.join(caller, 'package.json'), JSON.stringify({ name: 'hepta-paper-workspace', version: '999.0.0' }), { mode: 0o600 });
  fs.mkdirSync(path.join(caller, 'relative-runtime'), { mode: 0o700 });
});
after(() => {
  if (!fixture) return;
  try {
    assert.deepEqual(pin(binary), shippedPin); assert.deepEqual(pin(unknown), unknownPin); assert.deepEqual(pin(path.join(root, 'package.json')), markerPin);
    for (const [relative, expected] of graph) {
      assert.deepEqual(pin(path.join(source, relative)), expected.source);
      assert.deepEqual(pin(path.join(root, relative)), expected.copy);
    }
  } catch (error) { keepFixture = true; throw error; }
  finally { if (!keepFixture) fs.rmSync(fixture, { recursive: true, force: false }); }
});

test('normal_governance_physical_root_relative_runtime_and_unknown_copy_are_observed', () => {
  for (const name of ['owner', 'operational']) {
    const initial = pair(name); assert.equal(initial.status, name === 'owner' ? 'owner_acceptance_pending' : 'capability_operational_proof_pending');
    pair(name, { HEPTA_PAPER_RUNTIME_ROOT: '' }); pair(name, { HEPTA_PAPER_RUNTIME_ROOT: './relative-runtime' });
    pair(name, { HEPTA_PAPER_RUNTIME_ROOT: './missing/../relative-runtime/.' }); pair(name, { HEPTA_PAPER_RUNTIME_ROOT: absoluteRuntime });
    const missing = run('native', ['verify', name], {}, unknown); assert.equal(missing.status, 1); assert.match(missing.stderr, /native_workspace_root_required/u); assert.equal(missing.stdout, '');
    const explicit = run('native', ['verify', name], { HEPTA_PAPER_WORKSPACE_ROOT: root }, unknown);
    assert.equal(explicit.status, 0, explicit.stderr); assert.deepEqual(JSON.parse(explicit.stdout), initial);
  }
});

test('normal_owner_signed_projection_and_invalid_authority_match_actual_node', () => {
  for (const mode of ['none', 'complete', 'local', 'revoked', 'wrong_role', 'tamper', 'bad_signature', 'private_key']) {
    acceptance(mode, defaultRuntime); const before = authoritySnapshot(defaultRuntime);
    const value = pair('owner'); assert.deepEqual(authoritySnapshot(defaultRuntime), before);
    assert.equal(value.status, mode === 'complete' ? 'external_independent_owner_acceptance_complete'
      : mode === 'local' ? 'local_admin_delegated_owner_acceptance_complete' : 'owner_acceptance_pending');
  }
  acceptance('none', defaultRuntime);
});

test('normal_governance_rejects_missing_git_and_owner_missing_coverage_before_status', () => {
  const movedGit = path.join(fixture, 'held-git'); fs.renameSync(path.join(root, '.git'), movedGit);
  try {
    for (const name of ['owner', 'operational']) for (const engine of ['node', 'native']) {
      const result = run(engine, ['verify', name]); assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, '');
      assert.match(result.stderr, /code_provenance_git_command_failed:head:exit_128/u);
    }
  } finally { fs.renameSync(movedGit, path.join(root, '.git')); }
  const relative = 'migration/tests/capabilities/submission.delivery-runtime.test.mjs';
  const selected = path.join(root, relative), held = path.join(fixture, 'held-coverage.mjs'); fs.renameSync(selected, held);
  try {
    const node = run('node', ['verify', 'owner']), native = run('native', ['verify', 'owner']);
    for (const result of [node, native]) { assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, ''); }
    assert.match(node.stderr, /ENOENT/u); assert.match(native.stderr, /code_provenance_entry_read_failed/u);
  } finally {
    fs.renameSync(held, selected); const restored = pin(selected); assert.equal(restored.sha256, graph.get(relative).copy.sha256);
    // Renaming the owned negative input changes its ctime. Preserve the actual
    // new observation rather than pretending the original metadata survived.
    graph.get(relative).copy = restored;
  }
  pair('owner'); pair('operational');
});

function processPin(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return { pid, state: fields[0], group: Number(fields[2]), session: Number(fields[3]), start: fields[19],
      uid: Number(/^Uid:\s+(\d+)/mu.exec(status)[1]) };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
const stopped = pin => !pin || ['Z', 'X'].includes(pin.state);
function groupMembers(group, session) {
  return fs.readdirSync('/proc').filter(name => /^\d+$/u.test(name)).map(Number).map(processPin)
    .filter(value => value && value.group === group && value.session === session);
}
function signalPinned(pin, signal) {
  const current = processPin(pin.pid); if (stopped(current)) return;
  for (const field of ['uid', 'group', 'session', 'start']) assert.equal(current[field], pin[field], `owned PID identity changed: ${field}`);
  assert.equal(current.uid, process.getuid()); process.kill(pin.pid, signal);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boundedClose(completion, milliseconds, message, timedOut = () => {}) {
  let timer;
  try {
    return await Promise.race([completion, new Promise((resolve, reject) => {
      timer = setTimeout(() => { timedOut(); reject(new Error(message)); }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function interrupted(engine, name, signal, watched) {
  const program = engine === 'node' ? process.execPath : binary;
  const args = engine === 'node' ? [path.join(root, 'paper-core/bin/hepta-paper.mjs'), 'verify', name] : ['verify', name];
  const child = spawn(program, args, { cwd: caller, env: env(), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const primary = processPin(child.pid); assert.ok(primary); assert.equal(primary.group, child.pid); assert.equal(primary.session, child.pid);
  const observed = new Map([[primary.pid, primary]]); let settled = false, result, stdout = 0, stderr = 0, captureFailure;
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, observedSignal) => { settled = true; result = { code, signal: observedSignal }; resolve(result); });
  });
  const capFailure = () => {
    keepFixture = true; captureFailure ||= new Error('owned frontend output limit exceeded');
    try { signalPinned(primary, 'SIGKILL'); } catch (error) { captureFailure = error; }
  };
  child.stdout.on('data', bytes => { stdout += bytes.length; if (stdout > 8 * 1024 * 1024) capFailure(); });
  child.stderr.on('data', bytes => { stderr += bytes.length; if (stderr > 1024 * 1024) capFailure(); });
  try {
    let barrier = false; const deadline = Date.now() + 30_000;
    while (!settled && !captureFailure && Date.now() < deadline && !barrier) {
      for (const member of groupMembers(primary.group, primary.session)) {
        assert.equal(member.uid, primary.uid); const previous = observed.get(member.pid);
        if (previous) assert.equal(member.start, previous.start); else observed.set(member.pid, member);
        try {
          for (const fd of fs.readdirSync(`/proc/${member.pid}/fd`)) {
            try { if (fs.readlinkSync(`/proc/${member.pid}/fd/${fd}`) === watched) { barrier = true; break; } }
            catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
          }
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      }
      if (!barrier) await delay(2);
    }
    if (captureFailure) throw captureFailure;
    assert.ok(barrier, `actual source FD barrier not observed: ${engine}/${name}/${signal}`);
    signalPinned(primary, signal);
    const terminal = await boundedClose(completion, 30_000, 'own frontend close timeout');
    if (captureFailure) throw captureFailure;
    assert.equal(terminal.code, null); assert.equal(terminal.signal, signal);
    assert.ok(stdout <= 8 * 1024 * 1024 && stderr <= 1024 * 1024);
  } catch (error) { keepFixture = true; throw error; }
  finally {
    try {
    // SIGKILL has no cooperative cleanup guarantee. Pin every actual remaining
    // own-session member and clean it before retry or fixture deletion.
    for (const member of groupMembers(primary.group, primary.session)) {
      const previous = observed.get(member.pid); if (previous) assert.equal(member.start, previous.start); else observed.set(member.pid, member);
      assert.equal(member.uid, primary.uid);
    }
    if (!settled) signalPinned(primary, 'SIGKILL');
    for (const member of [...observed.values()].sort((a, b) => Number(a.pid === primary.pid) - Number(b.pid === primary.pid))) signalPinned(member, 'SIGKILL');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && groupMembers(primary.group, primary.session).some(member => !stopped(member))) await delay(10);
    if (groupMembers(primary.group, primary.session).some(member => !stopped(member))) {
      keepFixture = true; child.stdout.destroy(); child.stderr.destroy(); child.unref(); throw new Error('own process cleanup unverified; fixture retained');
    }
    if (!settled) {
      await boundedClose(completion, 15_000, 'own close remains unverified; fixture retained', () => {
        keepFixture = true; child.stdout.destroy(); child.stderr.destroy(); child.unref();
      });
    }
    } catch (error) {
      keepFixture = true; child.stdout.destroy(); child.stderr.destroy(); child.unref(); throw error;
    }
  }
}

test('normal_governance_term_kill_and_fresh_retry_preserve_source_and_authority', async () => {
  const selected = path.join(root, 'signal-input.dat'); fs.writeFileSync(selected, Buffer.alloc(32 * 1024 * 1024, 0x61), { flag: 'wx', mode: 0o440 });
  git('add', 'signal-input.dat'); git('-c', 'user.name=Local governance test', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Add actual cancellation source');
  const sourceBefore = pin(selected), authorityBefore = authoritySnapshot(defaultRuntime);
  for (const name of ['owner', 'operational']) {
    const expected = pair(name);
    for (const signal of ['SIGTERM', 'SIGKILL']) for (const engine of ['node', 'native']) {
      await interrupted(engine, name, signal, selected);
      assert.deepEqual(pin(selected), sourceBefore); assert.deepEqual(authoritySnapshot(defaultRuntime), authorityBefore);
      const retry = run(engine, ['verify', name]); assert.equal(retry.status, 0, retry.stderr); assert.deepEqual(JSON.parse(retry.stdout), expected);
      assert.deepEqual(pin(selected), sourceBefore); assert.deepEqual(authoritySnapshot(defaultRuntime), authorityBefore);
    }
  }
});
