import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { parse } from 'espree';
import {
  assertExactCargoOwnerExecution, cargoTargetObservation, cargoEnvironmentObservation, exactCargoTestInventory,
  validateCommand, verifyRepositorySourceEvidence,
  SOURCE_EVIDENCE_PRODUCER_PATHS,
} from '../bin/verify-source-implementation-evidence.mjs';
const fixtureTempParent = fs.realpathSync(os.tmpdir());

function command(root, program, args) {
  const output = spawnSync(program, args, { cwd: root, encoding: 'utf8', shell: false,
    timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CARGO_HOME: process.env.CARGO_HOME, GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(output.error, undefined); assert.equal(output.signal, null);
  assert.equal(output.status, 0, output.stderr); return output.stdout.trim();
}
function write(root, relative, bytes) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function fixture(t, { firstOwnerBody, firstSelector } = {}) {
  const root = fs.mkdtempSync(path.join(fixtureTempParent, 'hepta-source-batch-fixture-'));
  const target = fs.mkdtempSync(path.join(fixtureTempParent, 'hepta-source-batch-target-'));
  const cleanup = fs.mkdtempSync(path.join(fixtureTempParent, 'hepta-source-batch-cleanup-'));
  const cargoHome = fs.mkdtempSync(path.join(fixtureTempParent, 'hepta-source-batch-cargo-home-'));
  const retention = { required: false };
  const original = Object.fromEntries(['PATH', 'CARGO_TARGET_DIR', 'TMPDIR', 'CARGO_HOME'].map(key => [key, process.env[key]]));
  const cargo = command(root, 'rustup', ['which', '--toolchain', '1.98.0', 'cargo']);
  process.env.PATH = `${path.dirname(cargo)}${path.delimiter}${original.PATH || ''}`;
  process.env.CARGO_TARGET_DIR = target; process.env.TMPDIR = cleanup; process.env.CARGO_HOME = cargoHome;
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (!retention.required) for (const owned of [root, target, cleanup, cargoHome]) fs.rmSync(owned, { recursive: true });
  });
  command(root, 'git', ['init', '--quiet']);
  command(root, 'git', ['config', 'user.name', 'Hepta Execution Test']);
  command(root, 'git', ['config', 'user.email', 'execution@example.invalid']);
  for (const relative of SOURCE_EVIDENCE_PRODUCER_PATHS) {
    write(root, relative, fs.readFileSync(new URL(`../../${relative}`, import.meta.url)));
  }
  write(root, 'rust/Cargo.toml', '[workspace]\nmembers=["crates/fixture"]\nresolver="3"\n');
  write(root, 'rust/crates/fixture/Cargo.toml', '[package]\nname="fixture"\nversion="0.1.0"\nedition="2024"\n');
  write(root, 'rust/crates/fixture/src/lib.rs', `#[cfg(test)] mod tests {
    #[test] fn cargo_environment() { ${firstOwnerBody ?? 'assert_eq!(std::env::var("CARGO_MANIFEST_DIR").unwrap(), env!("CARGO_MANIFEST_DIR")); assert_eq!(std::env::var("CARGO_PKG_NAME").unwrap(), "fixture");'} }
    #[test] fn owned_cleanup() { let p=std::env::temp_dir().join(format!("owned-{}",std::process::id())); std::fs::write(&p,b"actual").unwrap(); assert_eq!(std::fs::read(&p).unwrap(),b"actual"); std::fs::remove_file(&p).unwrap(); assert!(!p.exists()); }
    #[test] #[ignore="selected recovery owner"] fn ignored_recovery() { assert!(std::env::var("CARGO").unwrap().ends_with("cargo")); }
}
`);
  write(root, 'rust/crates/fixture/tests/owners.rs', '#[path = "owners/nested.rs"] mod nested;\n');
  write(root, 'rust/crates/fixture/tests/owners/nested.rs', `#[test] fn integration_environment() { assert_eq!(std::env::var("CARGO_MANIFEST_DIR").unwrap(), env!("CARGO_MANIFEST_DIR")); assert!(option_env!("CARGO_TARGET_TMPDIR").is_some()); }
#[test] fn second_owner() { assert_eq!(std::env::var("CARGO_PKG_NAME").unwrap(), "fixture"); }
`);
  command(path.join(root, 'rust'), cargo, ['generate-lockfile', '--offline']);
  write(root, 'docs/system/truth/work-items.v2.json', JSON.stringify({ schemaVersion: 2,
    items: { 'TEST-001': { state: 'source_implemented', moduleId: 'module.example', capabilityIds: ['CAP-EXAMPLE'], evidenceTier: 'source' } } }));
  write(root, 'docs/system/truth/modules.v1.json', JSON.stringify({ schemaVersion: 1, modules: { 'module.example': { state: 'source_implemented' } } }));
  write(root, 'docs/system/truth/capabilities.v1.json', JSON.stringify({ schemaVersion: 1, capabilities: { 'CAP-EXAMPLE': { state: 'source_implemented' } } }));
  const lib = 'rust/crates/fixture/src/lib.rs'; const integration = 'rust/crates/fixture/tests/owners/nested.rs';
  const files = [[lib, ['cargo_environment', 'owned_cleanup', 'ignored_recovery']], [integration, ['integration_environment', 'second_owner']]]
    .map(([relative, names]) => ({ path: relative, mode: '100644', gitBlob: command(root, 'git', ['hash-object', relative]),
      language: 'rust', role: relative === lib ? 'implementation' : 'test', symbols: names.map(name => ({ kind: 'test', name })) }));
  const declarations = [
    [lib, ['--lib', firstSelector ?? 'tests::cargo_environment']], [lib, ['--lib', 'tests::owned_cleanup']],
    [integration, ['--test', 'owners', 'nested::integration_environment']], [integration, ['--test', 'owners', 'nested::second_owner']],
    [lib, ['--lib', 'tests::ignored_recovery'], true],
  ].map(([relative, args, ignored]) => ({ program: 'cargo', args: ['test', '--locked', '-p', 'fixture', ...args, '--', '--exact', ...(ignored ? ['--ignored'] : []), '--nocapture'],
    workdir: 'rust', expectedExitCode: 0, timeoutSeconds: 30, expectedTargets: [relative] }));
  const document = { $schema: '../schemas/source-implementation-evidence-v1.schema.json', schemaVersion: 1,
    kind: 'RepositorySourceImplementationEvidenceV1', repository: 'TrillionniumFoundation/hepta-paper',
    subjectPolicy: 'current_clean_git_head_tree_and_exact_blobs',
    promotionPolicy: 'semantic_registry_binding_plus_exact_git_blobs_plus_executable_owner_tests',
    registries: { workItems: 'docs/system/truth/work-items.v2.json', modules: 'docs/system/truth/modules.v1.json', capabilities: 'docs/system/truth/capabilities.v1.json' },
    bundles: { 'actual-source': { description: 'Actual Cargo environment, exact owners, ignored recovery and fixture cleanup.', files, verificationCommands: declarations } },
    records: { 'TEST-001': { workItemId: 'TEST-001', moduleId: 'module.example', capabilityIds: ['CAP-EXAMPLE'], evidenceTier: 'source', bundleIds: ['actual-source'], promotionRequested: false,
      authorityClaims: { externalAuthorityGranted: false, nodeRetirementAuthorized: false, productionActivated: false, targetHostQualified: false, writerCutoverAuthorized: false } } } };
  write(root, 'docs/system/evidence/repository-source-implementation-v1.json', JSON.stringify(document));
  command(root, 'git', ['add', '.']); command(root, 'git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'actual fixture']);
  return { root, target, cleanup, declarations, files, retention };
}

test('same-subject Cargo target reuse preserves independent real owners, environment, ignored execution and cleanup', t => {
  const f = fixture(t);
  const receipt = verifyRepositorySourceEvidence({ root: f.root, execute: true });
  assert.equal(receipt.commandObservations.length, 5); assert.equal(receipt.executionTargets.length, 2);
  assert.deepEqual(receipt.commandObservations.map(row => row.args), f.declarations.map(row => row.args));
  const processes = receipt.commandObservations.map(row => row.physicalInvocation.processId);
  assert.equal(new Set(processes).size, 5, 'every selected owner remains a separate actual process');
  for (const [index, row] of receipt.commandObservations.entries()) {
    assert.equal(row.status, 0); assert.equal(row.physicalInvocation.args[0], f.declarations[index].args[f.declarations[index].args.indexOf('--')-1]);
    assert.equal(row.actualTestCounts.passed, 1); assert.equal(row.actualTestCounts.failed, 0); assert.equal(row.actualTestCounts.ignored, 0); assert.equal(row.actualTestCounts.measured, 0);
    assert.equal(row.actualTestSelector, row.physicalInvocation.args[0]);
    assert(row.physicalInvocation.timeoutMs > 0 && row.physicalInvocation.timeoutMs <= 30_000);
  }
  assert.equal(receipt.commandObservations[0].executionTargetId, receipt.commandObservations[4].executionTargetId);
  for (const target of receipt.executionTargets) {
    assert.deepEqual(target.source, receipt.source); assert.equal(target.discovery.status, 0); assert.equal(target.inventory.status, 0);
    assert.equal(target.runtime.cargo.version.startsWith('cargo 1.98.0 '), true);
    assert.equal(target.capture.parentProcessId, target.discovery.processId);
    assert.equal(target.inventory.program, target.artifact.path);
    assert.deepEqual(target.inventory.args, ['--list']);
    assert.deepEqual(target.producer.map(row => row.path), SOURCE_EVIDENCE_PRODUCER_PATHS);
  }
  assert.deepEqual(fs.readdirSync(f.cleanup), []);
  assert(Object.values(receipt.authorityClaims).every(value => value === false));
  const again = verifyRepositorySourceEvidence({ root: f.root, execute: true });
  assert.notEqual(again.executionTargets[0].discovery.processId, receipt.executionTargets[0].discovery.processId);
  assert.notEqual(again.executionTargets[0], receipt.executionTargets[0]);
  assert.deepEqual(fs.readdirSync(f.cleanup), []);
});

test('independent owner transcripts reject extra missing duplicate failed ignored measured and ambiguous summaries', () => {
  const selected = 'one';
  const rows = 'test one ... ok\n';
  const summary = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s\n';
  assert.equal(assertExactCargoOwnerExecution(selected, rows + summary, 'control').rows.length, 1);
  for (const bad of [
    rows + 'test extra ... ok\n' + summary,
    rows.replace('test one ... ok\n', '') + summary,
    rows + 'test one ... ok\n' + summary,
    rows.replace('one ... ok', 'two ... FAILED') + summary,
    rows.replace('one ... ok', 'two ... ignored') + summary,
    rows + summary.replace('0 ignored', '1 ignored'),
    rows + summary.replace('0 measured', '1 measured'),
    rows + summary + summary, rows + summary.replace('1 passed', '2 passed'),
    rows + summary + summary.replace('result: ok.', 'result: FAILED.'),
  ]) assert.throws(() => assertExactCargoOwnerExecution(selected, bad, 'adversarial'), /verification_test_execution_incomplete/u);
  assert.throws(() => assertExactCargoOwnerExecution('', rows + summary, 'empty selector'), /verification_selector_invalid/u);
});

test('capture bindings and actual inventory reject arbitrary parent source launcher cwd argv and environment', () => {
  const root = '/fixture', binding = { packageName: 'fixture' }, artifact = { path: '/target/test-owner' };
  const runtime = { node: { path: '/qualified/node' }, cargo: { path: '/qualified/cargo' } };
  const row = { kind: 'CargoOwnerEnvironmentCaptureV1', version: 1, processId: 101, parentProcessId: 100,
    script: '/fixture/paper-core/bin/verify-source-implementation-evidence.mjs', node: '/qualified/node',
    cwd: '/fixture/rust/crates/fixture', executable: '/target/test-owner', args: ['--list'],
    environment: { PATH: '/qualified/bin', CARGO: '/qualified/cargo', CARGO_MANIFEST_DIR: '/fixture/rust/crates/fixture', CARGO_PKG_NAME: 'fixture' } };
  const read = value => cargoEnvironmentObservation(root, binding, artifact, JSON.stringify(value), 100, runtime, 'capture control', { PATH: '/qualified/bin' });
  assert.equal(read(row).processId, 101);
  for (const bad of [
    { ...row, parentProcessId: 99 }, { ...row, script: '/foreign/script' }, { ...row, node: '/foreign/node' },
    { ...row, cwd: '/foreign/cwd' }, { ...row, executable: '/foreign/artifact' }, { ...row, args: ['--ignored'] },
    { ...row, extra: true }, { ...row, environment: { ...row.environment, CARGO: '/foreign/cargo' } },
    { ...row, environment: { ...row.environment, CARGO_MANIFEST_DIR: '/foreign/cwd' } },
    { ...row, environment: { ...row.environment, CARGO_PKG_NAME: 'foreign' } },
    { ...row, environment: { ...row.environment, PATH: 1 } },
    { ...row, environment: { ...row.environment, PATH: '/foreign/path' } },
    { ...row, environment: { ...row.environment, FOREIGN_ENV: 'arbitrary' } },
  ]) assert.throws(() => read(bad), /verification_capture_binding_invalid/u);
  assert.throws(() => cargoEnvironmentObservation(root, binding, artifact, JSON.stringify(row)+'\n'+JSON.stringify(row), 100, runtime, 'duplicate', { PATH: '/qualified/bin' }), /verification_capture_cardinality/u);
  assert.deepEqual(exactCargoTestInventory('one: test\ntwo: test\n2 tests, 0 benchmarks\n', 'inventory'), ['one', 'two']);
  for (const text of ['one: test\none: test\n2 tests, 0 benchmarks\n', 'one: test\n2 tests, 0 benchmarks\n', 'one: test\n1 test, 1 benchmark\n', 'one: test\n']) {
    assert.throws(() => exactCargoTestInventory(text, 'adversarial'), /verification_discovery_invalid/u);
  }
});

test('actual artifact parser rejects duplicate foreign-source and aliased executable observations', t => {
  const f = fixture(t); const receipt = verifyRepositorySourceEvidence({ root: f.root, execute: true });
  const a = receipt.executionTargets[0].artifact;
  const binding = validateCommand(f.declarations[0], 'actual', new Set(f.files.map(row => row.path))).ownerBinding;
  const row = { reason: 'compiler-artifact', profile: { test: true }, executable: a.path,
    manifest_path: a.manifestPath, target: { name: a.targetName, kind: a.targetKind, src_path: a.sourcePath } };
  const list = 'tests::cargo_environment: test\ntests::owned_cleanup: test\n';
  const text = JSON.stringify(row) + '\n' + list;
  assert.equal(cargoTargetObservation(f.root, binding, text, 'actual control').artifact.sha256, a.sha256);
  assert.throws(() => cargoTargetObservation(f.root, binding, JSON.stringify(row) + '\n' + text, 'duplicate'), /verification_artifact_cardinality/u);
  assert.throws(() => cargoTargetObservation(f.root, binding, JSON.stringify({ ...row, target: { ...row.target, src_path: path.join(f.root, 'foreign.rs') } }) + '\n' + list, 'foreign source'), /verification_artifact_source_invalid/u);
  assert.throws(() => cargoTargetObservation(f.root, binding, text + list, 'duplicate inventory'), /verification_discovery_invalid/u);
  const alias = a.path + '.alias'; fs.symlinkSync(a.path, alias);
  assert.throws(() => cargoTargetObservation(f.root, binding, JSON.stringify({ ...row, executable: alias }) + '\n' + list, 'alias'), /verification_artifact_path_invalid/u);
});

test('actual failed owner refuses a receipt and closes its owned temporary file', t => {
  const failed = fixture(t, { firstOwnerBody: 'let p=std::env::temp_dir().join("failed-owner"); std::fs::write(&p,b"owned").unwrap(); std::fs::remove_file(&p).unwrap(); panic!("actual-owner-failure");' });
  const failedReceipt = path.join(failed.target, 'failure-receipt.json');
  assert.throws(() => verifyRepositorySourceEvidence({ root: failed.root, execute: true, receipt: failedReceipt }), /verification_command_failed/u);
  assert.equal(fs.existsSync(failedReceipt), false); assert.deepEqual(fs.readdirSync(failed.cleanup), []);
});

test('missing compiled selector refuses a receipt without a successful owner observation', t => {
  const missing = fixture(t, { firstSelector: 'tests::absent_scope::cargo_environment' });
  const missingReceipt = path.join(missing.target, 'missing-receipt.json');
  assert.throws(() => verifyRepositorySourceEvidence({ root: missing.root, execute: true, receipt: missingReceipt }), /verification_discovery_selector_missing/u);
  assert.equal(fs.existsSync(missingReceipt), false); assert.deepEqual(fs.readdirSync(missing.cleanup), []);
});

test('every loaded producer component rejects actual stat-cache-hidden bytes before fresh restored execution', t => {
  const f = fixture(t), receipt = path.join(f.target, 'producer-refusal.json');
  for (const relative of SOURCE_EVIDENCE_PRODUCER_PATHS) {
    const file = path.join(f.root, relative), original = fs.readFileSync(file);
    command(f.root, 'git', ['update-index', '--assume-unchanged', relative]);
    fs.appendFileSync(file, '\n// Actual altered capture producer component.\n');
    assert.equal(command(f.root, 'git', ['status', '--porcelain=v1', '--untracked-files=no']), '');
    assert.throws(() => verifyRepositorySourceEvidence({ root: f.root, execute: true, receipt }), /source_worktree_blob_mismatch/u, relative);
    assert.equal(fs.existsSync(receipt), false);
    fs.writeFileSync(file, original); command(f.root, 'git', ['update-index', '--no-assume-unchanged', relative]);
  }
  const fresh = verifyRepositorySourceEvidence({ root: f.root, execute: true });
  assert.equal(fresh.commandObservations.length, 5); assert.deepEqual(fs.readdirSync(f.cleanup), []);
  for (const target of fresh.executionTargets) {
    assert.deepEqual(target.producer.map(row => row.path), SOURCE_EVIDENCE_PRODUCER_PATHS);
  }
});

test('producer pins cover the actual transitive static and literal dynamic module graph', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const pending = [SOURCE_EVIDENCE_PRODUCER_PATHS[0]], reached = new Set();
  while (pending.length) {
    const relative = pending.pop(); if (reached.has(relative)) continue;
    reached.add(relative);
    const ast = parse(fs.readFileSync(path.join(root, relative), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
        assert.equal(typeof node.source.value, 'string', `nonliteral producer dependency:${relative}`);
        const specifier = node.source.value;
        if (!specifier.startsWith('node:')) {
          assert.equal(specifier.startsWith('.'), true, `external producer dependency:${specifier}`);
          pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(ast);
  }
  assert.equal(Object.isFrozen(SOURCE_EVIDENCE_PRODUCER_PATHS), true);
  assert.equal(new Set(SOURCE_EVIDENCE_PRODUCER_PATHS).size, SOURCE_EVIDENCE_PRODUCER_PATHS.length);
  assert.deepEqual([...reached].sort(), [...SOURCE_EVIDENCE_PRODUCER_PATHS].sort());
});

function processIdentity(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/u);
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return { pid, state: fields[0], group: Number(fields[2]), session: Number(fields[3]),
      start: fields[19], uid: Number(/^Uid:\s+(\d+)/mu.exec(status)[1]) };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
const stopped = value => !value || ['Z', 'X'].includes(value.state);
function ownSession(leader) {
  return fs.readdirSync('/proc').filter(name => /^\d+$/u.test(name)).map(Number).map(processIdentity)
    .filter(value => value && value.group === leader.group && value.session === leader.session);
}
function signalIdentity(value, signal) {
  const current = processIdentity(value.pid); if (stopped(current)) return;
  for (const field of ['start', 'uid', 'group', 'session']) assert.equal(current[field], value[field]);
  assert.equal(current.uid, process.getuid()); process.kill(current.pid, signal);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function boundedClose(closed, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    closed.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
async function cancelOwnedVerifier(f, signal, receipt) {
  const child = spawn(process.execPath, [path.join(f.root, 'paper-core/bin/verify-source-implementation-evidence.mjs'),
    '--root', f.root, '--execute', '--receipt', receipt], { env: { ...process.env }, cwd: f.root,
    shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const leader = processIdentity(child.pid); assert(leader); assert.equal(leader.group, child.pid); assert.equal(leader.session, child.pid);
  const observed = new Map([[leader.pid, leader]]); let settled = false; let outputBytes = 0;
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, observedSignal) => { settled = true; resolve({ code, signal: observedSignal }); });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    outputBytes += bytes.length; if (outputBytes > 2 * 1024 * 1024) { f.retention.required = true; signalIdentity(leader, 'SIGKILL'); }
  });
  try {
    const barrier = path.join(f.cleanup, 'owner-barrier'); const deadline = Date.now() + 30_000;
    while (!settled && !fs.existsSync(barrier) && Date.now() < deadline) await delay(2);
    assert(fs.existsSync(barrier), `actual selected-owner barrier missing: ${signal}`);
    const m = fs.lstatSync(barrier); assert(m.isFile()); assert.equal(m.uid, process.getuid()); assert.equal(m.nlink, 1);
    const ownerPid = Number(fs.readFileSync(barrier, 'utf8')); const owner = processIdentity(ownerPid);
    assert(owner); assert.equal(owner.group, leader.group); assert.equal(owner.session, leader.session); assert.equal(owner.uid, leader.uid);
    for (const member of ownSession(leader)) observed.set(member.pid, member);
    signalIdentity(leader, signal);
    const terminal = await boundedClose(closed, 15_000, 'owned verifier close timeout');
    assert.equal(terminal.code, null); assert.equal(terminal.signal, signal); assert(outputBytes <= 2 * 1024 * 1024);
    assert.equal(fs.existsSync(receipt), false, 'interrupted verification cannot publish acceptance');
  } finally {
    try {
      for (const member of ownSession(leader)) {
        assert.equal(member.uid, leader.uid); const prior = observed.get(member.pid);
        if (prior) assert.equal(prior.start, member.start); else observed.set(member.pid, member);
      }
      for (const member of [...observed.values()]) signalIdentity(member, 'SIGKILL');
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && ownSession(leader).some(value => !stopped(value))) await delay(10);
      if (ownSession(leader).some(value => !stopped(value))) throw new Error('owned session cleanup remains unverified');
      if (!settled) await boundedClose(closed, 15_000, 'owned verifier final close remains unverified');
    } catch (error) {
      f.retention.required = true; child.stdout.destroy(); child.stderr.destroy(); child.unref(); throw error;
    }
  }
}

test('actual TERM KILL cleanup and fresh same-source retry preserve independent owner evidence', async t => {
  const body = 'let p=std::env::temp_dir().join("owner-barrier"); std::fs::write(&p,std::process::id().to_string()).unwrap(); std::thread::sleep(std::time::Duration::from_secs(3)); std::fs::remove_file(&p).unwrap();';
  const f = fixture(t, { firstOwnerBody: body });
  const subject = { head: command(f.root, 'git', ['rev-parse', 'HEAD']), tree: command(f.root, 'git', ['rev-parse', 'HEAD^{tree}']) };
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const receipt = path.join(f.target, `${signal}-receipt.json`);
    await cancelOwnedVerifier(f, signal, receipt);
    const barrier = path.join(f.cleanup, 'owner-barrier');
    if (fs.existsSync(barrier)) { const m=fs.lstatSync(barrier); assert(m.isFile()); assert.equal(m.uid,process.getuid()); assert.equal(m.nlink,1); fs.unlinkSync(barrier); }
    assert.deepEqual(fs.readdirSync(f.cleanup), []);
    assert.equal(command(f.root, 'git', ['status', '--porcelain=v1', '--untracked-files=no']), '');
    const fresh = verifyRepositorySourceEvidence({ root: f.root, execute: true, expectedHead: subject.head, expectedTree: subject.tree });
    assert.deepEqual(fresh.source, subject); assert.equal(fresh.commandObservations.length, 5);
    assert.equal(new Set(fresh.commandObservations.map(row => row.physicalInvocation.processId)).size, 5);
    assert.deepEqual(fs.readdirSync(f.cleanup), []);
  }
});
