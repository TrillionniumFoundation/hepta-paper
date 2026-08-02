import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  loadExistingLocalReleaseIntegritySigningKey,
} from './release-integrity-key-management.mjs';
import { releaseIntegrityFilesystem } from './release-integrity-filesystem.mjs';

const {
  assertDirectoryChainUnchanged,
  ensurePrivateDirectory: ensurePrivateDirectoryWithinRuntime,
  hashRegularFile: sha256RegularFileNoFollow,
  readRegularFile: readRegularFileNoFollow,
  snapshotDirectoryChain,
} = releaseIntegrityFilesystem;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/;
const RELEASE_SIGNATURE_AUTHORITY_LIMIT = 'build_and_archive_integrity_only_not_owner_academic_referee_or_submission_authority';
const CODE_PROVENANCE_KEYS = Object.freeze([
  'commit', 'commitTree', 'evidenceClass', 'evidenceEnvironment', 'indexStateHash', 'kind',
  'packageVersion', 'repositoryContentHash', 'repositoryEntryCount', 'tags', 'treeDirty',
  'version', 'worktreeStateHash',
]);
const RELEASE_SIGNATURE_KEYS = Object.freeze([
  'algorithm', 'authorityLimit', 'kind', 'payloadHash', 'publicKeyFingerprint', 'publicKeyPem',
  'role', 'signature', 'version',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sha256Bytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory()) throw new Error('release_evidence_fsync_directory_unsafe');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function unique(values) {
  return [...new Set(values)];
}

function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate)).replace(/\\/g, '/');
  return relative && relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative)
    ? relative
    : null;
}

function existingDirectoryWithinRuntime(runtimeRoot, candidate) {
  const root = path.resolve(runtimeRoot);
  const destination = path.resolve(candidate);
  const relative = pathWithin(root, destination);
  if (!relative) return null;
  try {
    const rootChain = snapshotDirectoryChain(root);
    const selectedChain = snapshotDirectoryChain(destination);
    assertDirectoryChainUnchanged(rootChain);
    assertDirectoryChainUnchanged(selectedChain);
    return relative;
  } catch { return null; }
}

function loadExistingReleaseSigningKey(runtimeRoot, options = {}) {
  return loadExistingLocalReleaseIntegritySigningKey(runtimeRoot, options);
}

function exactCleanCodeProvenanceBlockers(provenance) {
  const blockers = [];
  if (!exactKeys(provenance, CODE_PROVENANCE_KEYS)) blockers.push('code_provenance_shape_invalid');
  if (provenance?.version !== 2 || provenance?.kind !== 'CodeProvenance') blockers.push('code_provenance_v2_required');
  if (!GIT_OBJECT_PATTERN.test(String(provenance?.commit || ''))) blockers.push('code_provenance_commit_invalid');
  if (!GIT_OBJECT_PATTERN.test(String(provenance?.commitTree || ''))) blockers.push('code_provenance_commit_tree_invalid');
  if (!SHA256_PATTERN.test(String(provenance?.indexStateHash || ''))) blockers.push('code_provenance_index_hash_invalid');
  if (!SHA256_PATTERN.test(String(provenance?.repositoryContentHash || ''))) blockers.push('code_provenance_repository_hash_invalid');
  if (!SHA256_PATTERN.test(String(provenance?.worktreeStateHash || ''))) blockers.push('code_provenance_worktree_hash_invalid');
  if (!Number.isSafeInteger(provenance?.repositoryEntryCount) || provenance.repositoryEntryCount < 1) blockers.push('code_provenance_entry_count_invalid');
  if (!Array.isArray(provenance?.tags) || provenance.tags.some((tag) => typeof tag !== 'string')
    || new Set(provenance?.tags || []).size !== provenance?.tags?.length) blockers.push('code_provenance_tags_invalid');
  if (typeof provenance?.packageVersion !== 'string' || !provenance.packageVersion) blockers.push('code_provenance_package_version_invalid');
  if (typeof provenance?.evidenceEnvironment !== 'string' || !provenance.evidenceEnvironment
    || typeof provenance?.evidenceClass !== 'string' || !provenance.evidenceClass) blockers.push('code_provenance_evidence_classification_invalid');
  if (provenance?.treeDirty !== false) blockers.push('code_provenance_clean_tree_required');
  return unique(blockers);
}

