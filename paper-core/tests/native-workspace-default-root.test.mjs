import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildNativeOwners, safeEnvironment } from '../../docs/tools/node-rust-route-acceptance.mjs';
import { storeStatusFixtureV1 } from '../../docs/tools/node-rust-store-route-acceptance.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let directory, deployed, executable, owner, decoy, far, runtime, database, owners;
const standalone = ['hepta-runtime-image-reproducibility', 'hepta-state-backup', 'hepta-automation-reconcile',
  'hepta-operational-proof-status', 'hepta-owner-acceptance-status'];
const environment = additions => {
  const out = safeEnvironment();
  delete out.TZ;
  return { ...out, ...additions };
};
function run(binary, argv, cwd = far, additions = {}) {
  const result = spawnSync(binary, argv, { cwd, env: environment(additions), encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  return result;
}
function report(result, code = 0) {
  assert.equal(result.status, code, result.stderr);
  return JSON.parse(result.stdout);
}
function copy(binary, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o750 });
  fs.copyFileSync(binary, destination, fs.constants.COPYFILE_EXCL); fs.chmodSync(destination, 0o750);
  assert.equal(digest(destination), digest(binary));
  const first = fs.statSync(binary), second = fs.statSync(destination);
  assert.ok(first.dev !== second.dev || first.ino !== second.ino);
  assert.deepEqual(fs.readFileSync(destination).subarray(0, 4), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
}
function marker(root) {
  for (const relative of ['paper-core/bin', 'paper-core/config']) fs.mkdirSync(path.join(root, relative), { recursive: true, mode: 0o750 });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'hepta-paper-workspace', version: '0.21.0' }), { flag: 'wx', mode: 0o640 });
}
before(() => {
  owners = buildNativeOwners({ extraBinaries: standalone }).owners; owner = owners['hepta-paper-rust'].path;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-root-'));
  deployed = path.join(directory, 'deployment'); executable = path.join(deployed, 'bin/hepta-paper-rust');
  marker(deployed); copy(owner, executable);
  for (const entry of fs.readdirSync(path.join(source, 'paper-core/src'))) {
    const destination = path.join(deployed, 'paper-core/src', entry);
    if (entry !== 'workspace-layout.mjs') { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.symlinkSync(path.join(source, 'paper-core/src', entry), destination); }
  }
  for (const name of ['hepta-paper.mjs', 'hepta-store.mjs']) fs.copyFileSync(path.join(source, 'paper-core/bin', name), path.join(deployed, 'paper-core/bin', name));
  for (const name of ['paper-composition', 'paper-domain']) fs.symlinkSync(path.join(source, name), path.join(deployed, name));
  for (const name of standalone) copy(owners[name].path, path.join(deployed, 'bin', name));
  fs.copyFileSync(path.join(source, 'paper-core/config/autonomous-research-state-databases.v1.json'),
    path.join(deployed, 'paper-core/config/autonomous-research-state-databases.v1.json'));
  for (const relative of ['paper-core/bin/workspace-status.mjs', 'paper-core/src/workspace-layout.mjs', 'paper-adapters/runtime/workspace-layout.mjs']) {
    fs.mkdirSync(path.dirname(path.join(deployed, relative)), { recursive: true });
    fs.copyFileSync(path.join(source, relative), path.join(deployed, relative));
  }
  far = path.join(directory, 'far'); decoy = path.join(directory, 'decoy'); fs.mkdirSync(far); marker(decoy);
  fs.writeFileSync(path.join(decoy, 'paper-core/config/repository-asset-externalization.v1.json'),
    JSON.stringify({ version: 1, kind: 'RepositoryAssetExternalizationManifest', assets: [] }));
  const prepared = path.join(directory, 'seed'); fs.mkdirSync(prepared);
  storeStatusFixtureV1(prepared, 'ready', environment({}));
  runtime = path.join(directory, 'hepta-paper-runtime/native-runtime'); fs.mkdirSync(path.dirname(runtime));
  fs.renameSync(path.join(prepared, 'runtime'), runtime); database = path.join(runtime, 'hepta-paper.sqlite');
  fs.chmodSync(database, 0o600);
});
after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

