import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readImmutableJsonDocument } from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import {
  verifyAutonomousEmpiricalFamilyPluginSignedBundle,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';

const ACTIVATION_KEYS = Object.freeze([
  'autonomousEmpiricalPluginInstalledReleaseHash', 'bundleHash', 'bundlePath',
  'installedAt', 'kind', 'packageHash', 'packageId', 'packageVersion',
  'registryHash', 'startupInspectionHash', 'trustStoreHash', 'trustStorePath', 'version',
]);
const ACTIVATION_POINTER_KEYS = Object.freeze([
  'acceptancePlanHash', 'acceptanceStepIdempotencyKey', 'activationDocumentHash',
  'activationPath', 'autonomousEmpiricalPluginActivationPointerHash',
  'installedReleaseHash', 'kind', 'packageId', 'packageVersion', 'publishedAt',
  'status', 'version',
]);
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fsyncDirectory(candidate) {
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
  );
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function assertSecureDirectory(candidate) {
  const selected = path.resolve(String(candidate || ''));
  let stat;
  try {
    stat = fs.lstatSync(selected);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid
      || (stat.mode & 0o022) !== 0 || fs.realpathSync(selected) !== selected) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('autonomous_empirical_plugin_install_directory_invalid');
  }
  return selected;
}

function ensureSecureDirectory(candidate) {
  const selected = path.resolve(String(candidate || ''));
  fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
  return assertSecureDirectory(selected);
}

