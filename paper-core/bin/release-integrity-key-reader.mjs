import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertWorkspaceLayoutPhysicallyDecoupled,
  defaultPaperAssetRoot,
} from '../src/workspace-layout.mjs';
import { releaseIntegrityKeyStorage } from './release-integrity-key-storage.mjs';

const {
  EXPECTED_NAMES,
  assertDirectoryChainUnchanged,
  assertPrivateDirectoryChainUnchanged,
  assertPrivateDirectoryIdentity,
  assertSafeDirectoryPath,
  keyPaths,
  lstatOrNull,
  readStableKeyFile,
  runtimeOwnerUid,
  snapshotDirectoryChain,
} = releaseIntegrityKeyStorage;

export const LOCAL_RELEASE_INTEGRITY_AUTHORITY_LIMIT =
  'build_and_archive_integrity_only_not_owner_academic_referee_or_submission_authority';

function isolatedRuntime(environment) {
  return environment?.HEPTA_PAPER_RUNTIME_ISOLATED === '1';
}

function assertNotIsolated(environment) {
  if (isolatedRuntime(environment)) {
    throw new Error('release_integrity_key_access_forbidden_in_isolated_runtime');
  }
}

function validatePair(privateKeyPem, publicKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKey = crypto.createPublicKey(publicKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('release_integrity_key_not_ed25519');
  }
  const derivedPublic = crypto.createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' });
  if (!Buffer.from(derivedPublic).equals(Buffer.from(publicKeyPem))) {
    throw new Error('release_integrity_key_pair_mismatch');
  }
  const challenge = crypto.randomBytes(64);
  const signature = crypto.sign(null, challenge, privateKey);
  if (!crypto.verify(null, challenge, publicKey, signature)) {
    throw new Error('release_integrity_key_pair_self_verification_failed');
  }
  return Object.freeze({ privateKey, publicKey });
}

function inspectPair(runtimeRoot, { environment, fileSystem, retainPrivate = false }) {
  assertNotIsolated(environment);
  const root = assertSafeDirectoryPath(
    fileSystem,
    runtimeRoot,
    'release_integrity_runtime_root_unsafe',
  );
  const rootChain = snapshotDirectoryChain(root, fileSystem);
  const expectedOwnerUid = runtimeOwnerUid(fileSystem, root);
  const paths = keyPaths(root);
  const keyRootStat = lstatOrNull(fileSystem, paths.keyRoot);
  if (!keyRootStat) {
    assertDirectoryChainUnchanged(rootChain, fileSystem);
    return Object.freeze({ root, paths, present: false });
  }
  assertPrivateDirectoryIdentity(
    keyRootStat,
    expectedOwnerUid,
    'release_integrity_key_root_unsafe',
  );
  if (fileSystem.realpathSync(paths.keyRoot) !== paths.keyRoot) {
    throw new Error('release_integrity_key_root_unsafe');
  }
  const keyRootChain = snapshotDirectoryChain(paths.keyRoot, fileSystem);
  assertDirectoryChainUnchanged(rootChain, fileSystem);
  assertPrivateDirectoryChainUnchanged(
    keyRootChain,
    expectedOwnerUid,
    fileSystem,
    'release_integrity_key_root_unsafe',
  );
  const names = fileSystem.readdirSync(paths.keyRoot).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_NAMES)) {
    throw new Error('release_integrity_key_pair_shape_invalid');
  }
  let privateFile;
  let success = false;
  try {
    privateFile = readStableKeyFile(
      fileSystem,
      paths.privatePath,
      0o600,
      expectedOwnerUid,
    );
    const publicFile = readStableKeyFile(
      fileSystem,
      paths.publicPath,
      0o444,
      expectedOwnerUid,
    );
    validatePair(privateFile.bytes, publicFile.bytes);
    const publicKeyPem = publicFile.bytes.toString('utf8');
    assertDirectoryChainUnchanged(rootChain, fileSystem);
    assertPrivateDirectoryChainUnchanged(
      keyRootChain,
      expectedOwnerUid,
      fileSystem,
      'release_integrity_key_root_changed_during_read',
    );
    success = true;
    return Object.freeze({
      root,
      paths,
      present: true,
      ...(retainPrivate ? { privateKeyPem: privateFile.bytes } : {}),
      publicKeyPem,
      publicKeyFingerprint: `sha256:${crypto.createHash('sha256').update(publicKeyPem).digest('hex')}`,
      identities: Object.freeze({
        private: privateFile.identity,
        public: publicFile.identity,
      }),
    });
  } finally {
    if (privateFile && (!retainPrivate || !success)) privateFile.bytes.fill(0);
  }
}

