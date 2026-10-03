import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildNativeOwners, safeEnvironment } from '../../../docs/tools/node-rust-route-acceptance.mjs';
import { resolveHeptaPaperCommand } from '../../src/command-registry.mjs';
import { relativeModuleSpecifiers } from '../../verification/javascript-module-specifiers.mjs';
// Source qualification fixtures only: physically copied ordinary frontends and
// original Node graph, no product fallback or live actor/portal authority.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function createNormalQualificationFixtureV1(routeNames) {
let fixture, root, caller, binary, unknown, graph, shippedPin, unknownPin, markerPin;
let keepFixture = false;
const dependencies = new Map();
const immutableCopyPins = new Map();
let copiedBytes = 0, copiedEntries = 0;
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
  if (immutableCopyPins.has(to)) {
    assert.deepEqual(pin(to), immutableCopyPins.get(to));
    assert.equal(pin(from).sha256, immutableCopyPins.get(to).sha256); return { source: pin(from), copy: immutableCopyPins.get(to) };
  }
  assert.ok(++copiedEntries <= 10000, 'bounded fixture entries');
  if (mode !== 0o550) { copiedBytes += Number(fs.lstatSync(from).size); assert.ok(copiedBytes <= 192 * 1024 * 1024, 'bounded original Node fixture graph'); }
  const original = pin(from); fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, mode);
  const copied = pin(to); assert.equal(copied.sha256, original.sha256); assert.equal(copied.identity[5], '1');
  assert.ok(copied.identity[0] !== original.identity[0] || copied.identity[1] !== original.identity[1]);
  assert.deepEqual(pin(from), original); immutableCopyPins.set(to, copied);
  return { source: original, copy: copied };
}

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
  const current = processPin(pin.pid); if (stopped(current)) return false;
  for (const field of ['uid', 'group', 'session', 'start']) assert.equal(current[field], pin[field], `owned PID identity changed: ${field}`);
  assert.equal(current.uid, process.getuid()); process.kill(pin.pid, signal); return true;
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

