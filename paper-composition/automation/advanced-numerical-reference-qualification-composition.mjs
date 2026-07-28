import fs from 'node:fs';
import path from 'node:path';

import {
  readImmutableJsonDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  composeAdvancedNumericalPluginRuntime,
} from './advanced-numerical-plugin-composition.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REGISTRY_KEYS = Object.freeze(['entries', 'kind', 'version']);
const ENTRY_KEYS = Object.freeze([
  'analysisFamily',
  'runtimeConfigurationHash',
  'runtimeConfigurationPath',
]);

function configuredPath(configDirectory, value) {
  const selected = String(value || '').trim();
  if (!selected) throw new Error('advanced_numerical_plugin_configuration_path_required');
  return path.resolve(configDirectory, selected);
}

function baseCandidate({
  analysisFamily,
  candidateManifest,
  candidateManifestHash,
  candidateSnapshot,
  entrypointHash,
  blockers = [],
}) {
  return Object.freeze({
    pluginId: `hepta.reference.${analysisFamily}`,
    pluginVersion: '1.0.0',
    analysisFamily,
    status: 'reference_candidate_unqualified',
    productionQualified: false,
    entrypoint: candidateManifest.entrypoint,
    entrypointHash,
    sourceMerkleHash: candidateSnapshot.merkleHash,
    sourceWorkspaceManifestHash: candidateSnapshot.manifestHash,
    candidateManifestHash,
    runtimeExecutableHash: null,
    runtimePackageClosureHash: null,
    signedBundleHash: null,
    qualificationStatementHash: null,
    qualificationBlockers: Object.freeze([...new Set(blockers)].sort()),
  });
}

function inspectEntry({
  candidate,
  candidateRoot,
  entry,
  now,
  registryPath,
  runtimeComposer,
}) {
  if (!hasExactObjectKeys(entry, ENTRY_KEYS)
    || entry.analysisFamily !== candidate.analysisFamily
    || !SHA256.test(String(entry.runtimeConfigurationHash || ''))) {
    throw new Error('advanced_numerical_reference_qualification_registry_entry_invalid');
  }
  const registryDirectory = path.dirname(registryPath);
  const configurationPath = configuredPath(
    registryDirectory,
    entry.runtimeConfigurationPath,
  );
  const configurationBytes = fs.readFileSync(configurationPath);
  if (hashBytes(configurationBytes) !== entry.runtimeConfigurationHash) {
    throw new Error('advanced_numerical_reference_runtime_configuration_hash_mismatch');
  }
  const configuration = readImmutableJsonDocument(configurationPath);
  if (configuration?.version !== 1
    || configuration?.kind !== 'AdvancedNumericalPluginRuntimeConfiguration') {
    throw new Error('advanced_numerical_plugin_runtime_configuration_invalid');
  }
  const configDirectory = path.dirname(configurationPath);
  if (!configuration.qualificationPath || !configuration.qualificationTrustStorePath) {
    throw new Error('advanced_numerical_plugin_qualification_configuration_required');
  }
  const bundle = readImmutableJsonDocument(
    configuredPath(configDirectory, configuration.signedBundlePath),
  );
  const trustStore = readImmutableJsonDocument(
    configuredPath(configDirectory, configuration.trustStorePath),
    { maximumBytes: 1024 * 1024 },
  );
  const qualification = readImmutableJsonDocument(
    configuredPath(configDirectory, configuration.qualificationPath),
  );
  const qualificationTrustStore = readImmutableJsonDocument(
    configuredPath(configDirectory, configuration.qualificationTrustStorePath),
    { maximumBytes: 1024 * 1024 },
  );
  const pluginRoot = configuredPath(configDirectory, configuration.pluginRoot);
  const outputRoot = configuredPath(configDirectory, configuration.outputRoot);
  const runtime = runtimeComposer({
    bundle,
    trustStore,
    qualification,
    qualificationTrustStore,
    pluginRoot,
    outputRoot,
    now,
  });
  const capabilities = runtime.runner.capabilities();
  const descriptor = runtime.descriptor;
  if (path.resolve(pluginRoot) !== path.resolve(candidateRoot)
    || descriptor.pluginId !== candidate.pluginId
    || descriptor.pluginVersion !== candidate.pluginVersion
    || descriptor.analysisFamily !== candidate.analysisFamily
    || descriptor.entrypoint.relativePath !== candidate.entrypoint
    || descriptor.entrypoint.sha256 !== candidate.entrypointHash
    || descriptor.sourceIdentity.merkleHash !== candidate.sourceMerkleHash
    || descriptor.sourceIdentity.workspaceManifestHash
      !== candidate.sourceWorkspaceManifestHash
    || capabilities.productionQualified !== true) {
    throw new Error('advanced_numerical_reference_qualification_identity_mismatch');
  }
  return Object.freeze({
    ...candidate,
    status: 'reference_candidate_production_qualified',
    productionQualified: true,
    runtimeExecutableHash: descriptor.runtime.executableHash,
    runtimePackageClosureHash: descriptor.runtime.packageClosureHash,
    signedBundleHash: runtime.verifiedBundle.signedBundleHash,
    qualificationStatementHash:
      capabilities.qualificationStatementHash || null,
    qualificationBlockers: Object.freeze([]),
  });
}

export function inspectAdvancedNumericalReferenceCandidateQualifications({
  candidateRoot,
  candidateManifest,
  candidateSnapshot,
  entrypointHash,
  registryPath = null,
  now = new Date(),
  runtimeComposer = composeAdvancedNumericalPluginRuntime,
} = {}) {
  const candidateManifestHash = hashRecord(
    'AdvancedNumericalReferenceCandidateManifest',
    candidateManifest,
  );
  const baseCandidates = candidateManifest.analysisFamilies.map((analysisFamily) => (
    baseCandidate({
      analysisFamily,
      candidateManifest,
      candidateManifestHash,
      candidateSnapshot,
      entrypointHash,
    })
  ));
  if (!registryPath) return Object.freeze(baseCandidates);
  let registry;
  try {
    registry = readImmutableJsonDocument(path.resolve(registryPath));
    if (!hasExactObjectKeys(registry, REGISTRY_KEYS)
      || registry.version !== 1
      || registry.kind
        !== 'AdvancedNumericalReferenceCandidateQualificationRegistry'
      || !Array.isArray(registry.entries)
      || registry.entries.length !== baseCandidates.length) {
      throw new Error('advanced_numerical_reference_qualification_registry_invalid');
    }
    const families = registry.entries.map((entry) => entry?.analysisFamily);
    if (new Set(families).size !== baseCandidates.length
      || baseCandidates.some((candidate) => !families.includes(candidate.analysisFamily))) {
      throw new Error('advanced_numerical_reference_qualification_registry_coverage_invalid');
    }
  } catch (error) {
    return Object.freeze(baseCandidates.map((candidate) => baseCandidate({
      ...candidate,
      candidateManifest,
      candidateManifestHash,
      candidateSnapshot,
      entrypointHash,
      blockers: [String(error?.message || error)],
    })));
  }
  return Object.freeze(baseCandidates.map((candidate) => {
    const entry = registry.entries.find((item) => (
      item.analysisFamily === candidate.analysisFamily
    ));
    try {
      return inspectEntry({
        candidate,
        candidateRoot,
        entry,
        now,
        registryPath: path.resolve(registryPath),
        runtimeComposer,
      });
    } catch (error) {
      return Object.freeze({
        ...candidate,
        qualificationBlockers: Object.freeze([String(error?.message || error)]),
      });
    }
  }));
}
