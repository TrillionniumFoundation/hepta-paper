import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { signAuthorityDocument, verifyAuthorityTimeWindow } from '../authority/authority-signatures.mjs';
import { inspectStrictDatasetManifest } from '../runtime/execution-snapshot.mjs';
import {
  authorizeOperatorDatasetMount,
  localGoldenDatasetRuntimeRootHash,
} from './operator-dataset-harness-reader.mjs';
import {
  operatorDatasetHarnessPrivatePath,
} from './operator-dataset-harness-private-repository.mjs';
import {
  removeLocalGoldenDatasetStagingOutput,
  writeLocalGoldenDatasetOutputNoClobber,
} from './local-golden-dataset-provisioning-repository.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { isDatasetLicenseId } from '../../paper-domain/automation/empirical-contract.mjs';
import {
  LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,
  LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,
  LOCAL_GOLDEN_DATASET_AUTHORITY_KIND,
  LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE,
  LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
  LOCAL_GOLDEN_DATASET_ENVELOPE_KIND,
  validateOperatorDatasetAuthorityDocument,
  validateOperatorDatasetHarnessDefinition,
  validateOperatorDatasetHarnessEnvelope,
  validateOperatorDatasetResearchSemantics,
  validateOperatorDatasetSplitManifest,
} from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import { validateAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';

const MAXIMUM_JSON_BYTES = 8 * 1024 * 1024;
const MAXIMUM_PRIVATE_KEY_BYTES = 64 * 1024;
const MAXIMUM_AUTHORITY_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const BUILTIN_PROTECTED_ROOTS = Object.freeze([
  '/var/lib/hepta-paper',
  '/srv/hepta-paper',
  '/etc/hepta-paper',
  '/opt/hepta-paper',
]);

function pathsOverlap(left, right) {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function canonicalExistingDirectory(candidate, role, { privateDirectory = false } = {}) {
  const requested = path.resolve(String(candidate || ''));
  let canonical;
  let identity;
  try {
    canonical = fs.realpathSync(requested);
    identity = fs.lstatSync(canonical);
  } catch { throw new Error(`local_golden_dataset_${role}_unreadable`); }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : identity.uid;
  if (requested !== canonical || !identity.isDirectory() || identity.isSymbolicLink()
    || identity.uid !== currentUid || (identity.mode & 0o022) !== 0
    || (privateDirectory && (identity.mode & 0o077) !== 0)) {
    throw new Error(`local_golden_dataset_${role}_identity_invalid`);
  }
  return canonical;
}

function readStableFile(candidate, role, { privateFile = false, maximumBytes = MAXIMUM_JSON_BYTES } = {}) {
  const requested = path.resolve(String(candidate || ''));
  let descriptor = null;
  try {
    const canonical = fs.realpathSync(requested);
    const before = fs.lstatSync(canonical);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : before.uid;
    if (canonical !== requested || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.uid !== currentUid || (before.mode & 0o022) !== 0
      || (privateFile && (before.mode & 0o077) !== 0)
      || before.size < 1 || before.size > maximumBytes) {
      throw new Error(`local_golden_dataset_${role}_identity_invalid`);
    }
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode
      || opened.uid !== before.uid || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs) {
      throw new Error(`local_golden_dataset_${role}_replaced`);
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || content.length !== opened.size) {
      throw new Error(`local_golden_dataset_${role}_changed_during_read`);
    }
    return Object.freeze({ canonical, content, hash: hashBytes(content) });
  } catch (error) {
    if (String(error?.message || '').startsWith('local_golden_dataset_')) throw error;
    throw new Error(`local_golden_dataset_${role}_unreadable`);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function readStableJson(candidate, role, options = {}) {
  const read = readStableFile(candidate, role, options);
  let value;
  try { value = JSON.parse(read.content.toString('utf8')); }
  catch { throw new Error(`local_golden_dataset_${role}_json_invalid`); }
  return Object.freeze({ ...read, value });
}

function immutableDatasetInspection(datasetRoot) {
  const inspection = inspectStrictDatasetManifest(datasetRoot, datasetRoot);
  if (inspection.sourceType !== 'directory' || inspection.blockers.length || !inspection.hash) {
    throw new Error(`local_golden_dataset_manifest_invalid:${inspection.blockers.join(',')}`);
  }
  const identities = [datasetRoot, ...inspection.entries.map((entry) => path.join(datasetRoot, entry.relative))];
  for (const candidate of identities) {
    const identity = fs.lstatSync(candidate);
    if (identity.isSymbolicLink() || (identity.mode & 0o222) !== 0) {
      throw new Error('local_golden_dataset_source_must_be_immutable');
    }
  }
  return inspection;
}

function protectedRoots({ workspaceRoot, protectedRoots = [] } = {}) {
  return [...new Set([
    ...BUILTIN_PROTECTED_ROOTS,
    repositoryRoot,
    workspaceRoot,
    ...protectedRoots,
  ].filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

function assertIsolatedRoots({ runtimeRoot, controlRoot, datasetRoot, inputPaths, protectedRoots: selectedProtectedRoots }) {
  const roots = { runtimeRoot, controlRoot, datasetRoot };
  for (const [leftName, left] of Object.entries(roots)) {
    for (const [rightName, right] of Object.entries(roots)) {
      if (leftName < rightName && pathsOverlap(left, right)) {
        throw new Error(`local_golden_dataset_roots_overlap:${leftName}:${rightName}`);
      }
    }
  }
  for (const [name, candidate] of Object.entries({ ...roots, ...inputPaths })) {
    if (selectedProtectedRoots.some((blocked) => pathsOverlap(blocked, candidate))) {
      throw new Error(`local_golden_dataset_protected_root_forbidden:${name}`);
    }
  }
  for (const [name, candidate] of Object.entries(inputPaths)) {
    if (isPathWithin(datasetRoot, candidate)) {
      throw new Error(`local_golden_dataset_control_input_inside_dataset:${name}`);
    }
  }
  if (isPathWithin(runtimeRoot, inputPaths.authorityPrivateKeyPath)
    || isPathWithin(controlRoot, inputPaths.authorityPrivateKeyPath)) {
    throw new Error('local_golden_dataset_private_key_inside_output_scope');
  }
}

function splitManifestFromAssignments(assignments, inspection, datasetName) {
  if (!exactKeys(assignments, ['version', 'kind', 'datasetName', 'entries'])
    || assignments.version !== 1 || assignments.kind !== 'LocalGoldenDatasetSplitAssignments'
    || assignments.datasetName !== datasetName || !Array.isArray(assignments.entries)) {
    throw new Error('local_golden_dataset_split_assignments_invalid');
  }
  const assignmentsByPath = new Map();
  for (const entry of assignments.entries) {
    if (!exactKeys(entry, ['path', 'split']) || assignmentsByPath.has(entry.path)
      || !['train', 'validation', 'public'].includes(entry.split)) {
      throw new Error('local_golden_dataset_split_assignments_invalid');
    }
    assignmentsByPath.set(String(entry.path), String(entry.split));
  }
  const files = inspection.entries.filter((entry) => entry.type === 'file');
  if (assignmentsByPath.size !== files.length
    || files.some((entry) => !assignmentsByPath.has(entry.relative))) {
    throw new Error('local_golden_dataset_split_assignments_incomplete');
  }
  return validateOperatorDatasetSplitManifest({
    version: 1,
    kind: 'OperatorDatasetSplitManifest',
    datasetName,
    datasetManifestHash: inspection.hash,
    entries: files.map((entry) => ({
      path: entry.relative,
      sha256: entry.hash,
      split: assignmentsByPath.get(entry.relative),
    })),
  }, { datasetName, datasetManifestHash: inspection.hash });
}

function selectedTrustKey(trustStore, keyId) {
  const publicKeyFields = new Set([
    'keyId', 'subjectId', 'organization', 'algorithm', 'publicKeyPem', 'roles',
    'status', 'revoked', 'effectiveFrom', 'validFrom', 'expiresAt', 'revokedAt',
    'keyPurpose', 'authorityScope', 'academicPromotionEligible',
    'externalTrustClaimed',
  ]);
  if (!exactKeys(trustStore, [
    'version', 'kind', 'authorityScope', 'evidenceClass',
    'academicPromotionEligible', 'externalTrustClaimed', 'keyPurpose', 'keys',
  ])
    || trustStore?.version !== 1 || trustStore?.kind !== 'AuthorityTrustStore'
    || trustStore.authorityScope !== LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE
    || trustStore.evidenceClass !== LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS
    || trustStore.academicPromotionEligible !== false
    || trustStore.externalTrustClaimed !== false
    || trustStore.keyPurpose !== LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE
    || !Array.isArray(trustStore.keys)
    || trustStore.keys.length < 1
    || new Set(trustStore.keys.map((key) => String(key?.keyId || ''))).size
      !== trustStore.keys.length
    || trustStore.keys.some((key) => !key || typeof key !== 'object' || Array.isArray(key)
      || Object.keys(key).some((field) => !publicKeyFields.has(field))
      || !key.keyId || !key.subjectId || key.algorithm !== 'ed25519'
      || !Array.isArray(key.roles) || key.roles.length !== 1
      || key.roles[0] !== LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE
      || key.keyPurpose !== LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE
      || key.authorityScope !== LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE
      || key.academicPromotionEligible !== false
      || key.externalTrustClaimed !== false
      || !key.publicKeyPem || key.privateKeyPem
      || /PRIVATE KEY/.test(String(key.publicKeyPem)))
    || /PRIVATE KEY/.test(JSON.stringify(trustStore))) {
    throw new Error('local_golden_dataset_public_trust_store_invalid');
  }
  const matches = trustStore.keys.filter((key) => String(key?.keyId || '') === keyId);
  const key = matches.length === 1 ? matches[0] : null;
  if (!key || key.algorithm !== 'ed25519' || key.status !== 'active'
    || !Array.isArray(key.roles) || key.roles.length !== 1
    || key.roles[0] !== LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE
    || key.keyPurpose !== LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE
    || key.authorityScope !== LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE
    || key.academicPromotionEligible !== false
    || key.externalTrustClaimed !== false
    || !key.publicKeyPem || key.privateKeyPem) {
    throw new Error('local_golden_dataset_authority_key_not_trusted');
  }
  try {
    if (crypto.createPublicKey(key.publicKeyPem).asymmetricKeyType !== 'ed25519') {
      throw new Error('not_ed25519');
    }
  }
  catch { throw new Error('local_golden_dataset_authority_public_key_invalid'); }
  return key;
}

function normalizedInputs(options = {}) {
  const datasetName = String(options.datasetName || '');
  const isolationId = String(options.isolationId || '');
  const authorityKeyId = String(options.authorityKeyId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(datasetName)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(isolationId)
    || !authorityKeyId || !isDatasetLicenseId(options.datasetLicenseId)) {
    throw new Error('local_golden_dataset_identity_invalid');
  }
  const selectedProtectedRoots = protectedRoots(options);
  const requestedPaths = Object.freeze(Object.fromEntries([
    'runtimeRoot', 'controlRoot', 'datasetRoot', 'splitAssignmentsPath',
    'harnessDefinitionPath', 'analysisProtocolPath', 'researchSemanticsPath',
    'authorityTrustStorePath', 'authorityPrivateKeyPath', 'mountOutputPath',
  ].map((name) => [name, path.resolve(String(options[name] || ''))])));
  for (const [name, candidate] of Object.entries(requestedPaths)) {
    if (selectedProtectedRoots.some((blocked) => pathsOverlap(blocked, candidate))) {
      throw new Error(`local_golden_dataset_protected_root_forbidden:${name}`);
    }
  }
  const runtimeRoot = canonicalExistingDirectory(options.runtimeRoot, 'runtime_root', { privateDirectory: true });
  const controlRoot = canonicalExistingDirectory(options.controlRoot, 'control_root', { privateDirectory: true });
  const datasetRoot = canonicalExistingDirectory(options.datasetRoot, 'dataset_root');
  const inputPaths = Object.freeze(Object.fromEntries([
    'splitAssignmentsPath', 'harnessDefinitionPath', 'analysisProtocolPath',
    'researchSemanticsPath', 'authorityTrustStorePath', 'authorityPrivateKeyPath',
  ].map((name) => [name, path.resolve(String(options[name] || ''))])));
  const mountOutputPath = path.resolve(String(options.mountOutputPath || ''));
  if (!isPathWithin(controlRoot, mountOutputPath) || mountOutputPath === controlRoot
    || path.extname(mountOutputPath).toLowerCase() !== '.json') {
    throw new Error('local_golden_dataset_mount_output_outside_control_root');
  }
  const receiptOutputPath = `${mountOutputPath.slice(0, -5)}.provisioning-receipt.json`;
  assertIsolatedRoots({
    runtimeRoot,
    controlRoot,
    datasetRoot,
    inputPaths,
    protectedRoots: selectedProtectedRoots,
  });
  return Object.freeze({
    datasetName,
    isolationId,
    authorityKeyId,
    datasetLicenseId: String(options.datasetLicenseId),
    runtimeRoot,
    controlRoot,
    datasetRoot,
    inputPaths,
    mountOutputPath,
    receiptOutputPath,
  });
}

export function inspectLocalGoldenDatasetProvisioning(options = {}) {
  const inputs = normalizedInputs(options);
  const inspection = immutableDatasetInspection(inputs.datasetRoot);
  const splitInput = readStableJson(inputs.inputPaths.splitAssignmentsPath, 'split_assignments');
  const harnessInput = readStableJson(inputs.inputPaths.harnessDefinitionPath, 'harness_definition', { privateFile: true });
  const analysisInput = readStableJson(inputs.inputPaths.analysisProtocolPath, 'analysis_protocol');
  const semanticsInput = readStableJson(inputs.inputPaths.researchSemanticsPath, 'research_semantics');
  const trustInput = readStableJson(inputs.inputPaths.authorityTrustStorePath, 'authority_trust_store');
  const split = splitManifestFromAssignments(splitInput.value, inspection, inputs.datasetName);
  const harness = validateOperatorDatasetHarnessDefinition(harnessInput.value, { benchmarkId: inputs.datasetName });
  const analysis = validateAnalysisProtocol(analysisInput.value, {
    benchmarkId: inputs.datasetName,
    benchmarkFamily: harness.definition.benchmarkFamily,
  });
  const semantics = validateOperatorDatasetResearchSemantics(semanticsInput.value);
  selectedTrustKey(trustInput.value, inputs.authorityKeyId);
  if (split.splitManifest.entries.some((entry) => !semantics.researchSemantics.eligibleSplits.includes(entry.split))) {
    throw new Error('local_golden_dataset_research_semantics_split_mismatch');
  }
  const time = verifyAuthorityTimeWindow({
    signedAt: options.signedAt,
    expiresAt: options.expiresAt,
    now: options.now || new Date(),
    maximumLifetimeMs: MAXIMUM_AUTHORITY_LIFETIME_MS,
  });
  if (!time.valid) throw new Error(`local_golden_dataset_authority_time_invalid:${time.blockers.join(',')}`);
  const runtimeRootHash = localGoldenDatasetRuntimeRootHash(inputs.runtimeRoot);
  if (!runtimeRootHash) throw new Error('local_golden_dataset_runtime_root_identity_invalid');
  const planPayload = {
    version: 1,
    kind: 'LocalGoldenDatasetProvisioningPlan',
    datasetName: inputs.datasetName,
    datasetManifestHash: inspection.hash,
    datasetLicenseId: inputs.datasetLicenseId,
    splitManifestHash: split.operatorDatasetSplitManifestHash,
    harnessDefinitionHash: harness.operatorDatasetHarnessDefinitionHash,
    analysisProtocolHash: analysis.analysisProtocolHash,
    researchSemanticsHash: semantics.operatorDatasetResearchSemanticsHash,
    authorityTrustStoreHash: hashRecord('LocalGoldenDatasetAuthorityTrustStore', trustInput.value),
    authorityKeyId: inputs.authorityKeyId,
    authorityKeyPurpose: LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,
    authorityPrivateKeyPathHash: hashRecord('LocalGoldenDatasetPrivateKeyPath', {
      path: inputs.inputPaths.authorityPrivateKeyPath,
    }),
    signedAt: time.signedAt,
    expiresAt: time.expiresAt,
    authorityScope: LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,
    evidenceClass: LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
    academicPromotionEligible: false,
    externalTrustClaimed: false,
    localGoldenRuntimeScope: {
      version: 1,
      kind: 'LocalGoldenDatasetRuntimeScope',
      isolationId: inputs.isolationId,
      runtimeRootHash,
    },
    mountOutputPath: inputs.mountOutputPath,
    receiptOutputPath: inputs.receiptOutputPath,
    externalActionPerformed: false,
  };
  const plan = Object.freeze({
    ...planPayload,
    localGoldenDatasetProvisioningPlanId: hashRecord('LocalGoldenDatasetProvisioningPlan', planPayload),
    ready: true,
  });
  const result = { plan };
  Object.defineProperty(result, 'inputs', { value: inputs, enumerable: false });
  Object.defineProperty(result, 'privateMaterial', { value: Object.freeze({
    inspection,
    split,
    harness,
    analysis,
    semantics,
    trustStore: trustInput.value,
  }), enumerable: false });
  return Object.freeze(result);
}

export function executeLocalGoldenDatasetProvisioning(options = {}) {
  const inspected = inspectLocalGoldenDatasetProvisioning(options);
  const expectedPlanId = String(options.expectedPlanId || '');
  if (expectedPlanId !== inspected.plan.localGoldenDatasetProvisioningPlanId) {
    throw new Error('local_golden_dataset_provisioning_plan_id_mismatch');
  }
  const privateKeyRead = readStableFile(
    inspected.inputs.inputPaths.authorityPrivateKeyPath,
    'authority_private_key',
    { privateFile: true, maximumBytes: MAXIMUM_PRIVATE_KEY_BYTES },
  );
  let privateKey;
  let derivedPublic;
  try {
    privateKey = crypto.createPrivateKey(privateKeyRead.content);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('not_ed25519');
    }
    derivedPublic = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  } catch { throw new Error('local_golden_dataset_authority_private_key_invalid'); }
  finally { privateKeyRead.content.fill(0); }
  const trustKey = selectedTrustKey(
    inspected.privateMaterial.trustStore,
    inspected.inputs.authorityKeyId,
  );
  const trustedPublic = crypto.createPublicKey(trustKey.publicKeyPem).export({ type: 'spki', format: 'der' });
  if (!Buffer.from(derivedPublic).equals(Buffer.from(trustedPublic))) {
    throw new Error('local_golden_dataset_authority_key_pair_mismatch');
  }
  const authority = signAuthorityDocument({
    version: 4,
    kind: LOCAL_GOLDEN_DATASET_AUTHORITY_KIND,
    datasetName: inspected.inputs.datasetName,
    datasetManifestHash: inspected.privateMaterial.inspection.hash,
    datasetLicenseId: inspected.inputs.datasetLicenseId,
    datasetSplitManifestHash: inspected.privateMaterial.split.operatorDatasetSplitManifestHash,
    benchmarkHarnessDefinitionHash: inspected.privateMaterial.harness.operatorDatasetHarnessDefinitionHash,
    analysisProtocolHash: inspected.privateMaterial.analysis.analysisProtocolHash,
    researchSemantics: inspected.privateMaterial.semantics.researchSemantics,
    authorityScope: LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,
    evidenceClass: LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
    authorityKeyPurpose: LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,
    academicPromotionEligible: false,
    externalTrustClaimed: false,
    localGoldenRuntimeScope: inspected.plan.localGoldenRuntimeScope,
    benchmarkFamily: inspected.privateMaterial.harness.definition.benchmarkFamily,
    seedSchedule: inspected.privateMaterial.harness.definition.seedSchedule,
    minimumRepetitions: inspected.privateMaterial.harness.definition.minimumRepetitions,
    workerExposurePolicy: 'signed-complete-dataset-file-manifest-v1',
    signedAt: inspected.plan.signedAt,
    expiresAt: inspected.plan.expiresAt,
  }, {
    privateKeyPem: privateKey,
    keyId: inspected.inputs.authorityKeyId,
    role: LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE,
  });
  const envelope = {
    version: 4,
    kind: LOCAL_GOLDEN_DATASET_ENVELOPE_KIND,
    authority,
    splitManifest: inspected.privateMaterial.split.splitManifest,
    harnessDefinition: inspected.privateMaterial.harness.definition,
    analysisProtocol: inspected.privateMaterial.analysis.analysisProtocol,
  };
  validateOperatorDatasetAuthorityDocument(authority, {
    datasetName: inspected.inputs.datasetName,
    datasetManifestHash: inspected.privateMaterial.inspection.hash,
  });
  validateOperatorDatasetHarnessEnvelope(envelope, {
    datasetName: inspected.inputs.datasetName,
    datasetManifestHash: inspected.privateMaterial.inspection.hash,
  });
  const envelopeContent = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
  const stagingEnvelope = path.join(
    inspected.inputs.controlRoot,
    `.local-golden-dataset-envelope-${expectedPlanId.slice('sha256:'.length)}.json`,
  );
  writeLocalGoldenDatasetOutputNoClobber(stagingEnvelope, envelopeContent, 0o600, {
    allowedRoot: inspected.inputs.controlRoot,
  });
  let mount;
  try {
    mount = authorizeOperatorDatasetMount({
      name: inspected.inputs.datasetName,
      source: inspected.inputs.datasetRoot,
      readOnly: true,
      manifestHash: inspected.privateMaterial.inspection.hash,
      licenseId: inspected.inputs.datasetLicenseId,
    }, {
      envelopePath: stagingEnvelope,
      authorityTrustStore: inspected.privateMaterial.trustStore,
      now: options.now || new Date(),
      runtimeRoot: inspected.inputs.runtimeRoot,
      persistPrivateEnvelope: false,
    });
  } finally {
    removeLocalGoldenDatasetStagingOutput(stagingEnvelope, {
      allowedRoot: inspected.inputs.controlRoot,
    });
  }
  const selector = buildCampaignBenchmarkSelector({
    benchmarkId: inspected.inputs.datasetName,
    datasetMounts: [mount],
  });
  if (selector.authorityScope !== LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE
    || selector.evidenceClass !== LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS
    || selector.academicPromotionEligible !== false
    || selector.externalTrustClaimed !== false
    || selector.assuranceScope !== 'local-operator-hidden-evaluation-only-v1') {
    throw new Error('local_golden_dataset_promotion_boundary_invalid');
  }
  const trustStoreContent = Buffer.from(`${JSON.stringify(inspected.privateMaterial.trustStore, null, 2)}\n`);
  writeLocalGoldenDatasetOutputNoClobber(
    operatorDatasetHarnessPrivatePath(
      inspected.inputs.runtimeRoot,
      mount.benchmarkHarnessDocumentHash,
    ),
    envelopeContent,
    0o600,
    { allowedRoot: inspected.inputs.runtimeRoot },
  );
  writeLocalGoldenDatasetOutputNoClobber(
    path.join(inspected.inputs.runtimeRoot, 'trust', 'AUTHORITY_TRUST_STORE.json'),
    trustStoreContent,
    0o600,
    { allowedRoot: inspected.inputs.runtimeRoot },
  );
  const mountContent = Buffer.from(`${JSON.stringify([mount], null, 2)}\n`);
  const receiptPayload = {
    version: 1,
    kind: 'LocalGoldenDatasetProvisioningReceipt',
    status: 'local_golden_dataset_provisioned',
    localGoldenDatasetProvisioningPlanId: expectedPlanId,
    datasetName: inspected.inputs.datasetName,
    datasetManifestHash: mount.manifestHash,
    operatorDatasetAuthorityDocumentHash: mount.operatorDatasetAuthorityDocumentHash,
    operatorDatasetHarnessDocumentHash: mount.benchmarkHarnessDocumentHash,
    mountDocumentHash: hashBytes(mountContent),
    authorityScope: LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,
    evidenceClass: LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
    authorityKeyPurpose: LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,
    academicPromotionEligible: false,
    externalTrustClaimed: false,
    localGoldenRuntimeScope: inspected.plan.localGoldenRuntimeScope,
    deterministicOutputs: true,
    atomicNoClobberPublication: true,
    externalActionPerformed: false,
  };
  const receipt = Object.freeze({
    ...receiptPayload,
    localGoldenDatasetProvisioningReceiptHash: hashRecord(
      'LocalGoldenDatasetProvisioningReceipt', receiptPayload,
    ),
  });
  writeLocalGoldenDatasetOutputNoClobber(inspected.inputs.mountOutputPath, mountContent, 0o600, {
    allowedRoot: inspected.inputs.controlRoot,
  });
  writeLocalGoldenDatasetOutputNoClobber(
    inspected.inputs.receiptOutputPath,
    Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
    0o600,
    { allowedRoot: inspected.inputs.controlRoot },
  );
  return Object.freeze({ ...receipt, ready: true });
}
