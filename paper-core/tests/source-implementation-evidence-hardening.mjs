#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { declaresTestOwner, validateCommand } from '../bin/verify-source-implementation-evidence.mjs';
import { stripRustInertText, rustSymbolMatches, rustSymbolCfgGated } from '../src/source-evidence-rust-symbols.mjs';
import { captureCommittedSourceSubject, git } from '../src/source-evidence-git-inputs.mjs';
import { verifyProspectiveMerge } from '../../docs/tools/prepare-prospective-merge.mjs';

export { stripRustInertText };

const EVIDENCE = 'docs/system/evidence/repository-source-implementation-v1.json';
const FUNCTIONAL_EVIDENCE = 'docs/system/evidence/rust-functional-source-closure-v1.json';
const SOURCE_EVIDENCE_MANIFESTS = [EVIDENCE, FUNCTIONAL_EVIDENCE];
const WORK_ITEMS = 'docs/system/truth/work-items.v2.json';
const MODULES = 'docs/system/truth/modules.v1.json';
const CAPABILITIES = 'docs/system/truth/capabilities.v1.json';
const MAIN_BASE = '7176fdad2d5fd8ae42b6e0b89c78783f938d8bc2';
const APPROVED_PRODUCT = '38ccd556d4c741c5b0e25bd0941f419857ea314f';
const MIG002_STAGE = 'c9a19ff74fa88eb335df7c2205bd9e2fc096ca40';
const MIG002_IMPL = 'rust/crates/hepta-module-platform/src/legacy_adapter.rs';

