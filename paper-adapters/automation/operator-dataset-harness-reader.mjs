import fs from 'node:fs';
import path from 'node:path';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  validateOperatorDatasetHarnessEnvelope,
} from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import { inspectStrictDatasetManifest } from '../runtime/execution-snapshot.mjs';
import {
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../authority/authority-signatures.mjs';
import {
  operatorDatasetHarnessPrivatePath,
  persistOperatorDatasetHarnessEnvelope,
} from './operator-dataset-harness-private-repository.mjs';

const MAXIMUM_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_AUTHORITY_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;

export function loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot, trustStoreOverride = null } = {}) {
  if (trustStoreOverride) return trustStoreOverride;
  if (!runtimeRoot) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(path.resolve(runtimeRoot), 'trust', 'AUTHORITY_TRUST_STORE.json'), 'utf8'));
  } catch { return null; }
}

function readPrivateEnvelope(envelopePath) {
  let descriptor = null;
  try {
    const requested = path.resolve(String(envelopePath || ''));
    const canonical = fs.realpathSync(requested);
    const identity = fs.lstatSync(canonical);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : identity.uid;
    if (requested !== canonical || !identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
      || identity.uid !== currentUid || (identity.mode & 0o077) !== 0 || identity.size > MAXIMUM_ENVELOPE_BYTES) {
      return { canonical, content: null, hash: null, blocker: 'operator_dataset_harness_envelope_identity_invalid' };
    }
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== identity.dev || opened.ino !== identity.ino
      || opened.uid !== identity.uid || opened.mode !== identity.mode || opened.size !== identity.size
      || opened.mtimeMs !== identity.mtimeMs || opened.ctimeMs !== identity.ctimeMs || opened.size > MAXIMUM_ENVELOPE_BYTES) {
      return { canonical, content: null, hash: null, blocker: 'operator_dataset_harness_envelope_replaced' };
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.uid !== opened.uid || after.mode !== opened.mode
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || content.length !== opened.size) {
      return { canonical, content: null, hash: null, blocker: 'operator_dataset_harness_envelope_changed_during_read' };
    }
    return { canonical, content, hash: hashBytes(content), blocker: null };
  } catch {
    return { canonical: null, content: null, hash: null, blocker: 'operator_dataset_harness_envelope_unreadable' };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function compareDatasetFileManifest(splitManifest, inspection) {
  const actual = (inspection?.entries || [])
    .filter((entry) => entry.type === 'file')
    .map((entry) => ({ path: entry.relative, sha256: entry.hash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const declared = (splitManifest?.entries || [])
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return JSON.stringify(actual) === JSON.stringify(declared);
}

export function rereadOperatorDatasetHarnessPrivateDefinition(datasetAuthorization, {
  authorityTrustStore = null,
  now = new Date(),
  runtimeRoot = null,
  selector = null,
} = {}) {
  const blockers = [];
  const selectorAnalysisProtocolHash = selector?.experimentDesign?.analysisProtocolTemplateHash
    || selector?.analysisProtocolHash
    || null;
  const handle = datasetAuthorization?.benchmarkHarnessDocumentHash
    || selector?.operatorDatasetHarnessDocumentHash
    || null;
  const envelopeRead = readPrivateEnvelope(operatorDatasetHarnessPrivatePath(runtimeRoot, handle));
  if (envelopeRead.blocker) blockers.push(envelopeRead.blocker);
  let validated = null;
  try {
    validated = validateOperatorDatasetHarnessEnvelope(
      envelopeRead.content ? JSON.parse(envelopeRead.content.toString('utf8')) : null,
      {
        datasetName: datasetAuthorization?.name,
        datasetManifestHash: datasetAuthorization?.manifestHash,
      },
    );
  } catch (error) {
    blockers.push(String(error?.message || 'operator_dataset_harness_envelope_invalid'));
  }
  const signatureVerification = verifyAuthoritySignatures({
    document: validated?.authority || null,
    trustStore: authorityTrustStore,
    requiredRoles: ['dataset_harness_operator'],
    minSignatures: 1,
  });
  blockers.push(...signatureVerification.blockers.map((blocker) => `operator_dataset_authority:${blocker}`));
  const timeVerification = verifyAuthorityTimeWindow({
    signedAt: validated?.authority?.signedAt,
    expiresAt: validated?.authority?.expiresAt,
    now,
    maximumLifetimeMs: MAXIMUM_AUTHORITY_LIFETIME_MS,
  });
  blockers.push(...timeVerification.blockers.map((blocker) => `operator_dataset_authority:${blocker}`));
  if (validated && (
    envelopeRead.hash !== handle
    || datasetAuthorization?.operatorAuthorizationHash !== validated.operatorDatasetAuthorityDocumentHash
    || datasetAuthorization?.operatorDatasetAuthorityDocumentHash !== validated.operatorDatasetAuthorityDocumentHash
    || datasetAuthorization?.splitManifestHash !== validated.operatorDatasetSplitManifestHash
    || datasetAuthorization?.benchmarkHarnessDefinitionHash !== validated.operatorDatasetHarnessDefinitionHash
    || datasetAuthorization?.analysisProtocolHash !== validated.analysisProtocolHash
    || datasetAuthorization?.benchmarkFamily !== validated.definition?.benchmarkFamily
    || JSON.stringify(datasetAuthorization?.operatorDatasetAuthority) !== JSON.stringify(validated.authority)
    || JSON.stringify(datasetAuthorization?.analysisProtocol) !== JSON.stringify(validated.analysisProtocol)
    || selector?.datasetMountName !== datasetAuthorization?.name
    || selector?.datasetManifestHash !== datasetAuthorization?.manifestHash
    || selector?.operatorDatasetHarnessDocumentHash !== envelopeRead.hash
    || selector?.operatorDatasetHarnessDefinitionHash !== validated.operatorDatasetHarnessDefinitionHash
    || selector?.operatorDatasetAuthorityDocumentHash !== validated.operatorDatasetAuthorityDocumentHash
    || selectorAnalysisProtocolHash !== validated.analysisProtocolHash
  )) blockers.push('operator_dataset_private_definition_binding_mismatch');
  const authorityVerification = Object.freeze({
    status: blockers.some((blocker) => blocker.startsWith('operator_dataset_authority:'))
      ? 'operator_dataset_authority_blocked'
      : 'operator_dataset_authority_verified',
    cryptographicSignaturesVerified: signatureVerification.cryptographicSignaturesVerified,
    verifiedSignatures: signatureVerification.verifiedSignatures,
    verifiedRoles: signatureVerification.verifiedRoles,
    verifiedSubjectIds: signatureVerification.verifiedSubjectIds,
    timeWindowValid: timeVerification.valid,
    signedAt: timeVerification.signedAt,
    expiresAt: timeVerification.expiresAt,
  });
  const payload = {
    version: 1,
    kind: 'OperatorDatasetPrivateDefinitionResolution',
    status: blockers.length
      ? 'operator_dataset_private_definition_blocked'
      : 'operator_dataset_private_definition_resolved',
    datasetName: datasetAuthorization?.name || null,
    datasetManifestHash: datasetAuthorization?.manifestHash || null,
    envelopeDocumentHash: envelopeRead.hash || null,
    operatorDatasetAuthorityDocumentHash: validated?.operatorDatasetAuthorityDocumentHash || null,
    operatorDatasetHarnessDefinitionHash: validated?.operatorDatasetHarnessDefinitionHash || null,
    analysisProtocolHash: validated?.analysisProtocolHash || null,
    operatorDatasetAuthorityVerificationHash: hashRecord('OperatorDatasetAuthorityVerification', authorityVerification),
    authorityVerification,
    rawOraclePublished: false,
    blockers: [...new Set(blockers)],
  };
  const result = {
    receipt: Object.freeze({
      ...payload,
      operatorDatasetPrivateDefinitionResolutionHash: hashRecord('OperatorDatasetPrivateDefinitionResolution', payload),
    }),
  };
  Object.defineProperty(result, 'privateDefinition', {
    value: blockers.length ? null : validated.definition,
    enumerable: false,
  });
  return Object.freeze(result);
}

export function readOperatorDatasetHarness(datasetMount, {
  authorityTrustStore = null,
  now = new Date(),
  runtimeRoot = null,
  privateEnvelopePath = null,
  allowLegacyAnalysisProtocol = false,
} = {}) {
  const blockers = [];
  let source = null;
  try { source = fs.realpathSync(path.resolve(String(datasetMount?.source || ''))); }
  catch { blockers.push('operator_dataset_source_unreadable'); }
  const registeredEnvelopePath = operatorDatasetHarnessPrivatePath(runtimeRoot, datasetMount?.operatorDatasetHarnessHandle);
  const envelopeRead = readPrivateEnvelope(privateEnvelopePath || registeredEnvelopePath);
  if (envelopeRead.blocker) blockers.push(envelopeRead.blocker);
  if (source && envelopeRead.canonical && isPathWithin(source, envelopeRead.canonical)) {
    blockers.push('operator_dataset_harness_must_be_host_only_outside_dataset');
  }
  let parsed = null;
  let validated = null;
  try {
    parsed = envelopeRead.content ? JSON.parse(envelopeRead.content.toString('utf8')) : null;
    validated = validateOperatorDatasetHarnessEnvelope(parsed, {
      datasetName: datasetMount?.name,
      datasetManifestHash: datasetMount?.manifestHash,
    });
  } catch (error) { blockers.push(String(error?.message || 'operator_dataset_harness_envelope_invalid')); }
  if (validated && !validated.academicAnalysisProtocolEligible && !allowLegacyAnalysisProtocol) {
    blockers.push('operator_dataset_analysis_protocol_required');
  }
  const datasetInspection = source ? inspectStrictDatasetManifest(source, source) : null;
  if (datasetInspection?.sourceType !== 'directory' || datasetInspection?.blockers?.length) {
    blockers.push('operator_dataset_worker_exposure_manifest_unreadable');
  }
  if (datasetInspection?.hash !== datasetMount?.manifestHash
    || validated?.authority?.datasetManifestHash !== datasetInspection?.hash) {
    blockers.push('operator_dataset_manifest_identity_mismatch');
  }
  if (validated && !compareDatasetFileManifest(validated.splitManifest, datasetInspection)) {
    blockers.push('operator_dataset_split_manifest_files_mismatch');
  }
  if (validated?.authority?.datasetLicenseId !== datasetMount?.licenseId) {
    blockers.push('operator_dataset_license_authority_mismatch');
  }
  const signatureVerification = verifyAuthoritySignatures({
    document: validated?.authority || null,
    trustStore: authorityTrustStore,
    requiredRoles: ['dataset_harness_operator'],
    minSignatures: 1,
  });
  blockers.push(...signatureVerification.blockers.map((blocker) => `operator_dataset_authority:${blocker}`));
  const timeVerification = verifyAuthorityTimeWindow({
    signedAt: validated?.authority?.signedAt,
    expiresAt: validated?.authority?.expiresAt,
    now,
    maximumLifetimeMs: MAXIMUM_AUTHORITY_LIFETIME_MS,
  });
  blockers.push(...timeVerification.blockers.map((blocker) => `operator_dataset_authority:${blocker}`));
  if (validated && (
    datasetMount?.operatorAuthorizationHash !== validated.operatorDatasetAuthorityDocumentHash
    || datasetMount?.operatorDatasetAuthorityDocumentHash !== validated.operatorDatasetAuthorityDocumentHash
    || datasetMount?.splitManifestHash !== validated.operatorDatasetSplitManifestHash
    || datasetMount?.benchmarkHarnessDefinitionHash !== validated.operatorDatasetHarnessDefinitionHash
    || datasetMount?.analysisProtocolHash !== validated.analysisProtocolHash
    || JSON.stringify(datasetMount?.analysisProtocol) !== JSON.stringify(validated.analysisProtocol)
    || datasetMount?.benchmarkHarnessDocumentHash !== envelopeRead.hash
    || datasetMount?.operatorDatasetHarnessHandle !== envelopeRead.hash
    || JSON.stringify(datasetMount?.operatorDatasetAuthority) !== JSON.stringify(validated.authority)
    || (validated.authority.version === 3 && (
      datasetMount?.operatorDatasetResearchSemanticsHash
        !== hashRecord('OperatorDatasetResearchSemantics', validated.authority.researchSemantics)
      || JSON.stringify(datasetMount?.operatorDatasetResearchSemantics)
        !== JSON.stringify(validated.authority.researchSemantics)
    ))
  )) blockers.push('operator_dataset_harness_plan_binding_mismatch');
  const authorityVerification = Object.freeze({
    status: blockers.some((blocker) => blocker.startsWith('operator_dataset_authority:'))
      ? 'operator_dataset_authority_blocked'
      : 'operator_dataset_authority_verified',
    cryptographicSignaturesVerified: signatureVerification.cryptographicSignaturesVerified,
    verifiedSignatures: signatureVerification.verifiedSignatures,
    verifiedRoles: signatureVerification.verifiedRoles,
    verifiedSubjectIds: signatureVerification.verifiedSubjectIds,
    timeWindowValid: timeVerification.valid,
    signedAt: timeVerification.signedAt,
    expiresAt: timeVerification.expiresAt,
  });
  const payload = {
    version: 3,
    kind: 'OperatorDatasetHarnessAuthorityReceipt',
    status: blockers.length ? 'operator_dataset_harness_authority_blocked' : 'operator_dataset_harness_authority_verified',
    datasetName: datasetMount?.name || null,
    datasetManifestHash: datasetMount?.manifestHash || null,
    datasetSplitManifestHash: validated?.operatorDatasetSplitManifestHash || datasetMount?.splitManifestHash || null,
    datasetLicenseId: datasetMount?.licenseId || null,
    operatorAuthorizationHash: validated?.operatorDatasetAuthorityDocumentHash || null,
    operatorDatasetAuthorityDocumentHash: validated?.operatorDatasetAuthorityDocumentHash || null,
    benchmarkHarnessDefinitionHash: validated?.operatorDatasetHarnessDefinitionHash || null,
    benchmarkFamily: validated?.definition?.benchmarkFamily || null,
    analysisProtocol: validated?.analysisProtocol || null,
    analysisProtocolHash: validated?.analysisProtocolHash || null,
    ...(validated?.authority?.version === 3 ? {
      operatorDatasetResearchSemantics: validated.authority.researchSemantics,
      operatorDatasetResearchSemanticsHash: hashRecord(
        'OperatorDatasetResearchSemantics', validated.authority.researchSemantics,
      ),
    } : {}),
    authority: validated?.authority || null,
    envelopeDocumentHash: envelopeRead.hash || null,
    operatorDatasetAuthorityVerificationHash: hashRecord('OperatorDatasetAuthorityVerification', authorityVerification),
    authorityVerification,
    authorizationScheme: 'ed25519-signed-host-only-dataset-harness-v1',
    evidenceAuthority: 'host-owned-hidden-fixture-reader-and-evaluator-v2',
    analysisAuthority: 'operator-signed-preregistered-analysis-protocol-v1',
    workerDatasetExposure: 'signed-complete-dataset-file-manifest-v1',
    hostOnlyHarnessMounted: false,
    rawOraclePublished: false,
    blockers: [...new Set(blockers)],
    externalActionPerformed: false,
  };
  const receipt = Object.freeze({
    ...payload,
    operatorDatasetHarnessAuthorityReceiptHash: hashRecord('OperatorDatasetHarnessAuthorityReceipt', payload),
  });
  return Object.freeze({
    receipt,
    privateDefinition: blockers.length ? null : validated.definition,
    privateSplitManifest: blockers.length ? null : validated.splitManifest,
  });
}

export function authorizeOperatorDatasetMount(datasetMount, {
  envelopePath,
  authorityTrustStore,
  now = new Date(),
  runtimeRoot = null,
  persistPrivateEnvelope = false,
  allowLegacyAnalysisProtocol = false,
} = {}) {
  const provisional = Object.freeze({ ...datasetMount });
  const envelopeRead = readPrivateEnvelope(path.resolve(String(envelopePath || '')));
  if (envelopeRead.blocker) throw new Error(envelopeRead.blocker);
  let validated = null;
  try {
    validated = validateOperatorDatasetHarnessEnvelope(
      envelopeRead.content ? JSON.parse(envelopeRead.content.toString('utf8')) : null,
      { datasetName: provisional.name, datasetManifestHash: provisional.manifestHash },
    );
  } catch (error) {
    throw new Error(String(error?.message || envelopeRead.blocker || 'operator_dataset_harness_envelope_invalid'));
  }
  const enriched = Object.freeze({
    ...provisional,
    operatorDatasetHarnessHandle: envelopeRead.hash,
    operatorAuthorizationHash: validated.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthorityDocumentHash: validated.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthority: validated.authority,
    splitManifestHash: validated.operatorDatasetSplitManifestHash,
    benchmarkHarnessDocumentHash: envelopeRead.hash,
    benchmarkHarnessDefinitionHash: validated.operatorDatasetHarnessDefinitionHash,
    benchmarkFamily: validated.definition.benchmarkFamily,
    benchmarkSeedSchedule: validated.definition.seedSchedule,
    benchmarkMinimumRepetitions: validated.definition.minimumRepetitions,
    analysisProtocol: validated.analysisProtocol,
    analysisProtocolHash: validated.analysisProtocolHash,
    ...(validated.authority.version === 3 ? {
      operatorDatasetResearchSemantics: validated.authority.researchSemantics,
      operatorDatasetResearchSemanticsHash: hashRecord(
        'OperatorDatasetResearchSemantics', validated.authority.researchSemantics,
      ),
    } : {}),
  });
  const resolution = readOperatorDatasetHarness(enriched, {
    authorityTrustStore,
    now,
    privateEnvelopePath: envelopeRead.canonical,
    allowLegacyAnalysisProtocol,
  });
  if (resolution.receipt.status !== 'operator_dataset_harness_authority_verified') {
    throw new Error(resolution.receipt.blockers.join(',') || 'operator_dataset_harness_authority_blocked');
  }
  if (persistPrivateEnvelope) persistOperatorDatasetHarnessEnvelope({
    runtimeRoot,
    handle: envelopeRead.hash,
    content: envelopeRead.content,
  });
  return enriched;
}
