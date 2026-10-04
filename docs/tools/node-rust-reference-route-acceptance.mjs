// Deterministic ordinary retirement/reference inputs. These are source-only
// compatibility observations and grant no deletion or retirement authority.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const REFERENCE_STATUS_PROFILES_V1 = Object.freeze([
  'verified', 'empty-archives', 'missing-first-edge', 'missing-last-edge',
  'missing-snapshot-receipt', 'missing-immutable-receipt', 'malformed-snapshot',
  'malformed-immutable', 'archive-missing', 'archive-size-mismatch', 'archive-hash-mismatch',
  'immutable-file-missing', 'immutable-file-present', 'utf8-names', 'relative-root',
  'relative-parent-root', 'snapshot-without-archives', 'immutable-without-files',
  'duplicate-json-key', 'duplicate-archive-name', 'parent-archive-name',
  'archive-symlink', 'receipt-symlink', 'invalid-hash', 'archive-count-limit',
  'receipt-byte-limit',
]);
const identity = s => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String);
function pin(file) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.size > 512n * 1024n * 1024n) throw new Error('reference_fixture_input_invalid');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (JSON.stringify(identity(fs.fstatSync(fd, { bigint: true }))) !== JSON.stringify(identity(before))) throw new Error('reference_fixture_input_changed');
    const hash = createHash('sha256'), block = Buffer.alloc(64 * 1024); let size = 0n;
    for (let count; (count = fs.readSync(fd, block)) !== 0;) {
      size += BigInt(count); if (size > before.size) throw new Error('reference_fixture_input_grew');
      hash.update(block.subarray(0, count));
    }
    if (size !== before.size || [fs.fstatSync(fd, { bigint: true }), fs.lstatSync(file, { bigint: true })]
      .some(s => JSON.stringify(identity(s)) !== JSON.stringify(identity(before)))) throw new Error('reference_fixture_input_changed');
    return { identity: identity(before), sha256: `sha256:${hash.digest('hex')}` };
  } finally { fs.closeSync(fd); }
}
function copy(source, target, mode) {
  const original = pin(source); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(target, mode); const actual = pin(target);
  if (actual.sha256 !== original.sha256 || actual.identity[5] !== '1'
    || actual.identity[0] === original.identity[0] && actual.identity[1] === original.identity[1]
    || JSON.stringify(pin(source)) !== JSON.stringify(original)) throw new Error('reference_fixture_copy_not_independent');
  return [source, original, target, actual];
}
function write(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o440 });
}
const deployments = new Map();
function deployment(fixture, source, nativeOwner) {
  const previous = deployments.get(fixture);
  if (previous) {
    if (previous.source !== source || previous.ownerSha256 !== nativeOwner.sha256) throw new Error('reference_fixture_owner_selection_changed');
    previous.assertCurrent(); return previous;
  }
  const workspace = path.join(fixture, 'deployment'), caller = path.join(fixture, 'caller');
  fs.mkdirSync(caller, { mode: 0o700 }); fs.mkdirSync(path.join(workspace, 'paper-core/config'), { recursive: true, mode: 0o700 });
  const pins = [], seen = new Set(), pending = ['paper-core/bin/hepta-paper.mjs', 'migration/bin/verify-retirement-source-snapshot.mjs'];
  while (pending.length) {
    const relative = pending.pop(); if (seen.has(relative)) continue; seen.add(relative);
    const from = path.join(source, relative); pins.push(copy(from, path.join(workspace, relative), 0o440));
    if (!relative.endsWith('.mjs')) continue;
    for (const match of fs.readFileSync(from, 'utf8').matchAll(/(?:from\s+|import\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)) {
      const name = match[1]; if (name.startsWith('node:')) continue;
      if (!name.startsWith('.')) throw new Error(`reference_fixture_import_unbound:${name}`);
      const selected = path.relative(source, path.resolve(path.dirname(from), name));
      if (!selected || selected.startsWith(`..${path.sep}`) || path.isAbsolute(selected)) throw new Error('reference_fixture_import_outside_source');
      pending.push(selected);
    }
  }
  const executable = path.join(workspace, 'bin/hepta-paper-rust');
  const binary = copy(nativeOwner.path, executable, 0o550); pins.push(binary);
  if (binary[3].sha256 !== nativeOwner.sha256) throw new Error('reference_fixture_native_owner_changed');
  write(path.join(workspace, 'package.json'), JSON.stringify({ name: 'hepta-paper-workspace', version: '0.21.0' }));
  // A decoy current directory must not determine either ordinary worker ROOT.
  write(path.join(caller, 'package.json'), '{"name":"hepta-paper-workspace","version":"999.0.0"}');
  const value = { source, ownerSha256: nativeOwner.sha256, workspace, caller, executable,
    assertCurrent: () => {
      for (const [from, original, to, copied] of pins) if (JSON.stringify(pin(from)) !== JSON.stringify(original)
        || JSON.stringify(pin(to)) !== JSON.stringify(copied)) throw new Error('reference_fixture_source_or_copy_changed');
    } };
  deployments.set(fixture, value); return value;
}
export function closeReferenceStatusFixtureV1(fixture) { deployments.delete(fixture); }
export function referenceStatusFixtureV1(fixture, profile, source, nativeOwner) {
  if (!REFERENCE_STATUS_PROFILES_V1.includes(profile)) throw new Error('reference_fixture_profile_invalid');
  const selected = deployment(fixture, source, nativeOwner);
  const { workspace, caller, executable, assertCurrent } = selected;
  // The physical copied deployment stays immutable for this one route
  // observation. Every case gets freshly created reference data; the complete
  // deployment and data namespace still participates in both inventories.
  fs.rmSync(path.join(workspace, 'reference'), { recursive: true, force: true });
  fs.rmSync(path.join(workspace, 'legacy.tar.zst'), { force: true });
  let reference = path.join(workspace, 'reference'); fs.mkdirSync(reference, { mode: 0o700 });
  let name = profile === 'utf8-names' ? '旧版归档.tar.zst' : 'legacy.tar.zst';
  const data = Buffer.from('deterministic source-only retirement reference\n');
  let archive = { name, bytes: data.length, sha256: sha256(data) };
  let snapshot = { archives: [archive] }, immutable = { files: [] };
  write(path.join(reference, name), data);
  if (profile === 'empty-archives') snapshot.archives = [];
  if (profile === 'archive-missing') fs.unlinkSync(path.join(reference, name));
  if (profile === 'archive-size-mismatch') archive.bytes += 1;
  if (profile === 'archive-hash-mismatch') archive.sha256 = `sha256:${'0'.repeat(64)}`;
  if (profile === 'invalid-hash') archive.sha256 = 'not-a-content-hash';
  if (profile === 'immutable-file-missing') immutable.files = [{ name: 'not-present.tar.zst' }];
  if (profile === 'immutable-file-present') immutable.files = [{ name }];
  if (profile === 'snapshot-without-archives') snapshot = {};
  if (profile === 'immutable-without-files') immutable = {};
  if (profile === 'duplicate-archive-name') snapshot.archives = [archive, { ...archive }];
  if (profile === 'archive-count-limit') snapshot.archives = Array.from({ length: 129 }, (_, i) => ({ ...archive, name: `missing-${i}.tar.zst` }));
  if (profile === 'parent-archive-name') { write(path.join(workspace, name), data); archive.name = `../${name}`; }
  if (profile === 'archive-symlink') { fs.renameSync(path.join(reference, name), path.join(reference, 'real-archive')); fs.symlinkSync('real-archive', path.join(reference, name)); }
  if (!['missing-first-edge', 'missing-last-edge', 'missing-snapshot-receipt'].includes(profile)) {
    let bytes = JSON.stringify(snapshot);
    if (profile === 'malformed-snapshot') bytes = '{';
    if (profile === 'duplicate-json-key') bytes = '{"archives":[],"archives":'+JSON.stringify(snapshot.archives)+'}';
    if (profile === 'receipt-byte-limit') bytes = JSON.stringify({ ...snapshot, padding: 'x'.repeat(4 * 1024 * 1024) });
    write(path.join(reference, 'RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json'), bytes);
  }
  if (!['missing-first-edge', 'missing-last-edge', 'missing-immutable-receipt'].includes(profile))
    write(path.join(reference, 'IMMUTABILITY_RECEIPT.json'), profile === 'malformed-immutable' ? '{' : JSON.stringify(immutable));
  if (profile === 'receipt-symlink') {
    fs.renameSync(path.join(reference, 'RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json'), path.join(reference, 'held-snapshot.json'));
    fs.symlinkSync('held-snapshot.json', path.join(reference, 'RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json'));
  }
  if (profile === 'missing-first-edge') reference = path.join(workspace, 'first-missing/leaf');
  if (profile === 'missing-last-edge') reference = path.join(reference, 'missing-leaf');
  const environment = { HEPTA_RETIREMENT_REFERENCE: profile === 'relative-root' ? './reference'
    : profile === 'relative-parent-root' ? './reference/../reference/.' : reference };
  return { cwd: caller, executable, environment,
    node: [path.join(workspace, 'paper-core/bin/hepta-paper.mjs'), 'retirement', 'reference'],
    assertCurrent };
}
export function expectedReferenceStatusV1(testCase, result) {
  const blockers = {
    'missing-first-edge': ['retirement_snapshot_receipt_missing_or_invalid', 'immutability_receipt_missing_or_invalid'],
    'missing-last-edge': ['retirement_snapshot_receipt_missing_or_invalid', 'immutability_receipt_missing_or_invalid'],
    'missing-snapshot-receipt': ['retirement_snapshot_receipt_missing_or_invalid'],
    'missing-immutable-receipt': ['immutability_receipt_missing_or_invalid'],
    'malformed-snapshot': ['retirement_snapshot_receipt_missing_or_invalid'],
    'malformed-immutable': ['immutability_receipt_missing_or_invalid'],
    'archive-missing': ['archive_missing:legacy.tar.zst'],
    'archive-size-mismatch': ['archive_size_mismatch:legacy.tar.zst'],
    'archive-hash-mismatch': ['archive_hash_mismatch:legacy.tar.zst'],
    'immutable-file-present': ['archive_not_immutable:legacy.tar.zst'],
  }[testCase.profile] || [];
  // Boundary profiles retain actual Node/native disagreement; they cannot be
  // accepted through equal generic failure or a test-only status override.
  return result.outcome === 'report' && result.exitCode === (blockers.length ? 1 : 0)
    && result.stdout.version === 1 && result.stdout.kind === 'LegacyRetirementReferenceVerification'
    && result.stdout.runtimeDependencyAllowed === false
    && typeof result.stdout.liveLegacyRootExists === 'boolean'
    && result.stdout.status === (blockers.length ? 'retirement_reference_blocked' : 'retirement_reference_verified')
    && JSON.stringify(result.stdout.blockers) === JSON.stringify(blockers);
}