export function inspectLocalReleaseIntegrityKey({
  runtimeRoot,
  environment = process.env,
  fileSystem = fs,
  assetRoot = defaultPaperAssetRoot(),
} = {}) {
  assertNotIsolated(environment);
  assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot, runtimeRoot });
  try {
    const inspected = inspectPair(path.resolve(runtimeRoot), { environment, fileSystem });
    if (!inspected.present) {
      return Object.freeze({
        version: 1,
        kind: 'LocalReleaseIntegrityKeyStatus',
        status: 'local_release_integrity_key_not_provisioned',
        ready: false,
        publicKeyFingerprint: null,
        authorityLimit: LOCAL_RELEASE_INTEGRITY_AUTHORITY_LIMIT,
        hostResidentExportableKey: true,
        privateKeyRead: false,
        credentialUse: 'required_when_pair_present',
        externalKmsOrHsmClaimed: false,
        fullProductionAuthorityClaimed: false,
        blockers: Object.freeze(['release_integrity_key_not_provisioned']),
      });
    }
    return Object.freeze({
      version: 1,
      kind: 'LocalReleaseIntegrityKeyStatus',
      status: 'local_release_integrity_key_ready_bounded_local_profile',
      ready: true,
      publicKeyFingerprint: inspected.publicKeyFingerprint,
      authorityLimit: LOCAL_RELEASE_INTEGRITY_AUTHORITY_LIMIT,
      hostResidentExportableKey: true,
      privateKeyRead: true,
      credentialUse: 'required',
      externalKmsOrHsmClaimed: false,
      fullProductionAuthorityClaimed: false,
      blockers: Object.freeze([]),
    });
  } catch (error) {
    return Object.freeze({
      version: 1,
      kind: 'LocalReleaseIntegrityKeyStatus',
      status: 'local_release_integrity_key_blocked',
      ready: false,
      publicKeyFingerprint: null,
      authorityLimit: LOCAL_RELEASE_INTEGRITY_AUTHORITY_LIMIT,
      hostResidentExportableKey: true,
      privateKeyRead: true,
      credentialUse: 'required_when_pair_present',
      externalKmsOrHsmClaimed: false,
      fullProductionAuthorityClaimed: false,
      blockers: Object.freeze([String(error?.message || error)]),
    });
  }
}

export function loadExistingLocalReleaseIntegritySigningKey(runtimeRoot, {
  includePrivate = false,
  environment = process.env,
  fileSystem = fs,
  assetRoot = defaultPaperAssetRoot(),
} = {}) {
  if (includePrivate) assertNotIsolated(environment);
  assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot, runtimeRoot });
  if (includePrivate) {
    const inspected = inspectPair(path.resolve(runtimeRoot), {
      environment,
      fileSystem,
      retainPrivate: true,
    });
    if (!inspected.present) throw new Error('ENOENT:release_integrity_key_not_provisioned');
    return Object.freeze({
      privatePath: inspected.paths.privatePath,
      privateKeyPem: inspected.privateKeyPem,
      publicPath: inspected.paths.publicPath,
      publicKeyPem: inspected.publicKeyPem,
      publicKeyFingerprint: inspected.publicKeyFingerprint,
    });
  }
  const root = assertSafeDirectoryPath(fileSystem, runtimeRoot, 'release_integrity_runtime_root_unsafe');
  const rootChain = snapshotDirectoryChain(root, fileSystem);
  const expectedOwnerUid = runtimeOwnerUid(fileSystem, root);
  const paths = keyPaths(root);
  const keyRoot = fileSystem.lstatSync(paths.keyRoot);
  try {
    assertPrivateDirectoryIdentity(
      keyRoot,
      expectedOwnerUid,
      'release_integrity_key_root_unsafe',
    );
  } catch {
    throw new Error('release_integrity_key_root_unsafe');
  }
  const keyRootChain = snapshotDirectoryChain(paths.keyRoot, fileSystem);
  assertDirectoryChainUnchanged(rootChain, fileSystem);
  assertPrivateDirectoryChainUnchanged(
    keyRootChain,
    expectedOwnerUid,
    fileSystem,
    'release_integrity_key_root_unsafe',
  );
  if (JSON.stringify(fileSystem.readdirSync(paths.keyRoot).sort()) !== JSON.stringify(EXPECTED_NAMES)) {
    throw new Error('release_integrity_key_pair_shape_invalid');
  }
  const privateStat = fileSystem.lstatSync(paths.privatePath);
  if (!privateStat.isFile() || privateStat.isSymbolicLink() || Number(privateStat.nlink) !== 1
    || (privateStat.mode & 0o7777) !== 0o600
    || Number(privateStat.uid) !== expectedOwnerUid) {
    throw new Error('release_integrity_private_key_unsafe');
  }
  const publicFile = readStableKeyFile(
    fileSystem,
    paths.publicPath,
    0o444,
    expectedOwnerUid,
  );
  const publicKeyPem = publicFile.bytes.toString('utf8');
  const publicKey = crypto.createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('release_integrity_public_key_not_ed25519');
  assertDirectoryChainUnchanged(rootChain, fileSystem);
  assertPrivateDirectoryChainUnchanged(
    keyRootChain,
    expectedOwnerUid,
    fileSystem,
    'release_integrity_key_root_changed_during_read',
  );
  return Object.freeze({
    publicPath: paths.publicPath,
    publicKeyPem,
    publicKeyFingerprint: `sha256:${crypto.createHash('sha256').update(publicKeyPem).digest('hex')}`,
  });
}

export const releaseIntegrityKeyReader = Object.freeze({
  assertNotIsolated,
  inspectPair,
  validatePair,
});
