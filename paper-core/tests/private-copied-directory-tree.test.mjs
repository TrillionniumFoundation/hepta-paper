import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  makePrivateCopiedDirectoryTreeWritable,
} from '../../workflow-kernel/runtime/private-copied-directory-tree.mjs';

function mode(selected) {
  return fs.statSync(selected).mode & 0o777;
}

test('sealed copied directories become private writable without changing file modes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-private-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, 'nested', 'deeper');
  fs.mkdirSync(nested, { recursive: true });
  const fixture = path.join(nested, 'fixture.txt');
  fs.writeFileSync(fixture, 'fixture\n');
  fs.chmodSync(fixture, 0o444);
  fs.chmodSync(nested, 0o555);
  fs.chmodSync(path.dirname(nested), 0o555);
  fs.chmodSync(root, 0o555);

  const result = makePrivateCopiedDirectoryTreeWritable({ root });

  assert.deepEqual(result, { root, directoryCount: 3, mode: '0700' });
  assert.equal(mode(root), 0o700);
  assert.equal(mode(path.dirname(nested)), 0o700);
  assert.equal(mode(nested), 0o700);
  assert.equal(mode(fixture), 0o444);
});

test('copied directory normalization rejects symbolic-link entries', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-private-copy-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'target.txt'), 'target\n');
  fs.symlinkSync('target.txt', path.join(root, 'linked.txt'));

  assert.throws(
    () => makePrivateCopiedDirectoryTreeWritable({ root }),
    /private_copied_directory_tree_symlink_forbidden/u,
  );
});