test('copied_ordinary_frontend_uses_its_deployment_and_matches_actual_copied_node_workspace', () => {
  const native = report(run(executable, ['operator', 'workspace'], decoy));
  const node = report(run(process.execPath, [path.join(deployed, 'paper-core/bin/workspace-status.mjs')], decoy));
  assert.equal(native.workspaceRoot, deployed);
  assert.deepEqual(native, node);
});
test('copied_ordinary_store_reads_real_sibling_runtime_without_compiled_source_default', () => {
  const native = report(run(executable, ['operator', 'store'], far));
  const node = report(run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(source, 'paper-core/bin/hepta-paper.mjs'), 'operator', 'store'],
    far, { HEPTA_PAPER_RUNTIME_ROOT: runtime }));
  assert.equal(native.ready, true); assert.deepEqual(native, node);
});
test('copied_frontend_missing_real_manifest_refuses_despite_valid_cwd_decoy', () => {
  const result = run(executable, ['verify', 'repository-assets'], decoy);
  assert.equal(result.status, 1); assert.match(result.stderr, /No such file|input-unreadable|os error 2/u);
});
test('copied_frontend_invalid_real_manifest_cannot_be_replaced_by_valid_cwd_decoy', () => {
  const manifest = path.join(deployed, 'paper-core/config/repository-asset-externalization.v1.json');
  fs.writeFileSync(manifest, JSON.stringify({ version: 2, kind: 'RepositoryAssetExternalizationManifest', assets: [] }), { flag: 'wx' });
  try {
    const value = report(run(executable, ['verify', 'repository-assets'], decoy), 1);
    assert.equal(value.repositoryBoundaryReady, false);
    assert.ok(value.integrityBlockers.includes('repository_asset_externalization_manifest_invalid'));
  } finally { fs.unlinkSync(manifest); }
});
test('typed_workspace_root_precedes_environment_and_relative_environment_uses_actual_caller_once', () => {
  const typed = report(run(executable, ['workspace-status', '--workspace-root', deployed], far, { HEPTA_PAPER_WORKSPACE_ROOT: decoy }));
  assert.equal(typed.workspaceRoot, deployed);
  const relative = report(run(executable, ['operator', 'workspace'], far, { HEPTA_PAPER_WORKSPACE_ROOT: '../deployment' }));
  assert.equal(relative.workspaceRoot, deployed);
});
test('arbitrary_copied_elf_in_debug_deps_requires_root_while_explicit_runtime_and_database_remain_independent', () => {
  const unknown = path.join(directory, 'unrecognized/debug/deps/hepta-paper-rust'); copy(owner, unknown);
  const refused = run(unknown, ['operator', 'workspace'], decoy);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /native_workspace_root_required/u);
  assert.equal(report(run(unknown, ['operator', 'workspace'], decoy, { HEPTA_PAPER_WORKSPACE_ROOT: deployed })).workspaceRoot, deployed);
  assert.equal(report(run(unknown, ['store-status', database, runtime])).ready, true);
  assert.equal(report(run(unknown, ['operator', 'store'], far, { HEPTA_PAPER_RUNTIME_ROOT: runtime })).ready, true);
});
test('actual_external_cargo_target_frontend_keeps_its_source_default_despite_cwd_decoy', () => {
  assert.equal(report(run(owner, ['operator', 'workspace'], decoy)).workspaceRoot, source);
});
test('normal_store_selected_timezone_fifo_is_bounded_and_cannot_supply_timeclip_rules', () => {
  const fifo = path.join(directory, 'timezone_fifo');
  const mkfifo = spawnSync('mkfifo', ['--mode=600', fifo], { encoding: 'utf8', timeout: 5_000, maxBuffer: 4096 });
  assert.equal(mkfifo.status, 0, mkfifo.stderr); assert.ok(fs.lstatSync(fifo).isFIFO());
  const prepared = path.join(directory, 'timeclip'); fs.mkdirSync(prepared);
  const fixture = storeStatusFixtureV1(prepared, 'date-local-timeclip', environment({}));
  const result = run(executable, ['operator', 'store', '--', '--require-trust-clean'], far,
    { ...fixture.environment, TZ: fifo });
  assert.equal(report(result, 2).ready, false);
});

