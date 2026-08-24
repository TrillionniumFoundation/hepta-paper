#!/usr/bin/env node

// Read-only P0 evidence inventory.  This command deliberately does not call
// provider connectors, sign anything, create a receipt, mutate SQLite, or
// manufacture a hash/credential/acceptance.  It is an observation aid for an
// operator; release-readiness and all production gates remain authoritative.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { JOURNAL_SUBMISSION_CONNECTOR_COVERAGE } from '../../paper-domain/submission/journal-connector-coverage.mjs';
import {
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
  HEPTA_WORKSPACE_ROOT,
} from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { inspectReadOnlySqliteDatabase } from '../src/read-only-sqlite-observation.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import {
  loadCapabilityConformanceProofs,
  loadCapabilityOperationalProofs,
} from '../../paper-adapters/governance/capability-proof-verifier.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import {
  verifyOperationalSloAlertPolicy,
  verifyProductionIntegrityPin,
} from '../../paper-domain/operations/production-integrity-contract.mjs';
import {
  verifyHeptaStoreRestoreDrillReceipt,
} from '../../paper-domain/evidence/hepta-store-restore-drill-receipt-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const REQUIRED_AUTHORITY_ROLES = Object.freeze([
  'research-author',
  'independent-reviewer',
  'release-attestor',
  'external-qualifier',
]);
const ROLE_ALIASES = Object.freeze({
  'research-author': Object.freeze(['research-author', 'research_author']),
  'independent-reviewer': Object.freeze([
    'independent-reviewer', 'independent_reviewer', 'formal_reviewer',
  ]),
  'release-attestor': Object.freeze([
    'release-attestor', 'release_attestor', 'research_execution_release_attestor',
  ]),
  'external-qualifier': Object.freeze([
    'external-qualifier', 'external_qualifier', 'qualifier',
    'nested_runtime_platform_independent_qualifier',
  ]),
});

function absolute(candidate, fallback) {
  return path.resolve(String(candidate || fallback));
}

function unique(values) {
  return [...new Set(values.map((value) => String(value)))];
}

function regularFile(filePath, {
  maximumBytes = 8 * 1024 * 1024,
  allowGroupWritable = false,
} = {}) {
  if (!filePath) return { path: null, present: false, safe: false, value: null };
  const selected = path.resolve(String(filePath));
  try {
    const stat = fs.lstatSync(selected);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size < 1 || stat.size > maximumBytes
      || fs.realpathSync(selected) !== selected) {
      return { path: selected, present: true, safe: false, value: null };
    }
    const bytes = fs.readFileSync(selected);
    return {
      path: selected,
      present: true,
      // Runtime evidence defaults to a strict owner-only write policy.  Public
      // source/config callers may explicitly allow group-writable checkout
      // files; they are still never treated as external authority evidence.
      safe: (stat.mode & (allowGroupWritable ? 0o002 : 0o022)) === 0,
      value: bytes,
    };
  } catch {
    return { path: selected, present: false, safe: false, value: null };
  }
}

function jsonFile(filePath, options = {}) {
  const file = regularFile(filePath, options);
  // Parse an unsafe-but-readable public document so the report can distinguish
  // "present but permission-unsafe" from "missing".  Callers still add a
  // blocker whenever `safe` is false; no unsafe document is treated as ready.
  if (!file.present) return { ...file, parsed: false, document: null };
  try {
    const document = JSON.parse(file.value.toString('utf8'));
    return { ...file, parsed: true, document };
  } catch {
    return { ...file, parsed: false, document: null };
  }
}

function blockerList(...values) {
  return unique(values.flat().filter((value) => String(value || '').length > 0));
}

function section(evidenceClass, blockers, fields = {}) {
  const normalized = blockerList(blockers);
  return Object.freeze({
    evidenceClass,
    status: normalized.length ? 'blocked' : 'observed_ready',
    blockers: Object.freeze(normalized),
    ...fields,
  });
}

function safeBoolean(value) {
  return value === true;
}

