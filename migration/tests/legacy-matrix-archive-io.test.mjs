import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  captureLegacyMatrixArchive, extractLegacyMatrixSources, legacyBytesHash,
  readStableLegacyFile,
} from '../legacy-matrix-archive-io.mjs';
import { resolveImmutableLegacyMatrixArchive } from '../legacy-matrix-reference.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-archive-io-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'input');
  const output = path.join(root, 'output');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  fs.mkdirSync(path.join(source, 'pkg'));
  fs.writeFileSync(path.join(source, 'pkg/a.py'), 'value = 42\n');
  const archive = path.join(root, 'reference.tar.gz');
  const result = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', source, 'pkg'], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const hash = legacyBytesHash(fs.readFileSync(archive));
  const sources = [{ path: 'pkg/a.py', sha256: legacyBytesHash(Buffer.from('value = 42\n')) }];
  return { root, source, output, archive, hash, sources };
}

test('real archive extraction verifies the exact regular source bytes', (t) => {
  const f = fixture(t);
  const capture = captureLegacyMatrixArchive(f.archive, f.hash);
  assert.equal(extractLegacyMatrixSources(capture, f.sources, f.output), 1);
  assert.equal(fs.readFileSync(path.join(f.output, 'pkg/a.py'), 'utf8'), 'value = 42\n');
});

test('an explicit missing or corrupt archive cannot fall back to an older discovered copy', (t) => {
  const f = fixture(t);
  const fallback = path.join(f.root, 'hepta-paper-legacy-reference');
  fs.mkdirSync(fallback);
  fs.copyFileSync(f.archive, path.join(fallback, 'reference.tar.gz'));
  const manifest = { archiveBasename: 'reference.tar.gz', archiveSha256: f.hash };
  const environment = { PAPER_FACTORY_LEGACY_ROOT: path.join(f.root, 'paper_factory') };
  assert.equal(resolveImmutableLegacyMatrixArchive({ manifest, environment }), path.join(fallback, 'reference.tar.gz'));
  for (const file of [path.join(f.root, 'missing.tar.gz'), path.join(f.root, 'corrupt.tar.gz')]) {
    if (file.includes('corrupt')) fs.writeFileSync(file, 'not the pinned archive');
    assert.throws(() => resolveImmutableLegacyMatrixArchive({
      manifest, environment: { ...environment, HEPTA_LEGACY_REFERENCE_ARCHIVE: file },
    }));
  }
});

test('archive reads reject symlink files, symlink parents, hardlinks, and special files', (t) => {
  const f = fixture(t);
  const symlink = path.join(f.root, 'alias.tar.gz');
  fs.symlinkSync(f.archive, symlink);
  assert.throws(() => captureLegacyMatrixArchive(symlink, f.hash), /legacy_matrix_file_unsafe/u);
  const linkedParent = path.join(f.root, 'linked');
  fs.symlinkSync(f.root, linkedParent);
  assert.throws(() => captureLegacyMatrixArchive(path.join(linkedParent, 'reference.tar.gz'), f.hash), /legacy_matrix_parent_unsafe/u);
  const hardlink = path.join(f.root, 'hardlink.tar.gz');
  fs.linkSync(f.archive, hardlink);
  assert.throws(() => captureLegacyMatrixArchive(f.archive, f.hash), /legacy_matrix_file_unsafe/u);
  fs.unlinkSync(hardlink);
  const fifo = path.join(f.root, 'fifo');
  assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
  assert.throws(() => readStableLegacyFile(fifo), /legacy_matrix_file_unsafe/u);
  assert.throws(() => readStableLegacyFile(f.source), /legacy_matrix_file_unsafe/u);
});