test('copied_standalone_automation_reuses_real_sibling_database_and_matches_explicit_source_read', () => {
  const args = ['--at', '2026-10-01T00:00:00.000Z'];
  const value = report(run(path.join(deployed, 'bin/hepta-automation-reconcile'), args));
  const explicit = report(run(owners['hepta-automation-reconcile'].path, [...args, '--database', database]));
  assert.deepEqual(value, explicit);
});
test('copied_standalone_backup_uses_actual_manifest_and_sibling_runtime_and_retains_typed_root', () => {
  const binary = path.join(deployed, 'bin/hepta-state-backup');
  const result = run(binary, ['--action', 'status']);
  assert.ok([0, 2].includes(result.status), result.stderr);
  const value = JSON.parse(result.stdout); assert.equal(value.kind, 'AutonomousResearchStateDatabaseInventory');
  assert.ok(value.instances.some(row => row.role === 'native-store'), JSON.stringify(value));
  assert.equal(JSON.stringify(value).includes(source), false);
  const unknown = path.join(directory, 'other/hepta-state-backup'); copy(owners['hepta-state-backup'].path, unknown);
  assert.match(run(unknown, ['--action', 'status']).stderr, /native_workspace_root_required/u);
  const explicit = run(unknown, ['--action', 'status', '--root', deployed, '--runtime-root', runtime]);
  assert.equal(explicit.status, result.status, explicit.stderr); assert.deepEqual(JSON.parse(explicit.stdout), value);
  assert.equal(run(unknown, ['--help']).status, 0);
});
test('copied_owner_and_operational_inspectors_keep_actual_deployment_consumer_refusals', () => {
  const ownerResult = run(path.join(deployed, 'bin/hepta-owner-acceptance-status'), [], decoy);
  assert.equal(ownerResult.status, 1); assert.match(ownerResult.stderr, /owner_acceptance_path_invalid/u);
  const operational = run(path.join(deployed, 'bin/hepta-operational-proof-status'), [], decoy);
  assert.equal(operational.status, 1); assert.match(operational.stderr, /code_provenance_git_command_failed/u);
});
test('copied_runtime_image_unknown_layout_requires_root_and_explicit_runtime_preserves_readonly_status', () => {
  const unknown = path.join(directory, 'other/hepta-runtime-image-reproducibility'); copy(owners['hepta-runtime-image-reproducibility'].path, unknown);
  const refused = run(unknown, ['--action', 'status']); assert.equal(refused.status, 1);
  assert.match(refused.stderr, /native_workspace_root_required/u);
  const explicit = report(run(unknown, ['--action', 'status', '--runtime-root', runtime]), 2);
  const recognized = report(run(path.join(deployed, 'bin/hepta-runtime-image-reproducibility'), ['--action', 'status']), 2);
  assert.deepEqual(recognized, explicit); assert.equal(explicit.externalActionPerformed, false);
});

test('ordinary_relative_runtime_uses_actual_frontend_root_and_matches_copied_node_wrapper', () => {
  const additions = { HEPTA_PAPER_RUNTIME_ROOT: '../hepta-paper-runtime/native-runtime' };
  const native = report(run(executable, ['operator', 'store'], far, additions));
  const node = report(run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(deployed, 'paper-core/bin/hepta-paper.mjs'), 'operator', 'store'], far, additions));
  assert.equal(native.ready, true); assert.deepEqual(native, node);
  const unknown = path.join(directory, 'other/relative/hepta-paper-rust'); copy(owner, unknown);
  assert.match(run(unknown, ['operator', 'store'], far, additions).stderr, /native_workspace_root_required/u);
  assert.equal(report(run(unknown, ['operator', 'store'], far, { ...additions, HEPTA_PAPER_WORKSPACE_ROOT: deployed })).ready, true);
});
test('copied_frontend_package_marker_refuses_fifo_alias_hardlink_oversize_and_invalid_names', () => {
  const root = path.join(directory, 'marker-refusals'); marker(root);
  const binary = path.join(root, 'bin/hepta-paper-rust'); copy(owner, binary);
  const file = path.join(root, 'package.json'); fs.unlinkSync(file);
  const good = JSON.stringify({ name: 'hepta-paper-workspace', version: '0.21.0' });
  const variants = [
    () => {},
    () => fs.writeFileSync(file, JSON.stringify({ name: 'decoy' })),
    () => fs.writeFileSync(file, '{malformed'),
    () => fs.writeFileSync(file, good + ' '.repeat(65536)),
    () => { fs.writeFileSync(file, good); fs.linkSync(file, path.join(root, 'hardlink')); },
    () => { fs.writeFileSync(path.join(root, 'actual-package'), good); fs.symlinkSync('actual-package', file); },
    () => { assert.equal(spawnSync('mkfifo', ['--mode=600', file], { timeout: 5_000, maxBuffer: 4096 }).status, 0); },
  ];
  for (const prepare of variants) {
    prepare(); const result = run(binary, ['operator', 'workspace']);
    assert.equal(result.status, 1); assert.match(result.stderr, /native_workspace_root_required/u);
    for (const name of ['package.json', 'hardlink', 'actual-package']) fs.rmSync(path.join(root, name), { force: true });
  }
  fs.writeFileSync(file, good);
  const config = path.join(root, 'paper-core/config'); fs.renameSync(config, `${config}-real`); fs.symlinkSync('config-real', config);
  assert.match(run(binary, ['operator', 'workspace']).stderr, /native_workspace_root_required/u);
});
test('typed_workspace_retirement_package_fifo_is_refused_by_the_same_bounded_reader', () => {
  const root = path.join(directory, 'retirement-package-fifo'); fs.mkdirSync(root);
  const file = path.join(root, 'package.json'); assert.equal(spawnSync('mkfifo', ['--mode=600', file], { timeout: 5_000, maxBuffer: 4096 }).status, 0);
  const result = run(executable, ['retirement-status'], far, { HEPTA_PAPER_WORKSPACE_ROOT: root });
  assert.equal(result.status, 1); assert.match(result.stderr, /native_workspace_marker_invalid/u);
});