function assertExactCleanCodeProvenance(provenance, options = {}) {
  const releaseCommitAssertion = Object.hasOwn(options, 'releaseCommitAssertion')
    ? options.releaseCommitAssertion
    : process.env.HEPTA_RELEASE_COMMIT;
  const blockers = exactCleanCodeProvenanceBlockers(provenance);
  if (releaseCommitAssertion !== undefined && releaseCommitAssertion !== provenance?.commit) {
    blockers.push('release_commit_environment_mismatch');
  }
  if (blockers.length) throw new Error(unique(blockers).join(','));
  return provenance;
}

function exactCodeProvenanceMatches(actual, expected) {
  return exactCleanCodeProvenanceBlockers(actual).length === 0
    && exactCleanCodeProvenanceBlockers(expected).length === 0
    && hashRecord('ExactCodeProvenance', actual) === hashRecord('ExactCodeProvenance', expected);
}

function verifyReleaseIntegritySignature(payload, signature, {
  pinnedPublicKeyPem = null,
  pinnedPublicKeyFingerprint = null,
} = {}) {
  try {
    if (!exactKeys(signature, RELEASE_SIGNATURE_KEYS)
      || signature.version !== 1
      || signature.kind !== 'ReleaseIntegritySignature'
      || signature.role !== 'local_release_integrity'
      || signature.algorithm !== 'ed25519'
      || signature.authorityLimit !== RELEASE_SIGNATURE_AUTHORITY_LIMIT
      || !SHA256_PATTERN.test(String(signature.payloadHash || ''))
      || !SHA256_PATTERN.test(String(signature.publicKeyFingerprint || ''))
      || typeof signature.publicKeyPem !== 'string'
      || typeof signature.signature !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature.signature)
      || signature.signature.length % 4 !== 0) return false;
    const signatureBytes = Buffer.from(signature.signature, 'base64');
    if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature.signature) return false;
    const publicKey = crypto.createPublicKey(signature.publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    const computedFingerprint = sha256Bytes(signature.publicKeyPem);
    if (computedFingerprint !== signature.publicKeyFingerprint
      || (pinnedPublicKeyPem !== null && signature.publicKeyPem !== pinnedPublicKeyPem)
      || (pinnedPublicKeyFingerprint !== null && signature.publicKeyFingerprint !== pinnedPublicKeyFingerprint)) return false;
    const canonical = Buffer.from(JSON.stringify(payload), 'utf8');
    if (sha256Bytes(canonical) !== signature.payloadHash) return false;
    return crypto.verify(null, canonical, publicKey, signatureBytes);
  } catch {
    return false;
  }
}

function signReleasePayload(payload, runtimeRoot, {
  allowKeyCreation = false,
  environment = process.env,
  fileSystem = fs,
  assetRoot,
} = {}) {
  if (allowKeyCreation) throw new Error('release_integrity_key_explicit_provision_required');
  let key;
  try {
    key = loadExistingReleaseSigningKey(runtimeRoot, {
      includePrivate: true,
      environment,
      fileSystem,
      ...(assetRoot === undefined ? {} : { assetRoot }),
    });
    const canonical = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = crypto.sign(null, canonical, key.privateKeyPem).toString('base64');
    const publicKeyFingerprint = key.publicKeyFingerprint || sha256Bytes(key.publicKeyPem);
    const result = {
      version: 1,
      kind: 'ReleaseIntegritySignature',
      role: 'local_release_integrity',
      algorithm: 'ed25519',
      publicKeyFingerprint,
      publicKeyPem: key.publicKeyPem,
      payloadHash: sha256Bytes(canonical),
      signature,
      authorityLimit: RELEASE_SIGNATURE_AUTHORITY_LIMIT,
    };
    if (!verifyReleaseIntegritySignature(payload, result, {
      pinnedPublicKeyPem: key.publicKeyPem,
      pinnedPublicKeyFingerprint: publicKeyFingerprint,
    })) throw new Error('release_integrity_signature_self_verification_failed');
    return result;
  } finally {
    key?.privateKeyPem?.fill(0);
  }
}

