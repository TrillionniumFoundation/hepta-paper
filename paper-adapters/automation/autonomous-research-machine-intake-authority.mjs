import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../authority/authority-signatures.mjs';
import {
  loadAutonomousResearchMachineIntakeExternalAuthorityDocuments,
} from './autonomous-research-machine-intake-authority-rotation-authorization.mjs';
import {
  BOOTSTRAP_KEYS,
  exactEvidenceKeys as exactKeys,
  GENESIS_ENVELOPE_KEYS,
  GENESIS_PAYLOAD_KEYS,
  INTENT_KEYS,
  PLAN_KEYS,
  RECEIPT_KEYS,
  SIGNATURE_KEYS,
  TRUST_KEY_KEYS,
  TRUST_STORE_KEYS,
} from './autonomous-research-machine-intake-authority-evidence.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{15,255}$/;
const MAXIMUM_INTENT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAXIMUM_BOOTSTRAP_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function exactPublicTrustStore(trustStore, minimumKeys = 2) {
  if (!exactKeys(trustStore, TRUST_STORE_KEYS) || trustStore.version !== 1
    || trustStore.kind !== 'AuthorityTrustStore' || !Array.isArray(trustStore.keys)
    || trustStore.keys.length < minimumKeys) return false;
  const ids = new Set();
  return trustStore.keys.every((key) => {
    if (!exactKeys(key, TRUST_KEY_KEYS) || ids.has(key.keyId)) return false;
    ids.add(key.keyId);
    return key.algorithm === 'ed25519' && key.status === 'active' && key.revokedAt === null
      && canonicalInstant(key.effectiveFrom) && canonicalInstant(key.expiresAt)
      && Date.parse(key.effectiveFrom) < Date.parse(key.expiresAt)
      && typeof key.publicKeyPem === 'string' && !/PRIVATE KEY/.test(key.publicKeyPem)
      && Array.isArray(key.roles) && key.roles.length > 0;
  });
}

function historicalWindowValid(document, verifiedAt, maximumLifetimeMs) {
  if (!canonicalInstant(document?.signedAt) || !canonicalInstant(document?.validFrom)
    || !canonicalInstant(document?.expiresAt) || !canonicalInstant(verifiedAt)) return false;
  const signedAt = Date.parse(document.signedAt);
  const validFrom = Date.parse(document.validFrom);
  const observedAt = Date.parse(verifiedAt);
  return signedAt <= validFrom && signedAt <= observedAt
    && verifyAuthorityTimeWindow({
      signedAt: document.signedAt,
      validFrom: document.validFrom,
      expiresAt: document.expiresAt,
      now: new Date(observedAt),
      maximumLifetimeMs,
    }).blockers.length === 0;
}

function authorityStateInvalid() {
  throw new Error('autonomous_research_machine_intake_authority_state_invalid');
}

function parseEvidence(value, { array = false } = {}) {
  try {
    const parsed = JSON.parse(value);
    if (array ? !Array.isArray(parsed) : (!parsed || typeof parsed !== 'object'
      || Array.isArray(parsed))) authorityStateInvalid();
    return parsed;
  } catch { return authorityStateInvalid(); }
}

function sameEvidence(left, right) {
  return hashRecord('AutonomousResearchMachineIntakeAuthorityEvidenceEquality', left)
    === hashRecord('AutonomousResearchMachineIntakeAuthorityEvidenceEquality', right);
}

function signerWindowValid(trustStore, signer, signedAt, verifiedAt) {
  const key = trustStore?.keys?.find((candidate) => candidate.keyId === signer?.keyId);
  const effective = Date.parse(String(key?.effectiveFrom || ''));
  const expires = Date.parse(String(key?.expiresAt || ''));
  const signed = Date.parse(String(signedAt || ''));
  const verified = Date.parse(String(verifiedAt || ''));
  const revoked = key?.revokedAt === null ? Number.POSITIVE_INFINITY
    : Date.parse(String(key?.revokedAt || ''));
  return key?.status === 'active' && key?.algorithm === 'ed25519'
    && [effective, expires, signed, verified].every(Number.isFinite)
    && (key.revokedAt === null || Number.isFinite(revoked))
    && effective <= signed && signed < expires && signed < revoked
    && effective <= verified && verified < expires && verified < revoked;
}

