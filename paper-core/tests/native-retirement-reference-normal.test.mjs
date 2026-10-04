import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { buildNativeOwners, safeEnvironment } from '../../docs/tools/node-rust-route-acceptance.mjs';

// Ordinary source-only inspection and interruption evidence grants no
// archive deletion, target-host, release, submission or retirement authority.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let fixture, root, caller, binary, unknown, graph, reference, relativeReference;
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
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HEPTA_RETIREMENT_REFERENCE: reference, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
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

function pair(additions = {}) {
  const args = ['retirement', 'reference'], node = run('node', args, additions), native = run('native', args, additions);
  assert.equal(native.status, node.status, native.stderr); assert.ok([0, 1].includes(node.status), node.stderr);
  const expected = JSON.parse(node.stdout), actual = JSON.parse(native.stdout); assert.deepEqual(actual, expected); return actual;
}
function receipts(directory, data = Buffer.from('held reference archive')) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'legacy.tar.zst'), data, { flag: 'wx', mode: 0o440 });
  fs.writeFileSync(path.join(directory, 'RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json'),
    JSON.stringify({ archives: [{ name: 'legacy.tar.zst', bytes: data.length, sha256: 'sha256:'+createHash('sha256').update(data).digest('hex') }] }), { flag: 'wx', mode: 0o440 });
  fs.writeFileSync(path.join(directory, 'IMMUTABILITY_RECEIPT.json'), '{"files":[]}', { flag: 'wx', mode: 0o440 });
}
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, pin(path.join(directory, name))]));
}
function fixtureRewrite(file, bytes) {
  fs.chmodSync(file, 0o600);
  try { fs.writeFileSync(file, bytes); } finally { fs.chmodSync(file, 0o440); }
}
before(() => {
  const owners = buildNativeOwners().owners;
  fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.userInfo().homedir), '.hepta-reference-normal-'));
  root = path.join(fixture, 'deployment'); caller = path.join(fixture, 'caller');
  fs.mkdirSync(caller, { mode: 0o700 }); fs.mkdirSync(path.join(root, 'paper-core/config'), { recursive: true, mode: 0o700 });
  binary = path.join(root, 'bin/hepta-paper-rust'); const shipped = copy(owners['hepta-paper-rust'].path, binary, 0o550);
  assert.equal('sha256:'+shipped.copy.sha256, owners['hepta-paper-rust'].sha256); shippedPin = shipped.copy;
  unknown = path.join(fixture, 'unknown/debug/deps/hepta-paper-rust'); unknownPin = copy(binary, unknown, 0o550).copy;
  const pending = ['paper-core/bin/hepta-paper.mjs', 'migration/bin/verify-retirement-source-snapshot.mjs']; graph = new Map();
  while (pending.length) {
    const relative = pending.pop(); if (graph.has(relative)) continue;
    const from = path.join(source, relative), to = path.join(root, relative); graph.set(relative, copy(from, to));
    if (!relative.endsWith('.mjs')) continue;
    for (const match of fs.readFileSync(from, 'utf8').matchAll(/(?:from\s+|import\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)) {
      const name = match[1]; if (name.startsWith('node:')) continue; assert.ok(name.startsWith('.'), 'unbound import: '+name);
      const selected = path.relative(source, path.resolve(path.dirname(from), name));
      assert.ok(selected && !selected.startsWith('..'+path.sep) && !path.isAbsolute(selected)); pending.push(selected);
    }
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'hepta-paper-workspace', version: '0.21.0' }), { flag: 'wx', mode: 0o440 });
  markerPin = pin(path.join(root, 'package.json'));
  reference = path.join(fixture, 'reference'); relativeReference = path.join(root, 'relative-reference');
  receipts(reference); receipts(relativeReference);
  fs.writeFileSync(path.join(caller, 'package.json'), '{"name":"hepta-paper-workspace","version":"999.0.0"}', { mode: 0o600 });
  fs.mkdirSync(path.join(caller, 'relative-reference'), { mode: 0o700 });
});
after(() => {
  if (!fixture) return;
  try {
    assert.deepEqual(pin(binary), shippedPin); assert.deepEqual(pin(unknown), unknownPin); assert.deepEqual(pin(path.join(root, 'package.json')), markerPin);
    for (const [relative, expected] of graph) {
      assert.deepEqual(pin(path.join(source, relative)), expected.source); assert.deepEqual(pin(path.join(root, relative)), expected.copy);
    }
  } catch (error) { keepFixture = true; throw error; }
  finally { if (!keepFixture) fs.rmSync(fixture, { recursive: true, force: false }); }
});
test('normal_reference_physical_root_relative_environment_and_actual_default_match_node', () => {
  assert.equal(pair().status, 'retirement_reference_verified');
  pair({ HEPTA_RETIREMENT_REFERENCE: './relative-reference' });
  pair({ HEPTA_RETIREMENT_REFERENCE: './relative-reference/../relative-reference' });
  const absent = pair({ HEPTA_RETIREMENT_REFERENCE: undefined }), empty = pair({ HEPTA_RETIREMENT_REFERENCE: '' });
  assert.equal(absent.referenceRoot, '/data/home-data/hepta-paper-legacy-reference/retirement-source-snapshot-2026-07-13');
  assert.deepEqual(empty, absent);
  const rejected = run('native', ['retirement', 'reference'], {}, unknown); assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /native_workspace_root_required/u);
  const explicit = run('native', ['retirement', 'reference'], { HEPTA_PAPER_WORKSPACE_ROOT: root }, unknown);
  assert.equal(explicit.status, 0, explicit.stderr); assert.deepEqual(JSON.parse(explicit.stdout), pair());
});
test('normal_reference_reports_missing_first_or_last_edge_invalid_json_and_changed_archive', () => {
  const before = snapshot(reference);
  for (const selected of [path.join(fixture, 'first-missing/leaf'), path.join(reference, 'missing-leaf')]) {
    const report = pair({ HEPTA_RETIREMENT_REFERENCE: selected });
    assert.equal(report.status, 'retirement_reference_blocked');
    assert.deepEqual(report.blockers, ['retirement_snapshot_receipt_missing_or_invalid', 'immutability_receipt_missing_or_invalid']);
    assert.equal(fs.existsSync(selected), false);
  }
  assert.deepEqual(snapshot(reference), before);
  const archive = path.join(reference, 'legacy.tar.zst'); fixtureRewrite(archive, 'changed');
  const blocked = pair(); assert.equal(blocked.status, 'retirement_reference_blocked'); assert.ok(blocked.blockers.includes('archive_hash_mismatch:legacy.tar.zst'));
  const receipt = path.join(reference, 'RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json'), original = fs.readFileSync(receipt);
  fixtureRewrite(receipt, '{'); const malformed = pair(); assert.deepEqual(malformed.blockers, ['retirement_snapshot_receipt_missing_or_invalid']);
  fixtureRewrite(receipt, original); const retry = pair(); assert.deepEqual(retry, blocked);
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
  const args = engine === 'node' ? [path.join(root, 'paper-core/bin/hepta-paper.mjs'), 'retirement', 'reference'] : ['retirement', 'reference'];
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

test('normal_reference_term_kill_actual_archive_and_fresh_retry_preserve_inputs', async () => {
  const archive = path.join(reference, 'legacy.tar.zst'); fs.chmodSync(archive, 0o600);
  const fd = fs.openSync(archive, 'w');
  try { fs.ftruncateSync(fd, 256 * 1024 * 1024); } finally { fs.closeSync(fd); fs.chmodSync(archive, 0o440); }
  fixtureRewrite(path.join(reference, 'RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json'), JSON.stringify({
    archives: [{ name: 'legacy.tar.zst', bytes: 256 * 1024 * 1024, sha256: 'sha256:'+'0'.repeat(64) }],
  }));
  const before = snapshot(reference), expected = pair(); assert.equal(expected.status, 'retirement_reference_blocked');
  for (const signal of ['SIGTERM', 'SIGKILL']) for (const engine of ['node', 'native']) {
    await interrupted(engine, 'reference', signal, archive); assert.deepEqual(snapshot(reference), before);
    const retry = run(engine, ['retirement', 'reference']); assert.equal(retry.status, 1, retry.stderr); assert.deepEqual(JSON.parse(retry.stdout), expected);
    assert.deepEqual(snapshot(reference), before);
  }
});