function snapshot(directory) {
  if (!fs.existsSync(directory)) return { absent: true };
  const rows = [];
  function visit(file) {
    const stat = fs.lstatSync(file, { bigint: true });
    const row = { path: path.relative(directory, file), identity: identity(stat) };
    if (stat.isFile()) {
      const captured = immutableCopyPins.get(file);
      if (captured) {
        // This file was raw-hashed during its independent physical copy. Each
        // case retains its complete named identity, including ctime, while the
        // suite's final guard re-reads all immutable source and copied bytes.
        // Mutable inputs still receive a fresh bounded raw read on every case.
        assert.deepEqual(identity(stat), captured.identity);
        row.pin = captured;
      } else row.pin = pin(file);
    }
    else if (stat.isSymbolicLink()) row.link = fs.readlinkSync(file);
    else assert.ok(stat.isDirectory(), 'special fixture input');
    rows.push(row);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
  }
  visit(directory); return rows;
}
// Inserted only after the current source guard closes. Qualification harness.
async function waitForJournalRead(primary, watched, expected, remember, settled, failed) {
  const until=Date.now()+30_000;
  const firstCounters=new Map();
  while(!settled()&&!failed()&&Date.now()<until){
    remember();
    const members=groupMembers(primary.group,primary.session);
    for(const member of members){
      assert.equal(member.uid,primary.uid);
      let names;try{names=fs.readdirSync(`/proc/${member.pid}/fd`);}catch(error){if(['ENOENT','ESRCH','EACCES'].includes(error.code))continue;throw error;}
      for(const name of names){
        const descriptor=`/proc/${member.pid}/fd/${name}`;
        try{
          if(fs.readlinkSync(descriptor)!==watched)continue;
          const offset=/^pos:\s*(\d+)$/mu.exec(fs.readFileSync(`/proc/${member.pid}/fdinfo/${name}`,'utf8'));
          if(!offset)continue;
          // The original descriptor owner uses position-neutral read_at/pread.
          // Require actual read-counter progress while the same original FD
          // remains held; its fdinfo offset correctly stays zero.
          const io=/^rchar:\s*(\d+)$/mu.exec(fs.readFileSync(`/proc/${member.pid}/io`,'utf8'));
          assert.ok(io,'actual owned read counter required');
          const key=`${member.pid}:${name}`;const currentRead=BigInt(io[1]);
          if(!firstCounters.has(key)){firstCounters.set(key,currentRead);continue;}
          const initialRead=firstCounters.get(key);
          assert.ok(currentRead>=initialRead,'owned read counter reset');
          if(currentRead-initialRead<64n*1024n)continue;
          assert.deepEqual(identity(fs.statSync(descriptor,{bigint:true})),expected.identity);
          assert.deepEqual(identity(fs.lstatSync(watched,{bigint:true})),expected.identity);
          const now=processPin(member.pid);assert.ok(!stopped(now));
          for(const field of ['uid','group','session','start'])assert.equal(now[field],member[field]);
          return {definition:'actual owned original journal FD with read counter progress; position-neutral pread, no SQL instruction claim',pid:member.pid,descriptor:Number(name),offset:offset[1],readCounters:{before:String(initialRead),after:String(currentRead),delta:String(currentRead-initialRead)},identity:expected.identity,observedAt:Date.now()};
        }catch(error){if(['ENOENT','ESRCH','EACCES'].includes(error.code))continue;throw error;}
      }
    }
    await new Promise(resolve=>setImmediate(resolve));
  }
  throw new Error('actual journal FD with read progress barrier not observed');
}
async function run(engine, args, additions = {}, executable = binary, interruptSignal = null, input = null, expectedTerminalSignal = null, requireNaturalGroupTermination = false, watchedJournal = null) {
  const program = ['node', 'oracle'].includes(engine) ? process.execPath : executable;
  const argv = engine === 'node' ? [path.join(root, 'paper-core/bin/hepta-paper.mjs'), ...args] : args;
  if (input !== null) assert.ok(Buffer.byteLength(input) <= 64 * 1024, 'bounded fixture oracle stdin');
  const watchedPin = watchedJournal === null ? null : pin(watchedJournal);
  let readBarrier = null;
  const beganAt = Date.now();
  const child = spawn(program, argv, { cwd: caller, env: env(additions), shell: false,
    detached: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const primary = processPin(child.pid); assert.ok(primary); assert.equal(primary.group, child.pid);
  assert.equal(primary.session, child.pid); assert.equal(primary.uid, process.getuid());
  const pins = new Map([[primary.pid, primary]]); let failure, result, settled = false;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { settled = true; result = { status: code, signal,
      stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), beganAt, endedAt: Date.now() }; resolve(result); });
  });
  if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  function remember() {
    for (const member of groupMembers(primary.group, primary.session)) {
      assert.equal(member.uid, primary.uid);
      if (pins.has(member.pid)) assert.equal(pins.get(member.pid).start, member.start);
      else pins.set(member.pid, member);
    }
  }
  function stop(signal) {
    remember();
    for (const selected of [...pins.values()].sort((a, b) => b.pid - a.pid)) signalPinned(selected, signal);
  }
  function consume(bytes, stream) {
    try {
      const current = stream === 'stdout' ? stdout : stderr;
      assert.ok(current.length + bytes.length <= 4 * 1024 * 1024, 'bounded frontend output exceeded');
      if (stream === 'stdout') stdout = Buffer.concat([current, bytes]); else stderr = Buffer.concat([current, bytes]);
    } catch (error) { failure ||= error; keepFixture = true; try { stop('SIGKILL'); } catch (error) { failure = error; } }
  }
  child.stdout.on('data', bytes => consume(bytes, 'stdout')); child.stderr.on('data', bytes => consume(bytes, 'stderr'));
  try {
    if (interruptSignal) {
      if (watchedJournal !== null) {
        assert.equal(engine, 'native', 'journal read progress barrier is a native held read observation');
        readBarrier = await waitForJournalRead(primary, watchedJournal, watchedPin, remember, () => settled, () => failure);
      }
      // With no watched journal this deliberately remains an unknown execution point, not a claim about a read or
      // durable dispatch phase. Both engines retry from the same namespace.
      // Signal the already pinned live primary before /proc group discovery;
      // an already completed fast native command is not a cancellation proof.
      assert.equal(signalPinned(primary, interruptSignal), true, 'owned primary exited before actual interrupt');
    }
    await boundedClose(completion, 60_000, 'ordinary frontend deadline exceeded', () => {
      keepFixture = true; try { stop('SIGKILL'); } catch (error) { failure = error; }
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      remember(); const live = [...pins.values()].filter(value => !stopped(processPin(value.pid)));
      if (!live.length) break;
      // Accepted active-cancellation proofs must observe production cleanup
      // before this harness can repair a leftover process with a signal.
      assert.equal(requireNaturalGroupTermination, false, 'production left an owned group member live before harness cleanup');
      assert.ok(Date.now() < deadline, 'owned group did not stop within cleanup bound');
      for (const member of live) signalPinned(member, 'SIGKILL'); await delay(5);
    }
    if (failure) throw failure;
    if (!interruptSignal) assert.equal(result.signal, expectedTerminalSignal, result.stderr);
    if (readBarrier !== null) result.readBarrier = readBarrier;
    return result;
  } catch (error) {
    keepFixture = true;
    try { stop('SIGKILL'); await boundedClose(completion, 15_000, 'bounded failure cleanup exceeded'); }
    catch (cleanup) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); throw new AggregateError([error, cleanup]); }
    throw error;
  } finally { assert.ok(settled || keepFixture); }
}
function prepare() {
  const owners = buildNativeOwners().owners;
  fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.userInfo().homedir), '.hepta-qualification-normal-'));
  root = path.join(fixture, 'deployment'); caller = path.join(fixture, 'caller');
  fs.mkdirSync(caller, { mode: 0o700 }); fs.mkdirSync(path.join(root, 'paper-core/config'), { recursive: true, mode: 0o700 });
  binary = path.join(root, 'bin/hepta-paper-rust'); shippedPin = copy(owners['hepta-paper-rust'].path, binary, 0o550).copy;
  assert.equal(`sha256:${shippedPin.sha256}`, owners['hepta-paper-rust'].sha256);
  unknown = path.join(fixture, 'unknown/debug/deps/hepta-paper-rust'); unknownPin = copy(binary, unknown, 0o550).copy;
  const pending = ['paper-core/bin/hepta-paper.mjs', ...routeNames.map(name => resolveHeptaPaperCommand('operator', name).argv[1])]; graph = new Map();
  if (routeNames.includes('campaign')) {
    // The original scoped bootstrap hashes these physical migration inputs.
    // They belong to the actual Node closure, even though they are not imports.
    for (const name of ['021_job_lease_fencing', '022_campaign_attempt_fencing', '023_workspace_retention_qualification', '024_submission_outbox_delivery_kind', '025_external_autonomous_submission_handoff']) {
      pending.push(`store/migrations/${name}.sql`);
    }
  }
  while (pending.length) {
    const relative = pending.pop(); if (graph.has(relative)) continue;
    const from = path.join(source, relative), to = path.join(root, relative); graph.set(relative, copy(from, to));
    if (!relative.endsWith('.mjs')) continue;
    const text = fs.readFileSync(from, 'utf8');
    for (const name of relativeModuleSpecifiers(text)) {
      const selected = path.relative(source, path.resolve(path.dirname(from), name));
      assert.ok(selected && !selected.startsWith(`..${path.sep}`) && !path.isAbsolute(selected)); pending.push(selected);
    }
    for (const match of text.matchAll(/new URL\(\s*(['"])([^'"\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/gu)) {
      const selected = path.resolve(path.dirname(from), match[2]);
      if (fs.existsSync(selected) && fs.lstatSync(selected).isFile()) {
        const relative = path.relative(source, selected); assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); pending.push(relative);
      }
    }
  }
  // Module initialization observes these actual fixed image inputs even on
  // help. Copy their original bytes; do not patch or bypass the Node mirror gate.
  function imageInputs(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const from = path.join(directory, name), stat = fs.lstatSync(from);
      if (stat.isDirectory()) imageInputs(from);
      else {
        assert.ok(stat.isFile() && !stat.isSymbolicLink());
        const relative = path.relative(source, from);
        graph.set(relative, copy(from, path.join(root, relative)));
      }
    }
  }
  imageInputs(path.join(source, 'runtime-images'));
  const databaseManifest = 'paper-core/config/autonomous-research-state-databases.v1.json';
  graph.set(databaseManifest, copy(path.join(source, databaseManifest), path.join(root, databaseManifest)));
  // Exact incumbent parser dependency closure; actual source and destination
  // bytes are pinned. The Node copy never falls back to an ambient package.
  const lockFile = path.join(source, 'package-lock.json'), lockPin = pin(lockFile);
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); assert.deepEqual(pin(lockFile), lockPin);
  graph.set('package-lock.json', copy(lockFile, path.join(root, 'package-lock.json')));
  for (const name of ['espree', 'eslint-scope', 'acorn', 'acorn-jsx', 'eslint-visitor-keys', 'esrecurse', 'estraverse']) {
    const selected = path.join(source, 'node_modules', name), manifest = path.join(selected, 'package.json');
    const metadata = pin(manifest), value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.deepEqual(pin(manifest), metadata); assert.equal(value.name, name);
    assert.equal(value.version, lock.packages[`node_modules/${name}`].version);
    function visit(directory) {
      for (const item of fs.readdirSync(directory).sort()) {
        const from = path.join(directory, item), stat = fs.lstatSync(from);
        const relative = path.join(name, path.relative(selected, from));
        if (stat.isDirectory()) visit(from);
        else { assert.ok(stat.isFile() && !stat.isSymbolicLink());
          assert.ok(dependencies.size < 4096); dependencies.set(relative,
            { from, ...copy(from, path.join(root, 'node_modules', relative)) }); }
      }
    }
    visit(selected);
  }
  graph.set('package.json', copy(path.join(source, 'package.json'), path.join(root, 'package.json')));
  markerPin = pin(path.join(root, 'package.json'));
  immutableCopyPins.set(path.join(root, 'package.json'), markerPin);
  fs.mkdirSync(path.join(root, 'relative-runtime'), { mode: 0o700 });
  fs.mkdirSync(path.join(caller, 'relative-runtime'), { mode: 0o700 });
  fs.writeFileSync(path.join(caller, 'package.json'), JSON.stringify({ name: 'hepta-paper-workspace', version: '999' }), { mode: 0o600 });
}
function close() {
  if (!fixture) return;
  try {
    assert.deepEqual(pin(binary), shippedPin); assert.deepEqual(pin(unknown), unknownPin);
    assert.deepEqual(pin(path.join(root, 'package.json')), markerPin);
    for (const [relative, expected] of dependencies) {
      assert.deepEqual(pin(expected.from), expected.source);
      assert.deepEqual(pin(path.join(root, 'node_modules', relative)), expected.copy);
    }
    for (const [relative, expected] of graph) {
      assert.deepEqual(pin(path.join(source, relative)), expected.source);
      assert.deepEqual(pin(path.join(root, relative)), expected.copy);
    }
  } catch (error) { keepFixture = true; throw error; }
  finally { if (!keepFixture) fs.rmSync(fixture, { recursive: true, force: false }); }
}
prepare();
const oracleScratch = path.join(fixture, 'oracle-scratch'); fs.mkdirSync(oracleScratch, { mode: 0o700 });
async function runOracle(name, input) {
  assert.ok(/^[a-z0-9-]+\.mjs$/u.test(name));
  const script = path.join(source, 'rust/oracle', name), before = pin(script);
  const observed = await run('oracle', [script], { TMPDIR: oracleScratch }, binary, null, JSON.stringify(input));
  assert.deepEqual(pin(script), before); return observed;
}
return { root, caller, binary, unknown, run, runOracle, snapshot, pin, close,
  preparation: { copiedEntries, copiedBytes, maximumBytes: 192 * 1024 * 1024, maximumEntries: 10000 } };
}