function verifyExternalGenesisAuthority({
  documents,
  configurationHash,
  producerProfileHash,
  verificationTime,
}) {
  const envelope = documents?.genesisEnvelope;
  const ownerTrustStore = documents?.ownerTrustStore;
  const ownerTrustStoreHash = hashRecord('AuthorityTrustStore', ownerTrustStore);
  const structureValid = exactKeys(envelope, GENESIS_ENVELOPE_KEYS)
    && envelope.version === 1
    && envelope.kind === 'AutonomousResearchMachineIntakeAuthorityGenesisEnvelope'
    && envelope.status === 'external_genesis_authority_verified'
    && envelope.configurationHash === configurationHash
    && envelope.producerProfileHash === producerProfileHash
    && envelope.authorityGeneration === 1
    && envelope.ownerTrustStoreHash === ownerTrustStoreHash
    && NONCE.test(String(envelope.nonce || ''))
    && canonicalInstant(envelope.signedAt) && canonicalInstant(envelope.validFrom)
    && canonicalInstant(envelope.expiresAt)
    && Array.isArray(envelope.signatures) && envelope.signatures.length === 2
    && envelope.signatures.every((signature) => exactKeys(signature, SIGNATURE_KEYS))
    && exactPublicTrustStore(ownerTrustStore);
  const historicalTimeValid = historicalWindowValid(
    envelope,
    verificationTime?.toISOString?.(),
    MAXIMUM_BOOTSTRAP_LIFETIME_MS,
  );
  const signatures = verifyAuthoritySignatures({
    document: envelope,
    trustStore: ownerTrustStore,
    requiredRoles: ['capability_owner', 'operational_observer'],
    minSignatures: 2,
    requireDistinctSubjects: true,
  });
  const signers = signatures.verifiedSignatures.map((signer) => Object.freeze({
    keyId: signer.keyId,
    subjectId: signer.subjectId,
    organization: signer.organization,
    role: signer.role,
  }));
  if (!structureValid || !historicalTimeValid || signatures.blockers.length
    || signatures.verifiedSignatures.length !== 2
    || signatures.verifiedSignatures.some((signer) => !signerWindowValid(
      ownerTrustStore,
      signer,
      envelope?.signedAt,
      verificationTime,
    ))) authorityStateInvalid();
  return Object.freeze({
    envelope,
    envelopeHash: hashRecord(
      'AutonomousResearchMachineIntakeAuthorityGenesisEnvelope',
      envelope,
    ),
    ownerTrustStore,
    ownerTrustStoreHash,
    verifiedSigners: Object.freeze(signers),
  });
}

