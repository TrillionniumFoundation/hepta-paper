// Pure controls for owner-source batching. Only source text is read from disk;
// the extracted production functions run in a VM with in-memory fs and Git.
// No runner imports, actual Git children, native fixtures, Cargo, ELF or signals.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const gitSource = fs.readFileSync(new URL('../src/source-evidence-git-inputs.mjs', import.meta.url), 'utf8');
const cargoSource = fs.readFileSync(new URL('../src/source-evidence-cargo-observations.mjs', import.meta.url), 'utf8');
const ROOT = '/checkout';
const identityFields = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const identity = metadata => identityFields.map(key => String(metadata[key]));
const gitBlob = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const artifactHash = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

function extractFunction(source, name) {
  const start = source.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `production function ${name} must exist`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `production function ${name} must have a top-level closing brace`);
  return source.slice(start, end + 2).replace(/^export /u, '');
}

// Exact historical assertion from Cargo module Git blob
// e973a4720e094ceae7b0bb35a68940c4933a4cfb. This is a negative budget
// control, never a substitute implementation for the positive assertions.
const historicalCargoAssertion = `function assertCargoBinaryArtifactsCurrent(root, binaries, rehash = false) {
  for (const pin of binaries) {
    readPinnedSource(root, pin.sourcePath, pin.sourcePin);
    readPinnedSource(root, pin.manifestPath, pin.manifestPin);
    const named = fs.lstatSync(pin.path, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink()
        || JSON.stringify(artifactIdentity(named)) !== JSON.stringify(pin.identity)) {
      fail('verification_binary_changed', pin.environmentKey);
    }
    if (rehash && JSON.stringify(artifactPin(pin.path, root))
        !== JSON.stringify({ path: pin.path, sha256: pin.sha256, identity: pin.identity })) {
      fail('verification_binary_changed', pin.environmentKey);
    }
  }
}`;

function systemError(code, detail) {
  return Object.assign(new Error(`${code}: ${detail}`), { code });
}

