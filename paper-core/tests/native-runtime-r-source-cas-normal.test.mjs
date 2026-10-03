import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createNormalQualificationFixtureV1 } from './support/native-qualification-normal-fixture-v1.mjs';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

let fixture;
const observations = [];
const args = values => ['operator', 'runtime-r-source-cas', '--', ...values];
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
before(() => { fixture = createNormalQualificationFixtureV1(['runtime-r-source-cas']); });
after(() => { process.stdout.write(`# r-cas-normal-observations ${JSON.stringify(observations)}\n`); fixture?.close(); });

// Status observes content hashes, not TAR execution or publisher authority.
// These synthetic bytes match its actual contract and never claim real packages.
function validStatus(root, copyOriginalLock = false) {
  const context = path.join(root, 'runtime-images/r-scientific');
  fs.mkdirSync(path.join(context, 'source-cas/src/contrib'), { recursive: true, mode: 0o700 });
  const lockFile = path.join(context, 'renv.lock');
  if (!copyOriginalLock) fs.writeFileSync(lockFile, JSON.stringify({ Packages: {
    demo: { Package: 'demo', Version: '1.0.0', Source: 'Repository', Repository: 'CRAN' },
  } }), { mode: 0o600 });
  // A materialized scientific input is an immutable original copy in this
  // fixture. Exercise its actual default status instead of overwriting archives.
  if (copyOriginalLock && fs.existsSync(path.join(context, 'source-cas/manifest.json'))) {
    return { context, archive: null, statusMaterialization: 'original immutable public source-CAS' };
  }
  const lockBytes = fs.readFileSync(lockFile), lock = JSON.parse(lockBytes);
  const packages = Object.values(lock.Packages).map(entry => {
    const file = `${entry.Package}_${entry.Version}.tar.gz`, bytes = Buffer.alloc(128, 'x');
    fs.writeFileSync(path.join(context, 'source-cas/src/contrib', file), bytes, { mode: 0o600 });
    return { package: entry.Package, version: entry.Version, file,
      url: `https://packagemanager.posit.co/cran/2024-11-01/src/contrib/${file}`, bytes: bytes.length, sha256: hash(bytes) };
  }).sort((a, b) => a.package.localeCompare(b.package));
  const payload = { version: 1, kind: 'RRuntimeSourceCasManifest', status: 'r_runtime_source_cas_complete',
    snapshot: 'https://packagemanager.posit.co/cran/2024-11-01', lockfileHash: hash(lockBytes), packageCount: packages.length,
    packages, exactLockClosure: true, allSourceArchivesContentHashed: true, offlineRestoreRequired: true };
  fs.writeFileSync(path.join(context, 'source-cas/manifest.json'), JSON.stringify({ ...payload,
    rRuntimeSourceCasManifestHash: hashRecord('RRuntimeSourceCasManifest', payload) }), { mode: 0o600 });
  fs.writeFileSync(path.join(context, 'source-cas/SHA256SUMS'), packages.map(p => `${p.sha256.slice(7)}  src/contrib/${p.file}`).join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(context, 'source-cas/PACKAGES.tsv'), ['Package\tVersion\tFile\tURL\tSHA256', ...packages.map(p => [p.package, p.version, p.file, p.url, p.sha256].join('\t'))].join('\n') + '\n', { mode: 0o600 });
  return { context, archive: path.join(context, 'source-cas/src/contrib', packages[0].file), statusMaterialization: 'synthetic status hashes' };
}
async function pair(values, selected, expectedExit = 0, statusMaterialization = 'synthetic status hashes') {
  const before = fixture.snapshot(selected);
  const node = await fixture.run('node', args(values)), native = await fixture.run('native', args(values));
  assert.equal(node.status, expectedExit, node.stderr); assert.equal(native.status, node.status, native.stderr);
  assert.equal(node.stderr, ''); assert.equal(native.stderr, '');
  assert.equal(native.stdout, node.stdout);
  assert.deepEqual(fixture.snapshot(selected), before);
  observations.push({ values, node, native, effects: 'complete selected namespace raw/metadata unchanged', statusMaterialization, executionAndPublisherAuthority: false });
  return JSON.parse(native.stdout);
}
test('normal_r_source_cas_original_grammar_and_help_precede_unknown_copied_root', async () => {
  const { booleanFlags, valueFlags } = resolveHeptaPaperCommand('operator', 'runtime-r-source-cas').forwardedArgumentSchema;
  const cases = [['--'], ['--=x'], ['-h'], ['positional'], ['--json'], ['--snapshot'], ['--execute'], ['--help', '--unknown']];
  for (const key of booleanFlags) cases.push([`--${key}=true`], [`--${key}=false`], [`--${key}`, `--${key}`]);
  for (const key of valueFlags) cases.push([`--${key}`], [`--${key}=`], [`--${key}`, ''], [`--${key}`, '--help'], [`--${key}=one`, `--${key}=two`]);
  for (const values of cases) {
    const node = await fixture.run('node', args(values)), native = await fixture.run('native', args(values)), unknown = await fixture.run('native', args(values), {}, fixture.unknown);
    for (const result of [node, native, unknown]) { assert.equal(result.status, 2); assert.equal(result.stdout, ''); }
    assert.deepEqual(JSON.parse(native.stderr), JSON.parse(node.stderr)); assert.deepEqual(JSON.parse(unknown.stderr), JSON.parse(node.stderr));
  }
  for (const values of [['--help'], ['--action=wrong', '--root=missing', '--seed=missing', '--concurrency=NaN', '--help']]) {
    const node = await fixture.run('node', args(values)), native = await fixture.run('native', args(values), {}, fixture.unknown);
    assert.equal(node.status, 0); assert.equal(native.status, 0); assert.equal(native.stdout, node.stdout); assert.equal(native.stderr, node.stderr);
  }
  for (const engine of ['node', 'native']) {
    const result = await fixture.run(engine, args(['--action=wrong']), {}, fixture.unknown);
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /r_runtime_source_cas_action_invalid:wrong/u);
  }
});
test('normal_r_source_cas_default_physical_root_and_ignored_status_options_match_full_raw_node_report', async () => {
  const input = validStatus(fixture.root, true);
  const report = await pair([], fixture.root, 0, input.statusMaterialization); assert.equal(report.ready, true);
  assert.ok(report.packageCount > 0);
  for (const value of ['6', '0', '-1', 'NaN', 'Infinity', '6.5', '0x10', '1e3', 'not-a-number']) {
    await pair(['--action=status', '--seed=definitely-missing-unused-seed', '--concurrency', value], fixture.root, 0, input.statusMaterialization);
  }
  const selected = path.join(fixture.root, 'selected-root'); validStatus(selected);
  for (const value of ['selected-root', selected, './selected-root/../selected-root']) {
    await pair(['--root', value], selected);
  }
  const unknown = await fixture.run('native', args([]), {}, fixture.unknown);
  assert.equal(unknown.status, 1); assert.equal(unknown.stdout, ''); assert.match(unknown.stderr, /native_workspace_root_required/u);
  const explicit = await fixture.run('native', args([]), { HEPTA_PAPER_WORKSPACE_ROOT: fixture.root }, fixture.unknown);
  assert.equal(explicit.status, 0); assert.deepEqual(JSON.parse(explicit.stdout), report);
});
test('normal_r_source_cas_blocked_reports_missing_input_and_tampering_match_node_without_writes', async () => {
  const scenarios = [
    ['missing-context', root => fs.mkdirSync(root, { mode: 0o700 })],
    ['missing-lock', root => fs.mkdirSync(path.join(root, 'runtime-images/r-scientific'), { recursive: true, mode: 0o700 })],
    ['missing-manifest', root => { const f = validStatus(root); fs.unlinkSync(path.join(f.context, 'source-cas/manifest.json')); }],
    ['invalid-lock', root => { const f = validStatus(root); fs.writeFileSync(path.join(f.context, 'renv.lock'), '{}'); }],
    ['bad-entry', root => { const f = validStatus(root); fs.writeFileSync(path.join(f.context, 'renv.lock'), JSON.stringify({ Packages: { demo: null } })); }],
    ['lock-json', root => { const f = validStatus(root); fs.writeFileSync(path.join(f.context, 'renv.lock'), '{'); }],
    ['extra-file', root => { const f = validStatus(root); fs.writeFileSync(path.join(f.context, 'source-cas/unexpected'), 'unknown'); }],
    ['archive-corrupt', root => { const f = validStatus(root); fs.writeFileSync(f.archive, Buffer.alloc(128, 'y')); }],
    ['index-corrupt', root => { const f = validStatus(root); fs.writeFileSync(path.join(f.context, 'source-cas/SHA256SUMS'), 'wrong'); }],
    ['manifest-drift', root => { const f = validStatus(root); const p = path.join(f.context, 'source-cas/manifest.json'), v = JSON.parse(fs.readFileSync(p)); v.packageCount = 2; fs.writeFileSync(p, JSON.stringify(v)); }],
  ];
  for (const [name, setup] of scenarios) {
    const root = path.join(fixture.root, name); setup(root);
    const report = await pair(['--root', name], root, 1); assert.equal(report.ready, false);
  }
});
test('normal_r_source_cas_native_bounded_alias_fifo_and_oversized_refusals_preserve_inputs', async () => {
  const root = path.join(fixture.root, 'bounds'), f = validStatus(root), manifest = path.join(f.context, 'source-cas/manifest.json');
  const regular = fs.readFileSync(manifest), heldArchive = fixture.pin(f.archive);
  fs.renameSync(manifest, `${manifest}.held`); fs.symlinkSync(`${manifest}.held`, manifest);
  let result = await fixture.run('native', args(['--root=bounds'])); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).ready, false);
  fs.unlinkSync(manifest); fs.unlinkSync(`${manifest}.held`);
  assert.equal(spawnSync('/usr/bin/mkfifo', [manifest], { timeout: 5_000 }).status, 0);
  result = await fixture.run('native', args(['--root=bounds'])); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).ready, false);
  fs.unlinkSync(manifest); const fd = fs.openSync(manifest, 'wx', 0o600); fs.ftruncateSync(fd, 16 * 1024 * 1024 + 1); fs.closeSync(fd);
  result = await fixture.run('native', args(['--root=bounds'])); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).ready, false);
  assert.deepEqual(fixture.pin(f.archive), heldArchive); fs.unlinkSync(manifest); fs.writeFileSync(manifest, regular);
  await pair(['--root=bounds'], root);
});
test('normal_r_source_cas_actual_unknown_entry_term_kill_then_same_namespace_fresh_status', async () => {
  for (const engine of ['node', 'native']) for (const signal of ['SIGTERM', 'SIGKILL']) {
    const before = fixture.snapshot(fixture.root);
    const interrupted = await fixture.run(engine, args([]), {}, fixture.binary, signal);
    assert.equal(interrupted.status, null); assert.equal(interrupted.signal, signal);
    assert.deepEqual(fixture.snapshot(fixture.root), before);
    await pair([], fixture.root);
    observations.push({ engine, signal, interruptionScope: 'unknown entry before report; not a publication phase or installation proof', interrupted });
  }
});
