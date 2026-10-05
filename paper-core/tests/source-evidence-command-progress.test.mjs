import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  createCommandProgress, executeCommands, verifyRepositorySourceEvidence,
  assertExactCargoOwnerExecution, exactCargoTestInventory,
} from '../bin/verify-source-implementation-evidence.mjs';
import { hashBytes } from '../src/source-evidence-producer.mjs';

// Pure controls only. Importing the entrypoint does not call main. The actual
// executor/CLI functions below run in an isolated VM with an in-memory fs,
// fake process/clock, fake pins and fake run. No verifier child, Cargo, ELF,
// native executable, signal, temporary fixture or global patch is used here.
const sourceText = fs.readFileSync(new URL('../bin/verify-source-implementation-evidence.mjs', import.meta.url), 'utf8');
function sourceBetween(start, end) {
  const from = sourceText.indexOf(start), to = sourceText.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `actual source function missing: ${start}`);
  return sourceText.slice(from, to);
}
const safeEnvironmentSource = sourceBetween('function safeExecutionEnvironment()', '// A successful test process');
const testAssertionSource = sourceBetween('function assertTestExecution(', '// Opt-in diagnostics only');
const diagnosticSource = sourceBetween('function commandDiagnostic(', 'function escaped(');
const parseSource = sourceBetween('function parseArguments(', 'export function verifyRepositorySourceEvidence(');
const mainSource = sourceBetween('function main()', '\nif (process.argv[1]');
const plain = value => JSON.parse(JSON.stringify(value));
const fail = (code, detail = '') => { throw new Error(`${code}${detail ? `: ${detail}` : ''}`); };
const fakeSource = { head: '1'.repeat(40), tree: '2'.repeat(40) };
const authorityKeys = ['externalAuthorityGranted', 'nodeRetirementAuthorized', 'productionActivated', 'targetHostQualified', 'writerCutoverAuthorized'];
const tap = 'ok 1 - selected owner\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const rustOutput = selector => `test ${selector} ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s\n`;
const nodeCommand = () => ({ program: 'node', args: ['--test', 'owner.test.mjs'], workdir: '.',
  expectedExitCode: 0, expectedTargets: ['owner.test.mjs'], timeoutSeconds: 1 });
function cargoCommand(selector, target = 'owners', ignored = false) {
  const discoveryPrefix = ['test', '--locked', '-p', 'fixture', '--test', target];
  return { program: 'cargo', args: [...discoveryPrefix, selector, '--', '--exact', ...(ignored ? ['--ignored'] : []), '--nocapture'],
    workdir: 'rust', expectedExitCode: 0, expectedTargets: ['rust/owners.rs'], timeoutSeconds: 1,
    ownerBinding: { discoveryPrefix, packageName: 'fixture', targetKind: 'integration', testTarget: target, selector } };
}
function bundlesOf(commands) {
  return new Map([['control', { commands, files: [
    { path: 'owner.test.mjs', mode: '100644', gitBlob: '3'.repeat(40), symbols: [{ kind: 'test', name: 'selected owner' }] },
    { path: 'rust/owners.rs', mode: '100644', gitBlob: '4'.repeat(40), symbols: [{ kind: 'test', name: 'one' }] },
  ] }]]);
}

