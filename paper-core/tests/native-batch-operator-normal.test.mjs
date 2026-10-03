import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { before, after, test } from 'node:test';
import { buildNativeOwners, safeEnvironment } from '../../docs/tools/node-rust-route-acceptance.mjs';
import { relativeModuleSpecifiers } from '../verification/javascript-module-specifiers.mjs';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hashPaperRecord, hashPaperSemanticIdentity } from '../../paper-domain/contracts/primitives.mjs';

// These ordinary previews exercise a bounded native profile. Local report
// persistence has a separate normal-entry owner. Execution, Node stack formatting
// and oversized inputs remain partial; no fixture grants external authority.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const ids = s => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const observations = [], inputPins = new Map(), graphPins = new Map();
let fixture, code, assets, runtimeRoot, caller, binary, database, cleanupUnverified = false;
const without = (value, ...keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

function pin(file) {
  const named = fs.lstatSync(file, { bigint: true });
  assert.ok(named.isFile() && named.size <= 128n * 1024n * 1024n, `nonregular or unbounded input: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const held = fs.fstatSync(fd, { bigint: true }), hash = createHash('sha256'), block = Buffer.alloc(65536);
    let total = 0n;
    for (let count; (count = fs.readSync(fd, block, 0, Number(named.size - total + 1n > 65536n ? 65536n : named.size - total + 1n))) !== 0;) {
      total += BigInt(count); assert.ok(total <= named.size, 'input grew beyond captured size'); hash.update(block.subarray(0, count));
    }
    assert.equal(total, named.size);
    for (const value of [held, fs.fstatSync(fd, { bigint: true }), fs.lstatSync(file, { bigint: true })]) assert.deepEqual(ids(value), ids(named));
    return { identity: ids(named), sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function namespace(root) {
  const out = {}; let count = 0;
  function walk(file) {
    assert.ok(++count <= 20000, 'fixture namespace exceeds closed limit');
    const value = fs.lstatSync(file, { bigint: true }), name = path.relative(root, file);
    if (value.isDirectory()) {
      out[name] = { directory: ids(value) };
      for (const entry of fs.readdirSync(file).sort()) walk(path.join(file, entry));
    } else if (value.isFile()) out[name] = pin(file);
    else if (value.isSymbolicLink()) out[name] = { symlink: fs.readlinkSync(file), identity: ids(value) };
    else throw new Error(`unexpected fixture special object retained: ${file}`);
  }
  walk(root); return out;
}
function environment(additions = {}) {
  return { ...safeEnvironment(), PATH: `${path.dirname(process.execPath)}:${safeEnvironment().PATH || '/usr/bin:/bin'}`,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...additions };
}
function copy(from, to, limit) {
  if (graphPins.has(to)) {
    assert.deepEqual(pin(from), inputPins.get(from));
    assert.deepEqual(pin(to), graphPins.get(to)); return;
  }
  const named = fs.lstatSync(from, { bigint: true }); assert.equal(named.isSymbolicLink(), false);
  assert.ok(++limit.entries <= 10000);
  if (named.isDirectory()) {
    fs.mkdirSync(to, { recursive: true, mode: Number(named.mode & 0o7777n) });
    for (const name of fs.readdirSync(from).sort()) copy(path.join(from, name), path.join(to, name), limit);
    assert.deepEqual(ids(fs.lstatSync(from, { bigint: true })), ids(named)); return;
  }
  const original = pin(from); limit.bytes += Number(named.size); assert.ok(limit.bytes <= 192 * 1024 * 1024, `fixture_copy_byte_limit:${from}:${limit.bytes}`);
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o750 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, Number(named.mode & 0o7777n));
  const copied = pin(to); assert.equal(copied.identity[5], '1'); assert.equal(copied.sha256, original.sha256);
  assert.deepEqual(pin(from), original); inputPins.set(from, original); graphPins.set(to, copied);
}
function runRaw(program, args, options = {}) {
  // This fixture's original Git bytes are evidence. Disable automatic packing
  // from its first init and every explicit fixture Git call; normal subprocess
  // commands also inherit the persisted local settings configured below.
  const actualArgs = program === '/usr/bin/git'
    ? ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args] : args;
  const out = spawnSync(program, actualArgs, { cwd: code, env: environment(), encoding: 'utf8', shell: false,
    timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(out.error, undefined, out.error?.message); assert.equal(out.signal, null, out.stderr);
  return out;
}
function durableInputs(before, after) {
  for (const [name, record] of Object.entries(before)) {
    if (!record.sha256 || name.startsWith('code/.git/')) continue;
    if (name === 'runtime/hepta-paper.sqlite-wal' || name === 'runtime/hepta-paper.sqlite-shm') continue;
    assert.deepEqual(after[name], record, `ordinary read changed original durable input: ${name}`);
  }
}
function run(engine, forwarded, additions = {}, expected = 0) {
  const before = namespace(fixture), tools = [pin(process.execPath), pin(binary)], start = Date.now();
  const args = ['operator', 'batch', '--', ...forwarded];
  const result = runRaw(engine === 'node' ? process.execPath : binary,
    engine === 'node' ? [path.join(code, 'paper-core/bin/hepta-paper.mjs'), ...args] : args,
    { cwd: caller, env: environment(additions) });
  const observed = namespace(fixture); durableInputs(before, observed);
  assert.deepEqual([pin(process.execPath), pin(binary)], tools);
  observations.push({ engine, argv: args, cwd: caller, additions, exitCode: result.status,
    elapsedMs: Date.now() - start, timeoutMs: 30000, namespaceBefore: digest(before), namespaceAfter: digest(observed),
    namespaceChanges: [...new Set([...Object.keys(before), ...Object.keys(observed)])].filter(name => JSON.stringify(before[name]) !== JSON.stringify(observed[name])),
    stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'), stderrSha256: createHash('sha256').update(result.stderr).digest('hex') });
  assert.equal(result.status, expected, result.stderr); return result;
}
function compareReports(left, right) {
  const taskSubject = value => without(value, 'taskHash', 'semanticIdentityVersion', 'semanticIdentityHash');
  const stateSubject = value => ({ ...without(value, 'stateHash', 'semanticIdentityVersion', 'semanticIdentityHash'), nextAction: null, autoLevel: null, stage: null, submissionIntent: null });
  const scopeSubject = value => Object.fromEntries(['mode', 'requestedPaperIds', 'selectedPaperIds', 'inventorySource', 'inventoryFallback', 'selectedTaskBindings'].map(key => [key, value[key]]));
  function normalize(original) {
    assert.equal(original.kind, 'PaperBatchRunReport'); assert.equal(original.version, 2);
    assert.equal(original.workflowExecutionPerformed, false); assert.equal(original.executionStatus, 'not_executed');
    assert.equal(original.reportHash, hashRecord('PaperBatchRunReport', without(original, 'reportHash')));
    const receipt = original.targetScopeReceipt;
    assert.equal(receipt.targetScopeHash, hashRecord('TargetScopeSubject', scopeSubject(receipt)));
    assert.equal(receipt.targetScopeReceiptHash, hashRecord('TargetScopeReceipt', without(receipt, 'targetScopeReceiptHash')));
    for (const result of original.results) {
      assert.equal(result.task.taskHash, hashPaperRecord('PaperTask', taskSubject(result.task)));
      assert.equal(result.task.semanticIdentityHash, hashPaperSemanticIdentity('PaperTask', taskSubject(result.task)));
      assert.equal(result.state.stateHash, hashPaperRecord('PaperWorkflowState', stateSubject(result.state)));
      assert.equal(result.state.semanticIdentityHash, hashPaperSemanticIdentity('PaperWorkflowState', stateSubject(result.state)));
      const lineage = result.workflowAuthorityLineage;
      assert.ok(Number.isFinite(Date.parse(lineage.recordedAt)));
      assert.equal(lineage.workflowAuthorityLineageReceiptHash, hashRecord('WorkflowAuthorityLineageReceipt', without(lineage, 'workflowAuthorityLineageReceiptHash')));
      assert.equal(result.paperStatusProjection.recordedAt, lineage.recordedAt);
      if (result.campaignCommand) {
        assert.equal(result.campaignCommand.campaignPlanHash, hashRecord('PaperCampaignPlan', without(result.campaignCommand.campaignPlan, 'campaignPlanHash')));
        assert.deepEqual(result.campaignPlan, result.campaignCommand.campaignPlan);
      }
    }
    const report = structuredClone(original), taskHashes = new Map();
    assert.ok(Number.isFinite(Date.parse(report.generatedAt))); report.generatedAt = '2026-10-02T00:00:00.000Z';
    for (const result of report.results) {
      for (const clock of [result.task.createdAt, result.state.createdAt]) assert.ok(Number.isFinite(Date.parse(clock)));
      result.task.createdAt = report.generatedAt; result.task.taskHash = hashPaperRecord('PaperTask', taskSubject(result.task)); taskHashes.set(result.paperId, result.task.taskHash);
      result.state.createdAt = report.generatedAt; result.state.stateHash = hashPaperRecord('PaperWorkflowState', stateSubject(result.state));
      result.workflowAuthorityLineage.recordedAt = report.generatedAt;
      result.workflowAuthorityLineage.workflowAuthorityLineageReceiptHash = hashRecord('WorkflowAuthorityLineageReceipt', without(result.workflowAuthorityLineage, 'workflowAuthorityLineageReceiptHash'));
      result.paperStatusProjection.recordedAt = report.generatedAt;
    }
    for (const binding of report.targetScopeReceipt.selectedTaskBindings) binding.taskHash = taskHashes.get(binding.paperId);
    report.targetScopeReceipt.targetScopeHash = hashRecord('TargetScopeSubject', scopeSubject(report.targetScopeReceipt));
    report.targetScopeReceipt.targetScopeReceiptHash = hashRecord('TargetScopeReceipt', without(report.targetScopeReceipt, 'targetScopeReceiptHash'));
    report.reportHash = hashRecord('PaperBatchRunReport', without(report, 'reportHash')); return report;
  }
  assert.deepEqual(normalize(left), normalize(right));
}
function pair(forwarded, additions = {}, json = true) {
  const left = run('node', forwarded, additions), right = run('native', forwarded, additions);
  if (json) compareReports(JSON.parse(left.stdout), JSON.parse(right.stdout));
  else assert.equal(right.stdout, left.stdout);
  return JSON.parse(json ? right.stdout : '{}');
}
const absolute = () => ['--root', assets, '--runtime-root', runtimeRoot, '--inventory-source', 'hepta', '--paper', 'local-normal-paper', '--quality-profile', 'survey_or_position'];

before(async () => {
  const built = buildNativeOwners(); assert.equal(`sha256:${pin(fs.realpathSync(process.execPath)).sha256}`, built.node.sha256);
  fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.userInfo().homedir), '.hepta-batch-normal-'));
  code = path.join(fixture, 'code'); assets = path.join(fixture, 'assets'); runtimeRoot = path.join(fixture, 'runtime'); caller = path.join(fixture, 'caller');
  for (const directory of [code, caller, assets, runtimeRoot]) fs.mkdirSync(directory, { mode: 0o750 });
  const limit = { entries: 0, bytes: 0 };
  // Copy the actual normal command/import closure, not unrelated tests and
  // development evidence. Keep all original runtime inputs, including the
  // public R source closure when CI has materialized it; do not bypass its gate.
  const command = resolveHeptaPaperCommand('operator', 'batch');
  assert.equal(command.argv[0], 'node');
  const pending = ['paper-core/bin/hepta-paper.mjs', command.argv[1],
    'paper-adapters/persistence/store-provider.mjs', 'paper-adapters/persistence/sqlite-campaign-store.mjs',
    'paper-domain/contracts/workflow-contracts.mjs', 'paper-domain/automation/campaign-plan.mjs',
    'paper-adapters/runtime/system-clock.mjs', 'package.json', 'package-lock.json'];
  const copied = new Set();
  while (pending.length) {
    const relative = pending.pop(); if (copied.has(relative)) continue;
    assert.ok(copied.size < 4096, 'ordinary_module_closure_limit');
    assert.ok(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    copied.add(relative);
    const from = path.join(source, relative); copy(from, path.join(code, relative), limit);
    if (!relative.endsWith('.mjs')) continue;
    const text = fs.readFileSync(from, 'utf8');
    for (const specifier of relativeModuleSpecifiers(text)) {
      pending.push(path.relative(source, path.resolve(path.dirname(from), specifier)));
    }
    for (const match of text.matchAll(/new URL\(\s*(['"])([^'"\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/gu)) {
      const selected = path.resolve(path.dirname(from), match[2]);
      if (fs.existsSync(selected) && fs.lstatSync(selected).isFile()) pending.push(path.relative(source, selected));
    }
  }
  for (const name of ['runtime-images', 'paper-core/config', 'store/migrations']) copy(path.join(source, name), path.join(code, name), limit);
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8'));
  for (const name of ['acorn', 'acorn-jsx', 'eslint-scope', 'eslint-visitor-keys', 'espree', 'esrecurse', 'estraverse']) {
    let packageRoot = path.dirname(require.resolve(name));
    for (let depth = 0; !fs.existsSync(path.join(packageRoot, 'package.json')); depth++) { assert.ok(depth < 8); packageRoot = path.dirname(packageRoot); }
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name); assert.equal(manifest.version, lock.packages[`node_modules/${name}`].version);
    copy(packageRoot, path.join(code, 'node_modules', name), limit);
  }
  // The qualified executable is one separate tool slot. The complete
  // source/R graph retains its original 192 MiB bound; each tool retains
  // the original 128 MiB regular-file bound and actual build hash.
  const executableCopy = { entries: 0, bytes: 0 };
  binary = path.join(code, 'bin/hepta-paper-rust'); copy(built.owners['hepta-paper-rust'].path, binary, executableCopy);
  assert.equal(executableCopy.entries, 1); assert.ok(executableCopy.bytes <= 128 * 1024 * 1024);
  assert.equal(`sha256:${pin(binary).sha256}`, built.owners['hepta-paper-rust'].sha256);
  fs.writeFileSync(path.join(code, '.gitignore'), '/bin/\n/node_modules/\n', { flag: 'wx', mode: 0o640 });
  for (const args of [['init', '--quiet'], ['config', '--local', 'gc.auto', '0'], ['config', '--local', 'maintenance.auto', 'false'], ['add', '--all'], ['-c', 'user.name=Normal batch test', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Actual copied Node ordinary graph']]) {
    const result = runRaw('/usr/bin/git', args); assert.equal(result.status, 0, result.stderr);
  }
  for (const [name, expected] of [['gc.auto', '0'], ['maintenance.auto', 'false']]) {
    const result = runRaw('/usr/bin/git', ['config', '--local', '--get', name]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), expected);
  }
  const from = relative => import(pathToFileURL(path.join(code, relative)).href);
  const { createDefaultPaperStore } = await from('paper-adapters/persistence/store-provider.mjs');
  const { createSqliteCampaignStore } = await from('paper-adapters/persistence/sqlite-campaign-store.mjs');
  const { createPaperTask } = await from('paper-domain/contracts/workflow-contracts.mjs');
  const { buildPaperCampaignPlan } = await from('paper-domain/automation/campaign-plan.mjs');
  const { createSystemClock } = await from('paper-adapters/runtime/system-clock.mjs');
  const sourceWorkspace = path.join(assets, 'drafts/local-normal-paper'); fs.mkdirSync(sourceWorkspace, { recursive: true });
  fs.writeFileSync(path.join(sourceWorkspace, 'main.tex'), '\\documentclass{article}\n\\begin{document}Actual local planning input.\\end{document}\n', { flag: 'wx', mode: 0o640 });
  database = path.join(runtimeRoot, 'hepta-paper.sqlite');
  const store = createDefaultPaperStore({ root: assets, runtimeRoot, dbPath: database });
  try {
    const task = createPaperTask({ paperId: 'local-normal-paper', title: 'Actual normal batch input', status: 'draft', venueTarget: 'Local Planning Venue', canonicalDir: 'drafts/local-normal-paper', sourceWorkspace: 'drafts/local-normal-paper', mainTex: 'drafts/local-normal-paper/main.tex', createdAt: '2026-10-02T00:00:00.000Z' });
    const plan = buildPaperCampaignPlan({ paperId: task.paperId, sourceWorkspace, campaignId: 'normal-registration', mode: 'local-build', maxRounds: 1, paperTask: task, paperState: null, languages: ['latex'] });
    const registered = createSqliteCampaignStore({ store, clock: createSystemClock() }).createCampaign(plan);
    assert.equal(registered.paperId, task.paperId);
    assert.equal(store.run('INSERT INTO venues(venue_id,name,kind,cycle,deadline,metadata_json) VALUES(?,?,?,?,?,?);', ['local-planning-venue', 'Local Planning Venue', 'local', '2026', '2026-12-31', '{}']).ok, true);
    assert.equal(store.checkpoint({ mode: 'TRUNCATE' }).ok, true);
  } finally { store.close(); }
});
after(context => {
  if (!fixture) return;
  try {
    for (const [file, expected] of inputPins) assert.deepEqual(pin(file), expected);
    for (const [file, expected] of graphPins) assert.deepEqual(pin(file), expected);
    context.diagnostic(JSON.stringify({ version: 1, scope: 'actual ordinary previews and explicit native refusal/coordination profile; no queue/role/authority acceptance', observations, routeAccepted: false, installedHostQualified: false }));
  } finally { if (!cleanupUnverified) fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('normal_batch_operator_help_physical_root_relative_paths_and_complete_preview_match_node', () => {
  pair(['--help'], {}, false);
  for (const mode of ['local-dry-run', 'local-build', 'research-verify', 'referee-review', 'referee-autopilot', 'local-package']) {
    const options = absolute(); options[options.length - 1] = mode === 'research-verify' ? 'formal_theorem_or_proof' : mode === 'local-build' ? 'theorem_or_proof' : 'survey_or_position';
    const report = pair([...options, '--mode', mode, '--max-rounds', '2', '--json']);
    assert.equal(report.results.length, 1); assert.equal(report.results[0].campaignSubmission, null);
  }
  pair([...absolute(), '--mode', 'local-dry-run'], {}, false);
  pair(['--root', '../assets', '--runtime-root', '../runtime', '--inventory-source', 'hepta', '--paper', 'local-normal-paper', '--quality-profile', 'survey_or_position', '--mode', 'local-dry-run', '--json']);
  pair(['--inventory-source', 'hepta', '--paper', 'local-normal-paper', '--quality-profile', 'survey_or_position', '--mode', 'local-dry-run', '--json'], { HEPTA_PAPER_ASSET_ROOT: '../assets', HEPTA_PAPER_RUNTIME_ROOT: '../runtime' });
});
test('normal_batch_operator_refusals_and_native_authority_write_profile_remain_partial', () => {
  for (const args of [['--unknown'], ['--json', '--json'], ['--limit', '0'], ['--max-rounds', '1.5'], ['--mode', 'not-a-mode'], ['--mode', 'inventory', '--execute'], ['--mode', 'journal-manage']]) {
    const left = run('node', [...absolute(), ...args], {}, 1), right = run('native', [...absolute(), ...args], {}, 1);
    assert.equal(left.stdout, ''); assert.equal(right.stdout, ''); assert.equal(right.stderr.split('\n').find(line => line.startsWith('Error:')), left.stderr.split('\n').find(line => line.startsWith('Error:')));
  }
  const before = namespace(fixture);
  const native = run('native', [...absolute(), '--mode', 'local-dry-run', '--execute'], {}, 1);
  assert.match(native.stderr, /native_batch_operator_execute_requires_bound_mutation_coordinator_v1/u);
  assert.deepEqual(namespace(fixture), before, 'native unavailable executor must refuse before any namespace effects');
  pair([...absolute(), '--mode', 'local-dry-run', '--json']);
});

function processIdentity(pid) {
  const base = `/proc/${pid}`, raw = fs.readFileSync(`${base}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/u);
  return { pid, uid: String(fs.statSync(base, { bigint: true }).uid), group: Number(fields[2]), session: Number(fields[3]), startTime: fields[19] };
}
function groupMembers(group) {
  return fs.readdirSync('/proc').filter(name => /^\d+$/u.test(name)).flatMap(name => {
    try { const value = processIdentity(Number(name)); return value.group === group ? [value] : []; }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return []; throw error; }
  });
}
function signalOwned(identity, sig) {
  try { assert.deepEqual(processIdentity(identity.pid), identity); process.kill(identity.pid, sig); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
}
async function boundedClose(closed, milliseconds) {
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned process close unknown; fixture retained')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function stopped(group, identities) {
  const deadline = Date.now() + 10000;
  while (true) {
    let running = false;
    for (const member of groupMembers(group)) {
      assert.deepEqual(member, identities.get(member.pid), 'unexpected group member; no permission to signal reused group');
      const raw = fs.readFileSync(`/proc/${member.pid}/stat`, 'utf8'), state = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/u)[0];
      if (state !== 'Z') running = true;
    }
    if (!running) return;
    if (Date.now() >= deadline) throw new Error('owned actor remains live or uninterruptible; fixture retained');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function interrupted(engine, sig) {
  const before = namespace(fixture), db = pin(database), args = ['operator', 'batch', '--', ...absolute(), '--mode', 'local-dry-run', '--json'];
  const child = spawn(engine === 'node' ? process.execPath : binary, engine === 'node' ? [path.join(code, 'paper-core/bin/hepta-paper.mjs'), ...args] : args,
    { cwd: caller, env: environment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let terminal = null, failure = null, count = 0; const stderr = [], identities = new Map();
  child.stdout.on('data', bytes => { count += bytes.length; if (count > 16 * 1024 * 1024) failure = new Error('bounded interrupted stdout exceeded'); });
  child.stderr.on('data', bytes => { stderr.push(bytes); if (stderr.reduce((sum, value) => sum + value.length, 0) > 1024 * 1024) failure = new Error('bounded interrupted stderr exceeded'); });
  const closed = new Promise(resolve => { child.once('error', error => { failure = error; resolve(); }); child.once('close', (code, signal) => { terminal = { code, signal }; resolve(); }); });
  try {
    const leader = processIdentity(child.pid); identities.set(leader.pid, leader);
    assert.equal(leader.group, leader.pid); assert.equal(leader.session, leader.pid); assert.equal(leader.uid, String(process.getuid()));
    const deadline = Date.now() + 30000; let barrier = null;
    while (!terminal && !failure && !barrier && Date.now() < deadline) {
      assert.deepEqual(processIdentity(leader.pid), leader);
      for (const member of groupMembers(leader.group)) {
        assert.equal(member.session, leader.session); assert.equal(member.uid, leader.uid); identities.set(member.pid, member);
        let descriptors; try { descriptors = fs.readdirSync(`/proc/${member.pid}/fd`); } catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES') continue; throw error; }
        for (const descriptor of descriptors) {
          const fd = `/proc/${member.pid}/fd/${descriptor}`;
          try {
            if (fs.readlinkSync(fd) !== database) continue;
            const held = fs.statSync(fd, { bigint: true });
            assert.equal(String(held.dev), db.identity[0]); assert.equal(String(held.ino), db.identity[1]); barrier = { pid: member.pid, descriptor, dev: String(held.dev), ino: String(held.ino) }; break;
          } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
        }
        if (barrier) break;
      }
      if (!barrier) await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(terminal, null); assert.equal(failure, null); assert.ok(barrier, 'ordinary actor never held actual database');
    if (sig === 'SIGKILL') {
      for (const member of groupMembers(leader.group)) { assert.equal(member.session, leader.session); assert.equal(member.uid, leader.uid); identities.set(member.pid, member); }
      for (const member of [...identities.values()].sort((a, b) => Number(a.pid === leader.pid) - Number(b.pid === leader.pid))) signalOwned(member, sig);
    } else signalOwned(leader, sig);
    await boundedClose(closed, 30000); assert.equal(failure, null);
    assert.deepEqual(terminal, { code: null, signal: sig }, Buffer.concat(stderr).toString()); assert.equal(count, 0);
    const observed = namespace(fixture); durableInputs(before, observed);
    observations.push({ engine, signal: sig, barrier, terminal, namespaceBefore: digest(before), namespaceAfter: digest(observed), timeoutMs: 30000 });
  } finally {
    try {
      for (const identity of identities.values()) signalOwned(identity, 'SIGKILL');
      await boundedClose(closed, 10000); await stopped(child.pid, identities);
    } catch (error) { cleanupUnverified = true; child.unref(); child.stdout.destroy(); child.stderr.destroy(); throw error; }
  }
}
test('normal_batch_operator_active_sidecars_and_native_document_caps_refuse_without_cleanup', () => {
  const wal = `${database}-wal`;
  fs.writeFileSync(wal, Buffer.alloc(0), { flag: 'wx', mode: 0o640 });
  const before = namespace(fixture);
  const node = run('node', [...absolute(), '--mode', 'local-dry-run', '--json'], {}, 1);
  const native = run('native', [...absolute(), '--mode', 'local-dry-run', '--json'], {}, 1);
  assert.match(node.stderr, /immutable_readonly_store_active_wal_present/u);
  assert.match(native.stderr, /native_batch_inventory_immutable_sidecar_present/u);
  const yaml = absolute(); yaml[yaml.indexOf('--inventory-source') + 1] = 'yaml';
  assert.match(run('node', [...yaml, '--mode', 'inventory', '--json'], {}, 1).stderr, /immutable_readonly_store_active_wal_present/u);
  assert.match(run('native', [...yaml, '--mode', 'inventory', '--json'], {}, 1).stderr, /native_batch_inventory_immutable_sidecar_present/u);
  assert.deepEqual(namespace(fixture), before, 'rejected sidecar remains untouched');
  // This leaf was created only by this fixture and all actors are terminal;
  // removing it prepares a distinct next input, never recovers an unknown WAL.
  assert.deepEqual(pin(wal), before['runtime/hepta-paper.sqlite-wal']); fs.unlinkSync(wal);
  const emptyYaml = path.join(fixture, 'empty-yaml-assets'); fs.mkdirSync(emptyYaml);
  pair(['--root', emptyYaml, '--runtime-root', runtimeRoot, '--inventory-source', 'yaml', '--mode', 'inventory', '--json']);
  const capped = path.join(fixture, 'capped-assets'); fs.mkdirSync(path.join(capped, 'registry'), { recursive: true });
  fs.writeFileSync(path.join(capped, 'registry/papers.yaml'), `papers:\n#${'x'.repeat(262145)}\n`, { flag: 'wx', mode: 0o640 });
  const args = ['--root', capped, '--runtime-root', runtimeRoot, '--inventory-source', 'yaml', '--mode', 'inventory', '--json'];
  const oversizedNode = run('node', args), oversizedNative = run('native', args, {}, 1);
  assert.equal(JSON.parse(oversizedNode.stdout).results.length, 0);
  assert.match(oversizedNative.stderr, /budget|limit|exceed/iu);
});
test('normal_batch_operator_actual_database_sigterm_sigkill_and_fresh_same_input_retry', async () => {
  for (const engine of ['node', 'native']) for (const sig of ['SIGTERM', 'SIGKILL']) {
    await interrupted(engine, sig); pair([...absolute(), '--mode', 'local-dry-run', '--json']);
  }
});