function sha256Buffer(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function inspectRoles({ runtimeRoot, environment }) {
  const trustStorePath = absolute(
    environment.HEPTA_AUTHORITY_TRUST_STORE,
    path.join(runtimeRoot, 'trust', 'AUTHORITY_TRUST_STORE.json'),
  );
  const read = jsonFile(trustStorePath, { maximumBytes: 4 * 1024 * 1024 });
  const document = read.document;
  const keys = Array.isArray(document?.keys) ? document.keys : [];
  const activeKeys = keys.filter((key) => key?.status === 'active');
  const roleCounts = {};
  for (const key of activeKeys) {
    for (const role of Array.isArray(key?.roles) ? key.roles : []) {
      const normalized = String(role);
      roleCounts[normalized] = Number(roleCounts[normalized] || 0) + 1;
    }
  }
  const coveredRoles = REQUIRED_AUTHORITY_ROLES.filter((role) => (
    ROLE_ALIASES[role].some((alias) => Number(roleCounts[alias] || 0) > 0)
  ));
  const missingRoles = REQUIRED_AUTHORITY_ROLES.filter((role) => !coveredRoles.includes(role));
  const roleKeyIds = Object.fromEntries(REQUIRED_AUTHORITY_ROLES.map((role) => [
    role,
    [...new Set(activeKeys.filter((key) => ROLE_ALIASES[role].some((alias) => (
      Array.isArray(key?.roles) && key.roles.includes(alias)
    ))).map((key) => String(key.keyId || key.subjectId || ''))
      .filter(Boolean))],
  ]));
  const roleSubjects = [...new Set(Object.values(roleKeyIds).flat())];
  const allRolesHaveDistinctSubjects = roleSubjects.length >= coveredRoles.length;
  const roleAssurance = Object.fromEntries(REQUIRED_AUTHORITY_ROLES.map((role) => [
    role,
    roleKeyIds[role].map((keyId) => activeKeys.find((key) => (
      String(key.keyId || key.subjectId || '') === keyId
    ))?.assurance || 'unspecified'),
  ]));
  const privateKeyMaterialDetected = keys.some((key) => (
    Boolean(key?.privateKeyPem) || /PRIVATE KEY/.test(String(key?.publicKeyPem || ''))
  ));
  const blockers = [];
  if (!read.present) blockers.push('authority_trust_store_missing');
  else if (!read.safe || !read.parsed || document?.kind !== 'AuthorityTrustStore') {
    blockers.push('authority_trust_store_invalid');
  }
  if (missingRoles.length) blockers.push(...missingRoles.map((role) => `authority_role_missing:${role}`));
  if (coveredRoles.length && !allRolesHaveDistinctSubjects) {
    blockers.push('authority_role_subjects_must_be_distinct');
  }
  for (const role of coveredRoles) {
    if (!roleAssurance[role].length || roleAssurance[role].some((value) => value !== 'external_independent')) {
      blockers.push(`authority_role_external_assurance_required:${role}`);
    }
  }
  if (privateKeyMaterialDetected) blockers.push('authority_trust_store_private_key_material_forbidden');
  return section('authority_configuration', blockers, {
    trustStorePath,
    trustStorePresent: read.present && read.safe && read.parsed,
    activeKeyCount: activeKeys.length,
    roleCounts: Object.freeze(roleCounts),
    requiredRoles: REQUIRED_AUTHORITY_ROLES,
    coveredRoles: Object.freeze(coveredRoles),
    missingRoles: Object.freeze(missingRoles),
    roleKeyIds: Object.freeze(roleKeyIds),
    roleAssurance: Object.freeze(roleAssurance),
    distinctRoleSubjects: allRolesHaveDistinctSubjects,
    privateKeyMaterialDetected,
  });
}

function inspectKms({ workspaceRoot, runtimeRoot, environment }) {
  const configPath = environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG
    || environment.HEPTA_RELEASE_ATTESTOR_CONFIG
    || null;
  const read = jsonFile(configPath, { maximumBytes: 4 * 1024 * 1024 });
  const value = read.document || {};
  const backend = value.backend || {};
  const backendKind = String(backend.kind || value.backendKind || '');
  const hardwareProtected = safeBoolean(backend.hardwareProtected) || safeBoolean(value.hardwareProtected);
  const privateKeyExportable = Object.hasOwn(backend, 'privateKeyExportable')
    ? backend.privateKeyExportable === true : value.privateKeyExportable === true;
  const configurationPin = environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH
    || environment.HEPTA_RELEASE_ATTESTOR_CONFIG_HASH
    || null;
  const hardwareBundlePath = backend.hardwareAuthority?.bundlePath
    || value.hardwareAuthority?.bundlePath
    || value.kmsHardwareAuthority?.bundlePath
    || null;
  const bundle = jsonFile(hardwareBundlePath, { maximumBytes: 4 * 1024 * 1024 });
  const blockers = [];
  if (!configPath) blockers.push('release_attestor_configuration_path_missing');
  else if (!read.present || !read.safe || !read.parsed) blockers.push('release_attestor_configuration_unreadable');
  if (backendKind !== 'external-kms-command') blockers.push('release_attestor_external_kms_backend_required');
  if (hardwareProtected !== true) blockers.push('release_attestor_hardware_protection_required');
  if (privateKeyExportable !== false) blockers.push('release_attestor_non_exportable_key_required');
  if (!SHA256.test(String(configurationPin || ''))) blockers.push('release_attestor_configuration_pin_missing');
  if (read.present && SHA256.test(String(configurationPin || ''))
    && sha256Buffer(read.value) !== configurationPin) {
    blockers.push('release_attestor_configuration_pin_mismatch');
  }
  if (!hardwareBundlePath || !bundle.present || !bundle.safe || !bundle.parsed) {
    blockers.push('release_attestor_kms_hardware_attestation_missing');
  }
  if (bundle.present && bundle.parsed
    && (bundle.document?.status !== 'hardware_attestation_verified'
      || bundle.document?.externalIndependent !== true
      || bundle.document?.privateKeyExportable === true)) {
    blockers.push('release_attestor_hardware_attestation_not_independent_or_verified');
  }
  if (value.externalActionPerformed === true || backend.externalActionPerformed === true) {
    blockers.push('release_attestor_external_action_marker_forbidden');
  }
  return section('release_attestor_hardware_authority', blockers, {
    configurationPath: configPath ? absolute(configPath, configPath) : null,
    configurationFilePresent: read.present,
    configurationPresent: read.present && read.safe && read.parsed,
    backendKind: backendKind || null,
    hardwareProtected,
    privateKeyExportable,
    configurationPinPresent: SHA256.test(String(configurationPin || '')),
    hardwareAttestationPath: hardwareBundlePath ? absolute(hardwareBundlePath, hardwareBundlePath) : null,
    hardwareAttestationPresent: bundle.present && bundle.safe && bundle.parsed,
    externalActionPerformed: value.externalActionPerformed === true
      || backend.externalActionPerformed === true,
    workspaceRoot,
    runtimeRoot,
  });
}

function inspectCapabilityProofCoverage({ workspaceRoot, runtimeRoot }) {
  const required = Object.keys(CAPABILITY_CATALOG).length;
  let conformance = new Map();
  let operational = new Map();
  let codeProvenance = null;
  try {
    codeProvenance = currentCodeProvenance({
      workspaceRoot,
      allowReleaseCommitEnvironment: false,
    });
  } catch { /* represented as zero verified proofs below */ }
  const releaseCommit = codeProvenance?.commit || null;
  try {
    conformance = loadCapabilityConformanceProofs({
      runtimeRoot,
      workspaceRoot,
      capabilityCatalog: CAPABILITY_CATALOG,
      releaseCommit,
      codeProvenance,
    });
  } catch { conformance = new Map(); }
  try {
    operational = loadCapabilityOperationalProofs({
      runtimeRoot,
      workspaceRoot,
      capabilityCatalog: CAPABILITY_CATALOG,
      releaseCommit,
      codeProvenance,
    });
  } catch { operational = new Map(); }
  const conformanceCount = conformance.size;
  const operationalCount = operational.size;
  const blockers = [];
  if (conformanceCount !== required) {
    blockers.push(`release_bound_conformance_not_complete:${conformanceCount}/${required}`);
  }
  if (operationalCount !== required) {
    blockers.push(`independent_production_proof_not_complete:${operationalCount}/${required}`);
  }
  return section('capability_proof_coverage', blockers, {
    requiredCapabilityCount: required,
    releaseBoundConformanceCount: conformanceCount,
    independentProductionProofCount: operationalCount,
    releaseBoundConformanceComplete: conformanceCount === required,
    independentProductionProofComplete: operationalCount === required,
    conformanceCannotQualifyAsOperational: true,
    localAdminSignaturesCannotQualifyAsIndependent: true,
    externalActionPerformed: false,
  });
}

function inspectWorm({ workspaceRoot, environment }) {
  const contractPath = environment.HEPTA_OFFHOST_WORM_CONTRACT
    || path.join(workspaceRoot, 'paper-core', 'config', 'offhost-worm-contract.v1.json');
  const read = jsonFile(contractPath, {
    maximumBytes: 1024 * 1024,
    allowGroupWritable: true,
  });
  const value = read.document || {};
  const targetMountRoot = value.targetMountRoot ? absolute(value.targetMountRoot, value.targetMountRoot) : null;
  let mountPresent = false;
  try { mountPresent = Boolean(targetMountRoot && fs.statSync(targetMountRoot).isDirectory()); } catch { mountPresent = false; }
  const custodyEvidencePath = environment.HEPTA_OFFHOST_WORM_CUSTODY_EVIDENCE
    || value.custodyEvidencePath || null;
  const custodyTrustStorePath = environment.HEPTA_OFFHOST_WORM_CUSTODY_TRUST_STORE
    || value.custodyTrustStorePath || null;
  const evidence = jsonFile(custodyEvidencePath, { maximumBytes: 4 * 1024 * 1024 });
  const trust = jsonFile(custodyTrustStorePath, { maximumBytes: 4 * 1024 * 1024 });
  const blockers = [];
  if (!read.present || !read.safe || !read.parsed || value.kind !== 'OffhostWormSnapshotContract') {
    blockers.push('offhost_worm_contract_missing_or_invalid');
  }
  if (!mountPresent) blockers.push('offhost_worm_target_mount_unavailable');
  if (value.offHostOrOffsiteCustodyQualified !== true) blockers.push('offhost_or_offsite_custody_not_qualified');
  if (value.offlineDetachmentOrObjectLockReceiptRequired === true
    && (!evidence.present || !evidence.safe || !evidence.parsed)) {
    blockers.push('offhost_worm_object_lock_or_detachment_receipt_missing');
  }
  if (value.independentCustodyAttestationRequired === true
    && (!trust.present || !trust.safe || !trust.parsed)) {
    blockers.push('offhost_worm_independent_custody_attestation_missing');
  }
  return section('offhost_worm_custody', blockers, {
    contractPath: absolute(contractPath, contractPath),
    contractFilePresent: read.present,
    contractPresent: read.present && read.safe && read.parsed,
    targetMountRoot,
    targetMountPresent: mountPresent,
    custodyDeclaredQualified: value.offHostOrOffsiteCustodyQualified === true,
    custodyEvidencePresent: evidence.present && evidence.safe && evidence.parsed,
    custodyTrustStorePresent: trust.present && trust.safe && trust.parsed,
    externalActionPerformed: false,
  });
}

function walkFiles(root, suffix, maximum = 128) {
  if (!root || !fs.existsSync(root)) return [];
  const found = [];
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length && found.length < maximum) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (found.length >= maximum) break;
      const candidate = path.join(current.directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(suffix)) found.push(candidate);
      else if (entry.isDirectory() && current.depth < 3 && !entry.isSymbolicLink()) {
        queue.push({ directory: candidate, depth: current.depth + 1 });
      }
    }
  }
  return found;
}

