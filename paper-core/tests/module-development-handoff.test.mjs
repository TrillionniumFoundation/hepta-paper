import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// Source-bound navigation checks, not a Rust build or semantic parity verdict.
test('every registered module has a concrete implementation handoff', () => {
  const modules = Object.keys(JSON.parse(read('docs/system/truth/modules.v1.json')).modules).sort();
  const document = read('docs/modules/IMPLEMENTATION_HANDOFF.md');
  const sections = [...document.matchAll(/^## (module\.[a-z-]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)];
  assert.deepEqual(sections.map((row) => row[1]).sort(), modules);
  for (const [, moduleId, body] of sections) {
    for (const label of ['Implementation scope', 'API and concrete types', 'Engineering contract', 'Boundary and recovery', 'Focused validation']) {
      assert.ok(body.includes(`**${label}:**`), `${moduleId}: missing ${label}`);
    }
    assert.match(body, /\]\([^)]+\.(?:rs|mjs|py)\)/, `${moduleId}: no actual source file`);
  }
  for (const [, relative] of document.matchAll(/\]\(([^)]+)\)/g)) {
    assert.ok(!relative.includes('://'), 'handoff references must bind repository source');
    const target = path.resolve(root, 'docs/modules', relative.split('#')[0]);
    assert.ok(target.startsWith(`${root.replace(/\/$/, '')}/`));
    const stat = fs.lstatSync(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `missing or aliased handoff ${relative}`);
  }
});

function cliCommands(source) {
  const commands = [...source.matchAll(/^\\s*Some\\("([a-z][a-z-]*)"\\)(?:\\s+if[^\\n]*)?\\s*=>\\s*\\{/gm)].map((row) => row[1]);
  assert.ok(commands.length > 0, 'CLI extraction must not silently become empty');
  assert.equal(new Set(commands).size, commands.length, 'unexpected duplicate CLI arm');
  return commands.sort();
}
function documentedCommands(document) {
  const commands = [...document.matchAll(/^\| `([a-z][a-z-]*)(?: [^`]*)?` \|/gm)].map((row) => row[1]);
  assert.equal(new Set(commands).size, commands.length, 'duplicate documented command');
  return commands.sort();
}

test('service command documentation covers the actual command match arms', () => {
  assert.deepEqual(
    documentedCommands(read('rust/crates/hepta-paper-service/README.md')),
    cliCommands(read('rust/crates/hepta-paper-service/src/bin/hepta-paper-rust.rs')),
  );
});

test('command documentation comparison exposes additions, omissions and duplicates', () => {
  const source = 'Some("first") if args.len() == 1 => {}, Some("second") if args.len() == 2 => {}';
  assert.deepEqual(cliCommands(source), ['first', 'second']);
  assert.notDeepEqual(documentedCommands('| `first` | described |\n'), cliCommands(source));
  assert.throws(() => documentedCommands('| `first` | one |\n| `first ARG` | two |\n'), /duplicate/);
  assert.throws(() => cliCommands('fn command() {}'), /empty/);
});