function verifyRotationJournalEvidence(row) {
  const plan = parseEvidence(row.plan_json);
  const intent = parseEvidence(row.rotation_intent_json);
  const bootstrap = parseEvidence(row.bootstrap_receipt_json);
  const ownerTrust = parseEvidence(row.owner_trust_store_snapshot_json);
  const rotationTrust = parseEvidence(row.rotation_trust_store_snapshot_json);
  const rotatorSnapshot = parseEvidence(row.rotator_public_key_snapshot_json, { array: true });
  const persistedBootstrapSigners = parseEvidence(
    row.bootstrap_verified_signers_json,
    { array: true },
  );
  const persistedSigner = parseEvidence(row.verified_signer_json);
  const receipt = parseEvidence(row.rotation_receipt_json);
  const readinessArrays = [
    'activeMachineLeases', 'activeSupervisorLeases', 'activeTopicLeases',
    'outstandingTopicGenerations', 'identityConflicts',
  ];
  const quarantineIds = plan.quarantinedLegacyMachineIntakeIds;
  const canonicalQuarantineIds = Array.isArray(quarantineIds)
    && quarantineIds.every((value) => typeof value === 'string' && value.length > 0)
    && JSON.stringify(quarantineIds) === JSON.stringify([...new Set(quarantineIds)].sort());
  const planStructureValid = exactKeys(plan, PLAN_KEYS) && plan.version === 1
    && plan.kind === 'AutonomousResearchMachineIntakeAuthorityRotationPlan'
    && plan.transition === 'v1-to-v2' && plan.expectedAuthorityGeneration === 1
    && plan.nextAuthorityGeneration === 2 && typeof plan.datasetRoot === 'string'
    && plan.datasetRoot.startsWith('/') && canonicalQuarantineIds
    && Array.isArray(plan.targetSourceIdentities)
    && typeof plan.topicProducerDatabasePresent === 'boolean'
    && readinessArrays.every((key) => Array.isArray(plan[key]) && plan[key].length === 0);
  const bootstrapStructureValid = exactKeys(bootstrap, BOOTSTRAP_KEYS)
    && bootstrap.version === 1
    && bootstrap.kind === 'AutonomousResearchMachineIntakeAuthorityRotationBootstrapReceipt'
    && bootstrap.status === 'external_rotation_authority_bootstrap_verified'
    && NONCE.test(String(bootstrap.nonce || ''))
    && historicalWindowValid(bootstrap, row.rotated_at, MAXIMUM_BOOTSTRAP_LIFETIME_MS)
    && Array.isArray(bootstrap.signatures) && bootstrap.signatures.length === 2
    && bootstrap.signatures.every((signature) => exactKeys(signature, SIGNATURE_KEYS))
    && Array.isArray(bootstrap.rotatorKeyIds) && bootstrap.rotatorKeyIds.length > 0
    && JSON.stringify(bootstrap.rotatorKeyIds)
      === JSON.stringify([...new Set(bootstrap.rotatorKeyIds)].sort());
  const intentStructureValid = exactKeys(intent, INTENT_KEYS) && intent.version === 1
    && intent.kind === 'AutonomousResearchMachineIntakeAuthorityRotationIntent'
    && intent.status === 'autonomous_research_machine_intake_authority_rotation_authorized'
    && NONCE.test(String(intent.nonce || ''))
    && historicalWindowValid(intent, row.rotated_at, MAXIMUM_INTENT_LIFETIME_MS)
    && Array.isArray(intent.signatures) && intent.signatures.length === 1
    && intent.signatures.every((signature) => exactKeys(signature, SIGNATURE_KEYS));
  const receiptStructureValid = exactKeys(receipt, RECEIPT_KEYS) && receipt.version === 1
    && receipt.kind === 'AutonomousResearchMachineIntakeAuthorityRotationReceipt'
    && receipt.status === 'autonomous_research_machine_intake_authority_rotated'
    && receipt.externalActionPerformed === false && canonicalInstant(receipt.rotatedAt)
    && receipt.datasetRoot === plan.datasetRoot
    && Number.isSafeInteger(receipt.quarantinedLegacyMachineAdmissionCount)
    && receipt.quarantinedLegacyMachineAdmissionCount === quarantineIds?.length;
  const snapshotStructureValid = exactPublicTrustStore(ownerTrust)
    && exactPublicTrustStore(rotationTrust, 1) && rotatorSnapshot.length > 0
    && rotatorSnapshot.every((key) => exactKeys(key, TRUST_KEY_KEYS)
      && rotationTrust.keys.some((trusted) => sameEvidence(key, trusted)))
    && JSON.stringify(rotatorSnapshot.map((key) => key.keyId))
      === JSON.stringify(bootstrap.rotatorKeyIds);
  const { planHash, ...planPayload } = plan;
  const { rotationReceiptHash, ...receiptPayload } = receipt;
  const computedPlanHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationPlan',
    planPayload,
  );
  const computedIntentHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationIntent',
    intent,
  );
  const computedBootstrapHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationBootstrapReceipt',
    bootstrap,
  );
  const computedOwnerTrustHash = hashRecord('AuthorityTrustStore', ownerTrust);
  const computedRotationTrustHash = hashRecord('AuthorityTrustStore', rotationTrust);
  const computedSnapshotHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotatorKeySnapshot',
    rotatorSnapshot,
  );
  const computedAnchorHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationAnchor',
    {
      bootstrapReceiptHash: computedBootstrapHash,
      previousConfigurationHash: row.previous_configuration_hash,
      expectedAuthorityGeneration: row.authority_generation - 1,
      rotationTrustStoreHash: computedRotationTrustHash,
      ownerTrustStoreHash: computedOwnerTrustHash,
      rotatorKeySnapshotHash: computedSnapshotHash,
    },
  );
  const computedReceiptHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationReceipt',
    receiptPayload,
  );
  const hashesValid = planHash === row.plan_hash && computedPlanHash === row.plan_hash
    && computedIntentHash === row.rotation_intent_hash
    && computedBootstrapHash === row.bootstrap_receipt_hash
    && computedOwnerTrustHash === row.owner_trust_store_hash
    && computedRotationTrustHash === row.authority_trust_store_hash
    && computedSnapshotHash === row.rotator_key_snapshot_hash
    && computedAnchorHash === row.authority_anchor_hash
    && rotationReceiptHash === row.rotation_receipt_hash
    && computedReceiptHash === row.rotation_receipt_hash;
  const planBindings = [
    ['transition', row.transition],
    ['expectedAuthorityGeneration', row.authority_generation - 1],
    ['nextAuthorityGeneration', row.authority_generation],
    ['previousConfigurationHash', row.previous_configuration_hash],
    ['previousProducerProfileHash', row.previous_producer_profile_hash],
    ['previousRotationReceiptHash', row.previous_rotation_receipt_hash],
    ['nextConfigurationHash', row.next_configuration_hash],
    ['nextProducerProfileHash', row.next_producer_profile_hash],
    ['nextProviderConfigurationHash', row.next_provider_configuration_hash],
    ['nextImplementationSha256', row.next_implementation_sha256],
    ['authorityTrustStoreHash', row.authority_trust_store_hash],
    ['ownerTrustStoreHash', row.owner_trust_store_hash],
    ['bootstrapReceiptHash', row.bootstrap_receipt_hash],
    ['authorityAnchorHash', row.authority_anchor_hash],
    ['rotatorKeySnapshotHash', row.rotator_key_snapshot_hash],
    ['preStateHash', row.pre_state_hash],
    ['quiescenceStateHash', row.quiescence_state_hash],
    ['postStateHash', row.post_state_hash],
  ];
  const intentBindings = [
    'transition', 'planHash', 'expectedAuthorityGeneration', 'nextAuthorityGeneration',
    'previousConfigurationHash', 'previousProducerProfileHash',
    'previousRotationReceiptHash', 'nextConfigurationHash', 'nextProducerProfileHash',
    'nextProviderConfigurationHash', 'nextImplementationSha256', 'preStateHash',
    'quiescenceStateHash', 'postStateHash', 'authorityTrustStoreHash',
    'bootstrapReceiptHash', 'authorityAnchorHash', 'rotatorKeySnapshotHash',
  ];
  const bindingsValid = planBindings.every(([key, value]) => plan[key] === value)
    && intentBindings.every((key) => intent[key] === plan[key])
    && intent.nonce === row.intent_nonce
    && bootstrap.previousConfigurationHash === row.previous_configuration_hash
    && bootstrap.expectedAuthorityGeneration === row.authority_generation - 1
    && bootstrap.rotationTrustStoreHash === row.authority_trust_store_hash
    && bootstrap.ownerTrustStoreHash === row.owner_trust_store_hash
    && bootstrap.rotatorKeySnapshotHash === row.rotator_key_snapshot_hash
    && receipt.planHash === row.plan_hash && sameEvidence(receipt.plan, plan)
    && receipt.transition === row.transition
    && receipt.authorityGeneration === row.authority_generation
    && receipt.previousConfigurationHash === row.previous_configuration_hash
    && receipt.previousProducerProfileHash === row.previous_producer_profile_hash
    && receipt.previousRotationReceiptHash === row.previous_rotation_receipt_hash
    && receipt.nextConfigurationHash === row.next_configuration_hash
    && receipt.nextProducerProfileHash === row.next_producer_profile_hash
    && receipt.nextProviderConfigurationHash === row.next_provider_configuration_hash
    && receipt.nextImplementationSha256 === row.next_implementation_sha256
    && receipt.rotationIntentHash === row.rotation_intent_hash
    && receipt.rotationIntentNonce === row.intent_nonce
    && receipt.bootstrapReceiptHash === row.bootstrap_receipt_hash
    && receipt.authorityAnchorHash === row.authority_anchor_hash
    && receipt.ownerTrustStoreHash === row.owner_trust_store_hash
    && receipt.authorityTrustStoreHash === row.authority_trust_store_hash
    && receipt.rotatorKeySnapshotHash === row.rotator_key_snapshot_hash
    && sameEvidence(receipt.bootstrapReceipt, bootstrap)
    && sameEvidence(receipt.ownerTrustStoreSnapshot, ownerTrust)
    && sameEvidence(receipt.rotationTrustStoreSnapshot, rotationTrust)
    && sameEvidence(receipt.rotatorPublicKeySnapshot, rotatorSnapshot)
    && sameEvidence(receipt.bootstrapVerifiedSignerIdentities, persistedBootstrapSigners)
    && sameEvidence(receipt.verifiedSignerIdentity, persistedSigner)
    && receipt.preStateHash === row.pre_state_hash
    && receipt.quiescenceStateHash === row.quiescence_state_hash
    && receipt.postStateHash === row.post_state_hash
    && receipt.quarantinedLegacyMachineAdmissionCount
      === row.quarantined_legacy_machine_admission_count
    && receipt.rotatedAt === row.rotated_at
    && row.rotated_at === intent.validFrom;
  const bootstrapSignatures = verifyAuthoritySignatures({
    document: bootstrap,
    trustStore: ownerTrust,
    requiredRoles: ['capability_owner', 'operational_observer'],
    minSignatures: 2,
    requireDistinctSubjects: true,
  });
  const intentSignatures = verifyAuthoritySignatures({
    document: intent,
    trustStore: rotationTrust,
    requiredRoles: ['autonomous_research_intake_authority_rotator'],
    minSignatures: 1,
  });
  const verifiedSigner = intentSignatures.verifiedSignatures[0];
  const actualBootstrapSigners = bootstrapSignatures.verifiedSignatures.map((signer) => ({
    keyId: signer.keyId,
    subjectId: signer.subjectId,
    organization: signer.organization,
    role: signer.role,
  }));
  const actualSigner = verifiedSigner ? {
    keyId: verifiedSigner.keyId,
    subjectId: verifiedSigner.subjectId,
    organization: verifiedSigner.organization,
    role: verifiedSigner.role,
  } : null;
  const signaturesValid = bootstrapSignatures.blockers.length === 0
    && intentSignatures.blockers.length === 0
    && bootstrapSignatures.verifiedSignatures.length === 2
    && intentSignatures.verifiedSignatures.length === 1
    && bootstrapSignatures.verifiedSignatures.every(
      (signer) => signerWindowValid(ownerTrust, signer, bootstrap.signedAt, row.rotated_at),
    )
    && signerWindowValid(rotationTrust, verifiedSigner, intent.signedAt, row.rotated_at)
    && verifiedSigner?.keyId === row.verified_signer_key_id
    && verifiedSigner?.subjectId === row.verified_signer_subject_id
    && verifiedSigner?.role === row.verified_signer_role
    && sameEvidence(actualBootstrapSigners, persistedBootstrapSigners)
    && sameEvidence(actualSigner, persistedSigner);
  if (!planStructureValid || !bootstrapStructureValid || !intentStructureValid
    || !receiptStructureValid || !snapshotStructureValid
    || !hashesValid || !bindingsValid || !signaturesValid) authorityStateInvalid();
}

