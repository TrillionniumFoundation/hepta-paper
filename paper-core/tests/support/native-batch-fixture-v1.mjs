import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildNativeOwners, safeEnvironment } from '../../../docs/tools/node-rust-route-acceptance.mjs';
import { relativeModuleSpecifiers } from '../../verification/javascript-module-specifiers.mjs';
import { resolveHeptaPaperCommand } from '../../src/command-registry.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import { hashPaperRecord, hashPaperSemanticIdentity } from '../../../paper-domain/contracts/primitives.mjs';
const without = (value, ...keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
// Test preparation only. The actual fixed normal registry's module/URL/SQL graph,
// locked seven packages retain the original 192 MiB source/R graph bound;
// 10k limits. This fixture supplies no campaign, provider or release authority.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const ids = s => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String);
function environment(additions = {}) {
  return { ...safeEnvironment(), PATH: `${path.dirname(process.execPath)}:${safeEnvironment().PATH || '/usr/bin:/bin'}`,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...additions };
}
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
// Harness JSON is parsed from the same bounded nofollow held descriptor whose
// raw bytes and complete named/held identity are verified before and after.
export function readNormalBatchJsonV1(file, maximum = 65536) {
  assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 16 * 1024 * 1024);
  const named = fs.lstatSync(file, { bigint: true });
  assert.ok(named.isFile() && named.size <= BigInt(maximum));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const held = fs.fstatSync(fd, { bigint: true }), chunks = [], hash = createHash('sha256');
    assert.deepEqual(ids(held), ids(named));
    const block = Buffer.alloc(65536); let total = 0n;
    for (let count; (count = fs.readSync(fd, block, 0, Number(named.size - total + 1n > 65536n ? 65536n : named.size - total + 1n))) !== 0;) {
      total += BigInt(count); assert.ok(total <= named.size, 'held JSON grew beyond captured size');
      hash.update(block.subarray(0, count)); chunks.push(Buffer.from(block.subarray(0, count)));
    }
    assert.equal(total, named.size);
    for (const current of [fs.fstatSync(fd, { bigint: true }), fs.lstatSync(file, { bigint: true })]) assert.deepEqual(ids(current), ids(named));
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), pin: { identity: ids(named), sha256: hash.digest('hex') } };
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
export { pin as pinNormalBatchInputV1, namespace as observeNormalBatchNamespaceV1 };
export async function createNormalBatchFixtureV1() {
  const inputPins = new Map(), graphPins = new Map();
  let fixture, code, assets, runtimeRoot, caller, binary, database;
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
  const out = spawnSync(program, args, { cwd: code, env: environment(), encoding: 'utf8', shell: false,
    timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(out.error, undefined, out.error?.message); assert.equal(out.signal, null, out.stderr);
  return out;
}

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
    'paper-adapters/runtime/system-clock.mjs', 'paper-adapters/artifacts/artifact-write-receipt-verifier.mjs', 'package.json', 'package-lock.json'];
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
  for (const args of [['init', '--quiet'], ['add', '--all'], ['-c', 'user.name=Normal batch test', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Actual copied Node ordinary graph']]) {
    const result = runRaw('/usr/bin/git', args); assert.equal(result.status, 0, result.stderr);
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
  return { fixture, code, assets, runtimeRoot, caller, binary, database, inputPins, graphPins, preparation: { entries: limit.entries, bytes: limit.bytes, maximumBytes: 192 * 1024 * 1024, maximumEntries: 10000, qualifiedExecutable: { entries: executableCopy.entries, bytes: executableCopy.bytes, maximumBytes: 128 * 1024 * 1024 } } };
}

export function compareNormalBatchReportsV1(left, right) {
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