function harness({ historical = false, owners = 3 } = {}) {
  let nextInode = 100n, nextDescriptor = 30;
  const descriptors = new Map(), hooks = {};
  const metrics = { opens: [], closes: [], reads: [], stats: [], index: [], hashes: [], rehashes: [], events: [] };
  const constants = { O_RDONLY: 0, O_DIRECTORY: 0x10000, O_NOFOLLOW: 0x20000, O_NONBLOCK: 0x800 };
  const makeNode = (kind, bytes = Buffer.alloc(0)) => ({
    kind, bytes: Buffer.from(bytes), children: new Map(), target: undefined,
    dev: 1n, ino: nextInode++, mode: kind === 'directory' ? 0o40755n : kind === 'symlink' ? 0o120777n : 0o100644n,
    uid: 1000n, gid: 1000n, nlink: 1n, size: BigInt(bytes.length), mtimeNs: 100n, ctimeNs: 100n,
  });
  const rootNode = makeNode('directory');
  const invoke = (name, ...args) => hooks[name]?.(...args);
  const metadata = (node, bigint = true) => ({
    ...Object.fromEntries(identityFields.map(key => [key, bigint ? node[key] : Number(node[key])])),
    isFile: () => node.kind === 'file', isDirectory: () => node.kind === 'directory',
    isSymbolicLink: () => node.kind === 'symlink',
  });
  const walk = (named, follow = false) => {
    const proc = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/u.exec(named);
    let node, parts;
    if (proc) {
      const held = descriptors.get(Number(proc[1]));
      if (!held) throw systemError('EBADF', named);
      node = held.node; parts = (proc[2] ?? '').split('/').filter(Boolean);
    } else {
      assert.ok(path.isAbsolute(named), `fake fs requires an absolute name: ${named}`);
      node = rootNode; parts = path.normalize(named).split('/').filter(Boolean);
    }
    for (const component of parts) {
      if (node.kind !== 'directory') throw systemError('ENOTDIR', named);
      node = node.children.get(component);
      if (!node) throw systemError('ENOENT', named);
    }
    if (follow && node.kind === 'symlink') return walk(node.target, true);
    return node;
  };
  const mkdir = named => {
    let node = rootNode;
    for (const component of named.split('/').filter(Boolean)) {
      if (!node.children.has(component)) node.children.set(component, makeNode('directory'));
      node = node.children.get(component);
    }
    return node;
  };
  const put = (named, bytes, options = {}) => {
    const parent = mkdir(path.dirname(named)), node = makeNode(options.kind ?? 'file', Buffer.from(bytes));
    if (options.mode !== undefined) node.mode = options.mode;
    if (options.target !== undefined) node.target = options.target;
    parent.children.set(path.basename(named), node);
    return node;
  };
  mkdir(ROOT); mkdir('/build');
  const index = new Map();
  const addSource = (relative, bytes = `source:${relative}\n`, mode = '100644') => {
    const node = put(`${ROOT}/${relative}`, bytes, { mode: mode === '100755' ? 0o100755n : 0o100644n });
    const expected = { mode, blob: gitBlob(node.bytes) };
    index.set(relative, { ...expected });
    return [relative, { ...expected }];
  };
  const manifest = addSource('crate/Cargo.toml', '[package]\nname = "control"\n');
  const binaries = Array.from({ length: owners }, (_, ordinal) => {
    const source = addSource(`crate/src/owner-${ordinal}.rs`);
    const named = `/build/owner-${ordinal}`, node = put(named, `artifact-${ordinal}`, { mode: 0o100755n });
    return { environmentKey: `CARGO_BIN_EXE_owner_${ordinal}`, sourcePath: source[0], sourcePin: source[1],
      manifestPath: manifest[0], manifestPin: { ...manifest[1] }, path: named,
      sha256: artifactHash(node.bytes), identity: identity(metadata(node)) };
  });
  const fakeFs = {
    constants,
    realpathSync(named) {
      const node = walk(named);
      return node.kind === 'symlink' ? node.target : path.normalize(named);
    },
    lstatSync(named, options) {
      invoke('beforeLstat', named);
      metrics.stats.push(named);
      return metadata(walk(named), options?.bigint === true);
    },
    fstatSync(descriptor, options) {
      invoke('beforeFstat', descriptor);
      const held = descriptors.get(descriptor);
      if (!held) throw systemError('EBADF', String(descriptor));
      return metadata(held.node, options?.bigint === true);
    },
    openSync(named, flags) {
      invoke('beforeOpen', named);
      const node = walk(named);
      if (node.kind === 'symlink' && (flags & constants.O_NOFOLLOW)) throw systemError('ELOOP', named);
      if ((flags & constants.O_DIRECTORY) && node.kind !== 'directory') throw systemError('ENOTDIR', named);
      const descriptor = nextDescriptor++;
      descriptors.set(descriptor, { node, named, offset: 0 });
      metrics.opens.push({ descriptor, node, named, flags });
      metrics.events.push({ kind: 'open', named });
      return descriptor;
    },
    readSync(descriptor, buffer, offset, length, position) {
      invoke('beforeRead', descriptor);
      const held = descriptors.get(descriptor);
      if (!held) throw systemError('EBADF', String(descriptor));
      const from = position ?? held.offset, count = Math.min(length, Math.max(0, held.node.bytes.length - from));
      held.node.bytes.copy(buffer, offset, from, from + count);
      if (position === null) held.offset += count;
      metrics.reads.push({ node: held.node, count });
      return count;
    },
    readdirSync(named) {
      invoke('beforeReaddir', named);
      const node = walk(named);
      if (node.kind !== 'directory') throw systemError('ENOTDIR', named);
      return [...node.children.keys()];
    },
    closeSync(descriptor) {
      const held = descriptors.get(descriptor);
      assert.ok(held, `descriptor ${descriptor} must be closed exactly once`);
      metrics.closes.push(descriptor);
      descriptors.delete(descriptor);
      // Model close(2) consuming its FD but reporting an error. The caller
      // must still attempt to release every remaining descriptor and fail.
      invoke('afterClose', descriptor, held.node);
    },
  };
  const spawnSync = (program, args, options) => {
    assert.equal(program, 'git', 'only the fake canonical Git process is allowed');
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 60_000);
    assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, '1');
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(options.env.GIT_DIR, undefined, 'inherited Git steering must be removed');
    assert.equal(options.env.GIT_WORK_TREE, undefined);
    assert.deepEqual(Array.from(args.slice(0, 5)), ['--no-pager', '-c', 'core.fsmonitor=false', '-C', ROOT]);
    const command = Array.from(args.slice(5));
    const literalPaths = command[0] === '--literal-pathspecs';
    if (literalPaths) command.shift();
    let output;
    if (command[0] === 'ls-files') {
      const separator = command.indexOf('--');
      assert.ok(separator >= 0, 'selected index queries must delimit path arguments');
      const selected = command.slice(separator + 1).map(value => value.replace(/^:\((?:top,)?literal\)/u, ''));
      assert.ok(command.includes('-s') || command.includes('--stage'));
      assert.ok(selected.length > 0);
      const query = { selected, nul: command.includes('-z'), command };
      metrics.index.push(query); metrics.events.push({ kind: 'index', selected });
      invoke('beforeIndex', query, metrics.index.length);
      output = selected.flatMap(relative => index.has(relative)
        ? [`${index.get(relative).mode} ${index.get(relative).blob} 0\t${relative}`] : [])
        .join(query.nul ? '\0' : '\n');
      if (query.nul && output) output += '\0';
      output = hooks.indexOutput?.(output, query, metrics.index.length) ?? output;
      invoke('afterIndex', query, metrics.index.length);
    } else if (command[0] === 'hash-object') {
      assert.equal(command[1], '--no-filters');
      invoke('beforeHash', metrics.hashes.length + 1);
      if (command[2] === '--stdin-paths') {
        assert.equal(command.length, 3);
        assert.equal(typeof options.input, 'string');
        assert.ok(options.input.endsWith('\n'));
        const childPaths = options.input.slice(0, -1).split('\n');
        assert.ok(childPaths.length <= 128, 'a canonical held-FD hash batch is bounded at 128');
        assert.deepEqual(Array.from(options.stdio.slice(0, 3)), ['pipe', 'pipe', 'pipe']);
        assert.equal(options.stdio.length, childPaths.length + 3);
        const held = childPaths.map((childPath, ordinal) => {
          assert.equal(childPath, `/proc/self/fd/${ordinal + 3}`);
          const entry = descriptors.get(options.stdio[ordinal + 3]);
          assert.ok(entry, 'Git can only hash an explicitly inherited open descriptor');
          assert.equal(entry.node.kind, 'file');
          assert.ok((metrics.opens.find(item => item.descriptor === options.stdio[ordinal + 3]).flags
            & constants.O_NOFOLLOW) !== 0);
          return entry;
        });
        metrics.hashes.push({ batch: true, nodes: held.map(entry => entry.node),
          bytes: held.map(entry => Buffer.from(entry.node.bytes)) });
        output = held.map(entry => gitBlob(entry.node.bytes)).join('\n');
      } else {
        assert.equal(command[2], '--stdin');
        assert.ok(Buffer.isBuffer(options.input));
        metrics.hashes.push({ batch: false, bytes: [Buffer.from(options.input)] });
        output = gitBlob(options.input);
      }
      metrics.events.push({ kind: 'hash' });
      output = hooks.hashOutput?.(output, metrics.hashes.length) ?? output;
      invoke('afterHash', metrics.hashes.length);
    } else {
      assert.fail(`unexpected actual Git operation: ${command.join(' ')}`);
    }
    return hooks.processResult?.(command, output) ?? { status: 0, stdout: output, stderr: '' };
  };
  const artifactPin = (named, root) => {
    assert.equal(root, ROOT);
    metrics.rehashes.push(named);
    const node = walk(named);
    return { path: named, sha256: artifactHash(node.bytes), identity: identity(metadata(node)) };
  };
  const context = vm.createContext({ fs: fakeFs, path, Buffer, spawnSync, artifactPin,
    process: { env: { GIT_DIR: '/hostile', GIT_WORK_TREE: '/hostile', PATH: '/fake' } } });
  const strippedGit = gitSource.replace(/^import[^\n]*\n/gmu, '').replace(/^export /gmu, '');
  const artifactIdentity = cargoSource.match(/^const artifactIdentity =[^;]+;/mu)?.[0];
  assert.ok(artifactIdentity, 'extract the actual nine-field Cargo identity projection');
  const cargoAssertion = historical ? historicalCargoAssertion
    : extractFunction(cargoSource, 'assertCargoBinaryArtifactsCurrent');
  new vm.Script(`${strippedGit}\n${artifactIdentity}\n${cargoAssertion}\n`
    + 'globalThis.control = { assertCargoBinaryArtifactsCurrent, readPinnedSource, '
    + 'assertPinnedSourcesCurrent: typeof assertPinnedSourcesCurrent === "function" ? assertPinnedSourcesCurrent : undefined };',
  { filename: 'extracted-owner-source-control.mjs' }).runInContext(context);
  const selected = () => binaries.flatMap(pin => [[pin.sourcePath, pin.sourcePin], [pin.manifestPath, pin.manifestPin]]);
  return { hooks, metrics, descriptors, index, binaries, manifest, selected, addSource, put, walk, mkdir,
    check: rehash => context.control.assertCargoBinaryArtifactsCurrent(ROOT, binaries, rehash),
    bulk: entries => {
      assert.equal(typeof context.control.assertPinnedSourcesCurrent, 'function', 'the production bulk assertion must exist');
      return context.control.assertPinnedSourcesCurrent(ROOT, entries);
    },
    assertClosed() {
      assert.equal(descriptors.size, 0, 'every held file and directory descriptor must be released');
      assert.equal(metrics.closes.length, metrics.opens.length, 'every successful open has one close attempt');
    } };
}

