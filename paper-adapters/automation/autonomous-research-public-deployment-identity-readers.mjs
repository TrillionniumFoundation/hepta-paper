import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,191}$/;
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAXIMUM_CONFIGURATION_BYTES = 1024 * 1024;
const MAXIMUM_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const MAXIMUM_PUBLIC_KEY_BYTES = 64 * 1024;

const COMPONENT_KIND = 'AutonomousResearchPublicDeploymentComponentInspection';

function stableBlocker(error, fallback) {
  const message = String(error?.message || '');
  return /^[a-z][a-z0-9_:-]{1,240}$/.test(message) ? message : fallback;
}

function secureJsonDocument(configPath) {
  const requested = path.resolve(String(configPath || ''));
  let stat;
  let resolved;
  try {
    stat = fs.lstatSync(requested);
    resolved = fs.realpathSync(requested);
  } catch {
    throw new Error('autonomous_research_public_deployment_configuration_file_invalid');
  }
  if (requested !== resolved || !stat.isFile() || stat.isSymbolicLink()
    || stat.nlink !== 1 || stat.size < 2
    || stat.size > MAXIMUM_CONFIGURATION_BYTES || (stat.mode & 0o022) !== 0) {
    throw new Error('autonomous_research_public_deployment_configuration_file_invalid');
  }
  try {
    return Object.freeze({
      configPath: resolved,
      document: JSON.parse(fs.readFileSync(resolved, 'utf8')),
    });
  } catch {
    throw new Error('autonomous_research_public_deployment_configuration_json_invalid');
  }
}

function referencePath(candidate, configPath) {
  const selected = String(candidate || '');
  return path.isAbsolute(selected)
    ? path.resolve(selected) : path.resolve(path.dirname(configPath), selected);
}

function executableIdentity(candidate, configPath) {
  const requested = referencePath(candidate, configPath);
  let resolved;
  let stat;
  try {
    resolved = fs.realpathSync(requested);
    stat = fs.statSync(resolved);
  } catch {
    throw new Error('autonomous_research_public_deployment_executable_invalid');
  }
  if (requested !== resolved || !stat.isFile() || stat.size < 1
    || stat.size > MAXIMUM_EXECUTABLE_BYTES || (stat.mode & 0o022) !== 0
    || (stat.mode & 0o111) === 0) {
    throw new Error('autonomous_research_public_deployment_executable_invalid');
  }
  return Object.freeze({
    executable: resolved,
    executableSha256: hashBytes(fs.readFileSync(resolved)),
  });
}

function publicKeyIdentity(candidate, configPath) {
  const requested = referencePath(candidate, configPath);
  let resolved;
  let stat;
  let pem;
  try {
    resolved = fs.realpathSync(requested);
    stat = fs.statSync(resolved);
    if (requested !== resolved || !stat.isFile() || stat.size < 1
      || stat.size > MAXIMUM_PUBLIC_KEY_BYTES || (stat.mode & 0o022) !== 0) {
      throw new Error('invalid');
    }
    pem = fs.readFileSync(resolved, 'utf8');
  } catch {
    throw new Error('autonomous_research_public_deployment_public_key_invalid');
  }
  if (!/-----BEGIN PUBLIC KEY-----/.test(pem)
    || /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/.test(pem)) {
    throw new Error('autonomous_research_public_deployment_public_key_invalid');
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(pem);
  } catch {
    throw new Error('autonomous_research_public_deployment_public_key_invalid');
  }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('autonomous_research_public_deployment_public_key_invalid');
  }
  return Object.freeze({
    publicKeySpkiHash: hashBytes(publicKey.export({ type: 'spki', format: 'der' })),
  });
}

function canonicalTimestamp(value, label) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`autonomous_research_public_deployment_${label}_timestamp_invalid`);
  }
  return value;
}

function canonicalEnvironmentAllowlist(value) {
  if (!Array.isArray(value) || value.length > 64
    || value.some((item) => !ENVIRONMENT_KEY.test(String(item || '')))) {
    throw new Error('autonomous_research_public_deployment_environment_allowlist_invalid');
  }
  const selected = [...new Set(value.map(String))].sort();
  if (selected.length !== value.length) {
    throw new Error('autonomous_research_public_deployment_environment_allowlist_invalid');
  }
  return Object.freeze(selected);
}

