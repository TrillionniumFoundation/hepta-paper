#!/usr/bin/env node
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const receiptSchema = path.join(
  repositoryRoot,
  'docs/provider-sandbox/schemas/provider-external-acceptance-receipt-v1.schema.json',
);
const registrySchema = path.join(
  repositoryRoot,
  'docs/provider-sandbox/schemas/provider-external-principal-registry-v1.schema.json',
);
const strictSchema = path.join(
  repositoryRoot,
  'docs/rust/tools/strict_json_schema.py',
);
const maximumDocumentBytes = 4 * 1024 * 1024;
const maximumKeyBytes = 64 * 1024;
const maximumSignatureBytes = 1024;
const roles = Object.freeze([
  'provider_owner',
  'evidence_owner',
  'release_owner',
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('provider_acceptance_canonical_number_invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonical(value[key])}`
    )).join(',')}}`;
  }
  fail('provider_acceptance_canonical_value_invalid');
}

export function canonicalAcceptancePayload(receipt) {
  return Buffer.from(canonical({
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    status: receipt.status,
    exactSubject: receipt.exactSubject,
    providerSubject: receipt.providerSubject,
    evidence: receipt.evidence,
    currentness: receipt.currentness,
    technicalCompanionAccepted: receipt.technicalCompanionAccepted,
    authority: receipt.authority,
  }), 'utf8');
}

export function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function requireAbsoluteCanonical(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail(`provider_acceptance_${label}_path_invalid`);
  }
  return value;
}

function captureRegularFile(source, destination, maximumBytes, label) {
  requireAbsoluteCanonical(source, label);
  let descriptor;
  try {
    descriptor = fs.openSync(
      source,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) {
      fail(`provider_acceptance_${label}_unsafe`);
    }
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(source, { bigint: true });
    if (offset !== Number(before.size)
      || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some((key) => (
        before[key] !== after[key] || before[key] !== named[key]
      ))) {
      fail(`provider_acceptance_${label}_changed`);
    }
    const captured = bytes.subarray(0, offset);
    fs.writeFileSync(destination, captured, { flag: 'wx', mode: 0o600 });
    fs.fsyncSync(fs.openSync(destination, fs.constants.O_RDONLY));
    return captured;
  } catch (error) {
    if (String(error.code).startsWith('provider_acceptance_')) throw error;
    fail(`provider_acceptance_${label}_capture_failed`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function strictValidate(schema, instance, label) {
  const result = spawnSync(
    'python3',
    [strictSchema, '--schema', schema, '--instance', instance],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    fail(`provider_acceptance_${label}_schema_invalid`);
  }
}

function parseCapturedJson(bytes, label) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(`provider_acceptance_${label}_not_object`);
    }
    return value;
  } catch (error) {
    if (String(error.code).startsWith('provider_acceptance_')) throw error;
    fail(`provider_acceptance_${label}_json_invalid`);
  }
}

function parseTimestamp(value, label) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString().replace('.000Z', 'Z') !== value) {
    fail(`provider_acceptance_${label}_timestamp_invalid`);
  }
  return milliseconds;
}

function parseArguments(argv) {
  const expected = new Set([
    '--receipt',
    '--registry',
    '--now',
    '--provider-owner-public-key',
    '--provider-owner-signature',
    '--evidence-owner-public-key',
    '--evidence-owner-signature',
    '--release-owner-public-key',
    '--release-owner-signature',
    '--output',
  ]);
  if (!Array.isArray(argv) || argv.length !== expected.size * 2) {
    fail('provider_acceptance_verifier_usage');
  }
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!expected.has(flag) || Object.hasOwn(values, flag) || typeof value !== 'string') {
      fail('provider_acceptance_verifier_usage');
    }
    values[flag] = value;
  }
  if (Object.keys(values).length !== expected.size) fail('provider_acceptance_verifier_usage');
  return values;
}

function rolePath(argumentsMap, role, suffix) {
  return argumentsMap[`--${role.replaceAll('_', '-')}-${suffix}`];
}

function writeExclusive(file, value) {
  requireAbsoluteCanonical(file, 'verification_output');
  const directory = path.dirname(file);
  if (fs.realpathSync(directory) !== directory) {
    fail('provider_acceptance_verification_output_parent_invalid');
  }
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (String(error.code).startsWith('provider_acceptance_')) throw error;
    fail('provider_acceptance_verification_output_failed');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function verifyProviderExternalAcceptanceReceipt({
  receiptPath,
  registryPath,
  now,
  publicKeyPaths,
  signaturePaths,
  outputPath,
  temporaryParent,
}) {
  const nowMilliseconds = parseTimestamp(now, 'now');
  requireAbsoluteCanonical(temporaryParent, 'temporary_parent');
  if (fs.realpathSync(temporaryParent) !== temporaryParent) {
    fail('provider_acceptance_temporary_parent_invalid');
  }
  const captureRoot = fs.mkdtempSync(path.join(temporaryParent, 'provider-acceptance-verify-'));
  fs.chmodSync(captureRoot, 0o700);
  try {
    const capturedReceiptPath = path.join(captureRoot, 'receipt.json');
    const capturedRegistryPath = path.join(captureRoot, 'registry.json');
    const receiptBytes = captureRegularFile(
      receiptPath,
      capturedReceiptPath,
      maximumDocumentBytes,
      'receipt',
    );
    const registryBytes = captureRegularFile(
      registryPath,
      capturedRegistryPath,
      maximumDocumentBytes,
      'registry',
    );
    strictValidate(receiptSchema, capturedReceiptPath, 'receipt');
    strictValidate(registrySchema, capturedRegistryPath, 'registry');
    const receipt = parseCapturedJson(receiptBytes, 'receipt');
    const registry = parseCapturedJson(registryBytes, 'registry');

    if (JSON.stringify(receipt.exactSubject.mergeParents) !== JSON.stringify([
      receipt.exactSubject.baseCommit,
      receipt.exactSubject.headCommit,
    ])) {
      fail('provider_acceptance_merge_parent_mismatch');
    }
    const observedAt = parseTimestamp(receipt.currentness.observedAt, 'observed_at');
    const validUntil = parseTimestamp(receipt.currentness.validUntil, 'valid_until');
    const registryObservedAt = parseTimestamp(registry.observedAt, 'registry_observed_at');
    if (!(registryObservedAt <= nowMilliseconds
      && observedAt <= nowMilliseconds
      && nowMilliseconds <= validUntil)) {
      fail('provider_acceptance_receipt_not_current');
    }

    const payload = canonicalAcceptancePayload(receipt);
    const payloadSha256 = sha256Bytes(payload);
    const principalIds = new Set();
    const publicKeyDigests = new Set();
    const signatureDigests = new Set();
    const verifiedDecisions = [];
    for (const [index, role] of roles.entries()) {
      const decision = receipt.decisions[index];
      const principal = registry.principals[index];
      if (decision.role !== role || principal.role !== role
        || decision.principalId !== principal.principalId) {
        fail('provider_acceptance_principal_binding_invalid');
      }
      if (decision.signedPayloadSha256 !== payloadSha256) {
        fail('provider_acceptance_signed_payload_hash_invalid');
      }
      if (principalIds.has(principal.principalId)) {
        fail('provider_acceptance_principal_duplicate');
      }
      principalIds.add(principal.principalId);
      const activeFrom = parseTimestamp(principal.activeFrom, `${role}_active_from`);
      const principalValidUntil = parseTimestamp(
        principal.validUntil,
        `${role}_valid_until`,
      );
      const decidedAt = parseTimestamp(decision.decidedAt, `${role}_decided_at`);
      if (!(activeFrom <= decidedAt
        && decidedAt <= observedAt
        && nowMilliseconds <= principalValidUntil)) {
        fail('provider_acceptance_principal_not_current');
      }

      const publicKeyPath = rolePath(publicKeyPaths, role, 'public-key');
      const signaturePath = rolePath(signaturePaths, role, 'signature');
      const keyBytes = captureRegularFile(
        publicKeyPath,
        path.join(captureRoot, `${role}.public.pem`),
        maximumKeyBytes,
        `${role}_public_key`,
      );
      const signatureBytes = captureRegularFile(
        signaturePath,
        path.join(captureRoot, `${role}.signature`),
        maximumSignatureBytes,
        `${role}_signature`,
      );
      const keySha256 = sha256Bytes(keyBytes);
      const signatureSha256 = sha256Bytes(signatureBytes);
      if (keySha256 !== principal.publicKeySha256) {
        fail('provider_acceptance_public_key_hash_invalid');
      }
      if (signatureSha256 !== decision.signatureArtifactSha256) {
        fail('provider_acceptance_signature_hash_invalid');
      }
      if (publicKeyDigests.has(keySha256) || signatureDigests.has(signatureSha256)) {
        fail('provider_acceptance_cryptographic_identity_duplicate');
      }
      publicKeyDigests.add(keySha256);
      signatureDigests.add(signatureSha256);
      let key;
      try {
        key = createPublicKey(keyBytes);
      } catch {
        fail('provider_acceptance_public_key_invalid');
      }
      if (key.asymmetricKeyType !== 'ed25519'
        || !verifySignature(null, payload, key, signatureBytes)) {
        fail('provider_acceptance_signature_invalid');
      }
      verifiedDecisions.push({
        role,
        principalId: principal.principalId,
        publicKeySha256: keySha256,
        signatureArtifactSha256: signatureSha256,
        decidedAt: decision.decidedAt,
        verified: true,
      });
    }

    const result = {
      schemaVersion: 1,
      kind: 'ProviderExternalAcceptanceReceiptVerificationV1',
      status: 'cryptographically_verified_technical_external_acceptance_non_authorizing',
      observedAt: now,
      validUntil: receipt.currentness.validUntil,
      receiptSha256: sha256Bytes(receiptBytes),
      principalRegistrySha256: sha256Bytes(registryBytes),
      signedPayloadSha256: payloadSha256,
      decisions: verifiedDecisions,
      technicalCompanionAccepted: true,
      providerAuthorized: false,
      credentialCustodyEstablished: false,
      externalActionAuthorized: false,
      releaseAuthorized: false,
      submissionAuthorized: false,
      productionAuthorized: false,
      externalAuthorityClaimed: false,
    };
    writeExclusive(outputPath, result);
    return Object.freeze(result);
  } finally {
    fs.rmSync(captureRoot, { recursive: true, force: true });
  }
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const publicKeyPaths = Object.create(null);
    const signaturePaths = Object.create(null);
    for (const role of roles) {
      publicKeyPaths[`--${role.replaceAll('_', '-')}-public-key`] = args[
        `--${role.replaceAll('_', '-')}-public-key`
      ];
      signaturePaths[`--${role.replaceAll('_', '-')}-signature`] = args[
        `--${role.replaceAll('_', '-')}-signature`
      ];
    }
    const result = verifyProviderExternalAcceptanceReceipt({
      receiptPath: args['--receipt'],
      registryPath: args['--registry'],
      now: args['--now'],
      publicKeyPaths,
      signaturePaths,
      outputPath: args['--output'],
      temporaryParent: path.dirname(args['--output']),
    });
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      receiptSha256: result.receiptSha256,
      signedPayloadSha256: result.signedPayloadSha256,
      decisions: result.decisions.length,
      productionAuthorized: false,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || 'provider_acceptance_verification_failed'}\n`);
    process.exitCode = 1;
  }
}
