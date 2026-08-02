import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { copySqliteDatabase } from '../../paper-adapters/persistence/sqlite-consistent-copy.mjs';

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sqlite-copy-security-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source.sqlite');
  const database = new DatabaseSync(sourcePath);
  database.exec(`
PRAGMA foreign_keys=ON;
CREATE TABLE parent(id INTEGER PRIMARY KEY) STRICT;
CREATE TABLE child(
  id INTEGER PRIMARY KEY,
  parent_id INTEGER NOT NULL REFERENCES parent(id)
) STRICT;
INSERT INTO parent(id) VALUES(1);
INSERT INTO child(id,parent_id) VALUES(1,1);
`);
  database.close();
  return { root, sourcePath };
}

function mode(candidate) {
  return fs.statSync(candidate).mode & 0o777;
}

test('consistent SQLite copies are owner-only from creation under a permissive umask', async (t) => {
  const fixture = createFixture(t);
  const destinationPath = path.join(fixture.root, 'backup.sqlite');
  const previousUmask = process.umask(0o000);
  try {
    const pending = copySqliteDatabase({
      sourcePath: fixture.sourcePath,
      destinationPath,
    });
    assert.equal(fs.existsSync(destinationPath), false);
    await pending;
  } finally {
    process.umask(previousUmask);
  }

  const stat = fs.lstatSync(destinationPath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.nlink, 1);
  assert.equal(mode(destinationPath), 0o600);
  const copy = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    assert.deepEqual(copy.prepare('PRAGMA quick_check;').all().map((row) => ({ ...row })), [
      { quick_check: 'ok' },
    ]);
    assert.deepEqual(copy.prepare('PRAGMA foreign_key_check;').all(), []);
    assert.equal(copy.prepare('SELECT count(*) AS count FROM child;').get().count, 1);
  } finally {
    copy.close();
  }
  assert.deepEqual(fs.readdirSync(fixture.root).filter((name) => name.startsWith('.sqlite-copy-')), []);
});

test('consistent SQLite copies never replace existing regular, symbolic, or hard-linked targets', async (t) => {
  const fixture = createFixture(t);
  const regularPath = path.join(fixture.root, 'regular.sqlite');
  fs.writeFileSync(regularPath, 'regular-sentinel', { mode: 0o600 });
  await assert.rejects(
    copySqliteDatabase({ sourcePath: fixture.sourcePath, destinationPath: regularPath }),
    (error) => error?.code === 'EEXIST',
  );
  assert.equal(fs.readFileSync(regularPath, 'utf8'), 'regular-sentinel');

  const victimPath = path.join(fixture.root, 'victim.sqlite');
  fs.writeFileSync(victimPath, 'symlink-victim', { mode: 0o600 });
  const symlinkPath = path.join(fixture.root, 'symlink.sqlite');
  fs.symlinkSync(victimPath, symlinkPath);
  await assert.rejects(
    copySqliteDatabase({ sourcePath: fixture.sourcePath, destinationPath: symlinkPath }),
    (error) => error?.code === 'EEXIST',
  );
  assert.equal(fs.readFileSync(victimPath, 'utf8'), 'symlink-victim');
  assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);

  const hardlinkSourcePath = path.join(fixture.root, 'hardlink-source.sqlite');
  fs.writeFileSync(hardlinkSourcePath, 'hardlink-sentinel', { mode: 0o600 });
  const hardlinkPath = path.join(fixture.root, 'hardlink.sqlite');
  fs.linkSync(hardlinkSourcePath, hardlinkPath);
  await assert.rejects(
    copySqliteDatabase({ sourcePath: fixture.sourcePath, destinationPath: hardlinkPath }),
    (error) => error?.code === 'EEXIST',
  );
  assert.equal(fs.readFileSync(hardlinkSourcePath, 'utf8'), 'hardlink-sentinel');
  assert.equal(fs.statSync(hardlinkSourcePath).nlink, 2);
  assert.deepEqual(fs.readdirSync(fixture.root).filter((name) => name.startsWith('.sqlite-copy-')), []);
});

test('consistent SQLite copies reject linked or writable destination parents and linked sources', async (t) => {
  const fixture = createFixture(t);
  const linkedSource = path.join(fixture.root, 'linked-source.sqlite');
  fs.symlinkSync(fixture.sourcePath, linkedSource);
  await assert.rejects(
    copySqliteDatabase({
      sourcePath: linkedSource,
      destinationPath: path.join(fixture.root, 'from-linked-source.sqlite'),
    }),
    /sqlite_copy_source_unsafe/,
  );

  const realParent = path.join(fixture.root, 'real-parent');
  fs.mkdirSync(realParent, { mode: 0o700 });
  const linkedParent = path.join(fixture.root, 'linked-parent');
  fs.symlinkSync(realParent, linkedParent);
  await assert.rejects(
    copySqliteDatabase({
      sourcePath: fixture.sourcePath,
      destinationPath: path.join(linkedParent, 'copy.sqlite'),
    }),
    /sqlite_copy_destination_parent_unsafe/,
  );
  assert.deepEqual(fs.readdirSync(realParent), []);

  const writableParent = path.join(fixture.root, 'writable-parent');
  fs.mkdirSync(writableParent, { mode: 0o777 });
  fs.chmodSync(writableParent, 0o777);
  await assert.rejects(
    copySqliteDatabase({
      sourcePath: fixture.sourcePath,
      destinationPath: path.join(writableParent, 'copy.sqlite'),
    }),
    /sqlite_copy_destination_parent_unsafe/,
  );
  assert.deepEqual(fs.readdirSync(writableParent), []);
});

test('failed SQLite backup creation removes the exclusively-created destination', async (t) => {
  const fixture = createFixture(t);
  const invalidSourcePath = path.join(fixture.root, 'invalid.sqlite');
  fs.writeFileSync(invalidSourcePath, 'not a SQLite database', { mode: 0o600 });
  const destinationPath = path.join(fixture.root, 'failed.sqlite');
  await assert.rejects(
    copySqliteDatabase({ sourcePath: invalidSourcePath, destinationPath }),
  );
  assert.equal(fs.existsSync(destinationPath), false);
  assert.deepEqual(fs.readdirSync(fixture.root).filter((name) => name.startsWith('.sqlite-copy-')), []);
});

test('SQLite copies fail closed before publication when restore verification finds foreign-key damage', async (t) => {
  const fixture = createFixture(t);
  const damaged = new DatabaseSync(fixture.sourcePath);
  damaged.exec(`
PRAGMA foreign_keys=OFF;
INSERT INTO child(id,parent_id) VALUES(2,999);
PRAGMA foreign_keys=ON;
`);
  damaged.close();
  const destinationPath = path.join(fixture.root, 'damaged.sqlite');
  await assert.rejects(
    copySqliteDatabase({ sourcePath: fixture.sourcePath, destinationPath }),
    /sqlite_copy_restore_verification_failed/,
  );
  assert.equal(fs.existsSync(destinationPath), false);
  assert.deepEqual(fs.readdirSync(fixture.root).filter((name) => name.startsWith('.sqlite-copy-')), []);
});
