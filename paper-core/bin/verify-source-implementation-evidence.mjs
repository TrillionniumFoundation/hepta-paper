#!/usr/bin/env node

import { stripRustInertText, rustSymbolMatches } from '../src/source-evidence-rust-symbols.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  fail, run, git, trackedBlob, readPinnedSource, assertSourceSubject,
} from '../src/source-evidence-git-inputs.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseStrictJson } from '../src/source-evidence-strict-json.mjs';
import {
  SAFE_RUST_TEST_PATTERN, artifactPin, assertExactCargoOwnerExecution,
  cargoTargetObservation, cargoEnvironmentObservation, exactCargoTestInventory, assertCargoBinaryArtifactsCurrent, assertCargoBuildScriptsCurrent,
} from '../src/source-evidence-cargo-observations.mjs';
import { hashBytes, producerPin } from '../src/source-evidence-producer.mjs';
export { parseStrictJson } from '../src/source-evidence-strict-json.mjs';
export {
  assertExactCargoOwnerExecution, cargoTargetObservation, cargoEnvironmentObservation, exactCargoTestInventory,
} from '../src/source-evidence-cargo-observations.mjs';
export { SOURCE_EVIDENCE_PRODUCER_PATHS } from '../src/source-evidence-producer.mjs';

const MAX_COMMAND_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_COMMAND_TIMEOUT_SECONDS = 1200;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const MODULE_PATTERN = /^module\.[a-z0-9-]+$/;
const CAPABILITY_PATTERN = /^CAP-[A-Z0-9-]+$/;
const WORK_ITEM_PATTERN = /^[A-Z][A-Z0-9-]*$/;
const BUNDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SYMBOL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NODE_TEST_TITLE_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const SAFE_PACKAGE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AUTHORITY_KEYS = Object.freeze([
  'externalAuthorityGranted',
  'nodeRetirementAuthorized',
  'productionActivated',
  'targetHostQualified',
  'writerCutoverAuthorized',
]);
const TOP_LEVEL_KEYS = Object.freeze([
  '$schema',
  'bundles',
  'kind',
  'promotionPolicy',
  'records',
  'registries',
  'repository',
  'schemaVersion',
  'subjectPolicy',
]);
const REGISTRY_KEYS = Object.freeze(['capabilities', 'modules', 'workItems']);
const BUNDLE_KEYS = Object.freeze(['description', 'files', 'verificationCommands']);
const FILE_KEYS = Object.freeze(['gitBlob', 'language', 'mode', 'path', 'role', 'symbols']);
const SYMBOL_KEYS = Object.freeze(['kind', 'name']);
const COMMAND_KEYS = Object.freeze([
  'args',
  'expectedExitCode',
  'expectedTargets',
  'program',
  'timeoutSeconds',
  'workdir',
]);
const RECORD_KEYS = Object.freeze([
  'authorityClaims',
  'bundleIds',
  'capabilityIds',
  'evidenceTier',
  'moduleId',
  'promotionRequested',
  'workItemId',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) fail('object_required', label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    fail('closed_keys_mismatch', `${label} actual=${actual.join(',')} expected=${wanted.join(',')}`);
  }
}

function requireString(value, label, pattern = null) {
  if (typeof value !== 'string' || value.length === 0) fail('string_required', label);
  if (pattern && !pattern.test(value)) fail('string_domain_invalid', `${label}=${value}`);
  return value;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('integer_domain_invalid', `${label}=${String(value)}`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') fail('boolean_required', label);
  return value;
}

function requireUniqueStrings(value, label, { minimum = 1, pattern = null } = {}) {
  if (!Array.isArray(value) || value.length < minimum) fail('string_array_invalid', label);
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    requireString(entry, `${label}[${index}]`, pattern);
    if (seen.has(entry)) fail('duplicate_array_value', `${label}=${entry}`);
    seen.add(entry);
  }
  return value;
}

function canonicalRelative(value, label, { allowDot = false } = {}) {
  requireString(value, label);
  if (allowDot && value === '.') return value;
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    fail('path_not_canonical', `${label}=${value}`);
  }
  const parts = value.split('/');
  if (parts.some((entry) => entry.length === 0 || entry === '.' || entry === '..')) {
    fail('path_not_canonical', `${label}=${value}`);
  }
  if (path.posix.normalize(value) !== value) fail('path_not_canonical', `${label}=${value}`);
  return value;
}

