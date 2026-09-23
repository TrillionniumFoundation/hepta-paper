import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  immutableAuthoritySigningPayload,
  readImmutableJsonDocument,
} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_SUBMISSION_DISPATCHER_CYCLE_SIGNER_ROLE,
} from '../../paper-domain/automation/autonomous-submission-dispatcher-challenge-contract.mjs';
import {
  readAutonomousSubmissionDispatcherIdentityConfiguration,
  verifyAutonomousSubmissionDispatcherCycleEnvelope,
} from './autonomous-submission-dispatcher-cycle-verifier.mjs';

const CONFIG_KEYS = Object.freeze([
  'identityConfigurationHash', 'identityConfigurationPath', 'kind', 'signer', 'version',
]);
const SIGNER_KEYS = Object.freeze([
  'algorithm', 'arguments', 'backendKind', 'command', 'environmentAllowlist',
  'keyId', 'role', 'timeoutMs',
]);
const RESPONSE_KEYS = Object.freeze([
  'algorithm', 'keyId', 'kind', 'payloadHash', 'role', 'signature', 'version',
]);
const SAFE_ENV = /^[A-Z][A-Z0-9_]{0,127}$/;

function integrityFile(candidate, { executable = false, privateFile = false } = {}) {
  const selected = path.resolve(String(candidate || ''));
  const stat = fs.lstatSync(selected);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(selected) !== selected
    || (stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022) !== 0
    || (privateFile && (stat.mode & 0o077) !== 0)
    || (executable && (stat.mode & 0o111) === 0)) {
    throw new Error('autonomous_submission_dispatcher_cycle_signer_file_invalid');
  }
  return selected;
}

function resolveRelative(candidate, source) {
  return path.isAbsolute(String(candidate || '')) ? path.resolve(String(candidate))
    : path.resolve(path.dirname(source), String(candidate || ''));
}

export function readAutonomousSubmissionDispatcherCycleSigningConfiguration({
  environment = process.env,
  configurationPath = null,
} = {}) {
  const selected = integrityFile(configurationPath
    || environment.HEPTA_SUBMISSION_DISPATCHER_CYCLE_SIGNING_CONFIG, {
    privateFile: true,
  });
  const value = readImmutableJsonDocument(selected, { maximumBytes: 1024 * 1024 });
  const signer = value?.signer;
  const args = Array.isArray(signer?.arguments)
    ? signer.arguments.map(String) : null;
  const allowlist = Array.isArray(signer?.environmentAllowlist)
    ? signer.environmentAllowlist.map(String) : null;
  if (!hasExactObjectKeys(value, CONFIG_KEYS)
    || value.version !== 1
    || value.kind !== 'AutonomousSubmissionDispatcherCycleSigningConfiguration'
    || !hasExactObjectKeys(signer, SIGNER_KEYS)
    || signer.backendKind !== 'external-command-ed25519-v1'
    || signer.algorithm !== 'ed25519'
    || signer.role !== AUTONOMOUS_SUBMISSION_DISPATCHER_CYCLE_SIGNER_ROLE
    || !Array.isArray(args) || args.length > 64
    || !Array.isArray(allowlist) || allowlist.length > 64
    || !allowlist.every((name) => SAFE_ENV.test(name))
    || !Number.isSafeInteger(Number(signer.timeoutMs))
    || Number(signer.timeoutMs) < 1_000 || Number(signer.timeoutMs) > 120_000) {
    throw new Error('autonomous_submission_dispatcher_cycle_signing_configuration_invalid');
  }
  const identityPath = resolveRelative(value.identityConfigurationPath, selected);
  const identity = readAutonomousSubmissionDispatcherIdentityConfiguration({
    configurationPath: identityPath,
  });
  if (identity.configurationHash !== value.identityConfigurationHash
    || identity.signer.keyId !== signer.keyId) {
    throw new Error('autonomous_submission_dispatcher_cycle_signer_identity_mismatch');
  }
  return Object.freeze({
    configurationPath: selected,
    identity,
    signer: Object.freeze({
      ...signer,
      command: integrityFile(resolveRelative(signer.command, selected), { executable: true }),
      arguments: Object.freeze(args),
      environmentAllowlist: Object.freeze(allowlist),
      timeoutMs: Number(signer.timeoutMs),
    }),
  });
}

export function signAutonomousSubmissionDispatcherCycleReceipt({
  receipt,
  challenge,
  signingConfiguration,
  environment = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const payload = immutableAuthoritySigningPayload(receipt);
  const payloadHash = hashBytes(payload);
  const request = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDispatcherCycleSigningRequest',
    keyId: signingConfiguration.signer.keyId,
    role: AUTONOMOUS_SUBMISSION_DISPATCHER_CYCLE_SIGNER_ROLE,
    algorithm: 'ed25519',
    payloadHash,
    payloadBase64: payload.toString('base64'),
  });
  const childEnvironment = Object.fromEntries(
    signingConfiguration.signer.environmentAllowlist
      .filter((name) => environment[name] !== undefined)
      .map((name) => [name, String(environment[name])]),
  );
  const result = spawnSyncImpl(
    signingConfiguration.signer.command,
    signingConfiguration.signer.arguments,
    {
      input: `${JSON.stringify(request)}\n`, encoding: 'utf8',
      timeout: signingConfiguration.signer.timeoutMs, maxBuffer: 256 * 1024,
      windowsHide: true, env: childEnvironment,
    },
  );
  let response;
  try { response = JSON.parse(result?.stdout); } catch { response = null; }
  const signature = Buffer.from(String(response?.signature || ''), 'base64');
  if (result?.status !== 0 || result?.signal || result?.error
    || !hasExactObjectKeys(response, RESPONSE_KEYS)
    || response.version !== 1
    || response.kind !== 'AutonomousSubmissionDispatcherCycleSigningResponse'
    || response.keyId !== signingConfiguration.signer.keyId
    || response.role !== AUTONOMOUS_SUBMISSION_DISPATCHER_CYCLE_SIGNER_ROLE
    || response.algorithm !== 'ed25519' || response.payloadHash !== payloadHash
    || signature.length !== 64
    || signature.toString('base64') !== response.signature) {
    throw new Error('autonomous_submission_dispatcher_cycle_external_signer_failed');
  }
  const envelope = Object.freeze({
    ...receipt,
    signatures: Object.freeze([Object.freeze({
      keyId: response.keyId,
      role: response.role,
      algorithm: response.algorithm,
      value: response.signature,
    })]),
  });
  verifyAutonomousSubmissionDispatcherCycleEnvelope({
    envelope,
    challenge,
    identity: signingConfiguration.identity,
    now: new Date(receipt.signedAt),
    requireReady: false,
  });
  return envelope;
}