function writeNoClobberJsonFile(file, value, {
  mode = 0o444,
  beforePostimageInspection = () => {},
} = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const parent = path.dirname(file);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('release_evidence_output_directory_unsafe');
  let descriptor;
  let identity;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || Number(opened.nlink) !== 1) throw new Error('release_evidence_output_file_unsafe');
    identity = { dev: opened.dev, ino: opened.ino };
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    beforePostimageInspection(Object.freeze({ file, identity: Object.freeze({ ...identity }) }));
    const persisted = fs.lstatSync(file);
    const persistedHash = sha256RegularFileNoFollow(file);
    const finalStat = fs.lstatSync(file);
    if (!persisted.isFile() || persisted.isSymbolicLink()
      || persisted.dev !== identity.dev || persisted.ino !== identity.ino
      || finalStat.dev !== identity.dev || finalStat.ino !== identity.ino
      || persisted.size !== bytes.length || finalStat.size !== bytes.length
      || persistedHash !== sha256Bytes(bytes)) throw new Error('release_evidence_output_postimage_mismatch');
    fsyncDirectory(parent);
    return Object.freeze({
      path: file,
      fileHash: sha256Bytes(bytes),
      bytes: bytes.length,
      mode,
      preexisting: false,
      identity: Object.freeze({ ...identity }),
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (identity && !removeExactPublishedFile({ path: file, identity, preexisting: false })) {
      throw new Error(`release_evidence_output_rollback_incomplete:${error.message}`);
    }
    throw error;
  }
}

function restoreQuarantinedFileNoClobber({ file, quarantinePath, stat }, fileSystem = fs) {
  try {
    fileSystem.linkSync(quarantinePath, file);
    const restored = fileSystem.lstatSync(file);
    if (!restored.isFile() || restored.isSymbolicLink()
      || restored.dev !== stat.dev || restored.ino !== stat.ino) return false;
    if (!removeExactPublishedFile({
      path: quarantinePath,
      identity: { dev: stat.dev, ino: stat.ino },
      preexisting: false,
    }, { fileSystem, expectedLinkCounts: [2] })) return false;
    fsyncDirectory(path.dirname(file));
    return true;
  } catch {
    // Never overwrite a concurrent path. The quarantined bytes remain recoverable.
    return false;
  }
}