function commandDiagnostic(value) {
  const bytes = Buffer.from(value ?? '', 'utf8');
  const tail = bytes.subarray(Math.max(0, bytes.length - MAX_COMMAND_DIAGNOSTIC_BYTES));
  return {
    byteCount: bytes.length,
    sha256: hashBytes(bytes),
    tailBase64: tail.toString('base64'),
    truncated: tail.length !== bytes.length,
  };
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function verifySymbol(text, language, symbol, relative) {
  const name = escaped(symbol.name);
  let expression;
  if (language === 'rust') {
    if (rustSymbolMatches(stripRustInertText(text), symbol).length === 0) {
      fail('source_symbol_missing', `${relative}:${symbol.kind}:${symbol.name}`);
    }
    return;
  } else if (language === 'javascript') {
    if (symbol.kind === 'test') {
      expression = new RegExp(`(?:test|it)\\s*\\(\\s*['\"]${name}['\"]`, 'u');
    } else if (symbol.kind === 'function') {
      expression = new RegExp(`(?:export\\s+)?(?:async\\s+)?(?:function\\s+${name}\\b|const\\s+${name}\\s*=)`, 'u');
    } else if (symbol.kind === 'type') {
      expression = new RegExp(`(?:class|const)\\s+${name}\\b`, 'u');
    } else {
      expression = new RegExp(`(?:export\\s+)?const\\s+${name}\\b`, 'u');
    }
  } else {
    fail('symbol_language_unsupported', `${relative}:${language}`);
  }
  if (!expression.test(text)) fail('source_symbol_missing', `${relative}:${symbol.kind}:${symbol.name}`);
}

function checkedFile(root, entry, globalPaths, bundleLabel) {
  exactKeys(entry, FILE_KEYS, `${bundleLabel}.file`);
  const relative = canonicalRelative(entry.path, `${bundleLabel}.file.path`);
  if (globalPaths.has(relative)) fail('duplicate_evidence_path', relative);
  globalPaths.add(relative);
  if (!['implementation', 'test'].includes(entry.role)) fail('file_role_invalid', relative);
  requireString(entry.gitBlob, `${relative}.gitBlob`, SHA1_PATTERN);
  if (!['100644', '100755'].includes(entry.mode)) {
    fail('file_mode_invalid', `${relative}=${entry.mode}`);
  }
  if (!['javascript', 'json', 'rust', 'shell'].includes(entry.language)) {
    fail('file_language_invalid', `${relative}=${entry.language}`);
  }
  if (!Array.isArray(entry.symbols) || entry.symbols.length < 1) {
    fail('source_symbol_required', relative);
  }
  const absolute = path.resolve(root, relative);
  const text = readPinnedSource(root, relative, { mode: entry.mode, blob: entry.gitBlob }).toString('utf8');
  const seenSymbols = new Set();
  for (const [index, symbol] of entry.symbols.entries()) {
    exactKeys(symbol, SYMBOL_KEYS, `${relative}.symbols[${index}]`);
    if (!['constant', 'function', 'test', 'type'].includes(symbol.kind)) {
      fail('symbol_kind_invalid', `${relative}:${symbol.kind}`);
    }
    // Node test identity is its actual readable title; Rust declarations and
    // JavaScript code symbols still require identifiers. Every selected title
    // must exist in pinned source and in the complete successful TAP transcript.
    requireString(symbol.name, `${relative}.symbols[${index}].name`,
      entry.language === 'javascript' && symbol.kind === 'test'
        ? NODE_TEST_TITLE_PATTERN : SYMBOL_PATTERN);
    const identity = `${symbol.kind}:${symbol.name}`;
    if (seenSymbols.has(identity)) fail('duplicate_symbol', `${relative}:${identity}`);
    seenSymbols.add(identity);
    verifySymbol(text, entry.language, symbol, relative);
  }
  return { ...entry, relative, absolute };
}

function scopedCargoTestTarget(expectedTarget) {
  const direct = /^rust\/crates\/([^/]+)\/tests\/([^/]+)\.rs$/u.exec(expectedTarget);
  if (direct !== null) return { packageName: direct[1], testTarget: direct[2] };
  const nested = /^rust\/crates\/([^/]+)\/tests\/([^/]+)\/(?:[^/]+\/)*[^/]+\.rs$/u.exec(
    expectedTarget,
  );
  if (nested === null) return null;
  return { packageName: nested[1], testTarget: nested[2] };
}

function scopedCargoLibraryTarget(expectedTarget) {
  const match = /^rust\/crates\/([^/]+)\/src\/(?:[^/]+\/)*[^/]+\.rs$/u.exec(expectedTarget);
  if (match === null) return null;
  return { packageName: match[1] };
}

// Call only after the file's declared symbols have been verified against its
// pinned live source. Rust implementation modules can also own inline #[test]
// functions; a role label alone must not hide that explicit, checked owner.
export function declaresTestOwner(entry) {
  return entry.role === 'test'
    || (entry.role === 'implementation' && entry.language === 'rust'
      && entry.symbols.some((symbol) => symbol.kind === 'test'));
}

export function validateCommand(command, label, testPaths) {
  exactKeys(command, COMMAND_KEYS, label);
  requireString(command.program, `${label}.program`);
  if (!Array.isArray(command.args) || command.args.length < 2) fail('command_args_invalid', label);
  for (const [index, argument] of command.args.entries()) {
    requireString(argument, `${label}.args[${index}]`);
    if (argument.includes('\0') || /[\r\n]/u.test(argument)) fail('command_arg_invalid', label);
  }
  const workdir = canonicalRelative(command.workdir, `${label}.workdir`, { allowDot: true });
  if (command.expectedExitCode !== 0) fail('command_exit_policy_invalid', label);
  requireInteger(command.timeoutSeconds, `${label}.timeoutSeconds`, 1, MAX_COMMAND_TIMEOUT_SECONDS);
  requireUniqueStrings(command.expectedTargets, `${label}.expectedTargets`, { minimum: 1 });
  for (const target of command.expectedTargets) {
    canonicalRelative(target, `${label}.expectedTarget`);
    if (!testPaths.has(target)) fail('command_target_not_declared_test', `${label}:${target}`);
  }

  if (command.program === 'node') {
    const allowed = command.args.length === 2
      && command.args[0] === '--test'
      && command.args[1] === command.expectedTargets[0]
      && command.expectedTargets.length === 1
      && workdir === '.';
    if (!allowed) fail('node_command_not_allowlisted', label);
  } else if (command.program === 'cargo') {
    // A selected ignored recovery fixture must actually run. This one closed
    // suffix retains the same exact owner/discovery and one-passed/zero-ignored
    // transcript policy; it never accepts package-wide or skipped execution.
    const args = command.args.at(-2) === '--ignored'
      ? command.args.filter((_argument, index) => index !== command.args.length - 2)
      : command.args;
    const integrationTarget = command.expectedTargets.length === 1
      ? scopedCargoTestTarget(command.expectedTargets[0])
      : null;
    const integrationScoped = args.length === 10
      && args[0] === 'test'
      && args[1] === '--locked'
      && args[2] === '-p'
      && SAFE_PACKAGE_PATTERN.test(args[3])
      && args[4] === '--test'
      && SAFE_RUST_TEST_PATTERN.test(args[5])
      && SAFE_RUST_TEST_PATTERN.test(args[6])
      && args[7] === '--'
      && args[8] === '--exact'
      && args[9] === '--nocapture'
      && integrationTarget !== null
      && integrationTarget.packageName === args[3]
      && integrationTarget.testTarget === args[5];
    const libraryTarget = command.expectedTargets.length === 1
      ? scopedCargoLibraryTarget(command.expectedTargets[0])
      : null;
    const libraryScoped = args.length === 9
      && args[0] === 'test'
      && args[1] === '--locked'
      && args[2] === '-p'
      && SAFE_PACKAGE_PATTERN.test(args[3])
      && args[4] === '--lib'
      && SAFE_RUST_TEST_PATTERN.test(args[5])
      && args[6] === '--'
      && args[7] === '--exact'
      && args[8] === '--nocapture'
      && libraryTarget !== null
      && libraryTarget.packageName === args[3];
    const ownerBinding = integrationScoped
      ? {
        discoveryPrefix: args.slice(0, 6),
        packageName: args[3],
        selector: args[6],
        targetKind: 'integration',
        testTarget: args[5],
      }
      : libraryScoped
        ? {
          discoveryPrefix: args.slice(0, 5),
          packageName: args[3],
          selector: args[5],
          targetKind: 'library',
          testTarget: null,
        }
        : null;
    if (ownerBinding === null || workdir !== 'rust') fail('cargo_command_not_allowlisted', label);
    return { ...command, workdir, ownerBinding };
  } else {
    fail('command_program_not_allowlisted', `${label}:${command.program}`);
  }
  return { ...command, workdir };
}

function registryObject(document, key, label) {
  if (!isPlainObject(document) || !isPlainObject(document[key])) {
    fail('registry_shape_invalid', label);
  }
  return document[key];
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((entry, index) => entry === b[index]);
}

export function validateEvidenceDocument(document, context) {
  exactKeys(document, TOP_LEVEL_KEYS, 'evidence');
  if (document.$schema !== '../schemas/source-implementation-evidence-v1.schema.json') {
    fail('schema_pointer_invalid', document.$schema);
  }
  if (document.schemaVersion !== 1) fail('schema_version_invalid');
  if (document.kind !== 'RepositorySourceImplementationEvidenceV1') fail('kind_invalid');
  if (document.repository !== 'TrillionniumFoundation/hepta-paper') fail('repository_invalid');
  if (document.subjectPolicy !== 'current_clean_git_head_tree_and_exact_blobs') {
    fail('subject_policy_invalid');
  }
  if (document.promotionPolicy !== 'semantic_registry_binding_plus_exact_git_blobs_plus_executable_owner_tests') {
    fail('promotion_policy_invalid');
  }
  exactKeys(document.registries, REGISTRY_KEYS, 'registries');
  const expectedRegistries = {
    workItems: 'docs/system/truth/work-items.v2.json',
    modules: 'docs/system/truth/modules.v1.json',
    capabilities: 'docs/system/truth/capabilities.v1.json',
  };
  for (const key of REGISTRY_KEYS) {
    if (document.registries[key] !== expectedRegistries[key]) {
      fail('registry_path_invalid', `${key}=${document.registries[key]}`);
    }
  }
  if (!isPlainObject(document.bundles) || Object.keys(document.bundles).length < 1) {
    fail('bundles_required');
  }
  if (!isPlainObject(document.records) || Object.keys(document.records).length < 1) {
    fail('records_required');
  }

  const globalPaths = new Set();
  const validatedBundles = new Map();
  for (const [bundleId, bundle] of Object.entries(document.bundles)) {
    requireString(bundleId, 'bundleId', BUNDLE_PATTERN);
    exactKeys(bundle, BUNDLE_KEYS, `bundle.${bundleId}`);
    requireString(bundle.description, `bundle.${bundleId}.description`);
    if (!Array.isArray(bundle.files) || bundle.files.length < 2) {
      fail('bundle_files_invalid', bundleId);
    }
    const files = bundle.files.map((entry) => checkedFile(
      context.root,
      entry,
      globalPaths,
      `bundle.${bundleId}`,
    ));
    const roles = new Set(files.map((entry) => entry.role));
    if (!roles.has('implementation') || !roles.has('test')) {
      fail('bundle_roles_incomplete', bundleId);
    }
    const testPaths = new Set(files.filter(declaresTestOwner).map((entry) => entry.path));
    if (!Array.isArray(bundle.verificationCommands) || bundle.verificationCommands.length < 1) {
      fail('verification_commands_required', bundleId);
    }
    const commands = bundle.verificationCommands.map((command, index) => validateCommand(
      command,
      `bundle.${bundleId}.verificationCommands[${index}]`,
      testPaths,
    ));
    validatedBundles.set(bundleId, { ...bundle, files, commands });
  }

  const workItems = registryObject(context.workItems, 'items', 'workItems');
  const modules = registryObject(context.modules, 'modules', 'modules');
  const capabilities = registryObject(context.capabilities, 'capabilities', 'capabilities');
  const referencedBundles = new Set();
  const promotions = [];

  for (const [recordId, record] of Object.entries(document.records)) {
    requireString(recordId, 'recordId', WORK_ITEM_PATTERN);
    exactKeys(record, RECORD_KEYS, `record.${recordId}`);
    if (record.workItemId !== recordId) fail('record_key_mismatch', recordId);
    const item = workItems[record.workItemId];
    if (!isPlainObject(item)) fail('unknown_work_item', record.workItemId);
    if (item.type === 'external_gap' || item.state === 'blocked_external') {
      fail('external_item_not_promotable', record.workItemId);
    }
    requireString(record.moduleId, `${recordId}.moduleId`, MODULE_PATTERN);
    if (!isPlainObject(modules[record.moduleId])) fail('unknown_module', record.moduleId);
    if (record.moduleId !== item.moduleId) fail('work_item_module_mismatch', recordId);
    requireUniqueStrings(record.capabilityIds, `${recordId}.capabilityIds`, {
      minimum: 1,
      pattern: CAPABILITY_PATTERN,
    });
    for (const capabilityId of record.capabilityIds) {
      if (!isPlainObject(capabilities[capabilityId])) fail('unknown_capability', capabilityId);
    }
    if (!sameStringSet(record.capabilityIds, item.capabilityIds)) {
      fail('work_item_capability_mismatch', recordId);
    }
    if (record.evidenceTier !== 'source') fail('evidence_tier_invalid', recordId);
    requireUniqueStrings(record.bundleIds, `${recordId}.bundleIds`, {
      minimum: 1,
      pattern: BUNDLE_PATTERN,
    });
    for (const bundleId of record.bundleIds) {
      if (!validatedBundles.has(bundleId)) fail('unknown_bundle_reference', `${recordId}:${bundleId}`);
      referencedBundles.add(bundleId);
    }
    exactKeys(record.authorityClaims, AUTHORITY_KEYS, `${recordId}.authorityClaims`);
    for (const key of AUTHORITY_KEYS) {
      if (requireBoolean(record.authorityClaims[key], `${recordId}.authorityClaims.${key}`)) {
        fail('authority_claim_forbidden', `${recordId}:${key}`);
      }
    }
    requireBoolean(record.promotionRequested, `${recordId}.promotionRequested`);
    if (record.promotionRequested) {
      if (item.state !== 'design_ready' || item.evidenceTier !== 'design') {
        fail('promotion_source_state_invalid', recordId);
      }
      promotions.push(recordId);
    } else if (item.state !== 'source_implemented' || item.evidenceTier !== 'source') {
      fail('existing_source_state_invalid', recordId);
    }
  }

  for (const bundleId of validatedBundles.keys()) {
    if (!referencedBundles.has(bundleId)) fail('orphan_bundle', bundleId);
  }
  return { bundles: validatedBundles, promotions };
}

function safeExecutionEnvironment() {
  const allowed = [
    'CARGO_HOME',
    'CARGO_TARGET_DIR',
    'CARGO_TERM_COLOR',
    'HOME',
    'LANG',
    'LC_ALL',
    'PATH',
    'RUSTFLAGS',
    'RUSTUP_HOME',
    'TMPDIR',
    'USER',
  ];
  const env = Object.create(null);
  for (const key of allowed) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  env.CI = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  // The test oracle receives the actual producer executable, never an ambient
  // caller override or a path searched by a privileged test child.
  env.HEPTA_TEST_NODE = fs.realpathSync(process.execPath);
  return env;
}

// A successful test process is not evidence that the selected test executed.
// These are pinned libtest/TAP transcript checks, not producer authentication:
// exact source ownership and the independent cargo discovery gate still apply.
function assertTestExecution(command, bundle, stdout, label) {
  const text = stdout.replace(/\x1b\[[0-9;]*m/gu, '');
  if (command.program === 'cargo') {
    const selector = command.args[4] === '--test' ? command.args[6] : command.args[5];
    const resultRows = text.split(/\r?\n/u)
      .filter((line) => line.startsWith(`test ${selector} ... `));
    const summaries = [...text.matchAll(
      /^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;[^\r\n]*$/gmu,
    )];
    const counts = summaries.map((row) => row.slice(1, 6).map(Number));
    if (resultRows.length !== 1 || resultRows[0] !== `test ${selector} ... ok`
        || counts.length === 0
        || counts.some((row) => row.some((value) => !Number.isSafeInteger(value)))
        || counts.reduce((sum, row) => sum + row[0], 0) !== 1
        || counts.some((row) => row[1] !== 0 || row[2] !== 0 || row[3] !== 0)) {
      fail('verification_test_execution_incomplete', `${label}:${selector}`);
    }
    return;
  }
  // Node's non-TTY --test output is TAP. Require the actual aggregate footer;
  // a file that merely loads (zero registered tests) is not an owner test.
  const totals = Object.create(null);
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const values = [...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gmu'))];
    if (values.length !== 1 || !Number.isSafeInteger(Number(values[0][1]))) {
      fail('verification_test_execution_incomplete', `${label}:tap_${key}`);
    }
    totals[key] = Number(values[0][1]);
  }
  const successful = [...text.matchAll(/^\s*ok \d+ - (.+)$/gmu)]
    .map((row) => row[1]);
  const named = successful.filter((name) => !/ # (?:SKIP|TODO)\b/iu.test(name)
    && !command.expectedTargets.some((target) => name === target || name.endsWith(`/${target}`)));
  const expectedNames = bundle.files
    .filter((file) => command.expectedTargets.includes(file.path))
    .flatMap((file) => file.symbols.filter((symbol) => symbol.kind === 'test').map((symbol) => symbol.name));
  if (totals.tests < 1 || totals.pass !== totals.tests
      || ['fail', 'cancelled', 'skipped', 'todo'].some((key) => totals[key] !== 0)
      || named.length === 0 || expectedNames.some((name) => !named.includes(name))) {
    fail('verification_test_execution_incomplete', `${label}:tap_execution`);
  }
}

export function executeCommands(root, bundles, source) {
  const observations = [];
  const targets = [];
  const inventories = new Map();
  const binaryImages = new Map();
  const buildImages = new Map();
  const env = safeExecutionEnvironment();
  const rootReal = fs.realpathSync(root);
  let runtime;
  let producer;
  let finalRemaining;
  for (const [bundleId, bundle] of bundles.entries()) {
    for (const [index, command] of bundle.commands.entries()) {
      const label = `${bundleId}:${index}`;
      const started = process.hrtime.bigint();
      const remaining = () => {
        const milliseconds = command.timeoutSeconds * 1000 - Number((process.hrtime.bigint() - started) / 1000000n);
        if (milliseconds <= 0) fail('verification_command_budget_exhausted', label);
        return milliseconds;
      };
      finalRemaining = remaining;
      const cwd = command.workdir === '.' ? root : path.resolve(root, command.workdir);
      const cwdReal = fs.realpathSync(cwd);
      if (cwdReal !== rootReal && !cwdReal.startsWith(`${rootReal}${path.sep}`)) fail('command_workdir_escape', label);
      const binding = command.ownerBinding;
      let executable = command.program;
      let args = command.args;
      let executionEnv = env;
      let executionCwd = cwdReal;
      let inventory;
      if (binding) {
        if (!runtime) {
          let cargo;
          for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
            const candidate = path.join(directory, 'cargo');
            try {
              const value = fs.statSync(candidate);
              if (!value.isFile() || (value.mode & 0o111) === 0) continue;
              const pin = artifactPin(fs.realpathSync(candidate), rootReal);
              const qualificationTimeoutMs = remaining();
              const version = run(pin.path, ['--version', '--verbose'], { cwd: cwdReal, env, timeout: qualificationTimeoutMs });
              const host = /^host: ([A-Za-z0-9_-]+)$/mu.exec(version.stdout ?? '')?.[1];
              if (version.status !== 0 || !/^cargo 1\.98\.0\b/u.test(version.stdout ?? '') || !host) {
                fail('verification_cargo_runtime_unqualified', label);
              }
              cargo = { ...pin, version: version.stdout.trim(), host, qualification: { args: ['--version', '--verbose'],
                cwd: cwdReal, timeoutMs: qualificationTimeoutMs, processId: version.pid, status: version.status, stdoutSha256: hashBytes(Buffer.from(version.stdout ?? '')), stderrSha256: hashBytes(Buffer.from(version.stderr ?? '')) } };
              break;
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          if (!cargo) fail('verification_cargo_runtime_missing');
          if (process.version !== 'v22.23.1') fail('verification_capture_node_unqualified');
          runtime = { cargo, node: { ...artifactPin(fs.realpathSync(process.execPath), rootReal), version: process.version } };
          producer = producerPin(rootReal);
        }
        const key = JSON.stringify([cwdReal, binding.discoveryPrefix]);
        if (!inventories.has(key)) {
          if (JSON.stringify(producerPin(rootReal)) !== JSON.stringify(producer)) fail('verification_capture_producer_changed', label);
          const script = path.join(rootReal, 'paper-core/bin/verify-source-implementation-evidence.mjs');
          const runner = [runtime.node.path, script, '--capture-cargo-owner-environment'];
          const config = `target.${JSON.stringify(runtime.cargo.host)}.runner=${JSON.stringify(runner)}`;
          const discoveryArgs = [...binding.discoveryPrefix, '--message-format=json', '--config', config, '--', '--list'];
          for (const pin of [runtime.cargo, runtime.node]) {
            if (JSON.stringify(artifactPin(pin.path, rootReal)) !== JSON.stringify({ path: pin.path, sha256: pin.sha256, identity: pin.identity })) fail('verification_runtime_changed');
          }
          const discoveryTimeoutMs = remaining();
          const captured = run(runtime.cargo.path, discoveryArgs, { cwd: cwdReal, env, timeout: discoveryTimeoutMs });
          if (captured.status !== 0) fail('verification_discovery_failed', label);
          const actual = cargoTargetObservation(rootReal, binding, captured.stdout ?? '', label);
          const capture = cargoEnvironmentObservation(rootReal, binding, actual.artifact, captured.stdout ?? '', captured.pid, runtime, label, env, actual.binaryArtifacts, actual.buildScripts);
          assertCargoBinaryArtifactsCurrent(rootReal, actual.binaryArtifacts);
          assertCargoBuildScriptsCurrent(rootReal, actual.buildScripts);
          for (const binary of actual.binaryArtifacts) binaryImages.set(binary.path, binary);
          for (const script of actual.buildScripts) buildImages.set(`${script.path}:${script.outDirectory.path}`, script);
          if (JSON.stringify(producerPin(rootReal)) !== JSON.stringify(producer)) fail('verification_capture_producer_changed', label);
          for (const pin of [runtime.cargo, runtime.node]) {
            if (JSON.stringify(artifactPin(pin.path, rootReal)) !== JSON.stringify({ path: pin.path, sha256: pin.sha256, identity: pin.identity })) fail('verification_runtime_changed');
          }
          const listTimeoutMs = remaining();
          const listed = run(actual.artifact.path, ['--list'], { cwd: capture.cwd, env: capture.environment, timeout: listTimeoutMs });
          if (listed.status !== 0) fail('verification_discovery_failed', label);
          const tests = exactCargoTestInventory(listed.stdout ?? '', label);
          const targetId = `cargo-target-${targets.length}`;
          const target = { kind: 'SourceOwnerCargoTargetReuseV1', version: 1, targetId, source,
            binding: { discoveryPrefix: binding.discoveryPrefix, packageName: binding.packageName, targetKind: binding.targetKind, ...(binding.testTarget ? { testTarget: binding.testTarget } : {}) },
            artifact: actual.artifact, binaryArtifacts: actual.binaryArtifacts, buildScripts: actual.buildScripts, runtime, producer,
            discovery: { program: runtime.cargo.path, args: discoveryArgs, cwd: cwdReal, processId: captured.pid, status: captured.status,
              timeoutMs: discoveryTimeoutMs, stdoutSha256: hashBytes(Buffer.from(captured.stdout ?? '')), stderrSha256: hashBytes(Buffer.from(captured.stderr ?? '')) },
            capture: { script, args: ['--capture-cargo-owner-environment', actual.artifact.path, '--list'],
              processId: capture.processId, parentProcessId: capture.parentProcessId, cwd: capture.cwd, environmentSha256: capture.environmentSha256, environmentKeys: Object.keys(capture.environment).sort() },
            inventory: { program: actual.artifact.path, args: ['--list'], cwd: capture.cwd, processId: listed.pid, status: listed.status, timeoutMs: listTimeoutMs,
              stdoutSha256: hashBytes(Buffer.from(listed.stdout ?? '')), stderrSha256: hashBytes(Buffer.from(listed.stderr ?? '')), tests },
            firstLogicalOwner: { bundleId, index }, elapsedMs: Number((process.hrtime.bigint() - started) / 1000000n) };
          targets.push(target);
          inventories.set(key, { target, environment: capture.environment });
        }
        inventory = inventories.get(key);
        if (!inventory.target.inventory.tests.includes(binding.selector)) fail('verification_discovery_selector_missing', label);
        const artifact = inventory.target.artifact;
        assertCargoBinaryArtifactsCurrent(rootReal, inventory.target.binaryArtifacts);
        assertCargoBuildScriptsCurrent(rootReal, inventory.target.buildScripts);
        if (JSON.stringify(artifactPin(artifact.path, rootReal)) !== JSON.stringify({ path: artifact.path, sha256: artifact.sha256, identity: artifact.identity })) {
          fail('verification_artifact_changed', label);
        }
        executable = artifact.path;
        args = [binding.selector, '--exact', ...(command.args.includes('--ignored') ? ['--ignored'] : []), '--nocapture'];
        executionCwd = inventory.target.capture.cwd;
        executionEnv = inventory.environment;
      }
      const timeoutMs = remaining();
      const result = run(executable, args, { cwd: executionCwd, env: executionEnv, timeout: timeoutMs });
      if (result.status !== command.expectedExitCode) {
        fail('verification_command_failed', JSON.stringify({ args: command.args, bundleId, index,
          expectedExitCode: command.expectedExitCode, program: command.program, signal: result.signal ?? null, status: result.status,
          stderr: commandDiagnostic(result.stderr), stdout: commandDiagnostic(result.stdout),
          timedOut: result.signal === 'SIGTERM' && result.status === null, workdir: command.workdir }));
      }
      let actualOwner;
      if (binding) {
        actualOwner = assertExactCargoOwnerExecution(binding.selector, result.stdout ?? '', label);
        const artifact = inventory.target.artifact;
        assertCargoBinaryArtifactsCurrent(rootReal, inventory.target.binaryArtifacts);
        assertCargoBuildScriptsCurrent(rootReal, inventory.target.buildScripts);
        if (JSON.stringify(artifactPin(artifact.path, rootReal)) !== JSON.stringify({ path: artifact.path, sha256: artifact.sha256, identity: artifact.identity })) {
          fail('verification_artifact_changed', label);
        }
      } else assertTestExecution(command, bundle, result.stdout ?? '', label);
      remaining();
      observations.push({ args: command.args, bundleId, expectedExitCode: command.expectedExitCode, index,
        program: command.program, status: result.status, timedOut: false, workdir: command.workdir,
        stdoutSha256: hashBytes(Buffer.from(result.stdout ?? '')), stderrSha256: hashBytes(Buffer.from(result.stderr ?? '')),
        ...(binding ? { executionTargetId: inventory.target.targetId, actualTestSelector: binding.selector,
          actualTestRows: actualOwner.rows, actualTestCounts: actualOwner.counts,
          physicalInvocation: { program: executable, args, cwd: executionCwd, environmentSha256: inventory.target.capture.environmentSha256,
            processId: result.pid, timeoutMs, status: result.status },
          sourcePins: bundle.files.filter((file) => command.expectedTargets.includes(file.path)).map((file) => ({ path: file.path, mode: file.mode, gitBlob: file.gitBlob })) } : {}),
        elapsedMs: Number((process.hrtime.bigint() - started) / 1000000n) });
    }
  }
  if (runtime) {
    assertCargoBinaryArtifactsCurrent(rootReal, [...binaryImages.values()], true);
    assertCargoBuildScriptsCurrent(rootReal, [...buildImages.values()], true);
    for (const pin of [runtime.cargo, runtime.node]) {
      if (JSON.stringify(artifactPin(pin.path, rootReal)) !== JSON.stringify({ path: pin.path, sha256: pin.sha256, identity: pin.identity })) fail('verification_runtime_changed');
    }
    if (JSON.stringify(producerPin(rootReal)) !== JSON.stringify(producer)) fail('verification_capture_producer_changed');
    const lastBudgetRemaining = finalRemaining();
    observations.at(-1).elapsedMs = bundles.get(observations.at(-1).bundleId).commands[observations.at(-1).index].timeoutSeconds * 1000 - lastBudgetRemaining;
  }
  return { observations, targets };
}

function captureCargoOwnerEnvironment(argv) {
  if (argv.length !== 2 || !path.isAbsolute(argv[0]) || argv[1] !== '--list') fail('verification_capture_arguments_invalid');
  const executable = fs.realpathSync(argv[0]);
  if (executable !== argv[0]) fail('verification_capture_arguments_invalid');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const cwd = fs.realpathSync(process.cwd());
  const cargo = process.env.CARGO;
  if (typeof cargo !== 'string' || !path.isAbsolute(cargo) || fs.realpathSync(cargo) !== cargo
      || fs.realpathSync(`/proc/${process.ppid}/exe`) !== cargo
      || !SAFE_PACKAGE_PATTERN.test(process.env.CARGO_PKG_NAME ?? '')
      || cwd !== path.join(root, 'rust/crates', process.env.CARGO_PKG_NAME)
      || process.env.CARGO_MANIFEST_DIR !== cwd || process.env.CARGO_MANIFEST_PATH !== path.join(cwd, 'Cargo.toml')) {
    fail('verification_capture_parent_invalid');
  }
  artifactPin(executable, root);
  const environment = Object.fromEntries(Object.entries(process.env));
  if (Object.keys(environment).length > 128 || Buffer.byteLength(JSON.stringify(environment)) > 1024 * 1024) {
    fail('verification_capture_environment_limit');
  }
  process.stdout.write(`${JSON.stringify({ kind: 'CargoOwnerEnvironmentCaptureV1', version: 1,
    processId: process.pid, parentProcessId: process.ppid, script: fs.realpathSync(fileURLToPath(import.meta.url)),
    node: fs.realpathSync(process.execPath), cwd: process.cwd(), executable, args: ['--list'], environment })}\n`);
}

function parseArguments(argv) {
  const result = {
    evidence: 'docs/system/evidence/repository-source-implementation-v1.json',
    execute: false,
    expectedHead: null,
    expectedTree: null,
    receipt: null,
    root: '.',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--execute') {
      result.execute = true;
    } else if (['--evidence', '--expected-head', '--expected-tree', '--receipt', '--root'].includes(value)) {
      const next = argv[index + 1];
      if (!next) fail('cli_value_required', value);
      index += 1;
      if (value === '--evidence') result.evidence = next;
      if (value === '--expected-head') result.expectedHead = next;
      if (value === '--expected-tree') result.expectedTree = next;
      if (value === '--receipt') result.receipt = next;
      if (value === '--root') result.root = next;
    } else {
      fail('cli_argument_unknown', value);
    }
  }
  return result;
}

export function verifyRepositorySourceEvidence(options = {}) {
  const root = fs.realpathSync(options.root ?? '.');
  const evidenceRelative = canonicalRelative(
    options.evidence ?? 'docs/system/evidence/repository-source-implementation-v1.json',
    'evidencePath',
  );
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (status !== '') fail('tracked_worktree_not_clean', status);
  const head = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  if (!SHA1_PATTERN.test(head) || !SHA1_PATTERN.test(tree)) fail('git_subject_invalid');
  if (options.expectedHead && options.expectedHead !== head) fail('expected_head_mismatch');
  if (options.expectedTree && options.expectedTree !== tree) fail('expected_tree_mismatch');
  const evidenceBlob = trackedBlob(root, evidenceRelative);
  const inputs = new Map([[evidenceRelative, evidenceBlob]]);
  const evidenceBytes = readPinnedSource(root, evidenceRelative, evidenceBlob);
  const document = parseStrictJson(evidenceBytes.toString('utf8'), evidenceRelative);
  const registries = Object.fromEntries(
    Object.entries(document.registries).map(([key, value]) => {
      const relative = canonicalRelative(value, `registry.${key}`);
      const pin = trackedBlob(root, relative);
      inputs.set(relative, pin);
      return [key, parseStrictJson(readPinnedSource(root, relative, pin).toString('utf8'), relative)];
    }),
  );
  const validation = validateEvidenceDocument(document, {
    root,
    workItems: registries.workItems,
    modules: registries.modules,
    capabilities: registries.capabilities,
  });
  for (const bundle of validation.bundles.values()) {
    for (const file of bundle.files) {
      inputs.set(file.path, { mode: file.mode, blob: file.gitBlob });
    }
  }
  // Complete semantic validation can itself span source changes. Admit all
  // commands only against the captured subject and with the same bound inputs.
  if (options.execute) assertSourceSubject(root, { head, tree }, inputs);
  const execution = options.execute
    ? executeCommands(root, validation.bundles, { head, tree })
    : { observations: [], targets: [] };
  // No successful receipt is constructed or published after observed drift.
  // Do not re-run tests or mint an updated subject from concurrent bytes.
  assertSourceSubject(root, { head, tree }, inputs);
  const receipt = {
    authorityClaims: Object.fromEntries(AUTHORITY_KEYS.map((key) => [key, false])),
    commandObservations: execution.observations,
    executionTargets: execution.targets,
    evidence: {
      gitBlob: evidenceBlob.blob,
      mode: evidenceBlob.mode,
      path: evidenceRelative,
      sha256: hashBytes(evidenceBytes),
    },
    kind: 'RepositorySourceImplementationEvidenceReceiptV1',
    promotions: validation.promotions,
    repository: document.repository,
    source: { head, tree },
    status: 'repository_source_evidence_verified',
    verificationCommandsExecuted: options.execute,
    version: 1,
  };
  if (options.receipt) {
    const receiptPath = path.resolve(options.receipt);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o444,
    });
  }
  return receipt;
}

function main() {
  if (process.argv[2] === '--capture-cargo-owner-environment') {
    captureCargoOwnerEnvironment(process.argv.slice(3));
    return;
  }
  const args = parseArguments(process.argv.slice(2));
  const receipt = verifyRepositorySourceEvidence(args);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
