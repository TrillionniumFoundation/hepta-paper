import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { buildNativeOwners, safeEnvironment } from '../../docs/tools/node-rust-route-acceptance.mjs';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';
import { qualificationFixtures } from '../../rust/oracle/journal-qualification-fixtures-v1.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

// Normal frontend observations on owned synthetic sources and authorities.
// They do not accept a whole route, a live portal, or an installed supervisor.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const routes = ['journal-connector-coverage', 'autonomous-supervisor-health'];
let fixture, root, caller, binary, unknown, graph, shippedPin, unknownPin, markerPin;
let keepFixture = false;
const dependencies = new Map();
const immutableCopyPins = new Map();
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
async function run(engine, args, additions = {}, executable = binary, interruptSignal = null) {
  const program = engine === 'node' ? process.execPath : executable;
  const argv = engine === 'node' ? [path.join(root, 'paper-core/bin/hepta-paper.mjs'), ...args] : args;
  const beganAt = Date.now();
  const child = spawn(program, argv, { cwd: caller, env: env(additions), shell: false,
    detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const primary = processPin(child.pid); assert.ok(primary); assert.equal(primary.group, child.pid);
  assert.equal(primary.session, child.pid); assert.equal(primary.uid, process.getuid());
  const pins = new Map([[primary.pid, primary]]); let failure, result, settled = false;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { settled = true; result = { status: code, signal,
      stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), beganAt, endedAt: Date.now() }; resolve(result); });
  });
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
      // Deliberately an unknown execution point, not a claim about a read or
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
      assert.ok(Date.now() < deadline, 'owned group did not stop within cleanup bound');
      for (const member of live) signalPinned(member, 'SIGKILL'); await delay(5);
    }
    if (failure) throw failure;
    if (!interruptSignal) assert.equal(result.signal, null, result.stderr);
    return result;
  } catch (error) {
    keepFixture = true;
    try { stop('SIGKILL'); await boundedClose(completion, 15_000, 'bounded failure cleanup exceeded'); }
    catch (cleanup) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); throw new AggregateError([error, cleanup]); }
    throw error;
  } finally { assert.ok(settled || keepFixture); }
}
function canonical(value, beganAt, endedAt) {
  if (value?.residentPrerequisites) {
    assert.equal(value.residentPrerequisites.inspectedAt, value.inspectedAt);
    const payload = { ...value.residentPrerequisites };
    const receipt = payload.autonomousResearchResidentPrerequisiteReceiptHash;
    delete payload.autonomousResearchResidentPrerequisiteReceiptHash;
    assert.equal(receipt, hashRecord('AutonomousResearchResidentPrerequisiteReceipt', payload),
      'validate actual receipt BEFORE comparing independent command times');
    if (value.strictMachineIntakeReconciliation != null) {
      assert.equal(value.strictMachineIntakeReconciliation.inspectedAt, value.inspectedAt);
    }
    value = { ...value, residentPrerequisites: { ...value.residentPrerequisites,
      autonomousResearchResidentPrerequisiteReceiptHash: '$VALIDATED_ACTUAL_CLOCK_RECEIPT' } };
  }
  if (Array.isArray(value)) return value.map(entry => canonical(entry, beganAt, endedAt));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === 'inspectedAt') {
      assert.match(entry, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
      assert.ok(beganAt <= Date.parse(entry) && Date.parse(entry) <= endedAt,
        'actual report timestamp outside its command interval');
      return [key, '$ACTUAL_COMMAND_TIME'];
    }
    return [key, canonical(entry, beganAt, endedAt)];
  }));
  return value;
}
async function pair(name, forwarded = [], additions = {}) {
  const args = ['operator', name, ...(forwarded.length ? ['--', ...forwarded] : [])];
  const before = snapshot(root), node = await run('node', args, additions), native = await run('native', args, additions);
  assert.equal(native.status, node.status, `${name}: ${forwarded}: ${native.stderr} / ${node.stderr}`);
  assert.equal(native.stdout.endsWith('\n'), node.stdout.endsWith('\n'));
  if (node.stdout) assert.deepEqual(canonical(JSON.parse(native.stdout), native.beganAt, native.endedAt), canonical(JSON.parse(node.stdout), node.beganAt, node.endedAt));
  else { assert.equal(native.stdout, ''); assert.ok(node.stderr.includes(native.stderr.trim()), `${native.stderr} / ${node.stderr}`); }
  assert.deepEqual(snapshot(root), before); return JSON.parse(node.stdout || 'null');
}
before(() => {
  const owners = buildNativeOwners().owners;
  fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.userInfo().homedir), '.hepta-readonly-normal-'));
  root = path.join(fixture, 'deployment'); caller = path.join(fixture, 'caller');
  fs.mkdirSync(caller, { mode: 0o700 }); fs.mkdirSync(path.join(root, 'paper-core/config'), { recursive: true, mode: 0o700 });
  binary = path.join(root, 'bin/hepta-paper-rust'); shippedPin = copy(owners['hepta-paper-rust'].path, binary, 0o550).copy;
  assert.equal(`sha256:${shippedPin.sha256}`, owners['hepta-paper-rust'].sha256);
  unknown = path.join(fixture, 'unknown/debug/deps/hepta-paper-rust'); unknownPin = copy(binary, unknown, 0o550).copy;
  const pending = ['paper-core/bin/hepta-paper.mjs', 'paper-core/bin/journal-connector-coverage.mjs',
    'paper-core/bin/autonomous-research-supervisor-health.mjs',
    'paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs']; graph = new Map();
  while (pending.length) {
    const relative = pending.pop(); if (graph.has(relative)) continue;
    const from = path.join(source, relative), to = path.join(root, relative); graph.set(relative, copy(from, to));
    if (!relative.endsWith('.mjs')) continue;
    for (const match of fs.readFileSync(from, 'utf8').matchAll(/(?:from\s+|import\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)) {
      const name = match[1]; if (name.startsWith('node:')) continue;
      if (['espree', 'eslint-scope'].includes(name)) continue;
      assert.ok(name.startsWith('.'), `unbound import: ${name}`);
      const selected = path.relative(source, path.resolve(path.dirname(from), name));
      assert.ok(selected && !selected.startsWith(`..${path.sep}`) && !path.isAbsolute(selected)); pending.push(selected);
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
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'hepta-paper-workspace', version: '0.21.0' }), { flag: 'wx', mode: 0o440 });
  markerPin = pin(path.join(root, 'package.json'));
  immutableCopyPins.set(path.join(root, 'package.json'), markerPin);
  fs.mkdirSync(path.join(root, 'relative-runtime'), { mode: 0o700 });
  fs.mkdirSync(path.join(caller, 'relative-runtime'), { mode: 0o700 });
  fs.writeFileSync(path.join(caller, 'package.json'), JSON.stringify({ name: 'hepta-paper-workspace', version: '999' }), { mode: 0o600 });
});
after(() => {
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
});