function fail(code, detail = '') {
  throw new Error(`${code}${detail ? `: ${detail}` : ''}`);
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    timeout: options.timeout ?? 300_000,
  });
  if (result.error) fail('spawn_failed', `${program}: ${result.error.message}`);
  if (result.status !== 0) fail('command_failed', `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function resolveProgram(name) {
  if (name === 'node') return fs.realpathSync(process.execPath);
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return fs.realpathSync(candidate);
    } catch {
      // continue
    }
  }
  fail('program_not_found', name);
}

function runtimeAttestation() {
  const node = resolveProgram('node');
  const cargo = resolveProgram('cargo');
  const gitProgram = resolveProgram('git');
  const nodeVersion = run(node, ['--version']).trim();
  const cargoVersion = run(cargo, ['--version', '--verbose']).trim();
  const gitVersion = run(gitProgram, ['--version']).trim();
  if (nodeVersion !== 'v22.23.1') fail('node_version_unqualified', nodeVersion);
  if (!/^cargo 1\.98\.0\b/mu.test(cargoVersion)) fail('cargo_version_unqualified', cargoVersion);
  return {
    node: { path: node, sha256: sha256File(node), version: nodeVersion },
    cargo: { path: cargo, sha256: sha256File(cargo), version: cargoVersion.split('\n')[0] },
    git: { path: gitProgram, sha256: sha256File(gitProgram), version: gitVersion },
  };
}

function assertClosedCheckout(root) {
  const ordinary = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (ordinary) fail('dirty_or_untracked_checkout', ordinary);
  const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard']);
  if (ignored) fail('ignored_repository_inputs_present', ignored);
}

function readJsonAt(root, ref, relative) {
  return JSON.parse(git(root, ['show', `${ref}:${relative}`]));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function assertAncestor(root, ancestor, descendant, label) {
  if (git(root, ['merge-base', ancestor, descendant]) !== ancestor) fail('stage_ancestry_invalid', label);
}

function assertMig002Transition(root) {
  const baseWork = readJsonAt(root, APPROVED_PRODUCT, WORK_ITEMS);
  const targetWork = readJsonAt(root, MIG002_STAGE, WORK_ITEMS);
  const expectedWork = structuredClone(baseWork);
  const baseMig = expectedWork?.items?.['MIG-002'];
  const targetMig = targetWork?.items?.['MIG-002'];
  if (!baseMig || !targetMig) fail('mig002_registry_missing');
  if (baseMig.state !== 'design_ready' || baseMig.evidenceTier !== 'design') fail('mig002_base_state_invalid');
  baseMig.state = 'source_implemented';
  baseMig.evidenceTier = 'source';
  if (!equal(expectedWork, targetWork)) fail('unrelated_work_item_registry_change');
  if (targetMig.state !== 'source_implemented' || targetMig.evidenceTier !== 'source') fail('mig002_target_state_invalid');

  const baseModules = readJsonAt(root, APPROVED_PRODUCT, MODULES);
  const targetModules = readJsonAt(root, MIG002_STAGE, MODULES);
  const expectedModules = structuredClone(baseModules);
  const adapter = expectedModules?.modules?.['module.node-legacy-adapter'];
  const targetAdapter = targetModules?.modules?.['module.node-legacy-adapter'];
  if (!adapter || !targetAdapter) fail('adapter_module_missing');
  if (adapter.state !== 'design_ready' || adapter.activation !== 'disabled' || adapter.authority !== 'prepared_result_only') {
    fail('adapter_base_boundary_invalid');
  }
  adapter.state = 'source_implemented';
  if (!adapter.paths.includes(MIG002_IMPL)) adapter.paths.push(MIG002_IMPL);
  if (!equal(expectedModules, targetModules)) fail('unrelated_module_registry_change');
  if (targetAdapter.activation !== 'disabled' || targetAdapter.authority !== 'prepared_result_only') fail('adapter_authority_boundary_changed');

  const baseCapabilities = readJsonAt(root, APPROVED_PRODUCT, CAPABILITIES);
  const targetCapabilities = readJsonAt(root, MIG002_STAGE, CAPABILITIES);
  if (!equal(baseCapabilities, targetCapabilities)) fail('capability_registry_changed');
}

function sourceEvidenceRecordsAt(root, target) {
  const records = new Map();
  for (const manifestPath of SOURCE_EVIDENCE_MANIFESTS) {
    const manifest = readJsonAt(root, target, manifestPath);
    for (const [recordId, record] of Object.entries(manifest.records ?? {})) {
      if (records.has(recordId)) fail('duplicate_source_evidence_record', `${recordId}:${manifestPath}`);
      const evidenceFilePaths = [];
      for (const bundleId of record.bundleIds ?? []) {
        const bundle = manifest.bundles?.[bundleId];
        if (!bundle) fail('source_evidence_bundle_missing', `${recordId}:${bundleId}:${manifestPath}`);
        for (const file of bundle.files ?? []) evidenceFilePaths.push(file.path);
      }
      records.set(recordId, { ...record, manifestPath, evidenceFilePaths });
    }
  }
  return records;
}

// Historical transitions are audited separately. A current PR must preserve its
// actual base's authority and registry fields; it must not replay old promotions.
function assertCandidateRegistryEvolution(root, base, target) {
  const readState = (ref) => ({
    work: readJsonAt(root, ref, WORK_ITEMS),
    modules: readJsonAt(root, ref, MODULES),
    capabilities: readJsonAt(root, ref, CAPABILITIES),
  });
  assertRegistryDelta(readState(base), readState(target), sourceEvidenceRecordsAt(root, target));
}

function assertRegistryDelta(base, target, evidenceRecords) {
  const stageWork = base.work;
  const targetWork = target.work;
  const expectedWork = structuredClone(stageWork);
  const promotableModules = new Set();

  for (const [recordId, record] of evidenceRecords) {
    const stageItem = stageWork?.items?.[recordId];
    const targetItem = targetWork?.items?.[recordId];
    if (!stageItem || !targetItem) fail('candidate_evidence_item_missing', recordId);

    if (equal(stageItem, targetItem)) {
      if (targetItem.state === 'source_implemented' && targetItem.evidenceTier === 'source') {
        promotableModules.add(targetItem.moduleId);
      }
      continue;
    }

    const expectedItem = structuredClone(stageItem);
    if (stageItem.state !== 'design_ready'
      || stageItem.evidenceTier !== 'design'
      || targetItem.state !== 'source_implemented'
      || targetItem.evidenceTier !== 'source'
      || record.promotionRequested !== false) {
      fail('candidate_transition_not_forward_source_promotion', `${recordId}:${record.manifestPath}`);
    }
    expectedItem.state = 'source_implemented';
    expectedItem.evidenceTier = 'source';
    if (!equal(expectedItem, targetItem)) fail('candidate_work_item_scope_drift', recordId);
    expectedWork.items[recordId] = expectedItem;
    promotableModules.add(targetItem.moduleId);
  }

  // Explicit owner-policy retirement is not a source/authority promotion.
  // Keep every other field and every business/operational work item unchanged.
  for (const recordId of ['GAP-GOV-003', 'QUAL-005', 'MOD-007']) {
    const before = stageWork?.items?.[recordId];
    const after = targetWork?.items?.[recordId];
    if (!before || !after || equal(before, after)) continue;
    if (before.state !== 'blocked_external' || after.state !== 'retired') {
      fail('candidate_governance_retirement_invalid', recordId);
    }
    const retired = { ...before, state: 'retired' };
    if (!equal(retired, after)) fail('candidate_governance_retirement_scope_drift', recordId);
    expectedWork.items[recordId] = retired;
  }

  if (!equal(expectedWork, targetWork)) fail('candidate_registry_drift', WORK_ITEMS);

  const moduleEvidencePaths = new Map();
  for (const [recordId, record] of evidenceRecords) {
    const moduleId = targetWork?.items?.[recordId]?.moduleId;
    if (!moduleId || !promotableModules.has(moduleId)) continue;
    const paths = moduleEvidencePaths.get(moduleId) ?? new Set();
    for (const filePath of record.evidenceFilePaths ?? []) paths.add(filePath);
    moduleEvidencePaths.set(moduleId, paths);
  }

  const stageModules = base.modules;
  const targetModules = target.modules;
  const expectedModules = structuredClone(stageModules);
  for (const moduleId of Object.keys(targetModules?.modules ?? {})) {
    const stageModule = stageModules?.modules?.[moduleId];
    const targetModule = targetModules?.modules?.[moduleId];
    if (!stageModule || !targetModule) fail('candidate_module_missing', moduleId);
    if (equal(stageModule, targetModule)) continue;
    const expectedModule = structuredClone(stageModule);
    if (stageModule.state === 'design_ready' && targetModule.state === 'source_implemented') {
      if (!promotableModules.has(moduleId)) fail('candidate_module_transition_without_source_evidence', moduleId);
      expectedModule.state = 'source_implemented';
    } else if (stageModule.state === 'source_implemented' && targetModule.state === 'source_implemented') {
      const boundPaths = moduleEvidencePaths.get(moduleId) ?? new Set();
      const stagePaths = new Set(stageModule.paths ?? []);
      for (const selectedPath of targetModule.paths ?? []) {
        if (!stagePaths.has(selectedPath) && !boundPaths.has(selectedPath)) {
          fail('candidate_module_implementation_path_unbound', `${moduleId}:${selectedPath}`);
        }
      }
      // Removing an unselected implementation path is convergence, not promotion.
      // Every newly selected path above remains source-evidence bound.
      expectedModule.paths = targetModule.paths;
    } else {
      fail('candidate_module_transition_invalid', moduleId);
    }
    if (!equal(expectedModule, targetModule)) fail('candidate_module_scope_drift', moduleId);
    expectedModules.modules[moduleId] = expectedModule;
  }
  if (!equal(expectedModules, targetModules)) fail('candidate_registry_drift', MODULES);

  const stageCapabilities = base.capabilities;
  const targetCapabilities = target.capabilities;
  const expectedCapabilities = structuredClone(stageCapabilities);
  // Owner-retired human-approval/staffing prerequisites are not external
  // operational authorities. Once retired in machine truth, they must not remain
  // active capability blockers. No other blocker, authority or capability field
  // is permitted to change through this policy exception.
  const retiredGovernanceBlockers = new Set(
    ['GAP-GOV-003', 'QUAL-005', 'MOD-007']
      .filter((id) => targetWork?.items?.[id]?.state === 'retired'),
  );
  for (const capability of Object.values(expectedCapabilities.capabilities ?? {})) {
    if (Array.isArray(capability.externalBlockerIds)) {
      capability.externalBlockerIds = capability.externalBlockerIds
        .filter((id) => !retiredGovernanceBlockers.has(id));
    }
  }
  if (!equal(expectedCapabilities, targetCapabilities)) fail('candidate_registry_drift', CAPABILITIES);
}

function assertRustSymbolOwnership(root, entry) {
  const source = fs.readFileSync(path.join(root, entry.path), 'utf8');
  const live = stripRustInertText(source);
  for (const symbol of entry.symbols) {
    const matches = rustSymbolMatches(live, symbol);
    if (matches.length !== 1) fail('rust_symbol_not_unique_live', `${entry.path}:${symbol.kind}:${symbol.name}:${matches.length}`);
    if (rustSymbolCfgGated(live, matches[0])) fail('rust_symbol_cfg_gated', `${entry.path}:${symbol.name}`);
  }
}

function cargoDiscoveryIndex(stdout, label) {
  const tests = new Set();
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu');
  for (const raw of stdout.replace(ansiColor, '').split(/\r?\n/u)) {
    const row = raw.trim();
    if (!row.endsWith(': test')) continue;
    const selector = row.slice(0, -': test'.length);
    if (!selector || tests.has(selector)) fail('cargo_discovery_inventory_invalid', label);
    tests.add(selector);
  }
  if (tests.size === 0) fail('cargo_discovery_inventory_empty', label);
  return tests;
}

function currentCargoTargetTests(root, runtime, discoveryPrefix, timeout, inventories) {
  // Reuse only this process's actual compiled-target observation. No inventory
  // is read from disk or reused across commits, tools, roots, or invocations.
  const key = JSON.stringify([root, runtime.cargo.path, runtime.cargo.sha256, discoveryPrefix]);
  if (!inventories.has(key)) {
    const stdout = run(runtime.cargo.path, [...discoveryPrefix, '--', '--list'], {
      cwd: path.join(root, 'rust'),
      timeout,
    });
    inventories.set(key, cargoDiscoveryIndex(stdout, discoveryPrefix.join(' ')));
  }
  return inventories.get(key);
}

function assertCargoBinding(root, bundleId, bundle, command, runtime, inventories) {
  if (command.program !== 'cargo') return;
  const testPaths = new Set(bundle.files
    .filter(declaresTestOwner)
    .map((entry) => entry.path));
  const { selector, discoveryPrefix } = validateCommand(
    command,
    `bundle.${bundleId}`,
    testPaths,
  ).ownerBinding;
  const targetEntries = bundle.files.filter((entry) => command.expectedTargets.includes(entry.path)
    && declaresTestOwner(entry));
  if (targetEntries.length !== command.expectedTargets.length || targetEntries.length < 1) fail('cargo_target_cardinality', bundleId);
  const symbolName = selector.split('::').at(-1);
  const owners = [];
  for (const entry of targetEntries) {
    if (entry.language !== 'rust') fail('cargo_target_language', entry.path);
    for (const symbol of entry.symbols.filter((candidate) => candidate.kind === 'test')) {
      if (symbol.name === symbolName) owners.push({ entry, symbol });
    }
  }
  if (owners.length !== 1) fail('cargo_selector_declared_owner_cardinality', `${selector}:${owners.length}`);
  const { entry, symbol } = owners[0];
  const source = stripRustInertText(fs.readFileSync(path.join(root, entry.path), 'utf8'));
  const matches = rustSymbolMatches(source, symbol);
  if (matches.length !== 1) fail('cargo_declared_test_not_unique_live', `${entry.path}:${symbol.name}:${matches.length}`);

  // Discovery may be the first Cargo command in a clean prospective-merge target.
  // Keep the exact selector ownership proof, but give cold dependency + test-harness
  // compilation enough time instead of inheriting a historical 300s per-test
  // execution budget. The enclosing workflow still has its independent job
  // deadline, so this does not turn a hung discovery into an unbounded pass.
  const discoveryTimeoutMs = Math.max(command.timeoutSeconds * 1000, 600_000);
  const discovered = currentCargoTargetTests(root, runtime, discoveryPrefix, discoveryTimeoutMs, inventories);
  if (!discovered.has(selector)) {
    fail('cargo_discovery_binding_failed', `${selector}:absent_from_actual_target_inventory`);
  }
}

function validateEvidenceSemantics(root, evidence, runtime, inventories) {
  for (const [bundleId, bundle] of Object.entries(evidence.bundles ?? {})) {
    for (const entry of bundle.files ?? []) if (entry.language === 'rust') assertRustSymbolOwnership(root, entry);
    for (const command of bundle.verificationCommands ?? []) assertCargoBinding(root, bundleId, bundle, command, runtime, inventories);
  }
}

function selfTest() {
  assert.deepEqual([...cargoDiscoveryIndex('module::first: test\nmodule::second: test\n2 tests, 0 benchmarks\n', 'ordinary')], ['module::first', 'module::second']);
  assert.deepEqual([...cargoDiscoveryIndex('\u001b[32mmodule::first: test\u001b[0m\r\n', 'ansi')], ['module::first']);
  assert.throws(() => cargoDiscoveryIndex('0 tests, 0 benchmarks\n', 'zero'), /cargo_discovery_inventory_empty/u);
  assert.throws(() => cargoDiscoveryIndex('module::first: test\nmodule::first: test\n', 'duplicate'), /cargo_discovery_inventory_invalid/u);
  assert.equal(cargoDiscoveryIndex('module::first: test\n', 'missing').has('module::absent'), false);
  const inventories = new Map();
  const fakeRuntime = { cargo: { path: '/qualified/cargo', sha256: 'sha256:original' } };
  const prefix = ['test', '--locked', '-p', 'crate-a', '--lib'];
  const existingKey = JSON.stringify(['/source', fakeRuntime.cargo.path, fakeRuntime.cargo.sha256, prefix]);
  const observedTests = new Set(['module::first']);
  inventories.set(existingKey, observedTests);
  assert.equal(currentCargoTargetTests('/source', fakeRuntime, prefix, 30, inventories), observedTests);
  assert.equal(inventories.has(JSON.stringify(['/other-source', fakeRuntime.cargo.path, fakeRuntime.cargo.sha256, prefix])), false);
  assert.equal(inventories.has(JSON.stringify(['/source', fakeRuntime.cargo.path, 'sha256:changed', prefix])), false);
  assert.equal(inventories.has(JSON.stringify(['/source', fakeRuntime.cargo.path, fakeRuntime.cargo.sha256, [...prefix.slice(0, -1), '--test', 'other-target']])), false);
  const generic = stripRustInertText('pub fn generic_owner<T: Clone>(value: T) -> T { value }');
  assert.equal(rustSymbolMatches(generic, { kind: 'function', name: 'generic_owner' }).length, 1,
    'a real generic function is a source owner, not a missing textual shape');
  const live = 'fn real() {}\n#[test]\nfn live_test() {}\n';
  const inert = '// fn fake() {}\nconst S: &str = "fn hidden() {}";\nr#"#[test] fn raw_fake() {}"#;\n/* fn blocked() {} */\n';
  const stripped = stripRustInertText(`${live}${inert}`);
  if (!/fn real\s*\(/u.test(stripped) || !/fn live_test\s*\(/u.test(stripped)) fail('selftest_live_lost');
  for (const name of ['fake', 'hidden', 'raw_fake', 'blocked']) {
    if (new RegExp(`fn\\s+${name}\\s*\\(`, 'u').test(stripped)) fail('selftest_inert_visible', name);
  }
  const cfg = stripRustInertText('#[cfg(feature = "never")]\nfn gated() {}\n');
  const match = rustSymbolMatches(cfg, { kind: 'function', name: 'gated' })[0];
  if (!rustSymbolCfgGated(cfg, match)) fail('selftest_cfg_not_detected');
  const genericSymbol = { kind: 'function', name: 'generic_owner' };
  for (const source of [
    'pub fn generic_owner<T: Clone>(value: T) -> T { value }',
    "pub(crate) fn generic_owner<'a, T: for<'b> Fn(&'b str) -> Vec<u8>>(value: &'a T) {}",
    'fn generic_owner<const N: usize>(value: [u8; N]) -> [u8; N] { value }',
    'fn generic_owner<T: Trait<{1 > 0}>>() {}',
    'fn generic_owner<T: Fn() -> Vec<(u8, u8)>>(_: T) {}',
    String.raw`const U: &str = "🦀"; const R: &str = r###" " fn raw_decoy<T>() {} " "###; fn generic_owner<'α>(x: &'α str) {}`,
    String.raw`const C: char = '\''; const B: u8 = b'>'; fn generic_owner<T>() {}`,
  ]) {
    const tokens = stripRustInertText(source);
    assert.equal(rustSymbolMatches(tokens, genericSymbol).length, 1, source);
    assert.equal(rustSymbolMatches(tokens, { kind: 'function', name: 'raw_decoy' }).length, 0);
    assert.equal(tokens.length, source.length, 'source positions must retain UTF-16 offsets');
  }
  for (const source of [
    '// fn generic_owner<T>() {}',
    '/* nested /* fn generic_owner<T>() {} */ comment */',
    String.raw`const X: &str = "fn generic_owner<T>() {}";`,
    String.raw`const X: &str = r###" " fn generic_owner<T>() {} " "###;`,
    'fn generic_owner<T', 'fn generic_owner<T>;', 'fn generic_owner<(T]>() {}',
    'fn generic_owner_extra<T>() {}',
  ]) assert.equal(rustSymbolMatches(stripRustInertText(source), genericSymbol).length, 0, source);
  assert.equal(rustSymbolMatches('fn generic_owner<T>() {} fn generic_owner<U>() {}', genericSymbol).length, 2);
  for (const source of [
    '#[cfg(feature = "absent")]\npub fn generic_owner<T>() {}',
    `#[cfg_attr(any(), cfg(any()))]${' '.repeat(1024)}pub fn generic_owner<T>() {}`,
    '#[cfg(any())]\npub unsafe extern "C" fn generic_owner<T>() {}',
  ]) {
    const tokens = stripRustInertText(source);
    const [found] = rustSymbolMatches(tokens, genericSymbol);
    assert.ok(found); assert.equal(rustSymbolCfgGated(tokens, found), true);
  }
  const annotatedTest = stripRustInertText('#[test]\n#[cfg(any())]\nfn guarded_test() {}');
  const [testMatch] = rustSymbolMatches(annotatedTest, { kind: 'test', name: 'guarded_test' });
  assert.ok(testMatch); assert.equal(rustSymbolCfgGated(annotatedTest, testMatch), true);
  const base = {
    work: { items: { 'TEST-001': {
      state: 'source_implemented', evidenceTier: 'source', moduleId: 'module.example',
    } } },
    modules: { modules: { 'module.example': {
      state: 'source_implemented', activation: 'disabled', authority: 'prepared_result_only',
      paths: ['src/current.rs'], owners: ['owner', 'reviewer'],
    } } },
    capabilities: { capabilities: { 'CAP-EXAMPLE': { authority: 'prepared_result_only' } } },
  };
  const records = new Map([['TEST-001', {
    promotionRequested: false, manifestPath: 'synthetic-only',
  }]]);
  // An already implemented current base is not an invalid old-stage promotion.
  assert.doesNotThrow(() => assertRegistryDelta(base, structuredClone(base), records));
  const design = structuredClone(base);
  design.work.items['TEST-001'].state = 'design_ready';
  design.work.items['TEST-001'].evidenceTier = 'design';
  design.modules.modules['module.example'].state = 'design_ready';
  assert.doesNotThrow(() => assertRegistryDelta(design, base, records));
  assert.throws(() => assertRegistryDelta(design, base, new Map()), /candidate_registry_drift/u);
  assert.throws(() => assertRegistryDelta(base, design, records), /candidate_transition/u);
  for (const [field, value] of [
    ['activation', 'authoritative'], ['authority', 'central_state_write'],
    ['paths', ['src/other.rs']], ['owners', ['reviewer', 'owner']],
    ['state', 'source_qualified'],
  ]) {
    const hostile = structuredClone(base);
    hostile.modules.modules['module.example'][field] = value;
    assert.throws(() => assertRegistryDelta(base, hostile, records), /candidate_module_/u);
  }
  const changedCapability = structuredClone(base);
  changedCapability.capabilities.capabilities['CAP-EXAMPLE'].authority = 'central_state_write';
  assert.throws(() => assertRegistryDelta(base, changedCapability, records), /candidate_registry_drift/u);
  const erased = structuredClone(base);
  delete erased.work.items['TEST-001'];
  assert.throws(() => assertRegistryDelta(base, erased, records), /candidate_evidence_item_missing/u);
  const unrelated = structuredClone(base);
  unrelated.work.items['OTHER-001'] = structuredClone(base.work.items['TEST-001']);
  assert.throws(() => assertRegistryDelta(base, unrelated, records), /candidate_registry_drift/u);
  assert.deepEqual(validateCommand({
    args: ['test', '--locked', '-p', 'crate-a', '--lib', 'module::case', '--', '--exact', '--nocapture'],
    expectedExitCode: 0,
    expectedTargets: ['rust/crates/crate-a/src/module/tests.rs'],
    program: 'cargo',
    timeoutSeconds: 30,
    workdir: 'rust',
  }, 'library', new Set(['rust/crates/crate-a/src/module/tests.rs'])).ownerBinding, {
    discoveryPrefix: ['test', '--locked', '-p', 'crate-a', '--lib'],
    packageName: 'crate-a',
    selector: 'module::case',
    targetKind: 'library',
    testTarget: null,
  });
  assert.deepEqual(validateCommand({
    args: [
      'test', '--locked', '-p', 'crate-a', '--test', 'integration_a',
      'case_a', '--', '--exact', '--nocapture',
    ],
    expectedExitCode: 0,
    expectedTargets: ['rust/crates/crate-a/tests/integration_a/nested.rs'],
    program: 'cargo',
    timeoutSeconds: 30,
    workdir: 'rust',
  }, 'integration', new Set(['rust/crates/crate-a/tests/integration_a/nested.rs'])).ownerBinding, {
    discoveryPrefix: ['test', '--locked', '-p', 'crate-a', '--test', 'integration_a'],
    packageName: 'crate-a',
    selector: 'case_a',
    targetKind: 'integration',
    testTarget: 'integration_a',
  });
  assert.throws(() => validateCommand({
    args: ['test', '--locked', '-p', 'crate-a', 'module::case', '--', '--exact', '--nocapture'],
    expectedExitCode: 0,
    expectedTargets: ['rust/crates/crate-a/src/module/tests.rs'],
    program: 'cargo',
    timeoutSeconds: 30,
    workdir: 'rust',
  }, 'unscoped', new Set(['rust/crates/crate-a/src/module/tests.rs'])), /cargo_command_not_allowlisted/u);
  const policyBase = structuredClone(base);
  for (const id of ['GAP-GOV-003', 'QUAL-005', 'MOD-007']) {
    policyBase.work.items[id] = {
      state: 'blocked_external', evidenceTier: 'external_authority', moduleId: 'module.example',
    };
  }
  policyBase.capabilities.capabilities['CAP-EXAMPLE'].externalBlockerIds = [
    'GAP-GOV-003', 'QUAL-005', 'MOD-007', 'GAP-HOST-001',
  ];
  const retired = structuredClone(policyBase);
  for (const id of ['GAP-GOV-003', 'QUAL-005', 'MOD-007']) retired.work.items[id].state = 'retired';
  retired.capabilities.capabilities['CAP-EXAMPLE'].externalBlockerIds = ['GAP-HOST-001'];
  assert.doesNotThrow(() => assertRegistryDelta(policyBase, retired, records));
  for (const change of [
    (candidate) => { candidate.work.items['GAP-GOV-003'].state = 'source_qualified'; },
    (candidate) => { candidate.work.items['QUAL-005'].evidenceTier = 'source'; },
    (candidate) => { candidate.capabilities.capabilities['CAP-EXAMPLE'].externalBlockerIds.push('MOD-007'); },
    (candidate) => { candidate.capabilities.capabilities['CAP-EXAMPLE'].externalBlockerIds = []; },
    (candidate) => { candidate.modules.modules['module.example'].activation = 'authoritative'; },
    (candidate) => { candidate.work.items['TEST-001'].state = 'retired'; },
  ]) {
    const hostile = structuredClone(retired);
    change(hostile);
    assert.throws(() => assertRegistryDelta(policyBase, hostile, records), /candidate_/u);
  }
  assert.throws(() => assertRegistryDelta(retired, policyBase, records), /candidate_governance_retirement_invalid/u);
  process.stdout.write('source-evidence hardening self-test: ok\n');
}