function writeJsonFile(candidate, value) {
  const descriptor = fs.openSync(
    candidate,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function atomicWriteJsonFile(candidate, value) {
  const selected = path.resolve(String(candidate || ''));
  const parent = assertSecureDirectory(path.dirname(selected));
  const temporary = path.join(
    parent,
    `.${path.basename(selected)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeJsonFile(temporary, value);
    fs.renameSync(temporary, selected);
    fsyncDirectory(parent);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already published or absent */ }
  }
  return selected;
}

function releaseHashes(bundle, trustStore) {
  const bundleHash = hashRecord('AutonomousEmpiricalFamilyPluginSignedBundle', bundle);
  const trustStoreHash = hashRecord('AutonomousEmpiricalPluginTrustStore', trustStore);
  return Object.freeze({
    bundleHash,
    trustStoreHash,
    installedReleaseHash: hashRecord('AutonomousEmpiricalPluginInstalledRelease', {
      bundleHash,
      trustStoreHash,
    }),
  });
}

function activationFor({
  bundle,
  trustStore,
  inspection,
  finalDirectory,
  installedAt,
}) {
  const hashes = releaseHashes(bundle, trustStore);
  return Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalPluginInstalledActivation',
    packageId: bundle.package.packageId,
    packageVersion: bundle.package.packageVersion,
    packageHash: bundle.package.autonomousEmpiricalFamilyPluginPackageHash,
    registryHash: bundle.package.registry.autonomousEmpiricalFamilyPluginRegistryHash,
    bundleHash: hashes.bundleHash,
    trustStoreHash: hashes.trustStoreHash,
    startupInspectionHash:
      inspection.autonomousEmpiricalFamilyPluginStartupInspectionHash,
    bundlePath: path.join(finalDirectory, 'bundle.json'),
    trustStorePath: path.join(finalDirectory, 'trust-store.json'),
    installedAt,
    autonomousEmpiricalPluginInstalledReleaseHash: hashes.installedReleaseHash,
  });
}

function acceptanceBinding({ acceptancePlanHash = null, acceptanceStepIdempotencyKey = null } = {}) {
  const planHash = acceptancePlanHash || null;
  const idempotencyKey = acceptanceStepIdempotencyKey || null;
  if ((planHash === null) !== (idempotencyKey === null)
    || (planHash !== null && (!SHA256.test(String(planHash))
      || !SHA256.test(String(idempotencyKey))))) {
    throw new Error('autonomous_empirical_plugin_activation_pointer_acceptance_binding_invalid');
  }
  return Object.freeze({ acceptancePlanHash: planHash, acceptanceStepIdempotencyKey: idempotencyKey });
}

function verifyActivationPointer(pointer, {
  pointerPath,
  expectedAcceptancePlanHash = null,
  expectedAcceptanceStepIdempotencyKey = null,
} = {}) {
  const expectedBinding = acceptanceBinding({
    acceptancePlanHash: expectedAcceptancePlanHash,
    acceptanceStepIdempotencyKey: expectedAcceptanceStepIdempotencyKey,
  });
  if (!hasExactObjectKeys(pointer, ACTIVATION_POINTER_KEYS)
    || pointer.version !== 1
    || pointer.kind !== 'AutonomousEmpiricalPluginActivationPointer'
    || pointer.status !== 'autonomous_empirical_plugin_activation_pointer_published'
    || !SAFE_COMPONENT.test(String(pointer.packageId || ''))
    || !SAFE_COMPONENT.test(String(pointer.packageVersion || ''))
    || !SHA256.test(String(pointer.installedReleaseHash || ''))
    || !SHA256.test(String(pointer.activationDocumentHash || ''))
    || !SHA256.test(String(pointer.autonomousEmpiricalPluginActivationPointerHash || ''))
    || typeof pointer.publishedAt !== 'string'
    || !Number.isFinite(Date.parse(pointer.publishedAt))
    || !path.isAbsolute(String(pointer.activationPath || ''))
    || path.resolve(pointer.activationPath) === path.resolve(pointerPath)
    || (pointer.acceptancePlanHash === null) !== (pointer.acceptanceStepIdempotencyKey === null)
    || (pointer.acceptancePlanHash !== null
      && (!SHA256.test(String(pointer.acceptancePlanHash))
        || !SHA256.test(String(pointer.acceptanceStepIdempotencyKey))))
    || (expectedBinding.acceptancePlanHash !== null
      && (pointer.acceptancePlanHash !== expectedBinding.acceptancePlanHash
        || pointer.acceptanceStepIdempotencyKey
          !== expectedBinding.acceptanceStepIdempotencyKey))) {
    throw new Error('autonomous_empirical_plugin_activation_pointer_invalid');
  }
  const {
    autonomousEmpiricalPluginActivationPointerHash: claimedHash,
    ...payload
  } = pointer;
  if (hashRecord('AutonomousEmpiricalPluginActivationPointer', payload) !== claimedHash) {
    throw new Error('autonomous_empirical_plugin_activation_pointer_hash_mismatch');
  }
  return pointer;
}

export function assertAutonomousEmpiricalPluginActivationPointerTarget(pointerPath) {
  const selected = path.resolve(String(pointerPath || ''));
  if (!pointerPath || path.basename(selected) === '.' || path.basename(selected) === '..') {
    throw new Error('autonomous_empirical_plugin_activation_pointer_path_invalid');
  }
  assertSecureDirectory(path.dirname(selected));
  if (fs.existsSync(selected)) {
    const stat = fs.lstatSync(selected);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(selected) !== selected
      || (stat.mode & 0o022) !== 0) {
      throw new Error('autonomous_empirical_plugin_activation_pointer_path_invalid');
    }
  }
  return selected;
}

function publishActivationPointer({
  pointerPath,
  activationPath,
  activation,
  acceptancePlanHash = null,
  acceptanceStepIdempotencyKey = null,
} = {}) {
  const selectedPointerPath = assertAutonomousEmpiricalPluginActivationPointerTarget(pointerPath);
  const binding = acceptanceBinding({ acceptancePlanHash, acceptanceStepIdempotencyKey });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalPluginActivationPointer',
    status: 'autonomous_empirical_plugin_activation_pointer_published',
    activationPath: path.resolve(activationPath),
    activationDocumentHash: hashRecord(
      'AutonomousEmpiricalPluginInstalledActivation',
      activation,
    ),
    installedReleaseHash: activation.autonomousEmpiricalPluginInstalledReleaseHash,
    packageId: activation.packageId,
    packageVersion: activation.packageVersion,
    publishedAt: activation.installedAt,
    ...binding,
  });
  const pointer = Object.freeze({
    ...payload,
    autonomousEmpiricalPluginActivationPointerHash: hashRecord(
      'AutonomousEmpiricalPluginActivationPointer',
      payload,
    ),
  });
  atomicWriteJsonFile(selectedPointerPath, pointer);
  return pointer;
}

function removeStage(stage, parent) {
  if (!stage || path.dirname(stage) !== parent || !path.basename(stage).startsWith('.stage-')) return;
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ }
}

export function inspectInstalledAutonomousEmpiricalPluginRelease({
  activationPath,
  now = new Date(),
  expectedAcceptancePlanHash = null,
  expectedAcceptanceStepIdempotencyKey = null,
} = {}) {
  const selectedActivationPath = path.resolve(String(activationPath || ''));
  const selectedDocument = readImmutableJsonDocument(selectedActivationPath, {
    maximumBytes: 1024 * 1024,
  });
  const activationPointer = selectedDocument.kind === 'AutonomousEmpiricalPluginActivationPointer'
    ? verifyActivationPointer(selectedDocument, {
      pointerPath: selectedActivationPath,
      expectedAcceptancePlanHash,
      expectedAcceptanceStepIdempotencyKey,
    }) : null;
  if (!activationPointer && (expectedAcceptancePlanHash !== null
    || expectedAcceptanceStepIdempotencyKey !== null)) {
    throw new Error('autonomous_empirical_plugin_activation_pointer_required');
  }
  const resolvedActivationPath = activationPointer
    ? path.resolve(activationPointer.activationPath) : selectedActivationPath;
  const activation = activationPointer
    ? readImmutableJsonDocument(resolvedActivationPath, { maximumBytes: 1024 * 1024 })
    : selectedDocument;
  const directory = path.dirname(resolvedActivationPath);
  if (!hasExactObjectKeys(activation, ACTIVATION_KEYS)
    || activation.version !== 1
    || activation.kind !== 'AutonomousEmpiricalPluginInstalledActivation'
    || !SAFE_COMPONENT.test(String(activation.packageId || ''))
    || !SAFE_COMPONENT.test(String(activation.packageVersion || ''))
    || !SHA256.test(String(activation.packageHash || ''))
    || !SHA256.test(String(activation.registryHash || ''))
    || !SHA256.test(String(activation.bundleHash || ''))
    || !SHA256.test(String(activation.trustStoreHash || ''))
    || !SHA256.test(String(activation.startupInspectionHash || ''))
    || !SHA256.test(String(activation.autonomousEmpiricalPluginInstalledReleaseHash || ''))
    || path.resolve(activation.bundlePath) !== path.join(directory, 'bundle.json')
    || path.resolve(activation.trustStorePath) !== path.join(directory, 'trust-store.json')) {
    throw new Error('autonomous_empirical_plugin_installed_activation_invalid');
  }
  assertSecureDirectory(directory);
  const bundle = readImmutableJsonDocument(activation.bundlePath);
  const trustStore = readImmutableJsonDocument(activation.trustStorePath, {
    maximumBytes: 1024 * 1024,
  });
  const verified = verifyAutonomousEmpiricalFamilyPluginSignedBundle(bundle, {
    trustStore,
    source: 'external-startup-signed-bundle-v1',
    now,
  });
  const expected = activationFor({
    bundle,
    trustStore,
    inspection: verified.startupInspection,
    finalDirectory: directory,
    installedAt: activation.installedAt,
  });
  if (JSON.stringify(expected) !== JSON.stringify(activation)) {
    throw new Error('autonomous_empirical_plugin_installed_activation_mismatch');
  }
  if (activationPointer
    && (activationPointer.activationDocumentHash !== hashRecord(
      'AutonomousEmpiricalPluginInstalledActivation', activation,
    )
      || activationPointer.installedReleaseHash
        !== activation.autonomousEmpiricalPluginInstalledReleaseHash
      || activationPointer.packageId !== activation.packageId
      || activationPointer.packageVersion !== activation.packageVersion
      || activationPointer.publishedAt !== activation.installedAt)) {
    throw new Error('autonomous_empirical_plugin_activation_pointer_target_mismatch');
  }
  return Object.freeze({
    ready: true,
    status: 'autonomous_empirical_plugin_installed_release_ready',
    activationPath: resolvedActivationPath,
    activationPointerPath: activationPointer ? selectedActivationPath : null,
    activationPointer,
    activationPointerVerified: Boolean(activationPointer),
    activation,
    bundle,
    trustStore,
    startupInspection: verified.startupInspection,
    activationEnvironment: Object.freeze({
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE: activation.bundlePath,
      HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE: activation.trustStorePath,
    }),
  });
}

export function installAutonomousEmpiricalPluginRelease({
  bundle,
  trustStore,
  startupInspection,
  installRoot,
  now = new Date(),
  activationPointerPath = null,
  acceptancePlanHash = null,
  acceptanceStepIdempotencyKey = null,
} = {}) {
  const verified = verifyAutonomousEmpiricalFamilyPluginSignedBundle(bundle, {
    trustStore,
    source: 'external-startup-signed-bundle-v1',
    now,
  });
  if (JSON.stringify(verified.startupInspection) !== JSON.stringify(startupInspection)) {
    throw new Error('autonomous_empirical_plugin_install_inspection_mismatch');
  }
  const root = ensureSecureDirectory(installRoot);
  const releases = ensureSecureDirectory(path.join(root, 'releases'));
  const packageId = bundle.package.packageId;
  const packageVersion = bundle.package.packageVersion;
  if (!SAFE_COMPONENT.test(packageId) || !SAFE_COMPONENT.test(packageVersion)) {
    throw new Error('autonomous_empirical_plugin_install_identity_invalid');
  }
  const packageDirectory = ensureSecureDirectory(path.join(releases, packageId));
  const versionDirectory = ensureSecureDirectory(path.join(packageDirectory, packageVersion));
  const hashes = releaseHashes(bundle, trustStore);
  const finalDirectory = path.join(
    versionDirectory,
    hashes.installedReleaseHash.slice('sha256:'.length),
  );
  const installedAt = new Date(now).toISOString();
  const activation = activationFor({
    bundle, trustStore, inspection: verified.startupInspection, finalDirectory, installedAt,
  });
  let stage = fs.mkdtempSync(path.join(versionDirectory, `.stage-${randomUUID()}-`));
  fs.chmodSync(stage, 0o700);
  try {
    writeJsonFile(path.join(stage, 'bundle.json'), bundle);
    writeJsonFile(path.join(stage, 'trust-store.json'), trustStore);
    writeJsonFile(path.join(stage, 'activation.json'), activation);
    fsyncDirectory(stage);
    try {
      fs.renameSync(stage, finalDirectory);
      stage = null;
      fsyncDirectory(versionDirectory);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
  } finally { removeStage(stage, versionDirectory); }
  const installed = inspectInstalledAutonomousEmpiricalPluginRelease({
    activationPath: path.join(finalDirectory, 'activation.json'),
    now,
  });
  const activationPointer = activationPointerPath ? publishActivationPointer({
    pointerPath: activationPointerPath,
    activationPath: path.join(finalDirectory, 'activation.json'),
    activation: installed.activation,
    acceptancePlanHash,
    acceptanceStepIdempotencyKey,
  }) : null;
  return Object.freeze({
    ...installed,
    activationPointerPath: activationPointer ? path.resolve(activationPointerPath) : null,
    activationPointer,
    activationPointerVerified: Boolean(activationPointer),
    installedReleasePath: finalDirectory,
    atomicallyInstalled: true,
    immutableContentAddressedInstall: true,
  });
}