function commandProjection(value, {
  configPath,
  expectedProtocol,
  backend = false,
} = {}) {
  const keys = [
    'args', 'credentialRoot', 'environmentAllowlist', 'executable',
    'principalId', 'protocol', 'serviceId', 'timeoutMs',
    ...(backend ? ['backend'] : []),
  ];
  if (!exactKeys(value, keys) || value.protocol !== expectedProtocol
    || !SAFE_ID.test(String(value.serviceId || ''))
    || !SAFE_ID.test(String(value.principalId || ''))
    || !Array.isArray(value.args) || value.args.length > 64
    || !Number.isSafeInteger(Number(value.timeoutMs))
    || Number(value.timeoutMs) < 1000 || Number(value.timeoutMs) > 12 * 60 * 60 * 1000) {
    throw new Error('autonomous_research_public_deployment_command_invalid');
  }
  // The current process configuration schemas do not distinguish public argv
  // identity from credential-bearing argv.  Reject every non-empty argv until
  // a signed schema classifies each argument as public; never copy or hash raw
  // argument values into a deployment identity.
  if (value.args.length !== 0) {
    throw new Error(
      'autonomous_research_public_deployment_command_arguments_public_classification_required',
    );
  }
  const executable = executableIdentity(value.executable, configPath);
  const credentialRootReference = referencePath(value.credentialRoot, configPath);
  const payload = {
    version: 1,
    serviceId: String(value.serviceId),
    principalId: String(value.principalId),
    protocol: expectedProtocol,
    ...executable,
    // This is only a public configuration reference. The target is deliberately
    // never opened, statted, traversed, or hashed by this module.
    credentialRootReferenceHash: hashRecord(
      'AutonomousResearchPublicCredentialRootReference',
      { path: credentialRootReference },
    ),
    publicArguments: Object.freeze([]),
    environmentAllowlist: canonicalEnvironmentAllowlist(value.environmentAllowlist),
    timeoutMs: Number(value.timeoutMs),
  };
  if (backend) payload.backend = backendProjection(value.backend);
  return Object.freeze(payload);
}

function backendProjection(value) {
  if (!exactKeys(value, [
    'backendId', 'buildkitVersion', 'endpointTlsSpkiHash', 'platform',
    'stateRootIdentityHash', 'workerId',
  ]) || !SAFE_ID.test(String(value.backendId || ''))
    || !SAFE_ID.test(String(value.workerId || ''))
    || !SAFE_ID.test(String(value.buildkitVersion || ''))
    || !SAFE_ID.test(String(value.platform || ''))
    || !SHA256.test(String(value.endpointTlsSpkiHash || ''))
    || !SHA256.test(String(value.stateRootIdentityHash || ''))) {
    throw new Error('autonomous_research_public_deployment_backend_invalid');
  }
  return Object.freeze({
    backendId: String(value.backendId),
    workerId: String(value.workerId),
    buildkitVersion: String(value.buildkitVersion),
    platform: String(value.platform),
    endpointTlsSpkiHash: value.endpointTlsSpkiHash,
    stateRootIdentityHash: value.stateRootIdentityHash,
  });
}

