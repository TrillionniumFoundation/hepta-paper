import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { buildNativeOwners, safeEnvironment } from '../../docs/tools/node-rust-route-acceptance.mjs';

// This owner exercises an explicitly bounded Linux native profile. Passing
// these cases does not accept verify/store's entire Node value/effect domain.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const statIdentity = s => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String);
let fixture, root, caller, binary, unknown, graph, copiedBinaryPin, copiedUnknownPin, markerPin;
let healthy, blocked, receipts, defaultDb, relativeRuntime, absoluteRuntime, large, beyondCell;
let coldNode, coldNative;
let cleanupUnverified = false;

function pin(file) {
  const namedBefore = fs.lstatSync(file, { bigint: true });
  assert.ok(namedBefore.isFile(), `nonregular input: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const heldBefore = fs.fstatSync(fd, { bigint: true });
    const hash = createHash('sha256'), block = Buffer.alloc(64 * 1024);
    for (let n; (n = fs.readSync(fd, block)) !== 0;) hash.update(block.subarray(0, n));
    const heldAfter = fs.fstatSync(fd, { bigint: true });
    const namedAfter = fs.lstatSync(file, { bigint: true });
    for (const value of [heldBefore, heldAfter, namedAfter]) assert.deepEqual(statIdentity(value), statIdentity(namedBefore));
    return { identity: statIdentity(namedBefore), sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function observe(db) {
  return Object.fromEntries(['', '-wal', '-shm', '-journal'].map(suffix => {
    const file = `${db}${suffix}`;
    return [suffix, fs.existsSync(file) ? pin(file) : { absent: true }];
  }));
}
function durable(before, after) {
  for (const suffix of ['', '-wal', '-journal']) assert.deepEqual(after[suffix], before[suffix]);
}
function environment(additions = {}) {
  const out = safeEnvironment();
  delete out.TZ;
  return { ...out, PATH: `${path.dirname(process.execPath)}:${out.PATH || '/usr/bin:/bin'}`,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ...additions };
}
function copy(from, to, mode = 0o550) {
  const before = pin(from);
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o750 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, mode);
  const copied = pin(to);
  assert.equal(copied.sha256, before.sha256); assert.equal(copied.identity[5], '1');
  assert.deepEqual(pin(from), before);
  assert.ok(copied.identity[0] !== before.identity[0] || copied.identity[1] !== before.identity[1]);
  return copied;
}
function run(engine, args, db, additions = {}, executable = binary) {
  const before = db ? observe(db) : null;
  const program = engine === 'node' ? process.execPath : executable;
  const argv = engine === 'node' ? [path.join(root, 'paper-core/bin/hepta-paper.mjs'), ...args] : args;
  const output = spawnSync(program, argv, { cwd: caller, env: environment(additions), shell: false,
    encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(output.error, undefined, output.error?.message); assert.equal(output.signal, null, output.stderr);
  if (db) durable(before, observe(db));
  return output;
}
function pair(args, db, code = 0, additions = {}, executable = binary) {
  const node = run('node', args, db, additions), native = run('native', args, db, additions, executable);
  assert.equal(node.status, code, node.stderr); assert.equal(native.status, code, native.stderr);
  assert.ok(node.stdout.startsWith('{'), node.stderr); assert.ok(native.stdout.startsWith('{'), native.stderr);
  const expected = JSON.parse(node.stdout), actual = JSON.parse(native.stdout);
  assert.equal(expected.dbPath, path.resolve(db)); assert.deepEqual(actual, expected);
  return actual;
}
function createDb(file, flavor = 'healthy') {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  let sql = "PRAGMA foreign_keys=OFF;CREATE TABLE ordinary(id INTEGER PRIMARY KEY,value TEXT,bytes BLOB);INSERT INTO ordinary VALUES(1,'actual-normal-reader',x'0001ff');";
  if (flavor === 'blocked') sql += 'CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id REFERENCES parent(id));INSERT INTO child VALUES(1,99);';
  if (flavor === 'receipts') sql += `CREATE TABLE receipt_ledger(receipt_id TEXT PRIMARY KEY,receipt_json TEXT,receipt_sha256 TEXT);
INSERT INTO receipt_ledger VALUES('bad-surrogate','{"receiptHash":"\\ud800"}','wrong');
INSERT INTO receipt_ledger VALUES('last-falsy','{"kind":7,"firstReceiptHash":"earlier","lastReceiptHash":0,"value":"\\ud800"}','wrong');`;
  if (flavor === 'large') sql += "WITH RECURSIVE n(i) AS (VALUES(2) UNION ALL SELECT i+1 FROM n WHERE i<8000) INSERT INTO ordinary SELECT i,replace(hex(zeroblob(1024)),'0','a'),x'0001ff' FROM n;";
  if (flavor === 'beyond-cell') sql += "INSERT INTO ordinary VALUES(2,replace(hex(zeroblob(524289)),'0','b'),NULL);";
  const output = spawnSync(process.execPath, ['--input-type=module', '--eval',
    "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec(process.argv[2]);db.close();", file, sql],
    { env: environment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(output.error, undefined); assert.equal(output.status, 0, output.stderr); fs.chmodSync(file, 0o600);
}
before(() => {
  const runtime = buildNativeOwners(), owners = runtime.owners;
  assert.equal(`sha256:${pin(fs.realpathSync(process.execPath)).sha256}`, runtime.node.sha256);
  // Shared /tmp, /var/tmp and /dev/shm have independent service/test
  // lifecycle changes. This own unique fixture stays in the real account's
  // home; production ancestor timestamp guards still apply unchanged.
  const fixtureParent = fs.realpathSync(os.userInfo().homedir);
  fixture = fs.mkdtempSync(path.join(fixtureParent, '.hepta-store-integrity-normal-'));
  root = path.join(fixture, 'deployment'); caller = path.join(fixture, 'caller');
  fs.mkdirSync(caller); fs.mkdirSync(path.join(root, 'paper-core/config'), { recursive: true });
  binary = path.join(root, 'bin/hepta-paper-rust'); copiedBinaryPin = copy(owners['hepta-paper-rust'].path, binary);
  assert.equal(`sha256:${copiedBinaryPin.sha256}`, owners['hepta-paper-rust'].sha256);
  unknown = path.join(fixture, 'unknown/debug/deps/hepta-paper-rust'); copiedUnknownPin = copy(binary, unknown);
  const pending = ['paper-core/bin/hepta-paper.mjs', 'paper-core/bin/hepta-store-logical-integrity.mjs']; graph = new Map();
  while (pending.length) {
    const relative = pending.pop(); if (graph.has(relative)) continue;
    const from = path.join(source, relative), to = path.join(root, relative);
    graph.set(relative, { source: pin(from), copy: copy(from, to, 0o440) });
    const text = fs.readFileSync(from, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)) {
      const name = match[1]; if (name.startsWith('node:')) continue;
      assert.ok(name.startsWith('.'), `unbound source import: ${name}`);
      const target = path.resolve(path.dirname(from), name), selected = path.relative(source, target);
      assert.ok(selected && !selected.startsWith(`..${path.sep}`) && !path.isAbsolute(selected)); pending.push(selected);
    }
  }
  const marker = path.join(root, 'package.json'); fs.writeFileSync(marker, JSON.stringify({ name: 'hepta-paper-workspace', version: '0.21.0' }), { flag: 'wx', mode: 0o440 }); markerPin = pin(marker);
  healthy = path.join(root, 'data/ordinary.sqlite'); blocked = path.join(root, 'data/blocked.sqlite'); receipts = path.join(root, 'data/receipts.sqlite');
  defaultDb = path.join(fixture, 'hepta-paper-runtime/native-runtime/hepta-paper.sqlite');
  relativeRuntime = path.join(root, 'relative-runtime/hepta-paper.sqlite'); absoluteRuntime = path.join(fixture, 'absolute-runtime/hepta-paper.sqlite');
  large = path.join(fixture, 'signal-input/ordinary.sqlite'); beyondCell = path.join(root, 'data/beyond-cell.sqlite');
  for (const [file, flavor] of [[healthy, 'healthy'], [blocked, 'blocked'], [receipts, 'receipts'], [defaultDb, 'healthy'],
    [relativeRuntime, 'healthy'], [absoluteRuntime, 'healthy'], [large, 'large'], [beyondCell, 'beyond-cell'],
    [path.join(root, '-'), 'healthy'], [path.join(root, '-h'), 'healthy'], [path.join(caller, 'data/ordinary.sqlite'), 'blocked']]) createDb(file, flavor);
  const seed = path.join(fixture, 'wal-seed/ordinary.sqlite'); fs.mkdirSync(path.dirname(seed), { recursive: true });
  const wal = spawnSync(process.execPath, ['--input-type=module', '--eval',
    "import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec(\"PRAGMA journal_mode=WAL;PRAGMA synchronous=OFF;PRAGMA wal_autocheckpoint=0;CREATE TABLE actual(x TEXT);INSERT INTO actual VALUES('in-wal')\");for(const target of process.argv.slice(2)){fs.mkdirSync(target,{recursive:true});fs.copyFileSync(process.argv[1],target+'/ordinary.sqlite');fs.copyFileSync(process.argv[1]+'-wal',target+'/ordinary.sqlite-wal');}db.close();",
    seed, path.join(fixture, 'cold-node'), path.join(fixture, 'cold-native')],
    { env: environment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(wal.error, undefined); assert.equal(wal.status, 0, wal.stderr);
  coldNode = path.join(fixture, 'cold-node/ordinary.sqlite'); coldNative = path.join(fixture, 'cold-native/ordinary.sqlite');
  for (const db of [coldNode, coldNative]) for (const suffix of ['', '-wal']) fs.chmodSync(`${db}${suffix}`, 0o400);
});
after(() => {
  if (!fixture) return;
  try {
    assert.deepEqual(pin(binary), copiedBinaryPin); assert.deepEqual(pin(unknown), copiedUnknownPin);
    assert.deepEqual(pin(path.join(root, 'package.json')), markerPin);
    for (const [relative, before] of graph) {
      assert.deepEqual(pin(path.join(source, relative)), before.source); assert.deepEqual(pin(path.join(root, relative)), before.copy);
    }
  } finally { if (!cleanupUnverified) fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('normal_verify_store_actual_paths_defaults_and_registry_match_node', () => {
  for (const [args, db, env] of [
    [['verify', 'store', '--', healthy], healthy, {}],
    [['verify', 'store', '--', `${root}/data/./../data/ordinary.sqlite`], healthy, {}],
    [['verify', 'store', '--', './data/ordinary.sqlite'], healthy, {}],
    [['verify', 'store'], defaultDb, {}],
    [['verify', 'store', '--', ''], defaultDb, {}],
    [['verify', 'store'], defaultDb, { HEPTA_PAPER_RUNTIME_ROOT: '' }],
    [['verify', 'store'], relativeRuntime, { HEPTA_PAPER_RUNTIME_ROOT: './relative-runtime' }],
    [['verify', 'store', '--', ''], relativeRuntime, { HEPTA_PAPER_RUNTIME_ROOT: './data/../relative-runtime/.' }],
    [['verify', 'store'], absoluteRuntime, { HEPTA_PAPER_RUNTIME_ROOT: path.dirname(absoluteRuntime) }],
    [['verify', 'store', '--', healthy], healthy, { HEPTA_PAPER_RUNTIME_ROOT: '/unused-missing-runtime' }],
    [['verify', 'store', '--', '-'], path.join(root, '-'), {}],
    [['verify', 'store', '--', '-h'], path.join(root, '-h'), {}],
  ]) pair(args, db, 0, env);
  pair(['verify', 'store', '--', healthy], healthy, 0, {}, unknown);
  const unknownDefault = run('native', ['verify', 'store'], defaultDb, {}, unknown);
  assert.equal(unknownDefault.status, 1); assert.match(unknownDefault.stderr, /native_workspace_root_required/u);
  for (const args of [['verify', 'store', healthy], ['verify', 'store', '--', '--help'], ['verify', 'store', '--', healthy, blocked]]) {
    const node = run('node', args, healthy), native = run('native', args, healthy);
    assert.equal(node.status, 2, node.stderr); assert.equal(native.status, 2, native.stderr);
    const expected = JSON.parse(node.stderr).error; assert.ok(native.stderr.includes(expected), native.stderr);
  }
  for (const [args, db, env] of [
    [['verify', 'store', '--', path.join(root, 'missing.sqlite')], path.join(root, 'missing.sqlite'), {}],
    [['verify', 'store'], path.join(fixture, 'missing-runtime/hepta-paper.sqlite'), { HEPTA_PAPER_RUNTIME_ROOT: path.join(fixture, 'missing-runtime') }],
  ]) for (const engine of ['node', 'native']) {
    const result = run(engine, args, db, env); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(fs.existsSync(db), false);
  }
});
test('normal_verify_store_blocked_fk_raw_receipts_exit_one_without_durable_writes', () => {
  const fk = pair(['verify', 'store', '--', blocked], blocked, 1);
  assert.equal(fk.status, 'sqlite_logical_integrity_blocked'); assert.equal(fk.foreignKeyViolationCount, 1);
  const raw = pair(['verify', 'store', '--', receipts], receipts, 1);
  assert.equal(raw.invalidReceiptHashCount, 2); assert.equal(raw.invalidReceiptRows[0].expected, '\ud800');
  assert.equal(raw.readonlyCheckMutatedDatabase, false);
});

function processIdentity(pid) {
  const directory = `/proc/${pid}`, text = fs.readFileSync(`${directory}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/u);
  return { pid, uid: String(fs.statSync(directory, { bigint: true }).uid),
    group: Number(fields[2]), session: Number(fields[3]), startTime: fields[19] };
}
function groupMembers(group) {
  return fs.readdirSync('/proc').filter(name => /^\d+$/u.test(name)).flatMap(name => {
    try { const identity = processIdentity(Number(name)); return identity.group === group ? [identity] : []; } catch { return []; }
  });
}
function signalOwned(identity, signalName) {
  try { assert.deepEqual(processIdentity(identity.pid), identity); process.kill(identity.pid, signalName); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
}
async function boundedClose(closed, milliseconds, message) {
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function waitOwnedGroupStopped(group, identities) {
  const deadline = Date.now() + 15_000;
  while (true) {
    let running = false;
    for (const identity of groupMembers(group)) {
      const expected = identities.get(identity.pid);
      if (!expected) throw new Error('unexpected remaining process group member; fixture retained');
      assert.deepEqual(identity, expected);
      try {
        const text = fs.readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/u);
        assert.equal(fields[19], identity.startTime);
        // Exited zombies have already released their descriptors. A live or
        // uninterruptible actor is never inferred stopped from SIGKILL alone.
        if (fields[0] !== 'Z') running = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!running) return;
    if (Date.now() >= deadline) throw new Error('own process group stop remains unknown; fixture retained');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function interruptedRead(engine, signalName) {
  const before = observe(large), program = engine === 'node' ? process.execPath : binary;
  const args = ['verify', 'store', '--', large];
  const child = spawn(program, engine === 'node' ? [path.join(root, 'paper-core/bin/hepta-paper.mjs'), ...args] : args,
    { cwd: caller, env: environment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let terminal = null, failure = null; const stdout = [], stderr = [];
  const identities = new Map();
  child.stdout.on('data', bytes => stdout.push(bytes)); child.stderr.on('data', bytes => stderr.push(bytes));
  const closed = new Promise(resolve => { child.once('error', error => { failure = error; resolve(); }); child.once('close', (code, signal) => { terminal = { code, signal }; resolve(); }); });
  try {
    const leader = processIdentity(child.pid); identities.set(leader.pid, leader);
    assert.equal(leader.group, child.pid); assert.equal(leader.session, child.pid); assert.equal(leader.uid, String(process.getuid()));
    const deadline = Date.now() + 30_000; let barrier = false;
    while (!terminal && !failure && Date.now() < deadline && !barrier) {
      assert.deepEqual(processIdentity(child.pid), leader);
      for (const member of groupMembers(child.pid)) {
        assert.equal(member.session, leader.session); assert.equal(member.uid, leader.uid); identities.set(member.pid, member);
        const pid = member.pid;
        let descriptors; try { descriptors = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
        for (const descriptor of descriptors) {
          const fd = `/proc/${pid}/fd/${descriptor}`;
          try { if (fs.readlinkSync(fd) === large) {
            const held = fs.statSync(fd, { bigint: true }); assert.equal(String(held.dev), before[''].identity[0]); assert.equal(String(held.ino), before[''].identity[1]); barrier = true; break;
          } } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
        }
        if (barrier) break;
      }
      if (!barrier) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(failure, null); assert.equal(terminal, null); assert.equal(barrier, true, 'ordinary process never opened the actual DB');
    const beforeSignal = groupMembers(child.pid);
    assert.ok(beforeSignal.some(member => member.pid === child.pid));
    for (const member of beforeSignal) { assert.equal(member.session, leader.session); assert.equal(member.uid, leader.uid); identities.set(member.pid, member); }
    if (signalName === 'SIGKILL') {
      // Kill only current pinned descendants and the leader, never a reused
      // numeric process group. Child-first prevents an orphan wrapper reader.
      for (const member of [...beforeSignal].sort((a, b) => Number(a.pid === child.pid) - Number(b.pid === child.pid))) signalOwned(member, signalName);
    } else signalOwned(leader, signalName);
    await boundedClose(closed, 30_000, 'own interrupted reader did not close');
    assert.equal(failure, null); durable(before, observe(large));
    assert.equal(terminal.signal, signalName, Buffer.concat(stderr).toString()); assert.equal(terminal.code, null);
    assert.equal(Buffer.concat(stdout).length, 0, 'interrupted read cannot claim a completed report');
  } finally {
    // Retain each PID's UID/session/start-time guard across cleanup. An old
    // PGID alone never authorizes signaling later processes with that number.
    try {
      for (const identity of identities.values()) signalOwned(identity, 'SIGKILL');
      await boundedClose(closed, 30_000, 'own reader cleanup remains unknown; fixture retained');
      await waitOwnedGroupStopped(child.pid, identities);
    }
    catch (error) {
      cleanupUnverified = true; child.unref(); child.stdout.destroy(); child.stderr.destroy(); throw error;
    }
  }
}
test('normal_verify_store_sigterm_sigkill_unknown_read_result_and_same_input_retry', async () => {
  const original = observe(large);
  for (const engine of ['node', 'native']) for (const signalName of ['SIGTERM', 'SIGKILL']) {
    await interruptedRead(engine, signalName);
    const report = pair(['verify', 'store', '--', large], large);
    assert.equal(report.status, 'sqlite_logical_integrity_verified'); durable(original, observe(large));
  }
});
test('normal_verify_store_explicit_native_budget_refusal_remains_partial', () => {
  const args = ['verify', 'store', '--', beyondCell], node = run('node', args, beyondCell), native = run('native', args, beyondCell);
  assert.equal(node.status, 0, node.stderr); assert.equal(JSON.parse(node.stdout).status, 'sqlite_logical_integrity_verified');
  assert.equal(native.status, 1); assert.equal(native.stdout, ''); assert.match(native.stderr, /budget|limit/u);
});
test('normal_verify_store_cold_0400_coordination_reports_match_but_shm_effects_remain_partial', () => {
  const nodeBefore = observe(coldNode), nativeBefore = observe(coldNative);
  assert.equal(nodeBefore['-shm'].absent, true); assert.equal(nativeBefore['-shm'].absent, true);
  const node = run('node', ['verify', 'store', '--', coldNode], coldNode), native = run('native', ['verify', 'store', '--', coldNative], coldNative);
  assert.equal(node.status, 0, node.stderr); assert.equal(native.status, 0, native.stderr);
  const nodeReport = JSON.parse(node.stdout), nativeReport = JSON.parse(native.stdout);
  assert.equal(nodeReport.dbPath, coldNode); assert.equal(nativeReport.dbPath, coldNative);
  delete nodeReport.dbPath; delete nativeReport.dbPath; assert.deepEqual(nativeReport, nodeReport);
  const nodeAfter = observe(coldNode), nativeAfter = observe(coldNative); durable(nodeBefore, nodeAfter); durable(nativeBefore, nativeAfter);
  assert.equal(Number(nodeAfter['-shm'].identity[2]) & 0o777, 0o400); assert.equal(Number(nativeAfter['-shm'].identity[2]) & 0o777, 0o400);
  assert.equal(nodeAfter['-shm'].identity[6], '32768'); assert.equal(nativeAfter['-shm'].identity[6], '0');
  pair(['verify', 'store', '--', coldNative], coldNative);
});
