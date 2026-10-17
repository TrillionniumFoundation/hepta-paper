#!/usr/bin/env node
// Static source bindings, not test execution or independently accepted parity.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = 'docs/migration/native-function-ports.v1.json';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function requireShape(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error('closed record shape rejected');
  }
}

function unchanged(left, right) {
  return ['dev', 'ino', 'uid', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs']
    .every((key) => left[key] === right[key]);
}

// Capture bounded, canonical regular-file bytes; do not follow source aliases.
// This is a repository validator, not a production filesystem authority boundary.
function readSource(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)
      || relative.includes('\\') || relative.includes('\0')
      || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('noncanonical path');
  }
  const absolute = path.resolve(root, relative);
  if (fs.realpathSync(absolute) !== absolute) throw new Error('symbolic path');
  const before = fs.lstatSync(absolute);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) {
    throw new Error('source shape/size');
  }
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!unchanged(before, fs.fstatSync(descriptor))) throw new Error('source replaced');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const received = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!received) break;
      length += received;
    }
    if (length !== before.size
        || !unchanged(before, fs.fstatSync(descriptor))
        || !unchanged(before, fs.lstatSync(absolute))) {
      throw new Error('source changed');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    fs.closeSync(descriptor);
  }
}

export function validateNativeFunctionPorts(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const sourceBindings = {};
  const capture = (relative) => {
    const source = readSource(root, relative);
    sourceBindings[relative] = hash(source);
    return source;
  };
  const index = options.index || JSON.parse(capture(INDEX));
  requireShape(index, [
    'schemaVersion', 'kind', 'scope', 'productionActivation', 'nodeRetirement', 'groups',
  ]);
  if (index.schemaVersion !== 1 || index.kind !== 'NativeFunctionPortIndexV1'
      || index.scope !== 'source_bindings_not_full_command_acceptance'
      || index.productionActivation !== false || index.nodeRetirement !== false
      || !Array.isArray(index.groups) || !index.groups.length || index.groups.length > 128) {
    throw new Error('index scope rejected');
  }

  const seen = new Set();
  let functionCount = 0;
  let constantCount = 0;
  for (const row of index.groups) {
    requireShape(row, [
      'id', 'nodePath', 'nodeSourceSha256', 'nodeFunctions', 'nodeConstants',
      'rustPath', 'rustSymbols', 'rustConstants',
      'testPath', 'oraclePath', 'examplePath', 'scope',
    ]);
    if (typeof row.id !== 'string' || !row.id || seen.has(row.id)
        || row.scope !== 'bounded_normalized_input_function_port') {
      throw new Error('group identity or scope rejected');
    }
    seen.add(row.id);
    const node = capture(row.nodePath);
    const rust = capture(row.rustPath);
    const test = capture(row.testPath);
    const oracle = capture(row.oraclePath);
    JSON.parse(capture(row.examplePath));
    if (hash(node) !== row.nodeSourceSha256) {
      throw new Error('incumbent source changed; requalify port');
    }

    // Only ordinary function and constant declarations occur in the current
    // incumbent sources. Other export forms require explicit inventory support.
    const exportLines = node.match(/^[ \t]*export\b.*$/gm) || [];
    if (exportLines.some((line) => !/^export (?:function \w+\(|const \w+\s*=)/.test(line))) {
      throw new Error('unsupported Node export form; requalify inventory');
    }
    const functions = [...node.matchAll(/^export function (\w+)/gm)]
      .map((match) => match[1]).sort();
    const constants = [...node.matchAll(/^export const (\w+)/gm)]
      .map((match) => match[1]).sort();
    for (const [actual, declared] of [[functions, row.nodeFunctions], [constants, row.nodeConstants]]) {
      if (!Array.isArray(declared)
          || JSON.stringify(actual) !== JSON.stringify([...declared].sort())) {
        throw new Error('Node export denominator changed');
      }
    }
    if (!Array.isArray(row.rustConstants)
        || row.rustConstants.length !== constants.length
        || new Set(row.rustConstants).size !== row.rustConstants.length) {
      throw new Error('invalid Rust constant set');
    }
    for (const symbol of row.rustConstants) {
      if (typeof symbol !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)
          || !new RegExp(`\\bpub\\s+const\\s+${symbol}\\s*:`).test(rust)) {
        throw new Error('Rust implementation constant absent');
      }
    }
    if (!Array.isArray(row.rustSymbols) || !row.rustSymbols.length
        || new Set(row.rustSymbols).size !== row.rustSymbols.length) {
      throw new Error('invalid Rust symbol set');
    }
    for (const symbol of row.rustSymbols) {
      if (typeof symbol !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)
          || !new RegExp(`\\bfn\\s+${symbol}\\s*\\(`).test(rust)) {
        throw new Error('Rust implementation symbol absent');
      }
    }
    if (!oracle.includes(row.nodePath) || !oracle.includes('productionOracleProfile')
        || !test.includes(row.nodePath) || !test.includes(row.oraclePath)) {
      throw new Error('source-bound oracle/test link absent');
    }
    if (!test.includes(row.examplePath)) {
      throw new Error('executable documentation example absent');
    }
    functionCount += functions.length;
    constantCount += constants.length;
  }
  return {
    kind: 'NativeFunctionPortBindingReportV1',
    scope: index.scope,
    sourceGroups: seen.size,
    incumbentFunctions: functionCount,
    incumbentConstants: constantCount,
    incumbentExports: functionCount + constantCount,
    sourceBindings,
    testsExecutedByThisValidator: false,
    fullCommandParityAccepted: false,
    independentReviewVerified: false,
    productionActivation: false,
    nodeRetirement: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('no arguments accepted');
    console.log(JSON.stringify(validateNativeFunctionPorts(), null, 2));
  } catch (error) {
    console.error(`native-function-port binding rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
