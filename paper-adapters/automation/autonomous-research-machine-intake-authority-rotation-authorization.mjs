import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../authority/authority-signatures.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ROTATOR_ROLE = 'autonomous_research_intake_authority_rotator';
const MAXIMUM_INTENT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAXIMUM_BOOTSTRAP_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;
const MAXIMUM_DOCUMENT_BYTES = 1024 * 1024;
const PRODUCTION_AUTHORITY_ROOT = '/etc/hepta-paper/authority-rotation';
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,255}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SIGNATURE_KEYS = Object.freeze(['algorithm', 'keyId', 'role', 'value'].sort());
const TRUST_STORE_KEYS = Object.freeze(['keys', 'kind', 'version'].sort());
const TRUST_KEY_KEYS = Object.freeze([
  'algorithm', 'effectiveFrom', 'expiresAt', 'keyId', 'organization', 'publicKeyPem',
  'revokedAt', 'roles', 'status', 'subjectId',
].sort());
const BOOTSTRAP_KEYS = Object.freeze([
  'expectedAuthorityGeneration', 'expiresAt', 'kind', 'nonce',
  'ownerTrustStoreHash', 'previousConfigurationHash', 'rotationTrustStoreHash', 'rotatorKeyIds',
  'rotatorKeySnapshotHash', 'signatures', 'signedAt', 'status', 'validFrom', 'version',
].sort());
const INTENT_KEYS = Object.freeze([
  'authorityAnchorHash', 'authorityTrustStoreHash', 'bootstrapReceiptHash',
  'expectedAuthorityGeneration', 'expiresAt', 'kind', 'nextAuthorityGeneration',
  'nextConfigurationHash', 'nextImplementationSha256', 'nextProducerProfileHash',
  'nextProviderConfigurationHash', 'nonce', 'planHash', 'postStateHash', 'preStateHash',
  'previousConfigurationHash', 'previousProducerProfileHash',
  'previousRotationReceiptHash', 'quiescenceStateHash', 'rotatorKeySnapshotHash',
  'signatures', 'signedAt', 'status', 'transition', 'validFrom', 'version',
].sort());

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function observedDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_clock_invalid');
  }
  return date;
}

function canonicalInstant(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validSignature(signature) {
  if (!exactKeys(signature, SIGNATURE_KEYS) || signature.algorithm !== 'ed25519'
    || !SAFE_ID.test(String(signature.keyId || ''))
    || !SAFE_ID.test(String(signature.role || ''))
    || !BASE64.test(String(signature.value || ''))) return false;
  try {
    const bytes = Buffer.from(signature.value, 'base64');
    return bytes.length === 64 && bytes.toString('base64') === signature.value;
  } catch { return false; }
}

function validatedTrustStore(trustStore, { now, requiredRoles, label }) {
  const blockers = [];
  if (!exactKeys(trustStore, TRUST_STORE_KEYS) || trustStore.version !== 1
    || trustStore.kind !== 'AuthorityTrustStore' || !Array.isArray(trustStore.keys)
    || trustStore.keys.length < 1 || trustStore.keys.length > 64) {
    blockers.push(`${label}_structure_invalid`);
  }
  const ids = new Set();
  const eligible = [];
  const nowMs = observedDate(now).getTime();
  for (const key of Array.isArray(trustStore?.keys) ? trustStore.keys : []) {
    const effectiveFrom = Date.parse(String(key?.effectiveFrom || ''));
    const expiresAt = Date.parse(String(key?.expiresAt || ''));
    let publicKey = null;
    try { publicKey = crypto.createPublicKey(String(key?.publicKeyPem || '')); } catch { /* invalid */ }
    const roles = Array.isArray(key?.roles) ? key.roles : [];
    const rolesCanonical = roles.length > 0 && roles.every((role) => SAFE_ID.test(String(role)))
      && JSON.stringify(roles) === JSON.stringify([...new Set(roles)].sort());
    const structurallyValid = exactKeys(key, TRUST_KEY_KEYS)
      && SAFE_ID.test(String(key.keyId || '')) && SAFE_ID.test(String(key.subjectId || ''))
      && (key.organization === null
        || (typeof key.organization === 'string' && key.organization.length > 0))
      && key.algorithm === 'ed25519' && key.status === 'active' && key.revokedAt === null
      && canonicalInstant(key.effectiveFrom) && canonicalInstant(key.expiresAt)
      && effectiveFrom < expiresAt && effectiveFrom <= nowMs && nowMs < expiresAt
      && rolesCanonical && publicKey?.asymmetricKeyType === 'ed25519'
      && !/PRIVATE KEY/.test(String(key.publicKeyPem || ''));
    if (!structurallyValid || ids.has(String(key?.keyId || ''))) {
      blockers.push(`${label}_key_invalid`);
    } else {
      ids.add(key.keyId);
      eligible.push(key);
    }
  }
  for (const role of requiredRoles) {
    if (!eligible.some((key) => key.roles.includes(role))) blockers.push(`${label}_role_missing`);
  }
  if (blockers.length) {
    throw new Error(
      `autonomous_research_machine_intake_authority_rotation_${[
        ...new Set(blockers),
      ].join(',')}`,
    );
  }
  return Object.freeze([...eligible].sort(
    (left, right) => left.keyId.localeCompare(right.keyId),
  ));
}

function signerKeyValidAt(keys, signer, signedAt, now) {
  const key = keys.find((candidate) => candidate.keyId === signer?.keyId);
  const signedAtMs = Date.parse(String(signedAt || ''));
  const nowMs = observedDate(now).getTime();
  return Boolean(key && Number.isFinite(signedAtMs)
    && Date.parse(key.effectiveFrom) <= signedAtMs && signedAtMs < Date.parse(key.expiresAt)
    && Date.parse(key.effectiveFrom) <= nowMs && nowMs < Date.parse(key.expiresAt)
    && key.revokedAt === null && key.status === 'active');
}

function assertProductionAuthorityPath(candidate, { file = false } = {}) {
  const requested = path.resolve(candidate);
  const components = requested.split(path.sep).filter(Boolean);
  let cursor = path.parse(requested).root;
  const rootIdentity = fs.lstatSync(cursor);
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() || rootIdentity.uid !== 0
    || (rootIdentity.mode & 0o022) !== 0 || fs.realpathSync(cursor) !== cursor) {
    throw new Error('authority_path_identity_invalid');
  }
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    const identity = fs.lstatSync(cursor);
    const expectedFile = file && index === components.length - 1;
    if (identity.isSymbolicLink() || identity.uid !== 0 || (identity.mode & 0o022) !== 0
      || (expectedFile ? (!identity.isFile() || identity.nlink !== 1) : !identity.isDirectory())
      || fs.realpathSync(cursor) !== cursor) throw new Error('authority_path_identity_invalid');
  }
}