function parseArgs(argv) {
  const options = { selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--target') options.target = argv[++i];
    else if (arg === '--receipt') options.receipt = argv[++i];
    else fail('unknown_argument', arg);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.selfTest) {
  selfTest();
  process.exit(0);
}
if (!options.base || !options.target || !options.receipt) fail('required_arguments_missing');
const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
assertClosedCheckout(root);
const targetHead = git(root, ['rev-parse', options.target]);
const prBase = git(root, ['rev-parse', options.base]);
const sourceSubject = captureCommittedSourceSubject(root);
if (!sourceSubject.committedClean) {
  fail('hardening_source_subject_mismatch', targetHead);
}
let sourceSubjectKind = 'exact-head';
if (sourceSubject.commit !== targetHead) {
  const observedMerge = verifyProspectiveMerge({ root, base: prBase, target: targetHead, commit: sourceSubject.commit });
  if (observedMerge.tree !== sourceSubject.tree) fail('hardening_source_subject_mismatch', targetHead);
  sourceSubjectKind = 'prospective-merge';
}
assertAncestor(root, prBase, targetHead, 'pr-base-to-target');
assertAncestor(root, MAIN_BASE, APPROVED_PRODUCT, 'main-base-to-approved-product');
assertAncestor(root, APPROVED_PRODUCT, MIG002_STAGE, 'approved-product-to-mig002-stage');
assertAncestor(root, MIG002_STAGE, targetHead, 'mig002-stage-to-target');
const runtime = runtimeAttestation();
assertMig002Transition(root);
assertAncestor(root, MIG002_STAGE, prBase, 'mig002-stage-to-pr-base');
assertCandidateRegistryEvolution(root, prBase, sourceSubject.commit);
const cargoInventories = new Map();
for (const manifestPath of SOURCE_EVIDENCE_MANIFESTS) {
  validateEvidenceSemantics(root, readJsonAt(root, sourceSubject.commit, manifestPath), runtime, cargoInventories);
}
assertClosedCheckout(root);
if (!equal(captureCommittedSourceSubject(root), sourceSubject)) fail('hardening_source_subject_changed');
if (!equal(runtimeAttestation(), runtime)) fail('hardening_runtime_changed');
const receipt = {
  schemaVersion: 1,
  kind: 'RepositorySourceEvidenceHardeningReceipt',
  prBase,
  target: targetHead,
  immutableStages: { mainBase: MAIN_BASE, approvedProduct: APPROVED_PRODUCT, mig002Stage: MIG002_STAGE },
  sourceEvidenceManifests: SOURCE_EVIDENCE_MANIFESTS,
  sourceSubject,
  sourceSubjectKind,
  runtime,
  registryTransition: 'exact:MIG-002 historical transition;actual-PR-base multi-manifest evidence-declared forward-only design/source delta;authority stable',
  sourceSemantics: 'comment-string-aware-unique-symbol-plus-current-process-cargo-target-inventory-binding',
  checkoutPolicy: 'no-untracked-and-no-ignored-repository-inputs',
  productionAuthorized: false,
  writerCutoverAuthorized: false,
  nodeRetirementAuthorized: false,
};
fs.writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
