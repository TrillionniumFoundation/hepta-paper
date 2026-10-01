#!/usr/bin/env node

import { stripRustInertText, rustSymbolMatches } from '../src/source-evidence-rust-symbols.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  fail, run, git, trackedBlob, readPinnedSource, assertSourceSubject,
} from '../src/source-evidence-git-inputs.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
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
const SAFE_RUST_TEST_PATTERN = /^[A-Za-z0-9_:]+$/;
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

class StrictJsonParser {
  constructor(text, label) {
    this.text = text;
    this.label = label;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.error('trailing_bytes');
    return value;
  }

  error(code) {
    fail('strict_json_invalid', `${this.label}:${code}@${this.index}`);
  }

  skipWhitespace() {
    while (this.index < this.text.length && /[\u0009\u000a\u000d\u0020]/u.test(this.text[this.index])) {
      this.index += 1;
    }
  }

  parseValue() {
    this.skipWhitespace();
    const token = this.text[this.index];
    if (token === '{') return this.parseObject();
    if (token === '[') return this.parseArray();
    if (token === '"') return this.parseString();
    if (token === '-' || /[0-9]/u.test(token ?? '')) return this.parseNumber();
    if (this.text.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }
    this.error('unexpected_token');
  }

  parseObject() {
    const result = Object.create(null);
    const keys = new Set();
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') this.error('object_key_required');
      const key = this.parseString();
      if (keys.has(key)) this.error(`duplicate_key:${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') this.error('colon_required');
      this.index += 1;
      result[key] = this.parseValue();
      this.skipWhitespace();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ',') this.error('object_comma_required');
      this.index += 1;
      this.skipWhitespace();
    }
    this.error('unterminated_object');
  }

  parseArray() {
    const result = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ',') this.error('array_comma_required');
      this.index += 1;
      this.skipWhitespace();
    }
    this.error('unterminated_array');
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    let escapedValue = false;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (!escapedValue && code === 0x22) {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index));
        } catch {
          this.error('string_decode');
        }
      }
      if (!escapedValue && code < 0x20) this.error('control_character');
      if (!escapedValue && code === 0x5c) {
        escapedValue = true;
        this.index += 1;
        continue;
      }
      escapedValue = false;
      this.index += 1;
    }
    this.error('unterminated_string');
  }

  parseNumber() {
    const fragment = this.text.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(fragment);
    if (!match) this.error('number_syntax');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.error('non_finite_number');
    return value;
  }
}

export function parseStrictJson(text, label = 'JSON') {
  if (typeof text !== 'string') fail('json_text_required', label);
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) fail('json_byte_limit', label);
  return new StrictJsonParser(text, label).parse();
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

function hashBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
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

export function assertExactCargoOwnerExecution(selector, stdout, label) {
  if (typeof selector !== 'string' || !SAFE_RUST_TEST_PATTERN.test(selector)) fail('verification_selector_invalid', label);
  const text = stdout.replace(/\x1b\[[0-9;]*m/gu, '');
  const rows = text.split(/\r?\n/u).filter((line) => line.startsWith('test ') && !line.startsWith('test result:'));
  const summaryLines = text.split(/\r?\n/u).filter((line) => line.startsWith('test result:'));
  const summaries = [...text.matchAll(
    /^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;[^\r\n]*$/gmu,
  )];
  const counts = summaries.map((row) => row.slice(1, 6).map(Number));
  const expected = `test ${selector} ... ok`;
  if (rows.length !== 1 || rows[0] !== expected || summaryLines.length !== 1 || counts.length !== 1
      || counts[0].some((value) => !Number.isSafeInteger(value))
      || counts[0][0] !== 1 || counts[0].slice(1, 4).some((value) => value !== 0)) {
    fail('verification_test_execution_incomplete', `${label}:exact_owner`);
  }
  return { rows, counts: Object.fromEntries(['passed', 'failed', 'ignored', 'measured', 'filteredOut'].map((key, index) => [key, counts[0][index]])) };
}

function artifactPin(executable, root) {
  if (!path.isAbsolute(executable) || fs.realpathSync(executable) !== executable
      || executable === root || executable.startsWith(`${root}${path.sep}`)) {
    fail('verification_artifact_path_invalid', executable);
  }
  const descriptor = fs.openSync(executable, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const identity = (value) => [value.dev, value.ino, value.mode, value.uid, value.gid,
    value.nlink, value.size, value.mtimeNs, value.ctimeNs].map(String);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size < 4n || before.size > 1024n * 1024n * 1024n
        || (before.mode & 0o111n) === 0n) fail('verification_artifact_file_invalid', executable);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      if (offset === 0 && !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        fail('verification_artifact_not_elf', executable);
      }
      offset += count;
      if (offset > Number(before.size)) fail('verification_artifact_changed', executable);
      hash.update(buffer.subarray(0, count));
    }
    const named = fs.lstatSync(executable, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink()) fail('verification_artifact_path_invalid', executable);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== Number(before.size) || JSON.stringify(identity(before)) !== JSON.stringify(identity(after))
        || identity(before).some((value, index) => value !== identity(named)[index])) {
      fail('verification_artifact_changed', executable);
    }
    return { path: executable, sha256: `sha256:${hash.digest('hex')}`, identity: identity(before) };
  } finally { fs.closeSync(descriptor); }
}

export function cargoTargetObservation(root, binding, stdout, label) {
  const artifacts = [];
  const tests = new Set();
  for (const line of stdout.replace(/\x1b\[[0-9;]*m/gu, '').split(/\r?\n/u)) {
    if (line.startsWith('{')) {
      let row;
      try { row = JSON.parse(line); } catch { fail('verification_artifact_json_invalid', label); }
      if (row.reason !== 'compiler-artifact' || row.profile?.test !== true || !row.executable) continue;
      const expectedManifest = path.join(root, 'rust/crates', binding.packageName, 'Cargo.toml');
      const expectedKind = binding.targetKind === 'library' ? 'lib' : 'test';
      if (row.manifest_path === expectedManifest && row.target?.kind?.length === 1
          && row.target.kind[0] === expectedKind
          && (binding.targetKind === 'library' || row.target?.name === binding.testTarget)) {
        const packageRoot = path.dirname(expectedManifest);
        const expectedSources = binding.targetKind === 'library'
          ? [path.join(packageRoot, 'src/lib.rs')]
          : [path.join(packageRoot, 'tests', `${binding.testTarget}.rs`),
            path.join(packageRoot, 'tests', binding.testTarget, 'main.rs')];
        if (!expectedSources.includes(row.target.src_path)) fail('verification_artifact_source_invalid', label);
        artifacts.push({ executable: row.executable, manifestPath: row.manifest_path,
          targetName: row.target.name, targetKind: row.target.kind, sourcePath: row.target.src_path });
      }
    } else if (line.endsWith(': test')) {
      const selector = line.slice(0, -': test'.length);
      if (!SAFE_RUST_TEST_PATTERN.test(selector) || tests.has(selector)) fail('verification_discovery_invalid', label);
      tests.add(selector);
    }
  }
  if (artifacts.length !== 1) fail('verification_artifact_cardinality', `${label}:${artifacts.length}`);
  return { artifact: { ...artifacts[0], ...artifactPin(artifacts[0].executable, root) }, tests: [...tests] };
}

function producerPin(root) {
  const paths = ['paper-core/bin/verify-source-implementation-evidence.mjs',
    'paper-core/src/source-evidence-git-inputs.mjs', 'paper-core/src/source-evidence-rust-symbols.mjs'];
  return paths.map((relative) => {
    const bound = trackedBlob(root, relative);
    const bytes = readPinnedSource(root, relative, bound);
    const loaded = relative === paths[0] ? fileURLToPath(import.meta.url)
      : fileURLToPath(new URL(`../src/${path.basename(relative)}`, import.meta.url));
    if (!bytes.equals(fs.readFileSync(loaded))) fail('verification_capture_producer_mismatch', relative);
    return { path: relative, mode: bound.mode, gitBlob: bound.blob, sha256: hashBytes(bytes) };
  });
}

export function cargoEnvironmentObservation(root, binding, artifact, stdout, cargoPid, runtime, label, expectedEnvironment) {
  const captures = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith('{')) continue;
    const row = parseStrictJson(line, label);
    if (row.kind === 'CargoOwnerEnvironmentCaptureV1') captures.push(row);
  }
  if (captures.length !== 1) fail('verification_capture_cardinality', label);
  const row = captures[0];
  const fields = ['kind', 'version', 'processId', 'parentProcessId', 'script', 'node', 'cwd', 'executable', 'args', 'environment'];
  const actualFields = Object.keys(row).sort();
  const env = row.environment;
  const cwd = path.dirname(path.join(root, 'rust/crates', binding.packageName, 'Cargo.toml'));
  const cargoEnvironmentKeys = new Set(['CARGO', 'CARGO_MANIFEST_DIR', 'CARGO_MANIFEST_PATH',
    'CARGO_PKG_AUTHORS', 'CARGO_PKG_DESCRIPTION', 'CARGO_PKG_HOMEPAGE', 'CARGO_PKG_LICENSE',
    'CARGO_PKG_LICENSE_FILE', 'CARGO_PKG_NAME', 'CARGO_PKG_README', 'CARGO_PKG_REPOSITORY',
    'CARGO_PKG_RUST_VERSION', 'CARGO_PKG_VERSION', 'CARGO_PKG_VERSION_MAJOR', 'CARGO_PKG_VERSION_MINOR',
    'CARGO_PKG_VERSION_PATCH', 'CARGO_PKG_VERSION_PRE', 'LD_LIBRARY_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
  if (JSON.stringify(actualFields) !== JSON.stringify(fields.sort()) || row.version !== 1
      || !Number.isSafeInteger(row.processId) || row.processId < 1 || row.parentProcessId !== cargoPid
      || row.script !== path.join(root, 'paper-core/bin/verify-source-implementation-evidence.mjs')
      || row.node !== runtime.node.path || row.cwd !== cwd || row.executable !== artifact.path
      || JSON.stringify(row.args) !== '["--list"]'
      || !env || Array.isArray(env) || typeof env !== 'object' || Object.keys(env).length > 128
      || Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== 'string' || value.includes('\0'))
      || !expectedEnvironment
      || Object.entries(expectedEnvironment).some(([key, value]) => !cargoEnvironmentKeys.has(key) && env[key] !== value)
      || Object.keys(env).some((key) => !Object.hasOwn(expectedEnvironment, key) && !cargoEnvironmentKeys.has(key))
      || Buffer.byteLength(JSON.stringify(env)) > 1024 * 1024
      || env.CARGO !== runtime.cargo.path || env.CARGO_MANIFEST_DIR !== cwd || env.CARGO_PKG_NAME !== binding.packageName
      || (env.CARGO_MANIFEST_PATH !== undefined && env.CARGO_MANIFEST_PATH !== path.join(cwd, 'Cargo.toml'))) {
    fail('verification_capture_binding_invalid', label);
  }
  return { cwd, environment: env, processId: row.processId, parentProcessId: row.parentProcessId,
    environmentSha256: hashBytes(Buffer.from(JSON.stringify(env))) };
}

export function exactCargoTestInventory(stdout, label) {
  const tests = [];
  const text = stdout.replace(/\x1b\[[0-9;]*m/gu, '');
  for (const line of text.split(/\r?\n/u)) {
    if (!line.endsWith(': test')) continue;
    const name = line.slice(0, -': test'.length);
    if (!SAFE_RUST_TEST_PATTERN.test(name) || tests.includes(name)) fail('verification_discovery_invalid', label);
    tests.push(name);
  }
  const summary = [...text.matchAll(/^(\d+) tests?, (\d+) benchmarks?$/gmu)];
  if (summary.length !== 1 || Number(summary[0][1]) !== tests.length || Number(summary[0][2]) !== 0) {
    fail('verification_discovery_invalid', label);
  }
  return tests;
}

export function executeCommands(root, bundles, source) {
  const observations = [];
  const targets = [];
  const inventories = new Map();
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
          const capture = cargoEnvironmentObservation(rootReal, binding, actual.artifact, captured.stdout ?? '', captured.pid, runtime, label, env);
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
            artifact: actual.artifact, runtime, producer,
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