function harness(options = {}) {
  const events = [], records = [], calls = [], stdout = [], stderr = [], writes = [], owners = [];
  const clock = { value: 0n };
  const env = { PATH: '/fake/toolchain', HOME: '/fake/home', GITHUB_ACTIONS: 'true', CI: 'true',
    SOURCE_EVIDENCE_PROGRESS: 'true', HEPTA_SOURCE_EVIDENCE_PROGRESS: 'true', PRIVATE_TOKEN: 'environment-secret', ...options.env };
  const bundles = options.bundles ?? bundlesOf(options.commands ?? [nodeCommand()]);
  const pin = executable => ({ path: executable, sha256: hashBytes(Buffer.from(executable)), identity: ['fixed-fake-pin'] });
  const producer = [{ path: 'fake-producer.mjs', mode: '100644', gitBlob: '5'.repeat(40), sha256: hashBytes(Buffer.from('producer')) }];
  const document = { registries: {}, repository: 'fixture/repository' };
  const evidenceBytes = Buffer.from(JSON.stringify(document));
  const advance = ms => { clock.value += BigInt(ms) * 1000000n; };
  const state = { events, records, calls, stdout, stderr, writes, owners, clock, advance, bundles };
  function recordPhase(line) {
    const row = JSON.parse(line);
    events.push(`progress:${row.phase}`);
    options.onPhase?.(row, state);
    options.write?.(line, state);
    records.push(row); stderr.push(line);
  }
  function fakeRun(program, args, runOptions) {
    const call = { program, args, options: runOptions };
    calls.push(call); events.push(`run:${args.includes('--version') ? 'qualification' : args.includes('--message-format=json') ? 'discovery' : args.length === 1 && args[0] === '--list' ? 'inventory' : 'owner'}`);
    advance(options.runMilliseconds ?? 7);
    if (options.run) return options.run(call, state);
    const output = args.includes('--version') ? 'cargo 1.98.0 (fake control)\nhost: x86_64-unknown-linux-gnu\n'
      : args.includes('--message-format=json') ? 'fake discovery payload secret\n'
        : args.length === 1 && args[0] === '--list' ? 'one: test\ntwo: test\n\n2 tests, 0 benchmarks\n'
          : program === 'node' ? tap : rustOutput(args[0]);
    return { pid: 100 + calls.length, status: 0, signal: null, stdout: output, stderr: 'child stderr secret\n' };
  }
  function binariesCurrent(root, images, final = false) {
    events.push(`binaries:${final ? 'final' : 'current'}`);
    options.validate?.('binaries', final, state, images);
  }
  function buildsCurrent(root, images, final = false) {
    events.push(`builds:${final ? 'final' : 'current'}`);
    options.validate?.('builds', final, state, images);
  }
  const context = vm.createContext({
    Buffer, path, hashBytes, fail, MAX_COMMAND_DIAGNOSTIC_BYTES: 8 * 1024,
    SHA1_PATTERN: /^[0-9a-f]{40}$/u, AUTHORITY_KEYS: authorityKeys,
    process: { env, version: 'v22.23.1', execPath: '/fake/toolchain/node', argv: [],
      hrtime: { bigint: () => { events.push('budget_clock'); return clock.value; } },
      stdout: { write: text => { stdout.push(text); return true; } },
      stderr: { write: text => { stderr.push(text); return true; } } },
    fs: {
      realpathSync: value => { events.push(`realpath:${value}`); return value; },
      statSync: value => { assert.equal(value, '/fake/toolchain/cargo'); return { isFile: () => true, mode: 0o100755 }; },
      writeSync: (fd, line) => { assert.equal(fd, 2); recordPhase(line); },
      mkdirSync: (value, settings) => { writes.push({ method: 'mkdir', value, settings }); },
      writeFileSync: (value, bytes, settings) => { writes.push({ method: 'write', value, bytes, settings }); },
    },
    run: fakeRun,
    artifactPin: executable => {
      events.push(`pin:${executable}`);
      options.pin?.(executable, state);
      return pin(executable);
    },
    producerPin: () => { events.push('producer_pin'); options.producer?.(state); return producer; },
    cargoTargetObservation: (root, binding) => {
      events.push('target_observation');
      options.validate?.('target', false, state);
      return { artifact: pin(`/fake/artifacts/${binding.testTarget}`),
        binaryArtifacts: [pin('/fake/artifacts/helper')],
        buildScripts: [{ ...pin('/fake/artifacts/build-script'), outDirectory: { path: '/fake/out' } }] };
    },
    holdCargoTestArtifactEpoch: artifact => {
      events.push('epoch_open');
      const owner = { artifact, closed: false,
        assertCurrent() { events.push('epoch_current'); options.validate?.('epoch', false, state); },
        finish() { events.push('epoch_finish'); options.validate?.('epoch', true, state); },
        close() { events.push('epoch_close'); owner.closed = true; },
      };
      owners.push(owner); return owner;
    },
    cargoEnvironmentObservation: (root, binding, artifact, text, pid) => {
      events.push('environment_observation'); options.validate?.('environment', false, state);
      return { cwd: '/source/rust/crates/fixture', environment: { PATH: '/fake/toolchain', CAPTURED_SECRET: 'captured-environment-secret' },
        environmentSha256: hashBytes(Buffer.from('captured environment')), processId: pid + 100, parentProcessId: pid };
    },
    assertCargoBinaryArtifactsCurrent: binariesCurrent,
    assertCargoBuildScriptsCurrent: buildsCurrent,
    exactCargoTestInventory: (...args) => { events.push('inventory_assertion'); options.validate?.('inventory', false, state); return exactCargoTestInventory(...args); },
    assertExactCargoOwnerExecution: (...args) => {
      events.push('owner_assertion_start');
      options.validate?.('owner', false, state);
      const result = assertExactCargoOwnerExecution(...args);
      events.push('owner_assertion_complete'); return result;
    },
    git: (root, args) => {
      if (args[0] === 'status') return '';
      assert.equal(args[0], 'rev-parse');
      return args[1] === 'HEAD' ? fakeSource.head : fakeSource.tree;
    },
    canonicalRelative: value => value,
    trackedBlob: () => ({ mode: '100644', blob: '6'.repeat(40) }),
    readPinnedSource: () => evidenceBytes,
    parseStrictJson: JSON.parse,
    validateEvidenceDocument: () => ({ bundles, promotions: [] }),
    assertSourceSubject: () => { events.push('source_subject'); options.subject?.(state); },
    captureCargoOwnerEnvironment: () => assert.fail('capture mode must not execute in pure controls'),
    console: { error: value => stderr.push(String(value)) },
  });
  vm.runInContext(`${safeEnvironmentSource}\n${diagnosticSource}\n${testAssertionSource}\n`
    + `const actualFormatter = (${createCommandProgress.toString()});\n`
    + `const executeCommands = (${executeCommands.toString()});\n`
    + `const verifyRepositorySourceEvidence = (${verifyRepositorySourceEvidence.toString()});\n`
    + `${parseSource}\n${mainSource}\n`
    + 'globalThis.api = { executeCommands, verifyRepositorySourceEvidence, parseArguments, main, actualFormatter, assertTestExecution };', context);
  const actualAssertion = context.api.assertTestExecution;
  context.assertTestExecution = (...args) => {
    events.push('node_assertion_start'); options.validate?.('node', false, state);
    const result = actualAssertion(...args);
    events.push('node_assertion_complete'); return result;
  };
  context.createCommandProgress = spec => {
    return context.api.actualFormatter({ ...spec,
      now: options.now ? () => options.now(state) : () => clock.value,
      write: recordPhase,
    });
  };
  return { ...state, context,
    execute: (...progress) => context.api.executeCommands('/source', bundles, fakeSource, ...progress),
    verify: settings => context.api.verifyRepositorySourceEvidence({ root: '/source', execute: true, ...settings }),
    cli: argv => { context.process.argv = ['/fake/toolchain/node', '/fake/runner.mjs', ...argv]; return context.api.main(); },
  };
}