function quarantinePublishedFile(file, expectedIdentity, {
  fileSystem = fs,
  randomBytes = crypto.randomBytes,
  expectedLinkCounts = [1],
} = {}) {
  const quarantinePath = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(12).toString('hex')}.quarantine`,
  );
  try {
    fileSystem.renameSync(file, quarantinePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ absent: true });
    throw error;
  }
  const stat = fileSystem.lstatSync(quarantinePath);
  const exact = stat.isFile() && !stat.isSymbolicLink()
    && expectedLinkCounts.includes(Number(stat.nlink))
    && stat.dev === expectedIdentity?.dev && stat.ino === expectedIdentity?.ino;
  if (!exact) {
    restoreQuarantinedFileNoClobber({ file, quarantinePath, stat }, fileSystem);
    return Object.freeze({ exact: false, quarantinePath, stat });
  }
  return Object.freeze({ exact: true, quarantinePath, stat });
}

function removeExactPublishedFile(publication, options = {}) {
  if (publication?.preexisting === true) return true;
  const identity = publication?.identity;
  if (!identity || typeof publication?.path !== 'string') return false;
  try {
    const quarantined = quarantinePublishedFile(publication.path, identity, options);
    if (quarantined.absent) return false;
    if (!quarantined.exact) return false;
    (options.fileSystem || fs).unlinkSync(quarantined.quarantinePath);
    fsyncDirectory(path.dirname(publication.path));
    return true;
  } catch {
    return false;
  }
}

function writeNoClobberJsonFiles(entries) {
  if (!Array.isArray(entries)
    || entries.some((entry) => !isPlainObject(entry)
      || typeof entry.path !== 'string'
      || !Object.hasOwn(entry, 'value'))) {
    throw new Error('release_evidence_artifact_set_invalid');
  }
  if (new Set(entries.map((entry) => path.resolve(entry.path))).size !== entries.length) {
    throw new Error('release_evidence_artifact_paths_not_unique');
  }
  const preexisting = new Map();
  for (const entry of entries) {
    const expectedBytes = Buffer.from(`${JSON.stringify(entry.value, null, 2)}\n`);
    const expectedMode = entry.mode ?? 0o444;
    try {
      const stat = fs.lstatSync(entry.path);
      if (entry.allowExistingExact !== true) {
        throw new Error('release_evidence_artifact_collision');
      }
      const actualBytes = readRegularFileNoFollow(entry.path);
      const finalStat = fs.lstatSync(entry.path);
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1
        || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino
        || (finalStat.mode & 0o777) !== expectedMode
        || !actualBytes.equals(expectedBytes)) {
        throw new Error('release_evidence_existing_artifact_conflict');
      }
      preexisting.set(path.resolve(entry.path), Object.freeze({
        path: entry.path,
        fileHash: sha256Bytes(actualBytes),
        bytes: actualBytes.length,
        mode: expectedMode,
        preexisting: true,
        identity: Object.freeze({ dev: stat.dev, ino: stat.ino }),
      }));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const publications = [];
  try {
    for (const entry of entries) {
      const existing = preexisting.get(path.resolve(entry.path));
      publications.push(existing || writeNoClobberJsonFile(entry.path, entry.value, {
        mode: entry.mode ?? 0o444,
      }));
    }
    return Object.freeze([...publications]);
  } catch (error) {
    let rollbackIncomplete = false;
    for (const publication of publications.slice().reverse()) {
      if (!removeExactPublishedFile(publication)) rollbackIncomplete = true;
    }
    if (rollbackIncomplete) {
      throw new Error(`release_evidence_artifact_set_rollback_incomplete:${error.message}`);
    }
    throw error;
  }
}

function verifyExactPublication(publication) {
  const stat = fs.lstatSync(publication.path);
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1
    && stat.dev === publication.identity.dev && stat.ino === publication.identity.ino
    && (stat.mode & 0o777) === publication.mode
    && sha256RegularFileNoFollow(publication.path) === publication.fileHash;
}

function readOptionalPointer(file) {
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || Number(before.nlink) !== 1) {
      throw new Error('release_evidence_pointer_unsafe');
    }
    const bytes = readRegularFileNoFollow(file);
    const after = fs.lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('release_evidence_pointer_changed_during_read');
    }
    return Object.freeze({
      bytes,
      fileHash: sha256Bytes(bytes),
      mode: before.mode & 0o777,
      size: before.size,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      identity: Object.freeze({ dev: before.dev, ino: before.ino }),
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function installAtomicJsonPointer(file, value, {
  beforeStagingCleanup = () => {},
} = {}) {
  const parent = path.dirname(file);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('release_evidence_output_directory_unsafe');
  }
  const previous = readOptionalPointer(file);
  const stagingPath = path.join(
    parent,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.staging`,
  );
  const staging = writeNoClobberJsonFile(stagingPath, value);
  let installed = false;
  try {
    if (previous) {
      const current = fs.lstatSync(file);
      if (!current.isFile() || current.isSymbolicLink() || Number(current.nlink) !== 1
        || current.dev !== previous.identity.dev || current.ino !== previous.identity.ino
        || current.size !== previous.size || current.mtimeMs !== previous.mtimeMs
        || current.ctimeMs !== previous.ctimeMs
        || sha256RegularFileNoFollow(file) !== previous.fileHash) {
        throw new Error('release_evidence_pointer_changed_before_commit');
      }
      // Every official writer holds the parent-scoped publication lock. Node
      // does not expose renameat2(RENAME_NOREPLACE), so this is not presented
      // as a CAS against an uncooperative writer; postimage verification and
      // identity-bound rollback remain fail closed.
      fs.renameSync(stagingPath, file);
      installed = true;
    } else {
      fs.linkSync(stagingPath, file);
      installed = true;
      beforeStagingCleanup(Object.freeze({
        path: stagingPath,
        identity: staging.identity,
      }));
      if (!removeExactPublishedFile(staging, { expectedLinkCounts: [2] })) {
        throw new Error('release_evidence_pointer_staging_cleanup_incomplete');
      }
    }
    const committed = fs.lstatSync(file);
    if (!committed.isFile() || committed.isSymbolicLink() || Number(committed.nlink) !== 1
      || committed.dev !== staging.identity.dev || committed.ino !== staging.identity.ino) {
      throw new Error('release_evidence_pointer_postimage_mismatch');
    }
    fsyncDirectory(parent);
    return Object.freeze({
      path: file,
      previous,
      fileHash: staging.fileHash,
      mode: staging.mode,
      identity: Object.freeze({ dev: committed.dev, ino: committed.ino }),
    });
  } catch (error) {
    let rollbackIncomplete = false;
    if (!installed && !removeExactPublishedFile(staging)) rollbackIncomplete = true;
    if (installed) {
      const pointerPublication = {
        path: file,
        previous,
        identity: staging.identity,
      };
      if (!rollbackAtomicJsonPointer(pointerPublication)) rollbackIncomplete = true;
    }
    if (rollbackIncomplete) {
      throw new Error(`release_evidence_pointer_rollback_incomplete:${error.message}`);
    }
    throw error;
  }
}