function signerProjection(value, {
  configPath,
  expectedRole,
  statuses = ['active'],
} = {}) {
  const expected = [
    'algorithm', 'effectiveFrom', 'expiresAt', 'keyId', 'keyVersion',
    'organization', 'publicKeyPath', 'revokedAt', 'role', 'status', 'subjectId',
  ];
  if (!exactKeys(value, expected) || !SAFE_ID.test(String(value.keyId || ''))
    || !SAFE_ID.test(String(value.keyVersion || ''))
    || !SAFE_ID.test(String(value.subjectId || ''))
    || typeof value.organization !== 'string' || !value.organization.trim()
    || value.algorithm !== 'ed25519' || value.role !== expectedRole
    || !statuses.includes(value.status)
    || (value.revokedAt !== null && typeof value.revokedAt !== 'string')) {
    throw new Error('autonomous_research_public_deployment_signer_invalid');
  }
  const effectiveFrom = canonicalTimestamp(value.effectiveFrom, 'signer_effective_from');
  const expiresAt = canonicalTimestamp(value.expiresAt, 'signer_expires_at');
  if (Date.parse(expiresAt) <= Date.parse(effectiveFrom)) {
    throw new Error('autonomous_research_public_deployment_signer_window_invalid');
  }
  const revokedAt = value.revokedAt === null
    ? null : canonicalTimestamp(value.revokedAt, 'signer_revoked_at');
  return Object.freeze({
    keyId: String(value.keyId),
    keyVersion: String(value.keyVersion),
    subjectId: String(value.subjectId),
    organization: value.organization.normalize('NFKC').trim().replace(/\s+/g, ' '),
    role: expectedRole,
    algorithm: 'ed25519',
    status: value.status,
    effectiveFrom,
    expiresAt,
    revokedAt,
    ...publicKeyIdentity(value.publicKeyPath, configPath),
  });
}

function finalizedInspection({
  componentId,
  publicConfiguration,
  publicTrustIdentityHash,
  credentialBindingStatus,
  blockers = [],
} = {}) {
  const uniqueBlockers = Object.freeze([...new Set(blockers)].sort());
  const publicConfigurationHash = publicConfiguration
    ? hashRecord('AutonomousResearchPublicDeploymentConfiguration', {
      componentId,
      publicConfiguration,
    }) : null;
  const identityPayload = publicConfigurationHash ? Object.freeze({
    componentId,
    publicConfigurationHash,
    publicTrustIdentityHash,
    credentialBindingStatus,
  }) : null;
  const publicIdentityHash = identityPayload
    ? hashRecord('AutonomousResearchPublicDeploymentComponentIdentity', identityPayload)
    : null;
  const payload = Object.freeze({
    version: 1,
    kind: COMPONENT_KIND,
    componentId,
    status: uniqueBlockers.length
      ? 'autonomous_research_public_deployment_component_blocked'
      : 'autonomous_research_public_deployment_component_ready',
    ready: uniqueBlockers.length === 0,
    publicConfigurationHash,
    publicTrustIdentityHash,
    credentialBindingStatus,
    publicIdentityHash,
    secretMaterialRead: false,
    environmentValuesRead: false,
    externalActionPerformed: false,
    blockers: uniqueBlockers,
  });
  return Object.freeze({
    ...payload,
    inspectionHash: hashRecord(
      'AutonomousResearchPublicDeploymentComponentInspection', payload,
    ),
  });
}

function blockedInspection(componentId, error, fallback) {
  return finalizedInspection({
    componentId,
    publicConfiguration: null,
    publicTrustIdentityHash: null,
    credentialBindingStatus: 'unavailable',
    blockers: [stableBlocker(error, fallback)],
  });
}

function trustSetProjection(value, { configPath, expectedRole } = {}) {
  if (!exactKeys(value, ['keys', 'kind', 'version']) || value.version !== 1
    || value.kind !== 'ResearchExecutionReleaseAttestorTrustSet'
    || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 32) {
    throw new Error('autonomous_research_public_deployment_trust_set_invalid');
  }
  const keys = value.keys.map((key) => signerProjection(key, {
    configPath,
    expectedRole,
    statuses: ['active', 'retiring'],
  })).sort((left, right) => (
    `${left.keyId}:${left.keyVersion}`.localeCompare(`${right.keyId}:${right.keyVersion}`)
  ));
  if (new Set(keys.map((key) => `${key.keyId}:${key.keyVersion}`)).size !== keys.length
    || new Set(keys.map((key) => key.publicKeySpkiHash)).size !== keys.length) {
    throw new Error('autonomous_research_public_deployment_trust_set_collision');
  }
  return Object.freeze(keys);
}

