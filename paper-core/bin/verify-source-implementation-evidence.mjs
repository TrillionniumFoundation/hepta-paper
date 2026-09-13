#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const MODULE_PATTERN = /^module\.[a-z0-9-]+$/;
const CAPABILITY_PATTERN = /^CAP-[A-Z0-9-]+$/;
const WORK_ITEM_PATTERN = /^[A-Z][A-Z0-9-]*$/;
const BUNDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SYMBOL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
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

function fail(code, detail = '') {
  const suffix = detail ? `: ${detail}` : '';
  throw new Error(`${code}${suffix}`);
}

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

function readStrictJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
    fail('json_file_invalid', file);
  }
  return parseStrictJson(fs.readFileSync(file, 'utf8'), file);
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

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: options.timeout,
  });
  if (result.error) fail('process_spawn_failed', `${program}: ${result.error.message}`);
  return result;
}

function git(root, args) {
  const result = run('git', ['-C', root, ...args]);
  if (result.status !== 0) fail('git_command_failed', `${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function hashBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function trackedBlob(root, relative) {
  const output = git(root, ['ls-files', '-s', '--', relative]);
  const match = /^(\d{6}) ([0-9a-f]{40}) 0\t(.+)$/u.exec(output);
  if (!match || match[3] !== relative) fail('tracked_blob_required', relative);
  return { mode: match[1], blob: match[2] };
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function verifySymbol(text, language, symbol, relative) {
  const name = escaped(symbol.name);
  let expression;
  if (language === 'rust') {
    if (symbol.kind === 'function') {
      expression = new RegExp(`(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\s*\\(`, 'u');
    } else if (symbol.kind === 'test') {
      expression = new RegExp(`#\\s*\\[\\s*test\\s*\\][\\s\\S]{0,320}?fn\\s+${name}\\s*\\(`, 'u');
    } else if (symbol.kind === 'type') {
      expression = new RegExp(`(?:struct|enum|trait|type)\\s+${name}\\b`, 'u');
    } else {
      expression = new RegExp(`(?:const|static)\\s+${name}\\b`, 'u');
    }
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
  const rootReal = fs.realpathSync(root);
  const parentReal = fs.realpathSync(path.dirname(absolute));
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
    fail('path_escape', relative);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('regular_file_required', relative);
  const real = fs.realpathSync(absolute);
  if (!real.startsWith(`${rootReal}${path.sep}`)) fail('path_escape', relative);
  const tracked = trackedBlob(root, relative);
  if (tracked.mode !== entry.mode || tracked.blob !== entry.gitBlob) {
    fail('git_blob_mismatch', `${relative}=${tracked.mode}:${tracked.blob}`);
  }
  const text = fs.readFileSync(absolute, 'utf8');
  const seenSymbols = new Set();
  for (const [index, symbol] of entry.symbols.entries()) {
    exactKeys(symbol, SYMBOL_KEYS, `${relative}.symbols[${index}]`);
    if (!['constant', 'function', 'test', 'type'].includes(symbol.kind)) {
      fail('symbol_kind_invalid', `${relative}:${symbol.kind}`);
    }
    requireString(symbol.name, `${relative}.symbols[${index}].name`, SYMBOL_PATTERN);
    const identity = `${symbol.kind}:${symbol.name}`;
    if (seenSymbols.has(identity)) fail('duplicate_symbol', `${relative}:${identity}`);
    seenSymbols.add(identity);
    verifySymbol(text, entry.language, symbol, relative);
  }
  return { ...entry, relative, absolute };
}

function validateCommand(command, label, testPaths) {
  exactKeys(command, COMMAND_KEYS, label);
  requireString(command.program, `${label}.program`);
  if (!Array.isArray(command.args) || command.args.length < 2) fail('command_args_invalid', label);
  for (const [index, argument] of command.args.entries()) {
    requireString(argument, `${label}.args[${index}]`);
    if (argument.includes('\0') || /[\r\n]/u.test(argument)) fail('command_arg_invalid', label);
  }
  const workdir = canonicalRelative(command.workdir, `${label}.workdir`, { allowDot: true });
  if (command.expectedExitCode !== 0) fail('command_exit_policy_invalid', label);
  requireInteger(command.timeoutSeconds, `${label}.timeoutSeconds`, 1, 600);
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
    const args = command.args;
    const allowed = args.length === 8
      && args[0] === 'test'
      && args[1] === '--locked'
      && args[2] === '-p'
      && SAFE_PACKAGE_PATTERN.test(args[3])
      && SAFE_RUST_TEST_PATTERN.test(args[4])
      && args[5] === '--'
      && args[6] === '--exact'
      && args[7] === '--nocapture'
      && workdir === 'rust';
    if (!allowed) fail('cargo_command_not_allowlisted', label);
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
    const testPaths = new Set(files.filter((entry) => entry.role === 'test').map((entry) => entry.path));
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
  return env;
}

function executeCommands(root, bundles) {
  const observations = [];
  const env = safeExecutionEnvironment();
  for (const [bundleId, bundle] of bundles.entries()) {
    for (const [index, command] of bundle.commands.entries()) {
      const cwd = command.workdir === '.' ? root : path.resolve(root, command.workdir);
      const cwdReal = fs.realpathSync(cwd);
      const rootReal = fs.realpathSync(root);
      if (cwdReal !== rootReal && !cwdReal.startsWith(`${rootReal}${path.sep}`)) {
        fail('command_workdir_escape', `${bundleId}:${index}`);
      }
      const result = run(command.program, command.args, {
        cwd: cwdReal,
        env,
        timeout: command.timeoutSeconds * 1000,
      });
      const observation = {
        args: command.args,
        bundleId,
        expectedExitCode: command.expectedExitCode,
        index,
        program: command.program,
        status: result.status,
        stderrSha256: hashBytes(Buffer.from(result.stderr ?? '', 'utf8')),
        stdoutSha256: hashBytes(Buffer.from(result.stdout ?? '', 'utf8')),
        timedOut: result.signal === 'SIGTERM' && result.status === null,
        workdir: command.workdir,
      };
      observations.push(observation);
      if (result.status !== command.expectedExitCode) {
        fail('verification_command_failed', `${bundleId}:${index}:status=${String(result.status)}`);
      }
    }
  }
  return observations;
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
  const evidencePath = path.resolve(root, evidenceRelative);
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (status !== '') fail('tracked_worktree_not_clean', status);
  const head = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  if (!SHA1_PATTERN.test(head) || !SHA1_PATTERN.test(tree)) fail('git_subject_invalid');
  if (options.expectedHead && options.expectedHead !== head) fail('expected_head_mismatch');
  if (options.expectedTree && options.expectedTree !== tree) fail('expected_tree_mismatch');
  const evidenceBlob = trackedBlob(root, evidenceRelative);
  const document = readStrictJson(evidencePath);
  const registries = Object.fromEntries(
    Object.entries(document.registries).map(([key, relative]) => [
      key,
      readStrictJson(path.resolve(root, canonicalRelative(relative, `registry.${key}`))),
    ]),
  );
  const validation = validateEvidenceDocument(document, {
    root,
    workItems: registries.workItems,
    modules: registries.modules,
    capabilities: registries.capabilities,
  });
  const commandObservations = options.execute
    ? executeCommands(root, validation.bundles)
    : [];
  const receipt = {
    authorityClaims: Object.fromEntries(AUTHORITY_KEYS.map((key) => [key, false])),
    commandObservations,
    evidence: {
      gitBlob: evidenceBlob.blob,
      mode: evidenceBlob.mode,
      path: evidenceRelative,
      sha256: hashBytes(fs.readFileSync(evidencePath)),
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