function rollbackAtomicJsonPointer(publication) {
  if (!publication.previous) return removeExactPublishedFile(publication);
  const parent = path.dirname(publication.path);
  const quarantined = quarantinePublishedFile(publication.path, publication.identity);
  if (!quarantined.exact) return false;
  const rollbackPath = path.join(
    parent,
    `.${path.basename(publication.path)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.rollback`,
  );
  let descriptor;
  let rollbackIdentity;
  try {
    descriptor = fs.openSync(
      rollbackPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const rollbackStat = fs.fstatSync(descriptor);
    if (!rollbackStat.isFile() || Number(rollbackStat.nlink) !== 1) {
      throw new Error('release_evidence_pointer_restore_staging_unsafe');
    }
    rollbackIdentity = Object.freeze({ dev: rollbackStat.dev, ino: rollbackStat.ino });
    fs.writeFileSync(descriptor, publication.previous.bytes);
    fs.fchmodSync(descriptor, publication.previous.mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(rollbackPath, publication.path);
    const restored = fs.lstatSync(publication.path);
    if (!restored.isFile() || restored.isSymbolicLink() || Number(restored.nlink) !== 2) {
      throw new Error('release_evidence_pointer_restore_postimage_mismatch');
    }
    if (!removeExactPublishedFile({
      path: rollbackPath,
      identity: rollbackIdentity,
      preexisting: false,
    }, { expectedLinkCounts: [2] })) throw new Error('release_evidence_pointer_restore_staging_cleanup_incomplete');
    if (!removeExactPublishedFile({
      path: quarantined.quarantinePath,
      identity: { dev: quarantined.stat.dev, ino: quarantined.stat.ino },
      preexisting: false,
    })) throw new Error('release_evidence_pointer_previous_cleanup_incomplete');
    fsyncDirectory(parent);
    return true;
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (rollbackIdentity) removeExactPublishedFile({
      path: rollbackPath,
      identity: rollbackIdentity,
      preexisting: false,
    }, { expectedLinkCounts: [1, 2] });
    restoreQuarantinedFileNoClobber({
      file: publication.path,
      quarantinePath: quarantined.quarantinePath,
      stat: quarantined.stat,
    });
    return false;
  }
}

function acquirePublicationLock(pointerPath) {
  const parent = path.dirname(pointerPath);
  const parentChain = snapshotDirectoryChain(parent);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('release_evidence_output_directory_unsafe');
  }
  const lockPath = path.join(parent, '.release-integrity-publication.lock');
  let descriptor;
  let identity;
  try {
    descriptor = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || Number(stat.nlink) !== 1) {
      throw new Error('release_evidence_publication_lock_unsafe');
    }
    identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
    fs.fsyncSync(descriptor);
    assertDirectoryChainUnchanged(parentChain);
    return Object.freeze({
      descriptor,
      path: lockPath,
      parentChain,
      identity,
    });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (identity && !removeExactPublishedFile({ path: lockPath, identity })) {
      throw new Error(`release_evidence_publication_lock_rollback_incomplete:${error.message}`);
    }
    if (error?.code === 'EEXIST') throw new Error('release_evidence_publication_locked');
    throw error;
  }
}