export function readConfiguredSourceAuthorityHash(database) {
  if (!database?.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='autonomous_research_machine_intake_metadata'`).get()) {
    return null;
  }
  const value = database.prepare(`SELECT configured_source_authority_hash
    FROM autonomous_research_machine_intake_metadata WHERE singleton=1`).get()
    ?.configured_source_authority_hash || null;
  if (value !== null && !SHA256.test(String(value))) {
    throw new Error('autonomous_research_machine_intake_state_invalid');
  }
  return value;
}

export function readAuthorizedMachineProducerProfileHash(database) {
  if (!database?.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='autonomous_research_machine_intake_metadata'`).get()) {
    return null;
  }
  const columns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_machine_intake_metadata)',
  ).all().map((column) => column.name));
  if (!columns.has('authorized_machine_producer_profile_hash')) return null;
  const value = database.prepare(`SELECT authorized_machine_producer_profile_hash
    FROM autonomous_research_machine_intake_metadata WHERE singleton=1`).get()
    ?.authorized_machine_producer_profile_hash || null;
  if (value !== null && !SHA256.test(String(value))) {
    throw new Error('autonomous_research_machine_intake_state_invalid');
  }
  return value;
}

export function readMachineIntakeAuthorityGeneration(database) {
  if (!database?.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='autonomous_research_machine_intake_metadata'`).get()) {
    return null;
  }
  const columns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_machine_intake_metadata)',
  ).all().map((column) => column.name));
  const value = columns.has('authority_generation')
    ? database.prepare(`SELECT authority_generation FROM
      autonomous_research_machine_intake_metadata WHERE singleton=1`).get()
      ?.authority_generation
    : 1;
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('autonomous_research_machine_intake_state_invalid');
  }
  return generation;
}

export function bindMachineIntakeAuthorityGenesis(database, {
  configurationHash,
  producerProfileHash,
  createdAt,
} = {}) {
  const timestamp = Date.parse(String(createdAt || ''));
  if (!SHA256.test(String(configurationHash || ''))
    || !SHA256.test(String(producerProfileHash || ''))
    || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== createdAt
    || database.prepare('SELECT COUNT(*) AS count FROM autonomous_research_machine_intake')
      .get().count !== 0
    || database.prepare(`SELECT COUNT(*) AS count FROM
      autonomous_research_machine_intake_authority_rotation`).get().count !== 0
    || database.prepare(`SELECT COUNT(*) AS count FROM
      autonomous_research_machine_intake_authority_genesis`).get().count !== 0) {
    authorityStateInvalid();
  }
  const external = verifyExternalGenesisAuthority({
    documents: loadAutonomousResearchMachineIntakeExternalAuthorityDocuments({
      genesisRequired: true,
    }),
    configurationHash,
    producerProfileHash,
    verificationTime: new Date(timestamp),
  });
  const authorityCreatedAt = external.envelope.validFrom;
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchMachineIntakeAuthorityGenesis',
    origin: 'fresh-v2-genesis',
    configurationHash,
    producerProfileHash,
    authorityGeneration: 1,
    externalGenesisEnvelopeHash: external.envelopeHash,
    ownerTrustStoreHash: external.ownerTrustStoreHash,
    createdAt: authorityCreatedAt,
  });
  const genesisHash = hashRecord('AutonomousResearchMachineIntakeAuthorityGenesis', payload);
  database.prepare(`INSERT INTO autonomous_research_machine_intake_authority_genesis(
    singleton,origin,configuration_hash,producer_profile_hash,authority_generation,
    external_genesis_envelope_hash,external_genesis_envelope_json,owner_trust_store_hash,
    owner_trust_store_snapshot_json,verified_signers_json,
    genesis_payload_json,genesis_hash,created_at
  ) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    payload.origin,
    configurationHash,
    producerProfileHash,
    1,
    external.envelopeHash,
    JSON.stringify(external.envelope),
    external.ownerTrustStoreHash,
    JSON.stringify(external.ownerTrustStore),
    JSON.stringify(external.verifiedSigners),
    JSON.stringify(payload),
    genesisHash,
    authorityCreatedAt,
  );
  return Object.freeze({ ...payload, genesisHash });
}

