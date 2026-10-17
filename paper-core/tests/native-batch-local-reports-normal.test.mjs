import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { before, after, test } from 'node:test';
import { safeEnvironment } from '../../docs/tools/node-rust-route-acceptance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createNormalBatchFixtureV1, compareNormalBatchReportsV1, readNormalBatchJsonV1, pinNormalBatchInputV1 as pin,
  observeNormalBatchNamespaceV1 as namespace } from './support/native-batch-fixture-v1.mjs';

// Real ordinary local output. These fixtures grant no SQLite business writer,
// provider, release or submission authority. Native recovery is an explicit
// bounded local profile; original Node vaults and native intents are distinct.
let f, verifyReceipt, cleanupUnverified = false;
const observations = [], completedOwners = new Set();
function environment() {
  const base = safeEnvironment();
  return { ...base, PATH: `${path.dirname(process.execPath)}:${base.PATH || '/usr/bin:/bin'}`, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
}
function argv() {
  return ['operator', 'batch', '--', '--root', f.assets, '--runtime-root', f.runtimeRoot,
    '--inventory-source', 'hepta', '--paper', 'local-normal-paper', '--quality-profile', 'survey_or_position',
    '--mode', 'local-dry-run', '--write-report', '--json'];
}
function command(engine) {
  return engine === 'node' ? { program: process.execPath, args: [path.join(f.code, 'paper-core/bin/hepta-paper.mjs'), ...argv()] }
    : { program: f.binary, args: argv() };
}
function inputGuards() {
  return { db: pin(f.database), source: namespace(f.assets), tools: [pin(process.execPath), pin(f.binary)] };
}
function actual(engine, expected = 0, argumentsOverride = null) {
  const before = namespace(f.runtimeRoot), input = inputGuards(), selected = command(engine), started = Date.now();
  if (argumentsOverride) selected.args = engine === 'node' ? [path.join(f.code, 'paper-core/bin/hepta-paper.mjs'), ...argumentsOverride] : argumentsOverride;
  const raw = spawnSync(selected.program, selected.args, { cwd: f.caller, env: environment(), shell: false,
    encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  assert.deepEqual(inputGuards(), input, 'local report changed DB, source or actual tool');
  const after = namespace(f.runtimeRoot);
  observations.push({ engine, command: selected, cwd: f.caller, umask: process.umask(), status: raw.status,
    signal: raw.signal, error: raw.error?.message || null, elapsedMs: Date.now() - started, timeoutMs: 30000,
    stdout: raw.stdout, stderr: raw.stderr, namespaceBefore: before, namespaceAfter: after });
  assert.equal(raw.error, undefined, raw.error?.message); assert.equal(raw.signal, null, raw.stderr);
  assert.equal(raw.status, expected, raw.stderr);
  return { raw, before, after, report: expected === 0 ? JSON.parse(raw.stdout) : null };
}
function verifyNewArtifacts(result, recoveryOperation = null) {
  const names = Object.keys(result.after).filter(name => /^report-receipts\/[a-f0-9]{64}\.json$/u.test(name) && !result.before[name]);
  const report = result.report, detailSubject = { version: 2, kind: 'PaperBatchResultDetail', mode: report.mode, rows: report.rows, results: report.results };
  const detailHash = hashRecord('PaperBatchResultDetail', detailSubject), stamp = report.generatedAt.replace(/[-:.]/gu, '').replace(/\d{3}Z$/u, 'Z');
  const expected = new Set([`details/${detailHash.slice(7)}.json`, `paper-batch-${report.mode}-${stamp}.json`,
    `paper-batch-${report.mode}-${stamp}.md`, `paper-batch-${report.mode}-latest.json`, `paper-batch-${report.mode}-latest.md`]);
  const current = [], recovered = [];
  assert.ok(names.length >= 5 && names.length <= (recoveryOperation ? 10 : 5), 'new report and actual recovered receipt bounds');
  for (const name of names) {
    const entry = readNormalBatchJsonV1(path.join(f.runtimeRoot, name), 128 * 1024).value;
    const { filesystemReportReceiptLedgerEntryHash, ...subject } = entry;
    assert.equal(filesystemReportReceiptLedgerEntryHash, hashRecord('FilesystemReportReceiptLedgerEntry', subject));
    assert.equal(entry.businessStoreMutated, false);
    const proof = verifyReceipt({ receipt: entry.receipt });
    assert.equal(entry.receipt.scopeRoot, path.join(f.runtimeRoot, 'reports'));
    if (expected.has(entry.receipt.path) && proof.status === 'artifact_write_receipt_source_verified') {
      assert.ok(!current.includes(entry.receipt.path), 'duplicate current receipt path'); current.push(entry.receipt.path);
      const relative = path.join('reports', entry.receipt.path);
      assert.equal(Number(result.after[relative].identity[2]) & 0o7777, 0o444);
    } else {
      assert.ok(recoveryOperation, 'unexpected receipt outside current report');
      // A fresh ordinary argv creates a fresh clock-bound report. The prior
      // interrupted report is recovered separately; it is not discarded or
      // relabelled as one of the current report's five receipts.
      const roots = fs.readdirSync(path.join(f.runtimeRoot, 'local-report-publication-v1')).filter(value => /^prepared-[a-f0-9]{32}$/u.test(value));
      const owners = roots.flatMap(value => {
        const root = path.join(f.runtimeRoot, 'local-report-publication-v1', value);
        const intent = readNormalBatchJsonV1(path.join(root, 'intent.json')).value;
        const record = readNormalBatchJsonV1(path.join(root, 'records.json'), 512 * 1024).value;
        return intent.operation === recoveryOperation && record.ledgerName === path.basename(name) ? [{ root, intent, record }] : [];
      });
      assert.equal(owners.length, 1, 'extra ledger lacks exact prior observed operation owner');
      assert.equal(owners[0].intent.authorityGranted, false); assert.equal(owners[0].record.authorityGranted, false);
      assert.equal(proof.manifestRead, true); assert.equal(proof.objectBytesRead, true);
      assert.ok(proof.blockers.every(value => /^artifact_materialized_(hash|size)_mismatch$/u.test(value)), JSON.stringify(proof));
      recovered.push({ name, operation: recoveryOperation, owner: owners[0].root, proof });
    }
  }
  assert.equal(current.length, 5);
  const detail = readNormalBatchJsonV1(path.join(f.runtimeRoot, 'reports', `details/${detailHash.slice(7)}.json`), 16 * 1024 * 1024).value;
  assert.deepEqual(detail, detailSubject);
  const latest = readNormalBatchJsonV1(path.join(f.runtimeRoot, 'reports/paper-batch-local-dry-run-latest.json')).value;
  assert.equal(latest.kind, 'CurrentReportPointer'); assert.equal(latest.generatedAt, report.generatedAt);
  const persisted = readNormalBatchJsonV1(path.join(f.runtimeRoot, 'reports', latest.reportPath), 16 * 1024 * 1024).value;
  const { reportHash, ...subject } = persisted;
  assert.equal(reportHash, hashRecord('PaperBatchRunReport', subject)); assert.equal(latest.reportHash, reportHash);
  const { results: _results, reportHash: _originalHash, ...original } = report;
  const { resultDetail, reportHash: _persistedHash, ...bounded } = persisted;
  assert.deepEqual(bounded, original); assert.equal(resultDetail.detailHash, detailHash);
  assert.equal(Number(result.after['report-receipts'].directory[2]) & 0o7777, 0o700);
  if (recovered.length) observations.push({ kind: 'PriorOrdinaryOperationRecoveredSeparatelyV1', recovered, currentPaths: current });
  return current;
}
before(async () => {
  f = await createNormalBatchFixtureV1();
  ({ verifyArtifactWriteReceiptSource: verifyReceipt } = await import(pathToFileURL(path.join(f.code, 'paper-adapters/artifacts/artifact-write-receipt-verifier.mjs')).href));
});
after(context => {
  context.diagnostic(JSON.stringify({ version: 1, kind: 'NormalLocalReportObservationsV1', qualified: false,
    routeAccepted: false, businessAuthorityGranted: false, installedCutover: false, observations }));
  if (!f || cleanupUnverified || context.signal.aborted || completedOwners.size !== 4) { context.diagnostic(`fixture retained: ${f?.fixture || "preparation incomplete"}`); return; }
  for (const [file, value] of f.inputPins) assert.deepEqual(pin(file), value);
  for (const [file, value] of f.graphPins) assert.deepEqual(pin(file), value);
  fs.rmSync(f.fixture, { recursive: true });
});
test('normal_batch_local_reports_original_node_then_native_full_namespace_receipts_and_fresh_retry', () => {
  const originalMask = process.umask(0o002);
  try {
    const node = actual('node'); verifyNewArtifacts(node);
    const legacy = namespace(path.join(f.runtimeRoot, '.hepta-materialization-recovery'));
    const native = actual('native'); verifyNewArtifacts(native); compareNormalBatchReportsV1(node.report, native.report);
    assert.deepEqual(namespace(path.join(f.runtimeRoot, '.hepta-materialization-recovery')), legacy, 'completed Node vault changed or adopted');
    assert.equal(Number(native.after['reports'].directory[2]) & 0o7777, 0o775);
    assert.equal(Number(native.after['report-artifact-cas'].directory[2]) & 0o7777, 0o775);
    assert.equal(Number(native.after['local-report-publication-v1'].directory[2]) & 0o7777, 0o700);
    const retry = actual('native'); verifyNewArtifacts(retry); compareNormalBatchReportsV1(native.report, retry.report);
    assert.deepEqual(namespace(path.join(f.runtimeRoot, '.hepta-materialization-recovery')), legacy); completedOwners.add('positive');
  } finally { process.umask(originalMask); }
});
test('normal_batch_local_reports_umask_and_existing_group_data_permissions_are_observed_without_chmod', () => {
  const originalMask = process.umask(0o022);
  try {
    // Existing 0775 dirs are Node-created input and must remain unchanged even
    // when this subsequent ordinary process has a more restrictive umask.
    const directories = ['reports', 'reports/details', 'report-artifact-cas', 'report-artifact-cas/manifests', 'report-receipts'];
    const before = Object.fromEntries(directories.map(name => [name, fs.lstatSync(path.join(f.runtimeRoot, name)).mode]));
    const result = actual('native'); verifyNewArtifacts(result);
    for (const name of directories) assert.equal(fs.lstatSync(path.join(f.runtimeRoot, name)).mode, before[name]);
    const priorRuntime = f.runtimeRoot, priorDatabase = f.database;
    const fresh = path.join(f.fixture, 'umask022-runtime'); fs.mkdirSync(fresh, { mode: 0o750 });
    fs.copyFileSync(priorDatabase, path.join(fresh, 'hepta-paper.sqlite'), fs.constants.COPYFILE_EXCL);
    assert.equal(pin(path.join(fresh, 'hepta-paper.sqlite')).sha256, pin(priorDatabase).sha256);
    f.runtimeRoot = fresh; f.database = path.join(fresh, 'hepta-paper.sqlite');
    try {
      const node = actual('node'); verifyNewArtifacts(node);
      const native = actual('native'); verifyNewArtifacts(native);
      compareNormalBatchReportsV1(node.report, native.report);
      assert.equal(Number(native.after.reports.directory[2]) & 0o7777, 0o755);
      assert.equal(Number(native.after['report-artifact-cas'].directory[2]) & 0o7777, 0o755);
    } finally { f.runtimeRoot = priorRuntime; f.database = priorDatabase; }
    completedOwners.add('modes');
  } finally { process.umask(originalMask); }
});
test('normal_batch_local_reports_unknown_namespace_alias_and_world_write_refuse_with_original_bytes_retained', () => {
  const foreign = path.join(f.runtimeRoot, 'local-report-publication-v1/foreign-record');
  fs.writeFileSync(foreign, 'foreign pending bytes', { flag: 'wx', mode: 0o600 });
  let before = namespace(f.runtimeRoot); const unknown = actual('native', 1);
  assert.match(unknown.raw.stderr, /unknown|retained|refus/iu); assert.deepEqual(namespace(f.runtimeRoot), before);
  assert.deepEqual(pin(foreign), before['local-report-publication-v1/foreign-record']); fs.unlinkSync(foreign);
  const reports = path.join(f.runtimeRoot, 'reports'), original = path.join(f.runtimeRoot, 'original-owned-reports');
  fs.renameSync(reports, original); fs.symlinkSync(original, reports); before = namespace(f.runtimeRoot);
  const alias = actual('native', 1); assert.match(alias.raw.stderr, /unknown|retained|refus/iu);
  assert.deepEqual(namespace(f.runtimeRoot), before); fs.unlinkSync(reports); fs.renameSync(original, reports);
  const mode = fs.lstatSync(reports).mode & 0o7777; fs.chmodSync(reports, 0o777); before = namespace(f.runtimeRoot);
  const unsafe = actual('native', 1); assert.match(unsafe.raw.stderr, /unknown|retained|refus/iu);
  assert.deepEqual(namespace(f.runtimeRoot), before); fs.chmodSync(reports, mode);
  const retry = actual('native'); verifyNewArtifacts(retry); completedOwners.add('refusals');
});
function identity(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/u);
  const uid = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^Uid:\s+(\d+)/mu)[1];
  return { pid, ppid: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: fields[19], uid };
}
function group(leader) {
  return fs.readdirSync('/proc').filter(name => /^\d+$/u.test(name)).flatMap(name => {
    try { const member = identity(Number(name)); if (member.group !== leader.group) return [];
      assert.equal(member.session, leader.session); assert.equal(member.uid, leader.uid); assert.ok(BigInt(member.start) >= BigInt(leader.start)); return [member];
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return []; throw error; }
  });
}
function signalOwned(member, signal) {
  try { assert.deepEqual(identity(member.pid), member); process.kill(member.pid, signal); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
}
async function waitClosed(closed, milliseconds) {
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned ordinary child close unverified; fixture retained')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function interruptPrepared(signal) {
  const input = inputGuards(), before = namespace(f.runtimeRoot), selected = command('native');
  const known = new Set(fs.readdirSync(path.join(f.runtimeRoot, 'local-report-publication-v1')));
  const child = spawn(selected.program, selected.args, { cwd: f.caller, env: environment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [], members = new Map(); let terminal = null, failure = null, total = 0;
  const closed = new Promise(resolve => { child.once('error', error => { failure = error; resolve(); }); child.once('close', (code, sig) => { terminal = { code, signal: sig }; resolve(); }); });
  for (const [pipe, target] of [[child.stdout, stdout], [child.stderr, stderr]]) pipe.on('data', bytes => { total += bytes.length; if (total > 16 * 1024 * 1024) failure = new Error('ordinary child output limit'); else target.push(bytes); });
  let leader, barrier, primaryQualified = false, groupQualified = false;
  try {
    leader = identity(child.pid); assert.equal(leader.ppid, process.pid); assert.equal(leader.uid, String(process.getuid())); primaryQualified = true; members.set(leader.pid, leader); assert.equal(leader.pid, leader.group); assert.equal(leader.pid, leader.session); groupQualified = true;
    const deadline = Date.now() + 30000;
    while (!terminal && !failure && !barrier && Date.now() < deadline) {
      assert.deepEqual(identity(leader.pid), leader);
      for (const member of group(leader)) members.set(member.pid, member);
      for (const name of fs.readdirSync(path.join(f.runtimeRoot, 'local-report-publication-v1'))) {
        if (known.has(name) || !/^prepared-[a-f0-9]{32}$/u.test(name)) continue;
        const intent = path.join(f.runtimeRoot, 'local-report-publication-v1', name, 'intent.json');
        try { const { pin: held, value: parsed } = readNormalBatchJsonV1(intent);
          assert.equal(parsed.kind, 'NativeLocalReportPreparedArtifact'); assert.equal(parsed.authorityGranted, false);
          barrier = { name, intent: parsed, pin: held, observedStage: 'prepared_name_and_held_intent_visible', parentFsyncCompletionClaimed: false }; break;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (!barrier) await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(terminal, null); assert.equal(failure, null); assert.ok(barrier, 'actual ordinary process never exposed own prepared name and held intent');
    signalOwned(leader, signal); await waitClosed(closed, 30000); assert.equal(failure, null);
    assert.deepEqual(terminal, { code: null, signal }, Buffer.concat(stderr).toString());
    assert.equal(Buffer.concat(stdout).length, 0); assert.deepEqual(inputGuards(), input);
    observations.push({ engine: 'native', signal, command: selected, actualLeader: leader, barrier,
      terminal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), namespaceBefore: before, namespaceAfter: namespace(f.runtimeRoot), timeoutMs: 30000 });
  } finally {
    try {
      if (groupQualified) for (const member of group(leader)) { members.set(member.pid, member); signalOwned(member, 'SIGKILL'); }
      else if (primaryQualified) signalOwned(leader, 'SIGKILL');
      await waitClosed(closed, 10000);
      const stop = Date.now() + 10000;
      while (groupQualified && group(leader).some(member => {
        assert.deepEqual(member, members.get(member.pid));
        const raw = fs.readFileSync(`/proc/${member.pid}/stat`, 'utf8'); return raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/u)[0] !== 'Z';
      })) { assert.ok(Date.now() < stop, 'own process remains live; cleanup unknown'); await new Promise(resolve => setTimeout(resolve, 5)); }
    } catch (error) { cleanupUnverified = true; child.unref(); child.stdout.destroy(); child.stderr.destroy(); throw error; }
  }
  return barrier.intent.operation;
}
test('normal_batch_local_reports_actual_prepared_sigterm_sigkill_and_same_argv_fresh_recovery', async () => {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const operation = await interruptPrepared(signal);
    const retry = actual('native'); verifyNewArtifacts(retry, operation);
    const previewArgs = argv().filter(value => value !== '--write-report');
    const preview = actual('native', 0, previewArgs);
    assert.deepEqual(preview.after, preview.before, 'fresh ordinary preview changed report namespace');
    compareNormalBatchReportsV1(retry.report, preview.report);
  }
  completedOwners.add('recovery');
});