test('stable reads reject both same-path inode replacement and in-place mutation during capture', (t) => {
  const f = fixture(t);
  const read = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const result = read(...args);
    if (!changed) {
      changed = true;
      fs.renameSync(f.archive, `${f.archive}.saved`);
      fs.copyFileSync(`${f.archive}.saved`, f.archive);
    }
    return result;
  });
  assert.throws(() => captureLegacyMatrixArchive(f.archive, f.hash), /legacy_matrix_file_changed/u);
  t.mock.restoreAll();
  changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const result = read(...args);
    if (!changed) {
      changed = true;
      fs.appendFileSync(f.archive, 'changed');
    }
    return result;
  });
  assert.throws(() => captureLegacyMatrixArchive(f.archive, f.hash), /legacy_matrix_file_changed/u);
});

test('captured extraction never reopens an archive path after a replacement', (t) => {
  const f = fixture(t);
  const capture = captureLegacyMatrixArchive(f.archive, f.hash);
  fs.renameSync(f.archive, `${f.archive}.saved`);
  fs.writeFileSync(f.archive, 'replacement must not be consumed');
  assert.equal(extractLegacyMatrixSources(capture, f.sources, f.output), 1);
  assert.equal(fs.readFileSync(f.archive, 'utf8'), 'replacement must not be consumed');
  assert.throws(() => extractLegacyMatrixSources({ ...capture }, f.sources, f.output), /capture_required/u);
});

test('a matching archive digest does not excuse a different source hash', (t) => {
  const f = fixture(t);
  assert.throws(() => extractLegacyMatrixSources(captureLegacyMatrixArchive(f.archive, f.hash),
    [{ ...f.sources[0], sha256: `sha256:${'0'.repeat(64)}` }], f.output), /source_hash_mismatch/u);
});

test('source paths, duplicates, and nonempty destination roots are rejected before extraction', (t) => {
  const f = fixture(t);
  const capture = captureLegacyMatrixArchive(f.archive, f.hash);
  for (const entry of ['../escape', '/absolute', 'pkg/../escape', 'pkg//a.py', '-option', 'pkg/a.py\n']) {
    assert.throws(() => extractLegacyMatrixSources(capture, [{ ...f.sources[0], path: entry }], f.output), /source_invalid/u);
  }
  assert.throws(() => extractLegacyMatrixSources(capture, [...f.sources, ...f.sources], f.output), /source_invalid/u);
  fs.writeFileSync(path.join(f.output, 'existing'), 'retained');
  assert.throws(() => extractLegacyMatrixSources(capture, f.sources, f.output), /destination_unsafe/u);
  assert.equal(fs.readFileSync(path.join(f.output, 'existing'), 'utf8'), 'retained');
});

test('tar environment pollution cannot add options or suppress verification', (t) => {
  const f = fixture(t);
  const previous = process.env.TAR_OPTIONS;
  process.env.TAR_OPTIONS = '--not-a-real-option';
  t.after(() => { if (previous === undefined) delete process.env.TAR_OPTIONS; else process.env.TAR_OPTIONS = previous; });
  assert.equal(extractLegacyMatrixSources(captureLegacyMatrixArchive(f.archive, f.hash), f.sources, f.output), 1);
});

test('archive-selected symlinks and hardlinks are never extracted as source files', (t) => {
  const f = fixture(t);
  fs.symlinkSync('a.py', path.join(f.source, 'pkg/symlink.py'));
  fs.linkSync(path.join(f.source, 'pkg/a.py'), path.join(f.source, 'pkg/hardlink.py'));
  const result = spawnSync('/usr/bin/tar', ['-czf', f.archive, '-C', f.source,
    'pkg/a.py', 'pkg/symlink.py', 'pkg/hardlink.py']);
  assert.equal(result.status, 0);
  const capture = captureLegacyMatrixArchive(f.archive, legacyBytesHash(fs.readFileSync(f.archive)));
  for (const item of ['symlink', 'hardlink']) {
    assert.throws(() => extractLegacyMatrixSources(capture,
      [{ ...f.sources[0], path: `pkg/${item}.py` }], f.output), /source_not_unique_regular/u);
  }
  assert.deepEqual(fs.readdirSync(f.output), []);
});