export function assertMachineIntakeAuthorityState(database) {
  const configuredSourceAuthorityHash = readConfiguredSourceAuthorityHash(database);
  const authorizedMachineProducerProfileHash = readAuthorizedMachineProducerProfileHash(database);
  const authorityGeneration = readMachineIntakeAuthorityGeneration(database);
  const metadataColumns = new Set(database.prepare(
    'PRAGMA table_info(autonomous_research_machine_intake_metadata)',
  ).all().map((column) => column.name));
  const lastAuthorityRotationReceiptHash = metadataColumns.has(
    'last_authority_rotation_receipt_hash',
  ) ? database.prepare(`SELECT last_authority_rotation_receipt_hash FROM
    autonomous_research_machine_intake_metadata WHERE singleton=1`).get()
    ?.last_authority_rotation_receipt_hash ?? null : null;
  const journalPresent = Boolean(database.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='autonomous_research_machine_intake_authority_rotation'`).get());
  let journal = [];
  try {
    journal = journalPresent ? database.prepare(`SELECT * FROM
      autonomous_research_machine_intake_authority_rotation
      ORDER BY authority_generation`).all() : [];
  } catch { authorityStateInvalid(); }
  let genesis = [];
  try {
    const genesisPresent = Boolean(database.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name='autonomous_research_machine_intake_authority_genesis'`).get());
    genesis = genesisPresent ? database.prepare(`SELECT * FROM
      autonomous_research_machine_intake_authority_genesis ORDER BY singleton`).all() : [];
  } catch { authorityStateInvalid(); }
  let genesisValid = false;
  if (genesis.length === 1) {
    const row = genesis[0];
    const payload = parseEvidence(row.genesis_payload_json);
    const persistedEnvelope = parseEvidence(row.external_genesis_envelope_json);
    const persistedOwnerTrust = parseEvidence(row.owner_trust_store_snapshot_json);
    const persistedSigners = parseEvidence(row.verified_signers_json, { array: true });
    let external;
    try {
      const documents = loadAutonomousResearchMachineIntakeExternalAuthorityDocuments({
        genesisRequired: true,
      });
      external = verifyExternalGenesisAuthority({
        documents,
        configurationHash: configuredSourceAuthorityHash,
        producerProfileHash: authorizedMachineProducerProfileHash,
        verificationTime: new Date(row.created_at),
      });
    } catch { authorityStateInvalid(); }
    genesisValid = exactKeys(payload, GENESIS_PAYLOAD_KEYS)
      && payload.version === 1
      && payload.kind === 'AutonomousResearchMachineIntakeAuthorityGenesis'
      && row.singleton === 1 && row.origin === 'fresh-v2-genesis'
      && row.authority_generation === 1
      && canonicalInstant(row.created_at)
      && row.created_at === external.envelope.validFrom
      && row.configuration_hash === configuredSourceAuthorityHash
      && row.producer_profile_hash === authorizedMachineProducerProfileHash
      && payload.origin === row.origin && payload.configurationHash === row.configuration_hash
      && payload.producerProfileHash === row.producer_profile_hash
      && payload.authorityGeneration === 1 && payload.createdAt === row.created_at
      && payload.externalGenesisEnvelopeHash === row.external_genesis_envelope_hash
      && payload.ownerTrustStoreHash === row.owner_trust_store_hash
      && row.external_genesis_envelope_hash === external.envelopeHash
      && row.owner_trust_store_hash === external.ownerTrustStoreHash
      && sameEvidence(persistedEnvelope, external.envelope)
      && sameEvidence(persistedOwnerTrust, external.ownerTrustStore)
      && sameEvidence(persistedSigners, external.verifiedSigners)
      && hashRecord('AutonomousResearchMachineIntakeAuthorityGenesis', payload)
        === row.genesis_hash;
  }
  const legacyV1Valid = authorityGeneration === 1
    && authorizedMachineProducerProfileHash === null && genesis.length === 0
    && lastAuthorityRotationReceiptHash === null && journal.length === 0;
  const v2GenesisValid = authorityGeneration === 1
    && authorizedMachineProducerProfileHash !== null && genesisValid
    && lastAuthorityRotationReceiptHash === null && journal.length === 0;
  const row = journal[0];
  const v2Valid = authorityGeneration === 2 && journal.length === 1 && genesis.length === 0
    && row?.authority_generation === 2 && row?.transition === 'v1-to-v2'
    && row?.previous_producer_profile_hash === null
    && row?.previous_rotation_receipt_hash === null
    && row?.next_configuration_hash === configuredSourceAuthorityHash
    && row?.next_producer_profile_hash === authorizedMachineProducerProfileHash
    && row?.rotation_receipt_hash === lastAuthorityRotationReceiptHash;
  if (!legacyV1Valid && !v2GenesisValid && !v2Valid) {
    authorityStateInvalid();
  }
  if (v2Valid) {
    let documents;
    try {
      documents = loadAutonomousResearchMachineIntakeExternalAuthorityDocuments();
    } catch { authorityStateInvalid(); }
    const fixedOwnerHash = hashRecord('AuthorityTrustStore', documents.ownerTrustStore);
    const fixedRotationHash = hashRecord('AuthorityTrustStore', documents.rotationTrustStore);
    const fixedBootstrapHash = hashRecord(
      'AutonomousResearchMachineIntakeAuthorityRotationBootstrapReceipt',
      documents.bootstrapReceipt,
    );
    if (fixedOwnerHash !== row.owner_trust_store_hash
      || fixedRotationHash !== row.authority_trust_store_hash
      || fixedBootstrapHash !== row.bootstrap_receipt_hash
      || !sameEvidence(
        documents.ownerTrustStore,
        parseEvidence(row.owner_trust_store_snapshot_json),
      )
      || !sameEvidence(
        documents.rotationTrustStore,
        parseEvidence(row.rotation_trust_store_snapshot_json),
      )
      || !sameEvidence(
        documents.bootstrapReceipt,
        parseEvidence(row.bootstrap_receipt_json),
      )) authorityStateInvalid();
    verifyRotationJournalEvidence(row);
  }
  return Object.freeze({
    configuredSourceAuthorityHash,
    authorizedMachineProducerProfileHash,
    authorityGeneration,
    lastAuthorityRotationReceiptHash,
  });
}