const phases = h => h.records.map(row => row.phase);
function thrown(action) {
  let result;
  try { action(); } catch (error) { result = error; }
  assert(result, 'expected the original verification failure'); return result;
}

test('progress formatter emits bounded hashed identities and fixed fields without payloads', () => {
  const lines = [];
  let clock = 5000000n;
  const privateText = 'private-payload-'.repeat(10000);
  const command = { ...nodeCommand(), args: [privateText], workdir: privateText, expectedTargets: [privateText],
    env: { TOKEN: privateText }, stdout: privateText, stderr: privateText };
  const emit = createCommandProgress({ bundleId: privateText, index: 2, ordinal: 3, command, now: () => clock, write: line => lines.push(line) });
  emit('command_start'); clock += 9000000n; emit('child_exit', 0); emit('unknown-payload-phase', privateText);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert(line.endsWith('\n')); assert(Buffer.byteLength(line) <= 1024);
    assert(!line.includes('private-payload')); assert(!line.includes('TOKEN'));
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row).sort(), ['bundleSha256', 'commandSha256', 'elapsedMs', 'index', 'kind', 'ordinal', 'phase', 'program', 'status'].sort());
    assert.equal(row.kind, 'SourceEvidenceCommandProgressV1');
    assert.equal(row.bundleSha256, hashBytes(Buffer.from(privateText)));
    assert.equal(row.commandSha256, hashBytes(Buffer.from(JSON.stringify({ program: command.program, args: command.args,
      workdir: command.workdir, expectedTargets: command.expectedTargets, timeoutSeconds: command.timeoutSeconds, expectedExitCode: command.expectedExitCode }))));
    assert.equal(row.index, 2); assert.equal(row.ordinal, 3); assert.equal(row.program, 'node');
  }
  assert.equal(JSON.parse(lines[0]).status, null); assert.equal(JSON.parse(lines[1]).status, 0);
  assert.equal(JSON.parse(lines[1]).elapsedMs, 9);
});