test('normal_readonly_registry_grammar_validates_every_actual_flag_before_io', async () => {
  for (const name of routes) {
    const route = resolveHeptaPaperCommand('operator', name);
    assert.equal(route.forwardingPolicy, 'registry'); assert.equal(route.forwardedArgumentSchema.positional, false);
    const { booleanFlags, valueFlags } = route.forwardedArgumentSchema;
    const cases = [['unexpected'], ['--'], ['--=x'], ['--unknown'], ['--action=run'], ['-'], ['-h']];
    for (const flag of booleanFlags) cases.push([`--${flag}=true`], [`--${flag}=`], [`--${flag}`, `--${flag}`]);
    for (const flag of valueFlags) cases.push([`--${flag}`], [`--${flag}=`], [`--${flag}`, ''],
      [`--${flag}`, '--help'], [`--${flag}=one`, `--${flag}=two`], [`--${flag}=one`, `--${flag}`]);
    for (const forwarded of cases) {
      const before = snapshot(root), args = ['operator', name, '--', ...forwarded];
      const node = await run('node', args), native = await run('native', args);
      assert.equal(node.status, 2, node.stderr); assert.equal(native.status, 2, native.stderr);
      assert.equal(node.stdout, ''); assert.equal(native.stdout, '');
      assert.equal(JSON.parse(native.stderr).error, JSON.parse(node.stderr).error);
      const unmarked = await run('native', args, {}, unknown);
      assert.equal(unmarked.status, 2); assert.equal(unmarked.stdout, '');
      assert.equal(JSON.parse(unmarked.stderr).error, JSON.parse(node.stderr).error,
        'the shared normal grammar must refuse before an unknown copied layout');
      assert.deepEqual(snapshot(root), before);
    }
    for (const args of [['operator', name, '--help'], ['operator', name, '--', '--help']]) {
      const node = await run('node', args), native = await run('native', args);
      assert.equal(native.status, node.status, `${native.stderr} / ${node.stderr}`);
      if (node.stdout) assert.deepEqual(JSON.parse(native.stdout), JSON.parse(node.stdout));
      else assert.equal(JSON.parse(native.stderr).error, JSON.parse(node.stderr).error);
    }
    for (const flag of valueFlags) for (const input of [[`--${flag}=missing`], [`--${flag}`, 'missing']]) {
      await pair(name, ['--help', ...input]);
    }
  }
});

