// Cooperative current-input observation for ONE consumer's own independent replay.
// This module owns no receipt acceptance, cache insertion or runtime authority.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { artifactPin } from '../../paper-core/src/source-evidence-cargo-observations.mjs';
import { git } from '../../paper-core/src/source-evidence-git-inputs.mjs';
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const identity = value => fields.map(key => String(value[key]));
const coreIdentity = value => ['dev', 'ino', 'uid', 'gid', 'mode'].map(key => String(value[key]));
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = () => { throw new Error('route_acceptance_own_replay_current_inputs_changed'); };
function pinFile(file, limit = 16 * 1024 * 1024, retainBytes = false) {
  if (path.resolve(file) !== file || fs.realpathSync(file) !== file) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) fail();
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536), chunks = []; let count = 0;
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, count);
      if (read === 0) break;
      count += read; if (count > Number(before.size) || count > limit) fail();
      hash.update(buffer.subarray(0, read));
      if (retainBytes) chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    if (count !== Number(before.size) || !named.isFile()
      || JSON.stringify(identity(before)) !== JSON.stringify(identity(after))
      || JSON.stringify(identity(before)) !== JSON.stringify(identity(named))) fail();
    return { path: file, sha256: `sha256:${hash.digest('hex')}`, identity: identity(before),
      ...(retainBytes ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally { fs.closeSync(fd); }
}
function sourceNamespace(root, budget, codeRoot = false) {
  const entries = [];
  function visit(directory) {
    const before = fs.lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || fs.realpathSync(directory) !== directory) fail();
    if (++budget.entries > 32768) fail();
    entries.push({ path: path.relative(root, directory), directory: identity(before) });
    for (const name of fs.readdirSync(directory).sort()) {
      if (codeRoot && directory === root && ['.git', 'node_modules'].includes(name)) continue;
      const named = path.join(directory, name), value = fs.lstatSync(named, { bigint: true });
      if (value.isDirectory()) visit(named);
      else if (value.isFile()) {
        if (++budget.entries > 32768) fail();
        budget.bytes += Number(value.size); if (budget.bytes > 1024 * 1024 * 1024) fail();
        entries.push({ path: path.relative(root, named), file: pinFile(named) });
      } else fail();
    }
    if (JSON.stringify(identity(before)) !== JSON.stringify(identity(fs.lstatSync(directory, { bigint: true })))) fail();
  }
  visit(root); return entries;
}
function boundedDirectoryNamespace(descriptor, budget) {
  const directory = fs.opendirSync(`/proc/self/fd/${descriptor}`), names = [];
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (names.length >= 16384 || ++budget.names > 65536) fail();
      budget.bytes += Buffer.byteLength(entry.name, 'utf8');
      if (budget.bytes > 16 * 1024 * 1024) fail();
      names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  names.sort();
  // Actual complete namespace is observed, but repeated candidate parents do
  // not copy all names into the retained comparison object. No caller digest
  // supplies this value; every invocation enumerates its actual held parent.
  return { namesCount: names.length, namesSha256: digest(JSON.stringify(names)) };
}
function observeCandidatePath(file, budget, accessError = null, selectedTool = false) {
  if (path.resolve(file) !== file || file.length > 4096 || ++budget.paths > 1024) fail();
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  const held = [], links = [], leaves = [], began = process.hrtime.bigint();
  const check = () => { if (process.hrtime.bigint() - began >= 30_000_000_000n) fail(); };
  const pin = (named, descriptor) => {
    try {
      const metadata = fs.fstatSync(descriptor, { bigint: true }), current = fs.lstatSync(named, { bigint: true });
      if (!metadata.isDirectory() || !current.isDirectory()
        || JSON.stringify(coreIdentity(metadata)) !== JSON.stringify(coreIdentity(current))) fail();
      const entry = { named, descriptor, metadata }; held.push(entry); return entry;
    } catch (error) { fs.closeSync(descriptor); throw error; }
  };
  const absent = (parent, component) => {
    try { fs.lstatSync(`/proc/self/fd/${parent.descriptor}/${component}`); fail(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  const assertCurrent = parent => {
    for (const entry of held) {
      check();
      const current = fs.lstatSync(entry.named, { bigint: true }), descriptor = fs.fstatSync(entry.descriptor, { bigint: true });
      const observe = entry === parent ? identity : coreIdentity;
      if (!current.isDirectory() || !descriptor.isDirectory()
        || JSON.stringify(observe(entry.metadata)) !== JSON.stringify(observe(current))
        || JSON.stringify(observe(entry.metadata)) !== JSON.stringify(observe(descriptor))) fail();
    }
    for (const entry of links) {
      const selected = `/proc/self/fd/${entry.parent.descriptor}/${entry.component}`;
      const current = fs.lstatSync(selected, { bigint: true });
      if (!current.isSymbolicLink() || JSON.stringify(identity(current)) !== JSON.stringify(entry.metadata)
        || fs.readlinkSync(selected) !== entry.target) fail();
    }
    for (const entry of leaves) {
      const current = fs.lstatSync(`/proc/self/fd/${entry.parent.descriptor}/${entry.component}`, { bigint: true });
      if (JSON.stringify(identity(current)) !== JSON.stringify(entry.metadata)) fail();
      if (entry.descriptor !== null && JSON.stringify(identity(fs.fstatSync(entry.descriptor, { bigint: true }))) !== JSON.stringify(entry.metadata)) fail();
    }
  };
  const finish = (parent, component, rest, state, missing) => {
    const namespace = boundedDirectoryNamespace(parent.descriptor, budget);
    if (missing) absent(parent, component);
    assertCurrent(parent);
    // Verify the original PATH access result independently of metadata shape.
    // Cargo/default DB paths require ENOENT; selected tools require X_OK,
    // including held ancestor aliases. Skipped tools keep the original
    // ENOENT/EACCES/ENOTDIR selection semantics, including actual symlinks.
    if (selectedTool) fs.accessSync(file, fs.constants.X_OK);
    else if (accessError) {
      try { fs.accessSync(file, fs.constants.X_OK); fail(); }
      catch (error) { if (error.code !== accessError) throw error; }
    } else {
      try { fs.lstatSync(file); fail(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (missing) absent(parent, component); assertCurrent(parent); check();
    return { path: file, state, accessError, missingPath: missing ? path.join(parent.named, component) : null,
      remaining: rest, ancestors: held.map(entry => ({ path: entry.named, identity: coreIdentity(entry.metadata) })),
      links: links.map(({ parent: owner, component: leaf, metadata, target }) => ({ path: path.join(owner.named, leaf), identity: metadata, target })),
      leaves: leaves.map(({ parent: owner, component: leaf, metadata }) => ({ path: path.join(owner.named, leaf), identity: metadata })),
      parent: { path: parent.named, identity: identity(parent.metadata), ...namespace } };
  };
  try {
    let requested = file;
    for (let hops = 0; hops <= 40; hops++) {
      const parts = requested.slice(path.parse(requested).root.length).split(path.sep);
      if (requested.length > 4096 || parts.length > 256) fail();
      let named = path.parse(requested).root, parent = pin(named, fs.openSync(named, flags)), restart = false;
      for (const [index, component] of parts.entries()) {
        check();
        const selected = `/proc/self/fd/${parent.descriptor}/${component}`;
        let metadata;
        try { metadata = fs.lstatSync(selected, { bigint: true }); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          return finish(parent, component, parts.slice(index + 1), 'absent', true);
        }
        if (metadata.isSymbolicLink()) {
          if ((!accessError && !selectedTool) || hops === 40) fail();
          const target = fs.readlinkSync(selected);
          links.push({ parent, component, metadata: identity(metadata), target });
          requested = path.resolve(parent.named, target, ...parts.slice(index + 1)); restart = true; break;
        }
        if (metadata.isDirectory() && index !== parts.length - 1) {
          named = path.join(named, component); parent = pin(named, fs.openSync(selected, flags)); continue;
        }
        if (selectedTool) { if (index !== parts.length - 1 || !metadata.isFile()) fail(); }
        else if (!accessError || !['EACCES', 'ENOTDIR'].includes(accessError)) fail();
        let descriptor = null;
        try { descriptor = fs.openSync(selected, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
        catch (error) { if (error.code !== 'EACCES') throw error; }
        leaves.push({ parent, component, metadata: identity(metadata), descriptor });
        return finish(parent, component, parts.slice(index + 1), selectedTool ? 'selected' : 'ineligible', false);
      }
      if (!restart) fail();
    }
    fail();
  } finally {
    for (const entry of leaves) if (entry.descriptor !== null) fs.closeSync(entry.descriptor);
    for (const entry of held.reverse()) fs.closeSync(entry.descriptor);
  }
}
function defaultStoreAbsence(root, budget) {
  const file = path.join(path.dirname(root), 'hepta-paper-runtime/native-runtime/hepta-paper.sqlite');
  return { file, ...observeCandidatePath(file, budget) };
}
function dependencyInputs(budget, absenceBudget) {
  const lock = pinFile(path.join(MODULE_ROOT, 'package-lock.json'), 1024 * 1024, true);
  const { bytes: lockBytes, ...lockPin } = lock;
  const packages = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lockBytes)).packages;
  const candidateRoot = path.join(MODULE_ROOT, 'node_modules');
  let requestedRoot = candidateRoot, candidateRootAbsence = null, parentPackageInputs = null;
  try { fs.lstatSync(candidateRoot, { bigint: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // The ordinary source verifier deliberately installs the exact npm lock in
    // an exclusive parent. Admit only that one ancestor, with the same raw
    // manifest and lock; all actually loaded packages still bind below it.
    candidateRootAbsence = observeCandidatePath(candidateRoot, absenceBudget);
    const parent = path.dirname(MODULE_ROOT);
    if (fs.realpathSync(parent) !== parent) fail();
    requestedRoot = path.join(parent, 'node_modules');
    const manifest = pinFile(path.join(MODULE_ROOT, 'package.json'), 1024 * 1024, true);
    const parentManifest = pinFile(path.join(parent, 'package.json'), 1024 * 1024, true);
    const parentLock = pinFile(path.join(parent, 'package-lock.json'), 1024 * 1024, true);
    if (!manifest.bytes.equals(parentManifest.bytes) || !lockBytes.equals(parentLock.bytes)
      || JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes)).packageManager !== 'npm@10.9.8'
      || JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lockBytes)).lockfileVersion !== 3) fail();
    const withoutBytes = ({ bytes: _bytes, ...value }) => value;
    parentPackageInputs = { manifest: withoutBytes(manifest), parentManifest: withoutBytes(parentManifest), parentLock: withoutBytes(parentLock) };
  }
  const namedBefore = fs.lstatSync(requestedRoot, { bigint: true }), actualRoot = fs.realpathSync(requestedRoot);
  if (!namedBefore.isDirectory() && !namedBefore.isSymbolicLink()) fail();
  if (parentPackageInputs && (namedBefore.isSymbolicLink() || actualRoot !== requestedRoot)) fail();
  const directoryBefore = fs.lstatSync(actualRoot, { bigint: true });
  if (!directoryBefore.isDirectory()) fail();
  const closure = [];
  // Same fixed lock-bound package closure used by the normal frontend fixture.
  // Top-level npm CLI aliases are outside the actual parser/module inputs.
  for (const name of ['espree', 'eslint-scope', 'acorn', 'acorn-jsx', 'eslint-visitor-keys', 'esrecurse', 'estraverse']) {
    const invocation = require.resolve(name), resolved = fs.realpathSync(invocation);
    let directory = path.dirname(resolved), manifest;
    while (true) {
      try {
        manifest = pinFile(path.join(directory, 'package.json'), 65536, true);
        if (JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes)).name === name) break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(directory); if (parent === directory) fail(); directory = parent;
    }
    const { bytes, ...manifestPin } = manifest;
    const version = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).version;
    if (directory !== path.join(actualRoot, name) || !packages?.[`node_modules/${name}`]
      || packages[`node_modules/${name}`].version !== version) fail();
    closure.push({ name, version, invocation, resolved, manifest: manifestPin, namespace: sourceNamespace(directory, budget) });
  }
  const topNames = fs.readdirSync(actualRoot).sort();
  if (topNames.length > 4096 || JSON.stringify(identity(namedBefore)) !== JSON.stringify(identity(fs.lstatSync(requestedRoot, { bigint: true })))
    || JSON.stringify(identity(directoryBefore)) !== JSON.stringify(identity(fs.lstatSync(actualRoot, { bigint: true })))) fail();
  return { moduleRoot: MODULE_ROOT, lock: lockPin, requestedRoot, actualRoot, topNames, candidateRootAbsence, parentPackageInputs,
    requestedRootIdentity: identity(namedBefore), actualRootIdentity: identity(directoryBefore),
    requestedRootLink: namedBefore.isSymbolicLink() ? fs.readlinkSync(requestedRoot) : null, closure };
}
function selectedTool(name, environment, budget) {
  const directories = (environment.PATH || '').split(path.delimiter);
  if (directories.length > 128 || directories.some(directory => !path.isAbsolute(directory))) fail();
  const search = [];
  for (const directory of directories) {
    const invocation = path.join(directory, name);
    try { fs.accessSync(invocation, fs.constants.X_OK); }
    catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
      search.push(observeCandidatePath(invocation, budget, error.code)); continue;
    }
    return { invocation, search, selection: observeCandidatePath(invocation, budget, null, true),
      invocationIdentity: identity(fs.lstatSync(invocation, { bigint: true })),
      actual: artifactPin(fs.realpathSync(invocation), environment.root) };
  }
  fail();
}
function configurationCandidates(root, environment, budget) {
  const files = [];
  const home = environment.CARGO_HOME || path.join(environment.HOME || '', '.cargo');
  if (!path.isAbsolute(home)) fail();
  const directories = new Set([home]);
  let current = path.join(root, 'rust');
  while (true) { directories.add(path.join(current, '.cargo')); const parent = path.dirname(current); if (parent === current) break; current = parent; }
  for (const directory of directories) for (const name of ['config', 'config.toml']) {
    const file = path.join(directory, name);
    try { files.push(pinFile(file, 1024 * 1024)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files.push({ absent: true, ...observeCandidatePath(file, budget) }); }
  }
  return files;
}
function nativeContext(root, runtime, buildContext, environment) {
  if (!buildContext || buildContext.root !== root || !path.isAbsolute(buildContext.target)
    || fs.realpathSync(buildContext.target) !== buildContext.target) fail();
  const target = fs.lstatSync(buildContext.target, { bigint: true });
  if (!target.isDirectory()) fail();
  const binaries = Object.entries(runtime.owners).sort(([a], [b]) => a.localeCompare(b)).map(([name, owner]) => {
    const expected = path.join(buildContext.target, 'debug', name);
    if (owner.path !== expected) fail();
    const actual = artifactPin(expected, root);
    if (owner.sha256 !== actual.sha256) fail();
    const metadata = buildContext.artifacts[name];
    if (!metadata || metadata.manifestPath !== path.join(root, 'rust/crates/hepta-paper-service/Cargo.toml')
      || metadata.sourcePath !== path.join(root, 'rust/crates/hepta-paper-service/src/bin', `${name}.rs`)
      || JSON.stringify(metadata.targetKind) !== '["bin"]' || metadata.profile.test !== false) fail();
    return { name, actual, metadata };
  });
  // Cargo's artifact source path alone does not prove the ELF's compile-time
  // workspace. Observe the actual ordinary default; cached output from another
  // source copy is refused even when its Git tree and executable bytes agree.
  const output = spawnSync(runtime.owners['hepta-paper-rust'].path, ['operator', 'workspace'],
    { cwd: root, env: environment, encoding: 'utf8', shell: false, timeout: 30000, maxBuffer: 1024 * 1024 });
  if (output.error || output.signal || ![0, 1].includes(output.status)) fail();
  const report = JSON.parse(output.stdout);
  if (report.workspaceRoot !== root || report.workspaceRealPath !== root || report.realPaths?.workspaceRoot !== root) {
    throw new Error('route_acceptance_native_compiled_workspace_context_differs');
  }
  return { target: buildContext.target, targetIdentity: coreIdentity(target), binaries,
    actualDefaultWorkspace: { workspaceRoot: report.workspaceRoot, workspaceRealPath: report.workspaceRealPath,
      workspaceRealRoot: report.realPaths.workspaceRoot } };
}
function optionalGitFile(file, budget, limit = 1024 * 1024) {
  try { return pinFile(file, limit); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { absent: true, ...observeCandidatePath(file, budget) }; }
}
function gitPhysicalInputs(root, directory, budget) {
  const common = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  if (fs.realpathSync(directory) !== directory || fs.realpathSync(common) !== common) fail();
  const named = fs.lstatSync(path.join(root, '.git'), { bigint: true });
  const reference = git(root, ['rev-parse', '--symbolic-full-name', 'HEAD']);
  if (reference && reference !== 'HEAD' && (!reference.startsWith('refs/') || reference.includes('\\')
    || reference.length > 4096 || reference.split('/').some(part => !part || part === '.' || part === '..'))) fail();
  return { directory, common, directoryIdentity: coreIdentity(fs.lstatSync(directory, { bigint: true })),
    commonIdentity: coreIdentity(fs.lstatSync(common, { bigint: true })),
    worktreeEntry: named.isFile() ? pinFile(path.join(root, '.git'), 65536) : coreIdentity(named),
    head: pinFile(path.join(directory, 'HEAD'), 65536),
    configuration: [optionalGitFile(path.join(common, 'config'), budget), optionalGitFile(path.join(directory, 'config.worktree'), budget)],
    exclude: optionalGitFile(path.join(common, 'info/exclude'), budget),
    reference: reference && reference !== 'HEAD' ? optionalGitFile(path.join(common, reference), budget, 65536) : null,
    packedRefs: optionalGitFile(path.join(common, 'packed-refs'), budget, 16 * 1024 * 1024) };
}
export function captureOwnRouteReplayGuardV1(root, environment, runtime, buildContext, additionalGraphSubjects = []) {
  if (path.resolve(root) !== root || fs.realpathSync(root) !== root) fail();
  const gitDirectory = git(root, ['rev-parse', '--absolute-git-dir']);
  const index = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']));
  const selectedHead = git(root, ['rev-parse', 'HEAD']);
  if (!Array.isArray(additionalGraphSubjects) || additionalGraphSubjects.length > 4
    || additionalGraphSubjects.some(value => typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value))) fail();
  // Each invocation still executes strict Git graph verification. Additional
  // subjects come from the current source locator owner, never a saved verdict.
  git(root, ['fsck', '--strict', '--no-reflogs', '--no-dangling',
    ...new Set([selectedHead, ...additionalGraphSubjects])]);
  const rootMetadata = fs.lstatSync(root, { bigint: true });
  if (!rootMetadata.isDirectory()) fail();
  const budget = { entries: 0, bytes: 0 }, absenceBudget = { paths: 0, names: 0, bytes: 0 };
  const context = { root, physicalRootIdentity: coreIdentity(rootMetadata),
    subject: git(root, ['rev-parse', 'HEAD', 'HEAD^{tree}']),
    graphSubjects: [...new Set([selectedHead, ...additionalGraphSubjects])],
    gitStatus: git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    index: pinFile(index, 16 * 1024 * 1024), gitPhysical: gitPhysicalInputs(root, gitDirectory, absenceBudget),
    indexStage: digest(git(root, ['ls-files', '--stage', '-z'])),
    namespace: sourceNamespace(root, budget, true), dependencies: dependencyInputs(budget, absenceBudget), configurations: configurationCandidates(root, environment, absenceBudget),
    defaultStoreAbsence: defaultStoreAbsence(root, absenceBudget),
    selectedEnvironment: { ...environment },
    // The existing Git owner uses non-GIT ambient keys. Hash them without
    // returning secret values; a changed ambient input cannot silently reuse.
    gitAmbientEnvironmentSha256: digest(JSON.stringify(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')).sort())),
    tools: ['cargo', 'rustc', 'git', 'python3'].map(name => ({ name, ...selectedTool(name, { ...environment, root }, absenceBudget) })),
    node: artifactPin(fs.realpathSync(process.execPath), root),
    native: runtime ? nativeContext(root, runtime, buildContext, environment) : null };
  if (JSON.stringify(coreIdentity(rootMetadata)) !== JSON.stringify(coreIdentity(fs.lstatSync(root, { bigint: true })))) fail();
  return context;
}
export function assertOwnRouteReplayGuardV1(expected, root, environment, runtime, buildContext, additionalGraphSubjects = []) {
  const current = captureOwnRouteReplayGuardV1(root, environment, runtime, buildContext, additionalGraphSubjects);
  if (JSON.stringify(current) !== JSON.stringify(expected)) fail();
  return current;
}