function expectFailure(state, action = () => state.check(), pattern = /./u) {
  assert.throws(action, pattern);
  state.assertClosed();
}

function assertOneObservation(state, uniqueCount) {
  const hashes = state.metrics.hashes;
  assert.ok(hashes.every(entry => entry.batch), 'owners must use actual held-FD batches');
  assert.equal(hashes.flatMap(entry => entry.nodes).length, uniqueCount, 'each selected source is read once per invocation');
  assert.equal(new Set(hashes.flatMap(entry => entry.nodes)).size, uniqueCount, 'shared manifests must not be reopened');
  assert.ok(state.metrics.index.every(entry => entry.nul), 'index paths must have NUL-delimited records');
  state.assertClosed();
}

test('the actual historical owner loop is a red control for repeated manifest and Git work', t => {
  const state = harness({ historical: true });
  state.check();
  assert.equal(state.metrics.hashes.length, 6);
  assert.equal(state.metrics.index.length, 6);
  assert.equal(state.metrics.index.filter(query => query.selected.includes('crate/Cargo.toml')).length, 3);
  const manifestNode = state.walk(`${ROOT}/crate/Cargo.toml`);
  assert.equal(state.metrics.opens.filter(entry => entry.node === manifestNode).length, 3);
  assert.throws(() => assertOneObservation(state, 4), /held-FD batches/u);
  state.assertClosed();
  t.diagnostic('Historical actual loop: 3 owners -> 6 hash processes + 6 index processes, manifest opened 3 times; new budget fails as expected.');
});

