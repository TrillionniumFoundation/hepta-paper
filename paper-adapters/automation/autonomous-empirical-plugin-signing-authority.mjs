import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  immutableAuthoritySigningPayload,
  readImmutableJsonDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_EMPIRICAL_PLUGIN_AUTHORITY_ROLE,
} from '../../paper-domain/automation/autonomous-empirical-plugin-release-contract.mjs';

const CONFIGURATION_KEYS = Object.freeze([
  'authorityLifetimeMs', 'kind', 'signer', 'trustStorePath', 'version',
]);
const SIGNER_KEYS = Object.freeze([
  'algorithm', 'arguments', 'backendKind', 'command', 'environmentAllowlist',
  'keyId', 'role', 'timeoutMs',
]);
const RESPONSE_KEYS = Object.freeze([
  'algorithm', 'keyId', 'kind', 'payloadHash', 'role', 'signature', 'version',
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,191}$/;
const SAFE_ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAXIMUM_AUTHORITY_LIFETIME_MS = 366 * 24 * 60 * 60 * 1_000;

function resolveRelative(candidate, configurationPath) {
  return path.isAbsolute(String(candidate || ''))
    ? path.resolve(String(candidate))
    : path.resolve(path.dirname(configurationPath), String(candidate || ''));
}

function integrityFile(candidate, {
  maximumBytes,
  requireExecutable = false,
  requirePrivate = false,
  allowRootOwner = false,
} = {}) {
  const requested = path.resolve(String(candidate || ''));
  let stat;
  try {
    stat = fs.lstatSync(requested);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink()
      || (stat.uid !== currentUid && !(allowRootOwner && stat.uid === 0))
      || stat.size < 1 || stat.size > maximumBytes
      || fs.realpathSync(requested) !== requested
      || (stat.mode & 0o022) !== 0
      || (requirePrivate && (stat.mode & 0o077) !== 0)
      || (requireExecutable && (stat.mode & 0o100) === 0)) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('autonomous_empirical_plugin_signing_integrity_file_invalid');
  }
  return requested;
}

function safeStringArray(values, matcher, maximum, { unique = true } = {}) {
  if (!Array.isArray(values) || values.length > maximum) return null;
  const selected = values.map((value) => String(value));
  return selected.every((value) => matcher.test(value))
    && (!unique || new Set(selected).size === selected.length)
    ? Object.freeze(selected) : null;
}

function trustKeyFor(trustStore, keyId) {
  if (trustStore?.version !== 1 || trustStore?.kind !== 'AuthorityTrustStore'
    || !Array.isArray(trustStore.keys)) return null;
  const matches = trustStore.keys.filter((key) => key?.keyId === keyId);
  if (matches.length !== 1) return null;
  const key = matches[0];
  if (key.algorithm !== 'ed25519' || key.status !== 'active'
    || !Array.isArray(key.roles)
    || !key.roles.includes(AUTONOMOUS_EMPIRICAL_PLUGIN_AUTHORITY_ROLE)
    || key.privateKeyPem || /PRIVATE KEY/.test(String(key.publicKeyPem || ''))) return null;
  return key;
}