function inspectRestore({ runtimeRoot, environment }) {
  const explicit = environment.HEPTA_RESTORE_DRILL_RECEIPT_PATH || null;
  const candidates = explicit ? [explicit]
    : walkFiles(path.join(runtimeRoot, 'backups'), '.restore-drill.receipt.json');
  const observations = candidates.map((candidate) => jsonFile(candidate, { maximumBytes: 4 * 1024 * 1024 }));
  const selected = observations.find((item) => item.present && item.safe && item.parsed) || null;
  let contract = null;
  if (selected) {
    try { contract = verifyHeptaStoreRestoreDrillReceipt(selected.document); } catch { contract = null; }
  }
  const passed = selected?.document?.status === 'hepta_store_restore_drill_passed'
    && contract?.valid === true;
  const blockers = [];
  if (!selected) blockers.push('restore_drill_passed_receipt_missing');
  else if (!passed) blockers.push('restore_drill_receipt_contract_invalid');
  return section('restore_drill', blockers, {
    receiptPath: selected?.path || (explicit ? absolute(explicit, explicit) : null),
    receiptPresent: Boolean(selected?.present && selected?.safe && selected?.parsed),
    receiptPassed: passed,
    receiptContractValid: contract?.valid === true,
    receiptVersion: contract?.version || selected?.document?.version || null,
    candidateCount: candidates.length,
    externalActionPerformed: false,
  });
}