test('actual owner assertion deduplicates only its complete source and manifest set', () => {
  const state = harness();
  state.check();
  assertOneObservation(state, 4);
  assert.equal(state.metrics.hashes.length, 1);
  assert.equal(state.metrics.index.length, 2, 'read the current selected index before and after bytes');
  const expected = [...new Set(state.selected().map(entry => entry[0]))].sort();
  for (const query of state.metrics.index) assert.deepEqual([...query.selected].sort(), expected);
  assert.deepEqual(state.metrics.events.filter(entry => ['index', 'hash'].includes(entry.kind)).map(entry => entry.kind),
    ['index', 'hash', 'index']);
  for (const pin of state.binaries) assert.ok(state.metrics.stats.includes(pin.path), 'each artifact retains its identity check');
  assert.equal(state.metrics.rehashes.length, 0, 'intermediate owners retain the optional rehash behavior');
});

test('before/after owners and repeated invocations always read fresh bytes and current index', () => {
  const state = harness();
  state.check(); state.check();
  assert.equal(state.metrics.hashes.length, 2);
  assert.equal(state.metrics.index.length, 4);
  const node = state.walk(`${ROOT}/${state.binaries[0].sourcePath}`), original = node.bytes;
  // Change only bytes: metadata equality or a cached prior success cannot help.
  node.bytes = Buffer.from(original.toString().replace('source:', 'mutate:'));
  expectFailure(state, () => state.check(), /source_worktree_blob_mismatch/u);
  node.bytes = original;
  state.check();
  assert.equal(state.metrics.hashes.length, 4, 'restoring bytes succeeds only after another fresh observation');
  const oldPin = state.index.get(state.manifest[0]);
  state.index.set(state.manifest[0], { ...oldPin, blob: 'f'.repeat(40) });
  const before = state.metrics.hashes.length;
  expectFailure(state);
  assert.equal(state.metrics.hashes.length, before, 'wrong current index is rejected before source hashes');
  state.index.set(state.manifest[0], oldPin);
  state.check();
  assert.equal(state.metrics.hashes.length, before + 1);
  state.assertClosed();
});