export function readAutonomousEmpiricalPluginSigningAuthorityConfiguration({
  configurationPath,
} = {}) {
  const selectedConfigurationPath = integrityFile(configurationPath, {
    maximumBytes: 1024 * 1024,
    requirePrivate: true,
  });
  const value = readImmutableJsonDocument(selectedConfigurationPath, {
    maximumBytes: 1024 * 1024,
  });
  const signer = value?.signer;
  const authorityLifetimeMs = Number(value?.authorityLifetimeMs);
  const args = safeStringArray(signer?.arguments, /^.{0,4096}$/s, 64, { unique: false });
  const environmentAllowlist = safeStringArray(
    signer?.environmentAllowlist, SAFE_ENVIRONMENT_NAME, 64,
  );
  if (!hasExactObjectKeys(value, CONFIGURATION_KEYS)
    || value.version !== 1
    || value.kind !== 'AutonomousEmpiricalPluginSigningAuthorityConfiguration'
    || !hasExactObjectKeys(signer, SIGNER_KEYS)
    || signer.backendKind !== 'external-command-ed25519-v1'
    || signer.algorithm !== 'ed25519'
    || signer.role !== AUTONOMOUS_EMPIRICAL_PLUGIN_AUTHORITY_ROLE
    || !SAFE_ID.test(String(signer.keyId || ''))
    || !args || !environmentAllowlist
    || !Number.isSafeInteger(Number(signer.timeoutMs))
    || Number(signer.timeoutMs) < 1_000 || Number(signer.timeoutMs) > 120_000
    || !Number.isSafeInteger(authorityLifetimeMs)
    || authorityLifetimeMs < 60_000
    || authorityLifetimeMs > MAXIMUM_AUTHORITY_LIFETIME_MS) {
    throw new Error('autonomous_empirical_plugin_signing_configuration_invalid');
  }
  const command = integrityFile(resolveRelative(signer.command, selectedConfigurationPath), {
    maximumBytes: 64 * 1024 * 1024,
    requireExecutable: true,
    allowRootOwner: true,
  });
  const trustStorePath = integrityFile(
    resolveRelative(value.trustStorePath, selectedConfigurationPath),
    { maximumBytes: 1024 * 1024, allowRootOwner: true },
  );
  const trustStore = readImmutableJsonDocument(trustStorePath, {
    maximumBytes: 1024 * 1024,
  });
  if (!trustKeyFor(trustStore, signer.keyId)) {
    throw new Error('autonomous_empirical_plugin_signing_trust_anchor_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousEmpiricalPluginSigningAuthorityInspection',
    backendKind: signer.backendKind,
    keyId: signer.keyId,
    role: signer.role,
    algorithm: signer.algorithm,
    command,
    arguments: args,
    environmentAllowlist,
    timeoutMs: Number(signer.timeoutMs),
    authorityLifetimeMs,
    trustStorePath,
    trustStoreHash: hashRecord('AutonomousEmpiricalPluginTrustStore', trustStore),
    privateKeyMaterialLoadedByHepta: false,
  };
  return Object.freeze({
    configurationPath: selectedConfigurationPath,
    signer: Object.freeze({
      ...signer,
      command,
      arguments: args,
      environmentAllowlist,
      timeoutMs: Number(signer.timeoutMs),
    }),
    authorityLifetimeMs,
    trustStorePath,
    trustStore,
    inspection: Object.freeze({
      ...payload,
      autonomousEmpiricalPluginSigningAuthorityInspectionHash: hashRecord(
        'AutonomousEmpiricalPluginSigningAuthorityInspection', payload,
      ),
    }),
  });
}

function commandEnvironment(names, environment) {
  return Object.fromEntries(names
    .filter((name) => environment?.[name] !== undefined)
    .map((name) => [name, String(environment[name])]));
}

export function signAutonomousEmpiricalPluginAuthorityDocument({
  document,
  signingAuthority,
  environment = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const payload = immutableAuthoritySigningPayload(document);
  const payloadHash = hashBytes(payload);
  const request = Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalPluginSigningRequest',
    keyId: signingAuthority?.signer?.keyId,
    role: AUTONOMOUS_EMPIRICAL_PLUGIN_AUTHORITY_ROLE,
    algorithm: 'ed25519',
    payloadHash,
    payloadBase64: payload.toString('base64'),
  });
  const result = spawnSyncImpl(
    signingAuthority.signer.command,
    signingAuthority.signer.arguments,
    {
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
      timeout: signingAuthority.signer.timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: commandEnvironment(signingAuthority.signer.environmentAllowlist, environment),
    },
  );
  if (result?.status !== 0 || result?.signal || result?.error
    || typeof result?.stdout !== 'string' || result.stdout.length > 256 * 1024) {
    throw new Error('autonomous_empirical_plugin_external_signer_failed');
  }
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw new Error('autonomous_empirical_plugin_external_signer_response_invalid'); }
  const encoded = String(response?.signature || '');
  const signature = Buffer.from(encoded, 'base64');
  if (!hasExactObjectKeys(response, RESPONSE_KEYS)
    || response.version !== 1
    || response.kind !== 'AutonomousEmpiricalPluginSigningResponse'
    || response.keyId !== signingAuthority.signer.keyId
    || response.role !== AUTONOMOUS_EMPIRICAL_PLUGIN_AUTHORITY_ROLE
    || response.algorithm !== 'ed25519'
    || response.payloadHash !== payloadHash
    || signature.length !== 64 || signature.toString('base64') !== encoded) {
    throw new Error('autonomous_empirical_plugin_external_signer_response_invalid');
  }
  return Object.freeze({
    keyId: response.keyId,
    role: response.role,
    algorithm: response.algorithm,
    value: encoded,
  });
}