function releasePublicationLock(lock) {
  fs.closeSync(lock.descriptor);
  return removeExactPublishedFile(lock);
}

function publishJsonArtifactSet({
  entries,
  pointerPath,
  pointerValue,
  beforePointer = () => {},
  afterPointer = () => {},
  pointerHooks = {},
} = {}) {
  const lock = acquirePublicationLock(pointerPath);
  let result;
  let operationError = null;
  try {
    assertDirectoryChainUnchanged(lock.parentChain);
    const publications = writeNoClobberJsonFiles(entries);
    let pointerPublication = null;
    try {
      beforePointer();
      assertDirectoryChainUnchanged(lock.parentChain);
      if (publications.some((publication) => !verifyExactPublication(publication))) {
        throw new Error('release_evidence_artifact_changed_before_pointer');
      }
      pointerPublication = installAtomicJsonPointer(pointerPath, pointerValue, pointerHooks);
      afterPointer();
      assertDirectoryChainUnchanged(lock.parentChain);
      if (publications.some((publication) => !verifyExactPublication(publication))
        || !verifyExactPublication(pointerPublication)) {
        throw new Error('release_evidence_publication_postimage_changed');
      }
      result = Object.freeze({ artifacts: publications, pointer: pointerPublication });
    } catch (error) {
      let rollbackIncomplete = false;
      if (pointerPublication && !rollbackAtomicJsonPointer(pointerPublication)) rollbackIncomplete = true;
      for (const publication of [...publications].reverse()) {
        if (!removeExactPublishedFile(publication)) rollbackIncomplete = true;
      }
      if (rollbackIncomplete) {
        throw new Error(`release_evidence_publication_rollback_incomplete:${error.message}`);
      }
      throw error;
    }
  } catch (error) {
    operationError = error;
  }
  try { assertDirectoryChainUnchanged(lock.parentChain); }
  catch (error) { operationError = operationError || error; }
  if (!releasePublicationLock(lock)) {
    throw new Error(`release_evidence_publication_lock_release_failed${operationError ? `:${operationError.message}` : ''}`);
  }
  if (operationError) throw operationError;
  return result;
}

export const releaseIntegrityEvidence = Object.freeze({
  SHA256_PATTERN,
  assertExactCleanCodeProvenance,
  ensurePrivateDirectoryWithinRuntime,
  existingDirectoryWithinRuntime,
  exactCleanCodeProvenanceBlockers,
  exactCodeProvenanceMatches,
  exactKeys,
  isPlainObject,
  loadExistingReleaseSigningKey,
  pathWithin,
  publishJsonArtifactSet,
  readRegularFileNoFollow,
  removeExactPublishedFile,
  sha256Bytes,
  sha256RegularFileNoFollow,
  signReleasePayload,
  unique,
  verifyReleaseIntegritySignature,
  writeNoClobberJsonFile,
  writeNoClobberJsonFiles,
});