function secureDocument(candidate, label, { productionAuthority = false } = {}) {
  const requested = path.resolve(String(candidate || ''));
  let descriptor = null;
  try {
    if (productionAuthority) assertProductionAuthorityPath(requested, { file: true });
    const canonical = fs.realpathSync(requested);
    const identity = fs.lstatSync(requested);
    if (requested !== canonical || !identity.isFile() || identity.isSymbolicLink()
      || identity.nlink !== 1 || (identity.mode & 0o022) !== 0
      || identity.size < 2 || identity.size > MAXIMUM_DOCUMENT_BYTES) throw new Error();
    descriptor = fs.openSync(
      canonical,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino
      || opened.uid !== identity.uid || opened.mode !== identity.mode
      || opened.size !== identity.size || opened.mtimeMs !== identity.mtimeMs
      || opened.ctimeMs !== identity.ctimeMs) throw new Error();
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || bytes.length !== opened.size) throw new Error();
    return Object.freeze({ path: canonical, document: JSON.parse(bytes.toString('utf8')) });
  } catch (error) {
    if (productionAuthority && error?.code === 'ENOENT') {
      throw new Error('autonomous_research_machine_intake_authority_rotation_bootstrap_required');
    }
    throw new Error(`autonomous_research_machine_intake_authority_rotation_${label}_invalid`);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function rotatorSnapshot(keys) {
  return Object.freeze(keys.map((key) => Object.freeze({
    keyId: String(key.keyId),
    subjectId: String(key.subjectId),
    organization: key.organization ? String(key.organization) : null,
    algorithm: 'ed25519',
    publicKeyPem: String(key.publicKeyPem),
    roles: Object.freeze([...new Set(key.roles.map(String))].sort()),
    status: 'active',
    effectiveFrom: key.effectiveFrom,
    expiresAt: key.expiresAt,
    revokedAt: null,
  })));
}

function timeBlockers(document, now, maximumLifetimeMs) {
  const verification = verifyAuthorityTimeWindow({
    signedAt: document?.signedAt,
    validFrom: document?.validFrom,
    expiresAt: document?.expiresAt,
    now,
    maximumLifetimeMs,
  });
  const blockers = [...verification.blockers];
  const signedAt = Date.parse(String(document?.signedAt || ''));
  const validFrom = Date.parse(String(document?.validFrom || ''));
  if (Number.isFinite(signedAt) && Number.isFinite(validFrom) && validFrom < signedAt) {
    blockers.push('authority_valid_from_before_signature');
  }
  if (Number.isFinite(signedAt) && signedAt > observedDate(now).getTime()) {
    blockers.push('authority_signed_in_future');
  }
  return blockers;
}

function fixedPaths(root = PRODUCTION_AUTHORITY_ROOT) {
  const authorityRoot = path.resolve(root);
  return Object.freeze({
    rotationTrustStore: path.join(authorityRoot, 'AUTHORITY_TRUST_STORE.json'),
    ownerTrustStore: path.join(authorityRoot, 'OWNER_TRUST_STORE.json'),
    bootstrapReceipt: path.join(authorityRoot,
      'AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_BOOTSTRAP.json'),
    genesisEnvelope: path.join(authorityRoot,
      'AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_GENESIS.json'),
  });
}

export function loadAutonomousResearchMachineIntakeExternalAuthorityDocuments({
  genesisRequired = false,
} = {}) {
  if (typeof genesisRequired !== 'boolean') {
    throw new Error('autonomous_research_machine_intake_external_authority_request_invalid');
  }
  const paths = fixedPaths();
  const read = (candidate, label) => secureDocument(candidate, label, {
    productionAuthority: true,
  }).document;
  const result = {
    authorityRoot: PRODUCTION_AUTHORITY_ROOT,
    rotationTrustStore: read(paths.rotationTrustStore, 'rotation_trust_store'),
    ownerTrustStore: read(paths.ownerTrustStore, 'owner_trust_store'),
    bootstrapReceipt: read(paths.bootstrapReceipt, 'bootstrap_receipt'),
    genesisEnvelope: null,
  };
  if (genesisRequired) result.genesisEnvelope = read(
    paths.genesisEnvelope,
    'genesis_envelope',
  );
  return Object.freeze(result);
}

function loadAuthorizationAtRoot({
  authorityRoot,
  productionAuthority,
  previousConfigurationHash,
  expectedAuthorityGeneration,
  now = new Date(),
} = {}) {
  if (!SHA256.test(String(previousConfigurationHash || ''))
    || !Number.isSafeInteger(expectedAuthorityGeneration)
    || expectedAuthorityGeneration < 1) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_anchor_input_invalid');
  }
  const paths = fixedPaths(authorityRoot);
  const rotationTrustStore = secureDocument(
    paths.rotationTrustStore,
    'rotation_trust_store',
    { productionAuthority },
  ).document;
  const ownerTrustStore = secureDocument(paths.ownerTrustStore, 'owner_trust_store', {
    productionAuthority,
  }).document;
  const bootstrapReceipt = secureDocument(paths.bootstrapReceipt, 'bootstrap_receipt', {
    productionAuthority,
  }).document;
  const trustNow = observedDate(now);
  const rotationKeys = validatedTrustStore(rotationTrustStore, {
    now: trustNow,
    requiredRoles: [ROTATOR_ROLE],
    label: 'rotation_trust_store_invalid',
  });
  const ownerKeys = validatedTrustStore(ownerTrustStore, {
    now: trustNow,
    requiredRoles: ['capability_owner', 'operational_observer'],
    label: 'owner_trust_store_invalid',
  });
  const rotatorKeys = rotationKeys.filter((key) => key.roles.includes(ROTATOR_ROLE));
  const snapshot = rotatorSnapshot(rotatorKeys);
  const rotationTrustStoreHash = hashRecord('AuthorityTrustStore', rotationTrustStore);
  const ownerTrustStoreHash = hashRecord('AuthorityTrustStore', ownerTrustStore);
  const rotatorKeySnapshotHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotatorKeySnapshot',
    snapshot,
  );
  const blockers = [];
  if (!exactKeys(bootstrapReceipt, BOOTSTRAP_KEYS)
    || bootstrapReceipt.version !== 1
    || bootstrapReceipt.kind
      !== 'AutonomousResearchMachineIntakeAuthorityRotationBootstrapReceipt'
    || bootstrapReceipt.status !== 'external_rotation_authority_bootstrap_verified'
    || !NONCE.test(String(bootstrapReceipt.nonce || ''))
    || !canonicalInstant(bootstrapReceipt.signedAt)
    || !canonicalInstant(bootstrapReceipt.validFrom)
    || !canonicalInstant(bootstrapReceipt.expiresAt)
    || !Array.isArray(bootstrapReceipt.signatures)
    || bootstrapReceipt.signatures.length !== 2
    || !bootstrapReceipt.signatures.every(validSignature)
    || !Array.isArray(bootstrapReceipt.rotatorKeyIds)
    || bootstrapReceipt.rotatorKeyIds.some((keyId) => !SAFE_ID.test(String(keyId)))
    || JSON.stringify(bootstrapReceipt.rotatorKeyIds)
      !== JSON.stringify([...new Set(bootstrapReceipt.rotatorKeyIds)].sort())) {
    blockers.push('rotation_bootstrap_structure_invalid');
  }
  if (bootstrapReceipt?.previousConfigurationHash !== previousConfigurationHash
    || bootstrapReceipt?.expectedAuthorityGeneration !== expectedAuthorityGeneration
    || bootstrapReceipt?.rotationTrustStoreHash !== rotationTrustStoreHash
    || bootstrapReceipt?.ownerTrustStoreHash !== ownerTrustStoreHash
    || bootstrapReceipt?.rotatorKeySnapshotHash !== rotatorKeySnapshotHash
    || JSON.stringify(bootstrapReceipt?.rotatorKeyIds)
      !== JSON.stringify(rotatorKeys.map((key) => String(key.keyId)))) {
    blockers.push('rotation_bootstrap_binding_mismatch');
  }
  blockers.push(...timeBlockers(
    bootstrapReceipt,
    now,
    MAXIMUM_BOOTSTRAP_LIFETIME_MS,
  ).map((blocker) => `rotation_bootstrap:${blocker}`));
  const bootstrapSignatures = verifyAuthoritySignatures({
    document: bootstrapReceipt,
    trustStore: ownerTrustStore,
    requiredRoles: ['capability_owner', 'operational_observer'],
    minSignatures: 2,
    requireDistinctSubjects: true,
  });
  blockers.push(...bootstrapSignatures.blockers.map(
    (blocker) => `rotation_bootstrap:${blocker}`,
  ));
  if (bootstrapSignatures.verifiedSignatures.some(
    (signer) => !signerKeyValidAt(ownerKeys, signer, bootstrapReceipt?.signedAt, trustNow),
  )) blockers.push('rotation_bootstrap:signer_key_time_window_invalid');
  if (blockers.length) {
    throw new Error(
      `autonomous_research_machine_intake_authority_rotation_bootstrap_invalid:${[
        ...new Set(blockers),
      ].join(',')}`,
    );
  }
  const bootstrapReceiptHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationBootstrapReceipt',
    bootstrapReceipt,
  );
  const authorityAnchorHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationAnchor',
    {
      bootstrapReceiptHash,
      previousConfigurationHash,
      expectedAuthorityGeneration,
      rotationTrustStoreHash,
      ownerTrustStoreHash,
      rotatorKeySnapshotHash,
    },
  );
  return Object.freeze({
    authorityRoot: path.resolve(authorityRoot),
    rotationTrustStore,
    rotationTrustStoreHash,
    ownerTrustStore,
    ownerTrustStoreHash,
    rotatorPublicKeySnapshot: snapshot,
    rotatorKeySnapshotHash,
    bootstrapReceipt: Object.freeze(bootstrapReceipt),
    bootstrapReceiptHash,
    bootstrapVerifiedSigners: Object.freeze(bootstrapSignatures.verifiedSignatures.map(
      (signer) => Object.freeze({
        keyId: signer.keyId,
        subjectId: signer.subjectId,
        organization: signer.organization,
        role: signer.role,
      }),
    )),
    authorityAnchorHash,
    requiredRotatorRole: ROTATOR_ROLE,
    privateKeyLoaded: false,
  });
}