export function inspectExternalResearchQualificationPublicDeploymentIdentity({
  configPath,
} = {}) {
  const componentId = 'external-qualification-process';
  try {
    const loaded = secureJsonDocument(configPath);
    const value = loaded.document;
    if (!exactKeys(value, [
      'kind', 'maximumQualificationCostUsd', 'qualificationCostAuthority',
      'qualifier', 'status', 'trustedSignerTrustSet', 'verifier',
      'verifierAttestor', 'version',
    ]) || value.version !== 3
      || value.kind !== 'ExternalResearchQualificationProcessConfiguration'
      || value.status !== 'active'
      || typeof value.maximumQualificationCostUsd !== 'number'
      || !Number.isFinite(value.maximumQualificationCostUsd)
      || value.maximumQualificationCostUsd < 0
      || !['operator_declared_worst_case_usd', 'externally_operated_zero_cost']
        .includes(value.qualificationCostAuthority)) {
      throw new Error('external_qualification_public_configuration_invalid');
    }
    const qualifier = commandProjection(value.qualifier, {
      configPath: loaded.configPath,
      expectedProtocol: 'external-qualification-json-stdio-v1',
    });
    const verifier = commandProjection(value.verifier, {
      configPath: loaded.configPath,
      expectedProtocol: 'external-qualification-json-stdio-v1',
    });
    const trustedSigners = trustSetProjection(value.trustedSignerTrustSet, {
      configPath: loaded.configPath,
      expectedRole: 'research_execution_release_attestor',
    });
    const verifierAttestor = signerProjection(value.verifierAttestor, {
      configPath: loaded.configPath,
      expectedRole: 'external_qualification_independent_verifier',
    });
    if (qualifier.serviceId === verifier.serviceId
      || qualifier.principalId === verifier.principalId
      || qualifier.executableSha256 === verifier.executableSha256
      || trustedSigners.some((key) => (
        key.publicKeySpkiHash === verifierAttestor.publicKeySpkiHash
      ))) {
      throw new Error('external_qualification_public_independence_invalid');
    }
    const publicTrustIdentityHash = hashRecord(
      'ExternalResearchQualificationPublicTrustIdentity',
      { trustedSigners, verifierAttestor },
    );
    return finalizedInspection({
      componentId,
      publicConfiguration: Object.freeze({
        version: 3,
        qualifier,
        verifier,
        maximumQualificationCostUsd: value.maximumQualificationCostUsd,
        qualificationCostAuthority: value.qualificationCostAuthority,
        publicTrustIdentityHash,
      }),
      publicTrustIdentityHash,
      credentialBindingStatus: 'public_signed_credential_generation_unavailable',
      blockers: [
        'external_qualification_public_credential_generation_or_fingerprint_required',
      ],
    });
  } catch (error) {
    return blockedInspection(
      componentId,
      error,
      'external_qualification_public_deployment_identity_invalid',
    );
  }
}

