import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertWorkspaceLayoutPhysicallyDecoupled,
  defaultPaperAssetRoot,
} from '../src/workspace-layout.mjs';
import {
  inspectLocalReleaseIntegrityKey,
  releaseIntegrityKeyReader,
} from './release-integrity-key-reader.mjs';
import { releaseIntegrityKeyStorage } from './release-integrity-key-storage.mjs';

const {
  assertNotIsolated,
  inspectPair,
  validatePair,
} = releaseIntegrityKeyReader;
const {
  PRIVATE_NAME,
  PUBLIC_NAME,
  assertDirectoryChainUnchanged,
  assertPrivateDirectoryChainUnchanged,
  assertPrivateDirectoryIdentity,
  assertSafeDirectoryPath,
  fsyncDirectory,
  keyPaths,
  lstatOrNull,
  publishStagedKeyFileNoClobber,
  readStableKeyFile,
  removeExact,
  removeExactEmptyDirectory,
  removeExactPairDirectory,
  runtimeOwnerUid,
  setPrivateDirectoryModePinned,
  snapshotDirectoryChain,
  writeExclusiveKey,
} = releaseIntegrityKeyStorage;

function acquireProvisioningLock(fileSystem, runtimeRoot) {
  const lockPath = path.join(
    path.dirname(runtimeRoot),
    `.${path.basename(runtimeRoot)}.release-integrity-key-provision.lock`,
  );
  let descriptor;
  let identity;
  try {
    descriptor = fileSystem.openSync(
      lockPath,
      fileSystem.constants.O_WRONLY | fileSystem.constants.O_CREAT
        | fileSystem.constants.O_EXCL | (fileSystem.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isFile() || Number(stat.nlink) !== 1) throw new Error('release_integrity_key_lock_unsafe');
    identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
    fileSystem.fsyncSync(descriptor);
    return Object.freeze({ descriptor, path: lockPath, identity });
  } catch (error) {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    if (identity && !removeExact(fileSystem, lockPath, identity)) {
      throw new Error(`release_integrity_key_lock_rollback_incomplete:${error.message}`);
    }
    if (error?.code === 'EEXIST') throw new Error('release_integrity_key_provision_locked');
    throw error;
  }
}

function releaseProvisioningLock(fileSystem, lock) {
  fileSystem.closeSync(lock.descriptor);
  return removeExact(fileSystem, lock.path, lock.identity);
}

export function provisionLocalReleaseIntegrityKey({
  runtimeRoot,
  execute = false,
  environment = process.env,
  fileSystem = fs,
  assetRoot = defaultPaperAssetRoot(),
  beforePublish = () => {},
} = {}) {
  if (execute !== true) throw new Error('release_integrity_key_provision_execute_required');
  assertNotIsolated(environment);
  assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot, runtimeRoot });
  const root = assertSafeDirectoryPath(
    fileSystem,
    runtimeRoot,
    'release_integrity_runtime_root_unsafe',
  );
  const rootChain = snapshotDirectoryChain(root, fileSystem);
  const expectedOwnerUid = runtimeOwnerUid(fileSystem, root);
  const paths = keyPaths(root);
  const lock = acquireProvisioningLock(fileSystem, root);
  assertDirectoryChainUnchanged(rootChain, fileSystem);
  let stagingRoot = null;
  let stagingIdentity = null;
  let keyRootCreated = false;
  let keyRootIdentity = null;
  const stagedPublications = [];
  const finalPublications = [];
  let result;
  let operationError = null;
  try {
    const existingRoot = lstatOrNull(fileSystem, paths.keyRoot);
    if (existingRoot) {
      inspectPair(root, { environment, fileSystem });
      result = Object.freeze({
        ...inspectLocalReleaseIntegrityKey({ runtimeRoot: root, environment, fileSystem, assetRoot }),
        status: 'local_release_integrity_key_already_provisioned',
        created: false,
      });
    } else {
      stagingRoot = fileSystem.mkdtempSync(path.join(
        path.dirname(root),
        `.${path.basename(root)}.release-signing-staging-`,
      ));
      stagingIdentity = setPrivateDirectoryModePinned(
        fileSystem,
        stagingRoot,
        expectedOwnerUid,
      );
      const stagedRootStat = fileSystem.lstatSync(stagingRoot);
      assertPrivateDirectoryIdentity(
        stagedRootStat,
        expectedOwnerUid,
        'release_integrity_key_staging_root_unsafe',
      );
      if (stagedRootStat.dev !== stagingIdentity.dev
        || stagedRootStat.ino !== stagingIdentity.ino) {
        throw new Error('release_integrity_key_staging_root_unsafe');
      }
      const pair = crypto.generateKeyPairSync('ed25519');
      const privateKeyPem = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
      const publicKeyPem = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }));
      const stagedPrivate = path.join(stagingRoot, PRIVATE_NAME);
      const stagedPublic = path.join(stagingRoot, PUBLIC_NAME);
      let privateIdentity;
      try {
        validatePair(privateKeyPem, publicKeyPem);
        privateIdentity = writeExclusiveKey(
          fileSystem,
          stagedPrivate,
          privateKeyPem,
          0o600,
          expectedOwnerUid,
        );
      } finally { privateKeyPem.fill(0); }
      stagedPublications.push({ path: stagedPrivate, identity: privateIdentity });
      stagedPublications.push({
        path: stagedPublic,
        identity: writeExclusiveKey(
          fileSystem,
          stagedPublic,
          publicKeyPem,
          0o444,
          expectedOwnerUid,
        ),
      });
      const stagedPrivateBytes = readStableKeyFile(
        fileSystem,
        stagedPrivate,
        0o600,
        expectedOwnerUid,
      ).bytes;
      try {
        validatePair(
          stagedPrivateBytes,
          readStableKeyFile(fileSystem, stagedPublic, 0o444, expectedOwnerUid).bytes,
        );
      } finally { stagedPrivateBytes.fill(0); }
      fsyncDirectory(fileSystem, stagingRoot, stagingIdentity);
      beforePublish();
      assertDirectoryChainUnchanged(rootChain, fileSystem);
      try {
        fileSystem.mkdirSync(paths.keyRoot, { mode: 0o700 });
        keyRootCreated = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        inspectPair(root, { environment, fileSystem });
        if (!removeExactPairDirectory(
          fileSystem,
          stagingRoot,
          stagingIdentity,
          stagedPublications,
        )) {
          throw new Error('release_integrity_key_staging_cleanup_incomplete');
        }
        stagingRoot = null;
        result = Object.freeze({
          ...inspectLocalReleaseIntegrityKey({ runtimeRoot: root, environment, fileSystem, assetRoot }),
          status: 'local_release_integrity_key_already_provisioned',
          created: false,
        });
      }
      if (keyRootCreated) {
        const createdRoot = fileSystem.lstatSync(paths.keyRoot);
        assertPrivateDirectoryIdentity(
          createdRoot,
          expectedOwnerUid,
          'release_integrity_key_root_unsafe',
        );
        keyRootIdentity = Object.freeze({ dev: createdRoot.dev, ino: createdRoot.ino });
        const keyRootChain = snapshotDirectoryChain(paths.keyRoot, fileSystem);
        assertDirectoryChainUnchanged(rootChain, fileSystem);
        assertPrivateDirectoryChainUnchanged(
          keyRootChain,
          expectedOwnerUid,
          fileSystem,
          'release_integrity_key_root_changed_during_publish',
        );

        // The public projection is installed first. The private key is the
        // signing authority and is installed last, so a crash cannot expose a
        // usable half-published signing authority. link(2) is no-clobber.
        finalPublications.push(publishStagedKeyFileNoClobber({
          fileSystem,
          source: stagedPublic,
          destination: paths.publicPath,
          identity: stagedPublications[1].identity,
          expectedMode: 0o444,
          expectedOwnerUid,
        }));
        assertPrivateDirectoryChainUnchanged(
          keyRootChain,
          expectedOwnerUid,
          fileSystem,
          'release_integrity_key_root_changed_during_publish',
        );
        finalPublications.push(publishStagedKeyFileNoClobber({
          fileSystem,
          source: stagedPrivate,
          destination: paths.privatePath,
          identity: stagedPublications[0].identity,
          expectedMode: 0o600,
          expectedOwnerUid,
        }));
        fsyncDirectory(fileSystem, paths.keyRoot, keyRootIdentity);
        if (!removeExactPairDirectory(
          fileSystem,
          stagingRoot,
          stagingIdentity,
          stagedPublications,
        )) throw new Error('release_integrity_key_staging_cleanup_incomplete');
        stagingRoot = null;
        fsyncDirectory(fileSystem, path.dirname(root));
        fsyncDirectory(fileSystem, root);
        assertDirectoryChainUnchanged(rootChain, fileSystem);
        assertPrivateDirectoryChainUnchanged(
          keyRootChain,
          expectedOwnerUid,
          fileSystem,
          'release_integrity_key_root_changed_during_publish',
        );
        inspectPair(root, { environment, fileSystem });
        result = Object.freeze({
          ...inspectLocalReleaseIntegrityKey({ runtimeRoot: root, environment, fileSystem, assetRoot }),
          status: 'local_release_integrity_key_provisioned',
          created: true,
        });
      }
    }
  } catch (error) {
    operationError = error;
    let rollbackIncomplete = false;
    for (const publication of [...finalPublications].reverse()) {
      if (!removeExact(fileSystem, publication.path, publication.identity)) rollbackIncomplete = true;
    }
    if (keyRootCreated && keyRootIdentity
      && !removeExactEmptyDirectory(fileSystem, paths.keyRoot, keyRootIdentity)) {
      rollbackIncomplete = true;
    }
    if (stagingRoot && stagingIdentity) {
      if (!removeExactPairDirectory(
        fileSystem,
        stagingRoot,
        stagingIdentity,
        stagedPublications,
      )) rollbackIncomplete = true;
    }
    if (rollbackIncomplete) {
      operationError = new Error(`release_integrity_key_provision_rollback_incomplete:${error.message}`);
    }
  }
  try { assertDirectoryChainUnchanged(rootChain, fileSystem); }
  catch (error) {
    operationError = operationError || error;
  }
  if (!releaseProvisioningLock(fileSystem, lock)) {
    throw new Error(`release_integrity_key_lock_release_failed${operationError ? `:${operationError.message}` : ''}`);
  }
  if (operationError) throw operationError;
  return result;
}
