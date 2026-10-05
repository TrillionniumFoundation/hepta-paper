import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const READONLY_PARSER_PACKAGES = Object.freeze([
  'espree', 'eslint-scope', 'acorn', 'acorn-jsx', 'eslint-visitor-keys', 'esrecurse', 'estraverse',
]);

// Resolve actual package entries but accept only the two existing locked layouts.
// No arbitrary ancestor, global package directory or PATH grants fixture trust.
export function resolveReadonlyParserDependencies({ source, pin }) {
  assert.equal(fs.realpathSync(source), source, 'canonical source required');
  const context = path.join(source, 'paper-core/tests/native-readonly-operator-normal.test.mjs');
  assert.equal(fs.realpathSync(context), context, 'canonical module context required');
  const resolve = createRequire(context).resolve;
  const installations = [path.join(source, 'node_modules'), path.join(path.dirname(source), 'node_modules')];
  const contextPins = new Map();
  function document(file) {
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024, 'bounded regular package document required');
    const before = pin(file), bytes = fs.readFileSync(file);
    assert.deepEqual(pin(file), before); contextPins.set(file, before);
    return bytes;
  }
  const manifestBytes = document(path.join(source, 'package.json'));
  const lockBytes = document(path.join(source, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  assert.equal(lock.lockfileVersion, 3);
  const roots = {};
  let installation = null;
  for (const name of READONLY_PARSER_PACKAGES) {
    const entry = fs.realpathSync(resolve(name));
    const selected = installations.find(base => entry.startsWith(path.join(base, name) + path.sep));
    assert.ok(selected, `parser dependency outside locked local/parent installation: ${name}`);
    if (installation === null) installation = selected;
    assert.equal(selected, installation, 'mixed parser installations are not a locked closure');
    const root = path.join(selected, name);
    assert.equal(fs.realpathSync(root), root, 'parser package alias refused');
    assert.ok(fs.lstatSync(root).isDirectory());
    const metadata = JSON.parse(document(path.join(root, 'package.json')));
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, lock.packages[`node_modules/${name}`]?.version, `locked parser version: ${name}`);
    roots[name] = root;
  }
  if (installation === installations[1]) {
    assert.deepEqual(document(path.join(path.dirname(source), 'package.json')), manifestBytes, 'parent manifest must be the exact source copy');
    assert.deepEqual(document(path.join(path.dirname(source), 'package-lock.json')), lockBytes, 'parent lock must be the exact source copy');
  }
  for (const [file, expected] of contextPins) assert.deepEqual(pin(file), expected);
  return { installation, roots: Object.freeze(roots), contextPins };
}

export function assertReadonlyFixtureSetupComplete(complete, failure) {
  if (failure) throw failure;
  assert.equal(complete, true, 'readonly fixture setup did not complete');
}