export function loadAutonomousResearchIntakeRotationAuthorization(input = {}) {
  return loadAuthorizationAtRoot({
    ...input,
    authorityRoot: PRODUCTION_AUTHORITY_ROOT,
    productionAuthority: true,
  });
}

export function buildAutonomousResearchIntakeRotationIntentTemplate(plan, now = new Date()) {
  const signedAt = observedDate(now);
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchMachineIntakeAuthorityRotationIntent',
    status: 'autonomous_research_machine_intake_authority_rotation_authorized',
    transition: plan.transition,
    planHash: plan.planHash,
    previousConfigurationHash: plan.previousConfigurationHash,
    previousProducerProfileHash: plan.previousProducerProfileHash,
    previousRotationReceiptHash: plan.previousRotationReceiptHash,
    nextConfigurationHash: plan.nextConfigurationHash,
    nextProducerProfileHash: plan.nextProducerProfileHash,
    nextProviderConfigurationHash: plan.nextProviderConfigurationHash,
    nextImplementationSha256: plan.nextImplementationSha256,
    expectedAuthorityGeneration: plan.expectedAuthorityGeneration,
    nextAuthorityGeneration: plan.nextAuthorityGeneration,
    preStateHash: plan.preStateHash,
    quiescenceStateHash: plan.quiescenceStateHash,
    postStateHash: plan.postStateHash,
    authorityTrustStoreHash: plan.authorityTrustStoreHash,
    bootstrapReceiptHash: plan.bootstrapReceiptHash,
    authorityAnchorHash: plan.authorityAnchorHash,
    rotatorKeySnapshotHash: plan.rotatorKeySnapshotHash,
    nonce: `rotation:${crypto.randomUUID()}`,
    signedAt: signedAt.toISOString(),
    validFrom: signedAt.toISOString(),
    expiresAt: new Date(signedAt.getTime() + MAXIMUM_INTENT_LIFETIME_MS).toISOString(),
    signatures: Object.freeze([]),
  });
}