test('formatter bounds indices program elapsed time and status and disables failed diagnostics', () => {
  const lines = []; let ticks = 0;
  const emit = createCommandProgress({ bundleId: 'x', index: -1, ordinal: Infinity,
    command: { ...nodeCommand(), program: 'secret-program-path' },
    now: () => ticks++ === 0 ? 0n : (BigInt(Number.MAX_SAFE_INTEGER) + 99n) * 1000000n,
    write: line => lines.push(JSON.parse(line)) });
  emit('child_exit', Infinity);
  assert.equal(lines[0].index, null); assert.equal(lines[0].ordinal, null);
  assert.equal(lines[0].program, 'unknown'); assert.equal(lines[0].status, null);
  assert.equal(lines[0].elapsedMs, Number.MAX_SAFE_INTEGER);
  for (const behavior of ['initial_throw', 'initial_number', 'later_throw', 'backwards', 'sink_throw']) {
    let nowCalls = 0, writeCalls = 0;
    const diagnostic = createCommandProgress({ bundleId: 'x', index: 0, ordinal: 0, command: nodeCommand(),
      now: () => {
        nowCalls += 1;
        if (behavior === 'initial_throw' || (behavior === 'later_throw' && nowCalls > 1)) throw new Error('clock failure');
        if (behavior === 'initial_number') return 0;
        return behavior === 'backwards' && nowCalls > 1 ? -1n : 0n;
      },
      write: () => { writeCalls += 1; if (behavior === 'sink_throw') throw new Error('sink failure'); },
    });
    assert.doesNotThrow(() => { diagnostic('command_start'); diagnostic('child_exit', 0); diagnostic('command_failed', 0); });
    assert.equal(writeCalls, behavior === 'sink_throw' ? 1 : 0, behavior);
    assert.equal(nowCalls, ['initial_throw', 'initial_number'].includes(behavior) ? 1 : 2, behavior);
  }
});

test('default and nonliteral library options remain silent even in CI-like environments', () => {
  const baseline = harness(), expected = plain(baseline.execute());
  for (const value of [undefined, false, 0, 1, 'true', { progress: true }]) {
    const h = harness();
    assert.deepEqual(plain(value === undefined ? h.execute() : h.execute(value)), expected);
    assert.deepEqual(h.stderr, []); assert.deepEqual(h.stdout, []); assert.deepEqual(h.records, []);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.env.GITHUB_ACTIONS, undefined);
    assert.equal(h.calls[0].options.env.PRIVATE_TOKEN, undefined);
  }
});

test('successful Node progress follows complete output assertion and remaining-budget check', () => {
  const off = harness(), on = harness();
  assert.deepEqual(plain(on.execute(true)), plain(off.execute()));
  assert.deepEqual(phases(on), ['command_start', 'child_start', 'child_exit', 'command_validated']);
  const exit = on.events.indexOf('progress:child_exit'), validated = on.events.indexOf('progress:command_validated');
  assert.deepEqual(on.events.slice(exit + 1, validated), ['node_assertion_start', 'node_assertion_complete', 'budget_clock', 'budget_clock']);
  assert.equal(on.records.at(-1).status, 0); assert.equal(on.records.at(-1).elapsedMs, 7);
  assert.equal(on.calls[0].args, on.bundles.get('control').commands[0].args);
  assert.equal(on.calls[0].options.timeout, 1000); assert.deepEqual(on.stdout, []);
  assert(!on.stderr.join('').includes('child stderr secret'));
  assert(!on.stderr.join('').includes('selected owner'));
});

test('logical ordinals span bundles while local indices preserve declared command order', () => {
  const first = bundlesOf([nodeCommand(), nodeCommand()]).get('control');
  const second = bundlesOf([nodeCommand()]).get('control');
  const h = harness({ bundles: new Map([['first', first], ['second', second]]) });
  const result = h.execute(true), starts = h.records.filter(row => row.phase === 'command_start');
  assert.deepEqual(starts.map(row => [row.index, row.ordinal]), [[0, 0], [1, 1], [0, 2]]);
  assert.deepEqual(plain(result.observations.map(row => [row.bundleId, row.index])), [['first', 0], ['first', 1], ['second', 0]]);
  assert.equal(new Set(starts.map(row => row.bundleSha256)).size, 2);
  assert.equal(new Set(starts.map(row => row.commandSha256)).size, 1);
});