export function bindConfiguredSourceAuthorityHash(database, authorizedSourceAuthorityHash) {
  if (!SHA256.test(String(authorizedSourceAuthorityHash || ''))) {
    throw new Error('autonomous_research_machine_intake_source_authority_required');
  }
  const persisted = readConfiguredSourceAuthorityHash(database);
  if (persisted && persisted !== authorizedSourceAuthorityHash) {
    throw new Error('autonomous_research_machine_intake_configuration_authority_mismatch');
  }
  if (!persisted) {
    const authorities = database.prepare(`SELECT DISTINCT source_authority_hash
      FROM autonomous_research_machine_intake ORDER BY source_authority_hash`).all()
      .map((row) => row.source_authority_hash);
    if (authorities.length > 1) {
      throw new Error('autonomous_research_machine_intake_configuration_authority_ambiguous');
    }
    if (authorities.length === 1 && authorities[0] !== authorizedSourceAuthorityHash) {
      throw new Error('autonomous_research_machine_intake_configuration_authority_mismatch');
    }
    database.prepare(`INSERT INTO autonomous_research_machine_intake_metadata(
      singleton,configured_source_authority_hash) VALUES(1,?)`).run(
      authorizedSourceAuthorityHash,
    );
  }
  return readConfiguredSourceAuthorityHash(database);
}

export function bindAuthorizedMachineProducerProfileHash(database, expected) {
  if (expected !== null && !SHA256.test(String(expected || ''))) {
    throw new Error('autonomous_research_machine_intake_producer_profile_hash_invalid');
  }
  const persisted = readAuthorizedMachineProducerProfileHash(database);
  if (persisted && persisted !== expected) {
    throw new Error('autonomous_research_machine_intake_producer_authority_mismatch');
  }
  if (!persisted && expected) {
    const existingMachineAdmissions = database.prepare(`SELECT admission_json FROM
      autonomous_research_machine_intake WHERE source_kind='machine'`).all();
    const incompatible = existingMachineAdmissions.some((row) => {
      try {
        const admission = JSON.parse(row.admission_json);
        return admission?.version !== 2
          || admission?.topicProducerCapabilityReceipt?.producerProfileHash !== expected;
      } catch { return true; }
    });
    if (incompatible) {
      throw new Error('autonomous_research_machine_intake_legacy_machine_admission_quarantine_required');
    }
    database.prepare(`UPDATE autonomous_research_machine_intake_metadata
      SET authorized_machine_producer_profile_hash=? WHERE singleton=1`).run(expected);
  }
  return readAuthorizedMachineProducerProfileHash(database);
}