export function verifyAutonomousResearchIntakeRotationIntent({
  rotationIntentPath,
  plan,
  authorization,
  now = new Date(),
} = {}) {
  const intent = secureDocument(rotationIntentPath, 'intent').document;
  const blockers = [];
  if (!exactKeys(intent, INTENT_KEYS) || intent.version !== 1
    || intent.kind !== 'AutonomousResearchMachineIntakeAuthorityRotationIntent'
    || intent.status !== 'autonomous_research_machine_intake_authority_rotation_authorized'
    || !NONCE.test(String(intent.nonce || '')) || !canonicalInstant(intent.signedAt)
    || !canonicalInstant(intent.validFrom) || !canonicalInstant(intent.expiresAt)
    || !Array.isArray(intent.signatures) || intent.signatures.length !== 1
    || !intent.signatures.every(validSignature)) {
    blockers.push('rotation_intent_structure_invalid');
  }
  const bindings = [
    ['planHash', plan.planHash],
    ['transition', plan.transition],
    ['previousConfigurationHash', plan.previousConfigurationHash],
    ['previousProducerProfileHash', plan.previousProducerProfileHash],
    ['previousRotationReceiptHash', plan.previousRotationReceiptHash],
    ['nextConfigurationHash', plan.nextConfigurationHash],
    ['nextProducerProfileHash', plan.nextProducerProfileHash],
    ['nextProviderConfigurationHash', plan.nextProviderConfigurationHash],
    ['nextImplementationSha256', plan.nextImplementationSha256],
    ['expectedAuthorityGeneration', plan.expectedAuthorityGeneration],
    ['nextAuthorityGeneration', plan.nextAuthorityGeneration],
    ['preStateHash', plan.preStateHash],
    ['quiescenceStateHash', plan.quiescenceStateHash],
    ['postStateHash', plan.postStateHash],
    ['authorityTrustStoreHash', authorization.rotationTrustStoreHash],
    ['bootstrapReceiptHash', authorization.bootstrapReceiptHash],
    ['authorityAnchorHash', authorization.authorityAnchorHash],
    ['rotatorKeySnapshotHash', authorization.rotatorKeySnapshotHash],
  ];
  if (bindings.some(([key, expected]) => intent?.[key] !== expected)) {
    blockers.push('rotation_intent_plan_binding_mismatch');
  }
  blockers.push(...timeBlockers(intent, now, MAXIMUM_INTENT_LIFETIME_MS)
    .map((blocker) => `rotation_intent:${blocker}`));
  const signatures = verifyAuthoritySignatures({
    document: intent,
    trustStore: authorization.rotationTrustStore,
    requiredRoles: [ROTATOR_ROLE],
    minSignatures: 1,
  });
  blockers.push(...signatures.blockers.map((blocker) => `rotation_intent:${blocker}`));
  if (signatures.verifiedSignatures.length !== 1
    || signatures.verifiedSignatures[0]?.role !== ROTATOR_ROLE) {
    blockers.push('rotation_intent_verified_signer_invalid');
  }
  if (signatures.verifiedSignatures.some((signer) => !signerKeyValidAt(
    authorization.rotatorPublicKeySnapshot,
    signer,
    intent?.signedAt,
    now,
  ))) blockers.push('rotation_intent_signer_key_time_window_invalid');
  if (blockers.length) {
    throw new Error(
      `autonomous_research_machine_intake_authority_rotation_intent_invalid:${[
        ...new Set(blockers),
      ].join(',')}`,
    );
  }
  const signer = signatures.verifiedSignatures[0];
  return Object.freeze({
    intent: Object.freeze(intent),
    intentHash: hashRecord('AutonomousResearchMachineIntakeAuthorityRotationIntent', intent),
    signer: Object.freeze({
      keyId: signer.keyId,
      subjectId: signer.subjectId,
      organization: signer.organization,
      role: signer.role,
    }),
  });
}
