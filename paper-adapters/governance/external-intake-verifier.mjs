import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import { verifyAuthoritySignatures } from '../authority/authority-signatures.mjs';
import { capabilityTargetBindings, verifyCapabilityOperationalReceipt } from './capability-proof-verifier.mjs';
import {
  LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT,
  LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST,
} from './legacy-owner-acceptance-contract.mjs';
import { verifyOwnerAcceptanceDocument } from './owner-acceptance-verifier.mjs';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function validateAuthorityDocumentEnvelope({ document, name, kind, version, paperId } = {}) {
  const blockers = [];
  if (!document) blockers.push(`${name}:missing_or_invalid_json`);
  if (document?.kind !== kind || document?.version !== version) blockers.push(`${name}:schema_envelope_invalid`);
  if (document?.paperId !== paperId) blockers.push(`${name}:paper_id_mismatch`);
  return blockers;
}

export function validatePublicTrustStore({ trustStore, requiredRoles = [], requireDistinctSubjects = false } = {}) {
  const blockers = [];
  if (trustStore?.version !== 1 || trustStore?.kind !== 'AuthorityTrustStore') blockers.push('trust_store_contract_invalid');
  const keys = Array.isArray(trustStore?.keys) ? trustStore.keys : [];
  const active = keys.filter((key) => key?.status === 'active');
  const keyIds = new Set();
  const subjects = new Set();
  for (const key of active) {
    if (!key?.keyId || keyIds.has(String(key.keyId))) blockers.push('trust_store_key_id_missing_or_duplicate');
    keyIds.add(String(key?.keyId || ''));
    if (!key?.subjectId) blockers.push(`trust_store_subject_missing:${key?.keyId || 'unknown'}`);
    subjects.add(String(key?.subjectId || ''));
    if (key?.algorithm !== 'ed25519') blockers.push(`trust_store_algorithm_invalid:${key?.keyId || 'unknown'}`);
    if (key?.privateKeyPem || /PRIVATE KEY/.test(String(key?.publicKeyPem || ''))) blockers.push(`private_key_material_forbidden:${key?.keyId || 'unknown'}`);
    try {
      const publicKey = crypto.createPublicKey(String(key?.publicKeyPem || ''));
      if (publicKey.asymmetricKeyType !== 'ed25519') blockers.push(`trust_store_public_key_not_ed25519:${key?.keyId || 'unknown'}`);
    } catch { blockers.push(`trust_store_public_key_invalid:${key?.keyId || 'unknown'}`); }
  }
  for (const role of requiredRoles) {
    if (!active.some((key) => Array.isArray(key.roles) && key.roles.includes(role))) blockers.push(`trust_store_role_missing:${role}`);
  }
  if (requireDistinctSubjects && active.length && subjects.size !== active.length) blockers.push('trust_store_subjects_not_distinct');
  return Object.freeze({
    status: blockers.length ? 'public_trust_store_blocked' : 'public_trust_store_verified',
    activeKeyCount: active.length,
    requiredRoles: [...requiredRoles],
    blockers: [...new Set(blockers)],
  });
}

export function verifyExternalIntake({ stagingRoot, workspaceRoot, releaseCommit, paperId = 'A_Theory_of__Expectations' } = {}) {
  const authorityTrustStore = readJson(path.join(stagingRoot, 'AUTHORITY_TRUST_STORE.json'));
  const ownerTrustStore = readJson(path.join(stagingRoot, 'OWNER_TRUST_STORE.json'));
  const authorityTrust = validatePublicTrustStore({
    trustStore: authorityTrustStore,
    requiredRoles: ['academic_evidence_authority', 'independent_referee', 'submission_operator', 'live_executor_authorizer'],
    requireDistinctSubjects: true,
  });
  const ownerTrust = validatePublicTrustStore({
    trustStore: ownerTrustStore,
    requiredRoles: ['capability_owner', 'operational_observer'],
    requireDistinctSubjects: true,
  });
  const ownerDocument = readJson(path.join(stagingRoot, 'CAPABILITY_OWNER_ACCEPTANCE.json'));
  const accepted = verifyOwnerAcceptanceDocument({
    document: ownerDocument,
    trustStore: ownerTrustStore,
    familyManifest: LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST,
  });
  const targetBindings = capabilityTargetBindings(workspaceRoot, CAPABILITY_CATALOG);
  const operational = [];
  for (const capabilityId of Object.keys(CAPABILITY_CATALOG).sort()) {
    const directory = path.join(stagingRoot, 'operational-proof', 'capabilities', capabilityId);
    const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort() : [];
    const verifications = files.map((name) => verifyCapabilityOperationalReceipt({
      document: readJson(path.join(directory, name)),
      trustStore: ownerTrustStore,
      capabilityId,
      targetBindings: targetBindings[capabilityId],
      releaseCommit,
    }));
    operational.push({
      capabilityId,
      verified: verifications.some((item) => item.status === 'capability_operational_receipt_verified'),
      files: files.length,
      blockers: [...new Set(verifications.flatMap((item) => item.blockers))],
    });
  }
  const authorityDirectory = path.join(stagingRoot, 'authority-inbox', paperId);
  const authorityDocuments = [
    ['ACADEMIC_EVIDENCE_ATTESTATION.json', 'AcademicEvidenceAttestation', 2, ['academic_evidence_authority'], 1],
    ['INDEPENDENT_REFEREE_VERDICT.json', 'IndependentRefereeVerdict', 1, ['independent_referee'], 1],
    ['LIVE_SUBMISSION_AUTHORIZATION.json', 'LiveSubmissionAuthorization', 1, ['submission_operator', 'live_executor_authorizer'], 2],
  ].map(([name, kind, version, requiredRoles, minSignatures]) => {
    const document = readJson(path.join(authorityDirectory, name));
    const verification = verifyAuthoritySignatures({ document, trustStore: authorityTrustStore, requiredRoles, minSignatures });
    const envelopeBlockers = validateAuthorityDocumentEnvelope({ document, name, kind, version, paperId });
    return {
      name,
      present: Boolean(document),
      envelopeVerified: envelopeBlockers.length === 0,
      signatureStatus: verification.status,
      blockers: [...new Set([...envelopeBlockers, ...verification.blockers])],
    };
  });
  const blockers = [
    ...authorityTrust.blockers,
    ...ownerTrust.blockers,
    ...(accepted.size === LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT
      ? []
      : [`owner_acceptance_incomplete:${accepted.size}/${LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT}`]),
    ...(operational.every((item) => item.verified) ? [] : [`operational_proof_incomplete:${operational.filter((item) => item.verified).length}/${operational.length}`]),
    ...(authorityDocuments.every((item) => item.envelopeVerified && item.signatureStatus === 'authority_signatures_verified') ? [] : ['authority_documents_incomplete_or_invalid']),
  ];
  return Object.freeze({
    version: 1,
    kind: 'ExternalEvidenceIntakeVerification',
    status: blockers.length ? 'external_evidence_intake_blocked' : 'external_evidence_intake_preflight_verified',
    stagingRoot: path.resolve(stagingRoot),
    releaseCommit,
    authorityTrust,
    ownerTrust,
    ownerAccepted: accepted.size,
    ownerRequired: LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT,
    operationallyProven: operational.filter((item) => item.verified).length,
    operationalRequired: operational.length,
    operational,
    authorityDocuments,
    installAuthorized: false,
    externalActionPerformed: false,
    semanticValidationDeferredToProductionPipeline: true,
    blockers: [...new Set(blockers)],
  });
}
