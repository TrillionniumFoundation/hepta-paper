#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const EVIDENCE = 'docs/system/evidence/repository-source-implementation-v1.json';
const WORK_ITEMS = 'docs/system/truth/work-items.v2.json';
const MODULES = 'docs/system/truth/modules.v1.json';
const CAPABILITIES = 'docs/system/truth/capabilities.v1.json';
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
  if (result.status !== 0) {
    fail('command_failed', `${program} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
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
  const pathEntries = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
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
  const text = run('git', ['-C', root, 'show', `${ref}:${relative}`]);
  return JSON.parse(text);
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

function assertExactRegistryTransition(root, base, target) {
  const baseWork = readJsonAt(root, base, WORK_ITEMS);
  const targetWork = readJsonAt(root, target, WORK_ITEMS);
  const expectedWork = structuredClone(baseWork);
  const baseMig = expectedWork?.items?.['MIG-002'];
  const targetMig = targetWork?.items?.['MIG-002'];
  if (!baseMig || !targetMig) fail('mig002_registry_missing');
  if (baseMig.state !== 'design_ready' || baseMig.evidenceTier !== 'design') {
    fail('mig002_base_state_invalid', `${baseMig.state}/${baseMig.evidenceTier}`);
  }
  baseMig.state = 'source_implemented';
  baseMig.evidenceTier = 'source';
  if (!equal(expectedWork, targetWork)) fail('unrelated_work_item_registry_change');
  if (targetMig.state !== 'source_implemented' || targetMig.evidenceTier !== 'source') {
    fail('mig002_target_state_invalid');
  }

  const baseModules = readJsonAt(root, base, MODULES);
  const targetModules = readJsonAt(root, target, MODULES);
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
  if (targetAdapter.activation !== 'disabled' || targetAdapter.authority !== 'prepared_result_only') {
    fail('adapter_authority_boundary_changed');
  }

  const baseCapabilities = readJsonAt(root, base, CAPABILITIES);
  const targetCapabilities = readJsonAt(root, target, CAPABILITIES);
  if (!equal(baseCapabilities, targetCapabilities)) fail('capability_registry_changed');
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

function assertCargoBinding(root, bundleId, bundle, command, runtime) {
  const args = command.args;
  if (command.program !== 'cargo') return;
  const selector = args[4];
  const testEntries = bundle.files.filter((entry) => command.expectedTargets.includes(entry.path) && entry.role === 'test');
  if (testEntries.length !== 1) fail('cargo_target_cardinality', bundleId);
  const testEntry = testEntries[0];
  if (testEntry.language !== 'rust') fail('cargo_target_language', testEntry.path);
  const testSymbols = testEntry.symbols.filter((symbol) => symbol.kind === 'test');
  if (testSymbols.length !== 1) fail('cargo_test_symbol_cardinality', testEntry.path);
  const symbol = testSymbols[0].name;
  if (!(selector === symbol || selector.endsWith(`::${symbol}`))) {
    fail('cargo_selector_not_declared_symbol', `${selector} != ${symbol}`);
  }
  const source = stripRustInertText(fs.readFileSync(path.join(root, testEntry.path), 'utf8'));
  const matches = [...source.matchAll(rustSymbolRegex(testSymbols[0]))];
  if (matches.length !== 1) fail('cargo_declared_test_not_unique_live', `${testEntry.path}:${symbol}`);

  const discoveryArgs = ['test', '--locked', '-p', args[3], selector, '--', '--exact', '--list'];
  const stdout = run(runtime.cargo.path, discoveryArgs, { cwd: path.join(root, 'rust'), timeout: command.timeoutSeconds * 1000 });
  const discovered = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.endsWith(': test'));
  if (discovered.length !== 1 || discovered[0] !== `${selector}: test`) {
    fail('cargo_discovery_binding_failed', `${selector}: ${JSON.stringify(discovered)}`);
  }
}

function validateEvidenceSemantics(root, evidence, runtime) {
  for (const [bundleId, bundle] of Object.entries(evidence.bundles ?? {})) {
    for (const entry of bundle.files ?? []) {
      if (entry.language === 'rust') assertRustSymbolOwnership(root, entry);
    }
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
const baseHead = git(root, ['rev-parse', options.base]);
if (git(root, ['merge-base', baseHead, targetHead]) !== baseHead) fail('base_not_ancestor');
const runtime = runtimeAttestation();
assertExactRegistryTransition(root, baseHead, targetHead);
const evidence = readJsonAt(root, targetHead, EVIDENCE);
validateEvidenceSemantics(root, evidence, runtime);
assertClosedCheckout(root);
const receipt = {
  schemaVersion: 1,
  kind: 'RepositorySourceEvidenceHardeningReceipt',
  base: baseHead,
  target: targetHead,
  runtime,
  registryTransition: 'exact:MIG-002:design_ready/design->source_implemented/source',
  sourceSemantics: 'comment-string-aware-unique-symbol-plus-cargo-discovery-binding',
  checkoutPolicy: 'no-untracked-and-no-ignored-repository-inputs',
  productionAuthorized: false,
  writerCutoverAuthorized: false,
  nodeRetirementAuthorized: false,
};
fs.writeFileSync(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