function inspectAntiRollback({ runtimeRoot, environment }) {
  const configured = environment.HEPTA_PRODUCTION_INTEGRITY_PIN_PATH || null;
  const candidates = unique([
    configured,
    path.join(runtimeRoot, 'production-integrity', 'PRODUCTION_INTEGRITY_PIN.json'),
    path.join(runtimeRoot, 'production-integrity', 'production-integrity-pin.json'),
  ].filter(Boolean));
  const observations = candidates.map((candidate) => jsonFile(candidate, { maximumBytes: 4 * 1024 * 1024 }));
  const selected = observations.find((item) => item.present && item.safe && item.parsed) || null;
  const value = selected?.document || {};
  const schemaValid = value.kind === 'ProductionIntegrityPin'
    && value.status === 'production_integrity_pin_active'
    && Number.isSafeInteger(value.deploymentGeneration) && value.deploymentGeneration >= 1;
  const hashFieldsPresent = [
    value.ociImageDigest,
    value.ociManifestDigest,
    value.kubernetesWorkloadDigest,
    value.databaseInventoryHash,
    value.databaseHeadHash,
    value.restoreDrillReceiptHash,
  ].every((valueHash) => SHA256.test(String(valueHash || '')));
  // Shape checks alone are not enough here: a local process could otherwise
  // place a self-consistent-looking set of digests in the pin.  Re-run the
  // canonical production-integrity verifier (including exact keys, payload
  // hash, generation/expiry and predecessor rules) without mutating state.
  let contractValid = false;
  if (schemaValid && hashFieldsPresent && value.externalActionPerformed === false) {
    try { contractValid = verifyProductionIntegrityPin(value); } catch { contractValid = false; }
  }
  const valid = schemaValid && hashFieldsPresent && contractValid
    && value.externalActionPerformed === false;
  const blockers = valid ? [] : ['production_integrity_pin_missing_or_invalid'];
  if (selected && !schemaValid) blockers.push('production_integrity_pin_schema_invalid');
  if (selected && !hashFieldsPresent) blockers.push('production_integrity_pin_hash_fields_missing_or_invalid');
  if (selected && schemaValid && hashFieldsPresent && !contractValid) {
    blockers.push('production_integrity_pin_contract_invalid');
  }
  if (value.externalActionPerformed === true) blockers.push('production_integrity_pin_external_action_forbidden');
  return section('anti_rollback', blockers, {
    pinPath: selected?.path || null,
    pinPresent: Boolean(selected?.present && selected?.safe && selected?.parsed),
    schemaValid,
    hashFieldsPresent,
    contractValid,
    pinValid: valid,
    deploymentGeneration: valid ? value.deploymentGeneration : null,
    externalActionPerformed: value.externalActionPerformed === true,
  });
}