test('nonzero signal spawn and zero-exit assertion failures retain original errors and never validate', () => {
  const spawnError = new Error('process_spawn_failed: exact original failure');
  const cases = [
    { name: 'nonzero', run: () => ({ status: 9, signal: null, stdout: 'private stdout', stderr: 'private stderr' }), code: /verification_command_failed/u, status: 9 },
    { name: 'timeout', run: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }), code: /"timedOut":true/u, status: null },
    { name: 'spawn', run: () => { throw spawnError; }, code: /process_spawn_failed/u, status: null },
    { name: 'assertion', run: () => ({ status: 0, stdout: '', stderr: '' }), code: /verification_test_execution_incomplete/u, status: 0 },
  ];
  for (const scenario of cases) {
    const off = harness(scenario), on = harness(scenario);
    const original = thrown(() => off.execute()), diagnosed = thrown(() => on.execute(true));
    assert.equal(diagnosed.message, original.message, scenario.name); assert.match(diagnosed.message, scenario.code);
    if (scenario.name === 'spawn') assert.equal(diagnosed, spawnError);
    assert(!phases(on).includes('command_validated')); assert.equal(phases(on).at(-1), 'command_failed');
    assert.equal(on.records.at(-1).status, scenario.status); assert.equal(on.calls.length, 1);
    assert(!on.stderr.join('').includes('private stdout')); assert(!on.stderr.join('').includes('private stderr'));
  }
});

test('diagnostic clock and sink failures preserve both verification success and original failure', () => {
  for (const diagnostic of [
    { now: () => { throw new Error('diagnostic clock unavailable'); } },
    { write: () => { throw new Error('diagnostic sink unavailable'); } },
  ]) {
    const original = harness(), observed = harness(diagnostic);
    assert.deepEqual(plain(observed.execute(true)), plain(original.execute()));
    const validationError = new Error('original owner validation failure');
    const failing = harness({ ...diagnostic, validate: () => { throw validationError; } });
    assert.equal(thrown(() => failing.execute(true)), validationError);
    assert.equal(failing.calls.length, 1);
  }
});

test('progress cannot refresh the original deadline or admit a child after the budget expires', () => {
  const h = harness({ onPhase: (row, state) => {
    if (row.phase === 'command_start' || row.phase === 'child_start') state.advance(500);
  } });
  assert.match(thrown(() => h.execute(true)).message, /verification_command_budget_exhausted: control:0/u);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(phases(h), ['command_start', 'child_start', 'command_failed']);
  const afterExit = harness({ commands: [nodeCommand(), nodeCommand()], onPhase: (row, state) => {
    if (row.phase === 'child_exit') state.advance(1000);
  } });
  assert.match(thrown(() => afterExit.execute(true)).message, /verification_command_budget_exhausted: control:0/u);
  assert.equal(afterExit.calls.length, 1); assert(!phases(afterExit).includes('command_validated'));
  assert(afterExit.events.includes('node_assertion_complete'));
});