test('a caller digest cannot replace an independently observed current index pin', () => {
  const state = harness();
  const node = state.walk(`${ROOT}/${state.binaries[0].sourcePath}`);
  node.bytes = Buffer.from('caller-selected replacement bytes');
  state.binaries[0].sourcePin = { mode: '100644', blob: gitBlob(node.bytes) };
  expectFailure(state);
  assert.equal(state.metrics.hashes.length, 0);
});

test('same-path identical pins deduplicate but conflicting blob or mode pins fail closed', () => {
  for (const conflict of [{ blob: 'e'.repeat(40) }, { mode: '100755' }]) {
    const state = harness();
    const entry = state.manifest;
    expectFailure(state, () => state.bulk([entry, [entry[0], { ...entry[1], ...conflict }]]));
    assert.equal(state.metrics.hashes.length, 0);
  }
  const state = harness();
  state.bulk([state.manifest, [state.manifest[0], { ...state.manifest[1] }]]);
  assertOneObservation(state, 1);
});

test('index changes during hashing and source changes after the final index read are rejected', () => {
  const indexRace = harness();
  indexRace.hooks.afterHash = () => indexRace.index.get(indexRace.manifest[0]).blob = 'a'.repeat(40);
  expectFailure(indexRace);
  assert.equal(indexRace.metrics.index.length, 2);
  const sourceRace = harness();
  sourceRace.hooks.afterIndex = (_query, count) => {
    if (count === 2) sourceRace.walk(`${ROOT}/${sourceRace.manifest[0]}`).ctimeNs++;
  };
  expectFailure(sourceRace, () => sourceRace.check(), /source_subject_changed/u);
});

test('symlinks, file identity replacement, executable mode and size changes fail closed', async t => {
  const cases = [
    ['leaf symlink', state => {
      state.put(`${ROOT}/${state.manifest[0]}`, '', { kind: 'symlink', target: '/outside/manifest' });
    }],
    ['parent symlink', state => {
      state.put(`${ROOT}/crate/src`, '', { kind: 'symlink', target: '/outside/sources' });
    }],
    ['wrong executable mode', state => { state.walk(`${ROOT}/${state.manifest[0]}`).mode |= 0o111n; }],
    ['oversized source', state => { state.walk(`${ROOT}/${state.manifest[0]}`).size = 16n * 1024n * 1024n + 1n; }],
    ['same bytes at a replacement inode', state => {
      state.hooks.afterHash = () => state.put(`${ROOT}/${state.manifest[0]}`, state.walk(`${ROOT}/${state.manifest[0]}`).bytes);
    }],
    ['source grows during hash', state => {
      state.hooks.afterHash = () => { state.walk(`${ROOT}/${state.manifest[0]}`).size++; };
    }],
    ['held source mode changes', state => {
      state.hooks.afterHash = () => { state.walk(`${ROOT}/${state.manifest[0]}`).mode |= 0o111n; };
    }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const state = harness(); mutate(state); expectFailure(state);
  });
});