test('duplicate archive members are rejected instead of selecting the last overwrite', (t) => {
  const f = fixture(t);
  assert.equal(spawnSync('/usr/bin/tar', ['-czf', f.archive, '-C', f.source, 'pkg/a.py', 'pkg/a.py']).status, 0);
  const capture = captureLegacyMatrixArchive(f.archive, legacyBytesHash(fs.readFileSync(f.archive)));
  assert.throws(() => extractLegacyMatrixSources(capture, f.sources, f.output), /source_not_unique_regular/u);
  assert.deepEqual(fs.readdirSync(f.output), []);
});

test('archive file bounds and malformed expected digests fail before allocating input', (t) => {
  const f = fixture(t);
  assert.throws(() => readStableLegacyFile(f.archive, 1), /file_unsafe/u);
  for (const bound of [NaN, Infinity, 0, -1, true]) {
    assert.throws(() => readStableLegacyFile(f.archive, bound), /path_or_limit_invalid/u);
  }
  assert.throws(() => captureLegacyMatrixArchive(f.archive, 'sha256:not-a-digest'), /digest_invalid/u);
});


test('relative and aliased extraction roots are rejected before extraction', (t) => {
  const f = fixture(t);
  const capture = captureLegacyMatrixArchive(f.archive, f.hash);
  for (const root of ['.', path.relative(process.cwd(), f.output), `${f.output}/../output`]) {
    assert.throws(() => extractLegacyMatrixSources(capture, f.sources, root), /destination_unsafe/u);
  }
  const alias = path.join(f.root, 'output-alias');
  fs.symlinkSync(f.output, alias);
  assert.throws(() => extractLegacyMatrixSources(capture, f.sources, alias), /destination_unsafe/u);
  assert.deepEqual(fs.readdirSync(f.output), []);
});

test('selected decompressed source bytes have an aggregate bound before any writes', (t) => {
  const f = fixture(t);
  fs.truncateSync(path.join(f.source, 'pkg/a.py'), 129 * 1024 * 1024);
  assert.equal(spawnSync('/usr/bin/tar', ['-czf', f.archive, '-C', f.source, 'pkg/a.py']).status, 0);
  const capture = captureLegacyMatrixArchive(f.archive, legacyBytesHash(fs.readFileSync(f.archive)));
  assert.throws(() => extractLegacyMatrixSources(capture, f.sources, f.output), /source_size_invalid/u);
  assert.deepEqual(fs.readdirSync(f.output), []);
});


test('multiple individually bounded sources cannot exceed the total extraction limit', (t) => {
  const f = fixture(t);
  const sources = [f.sources[0], { ...f.sources[0], path: 'pkg/b.py' }];
  fs.writeFileSync(path.join(f.source, 'pkg/b.py'), '');
  for (const source of sources) fs.truncateSync(path.join(f.source, source.path), 65 * 1024 * 1024);
  assert.equal(spawnSync('/usr/bin/tar', ['-czf', f.archive, '-C', f.source, 'pkg']).status, 0);
  const capture = captureLegacyMatrixArchive(f.archive, legacyBytesHash(fs.readFileSync(f.archive)));
  assert.throws(() => extractLegacyMatrixSources(capture, sources, f.output), /extraction_byte_limit/u);
  assert.deepEqual(fs.readdirSync(f.output), []);
});

test('invalid archive selectors fail before discovery and symlink discovery roots are rejected', (t) => {
  const f = fixture(t);
  for (const archiveBasename of ['../reference.tar.gz', '/reference.tar.gz', '', '.']) {
    assert.throws(() => resolveImmutableLegacyMatrixArchive({
      manifest: { archiveBasename, archiveSha256: f.hash }, environment: {},
    }), /archive_manifest_invalid/u);
  }
  fs.symlinkSync(f.source, path.join(f.root, 'hepta-paper-legacy-reference'));
  assert.throws(() => resolveImmutableLegacyMatrixArchive({
    manifest: { archiveBasename: 'reference.tar.gz', archiveSha256: f.hash },
    environment: { PAPER_FACTORY_LEGACY_ROOT: path.join(f.root, 'paper_factory') },
  }), /discovery_root_unsafe/u);
});
