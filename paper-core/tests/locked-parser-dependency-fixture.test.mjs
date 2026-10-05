import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { READONLY_PARSER_PACKAGES, resolveReadonlyParserDependencies, assertReadonlyFixtureSetupComplete } from './support/locked-parser-dependency-fixture.mjs';
function pin(file) {
  const stat = fs.lstatSync(file, { bigint: true }); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  return { identity: ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(stat[k])), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
function fixture(t, layout) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-parser-layout-'));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const parent = path.join(outer, 'parent'), source = path.join(parent, 'candidate');
  fs.mkdirSync(path.join(source, 'paper-core/tests'), { recursive: true });
  fs.writeFileSync(path.join(source, 'paper-core/tests/native-readonly-operator-normal.test.mjs'), '// module resolution context only\n');
  const manifest = JSON.stringify({ name: 'fixture-only', version: '0.0.0' });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(READONLY_PARSER_PACKAGES.map(name => [`node_modules/${name}`, { version: '1.0.0' }])) });
  for (const directory of [source, parent]) {
    fs.writeFileSync(path.join(directory, 'package.json'), manifest);
    fs.writeFileSync(path.join(directory, 'package-lock.json'), lock);
  }
  const installation = path.join(layout === 'local' ? source : layout === 'parent' ? parent : outer, 'node_modules');
  for (const name of READONLY_PARSER_PACKAGES) {
    const selected = path.join(installation, name); fs.mkdirSync(selected, { recursive: true });
    fs.writeFileSync(path.join(selected, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(selected, 'index.js'), "throw new Error('fixture package must never be executed');\n");
  }
  return { outer, parent, source, installation };
}
for (const layout of ['local', 'parent']) test(`accept exact ${layout} locked package files without installing or executing them`, t => {
  const f = fixture(t, layout), found = resolveReadonlyParserDependencies({ source: f.source, pin });
  assert.equal(found.installation, f.installation);
  assert.equal(Object.keys(found.roots).length, 7);
  for (const name of READONLY_PARSER_PACKAGES) assert.equal(found.roots[name], path.join(f.installation, name));
  if (layout === 'parent') assert.equal(fs.existsSync(path.join(f.source, 'node_modules')), false);
});
test('an actual resolver hit in a farther ancestor is refused', t => {
  const f = fixture(t, 'ancestor');
  assert.throws(() => resolveReadonlyParserDependencies({ source: f.source, pin }), /outside locked/);
});
test('mixed local and parent packages are refused', t => {
  const f = fixture(t, 'parent'); fs.mkdirSync(path.join(f.source, 'node_modules'));
  fs.renameSync(path.join(f.installation, 'espree'), path.join(f.source, 'node_modules/espree'));
  assert.throws(() => resolveReadonlyParserDependencies({ source: f.source, pin }), /mixed parser installations/);
});
test('package symlink escape is refused without executing its main', t => {
  const f = fixture(t, 'local'), selected = path.join(f.installation, 'espree'), moved = path.join(f.outer, 'foreign-espree');
  fs.renameSync(selected, moved); fs.symlinkSync(moved, selected);
  assert.throws(() => resolveReadonlyParserDependencies({ source: f.source, pin }), /outside locked|alias/);
});
for (const name of ['package.json', 'package-lock.json']) test(`parent ${name} must be the exact candidate bytes`, t => {
  const f = fixture(t, 'parent'); fs.appendFileSync(path.join(f.parent, name), '\n');
  assert.throws(() => resolveReadonlyParserDependencies({ source: f.source, pin }), /exact source copy/);
});
test('missing metadata and declared-version drift remain real failures', t => {
  const f = fixture(t, 'local'), file = path.join(f.installation, 'espree/package.json'), bytes = fs.readFileSync(file);
  fs.unlinkSync(file); assert.throws(() => resolveReadonlyParserDependencies({ source: f.source, pin }), /ENOENT/);
  const value = JSON.parse(bytes); value.version = '2.0.0'; fs.writeFileSync(file, JSON.stringify(value));
  assert.throws(() => resolveReadonlyParserDependencies({ source: f.source, pin }), /locked parser version/);
});
test('incomplete setup retains its original error instead of reading an uncreated marker', () => {
  const original = new Error('original missing dependency'); let markerReads = 0;
  assert.throws(() => { assertReadonlyFixtureSetupComplete(false, original); markerReads += 1; }, error => error === original);
  assert.equal(markerReads, 0);
  assert.throws(() => assertReadonlyFixtureSetupComplete(false, null), /did not complete/);
  assert.throws(() => assertReadonlyFixtureSetupComplete(true, original), error => error === original);
  assert.doesNotThrow(() => assertReadonlyFixtureSetupComplete(true, null));
});
