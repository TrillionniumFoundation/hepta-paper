import assert from 'node:assert/strict';
import test from 'node:test';
import { relativeModuleSpecifiers } from '../verification/javascript-module-specifiers.mjs';

test('specifier discovery preserves ASCII identifier boundaries and immutable results', () => {
  const identifierCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$';
  for (const character of identifierCharacters) {
    assert.deepEqual(relativeModuleSpecifiers(`import${character} './not-an-import.mjs';`), []);
    assert.deepEqual(relativeModuleSpecifiers(`export${character} * from './not-an-export.mjs';`), []);
  }
  for (const whitespace of [' ', '\t', '\n', '\r', '\v', '\f', '\u00a0', '\ufeff']) {
    assert.deepEqual(relativeModuleSpecifiers(`import${whitespace}'./dependency.mjs';`), ['./dependency.mjs']);
  }
  assert.ok(Object.isFrozen(relativeModuleSpecifiers("import './dependency.mjs';")));
});

test('specifier discovery retains comments templates escaped strings dynamic imports and deduplication', () => {
  assert.deepEqual(relativeModuleSpecifiers([
    "// import './comment.mjs';",
    "/* export * from './block-comment.mjs'; */",
    "const template = `import './template.mjs'`;",
    "import './first.mjs';",
    "export { value } from '../second.mjs';",
    "const dynamic = import('./third.mjs');",
    "const computed = import('./computed-' + suffix);",
    "import './first.mjs';",
    "import 'node:fs';",
    "import './escaped\\u002dpath.mjs';",
  ].join('\n')), ['./first.mjs', '../second.mjs', './third.mjs', './escaped\\u002dpath.mjs']);
  assert.deepEqual(relativeModuleSpecifiers(''), []);
  assert.deepEqual(relativeModuleSpecifiers(undefined), []);
});