test('normal_journal_full_values_venues_gates_and_kind_refusals_match_node', async () => {
  const report = await pair(routes[0]); await pair(routes[0], ['--summary']);
  for (const kind of ['journal', 'conference']) await pair(routes[0], [`--kind=${kind}`]);
  for (const entry of report.entries) await pair(routes[0], ['--venue', entry.venueId]);
  for (const flag of resolveHeptaPaperCommand('operator', routes[0]).forwardedArgumentSchema.booleanFlags.filter(flag => flag.startsWith('require-'))) {
    await pair(routes[0], [`--${flag}`]); await pair(routes[0], ['--venue=tmlr', `--${flag}`]);
  }
  for (const forwarded of [['--kind=invalid'], ['--venue=missing'], ['--venue=tmlr', '--kind=conference']]) await pair(routes[0], forwarded);
});

test('normal_health_modes_defaults_relative_runtime_and_unknown_copy_match_node', async () => {
  const modes = [[], ...resolveHeptaPaperCommand('operator', routes[1]).forwardedArgumentSchema.booleanFlags
    .filter(flag => flag.startsWith('require-')).map(flag => [`--${flag}`]),
    ['--require-fully-autonomous', '--require-strict-machine-intake-reconciliation']];
  for (const mode of modes) {
    await pair(routes[1], mode); await pair(routes[1], [...mode, '--runtime-root=relative-runtime']);
    await pair(routes[1], mode, { HEPTA_PAPER_RUNTIME_ROOT: './relative-runtime' });
  }
  for (const name of routes) {
    const selected = await run('native', ['operator', name], {}, unknown);
    assert.equal(selected.status, 1); assert.equal(selected.stdout, ''); assert.match(selected.stderr, /native_workspace_root_required/u);
    const explicit = await run('native', ['operator', name], { HEPTA_PAPER_WORKSPACE_ROOT: root }, unknown);
    const deployed = await run('native', ['operator', name]); assert.equal(explicit.status, deployed.status);
    assert.deepEqual(canonical(JSON.parse(explicit.stdout), explicit.beganAt, explicit.endedAt), canonical(JSON.parse(deployed.stdout), deployed.beganAt, deployed.endedAt));
  }
});

test('normal_journal_actual_synthetic_signed_inputs_are_readonly_and_relative_to_worker', async () => {
  const directory = path.join(root, 'qualification'); fs.mkdirSync(directory, { mode: 0o700 });
  for (const [index, input] of qualificationFixtures(Date.now()).entries()) {
    const registry = `qualification/registry-${index}.json`, trust = `qualification/trust-${index}.json`;
    fs.writeFileSync(path.join(root, registry), input.registryText, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(root, trust), input.trustText, { flag: 'wx', mode: 0o600 });
    const flags = ['--venue=tmlr', '--qualification-registry', registry,
      '--qualification-trust-store', trust, `--qualification-registry-hash=${input.expectedRegistryHash}`,
      `--qualification-trust-store-hash=${input.expectedTrustStoreHash}`];
    await pair(routes[0], flags);
    await pair(routes[0], ['--venue=tmlr'], {
      HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY: registry, HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH: input.expectedRegistryHash,
      HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE: trust, HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH: input.expectedTrustStoreHash,
    });
  }
});

test('normal_readonly_term_kill_unknown_execution_and_same_namespace_fresh_retry', async () => {
  for (const name of routes) for (const engine of ['node', 'native']) for (const signal of ['SIGTERM', 'SIGKILL']) {
    const before = snapshot(root), result = await run(engine, ['operator', name], {}, binary, signal);
    assert.equal(result.signal, signal); assert.equal(result.status, null); assert.deepEqual(snapshot(root), before);
    await pair(name);
  }
});