test('held parent identity and directory namespace remain part of source authority', async t => {
  for (const [name, mutate] of [
    ['parent inode', state => { state.walk(`${ROOT}/crate`).ino++; }],
    ['namespace without metadata change', state => { state.put(`${ROOT}/crate/new-entry`, 'new'); }],
    ['removed namespace entry', state => { state.walk(`${ROOT}/crate`).children.delete('src'); }],
  ]) await t.test(name, () => {
    const state = harness(); state.hooks.afterHash = () => mutate(state); expectFailure(state);
  });
  const late = harness();
  late.hooks.afterIndex = (_query, count) => { if (count === 2) late.put(`${ROOT}/crate/late-entry`, 'late'); };
  expectFailure(late, () => late.check(), /source_subject_changed/u);
});

test('malformed or incomplete canonical hash output fails closed', async t => {
  for (const [name, transform] of [
    ['empty', () => ''], ['missing hash', output => output.split('\n').slice(1).join('\n')],
    ['extra hash', output => `${output}\n${'a'.repeat(40)}`],
    ['noncanonical hex', output => output.replace(/[a-f]/u, 'Z')],
    ['reordered hashes', output => output.split('\n').reverse().join('\n')],
  ]) await t.test(name, () => {
    const state = harness(); state.hooks.hashOutput = transform;
    expectFailure(state, () => state.check(), /source_batch_git_output_invalid|source_worktree_blob_mismatch/u);
  });
});

test('malformed, missing, duplicate or unrequested current index records fail closed', async t => {
  const transforms = [
    ['missing NUL', output => output.slice(0, -1)],
    ['missing selected path', output => output.split('\0').slice(1).join('\0')],
    ['duplicate path', output => `${output}${output.split('\0')[0]}\0`],
    ['unrequested path', output => `${output}100644 ${'a'.repeat(40)} 0\telsewhere.rs\0`],
    ['conflict stage', output => output.replace(' 0\t', ' 1\t')],
    ['symlink index mode', output => output.replace('100644 ', '120000 ')],
    ['malformed object ID', output => output.replace(/[a-f0-9]{40}/u, 'z'.repeat(40))],
    ['empty index', () => ''],
  ];
  for (const [name, transform] of transforms) for (const phase of [1, 2]) await t.test(`${name}, read ${phase}`, () => {
    const state = harness();
    state.hooks.indexOutput = (output, _query, count) => count === phase ? transform(output) : output;
    expectFailure(state);
    assert.equal(state.metrics.hashes.length, phase - 1, 'no later hash is allowed after index rejection');
  });
});

test('read, stat, process and close errors fail closed while attempting every FD release', async t => {
  const cases = [
    ['directory read failure', state => {
      state.hooks.beforeReaddir = () => { throw systemError('EIO', 'directory read'); };
    }],
    ['held file stat failure', state => {
      state.hooks.beforeFstat = descriptor => {
        if (state.descriptors.get(descriptor)?.node.kind === 'file') throw systemError('EIO', 'file stat');
      };
    }],
    ['canonical Git cannot read inherited source', state => {
      state.hooks.processResult = command => command[0] === 'hash-object'
        ? { status: 128, stdout: '', stderr: 'injected source read failure' } : undefined;
    }],
    ['canonical Git spawn error', state => {
      state.hooks.processResult = command => command[0] === 'hash-object'
        ? { status: null, stdout: '', stderr: '', error: systemError('EIO', 'spawn') } : undefined;
    }],
    ['first file close reports error', state => {
      let failed = false;
      state.hooks.afterClose = (_descriptor, node) => {
        if (!failed && node.kind === 'file') { failed = true; throw systemError('EIO', 'file close'); }
      };
    }],
    ['first parent close reports error', state => {
      let failed = false;
      state.hooks.afterClose = (_descriptor, node) => {
        if (!failed && node.kind === 'directory') { failed = true; throw systemError('EIO', 'parent close'); }
      };
    }],
  ];
  for (const [name, configure] of cases) await t.test(name, () => {
    const state = harness(); configure(state); expectFailure(state);
  });
});