function inspectDatabase({ workspaceRoot, runtimeRoot, environment }) {
  const manifestPath = environment.HEPTA_STATE_DATABASE_MANIFEST
    || path.join(workspaceRoot, 'paper-core', 'config', 'autonomous-research-state-databases.v1.json');
  const read = jsonFile(manifestPath, {
    maximumBytes: 16 * 1024 * 1024,
    allowGroupWritable: true,
  });
  const entries = Array.isArray(read.document?.databases) ? read.document.databases : [];
  const databases = entries.map((entry) => inspectReadOnlySqliteDatabase({
    dbPath: path.join(runtimeRoot, String(entry.relativePath || '')),
    expectedSchemaContractId: entry.schemaContractId || null,
    absolute,
    regularFile,
  }));
  const blockers = [];
  if (!read.present || !read.safe || !read.parsed || read.document?.kind !== 'AutonomousResearchStateDatabaseManifest') {
    blockers.push('database_inventory_manifest_missing_or_invalid');
  }
  if (!entries.length) blockers.push('database_inventory_manifest_empty');
  for (const database of databases) blockers.push(...database.blockers);
  return section('database_inventory', blockers, {
    manifestPath: absolute(manifestPath, manifestPath),
    manifestFilePresent: read.present,
    manifestPresent: read.present && read.safe && read.parsed,
    expectedDatabaseCount: entries.length,
    databases: Object.freeze(databases),
    externalActionPerformed: false,
  });
}

function inspectSingleVenue({ workspaceRoot, environment }) {
  const configPath = environment.HEPTA_SINGLE_VENUE_ROLLOUT_CONFIG
    || path.join(workspaceRoot, 'paper-core', 'config', 'submission-single-venue-rollout.v1.json');
  const read = jsonFile(configPath, {
    maximumBytes: 1024 * 1024,
    allowGroupWritable: true,
  });
  const value = read.document || {};
  const coverage = JOURNAL_SUBMISSION_CONNECTOR_COVERAGE;
  const sandboxEvidencePath = environment.HEPTA_SINGLE_VENUE_SANDBOX_EVIDENCE
    || value.sandboxCanaryEvidencePath || null;
  const sandboxEvidence = jsonFile(sandboxEvidencePath, { maximumBytes: 4 * 1024 * 1024 });
  const blockers = [];
  if (!read.present || !read.safe || !read.parsed) blockers.push('single_venue_rollout_configuration_missing_or_invalid');
  if (value.enabled !== true) blockers.push('single_venue_rollout_not_enabled');
  if (!value.venueId || !value.targetInstanceId) blockers.push('single_venue_target_binding_missing');
  if (value.credentialsPresent !== true) blockers.push('single_venue_credentials_not_configured');
  // A canary is evidence, not permission to perform a portal side effect.
  // The preflight requires a supplied, readable evidence document and rejects
  // any document/configuration that claims an external action occurred.
  if (!sandboxEvidence.present || !sandboxEvidence.safe || !sandboxEvidence.parsed) {
    blockers.push('single_venue_sandbox_canary_evidence_missing');
  }
  if (value.sandboxCanaryExternalActionPerformed === true
    || sandboxEvidence.document?.externalActionPerformed === true) {
    blockers.push('single_venue_sandbox_canary_external_action_forbidden');
  }
  if (value.productionReady !== true) blockers.push('single_venue_production_qualification_missing');
  if (value.liveCommitEnabled !== true) blockers.push('single_venue_live_commit_disabled');
  if (value.externalActionPerformed === true) blockers.push('single_venue_external_action_marker_forbidden');
  return section('submission_qualification', blockers, {
    configurationPath: absolute(configPath, configPath),
    configurationFilePresent: read.present,
    configurationPresent: read.present && read.safe && read.parsed,
    sandboxEvidencePath: sandboxEvidencePath ? absolute(sandboxEvidencePath, sandboxEvidencePath) : null,
    sandboxEvidencePresent: sandboxEvidence.present && sandboxEvidence.safe && sandboxEvidence.parsed,
    sandboxEvidenceExternalActionPerformed: sandboxEvidence.document?.externalActionPerformed === true,
    targetCount: Number(coverage.journalProfileCount || coverage.entries?.length || 0),
    verifiedBindingCount: Number(coverage.targetProfileResolvedCount || 0),
    sandboxQualifiedCount: Number(coverage.sandboxQualifiedCount || 0),
    productionQualifiedCount: Number(coverage.productionQualifiedCount || 0),
    liveCommitAuthorizedCount: Number(coverage.liveCommitAuthorizedCount || 0),
    liveSubmissionReadyCount: Number(coverage.liveSubmissionReadyCount || 0),
    humanSingleUseAuthorizationRequired: value.humanSingleUseAuthorizationRequired === true,
    credentialsPresent: value.credentialsPresent === true,
    externalActionPerformed: value.externalActionPerformed === true,
  });
}