test('Cargo controls preserve qualification discovery inventory independent owners and final pins', () => {
  const commands = [cargoCommand('one'), cargoCommand('two', 'owners', true)];
  const off = harness({ commands }), on = harness({ commands });
  const original = off.execute(), result = on.execute(true);
  assert.deepEqual(plain(result), plain(original));
  assert.deepEqual(phases(on), ['command_start', 'runtime_qualification_start', 'runtime_qualification_exit',
    'cargo_discovery_start', 'cargo_discovery_exit', 'test_inventory_start', 'test_inventory_exit',
    'child_start', 'child_exit', 'command_validated', 'command_start', 'child_start', 'child_exit',
    'command_validated', 'final_validation_start', 'final_validation_complete']);
  assert.equal(result.targets.length, 1); assert.equal(result.observations.length, 2);
  assert.equal(on.calls.length, 5); assert.equal(on.owners.length, 1); assert(on.owners[0].closed);
  assert.deepEqual(on.calls.map(call => call.options.timeout), [1000, 993, 986, 979, 1000]);
  assert.deepEqual(plain(on.calls.slice(3).map(call => call.args)), [['one', '--exact', '--nocapture'], ['two', '--exact', '--ignored', '--nocapture']]);
  assert.notEqual(result.observations[0].physicalInvocation.processId, result.observations[1].physicalInvocation.processId);
  assert.equal(on.calls[3].options.env, on.calls[4].options.env);
  assert.equal(result.observations[0].executionTargetId, result.observations[1].executionTargetId);
  for (let index = 0; index < on.events.length; index += 1) {
    if (on.events[index] !== 'progress:child_exit') continue;
    const validated = on.events.indexOf('progress:command_validated', index);
    assert.deepEqual(on.events.slice(index + 1, validated), ['owner_assertion_start', 'owner_assertion_complete',
      'binaries:current', 'builds:current', 'epoch_current', 'budget_clock', 'budget_clock']);
  }
  const finalStart = on.events.indexOf('progress:final_validation_start');
  assert.deepEqual(on.events.slice(finalStart + 1), ['epoch_finish', 'binaries:final', 'builds:final',
    'pin:/fake/toolchain/cargo', 'pin:/fake/toolchain/node', 'producer_pin', 'budget_clock',
    'progress:final_validation_complete', 'epoch_close']);
  assert.equal(on.events.filter(value => value === 'inventory_assertion').length, 1);
  assert(!on.stderr.join('').includes('captured-environment-secret')); assert(!on.stderr.join('').includes('fake discovery payload'));
  assert.deepEqual(on.stdout, []);
});

test('Cargo discovery and inventory failures retain exit phases and stop subsequent fake runs', () => {
  for (const failedPhase of ['qualification', 'discovery', 'inventory']) {
    const make = () => harness({ commands: [cargoCommand('one')], run: (call, state) => {
      const phase = call.args.includes('--version') ? 'qualification' : call.args.includes('--message-format=json') ? 'discovery' : 'inventory';
      return { pid: 100 + state.calls.length, status: phase === failedPhase ? 7 : 0,
        stdout: phase === 'qualification' ? 'cargo 1.98.0 (fake)\nhost: x86_64-unknown-linux-gnu\n' : '', stderr: 'private discovery failure' };
    } });
    const off = make(), on = make();
    assert.equal(thrown(() => on.execute(true)).message, thrown(() => off.execute()).message);
    assert.equal(on.calls.length, ['qualification', 'discovery', 'inventory'].indexOf(failedPhase) + 1);
    assert.equal(phases(on).at(-1), 'command_failed'); assert(!phases(on).includes('command_validated'));
    const expectedExit = { qualification: 'runtime_qualification_exit', discovery: 'cargo_discovery_exit', inventory: 'test_inventory_exit' }[failedPhase];
    assert.equal(on.records.find(row => row.phase === expectedExit).status, 7);
    assert(on.owners.every(owner => owner.closed));
  }
});

test('Cargo remaining budget includes discovery and blocks inventory without resetting', () => {
  const h = harness({ commands: [cargoCommand('one')], onPhase: (row, state) => {
    if (row.phase === 'cargo_discovery_exit') state.advance(1000);
  } });
  assert.match(thrown(() => h.execute(true)).message, /verification_command_budget_exhausted/u);
  assert.equal(h.calls.length, 2); assert(h.owners.every(owner => owner.closed));
  assert(!phases(h).includes('test_inventory_exit')); assert(!phases(h).includes('child_start'));
  assert(!phases(h).includes('command_validated')); assert.equal(phases(h).at(-1), 'command_failed');
});

test('Cargo zero-exit owner assertion failure never validates and always closes its epoch', () => {
  const failure = new Error('original exact owner failure');
  const h = harness({ commands: [cargoCommand('one')], validate: stage => { if (stage === 'owner') throw failure; } });
  assert.equal(thrown(() => h.execute(true)), failure);
  assert.equal(h.records.find(row => row.phase === 'child_exit').status, 0);
  assert(!phases(h).includes('command_validated')); assert(!phases(h).includes('final_validation_start'));
  assert(h.owners[0].closed); assert.equal(h.records.at(-1).status, 0);
});

