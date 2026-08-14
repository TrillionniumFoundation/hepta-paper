import fs from 'node:fs';
import path from 'node:path';

import {
  buildAdvancedNumericalGpuRuntimeAuthority,
  verifyAdvancedNumericalPluginDescriptor,
} from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_DOCUMENT_BYTES = 4 * 1024 * 1024;
const V1_KEYS = Object.freeze([
  'kind',
  'outputRoot',
  'pluginRoot',
  'signedBundlePath',
  'trustStorePath',
  'version',
]);
const V2_KEYS = Object.freeze([
  'kind',
  'outputRoot',
  'pluginRoot',
  'qualificationEvidenceFileHash',
  'qualificationEvidencePath',
  'qualificationFileHash',
  'qualificationPath',
  'qualificationTrustStoreFileHash',
  'qualificationTrustStorePath',
  'signedBundleFileHash',
  'signedBundlePath',
  'trustStoreFileHash',
  'trustStorePath',
  'version',
]);
const GPU_CONFIGURATION_KEYS = Object.freeze([
  'containerExecutable', 'containerImage', 'containerImageDigest',
  'cpuFallbackPolicy', 'gpuDeviceIsolationScope', 'gpuDeviceSelector',
  'gpuMemoryLimitBytes', 'gpuMemoryLimitEnforced', 'gpuMemoryLimitScope',
  'requiresGpu', 'runtimeProfile',
]);
const V2_GPU_KEYS = Object.freeze([...V2_KEYS, ...GPU_CONFIGURATION_KEYS]);

function configuredPath(configDirectory, value) {
  const selected = String(value || '').trim();
  if (!selected) throw new Error('advanced_numerical_plugin_configuration_path_required');
  return path.resolve(configDirectory, selected);
}

function configuredHash(value) {
  const selected = String(value || '').toLowerCase();
  if (!SHA256.test(selected)) {
    throw new Error('advanced_numerical_plugin_configuration_file_hash_invalid');
  }
  return selected;
}

