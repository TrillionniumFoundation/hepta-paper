import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildSqliteLogicalIntegrityReport,
  createReadOnlyPaperStore,
} from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';
import {
  immutableArchiveDirectoryChainUnchanged,
  snapshotImmutableArchiveDirectoryChain,
} from './release-evidence-filesystem-identity.mjs';

const { isPlainObject } = releaseIntegrityEvidence;

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export function captureReleaseEvidenceRegularFile(file, {
  required = false,
  maximumBytes = null,
  fileSystem = fs,
  afterOpen = () => {},
} = {}) {
  const absolute = path.resolve(file);
  let initialPath;
  try { initialPath = fileSystem.lstatSync(absolute); } catch (error) {
    if (!required && error?.code === 'ENOENT') {
      return Object.freeze({ present: false, path: absolute, fileHash: null });
    }
    throw error;
  }
  if (!initialPath.isFile() || initialPath.isSymbolicLink()
    || Number(initialPath.nlink) !== 1) {
    throw new Error('release_evidence_input_file_unsafe');
  }
  const parentChain = snapshotImmutableArchiveDirectoryChain(
    path.dirname(absolute),
    fileSystem,
  );
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      absolute,
      fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0),
    );
    const before = fileSystem.fstatSync(descriptor);
    if (!before.isFile() || Number(before.nlink) !== 1
      || before.dev !== initialPath.dev || before.ino !== initialPath.ino) {
      throw new Error('release_evidence_input_file_path_identity_mismatch');
    }
    if (maximumBytes !== null
      && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
        || before.size < 1 || before.size > maximumBytes)) {
      throw new Error('release_evidence_input_file_size_invalid');
    }
    afterOpen({ descriptor, identity: Object.freeze({ dev: before.dev, ino: before.ino }) });
    let bytes = null;
    const hash = crypto.createHash('sha256');
    if (maximumBytes !== null) {
      bytes = fileSystem.readFileSync(descriptor);
      if (bytes.length !== before.size) throw new Error('release_evidence_input_file_short_read');
      hash.update(bytes);
    } else {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < before.size) {
        const read = fileSystem.readSync(
          descriptor,
          buffer,
          0,
          Math.min(buffer.length, before.size - position),
          position,
        );
        if (read < 1) throw new Error('release_evidence_input_file_short_read');
        hash.update(buffer.subarray(0, read));
        position += read;
      }
    }
    const after = fileSystem.fstatSync(descriptor);
    const finalPath = fileSystem.lstatSync(absolute);
    if (!after.isFile() || Number(after.nlink) !== 1
      || !finalPath.isFile() || finalPath.isSymbolicLink() || Number(finalPath.nlink) !== 1
      || !sameFileIdentity(before, after)
      || finalPath.dev !== before.dev || finalPath.ino !== before.ino
      || !immutableArchiveDirectoryChainUnchanged(parentChain, fileSystem)) {
      throw new Error('release_evidence_input_file_changed');
    }
    return Object.freeze({
      present: true,
      path: absolute,
      fileHash: `sha256:${hash.digest('hex')}`,
      device: String(before.dev),
      inode: String(before.ino),
      size: before.size,
      mode: before.mode & 0o7777,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      ...(bytes === null ? {} : { bytes }),
    });
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function sameBigIntFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function hashPinnedDescriptor(descriptor, size, fileSystem = fs) {
  if (typeof size !== 'bigint' || size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('release_evidence_production_database_size_invalid');
  }
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0n;
  while (position < size) {
    const remaining = size - position;
    const requested = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining);
    const read = fileSystem.readSync(
      descriptor,
      buffer,
      0,
      requested,
      Number(position),
    );
    if (read < 1) throw new Error('release_evidence_production_database_short_read');
    hash.update(buffer.subarray(0, read));
    position += BigInt(read);
  }
  return `sha256:${hash.digest('hex')}`;
}

const SQLITE_LOGICAL_DEPENDENCY_SUFFIXES = Object.freeze([
  '',
  '-journal',
  '-shm',
  '-wal',
]);