export function inspectRuntimeImageReproducibilityPublicDeploymentIdentity({
  configPath,
} = {}) {
  const componentId = 'runtime-image-reproducibility-process';
  try {
    const loaded = secureJsonDocument(configPath);
    const value = loaded.document;
    if (!exactKeys(value, [
      'buildArgs', 'kind', 'maximumReceiptAgeMs', 'maximumVerificationCostUsd',
      'platform', 'sourceDateEpoch', 'status', 'verificationCostAuthority',
      'verifiers', 'version',
    ]) || value.version !== 1
      || value.kind !== 'RuntimeImageReproducibilityProcessConfiguration'
      || value.status !== 'active' || value.platform !== 'linux/amd64'
      || Number(value.sourceDateEpoch) !== 1733097600
      || !exactKeys(value.buildArgs, [])
      || !Number.isSafeInteger(Number(value.maximumReceiptAgeMs))
      || typeof value.maximumVerificationCostUsd !== 'number'
      || !Number.isFinite(value.maximumVerificationCostUsd)
      || value.maximumVerificationCostUsd < 0
      || !['operator_declared_worst_case_usd', 'externally_operated_zero_cost']
        .includes(value.verificationCostAuthority)
      || !Array.isArray(value.verifiers) || value.verifiers.length !== 2) {
      throw new Error('runtime_reproducibility_public_configuration_invalid');
    }
    const verifiers = value.verifiers.map((entry) => {
      if (!exactKeys(entry, ['attestor', 'command'])) {
        throw new Error('runtime_reproducibility_public_verifier_invalid');
      }
      return Object.freeze({
        command: commandProjection(entry.command, {
          configPath: loaded.configPath,
          expectedProtocol: 'runtime-image-reproducibility-json-stdio-v1',
          backend: true,
        }),
        attestor: signerProjection(entry.attestor, {
          configPath: loaded.configPath,
          expectedRole: 'runtime_image_reproducibility_external_verifier',
        }),
      });
    }).sort((left, right) => (
      left.command.serviceId.localeCompare(right.command.serviceId)
    ));
    const left = verifiers[0];
    const right = verifiers[1];
    if (left.command.serviceId === right.command.serviceId
      || left.command.principalId === right.command.principalId
      || left.command.executableSha256 === right.command.executableSha256
      || left.command.backend.backendId === right.command.backend.backendId
      || left.command.backend.endpointTlsSpkiHash
        === right.command.backend.endpointTlsSpkiHash
      || left.attestor.publicKeySpkiHash === right.attestor.publicKeySpkiHash
      || left.attestor.organization.toLowerCase() === right.attestor.organization.toLowerCase()) {
      throw new Error('runtime_reproducibility_public_independence_invalid');
    }
    const publicTrustIdentityHash = hashRecord(
      'RuntimeImageReproducibilityPublicTrustIdentity',
      verifiers.map(({ command, attestor }) => Object.freeze({
        serviceId: command.serviceId,
        principalId: command.principalId,
        backend: command.backend,
        attestor,
      })),
    );
    return finalizedInspection({
      componentId,
      publicConfiguration: Object.freeze({
        version: 1,
        platform: value.platform,
        sourceDateEpoch: Number(value.sourceDateEpoch),
        buildArgs: Object.freeze({}),
        maximumReceiptAgeMs: Number(value.maximumReceiptAgeMs),
        maximumVerificationCostUsd: value.maximumVerificationCostUsd,
        verificationCostAuthority: value.verificationCostAuthority,
        verifiers: Object.freeze(verifiers),
        publicTrustIdentityHash,
      }),
      publicTrustIdentityHash,
      credentialBindingStatus: 'public_signed_credential_generation_unavailable',
      blockers: [
        'runtime_reproducibility_public_credential_generation_or_fingerprint_required',
      ],
    });
  } catch (error) {
    return blockedInspection(
      componentId,
      error,
      'runtime_reproducibility_public_deployment_identity_invalid',
    );
  }
}