function inspectOci({ workspaceRoot, runtimeRoot, environment }) {
  const pinPath = environment.HEPTA_PRODUCTION_INTEGRITY_PIN_PATH
    || path.join(runtimeRoot, 'production-integrity', 'PRODUCTION_INTEGRITY_PIN.json');
  const registryPath = environment.HEPTA_REGISTRY_ATTESTATION_PATH
    || path.join(runtimeRoot, 'attestations', 'registry-attestation.json');
  const cvePath = environment.HEPTA_CVE_ATTESTATION_PATH
    || path.join(runtimeRoot, 'attestations', 'cve-attestation.json');
  const verifierPath = environment.HEPTA_OCI_INDEPENDENT_VERIFIER_PATH
    || path.join(runtimeRoot, 'attestations', 'oci-independent-verifier.json');
  const pin = jsonFile(pinPath, { maximumBytes: 4 * 1024 * 1024 });
  const registry = jsonFile(registryPath, { maximumBytes: 4 * 1024 * 1024 });
  const cve = jsonFile(cvePath, { maximumBytes: 4 * 1024 * 1024 });
  const verifier = jsonFile(verifierPath, { maximumBytes: 4 * 1024 * 1024 });
  let baseDigestCount = 0;
  try {
    for (const entry of fs.readdirSync(path.join(workspaceRoot, 'runtime-images'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dockerfile = path.join(workspaceRoot, 'runtime-images', entry.name, 'Dockerfile');
      const read = regularFile(dockerfile, {
        maximumBytes: 1024 * 1024,
        allowGroupWritable: true,
      });
      if (read.safe) baseDigestCount += (read.value.toString('utf8').match(/@sha256:[0-9a-f]{64}/gi) || []).length;
    }
  } catch { /* represented by missing attestations below */ }
  const pinContractValid = Boolean(pin.present && pin.safe && pin.parsed
    && (() => {
      try { return verifyProductionIntegrityPin(pin.document); } catch { return false; }
    })());
  const simpleAttestation = (read, expectedHash, acceptedKinds) => {
    const value = read.document || {};
    const declaredHash = [
      value.attestationHash,
      value.registryAttestationHash,
      value.cveAttestationHash,
      value.evidenceHash,
    ].find((candidate) => SHA256.test(String(candidate || '')));
    const kindValid = acceptedKinds.includes(String(value.kind || ''));
    const statusValid = typeof value.status === 'string'
      && /(verified|attested|qualified|ready|passed)/i.test(value.status);
    const independent = value.independentAuthority === true
      || value.externalIndependent === true
      || value.independent === true;
    // A present attestation must carry its own content hash.  Merely having a
    // status string is not evidence, even when the production pin is absent.
    const hashBound = Boolean(declaredHash)
      && (!expectedHash || declaredHash === expectedHash);
    return Object.freeze({
      present: read.present && read.safe && read.parsed,
      kindValid,
      statusValid,
      independent,
      declaredHash: declaredHash || null,
      hashBound,
      valid: read.present && read.safe && read.parsed && kindValid && statusValid
        && independent && hashBound,
    });
  };
  const registryContract = simpleAttestation(
    registry,
    pin.document?.registryAttestationHash,
    ['RegistryAttestation', 'OCIRegistryAttestation', 'ContainerRegistryAttestation'],
  );
  const cveContract = simpleAttestation(
    cve,
    pin.document?.cveAttestationHash,
    ['CveAttestation', 'CVEAttestation', 'ContainerCveAttestation'],
  );
  const verifierDocument = verifier.document || {};
  const responses = Array.isArray(verifierDocument.responses)
    ? verifierDocument.responses : [];
  const verifierIds = responses.map((item) => String(item?.verifierId || ''));
  const verifierSubjects = responses.map((item) => String(item?.signer?.subjectId || ''));
  const verifierBackends = responses.map((item) => String(item?.backendIdentityHash || ''));
  const verifierOrganizations = responses.map((item) => String(item?.signer?.organization || '').trim().toLowerCase());
  const verifierResponsesStructurallyValid = responses.every((item) => (
    item?.status === 'runtime_image_oci_bitwise_rebuild_attested'
      && SHA256.test(String(item?.responseHash || ''))
      && SHA256.test(String(item?.verifierServiceIdentityHash || ''))
      && typeof item?.signature === 'string' && item.signature.length > 0
      && item?.signer?.algorithm === 'ed25519'
      && item?.signer?.status === 'active'
  ));
  const twoIndependentVerifiers = responses.length === 2
    && verifierResponsesStructurallyValid
    && verifierIds.every(Boolean) && new Set(verifierIds).size === 2
    && verifierSubjects.every(Boolean) && new Set(verifierSubjects).size === 2
    && verifierBackends.every((item) => SHA256.test(item)) && new Set(verifierBackends).size === 2
    && verifierOrganizations.every(Boolean) && new Set(verifierOrganizations).size === 2;
  const verifierContractValid = verifier.present && verifier.safe && verifier.parsed
    && verifierDocument.kind === 'RuntimeImageReproducibilityReceipt'
    && verifierDocument.version === 2
    && verifierDocument.status === 'runtime_image_reproducibility_external_attestations_recorded'
    && verifierDocument.externalActionPerformed === true
    && verifierDocument.privateSigningKeyLoadedByController === false
    && verifierDocument.assurance === 'two-independent-ed25519-attested-oci-layout-rebuilds-v1'
    && twoIndependentVerifiers;
  const blockers = [];
  if (!pin.present || !pin.safe || !pin.parsed) blockers.push('oci_production_integrity_pin_missing');
  else if (!pinContractValid) blockers.push('oci_production_integrity_pin_contract_invalid');
  if (!verifier.present || !verifier.safe || !verifier.parsed) blockers.push('oci_independent_verifier_attestation_missing');
  else if (!verifierContractValid) blockers.push('oci_independent_verifier_attestation_invalid');
  if (!registry.present || !registry.safe || !registry.parsed) blockers.push('oci_registry_attestation_missing');
  else if (!registryContract.valid) blockers.push('oci_registry_attestation_invalid');
  if (!cve.present || !cve.safe || !cve.parsed) blockers.push('oci_cve_attestation_missing');
  else if (!cveContract.valid) blockers.push('oci_cve_attestation_invalid');
  return section('oci_reproducibility', blockers, {
    productionIntegrityPinPresent: pin.present && pin.safe && pin.parsed,
    productionIntegrityPinContractValid: pinContractValid,
    independentVerifierAttestationPresent: verifier.present && verifier.safe && verifier.parsed,
    independentVerifierAttestationContractValid: verifierContractValid,
    registryAttestationPresent: registry.present && registry.safe && registry.parsed,
    registryAttestationContractValid: registryContract.valid,
    cveAttestationPresent: cve.present && cve.safe && cve.parsed,
    cveAttestationContractValid: cveContract.valid,
    independentVerifierCount: responses.length,
    independentVerifierSubjectsDistinct: new Set(verifierSubjects.filter(Boolean)).size === responses.length,
    independentVerifierBackendsDistinct: new Set(verifierBackends.filter(Boolean)).size === responses.length,
    pinnedBaseImageReferenceCount: baseDigestCount,
    bitwiseRebuildVerified: verifierContractValid,
    externalActionPerformed: false,
  });
}

function inspectKubernetes({ workspaceRoot, environment }) {
  const manifestPath = environment.HEPTA_KUBERNETES_MANIFEST
    || path.join(workspaceRoot, 'paper-core', 'deploy', 'autonomous-research-supervisor.k8s.yaml');
  const read = regularFile(manifestPath, {
    maximumBytes: 16 * 1024 * 1024,
    allowGroupWritable: true,
  });
  const text = read.safe ? read.value.toString('utf8') : '';
  const placeholders = (text.match(/REPLACE_WITH_[A-Z0-9_]+/g) || []).length;
  const imageReferenceCount = (text.match(/^\s*image:\s*[^\n#]+/gim) || []).length;
  const imageDigestCount = (text.match(/image:\s*[^\s]+@sha256:[0-9a-f]{64}/gi) || []).length;
  const workloadDigestMatch = text.match(/hepta\.paper\/kubernetes-workload-digest:\s*([^\s#]+)/i);
  const workloadDigest = workloadDigestMatch?.[1] || null;
  const workloadDigestPresent = SHA256.test(String(workloadDigest || ''))
    && !/REPLACE_WITH_[A-Z0-9_]+/.test(String(workloadDigest || ''));
  const allImagesPinned = imageReferenceCount > 0 && imageDigestCount === imageReferenceCount;
  const blockers = [];
  if (!read.present || !read.safe) blockers.push('kubernetes_manifest_missing_or_unsafe');
  if (placeholders > 0) blockers.push('kubernetes_manifest_placeholders_present');
  if (!allImagesPinned) blockers.push('kubernetes_image_digest_missing_or_unpinned');
  if (!workloadDigestPresent) blockers.push('kubernetes_workload_digest_attestation_missing');
  return section('kubernetes_manifest', blockers, {
    manifestPath: absolute(manifestPath, manifestPath),
    manifestFilePresent: read.present,
    manifestPresent: read.present && read.safe,
    placeholderCount: placeholders,
    imageReferenceCount,
    pinnedImageReferenceCount: imageDigestCount,
    allImagesPinned,
    workloadDigest,
    workloadDigestPresent,
    externalActionPerformed: false,
  });
}

function inspectSlo({ workspaceRoot, runtimeRoot, environment }) {
  const policyPath = environment.HEPTA_OPERATIONAL_SLO_POLICY_PATH
    || path.join(runtimeRoot, 'operations', 'slo-policy.json');
  const schemaPath = path.join(workspaceRoot, 'paper-core', 'config', 'production-integrity-policy.schema.json');
  const policy = jsonFile(policyPath, { maximumBytes: 1024 * 1024 });
  const schema = regularFile(schemaPath, {
    maximumBytes: 4 * 1024 * 1024,
    allowGroupWritable: true,
  });
  const value = policy.document || {};
  const shapeValid = value.kind === 'OperationalSloAlertPolicy'
    && value.version === 1 && value.alertOnMissingData === true
    && SHA256.test(String(value.operationalSloAlertPolicyHash || ''));
  // Verify the canonical hash and exact policy bounds.  This remains
  // observation-only; no alert or policy is generated by the preflight.
  let contractValid = false;
  if (shapeValid) {
    try { contractValid = verifyOperationalSloAlertPolicy(value); } catch { contractValid = false; }
  }
  const valid = shapeValid && contractValid;
  const blockers = [];
  if (!schema.present || !schema.safe) blockers.push('operational_slo_schema_missing');
  if (!policy.present || !policy.safe || !policy.parsed || !valid) blockers.push('operational_slo_policy_missing_or_invalid');
  if (policy.present && policy.safe && policy.parsed && shapeValid && !contractValid) {
    blockers.push('operational_slo_policy_contract_invalid');
  }
  return section('operational_slo', blockers, {
    schemaFilePresent: schema.present,
    schemaPresent: schema.present && schema.safe,
    policyPath: absolute(policyPath, policyPath),
    policyFilePresent: policy.present,
    policyPresent: policy.present && policy.safe && policy.parsed,
    policyContractValid: contractValid,
    alertOnMissingData: value.alertOnMissingData === true,
    alertsConfigured: valid,
    externalActionPerformed: false,
  });
}

export function runP0ExternalAuthorityPreflight({
  workspaceRoot = HEPTA_WORKSPACE_ROOT,
  runtimeRoot = defaultPaperRuntimeRoot(),
  assetRoot = defaultPaperAssetRoot(),
  environment = process.env,
  now = new Date(),
} = {}) {
  const resolvedWorkspaceRoot = absolute(workspaceRoot, HEPTA_WORKSPACE_ROOT);
  const resolvedRuntimeRoot = absolute(runtimeRoot, defaultPaperRuntimeRoot());
  const resolvedAssetRoot = absolute(assetRoot, defaultPaperAssetRoot());
  const sections = {
    roles: inspectRoles({ runtimeRoot: resolvedRuntimeRoot, environment }),
    kmsHsm: inspectKms({
      workspaceRoot: resolvedWorkspaceRoot,
      runtimeRoot: resolvedRuntimeRoot,
      environment,
    }),
    worm: inspectWorm({
      workspaceRoot: resolvedWorkspaceRoot,
      runtimeRoot: resolvedRuntimeRoot,
      environment,
    }),
    restore: inspectRestore({ runtimeRoot: resolvedRuntimeRoot, environment }),
    antiRollback: inspectAntiRollback({ runtimeRoot: resolvedRuntimeRoot, environment }),
    singleVenue: inspectSingleVenue({ workspaceRoot: resolvedWorkspaceRoot, environment }),
    database: inspectDatabase({
      workspaceRoot: resolvedWorkspaceRoot,
      runtimeRoot: resolvedRuntimeRoot,
      environment,
    }),
    oci: inspectOci({
      workspaceRoot: resolvedWorkspaceRoot,
      runtimeRoot: resolvedRuntimeRoot,
      environment,
    }),
    kubernetes: inspectKubernetes({ workspaceRoot: resolvedWorkspaceRoot, environment }),
    slo: inspectSlo({
      workspaceRoot: resolvedWorkspaceRoot,
      runtimeRoot: resolvedRuntimeRoot,
      environment,
    }),
    capabilityProofCoverage: inspectCapabilityProofCoverage({
      workspaceRoot: resolvedWorkspaceRoot,
      runtimeRoot: resolvedRuntimeRoot,
    }),
  };
  const observedDate = new Date(now);
  const observedAt = Number.isFinite(observedDate.getTime())
    ? observedDate.toISOString() : null;
  const blockers = unique([
    ...Object.values(sections).flatMap((item) => item.blockers || []),
    ...(observedAt ? [] : ['preflight_observation_clock_invalid']),
  ]);
  return Object.freeze({
    version: 1,
    kind: 'P0ExternalAuthorityPreflight',
    status: blockers.length ? 'p0_external_authority_preflight_blocked' : 'p0_external_authority_preflight_ready',
    observedAt,
    workspaceRoot: resolvedWorkspaceRoot,
    runtimeRoot: resolvedRuntimeRoot,
    assetRoot: resolvedAssetRoot,
    readOnly: true,
    secretsRead: false,
    credentialsGenerated: false,
    hashesGenerated: false,
    acceptanceGenerated: false,
    externalActionPerformed: false,
    sections: Object.freeze(sections),
    blockers: Object.freeze(blockers),
  });
}

function usage() {
  return {
    version: 1,
    kind: 'P0ExternalAuthorityPreflightUsage',
    usage: 'p0-external-authority-preflight [--workspace-root PATH] [--runtime-root PATH] [--asset-root PATH]',
    mutation: 'none',
    externalAction: false,
    note: 'Reports observations only; it never creates credentials, hashes, receipts, acceptance, or portal actions.',
  };
}

function main() {
  const args = parseStrictCliArguments(process.argv.slice(2), {
    booleanFlags: ['help'],
    valueFlags: ['workspace-root', 'runtime-root', 'asset-root'],
    positional: false,
  });
  if (args.help) {
    process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
    return;
  }
  const report = runP0ExternalAuthorityPreflight({
    workspaceRoot: args['workspace-root'] || HEPTA_WORKSPACE_ROOT,
    runtimeRoot: args['runtime-root'] || defaultPaperRuntimeRoot(),
    assetRoot: args['asset-root'] || defaultPaperAssetRoot(),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'p0_external_authority_preflight_ready') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}
