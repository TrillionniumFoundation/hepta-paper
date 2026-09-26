#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

function git(root, args) {
  return run('git', ['-C', root, ...args]).trim();
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
  return JSON.parse(run('git', ['-C', root, 'show', `${ref}:${relative}`]));
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

function blankRange(chars, start, end) {
  for (let i = start; i < end; i += 1) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
}

export function stripRustInertText(source) {
  const chars = [...source];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '/' && chars[i + 1] === '/') {
      const start = i;
      i += 2;
      while (i < chars.length && chars[i] !== '\n') i += 1;
      blankRange(chars, start, i);
      continue;
    }
    if (chars[i] === '/' && chars[i + 1] === '*') {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < chars.length && depth > 0) {
        if (chars[i] === '/' && chars[i + 1] === '*') { depth += 1; i += 2; continue; }
        if (chars[i] === '*' && chars[i + 1] === '/') { depth -= 1; i += 2; continue; }
        i += 1;
      }
      if (depth !== 0) fail('unterminated_block_comment');
      blankRange(chars, start, i);
      continue;
    }
    const rawStart = source.slice(i).match(/^(?:br|r)(#*)"/u);
    if (rawStart) {
      const start = i;
      const hashes = rawStart[1];
      i += rawStart[0].length;
      const close = `"${hashes}`;
      const end = source.indexOf(close, i);
      if (end < 0) fail('unterminated_raw_string');
      i = end + close.length;
      blankRange(chars, start, i);
      continue;
    }
    if (chars[i] === '"' || (chars[i] === 'b' && chars[i + 1] === '"')) {
      const start = i;
      if (chars[i] === 'b') i += 1;
      i += 1;
      while (i < chars.length) {
        if (chars[i] === '\\') { i += 2; continue; }
        if (chars[i] === '"') { i += 1; break; }
        i += 1;
      }
      blankRange(chars, start, i);
      continue;
    }
    if (chars[i] === '\'' || (chars[i] === 'b' && chars[i + 1] === '\'')) {
      const start = i;
      if (chars[i] === 'b') i += 1;
      i += 1;
      while (i < chars.length) {
        if (chars[i] === '\\') { i += 2; continue; }
        if (chars[i] === '\'') { i += 1; break; }
        if (chars[i] === '\n') break;
        i += 1;
      }
      blankRange(chars, start, i);
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function rustSymbolRegex(symbol) {
  const name = escapeRegex(symbol.name);
  if (symbol.kind === 'test') return new RegExp(`#\\s*\\[\\s*test\\s*\\]\\s*(?:#\\s*\\[[^\\]]+\\]\\s*)*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\s*\\(`, 'gu');
  if (symbol.kind === 'function') return new RegExp(`(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\s*\\(`, 'gu');
  if (symbol.kind === 'type') return new RegExp(`(?:struct|enum|trait|type)\\s+${name}\\b`, 'gu');
  return new RegExp(`(?:const|static)\\s+${name}\\b`, 'gu');
}

function assertRustSymbolOwnership(root, entry) {
  const source = fs.readFileSync(path.join(root, entry.path), 'utf8');
  const live = stripRustInertText(source);
  for (const symbol of entry.symbols) {
    const matches = [...live.matchAll(rustSymbolRegex(symbol))];
    if (matches.length !== 1) fail('rust_symbol_not_unique_live', `${entry.path}:${symbol.kind}:${symbol.name}:${matches.length}`);
    const index = matches[0].index ?? 0;
    const localPrefix = live.slice(Math.max(0, index - 320), index);
    const attrs = localPrefix.match(/(?:#\s*\[[^\]]+\]\s*)+$/u)?.[0] ?? '';
    if (/\bcfg(?:_attr)?\s*\(/u.test(attrs)) fail('rust_symbol_cfg_gated', `${entry.path}:${symbol.name}`);
  }
}

function parseCargoTestBinding(command) {
  const args = command.args ?? [];
  if (args[0] !== 'test') fail('cargo_command_not_test');
  const packageIndex = args.indexOf('-p');
  if (packageIndex < 0 || !args[packageIndex + 1]) fail('cargo_package_selector_missing');
  const separatorIndex = args.indexOf('--');
  const commandEnd = separatorIndex < 0 ? args.length : separatorIndex;
  const testTargetIndex = args.indexOf('--test');
  let selectorIndex = packageIndex + 2;
  const discoveryPrefix = ['test', '--locked', '-p', args[packageIndex + 1]];
  if (testTargetIndex >= 0 && testTargetIndex < commandEnd) {
    const target = args[testTargetIndex + 1];
    if (!target || testTargetIndex + 2 >= commandEnd) fail('cargo_integration_test_selector_missing');
    discoveryPrefix.push('--test', target);
    selectorIndex = testTargetIndex + 2;
  }
  const selector = args[selectorIndex];
  if (!selector || selector.startsWith('-') || selectorIndex >= commandEnd) fail('cargo_test_selector_missing');
  return { selector, discoveryPrefix };
}

function assertCargoBinding(root, bundleId, bundle, command, runtime) {
  if (command.program !== 'cargo') return;
  const { selector, discoveryPrefix } = parseCargoTestBinding(command);
  const targetEntries = bundle.files.filter((entry) => command.expectedTargets.includes(entry.path) && entry.role === 'test');
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
  const matches = [...source.matchAll(rustSymbolRegex(symbol))];
  if (matches.length !== 1) fail('cargo_declared_test_not_unique_live', `${entry.path}:${symbol.name}:${matches.length}`);

  const discoveryArgs = [...discoveryPrefix, selector, '--', '--exact', '--list'];
  // Discovery may be the first Cargo command in a clean prospective-merge target.
  // Keep the exact selector/list proof, but give cold dependency + test-harness
  // compilation enough time instead of inheriting a historical 300s per-test
  // execution budget. The enclosing workflow still has its independent job
  // deadline, so this does not turn a hung discovery into an unbounded pass.
  const discoveryTimeoutMs = Math.max(command.timeoutSeconds * 1000, 600_000);
  const stdout = run(runtime.cargo.path, discoveryArgs, {
    cwd: path.join(root, 'rust'),
    timeout: discoveryTimeoutMs,
  });
  const discovered = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.endsWith(': test'));
  if (discovered.length !== 1 || discovered[0] !== `${selector}: test`) {
    fail('cargo_discovery_binding_failed', `${selector}:${JSON.stringify(discovered)}`);
  }
}

function validateEvidenceSemantics(root, evidence, runtime) {
  for (const [bundleId, bundle] of Object.entries(evidence.bundles ?? {})) {
    for (const entry of bundle.files ?? []) if (entry.language === 'rust') assertRustSymbolOwnership(root, entry);
    for (const command of bundle.verificationCommands ?? []) assertCargoBinding(root, bundleId, bundle, command, runtime);
  }
}

function selfTest() {
  const live = 'fn real() {}\n#[test]\nfn live_test() {}\n';
  const inert = '// fn fake() {}\nconst S: &str = "fn hidden() {}";\nr#"#[test] fn raw_fake() {}"#;\n/* fn blocked() {} */\n';
  const stripped = stripRustInertText(`${live}${inert}`);
  if (!/fn real\s*\(/u.test(stripped) || !/fn live_test\s*\(/u.test(stripped)) fail('selftest_live_lost');
  for (const name of ['fake', 'hidden', 'raw_fake', 'blocked']) {
    if (new RegExp(`fn\\s+${name}\\s*\\(`, 'u').test(stripped)) fail('selftest_inert_visible', name);
  }
  const cfg = stripRustInertText('#[cfg(feature = "never")]\nfn gated() {}\n');
  const match = [...cfg.matchAll(rustSymbolRegex({ kind: 'function', name: 'gated' }))][0];
  const attrs = cfg.slice(Math.max(0, match.index - 320), match.index).match(/(?:#\s*\[[^\]]+\]\s*)+$/u)?.[0] ?? '';
  if (!/\bcfg(?:_attr)?\s*\(/u.test(attrs)) fail('selftest_cfg_not_detected');
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
  assert.deepEqual(
    parseCargoTestBinding({ args: ['test', '--locked', '-p', 'crate-a', 'module::case', '--', '--exact'] }),
    { selector: 'module::case', discoveryPrefix: ['test', '--locked', '-p', 'crate-a'] },
  );
  assert.deepEqual(
    parseCargoTestBinding({ args: ['test', '--locked', '-p', 'crate-a', '--test', 'integration_a', 'case_a', '--', '--exact'] }),
    { selector: 'case_a', discoveryPrefix: ['test', '--locked', '-p', 'crate-a', '--test', 'integration_a'] },
  );
  assert.throws(
    () => parseCargoTestBinding({ args: ['test', '--locked', '-p', 'crate-a', '--test', 'integration_a', '--', '--exact'] }),
    /cargo_integration_test_selector_missing/u,
  );
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
assertAncestor(root, prBase, targetHead, 'pr-base-to-target');
assertAncestor(root, MAIN_BASE, APPROVED_PRODUCT, 'main-base-to-approved-product');
assertAncestor(root, APPROVED_PRODUCT, MIG002_STAGE, 'approved-product-to-mig002-stage');
assertAncestor(root, MIG002_STAGE, targetHead, 'mig002-stage-to-target');
const runtime = runtimeAttestation();
assertMig002Transition(root);
assertAncestor(root, MIG002_STAGE, prBase, 'mig002-stage-to-pr-base');
assertCandidateRegistryEvolution(root, prBase, targetHead);
for (const manifestPath of SOURCE_EVIDENCE_MANIFESTS) {
  validateEvidenceSemantics(root, readJsonAt(root, targetHead, manifestPath), runtime);
}
assertClosedCheckout(root);
const receipt = {
  schemaVersion: 1,
  kind: 'RepositorySourceEvidenceHardeningReceipt',
  prBase,
  target: targetHead,
  immutableStages: { mainBase: MAIN_BASE, approvedProduct: APPROVED_PRODUCT, mig002Stage: MIG002_STAGE },
  sourceEvidenceManifests: SOURCE_EVIDENCE_MANIFESTS,
  runtime,
  registryTransition: 'exact:MIG-002 historical transition;actual-PR-base multi-manifest evidence-declared forward-only design/source delta;authority stable',
  sourceSemantics: 'comment-string-aware-unique-symbol-plus-cargo-discovery-binding',
  checkoutPolicy: 'no-untracked-and-no-ignored-repository-inputs',
  productionAuthorized: false,
  writerCutoverAuthorized: false,
  nodeRetirementAuthorized: false,
};
fs.writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