test('every final Cargo validation failure preserves its error and closes all artifact owners', () => {
  for (const stage of ['epoch', 'binaries', 'builds', 'runtime', 'producer', 'budget']) {
    const failure = new Error(`original final ${stage} failure`);
    let finalStarted = false;
    const h = harness({ commands: [cargoCommand('one', 'a'), cargoCommand('two', 'b')],
      onPhase: (row, state) => {
        if (row.phase === 'final_validation_start') { finalStarted = true; if (stage === 'budget') state.advance(1000); }
      },
      validate: (current, final) => { if (final && current === stage) throw failure; },
      pin: () => { if (finalStarted && stage === 'runtime') throw failure; },
      producer: () => { if (finalStarted && stage === 'producer') throw failure; },
    });
    const error = thrown(() => h.execute(true));
    if (stage === 'budget') assert.match(error.message, /verification_command_budget_exhausted/u);
    else assert.equal(error, failure);
    assert.equal(h.owners.length, 2); assert(h.owners.every(owner => owner.closed));
    assert.equal(phases(h).filter(value => value === 'command_validated').length, 2);
    assert(!phases(h).includes('final_validation_complete')); assert.equal(phases(h).at(-1), 'command_failed');
    assert.deepEqual(h.events.slice(-2), ['epoch_close', 'epoch_close']);
  }
});

test('actual CLI parser enables diagnostics only with explicit --progress', () => {
  const h = harness();
  assert.equal(h.context.api.parseArguments([]).progress, false);
  assert.equal(h.context.api.parseArguments(['--execute']).progress, false);
  assert.equal(h.context.api.parseArguments(['--execute', '--progress']).progress, true);
  assert.equal(h.context.api.parseArguments(['--progress', '--root', '/source']).root, '/source');
  assert.match(thrown(() => h.context.api.parseArguments(['--progress=true'])).message, /cli_argument_unknown/u);
});

test('verify API and CLI preserve stdout and receipt bytes and keep progress out of receipt authority', () => {
  const off = harness(), on = harness();
  off.cli(['--execute', '--root', '/source', '--receipt', '/fake/receipt.json']);
  on.cli(['--execute', '--progress', '--root', '/source', '--receipt', '/fake/receipt.json']);
  assert.deepEqual(on.stdout, off.stdout); assert.deepEqual(plain(on.writes), plain(off.writes));
  assert.deepEqual(off.stderr, []); assert.equal(on.records.length, 4);
  const receipt = JSON.parse(on.stdout[0]);
  assert.deepEqual(Object.keys(receipt).sort(), ['authorityClaims', 'commandObservations', 'executionTargets', 'evidence', 'kind', 'promotions', 'repository', 'source', 'status', 'verificationCommandsExecuted', 'version'].sort());
  assert.deepEqual(Object.keys(receipt.commandObservations[0]).sort(), ['args', 'bundleId', 'elapsedMs', 'expectedExitCode', 'index', 'program', 'status', 'stderrSha256', 'stdoutSha256', 'timedOut', 'workdir'].sort());
  assert(Object.values(receipt.authorityClaims).every(value => value === false));
  const written = on.writes.find(row => row.method === 'write');
  assert.equal(written.bytes, on.stdout[0]); assert.deepEqual(plain(written.settings), { encoding: 'utf8', flag: 'wx', mode: 0o444 });
  assert(!on.stdout[0].includes('SourceEvidenceCommandProgressV1'));
  for (const progress of [undefined, false, 'true', 1]) {
    const h = harness();
    assert.deepEqual(plain(h.verify({ progress })), receipt); assert.deepEqual(h.stderr, []);
  }
  const noExecute = harness(); noExecute.cli(['--progress', '--root', '/source']);
  assert.equal(noExecute.calls.length, 0); assert.deepEqual(noExecute.stderr, []);
  assert.equal(JSON.parse(noExecute.stdout[0]).verificationCommandsExecuted, false);
});

test('failed source subject validation cannot publish a receipt or successful CLI stdout', () => {
  let checks = 0;
  const failure = new Error('original final source drift');
  const h = harness({ subject: () => { checks += 1; if (checks === 2) throw failure; } });
  assert.equal(thrown(() => h.cli(['--execute', '--progress', '--root', '/source', '--receipt', '/fake/receipt.json'])), failure);
  assert.deepEqual(h.stdout, []); assert.deepEqual(h.writes, []);
  assert.deepEqual(phases(h), ['command_start', 'child_start', 'child_exit', 'command_validated']);
});
