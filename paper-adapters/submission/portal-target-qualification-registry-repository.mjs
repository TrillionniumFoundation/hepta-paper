import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Local persistence is intentionally isolated in this repository boundary.

import {
  verifyAuthoritySignatures,
} from '../authority/authority-signatures.mjs';
import {
  PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES,
  PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES,
  buildPortalTargetQualificationRegistry,
  inspectPortalTargetQualificationRegistryFreshness,
  requiredPortalTargetQualificationAuthorityRoles,
  verifyPortalTargetQualificationRegistryStructure,
} from '../../paper-domain/submission/portal-target-qualification-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const VERIFIED_INSPECTIONS = new WeakSet();

function expectedHash(value, code, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error(code);
    return null;
  }
  const selected = String(value).toLowerCase();
  if (!SHA256.test(selected)) throw new Error(code);
  return selected;
}

function readSecureJson(filePath, {
  missingAllowed = false,
  expectedFileHash = null,
  errorCode = 'portal_target_qualification_file_invalid',
} = {}) {
  const selected = path.resolve(String(filePath || ''));
  if (!fs.existsSync(selected)) {
    if (missingAllowed) return null;
    throw new Error(`${errorCode}:missing`);
  }
  let descriptor = null;
  try {
    const stat = fs.lstatSync(selected);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size < 2 || stat.size > 4 * 1024 * 1024
      || (stat.mode & 0o022) !== 0
      || (stat.uid !== 0 && stat.uid !== currentUid)
      || fs.realpathSync(selected) !== selected) throw new Error('unsafe');
    descriptor = fs.openSync(
      selected,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const before = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== stat.dev
      || before.ino !== stat.ino || before.size !== bytes.length
      || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('changed');
    }
    const fileHash = hashBytes(bytes);
    if (expectedFileHash && fileHash !== expectedFileHash) throw new Error('pin');
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('shape');
    }
    return Object.freeze({ path: selected, bytes, fileHash, value });
  } catch {
    throw new Error(errorCode);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function roleSignatures(verification) {
  return new Map(verification.verifiedSignatures.map((signature) => [
    signature.role,
    signature,
  ]));
}

function evidenceAuthorityBlockers({ evidence, trustStore, expectedSignature }) {
  const policy = PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES[
    evidence?.evidenceType
  ];
  if (!policy) return ['portal_target_evidence_policy_missing'];
  const verification = verifyAuthoritySignatures({
    document: evidence,
    trustStore,
    requiredRoles: [policy.authorityRole],
    minSignatures: 1,
    requireDistinctSubjects: true,
  });
  const blockers = [...verification.blockers];
  if (evidence.signatures.length !== 1) {
    blockers.push('portal_target_evidence_signature_set_not_minimal');
  }
  const signer = verification.verifiedSignatures[0] || null;
  if (signer?.role !== evidence.verifierRole
    || signer?.subjectId !== evidence.issuerPrincipalId
    || signer?.subjectId !== expectedSignature?.subjectId
    || signer?.keyId !== expectedSignature?.keyId) {
    blockers.push('portal_target_evidence_verifier_identity_mismatch');
  }
  return blockers;
}

function authorityBlockers(registry, trustStore) {
  const requiredRoles = requiredPortalTargetQualificationAuthorityRoles(registry);
  const verification = verifyAuthoritySignatures({
    document: registry,
    trustStore,
    requiredRoles,
    minSignatures: requiredRoles.length,
    requireDistinctSubjects: true,
  });
  const blockers = [...verification.blockers];
  if (registry.signatures.length !== requiredRoles.length) {
    blockers.push('portal_target_qualification_signature_set_not_minimal');
  }
  const signatures = roleSignatures(verification);
  const organizations = verification.verifiedSignatures.map((signature) => (
    String(signature.organization || '').trim().toLowerCase()
  ));
  if (organizations.some((organization) => !organization)
    || new Set(organizations).size !== organizations.length) {
    blockers.push('portal_target_qualification_authority_organizations_not_independent');
  }
  const fingerprints = verification.verifiedSignatures.map((signature) => (
    signature.publicKeySpkiSha256 || null
  ));
  if (fingerprints.some((fingerprint) => fingerprint === null)
    || new Set(fingerprints).size !== fingerprints.length) {
    blockers.push('portal_target_qualification_authority_spki_not_independent');
  }
  const owner = signatures.get(PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.owner);
  const observer = signatures.get(PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.observer);
  const productionAuthorizer = signatures.get(
    PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.productionAuthorizer,
  );
  for (const entry of registry.entries) {
    if (entry.evidence.discovery.issuerPrincipalId !== owner?.subjectId) {
      blockers.push(`portal_target_discovery_owner_mismatch:${entry.venueId}`);
    }
    for (const type of [
      'sandboxCanary',
      'portalIdentity',
      'dispatcherChallenge',
      'cycleRecovery',
    ]) {
      const evidence = entry.evidence[type];
      if (evidence && evidence.issuerPrincipalId !== observer?.subjectId) {
        blockers.push(`portal_target_observer_mismatch:${entry.venueId}:${type}`);
      }
    }
    if (entry.productionQualified
      && entry.evidence.productionAuthorization.issuerPrincipalId
        !== productionAuthorizer?.subjectId) {
      blockers.push(`portal_target_production_authorizer_mismatch:${entry.venueId}`);
    }
    for (const evidence of Object.values(entry.evidence).filter(Boolean)) {
      const expected = evidence.evidenceType === 'discovery'
        ? owner
        : evidence.evidenceType === 'productionAuthorization'
          ? productionAuthorizer
          : observer;
      blockers.push(...evidenceAuthorityBlockers({
        evidence,
        trustStore,
        expectedSignature: expected,
      }).map((blocker) => (
        `${entry.venueId}:${evidence.evidenceType}:${blocker}`
      )));
    }
  }
  return Object.freeze({
    verification,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function verifyRegistry({
  registryRead,
  trustStoreRead,
  expectedRegistryHash = null,
  now = new Date(),
  requireCurrent = true,
} = {}) {
  const blockers = [];
  const rawRegistry = registryRead?.value || null;
  let registry = null;
  if (!verifyPortalTargetQualificationRegistryStructure(rawRegistry)) {
    blockers.push('portal_target_qualification_registry_structure_invalid');
  } else {
    registry = buildPortalTargetQualificationRegistry(rawRegistry);
  }
  const pinnedRegistryHash = expectedHash(
    expectedRegistryHash,
    'portal_target_qualification_registry_pin_invalid',
  );
  if (pinnedRegistryHash
    && registry?.portalTargetQualificationRegistryHash !== pinnedRegistryHash) {
    blockers.push('portal_target_qualification_registry_pin_mismatch');
  }
  let authority = null;
  if (blockers.length === 0) {
    authority = authorityBlockers(registry, trustStoreRead.value);
    blockers.push(...authority.blockers);
  }
  if (requireCurrent && blockers.length === 0) {
    blockers.push(...inspectPortalTargetQualificationRegistryFreshness(
      registry,
      { now },
    ).blockers);
  }
  return Object.freeze({
    registry,
    authority,
    semanticPinVerified: pinnedRegistryHash !== null
      && registry?.portalTargetQualificationRegistryHash === pinnedRegistryHash,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function readTrustStore({ trustStorePath, expectedTrustStoreHash } = {}) {
  const pin = expectedHash(
    expectedTrustStoreHash,
    'portal_target_qualification_trust_store_pin_required',
    { required: true },
  );
  return readSecureJson(trustStorePath, {
    expectedFileHash: pin,
    errorCode: 'portal_target_qualification_trust_store_invalid',
  });
}

export function inspectPortalTargetQualificationRegistry({
  registryPath,
  trustStorePath,
  expectedTrustStoreHash,
  expectedRegistryHash = null,
  now = new Date(),
} = {}) {
  const blockers = [];
  let registryRead = null;
  let trustStoreRead = null;
  let verification = null;
  try {
    registryRead = readSecureJson(registryPath, {
      errorCode: 'portal_target_qualification_registry_file_invalid',
    });
  } catch (error) { blockers.push(error.message); }
  try {
    trustStoreRead = readTrustStore({ trustStorePath, expectedTrustStoreHash });
  } catch (error) { blockers.push(error.message); }
  if (registryRead && trustStoreRead) {
    verification = verifyRegistry({
      registryRead,
      trustStoreRead,
      expectedRegistryHash,
      now,
      requireCurrent: true,
    });
    blockers.push(...verification.blockers);
    if (!verification.semanticPinVerified) {
      blockers.push('portal_target_qualification_registry_semantic_pin_required');
    }
  }
  const registry = verification?.registry || registryRead?.value || null;
  const ready = blockers.length === 0;
  const entries = ready ? registry.entries : [];
  const inspection = Object.freeze({
    version: 1,
    kind: 'PortalTargetQualificationRegistryInspection',
    status: ready
      ? 'portal_target_qualification_registry_ready'
      : 'portal_target_qualification_registry_blocked',
    ready,
    registryPath: registryRead?.path || path.resolve(String(registryPath || '')),
    registryFileHash: registryRead?.fileHash || null,
    registryHash: registry?.portalTargetQualificationRegistryHash || null,
    semanticPinVerified: verification?.semanticPinVerified === true,
    trustStoreFileHash: trustStoreRead?.fileHash || null,
    generation: registry?.generation || null,
    expiresAt: registry?.expiresAt || null,
    sandboxQualifiedTargetCount: entries.filter((entry) => entry.sandboxQualified).length,
    productionQualifiedTargetCount:
      entries.filter((entry) => entry.productionQualified).length,
    liveCommitAuthorizedTargetCount: 0,
    humanSingleUseAuthorizationRequired: true,
    entries: Object.freeze(entries),
    registry: ready ? registry : null,
    signatureVerification: verification?.authority?.verification || null,
    blockers: Object.freeze([...new Set(blockers)].sort()),
    safety: Object.freeze({
      externalActionPerformed: false,
      referencedEvidenceExternalActionPerformed:
        entries.length > 0 && entries.every((entry) => (
          Object.values(entry.evidence).filter(Boolean)
            .some((evidence) => evidence.externalActionPerformed === true)
        )),
      networkActionPerformed: false,
      credentialUsed: false,
      liveCommitPermitProduced: false,
      liveCommitPermitConsumed: false,
    }),
  });
  if (ready) VERIFIED_INSPECTIONS.add(inspection);
  return inspection;
}

export function applyInspectedPortalTargetQualificationsToCoverage(
  coverage,
  inspection,
  { now = new Date() } = {},
) {
  if (!VERIFIED_INSPECTIONS.has(inspection)
    || inspection?.ready !== true
    || inspection?.semanticPinVerified !== true
    || inspection?.registry === null) {
    throw new Error('portal_target_qualification_verified_inspection_required');
  }
  const freshness = inspectPortalTargetQualificationRegistryFreshness(
    inspection.registry,
    { now },
  );
  if (!freshness.ready) {
    throw new Error(`portal_target_qualification_registry_not_current:${
      freshness.blockers.join(',')}`);
  }
  const qualifications = new Map(
    inspection.registry.entries.map((entry) => [entry.venueId, entry]),
  );
  const entries = coverage.entries.map((entry) => {
    const qualification = qualifications.get(entry.venueId);
    if (!qualification) return entry;
    const blockers = qualification.productionQualified
      ? ['final_commit_human_review_and_single_use_permit_required']
      : [
        'portal_target_production_authorization_required',
        'final_commit_human_review_and_single_use_permit_required',
      ];
    const { journalSubmissionConnectorCoverageEntryHash: _oldHash, ...oldPayload } = entry;
    const payload = {
      ...oldPayload,
      connectorDisposition: qualification.productionQualified
        ? 'cryptographically_attested_target_production_qualified'
        : 'cryptographically_attested_target_sandbox_qualified',
      targetProfileResolved: true,
      sandboxQualified: true,
      productionQualified: qualification.productionQualified,
      liveCommitAuthorized: false,
      liveSubmissionReady: false,
      discoveryRequired: false,
      blockers: Object.freeze(blockers),
    };
    return Object.freeze({
      ...payload,
      journalSubmissionConnectorCoverageEntryHash:
        hashRecord('JournalSubmissionConnectorCoverageEntry', payload),
    });
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    portalTargetQualificationRegistryHash: inspection.registryHash,
    qualificationGeneration: inspection.generation,
    qualificationExpiresAt: inspection.expiresAt,
  });
}

function assertMonotonicCandidate(current, candidate) {
  if (!current) {
    if (candidate.generation !== 1
      || candidate.predecessorRegistryHash !== null
      || candidate.revokedQualificationHashes.length !== 0) {
      throw new Error('portal_target_qualification_initial_generation_invalid');
    }
    return;
  }
  if (candidate.generation !== current.generation + 1
    || candidate.predecessorRegistryHash
      !== current.portalTargetQualificationRegistryHash
    || Date.parse(candidate.issuedAt) <= Date.parse(current.issuedAt)) {
    throw new Error('portal_target_qualification_generation_not_monotonic');
  }
  const currentHashes = new Set(
    current.entries.map((entry) => entry.portalTargetQualificationHash),
  );
  if (candidate.revokedQualificationHashes.some((hash) => !currentHashes.has(hash))) {
    throw new Error('portal_target_qualification_revocation_not_current');
  }
  const revoked = new Set(candidate.revokedQualificationHashes);
  const candidates = new Map(candidate.entries.map((entry) => [entry.venueId, entry]));
  for (const prior of current.entries) {
    const next = candidates.get(prior.venueId);
    const changed = !next
      || next.portalTargetQualificationHash !== prior.portalTargetQualificationHash;
    if (changed !== revoked.has(prior.portalTargetQualificationHash)) {
      throw new Error(`portal_target_qualification_revocation_required:${prior.venueId}`);
    }
  }
  if (candidate.entries.some((entry) => (
    revoked.has(entry.portalTargetQualificationHash)
  ))) throw new Error('portal_target_qualification_revoked_entry_reused');
}

export function planPortalTargetQualificationRegistryImport({
  registryPath,
  candidatePath,
  expectedCandidateFileHash,
  trustStorePath,
  expectedTrustStoreHash,
  now = new Date(),
} = {}) {
  const candidatePin = expectedHash(
    expectedCandidateFileHash,
    'portal_target_qualification_candidate_pin_required',
    { required: true },
  );
  const trustStoreRead = readTrustStore({ trustStorePath, expectedTrustStoreHash });
  const candidateRead = readSecureJson(candidatePath, {
    expectedFileHash: candidatePin,
    errorCode: 'portal_target_qualification_candidate_invalid',
  });
  const candidateVerification = verifyRegistry({
    registryRead: candidateRead,
    trustStoreRead,
    now,
    requireCurrent: true,
  });
  if (candidateVerification.blockers.length) {
    throw new Error(`portal_target_qualification_candidate_blocked:${
      candidateVerification.blockers.join(',')}`);
  }
  const selectedRegistryPath = path.resolve(String(registryPath || ''));
  const currentRead = readSecureJson(selectedRegistryPath, {
    missingAllowed: true,
    errorCode: 'portal_target_qualification_registry_file_invalid',
  });
  let current = null;
  if (currentRead) {
    const currentVerification = verifyRegistry({
      registryRead: currentRead,
      trustStoreRead,
      now,
      requireCurrent: false,
    });
    if (currentVerification.blockers.length) {
      throw new Error(`portal_target_qualification_current_registry_blocked:${
        currentVerification.blockers.join(',')}`);
    }
    current = currentVerification.registry;
  }
  const candidate = candidateVerification.registry;
  assertMonotonicCandidate(current, candidate);
  const payload = {
    version: 1,
    kind: 'PortalTargetQualificationRegistryImportPlan',
    status: 'portal_target_qualification_registry_import_planned',
    registryPath: selectedRegistryPath,
    currentRegistryHash: current?.portalTargetQualificationRegistryHash || null,
    candidatePath: candidateRead.path,
    candidateFileHash: candidateRead.fileHash,
    candidateRegistryHash: candidate.portalTargetQualificationRegistryHash,
    candidateGeneration: candidate.generation,
    trustStorePath: trustStoreRead.path,
    trustStoreFileHash: trustStoreRead.fileHash,
    targetVenueIds: Object.freeze(candidate.entries.map((entry) => entry.venueId)),
    liveCommitAuthorizationIncluded: false,
    humanSingleUseAuthorizationRequired: true,
  };
  return Object.freeze({
    ...payload,
    planHash: hashRecord('PortalTargetQualificationRegistryImportPlan', payload),
    candidate,
    safety: Object.freeze({
      mutationPerformed: false,
      externalActionPerformed: false,
      referencedEvidenceExternalActionPerformed:
        candidate.entries.length > 0 && candidate.entries.every((entry) => (
          Object.values(entry.evidence).filter(Boolean)
            .some((evidence) => evidence.externalActionPerformed === true)
        )),
      liveCommitPermitProduced: false,
      liveCommitPermitConsumed: false,
    }),
  });
}

function withRegistryLock(registryPath, planHash, operation) {
  const parent = path.dirname(registryPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(parent);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(parent) !== parent
    || (stat.mode & 0o022) !== 0
    || (stat.uid !== 0 && stat.uid !== currentUid)) {
    throw new Error('portal_target_qualification_registry_parent_invalid');
  }
  const lockPath = `${registryPath}.lock`;
  const lock = fs.openSync(
    lockPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(lock, `${planHash}\n`);
    fs.fsyncSync(lock);
    return operation();
  } finally {
    fs.closeSync(lock);
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  }
}

function writeRegistryBytesAtomically(registryPath, bytes) {
  const parent = path.dirname(registryPath);
  const temporary = path.join(
    parent,
    `.${path.basename(registryPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let published = false;
  try {
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, registryPath);
    published = true;
    const parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
  } finally {
    if (!published) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }
}

function writeRegistryAtomically(registryPath, registry) {
  writeRegistryBytesAtomically(
    registryPath,
    Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, 'utf8'),
  );
}

function removeRegistryDurably(registryPath) {
  fs.rmSync(registryPath, { force: true });
  const parentDescriptor = fs.openSync(path.dirname(registryPath), fs.constants.O_RDONLY);
  try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
}

export function executePortalTargetQualificationRegistryImport({
  expectedPlanHash,
  ...options
} = {}) {
  const planHash = expectedHash(
    expectedPlanHash,
    'portal_target_qualification_plan_hash_required',
    { required: true },
  );
  const initial = planPortalTargetQualificationRegistryImport(options);
  if (initial.planHash !== planHash) {
    throw new Error('portal_target_qualification_plan_hash_mismatch');
  }
  const inspection = withRegistryLock(initial.registryPath, planHash, () => {
    const beforeWrite = planPortalTargetQualificationRegistryImport(options);
    if (beforeWrite.planHash !== planHash) {
      throw new Error('portal_target_qualification_plan_stale');
    }
    const priorRead = readSecureJson(initial.registryPath, {
      missingAllowed: true,
      errorCode: 'portal_target_qualification_registry_file_invalid',
    });
    if ((priorRead?.value?.portalTargetQualificationRegistryHash || null)
      !== beforeWrite.currentRegistryHash) {
      throw new Error('portal_target_qualification_plan_stale');
    }
    writeRegistryAtomically(initial.registryPath, initial.candidate);
    let result;
    try {
      result = inspectPortalTargetQualificationRegistry({
        registryPath: initial.registryPath,
        trustStorePath: initial.trustStorePath,
        expectedTrustStoreHash: initial.trustStoreFileHash,
        expectedRegistryHash: initial.candidateRegistryHash,
        now: options.now,
      });
      if (!result.ready) throw new Error(result.blockers.join(','));
      return result;
    } catch (error) {
      try {
        if (priorRead) {
          writeRegistryBytesAtomically(initial.registryPath, priorRead.bytes);
        } else {
          removeRegistryDurably(initial.registryPath);
        }
      } catch {
        throw new Error('portal_target_qualification_post_import_rollback_failed');
      }
      throw new Error(`portal_target_qualification_post_import_verification_failed:${
        error.message}`);
    }
  });
  if (!inspection.ready) {
    throw new Error(`portal_target_qualification_post_import_verification_failed:${
      inspection.blockers.join(',')}`);
  }
  return Object.freeze({
    version: 1,
    kind: 'PortalTargetQualificationRegistryImportReceipt',
    status: 'portal_target_qualification_registry_imported',
    planHash,
    registryPath: initial.registryPath,
    registryHash: inspection.registryHash,
    generation: inspection.generation,
    targetVenueIds: initial.targetVenueIds,
    inspection,
    externalActionPerformed: false,
    liveCommitPermitProduced: false,
    liveCommitPermitConsumed: false,
    humanSingleUseAuthorizationRequired: true,
  });
}