export function readIntegrityAdvancedNumericalJsonDocument(filePath, {
  expectedHash = null,
  maximumBytes = MAXIMUM_DOCUMENT_BYTES,
} = {}) {
  const selectedPath = path.resolve(String(filePath || ''));
  const normalizedExpectedHash = expectedHash === null
    ? null : configuredHash(expectedHash);
  if (!Number.isSafeInteger(maximumBytes)
    || maximumBytes < 2 || maximumBytes > MAXIMUM_DOCUMENT_BYTES) {
    throw new Error('advanced_numerical_plugin_document_limit_invalid');
  }
  let descriptor = null;
  try {
    const resolvedPath = fs.realpathSync(selectedPath);
    const pathStat = fs.lstatSync(selectedPath);
    if (selectedPath !== resolvedPath || !pathStat.isFile()
      || pathStat.isSymbolicLink() || pathStat.nlink !== 1
      || pathStat.size < 2 || pathStat.size > maximumBytes
      || (pathStat.mode & 0o022) !== 0) {
      throw new Error('advanced_numerical_plugin_document_integrity_invalid');
    }
    const currentUid = typeof process.getuid === 'function'
      ? process.getuid() : pathStat.uid;
    if (pathStat.uid !== 0 && pathStat.uid !== currentUid) {
      throw new Error('advanced_numerical_plugin_document_owner_invalid');
    }
    descriptor = fs.openSync(
      selectedPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1
      || before.size !== pathStat.size || before.dev !== pathStat.dev
      || before.ino !== pathStat.ino || (before.mode & 0o022) !== 0) {
      throw new Error('advanced_numerical_plugin_document_integrity_invalid');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (bytes.length !== before.size || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) {
      throw new Error('advanced_numerical_plugin_document_changed_during_read');
    }
    const fileHash = hashBytes(bytes);
    if (normalizedExpectedHash !== null && fileHash !== normalizedExpectedHash) {
      throw new Error('advanced_numerical_plugin_document_hash_mismatch');
    }
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('advanced_numerical_plugin_document_json_invalid');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('advanced_numerical_plugin_document_json_invalid');
    }
    return Object.freeze({
      path: selectedPath,
      fileHash,
      value,
    });
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function readDependency(configDirectory, configuration, name, maximumBytes) {
  return readIntegrityAdvancedNumericalJsonDocument(
    configuredPath(configDirectory, configuration[`${name}Path`]),
    {
      expectedHash: configuredHash(configuration[`${name}FileHash`]),
      maximumBytes,
    },
  );
}

function gpuRuntimeAuthority(configuration, bundle, gpuConfiguration) {
  const descriptor = bundle?.descriptor;
  if (descriptor?.version !== 2) {
    if (gpuConfiguration) {
      throw new Error('advanced_numerical_plugin_gpu_configuration_descriptor_mismatch');
    }
    return null;
  }
  if (!verifyAdvancedNumericalPluginDescriptor(descriptor)) {
    throw new Error('advanced_numerical_plugin_configuration_descriptor_invalid');
  }
  if (!gpuConfiguration) {
    throw new Error('advanced_numerical_plugin_gpu_configuration_v2_required');
  }
  const authority = buildAdvancedNumericalGpuRuntimeAuthority(descriptor);
  if (GPU_CONFIGURATION_KEYS.some((key) => (
    JSON.stringify(configuration[key]) !== JSON.stringify(authority[key])
  ))) {
    throw new Error('advanced_numerical_plugin_gpu_configuration_binding_invalid');
  }
  return authority;
}

export function readAdvancedNumericalPluginRuntimeConfiguration({
  configurationPath,
  expectedConfigurationHash = null,
  requireProductionQualification = false,
} = {}) {
  const configurationRead = readIntegrityAdvancedNumericalJsonDocument(
    configurationPath,
    { expectedHash: expectedConfigurationHash },
  );
  const configuration = configurationRead.value;
  const configDirectory = path.dirname(configurationRead.path);
  const versionOne = configuration?.version === 1
    && configuration?.kind === 'AdvancedNumericalPluginRuntimeConfiguration'
    && hasExactObjectKeys(configuration, V1_KEYS);
  const versionTwo = configuration?.version === 2
    && configuration?.kind === 'AdvancedNumericalPluginRuntimeConfiguration'
    && (hasExactObjectKeys(configuration, V2_KEYS)
      || hasExactObjectKeys(configuration, V2_GPU_KEYS));
  const versionTwoGpu = versionTwo && hasExactObjectKeys(configuration, V2_GPU_KEYS);
  if (!versionOne && !versionTwo) {
    throw new Error('advanced_numerical_plugin_runtime_configuration_invalid');
  }
  if (requireProductionQualification && !versionTwo) {
    throw new Error(
      'advanced_numerical_plugin_pinned_qualification_configuration_v2_required',
    );
  }
  const pluginRoot = configuredPath(configDirectory, configuration.pluginRoot);
  const outputRoot = configuredPath(configDirectory, configuration.outputRoot);
  if (versionOne) {
    const bundle = readIntegrityAdvancedNumericalJsonDocument(
      configuredPath(configDirectory, configuration.signedBundlePath),
    );
    const trustStore = readIntegrityAdvancedNumericalJsonDocument(
      configuredPath(configDirectory, configuration.trustStorePath),
      { maximumBytes: 1024 * 1024 },
    );
    if (bundle.value?.descriptor?.version === 2) {
      throw new Error('advanced_numerical_plugin_gpu_configuration_v2_required');
    }
    return Object.freeze({
      configuration,
      configurationPath: configurationRead.path,
      configurationHash: configurationRead.fileHash,
      configurationPinned: expectedConfigurationHash !== null,
      dependentDocumentsPinned: false,
      bundle: bundle.value,
      trustStore: trustStore.value,
      qualification: null,
      qualificationEvidence: null,
      qualificationTrustStore: null,
      gpuRuntimeAuthority: null,
      pluginRoot,
      outputRoot,
      dependencyFileHashes: Object.freeze({
        signedBundleFileHash: bundle.fileHash,
        trustStoreFileHash: trustStore.fileHash,
      }),
    });
  }
  for (const key of V2_KEYS.filter((key) => key.endsWith('FileHash'))) {
    configuredHash(configuration[key]);
  }
  const bundle = readDependency(
    configDirectory,
    configuration,
    'signedBundle',
    MAXIMUM_DOCUMENT_BYTES,
  );
  const trustStore = readDependency(
    configDirectory,
    configuration,
    'trustStore',
    1024 * 1024,
  );
  const qualification = readDependency(
    configDirectory,
    configuration,
    'qualification',
    MAXIMUM_DOCUMENT_BYTES,
  );
  const qualificationEvidence = readDependency(
    configDirectory,
    configuration,
    'qualificationEvidence',
    MAXIMUM_DOCUMENT_BYTES,
  );
  const qualificationTrustStore = readDependency(
    configDirectory,
    configuration,
    'qualificationTrustStore',
    1024 * 1024,
  );
  const selectedGpuRuntimeAuthority = gpuRuntimeAuthority(
    configuration,
    bundle.value,
    versionTwoGpu,
  );
  return Object.freeze({
    configuration,
    configurationPath: configurationRead.path,
    configurationHash: configurationRead.fileHash,
    configurationPinned: expectedConfigurationHash !== null,
    dependentDocumentsPinned: true,
    bundle: bundle.value,
    trustStore: trustStore.value,
    qualification: qualification.value,
    qualificationEvidence: qualificationEvidence.value,
    qualificationTrustStore: qualificationTrustStore.value,
    gpuRuntimeAuthority: selectedGpuRuntimeAuthority,
    pluginRoot,
    outputRoot,
    dependencyFileHashes: Object.freeze({
      signedBundleFileHash: bundle.fileHash,
      trustStoreFileHash: trustStore.fileHash,
      qualificationFileHash: qualification.fileHash,
      qualificationEvidenceFileHash: qualificationEvidence.fileHash,
      qualificationTrustStoreFileHash: qualificationTrustStore.fileHash,
    }),
  });
}
