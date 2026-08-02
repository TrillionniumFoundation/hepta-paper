import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY,
  STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER,
  buildStrictFullAutoAcceptancePlan,
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  StrictFullAutoAcceptanceControlStore,
} from './strict-full-auto-acceptance-control-store-repository.mjs';
import {
  inspectStrictFullAutoAcceptanceRootBinding,
  preflightStrictFullAutoAcceptanceInputDirectory,
} from './strict-full-auto-acceptance-root-binding.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
} from './autonomous-submission-portal-public-adapter.mjs';
import {
  verifyAutonomousResearchAuthorIdentityConfiguration,
} from './autonomous-research-author-identity-configuration.mjs';
import {
  readProvisionedReleaseAttestorConfiguration,
} from '../build-package/research-execution-release-attestor-configuration.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SEMANTIC_CONFIGURATION_REFERENCES = new Set([
  'research-author-identity-config',
  'release-attestor-config',
]);
const OBSERVED_CONTENT_HASH = Symbol('strictFullAutoAcceptanceObservedContentHash');

function regularFileNoSymlink(candidate, label) {
  const absolute = path.resolve(candidate);
  let link;
  try {
    link = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new Error(`strict_full_auto_acceptance_reference_missing:${label}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!link.isFile() || link.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    throw new Error(`strict_full_auto_acceptance_reference_not_regular:${label}`);
  }
  return Object.freeze({ absolute, stat: link });
}

function directoryNoSymlink(candidate, label) {
  const absolute = path.resolve(candidate);
  let link;
  try {
    link = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new Error(`strict_full_auto_acceptance_reference_missing:${label}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!link.isDirectory() || link.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    throw new Error(`strict_full_auto_acceptance_reference_not_directory:${label}`);
  }
  return Object.freeze({ absolute, stat: link });
}

function regularFileSnapshot(candidate, inspected, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || String(opened.dev) !== String(inspected.stat.dev)
      || String(opened.ino) !== String(inspected.stat.ino)) {
      throw new Error(`strict_full_auto_acceptance_reference_changed:${label}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    if (String(opened.dev) !== String(completed.dev)
      || String(opened.ino) !== String(completed.ino)
      || String(opened.size) !== String(completed.size)
      || String(opened.mtimeNs) !== String(completed.mtimeNs)
      || String(opened.ctimeNs) !== String(completed.ctimeNs)) {
      throw new Error(`strict_full_auto_acceptance_reference_changed:${label}`);
    }
    return bytes;
  } catch (error) {
    if (String(error?.message || '').startsWith(
      'strict_full_auto_acceptance_reference_changed:',
    )) throw error;
    throw new Error(`strict_full_auto_acceptance_reference_changed:${label}`, {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function contentHash(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function secretMetadataIdentity({ absolute, stat, referenceId, subjectId }) {
  if ((Number(stat.mode) & 0o022) !== 0) {
    throw new Error(`strict_full_auto_acceptance_secret_reference_writable:${referenceId}`);
  }
  if (referenceId.endsWith('-credential-root')
    && ((Number(stat.mode) & 0o077) !== 0
      || String(stat.uid) !== String(process.getuid?.()))) {
    throw new Error(`strict_full_auto_acceptance_credential_root_not_private:${referenceId}`);
  }
  return strictFullAutoAcceptanceHash({
    version: 1,
    kind: 'OpaqueSecretReferenceIdentity',
    referenceId,
    subjectId,
    resolvedPath: absolute,
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: Number(stat.mode) & 0o7777,
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNanoseconds: String(stat.mtimeNs),
  });
}

function inspectReference(referenceId, value) {
  const requiredKind = STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY[referenceId];
  if (!requiredKind) throw new Error(`strict_full_auto_acceptance_reference_unknown:${referenceId}`);
  const publicReference = requiredKind === 'public-reference';
  const privateConfiguration = requiredKind === 'private-configuration-reference';
  const contentReference = publicReference || privateConfiguration;
  const opaqueDirectory = requiredKind === 'opaque-directory-reference';
  const semanticConfiguration = SEMANTIC_CONFIGURATION_REFERENCES.has(referenceId);
  const requiredKeys = contentReference
    ? semanticConfiguration
      ? ['kind', 'path', 'subjectId', 'expectedConfigurationIdentityHash']
      : ['kind', 'path', 'subjectId', 'expectedSha256']
    : ['kind', 'path', 'subjectId'];
  if (!exactKeys(value, requiredKeys) || value.kind !== requiredKind
    || typeof value.path !== 'string' || value.path.length === 0
    || typeof value.subjectId !== 'string' || value.subjectId.length === 0
    || (contentReference && !semanticConfiguration
      && !SHA256.test(String(value.expectedSha256 || '')))
    || (semanticConfiguration
      && !SHA256.test(String(value.expectedConfigurationIdentityHash || '')))) {
    throw new Error(`strict_full_auto_acceptance_reference_configuration_invalid:${referenceId}`);
  }
  const inspected = opaqueDirectory
    ? directoryNoSymlink(value.path, referenceId)
    : regularFileNoSymlink(value.path, referenceId);
  let identity;
  let inspectedContentHash = null;
  let documentPins = Object.freeze({});
  if (contentReference) {
    if ((Number(inspected.stat.mode) & 0o222) !== 0) {
      throw new Error(`strict_full_auto_acceptance_content_reference_mutable:${referenceId}`);
    }
    if (privateConfiguration
      && ((Number(inspected.stat.mode) & 0o077) !== 0
        || String(inspected.stat.uid) !== String(process.getuid?.()))) {
      throw new Error(`strict_full_auto_acceptance_private_config_not_private:${referenceId}`);
    }
    const bytes = regularFileSnapshot(inspected.absolute, inspected, referenceId);
    inspectedContentHash = contentHash(bytes);
    if (!semanticConfiguration && inspectedContentHash !== value.expectedSha256) {
      throw new Error(`strict_full_auto_acceptance_reference_hash_mismatch:${referenceId}`);
    }
    const documentPinRequired = new Set([
      'formal-sandbox-runtime-config',
      'production-mathlib-build-authority-config',
      'autonomous-venue-profile-config',
      'autonomous-submission-metadata-config',
      'submission-portal-descriptor-config',
      'prior-art-service-config',
      'external-replay-config',
      'research-author-identity-config',
      'release-attestor-config',
    ]).has(referenceId);
    if (documentPinRequired) {
      let parsed;
      try { parsed = JSON.parse(bytes.toString('utf8')); }
      catch (error) {
        throw new Error(`strict_full_auto_acceptance_document_pin_invalid:${referenceId}`, {
          cause: error,
        });
      }
      if (documentPinRequired && !semanticConfiguration
        && !/^sha256:[0-9a-f]{64}$/.test(String(parsed?.configurationHash || ''))) {
        throw new Error(`strict_full_auto_acceptance_document_pin_invalid:${referenceId}`);
      }
      if (referenceId === 'research-author-identity-config'
        && (parsed?.version !== 2
          || parsed.kind !== 'AutonomousResearchAuthorIdentityConfiguration'
          || !verifyAutonomousResearchAuthorIdentityConfiguration(parsed)
          || parsed.configurationHash !== value.expectedConfigurationIdentityHash)) {
        throw new Error(`strict_full_auto_acceptance_document_pin_invalid:${referenceId}`);
      }
      const expectedTokenEnvironmentVariable = referenceId === 'prior-art-service-config'
        ? 'HEPTA_PRIOR_ART_SERVICE_TOKEN_FILE'
        : referenceId === 'external-replay-config'
          ? 'HEPTA_EXTERNAL_REPLAY_SERVICE_TOKEN_FILE' : null;
      if (expectedTokenEnvironmentVariable
        && parsed.tokenEnvironmentVariable !== expectedTokenEnvironmentVariable) {
        throw new Error(`strict_full_auto_acceptance_credential_binding_invalid:${referenceId}`);
      }
      documentPins = Object.freeze({
        ...(documentPinRequired ? {
          configurationHash: semanticConfiguration
            ? value.expectedConfigurationIdentityHash
            : parsed.configurationHash,
        } : {}),
        ...(referenceId === 'submission-portal-descriptor-config' ? {
          portalId: parsed.portalId,
          portalDescriptorHash: autonomousSubmissionPortalPublicDescriptorHash(parsed),
        } : {}),
        ...(expectedTokenEnvironmentVariable
          ? { tokenEnvironmentVariable: expectedTokenEnvironmentVariable } : {}),
      });
    }
    identity = strictFullAutoAcceptanceHash({
      referenceId,
      subjectId: value.subjectId,
      resolvedPath: inspected.absolute,
      contentHash: semanticConfiguration
        ? value.expectedConfigurationIdentityHash : inspectedContentHash,
    });
  } else {
    // Opaque references are deliberately never opened or read by this process.
    identity = secretMetadataIdentity({
      ...inspected,
      referenceId,
      subjectId: value.subjectId,
    });
  }
  const binding = {
    referenceId,
    kind: requiredKind,
    subjectId: value.subjectId,
    resolvedPath: inspected.absolute,
    identity,
    contentHash: semanticConfiguration
      ? value.expectedConfigurationIdentityHash : inspectedContentHash,
    documentPins,
  };
  if (inspectedContentHash !== null) {
    Object.defineProperty(binding, OBSERVED_CONTENT_HASH, {
      value: inspectedContentHash,
    });
  }
  return Object.freeze(binding);
}

function validatedConfiguration(configuration) {
  if (!exactKeys(configuration, [
    'version', 'kind', 'controlRoot', 'runtimeRoot', 'assetRoot', 'datasetRoot',
    'operationalEnvironment', 'references', 'steps', 'finalVerification',
  ])
    || configuration.version !== 1
    || configuration.kind !== 'StrictFullAutoAcceptanceConfiguration'
    || typeof configuration.controlRoot !== 'string'
    || !path.isAbsolute(configuration.controlRoot)
    || typeof configuration.runtimeRoot !== 'string'
    || !path.isAbsolute(configuration.runtimeRoot)
    || typeof configuration.assetRoot !== 'string'
    || !path.isAbsolute(configuration.assetRoot)
    || typeof configuration.datasetRoot !== 'string'
    || !path.isAbsolute(configuration.datasetRoot)
    || !configuration.operationalEnvironment
    || typeof configuration.operationalEnvironment !== 'object'
    || Array.isArray(configuration.operationalEnvironment)
    || !configuration.references || Array.isArray(configuration.references)
    || !configuration.steps || Array.isArray(configuration.steps)
    || !configuration.finalVerification
    || typeof configuration.finalVerification !== 'object'
    || Array.isArray(configuration.finalVerification)) {
    throw new Error('strict_full_auto_acceptance_configuration_invalid');
  }
  const referenceIds = Object.keys(configuration.references).sort();
  const expectedReferenceIds = Object.keys(STRICT_FULL_AUTO_ACCEPTANCE_REFERENCE_POLICY).sort();
  if (referenceIds.join('\0') !== expectedReferenceIds.join('\0')) {
    throw new Error('strict_full_auto_acceptance_configuration_reference_set_invalid');
  }
  const stepIds = Object.keys(configuration.steps);
  if (stepIds.length !== STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER.length
    || STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER.some((id) => !configuration.steps[id])) {
    throw new Error('strict_full_auto_acceptance_configuration_step_set_invalid');
  }
  return configuration;
}

function invocationFlagValue(invocation, flag) {
  const index = invocation.arguments.indexOf(flag);
  return index < 0 ? null : invocation.arguments[index + 1];
}

function resolvedConfigurationMember(configurationPath, candidate) {
  return path.isAbsolute(String(candidate || ''))
    ? path.resolve(candidate) : path.resolve(path.dirname(configurationPath), String(candidate));
}

function assertExecutableReference(reference, label) {
  const stat = fs.lstatSync(reference.resolvedPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error(`strict_full_auto_acceptance_executable_reference_invalid:${label}`);
  }
}

function parseBoundJsonReference(reference, label) {
  const inspected = regularFileNoSymlink(reference.resolvedPath, label);
  const bytes = regularFileSnapshot(inspected.absolute, inspected, label);
  if (contentHash(bytes) !== (reference[OBSERVED_CONTENT_HASH] ?? reference.contentHash)) {
    throw new Error(
      `strict_full_auto_acceptance_bound_reference_changed:${reference.referenceId}`,
    );
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`strict_full_auto_acceptance_${label}_invalid`, { cause: error });
  }
}

function assertPrivateAuthorityConfigurations(referenceBindings) {
  const references = new Map(referenceBindings.map((item) => [item.referenceId, item]));
  const empiricalConfig = references.get('empirical-plugin-signing-config');
  const empirical = parseBoundJsonReference(
    empiricalConfig,
    'empirical_signer_config',
  );
  const empiricalCommand = references.get('empirical-plugin-signer-command');
  const empiricalTrust = references.get('empirical-plugin-trust-store');
  if (empirical?.kind !== 'AutonomousEmpiricalPluginSigningAuthorityConfiguration'
    || !Array.isArray(empirical?.signer?.environmentAllowlist)
    || empirical.signer.environmentAllowlist.length !== 0
    || resolvedConfigurationMember(empiricalConfig.resolvedPath, empirical.signer.command)
      !== empiricalCommand.resolvedPath
    || resolvedConfigurationMember(empiricalConfig.resolvedPath, empirical.trustStorePath)
      !== empiricalTrust.resolvedPath) {
    throw new Error('strict_full_auto_acceptance_empirical_signer_config_invalid');
  }
  assertExecutableReference(empiricalCommand, 'empirical-plugin-signer-command');

  const releaseConfig = references.get('release-attestor-config');
  const release = parseBoundJsonReference(
    releaseConfig,
    'release_attestor_config',
  );
  const signer = release?.backend?.signerCommand;
  const probe = release?.backend?.probeCommand;
  const signerRoot = references.get('release-attestor-signer-credential-root');
  const probeRoot = references.get('release-attestor-probe-credential-root');
  const signerCommand = references.get('release-attestor-signer-command');
  const probeCommand = references.get('release-attestor-probe-command');
  const hardwareAuthority = release?.hardwareAuthorityAttestation;
  const hardwareSignerKeyIds = hardwareAuthority?.signerKeyIds;
  const passiveReleaseRead = readProvisionedReleaseAttestorConfiguration({
    configPath: releaseConfig.resolvedPath,
    expectedConfigurationHash: releaseConfig.documentPins.configurationHash,
    requiredConfigurationVersion: 3,
    requiredBackendKind: 'external-kms-command',
    environment: {},
    spawnSyncImpl() {
      throw new Error('strict_full_auto_acceptance_release_attestor_action_forbidden');
    },
  });
  if (!passiveReleaseRead.configuration
    || passiveReleaseRead.blocker !== null
    || passiveReleaseRead.configuration.configurationPinned !== true
    || passiveReleaseRead.configuration.configurationIdentityProfile
      !== 'stable-kms-authority-policy-and-rotating-bundle-v3'
    || release?.version !== 3
    || release.kind !== 'ResearchExecutionReleaseAttestorConfiguration'
    || release?.backend?.kind !== 'external-kms-command'
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/.test(
      String(release.backend.kmsProvider || ''),
    )
    || ![
      release.backend.providerAccountIdentityHash,
      release.backend.keyResourceIdentityHash,
      release.backend.credentialGenerationIdentityHash,
    ].every((value) => SHA256.test(String(value || '')))
    || !exactKeys(hardwareAuthority, [
      'bundlePath', 'challengeHash', 'signerKeyIds', 'trustStoreHash',
    ])
    || ![
      hardwareAuthority.challengeHash,
      hardwareAuthority.trustStoreHash,
    ].every((value) => SHA256.test(String(value || '')))
    || !Array.isArray(hardwareSignerKeyIds)
    || hardwareSignerKeyIds.length < 1
    || new Set(hardwareSignerKeyIds).size !== hardwareSignerKeyIds.length
    || hardwareSignerKeyIds.some((keyId) => (
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/.test(String(keyId || ''))
    ))
    || !Array.isArray(signer?.environmentAllowlist)
    || !Array.isArray(probe?.environmentAllowlist)
    || signer.environmentAllowlist.length !== 0 || probe.environmentAllowlist.length !== 0
    || resolvedConfigurationMember(releaseConfig.resolvedPath, signer.credentialRoot)
      !== signerRoot.resolvedPath
    || resolvedConfigurationMember(releaseConfig.resolvedPath, probe.credentialRoot)
      !== probeRoot.resolvedPath
    || resolvedConfigurationMember(releaseConfig.resolvedPath, signer.executable)
      !== signerCommand.resolvedPath
    || resolvedConfigurationMember(releaseConfig.resolvedPath, probe.executable)
      !== probeCommand.resolvedPath
    || signer.principalId === probe.principalId) {
    throw new Error('strict_full_auto_acceptance_release_attestor_config_invalid');
  }
  assertExecutableReference(signerCommand, 'release-attestor-signer-command');
  assertExecutableReference(probeCommand, 'release-attestor-probe-command');
}

function parseJsonFile(candidate, label, inspected = regularFileNoSymlink(candidate, label)) {
  try {
    return JSON.parse(regularFileSnapshot(
      inspected.absolute,
      inspected,
      label,
    ).toString('utf8'));
  } catch (error) {
    throw new Error(`strict_full_auto_acceptance_${label}_invalid`, { cause: error });
  }
}

export class StrictFullAutoAcceptanceRepository {
  constructor({ configurationPath, controlStore = new StrictFullAutoAcceptanceControlStore() } = {}) {
    this.configurationPath = regularFileNoSymlink(
      configurationPath,
      'configuration',
    ).absolute;
    this.controlStore = controlStore;
  }

  inspectPlan() {
    const inspectedConfiguration = regularFileNoSymlink(
      this.configurationPath,
      'configuration',
    );
    const configuration = validatedConfiguration(parseJsonFile(
      this.configurationPath,
      'configuration',
      inspectedConfiguration,
    ));
    const configurationHash = strictFullAutoAcceptanceHash(configuration);
    const referenceBindings = Object.entries(configuration.references)
      .map(([referenceId, value]) => inspectReference(referenceId, value));
    assertPrivateAuthorityConfigurations(referenceBindings);
    const steps = STRICT_FULL_AUTO_ACCEPTANCE_STEP_ORDER.map((stepId) => Object.freeze({
      stepId,
      ...configuration.steps[stepId],
    }));
    const controlRoot = path.resolve(configuration.controlRoot);
    const runtimeRoot = path.resolve(configuration.runtimeRoot);
    const assetRoot = path.resolve(configuration.assetRoot);
    const datasetRoot = preflightStrictFullAutoAcceptanceInputDirectory(
      configuration.datasetRoot,
      'registered-dataset-root',
    );
    preflightStrictFullAutoAcceptanceInputDirectory(
      invocationFlagValue(configuration.steps['restore-drill'].execute, '--bundle'),
      'restore-drill-bundle',
    );
    return buildStrictFullAutoAcceptancePlan({
      configurationHash,
      controlRoot,
      runtimeRoot,
      assetRoot,
      datasetRoot,
      rootBindings: [
        inspectStrictFullAutoAcceptanceRootBinding(controlRoot, 'control-root', {
          targetRequired: true, accessMode: 'read-write',
        }),
        inspectStrictFullAutoAcceptanceRootBinding(
          runtimeRoot,
          'runtime-root',
          { accessMode: 'read-write' },
        ),
        inspectStrictFullAutoAcceptanceRootBinding(assetRoot, 'asset-root', {
          targetRequired: true, accessMode: 'read-only',
        }),
        inspectStrictFullAutoAcceptanceRootBinding(datasetRoot, 'dataset-root', {
          targetRequired: true, accessMode: 'read-only',
        }),
      ],
      operationalEnvironment: configuration.operationalEnvironment,
      referenceBindings,
      steps,
      finalVerification: configuration.finalVerification,
    });
  }

  statePath(plan) {
    return this.controlStore.statePath(plan);
  }

  receiptPath(plan) {
    return this.controlStore.receiptPath(plan);
  }

  readState(plan) {
    return this.controlStore.readState(plan);
  }

  writeState(plan, state, options) {
    return this.controlStore.writeState(plan, state, options);
  }

  readReceipt(plan) {
    return this.controlStore.readReceipt(plan);
  }

  writeReceipt(plan, receipt, options) {
    return this.controlStore.writeReceipt(plan, receipt, options);
  }

  acquireLease(plan, options) {
    return this.controlStore.acquireLease(plan, options);
  }

  assertLease(plan, lease) {
    return this.controlStore.assertLease(plan, lease);
  }

  renewLease(plan, lease) {
    return this.controlStore.renewLease(plan, lease);
  }

  releaseLease(plan, lease) {
    return this.controlStore.releaseLease(plan, lease);
  }

  ensureIntent(plan, step, options) {
    return this.controlStore.ensureIntent(plan, step, options);
  }

  ensureDispatchStarted(plan, step, options) {
    return this.controlStore.ensureDispatchStarted(plan, step, options);
  }

  assertRuntimeRootAbsent(plan) {
    return this.controlStore.assertRuntimeRootAbsent(plan);
  }

  ensureRuntimeRootActivation(plan, options) {
    return this.controlStore.ensureRuntimeRootActivation(plan, options);
  }

  readRuntimeRootActivation(plan) {
    return this.controlStore.readRuntimeRootActivation(plan);
  }
}
