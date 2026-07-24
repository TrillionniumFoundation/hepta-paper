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
  autonomousSubmissionPortalPublicDescriptorHash,
} from './autonomous-submission-portal-public-adapter.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

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

function fileHash(candidate) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${digest.digest('hex')}`;
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
  const requiredKeys = contentReference
    ? ['kind', 'path', 'subjectId', 'expectedSha256']
    : ['kind', 'path', 'subjectId'];
  if (!exactKeys(value, requiredKeys) || value.kind !== requiredKind
    || typeof value.path !== 'string' || value.path.length === 0
    || typeof value.subjectId !== 'string' || value.subjectId.length === 0
    || (contentReference && !SHA256.test(String(value.expectedSha256 || '')))) {
    throw new Error(`strict_full_auto_acceptance_reference_configuration_invalid:${referenceId}`);
  }
  const inspected = opaqueDirectory
    ? directoryNoSymlink(value.path, referenceId)
    : regularFileNoSymlink(value.path, referenceId);
  let identity;
  let contentHash = null;
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
    contentHash = fileHash(inspected.absolute);
    if (contentHash !== value.expectedSha256) {
      throw new Error(`strict_full_auto_acceptance_reference_hash_mismatch:${referenceId}`);
    }
    const documentPinRequired = new Set([
      'research-author-principal',
      'formal-sandbox-runtime-config',
      'production-mathlib-build-authority-config',
      'autonomous-venue-profile-config',
      'autonomous-submission-metadata-config',
      'submission-portal-descriptor-config',
      'prior-art-service-config',
      'external-replay-config',
    ]).has(referenceId);
    if (documentPinRequired) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(inspected.absolute, 'utf8')); }
      catch (error) {
        throw new Error(`strict_full_auto_acceptance_document_pin_invalid:${referenceId}`, {
          cause: error,
        });
      }
      if (documentPinRequired
        && !/^sha256:[0-9a-f]{64}$/.test(String(parsed?.configurationHash || ''))) {
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
        ...(documentPinRequired ? { configurationHash: parsed.configurationHash } : {}),
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
      contentHash,
    });
  } else {
    // Opaque references are deliberately never opened or read by this process.
    identity = secretMetadataIdentity({
      ...inspected,
      referenceId,
      subjectId: value.subjectId,
    });
  }
  return Object.freeze({
    referenceId,
    kind: requiredKind,
    subjectId: value.subjectId,
    resolvedPath: inspected.absolute,
    identity,
    contentHash,
    documentPins,
  });
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

function directoryAnchor(candidate, rootId, {
  targetRequired = false,
  accessMode,
} = {}) {
  const resolvedPath = path.resolve(candidate);
  if (!['read-only', 'read-write'].includes(accessMode)) {
    throw new Error(`strict_full_auto_acceptance_root_access_mode_invalid:${rootId}`);
  }
  if (resolvedPath === path.parse(resolvedPath).root) {
    throw new Error(`strict_full_auto_acceptance_root_too_broad:${rootId}`);
  }
  const anchorKind = targetRequired ? 'target' : 'parent';
  const anchorPath = targetRequired ? resolvedPath : path.dirname(resolvedPath);
  let stat;
  try {
    stat = fs.lstatSync(anchorPath, { bigint: true });
  } catch (error) {
    throw new Error(`strict_full_auto_acceptance_root_anchor_missing:${rootId}`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(anchorPath) !== anchorPath
    || (Number(stat.mode) & 0o022) !== 0
    || String(stat.uid) !== String(process.getuid?.())) {
    throw new Error(`strict_full_auto_acceptance_root_anchor_invalid:${rootId}`);
  }
  let futureTarget = null;
  if (!targetRequired) {
    try { futureTarget = fs.lstatSync(resolvedPath); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  if (futureTarget) {
    const target = futureTarget;
    if (!target.isDirectory() || target.isSymbolicLink()
      || fs.realpathSync(resolvedPath) !== resolvedPath
      || (Number(target.mode) & 0o022) !== 0
      || String(target.uid) !== String(process.getuid?.())) {
      throw new Error(`strict_full_auto_acceptance_future_root_target_invalid:${rootId}`);
    }
  }
  const body = Object.freeze({
    rootId,
    accessMode,
    resolvedPath,
    anchorKind,
    anchorPath,
    anchorRealPath: fs.realpathSync(anchorPath),
    anchorDevice: String(stat.dev),
    anchorInode: String(stat.ino),
    anchorMode: Number(stat.mode) & 0o7777,
    anchorUid: String(stat.uid),
  });
  return Object.freeze({ ...body, identity: strictFullAutoAcceptanceHash(body) });
}

function preflightInputDirectory(candidate, label) {
  const absolute = path.resolve(String(candidate || ''));
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) {
    throw new Error(`strict_full_auto_acceptance_input_directory_missing:${label}`, {
      cause: error,
    });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    throw new Error(`strict_full_auto_acceptance_input_directory_invalid:${label}`);
  }
  return absolute;
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

function assertPrivateAuthorityConfigurations(referenceBindings) {
  const references = new Map(referenceBindings.map((item) => [item.referenceId, item]));
  const empiricalConfig = references.get('empirical-plugin-signing-config');
  let empirical;
  try { empirical = JSON.parse(fs.readFileSync(empiricalConfig.resolvedPath, 'utf8')); }
  catch (error) {
    throw new Error('strict_full_auto_acceptance_empirical_signer_config_invalid', {
      cause: error,
    });
  }
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
  let release;
  try { release = JSON.parse(fs.readFileSync(releaseConfig.resolvedPath, 'utf8')); }
  catch (error) {
    throw new Error('strict_full_auto_acceptance_release_attestor_config_invalid', {
      cause: error,
    });
  }
  const signer = release?.backend?.signerCommand;
  const probe = release?.backend?.probeCommand;
  const signerRoot = references.get('release-attestor-signer-credential-root');
  const probeRoot = references.get('release-attestor-probe-credential-root');
  const signerCommand = references.get('release-attestor-signer-command');
  const probeCommand = references.get('release-attestor-probe-command');
  if (release?.version !== 2
    || release.kind !== 'ResearchExecutionReleaseAttestorConfiguration'
    || release?.backend?.kind !== 'external-kms-command'
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

function parseJsonFile(candidate, label) {
  try {
    return JSON.parse(fs.readFileSync(candidate, 'utf8'));
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
    const configuration = validatedConfiguration(parseJsonFile(
      this.configurationPath,
      'configuration',
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
    const datasetRoot = preflightInputDirectory(
      configuration.datasetRoot,
      'registered-dataset-root',
    );
    preflightInputDirectory(
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
        directoryAnchor(controlRoot, 'control-root', {
          targetRequired: true, accessMode: 'read-write',
        }),
        directoryAnchor(runtimeRoot, 'runtime-root', { accessMode: 'read-write' }),
        directoryAnchor(assetRoot, 'asset-root', {
          targetRequired: true, accessMode: 'read-only',
        }),
        directoryAnchor(datasetRoot, 'dataset-root', {
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