function capturePinnedSqliteDependency({
  pinnedRootPath,
  databaseName,
  suffix,
  fileSystem,
}) {
  const name = `${databaseName}${suffix}`;
  const dependencyPath = path.join(pinnedRootPath, name);
  let pathIdentity;
  try { pathIdentity = fileSystem.lstatSync(dependencyPath, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT' && suffix !== '') {
      return Object.freeze({
        name,
        path: dependencyPath,
        present: false,
        descriptor: null,
        identity: null,
        fileHash: null,
      });
    }
    throw error;
  }
  if (!pathIdentity.isFile() || pathIdentity.isSymbolicLink()
    || pathIdentity.nlink !== 1n) {
    throw new Error('release_evidence_production_database_dependency_unsafe');
  }
  const descriptor = fileSystem.openSync(
    dependencyPath,
    fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0),
  );
  try {
    const identity = fileSystem.fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || identity.nlink !== 1n
      || !sameBigIntFileIdentity(identity, pathIdentity)) {
      throw new Error('release_evidence_production_database_dependency_identity_mismatch');
    }
    return Object.freeze({
      name,
      path: dependencyPath,
      present: true,
      descriptor,
      identity,
      fileHash: hashPinnedDescriptor(descriptor, identity.size, fileSystem),
    });
  } catch (error) {
    fileSystem.closeSync(descriptor);
    throw error;
  }
}

