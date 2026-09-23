import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { isPathWithin, resolveRepoPath } from '../../workflow-kernel/runtime/path-utils.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';

test('resolveRepoPath preserves the five former adapter-local path semantics', () => {
  const root = path.resolve('/tmp/hepta-root');
  assert.equal(resolveRepoPath(root, null), null);
  assert.equal(resolveRepoPath(root, '   '), null);
  assert.equal(resolveRepoPath(root, 'papers/example/main.tex'), path.join(root, 'papers/example/main.tex'));
  assert.equal(resolveRepoPath(root, '/var/tmp/paper/main.tex'), '/var/tmp/paper/main.tex');
  assert.equal(resolveRepoPath(root, ' papers/example/main.tex '), path.join(root, 'papers/example/main.tex'));
});

test('isPathWithin accepts a root and descendants but rejects lexical siblings', () => {
  const root = path.resolve('/tmp/hepta-workspace');
  assert.equal(isPathWithin(root, root), true);
  assert.equal(isPathWithin(root, path.join(root, 'attempts', 'a')), true);
  assert.equal(isPathWithin(root, path.resolve('/tmp/hepta-workspace-other')), false);
  assert.equal(isPathWithin(root, path.join(root, '..', 'escaped')), false);
  assert.equal(pathWithin(root, path.join(root, 'attempts', 'a')), true);
  assert.equal(pathWithin(root, path.resolve('/tmp/hepta-workspace-other')), false);
});
