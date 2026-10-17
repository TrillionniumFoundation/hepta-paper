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
    assert.ok(body.trim().length > 0, `${moduleId}: empty handoff`);
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

// Runtime command/document equality is owned by the compiled Rust catalog and
// the cli_command_catalog executable test. Do not parse Rust match-arm spelling.