function assertPinnedSqliteDependencyUnchanged(dependency, fileSystem) {
  if (!dependency.present) {
    try {
      fileSystem.lstatSync(dependency.path, { bigint: true });
      throw new Error('release_evidence_production_database_dependency_appeared');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  const descriptorIdentity = fileSystem.fstatSync(dependency.descriptor, { bigint: true });
  const pathIdentity = fileSystem.lstatSync(dependency.path, { bigint: true });
  if (!descriptorIdentity.isFile() || descriptorIdentity.nlink !== 1n
    || !pathIdentity.isFile() || pathIdentity.isSymbolicLink()
    || pathIdentity.nlink !== 1n
    || !sameBigIntFileIdentity(dependency.identity, descriptorIdentity)
    || !sameBigIntFileIdentity(dependency.identity, pathIdentity)
    || hashPinnedDescriptor(
      dependency.descriptor,
      descriptorIdentity.size,
      fileSystem,
    ) !== dependency.fileHash) {
    throw new Error('release_evidence_production_database_dependency_changed');
  }
}

function publicSqliteDependencyCapture(dependency) {
  if (!dependency.present) {
    return Object.freeze({
      name: dependency.name,
      present: false,
      fileHash: null,
    });
  }
  return Object.freeze({
    name: dependency.name,
    present: true,
    fileHash: dependency.fileHash,
    device: String(dependency.identity.dev),
    inode: String(dependency.identity.ino),
    size: Number(dependency.identity.size),
    mode: Number(dependency.identity.mode & 0o7777n),
    mtimeNs: String(dependency.identity.mtimeNs),
    ctimeNs: String(dependency.identity.ctimeNs),
  });
}

export function captureProductionStoreLogicalIntegrity({
  runtimeRoot,
  databaseName = 'hepta-paper.sqlite',
  fileSystem = fs,
  inspectLogicalIntegrity = null,
} = {}) {
  const lexicalRoot = path.resolve(String(runtimeRoot || ''));
  if (!path.isAbsolute(String(runtimeRoot || ''))
    || databaseName !== 'hepta-paper.sqlite') {
    throw new Error('release_evidence_production_database_scope_invalid');
  }
  const lexicalDatabasePath = path.join(lexicalRoot, databaseName);
  let initialDatabase;
  try { initialDatabase = fileSystem.lstatSync(lexicalDatabasePath, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        database: Object.freeze({
          present: false,
          path: lexicalDatabasePath,
          fileHash: null,
        }),
        report: null,
      });
    }
    throw error;
  }
  const rootChain = snapshotImmutableArchiveDirectoryChain(lexicalRoot, fileSystem);
  let rootDescriptor;
  let dependencies = [];
  try {
    rootDescriptor = fileSystem.openSync(
      lexicalRoot,
      fileSystem.constants.O_RDONLY
        | (fileSystem.constants.O_DIRECTORY || 0)
        | (fileSystem.constants.O_NOFOLLOW || 0),
    );
    const rootBefore = fileSystem.fstatSync(rootDescriptor, { bigint: true });
    const lexicalRootBefore = fileSystem.lstatSync(lexicalRoot, { bigint: true });
    if (!rootBefore.isDirectory() || !lexicalRootBefore.isDirectory()
      || lexicalRootBefore.isSymbolicLink()
      || rootBefore.dev !== lexicalRootBefore.dev || rootBefore.ino !== lexicalRootBefore.ino) {
      throw new Error('release_evidence_production_database_root_unsafe');
    }
    const pinnedRootPath = `/proc/self/fd/${rootDescriptor}`;
    try { fileSystem.realpathSync(pinnedRootPath); } catch {
      throw new Error('release_evidence_production_database_pinned_root_unavailable');
    }
    const pinnedDatabasePath = path.join(pinnedRootPath, databaseName);
    for (const suffix of SQLITE_LOGICAL_DEPENDENCY_SUFFIXES) {
      dependencies.push(capturePinnedSqliteDependency({
        pinnedRootPath,
        databaseName,
        suffix,
        fileSystem,
      }));
    }
    const databaseDependency = dependencies.find((dependency) => dependency.name === databaseName);
    const databaseBefore = databaseDependency?.identity;
    if (!databaseBefore.isFile() || databaseBefore.nlink !== 1n
      || !initialDatabase.isFile() || initialDatabase.isSymbolicLink()
      || initialDatabase.nlink !== 1n
      || databaseBefore.dev !== initialDatabase.dev
      || databaseBefore.ino !== initialDatabase.ino) {
      throw new Error('release_evidence_production_database_unsafe');
    }
    const databaseHash = databaseDependency.fileHash;
    const inspect = inspectLogicalIntegrity || ((dbPath) => {
      const store = createReadOnlyPaperStore({ dbPath });
      try { return buildSqliteLogicalIntegrityReport({ dbPath, store }); }
      finally { store.close?.(); }
    });
    const inspected = inspect(pinnedDatabasePath);
    if (!isPlainObject(inspected)) {
      throw new Error('release_evidence_production_database_logical_report_invalid');
    }
    const lexicalDatabaseAfter = fileSystem.lstatSync(
      lexicalDatabasePath,
      { bigint: true },
    );
    const rootAfter = fileSystem.fstatSync(rootDescriptor, { bigint: true });
    const lexicalRootAfter = fileSystem.lstatSync(lexicalRoot, { bigint: true });
    dependencies.forEach((dependency) => (
      assertPinnedSqliteDependencyUnchanged(dependency, fileSystem)
    ));
    if (!sameBigIntFileIdentity(databaseBefore, lexicalDatabaseAfter)
      || !sameBigIntFileIdentity(rootBefore, rootAfter)
      || !sameBigIntFileIdentity(rootBefore, lexicalRootAfter)
      || !immutableArchiveDirectoryChainUnchanged(rootChain, fileSystem)) {
      throw new Error('release_evidence_production_database_changed_during_snapshot');
    }
    const report = Object.freeze({ ...inspected, dbPath: lexicalDatabasePath });
    return Object.freeze({
      database: Object.freeze({
        present: true,
        path: lexicalDatabasePath,
        fileHash: databaseHash,
        device: String(databaseBefore.dev),
        inode: String(databaseBefore.ino),
        size: Number(databaseBefore.size),
        mode: Number(databaseBefore.mode & 0o7777n),
        mtimeNs: String(databaseBefore.mtimeNs),
        ctimeNs: String(databaseBefore.ctimeNs),
        dependencies: Object.freeze(dependencies.map(publicSqliteDependencyCapture)),
      }),
      report,
    });
  } finally {
    for (const dependency of dependencies) {
      if (dependency.descriptor !== null) fileSystem.closeSync(dependency.descriptor);
    }
    if (rootDescriptor !== undefined) fileSystem.closeSync(rootDescriptor);
  }
}