export function inspectResearchExecutionReleaseAttestorPublicDeploymentIdentity({
  configPath,
} = {}) {
  const componentId = 'research-execution-release-attestor';
  try {
    const loaded = secureJsonDocument(configPath);
    const value = loaded.document;
    if (!exactKeys(value, [
      'attestationLifetimeSeconds', 'backend', 'kind', 'status', 'trustSet', 'version',
    ]) || value.version !== 2
      || value.kind !== 'ResearchExecutionReleaseAttestorConfiguration'
      || value.status !== 'active'
      || !Number.isSafeInteger(Number(value.attestationLifetimeSeconds))
      || Number(value.attestationLifetimeSeconds) < 60) {
      throw new Error('release_attestor_public_configuration_v2_required');
    }
    const backend = value.backend;
    if (!exactKeys(backend, [
      'activeKeyId', 'activeKeyVersion', 'algorithm', 'backendId', 'backendVersion',
      'externalSignerProcess', 'hardwareProtected', 'kind', 'privateKeyExportable',
      'probeAttestor', 'probeCommand', 'signerCommand',
    ]) || backend.kind !== 'external-kms-command'
      || !SAFE_ID.test(String(backend.backendId || ''))
      || !SAFE_ID.test(String(backend.backendVersion || ''))
      || backend.algorithm !== 'ed25519' || backend.hardwareProtected !== true
      || backend.privateKeyExportable !== false
      || backend.externalSignerProcess !== true) {
      throw new Error('release_attestor_public_backend_invalid');
    }
    const trustedSigners = trustSetProjection(value.trustSet, {
      configPath: loaded.configPath,
      expectedRole: 'research_execution_release_attestor',
    });
    const active = trustedSigners.filter((key) => (
      key.status === 'active' && key.revokedAt === null
    ));
    if (active.length !== 1 || active[0].keyId !== backend.activeKeyId
      || active[0].keyVersion !== backend.activeKeyVersion) {
      throw new Error('release_attestor_public_active_key_binding_invalid');
    }
    const signerCommand = commandProjection(backend.signerCommand, {
      configPath: loaded.configPath,
      expectedProtocol: 'hepta-release-signer-json-stdio-v1',
    });
    const probeCommand = commandProjection(backend.probeCommand, {
      configPath: loaded.configPath,
      expectedProtocol: 'hepta-release-signer-probe-json-stdio-v1',
    });
    const probeAttestor = signerProjection(backend.probeAttestor, {
      configPath: loaded.configPath,
      expectedRole: 'research_execution_release_signer_backend_probe_attestor',
    });
    if (signerCommand.serviceId === probeCommand.serviceId
      || signerCommand.principalId === probeCommand.principalId
      || signerCommand.executableSha256 === probeCommand.executableSha256
      || trustedSigners.some((key) => (
        key.publicKeySpkiHash === probeAttestor.publicKeySpkiHash
      ))) {
      throw new Error('release_attestor_public_probe_independence_invalid');
    }
    const publicTrustIdentityHash = hashRecord(
      'ResearchExecutionReleaseAttestorPublicTrustIdentity',
      { trustedSigners, probeAttestor },
    );
    return finalizedInspection({
      componentId,
      publicConfiguration: Object.freeze({
        version: 2,
        attestationLifetimeSeconds: Number(value.attestationLifetimeSeconds),
        backendId: String(backend.backendId),
        backendVersion: String(backend.backendVersion),
        activeKeyId: String(backend.activeKeyId),
        activeKeyVersion: String(backend.activeKeyVersion),
        signerCommand,
        probeCommand,
        publicTrustIdentityHash,
      }),
      publicTrustIdentityHash,
      credentialBindingStatus: 'public_signing_key_bound_transport_credential_unversioned',
      blockers: [
        'release_attestor_public_transport_credential_generation_or_fingerprint_required',
      ],
    });
  } catch (error) {
    return blockedInspection(
      componentId,
      error,
      'release_attestor_public_deployment_identity_invalid',
    );
  }
}

export function buildAutonomousResearchPublicDeploymentComponentInspection({
  componentId,
  publicIdentityHash,
  publicConfigurationHash = publicIdentityHash,
  publicTrustIdentityHash = null,
  credentialBindingStatus = 'not_applicable',
  blockers = [],
} = {}) {
  if (!SAFE_ID.test(String(componentId || ''))
    || !SHA256.test(String(publicIdentityHash || ''))
    || !SHA256.test(String(publicConfigurationHash || ''))
    || (publicTrustIdentityHash !== null
      && !SHA256.test(String(publicTrustIdentityHash || '')))
    || typeof credentialBindingStatus !== 'string' || !credentialBindingStatus
    || !Array.isArray(blockers)
    || blockers.some((blocker) => !/^[a-z][a-z0-9_:-]{1,240}$/.test(String(blocker)))) {
    throw new Error('autonomous_research_public_deployment_component_invalid');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers.map(String))].sort());
  const payload = Object.freeze({
    version: 1,
    kind: COMPONENT_KIND,
    componentId: String(componentId),
    status: uniqueBlockers.length
      ? 'autonomous_research_public_deployment_component_blocked'
      : 'autonomous_research_public_deployment_component_ready',
    ready: uniqueBlockers.length === 0,
    publicConfigurationHash,
    publicTrustIdentityHash,
    credentialBindingStatus,
    publicIdentityHash,
    secretMaterialRead: false,
    environmentValuesRead: false,
    externalActionPerformed: false,
    blockers: uniqueBlockers,
  });
  return Object.freeze({
    ...payload,
    inspectionHash: hashRecord(
      'AutonomousResearchPublicDeploymentComponentInspection', payload,
    ),
  });
}