test('129 unique selected paths cross the 128-file boundary with complete postchecks', () => {
  const state = harness({ owners: 0 });
  const entries = Array.from({ length: 129 }, (_, ordinal) => state.addSource(`batch/item-${ordinal}.rs`));
  state.bulk([...entries, entries[0], entries[128]]);
  assertOneObservation(state, 129);
  assert.deepEqual(state.metrics.hashes.map(entry => entry.nodes.length), [128, 1]);
  assert.ok(state.metrics.index.every(query => query.selected.length <= 128));
  assert.equal(state.metrics.index.flatMap(query => query.selected).length, 258);
  const late = harness({ owners: 0 });
  const lateEntries = Array.from({ length: 129 }, (_, ordinal) => late.addSource(`batch/item-${ordinal}.rs`));
  late.hooks.afterHash = count => {
    if (count === 2) late.walk(`${ROOT}/${lateEntries[0][0]}`).ctimeNs++;
  };
  expectFailure(late, () => late.bulk(lateEntries), /source_subject_changed/u);
});

test('a final target union larger than 256 sources remains fully checked in fixed batches', () => {
  const state = harness({ owners: 0 });
  const entries = Array.from({ length: 257 }, (_, ordinal) => state.addSource(`batch/item-${ordinal}.rs`));
  state.bulk(entries);
  assertOneObservation(state, 257);
  assert.deepEqual(state.metrics.hashes.map(entry => entry.nodes.length), [128, 128, 1]);
  assert.ok(state.metrics.index.every(query => query.selected.length <= 128));
  assert.equal(state.metrics.index.flatMap(query => query.selected).length, 514);
});

test('targets without binary sources keep the original empty observation behavior', () => {
  const state = harness({ owners: 0 });
  state.check();
  assert.equal(state.metrics.index.length, 0);
  assert.equal(state.metrics.hashes.length, 0);
  assert.equal(state.metrics.opens.length, 0);
  state.assertClosed();
});

test('every artifact keeps all nine identity fields, including the last owner', async t => {
  for (const ordinal of [0, 1, 2]) for (const field of identityFields) await t.test(`owner ${ordinal}, ${field}`, () => {
    const state = harness(); state.walk(state.binaries[ordinal].path)[field]++;
    expectFailure(state, () => state.check(), /verification_binary_changed/u);
  });
  const state = harness();
  state.put(state.binaries.at(-1).path, '', { kind: 'symlink', target: '/outside/binary' });
  expectFailure(state, () => state.check(), /verification_binary_changed/u);
});

test('final rehash remains optional and checks every artifact against its original pin', async t => {
  const stable = harness(); stable.check(true);
  assert.deepEqual(stable.metrics.rehashes, stable.binaries.map(pin => pin.path));
  stable.assertClosed();
  for (const ordinal of [0, 1, 2]) await t.test(`changed bytes, owner ${ordinal}`, () => {
    const state = harness(), node = state.walk(state.binaries[ordinal].path);
    node.bytes = Buffer.from('artifact-X');
    // The artifact rehash dependency is a spy. This proves the actual owner
    // still invokes and compares it, without claiming ELF parser coverage.
    state.check(false);
    assert.equal(state.metrics.rehashes.length, 0);
    expectFailure(state, () => state.check(true), /verification_binary_changed/u);
    assert.ok(state.metrics.rehashes.includes(state.binaries[ordinal].path));
  });
});
