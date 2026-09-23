import fs from 'node:fs';
import path from 'node:path';

import {
  inspectPackageRetentionRecoveryReadinessResponse,
  evaluateFullProductionReadiness,
} from '../../paper-application/automation/full-production-readiness-policy.mjs';
import {
  restrictedChildEnvironment,
  runBoundedChildProcess,
} from '../../paper-adapters/automation/bounded-child-process.mjs';
import {
  descriptorSha256HashSync,
  openPinnedRegularFileSync,
  readRegularJsonFileSync,
  samePinnedFileIdentity,
} from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { HEPTA_WORKSPACE_ROOT } from '../../paper-adapters/runtime/workspace-layout.mjs';
import {
  LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT,
  LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST,
} from '../../paper-adapters/governance/legacy-owner-acceptance-contract.mjs';
import {
  verifyOwnerAcceptanceDocument,
} from '../../paper-adapters/governance/owner-acceptance-verifier.mjs';
import {
  assertBoundRegularJsonSnapshot,
  readBoundRegularJsonSnapshot,
} from '../../paper-adapters/governance/capability-proof-verifier-support.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import {
  loadCapabilityOperationalProofs,
} from '../bootstrap/operator-governance-composition.mjs';
import {
  verifyOffhostWormTarget,
} from '../bootstrap/operator-release-composition.mjs';
import { queryAutomationReadiness } from './automation-readiness-query.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PACKAGE_READINESS_TIMEOUT_MS = 30_000;
const MAXIMUM_PACKAGE_READINESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAXIMUM_PACKAGE_READINESS_COMMAND_BYTES = 16 * 1024 * 1024;
const CHILD_COMMAND_DESCRIPTOR_PATH = '/proc/self/fd/3';

function sameProtectedPathIdentity(left, right) {
  return Boolean(left && right
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode)
    && String(left.uid) === String(right.uid)
    && String(left.gid) === String(right.gid));
}

function trustedOwner(stat, requiredCommandUid) {
  return stat.uid === BigInt(requiredCommandUid);
}

function protectedCommandPath(commandPath, {
  requiredCommandUid,
  trustedRoot,
}) {
  const selected = path.resolve(String(commandPath || ''));
  const selectedTrustedRoot = path.resolve(String(trustedRoot || ''));
  const relativeToTrustedRoot = path.relative(selectedTrustedRoot, selected);
  if (!path.isAbsolute(String(commandPath || ''))
    || !path.isAbsolute(String(trustedRoot || ''))
    || selected === selectedTrustedRoot
    || relativeToTrustedRoot === '..'
    || relativeToTrustedRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToTrustedRoot)) {
    throw new Error('full_production_package_readiness_command_reference_invalid');
  }
  const relative = relativeToTrustedRoot;
  const segments = relative.split(path.sep);
  const pathSnapshot = [];
  let cursor = selectedTrustedRoot;
  try {
    for (let index = -1; index < segments.length; index += 1) {
      if (index >= 0) cursor = path.join(cursor, segments[index]);
      const stat = fs.lstatSync(cursor, { bigint: true });
      const final = index === segments.length - 1;
      const stickyRootDirectory = stat.uid === 0n
        && (stat.mode & 0o1000n) !== 0n;
      if (stat.isSymbolicLink() || !trustedOwner(stat, requiredCommandUid)
        || (final
          ? !stat.isFile() || stat.nlink !== 1n
            || stat.size < 1n || stat.size > BigInt(MAXIMUM_PACKAGE_READINESS_COMMAND_BYTES)
            || (stat.mode & 0o111n) === 0n || (stat.mode & 0o222n) !== 0n
          : !stat.isDirectory()
            || ((stat.mode & 0o022n) !== 0n && !stickyRootDirectory))) {
        throw new Error('invalid');
      }
      pathSnapshot.push(Object.freeze({ path: cursor, stat }));
    }
    if (fs.realpathSync(selected) !== selected) throw new Error('invalid');
  } catch (error) {
    throw new Error('full_production_package_readiness_command_reference_invalid', {
      cause: error,
    });
  }
  return Object.freeze({ selected, pathSnapshot: Object.freeze(pathSnapshot) });
}

function assertProtectedCommandPathCurrent(inspection) {
  for (const entry of inspection.pathSnapshot) {
    let current;
    try { current = fs.lstatSync(entry.path, { bigint: true }); }
    catch (error) {
      throw new Error('full_production_package_readiness_command_reference_drift', {
        cause: error,
      });
    }
    if (!sameProtectedPathIdentity(entry.stat, current)) {
      throw new Error('full_production_package_readiness_command_reference_drift');
    }
  }
}

function openCommandInspection(commandPath, expectedHash, referencePolicy) {
  if (!SHA256.test(String(expectedHash || ''))
    || !fs.existsSync('/proc/self/fd')) {
    throw new Error('full_production_package_readiness_command_reference_invalid');
  }
  const pathInspection = protectedCommandPath(commandPath, referencePolicy);
  const pinned = openPinnedRegularFileSync(pathInspection.selected, {
    errorCode: 'full_production_package_readiness_command_reference_invalid',
  });
  try {
    const observedHash = descriptorSha256HashSync(pinned.descriptor);
    const after = fs.fstatSync(pinned.descriptor, { bigint: true });
    assertProtectedCommandPathCurrent(pathInspection);
    if (!samePinnedFileIdentity(pinned.opened, after)
      || !trustedOwner(after, referencePolicy.requiredCommandUid)
      || observedHash !== expectedHash) {
      throw new Error('full_production_package_readiness_command_reference_drift');
    }
    return Object.freeze({
      ...pathInspection,
      descriptor: pinned.descriptor,
      identity: after,
      contentHash: observedHash,
    });
  } catch (error) {
    fs.closeSync(pinned.descriptor);
    throw error;
  }
}

function assertCommandInspectionCurrent(inspection) {
  const current = fs.fstatSync(inspection.descriptor, { bigint: true });
  assertProtectedCommandPathCurrent(inspection);
  if (!samePinnedFileIdentity(inspection.identity, current)
    || !samePinnedFileIdentity(
      current,
      fs.lstatSync(inspection.selected, { bigint: true }),
    )
    || descriptorSha256HashSync(inspection.descriptor) !== inspection.contentHash) {
    throw new Error('full_production_package_readiness_command_reference_drift');
  }
}

function parsePackageReadinessOutput(value) {
  let parsed;
  try { parsed = JSON.parse(String(value || '')); }
  catch (error) {
    throw new Error('full_production_package_readiness_child_output_invalid', {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('full_production_package_readiness_child_output_invalid');
  }
  return parsed;
}

async function queryPackageRetentionRecoveryReadiness({
  commandPath,
  commandSha256,
  root,
  runtimeRoot,
  workspaceRoot,
  environment,
  runProcess,
  timeoutMs,
  observeNow,
  commandReferencePolicy,
}) {
  const pinned = openCommandInspection(
    commandPath,
    commandSha256,
    commandReferencePolicy,
  );
  let result;
  try {
    result = await runProcess({
      executable: CHILD_COMMAND_DESCRIPTOR_PATH,
      args: [
        '--action', 'retention-recovery-readiness',
        '--root', root,
        '--runtime-root', runtimeRoot,
      ],
      cwd: workspaceRoot,
      env: restrictedChildEnvironment({ source: environment }),
      timeoutMs,
      maximumCapturedBytes: MAXIMUM_PACKAGE_READINESS_OUTPUT_BYTES,
      inheritedDescriptors: [pinned.descriptor],
    });
    assertCommandInspectionCurrent(pinned);
  } finally {
    fs.closeSync(pinned.descriptor);
  }
  if (result?.timedOut || result?.aborted || result?.outputTruncated
    || result?.error || result?.exitCode !== 0) {
    throw new Error('full_production_package_readiness_child_infrastructure_failed');
  }
  const observed = observeNow();
  if (!(observed instanceof Date) || !Number.isFinite(observed.getTime())) {
    throw new Error('full_production_readiness_clock_invalid');
  }
  const observedAt = observed.toISOString();
  return Object.freeze({
    observedAt,
    inspection: inspectPackageRetentionRecoveryReadinessResponse({
      response: parsePackageReadinessOutput(result.stdout),
      observedAt,
    }),
  });
}

function independentOwnerAcceptanceInspection({ document, trustStore, verifyDocument }) {
  const required = LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT;
  const expectedFamilyIds = LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST.families
    .map((family) => family.familyId).sort();
  const actualFamilyIds = Array.isArray(document?.acceptedFamilies)
    ? document.acceptedFamilies.map((family) => String(family?.familyId || '')).sort()
    : [];
  const familyManifestBound = document?.version === 2
    && document.kind === 'CapabilityOwnerAcceptance'
    && document.familyManifestHash
      === LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST.familyManifestHash
    && actualFamilyIds.length === expectedFamilyIds.length
    && new Set(actualFamilyIds).size === actualFamilyIds.length
    && JSON.stringify(actualFamilyIds) === JSON.stringify(expectedFamilyIds);
  const accepted = familyManifestBound
    ? verifyDocument({
      document,
      trustStore,
      familyManifest: LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST,
    }) : new Map();
  const records = accepted instanceof Map ? [...accepted.values()] : [];
  const externallyAccepted = records.filter((record) => (
    record?.issuerAssurance === 'external_independent'
      && record?.acceptanceClass === 'external_independent_owner_acceptance'
  )).length;
  const localAdminAccepted = records.filter((record) => (
    record?.issuerAssurance === 'local_admin_delegated'
      && record?.acceptanceClass === 'local_admin_delegated_owner_acceptance'
  )).length;
  return Object.freeze({
    version: 1,
    kind: 'IndependentExternalOwnerAcceptanceInspection',
    status: familyManifestBound && externallyAccepted === required
      ? 'independent_external_owner_acceptance_ready'
      : 'independent_external_owner_acceptance_blocked',
    externallyAccepted,
    required,
    familyManifestBound,
    familyManifestHash: document?.familyManifestHash || null,
    localAdminAccepted,
    automaticAcceptanceForbidden: true,
  });
}

function readPinnedOwnerReference({
  referenceRoot,
  candidate,
  expectedHash,
  expectedName,
  requiredOwnerUid,
}) {
  const expectedPath = path.join(referenceRoot, expectedName);
  if (!path.isAbsolute(String(candidate || ''))
    || path.resolve(candidate) !== expectedPath
    || !SHA256.test(String(expectedHash || ''))) {
    throw new Error('full_production_owner_reference_invalid');
  }
  let snapshot;
  try {
    snapshot = readBoundRegularJsonSnapshot(referenceRoot, expectedPath);
    const stat = snapshot.fileIdentity;
    if (String(stat.uid) !== String(requiredOwnerUid)
      || snapshot.contentHash !== expectedHash) {
      throw new Error('invalid');
    }
    assertBoundRegularJsonSnapshot(snapshot);
  } catch (error) {
    throw new Error('full_production_owner_reference_invalid', { cause: error });
  }
  return snapshot;
}

function protectedOwnerReferenceRoot({
  ownerTrustStore,
  ownerAcceptanceDocument,
  requiredOwnerUid,
}) {
  const trustStorePath = path.resolve(String(ownerTrustStore || ''));
  const acceptanceDocumentPath = path.resolve(String(ownerAcceptanceDocument || ''));
  const referenceRoot = path.dirname(trustStorePath);
  if (!path.isAbsolute(String(ownerTrustStore || ''))
    || !path.isAbsolute(String(ownerAcceptanceDocument || ''))
    || path.basename(trustStorePath) !== 'OWNER_TRUST_STORE.json'
    || path.basename(acceptanceDocumentPath) !== 'CAPABILITY_OWNER_ACCEPTANCE.json'
    || path.dirname(acceptanceDocumentPath) !== referenceRoot
    || referenceRoot === path.parse(referenceRoot).root
    || path.basename(referenceRoot) !== 'capabilities-public') {
    throw new Error('full_production_owner_reference_invalid');
  }
  try {
    const stat = fs.lstatSync(referenceRoot, { bigint: true });
    if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || fs.realpathSync(referenceRoot) !== referenceRoot
      || String(stat.uid) !== String(requiredOwnerUid)
      || (stat.mode & 0o022n) !== 0n) {
      throw new Error('invalid');
    }
  } catch (error) {
    throw new Error('full_production_owner_reference_invalid', { cause: error });
  }
  return referenceRoot;
}

function independentOperationalProofInspection({ proofs, releaseCommit }) {
  if (!(proofs instanceof Map) || typeof releaseCommit !== 'string' || !releaseCommit) {
    throw new Error('full_production_operational_proof_inspection_invalid');
  }
  const capabilities = Object.freeze(Object.keys(CAPABILITY_CATALOG).sort()
    .map((capabilityId) => {
      const proof = proofs.get(capabilityId) || null;
      return Object.freeze({
        capabilityId,
        verified: Boolean(proof),
        operationalReceiptHashes: Object.freeze([
          ...(proof?.operationalReceiptHashes || []),
        ].sort()),
        issuerAssurances: Object.freeze([...(proof?.issuerAssurances || [])].sort()),
      });
    }));
  const verified = capabilities.filter((item) => item.verified).length;
  const required = capabilities.length;
  return Object.freeze({
    version: 1,
    kind: 'IndependentProductionOperationalProofInspection',
    status: verified === required
      ? 'independent_production_operational_proof_ready'
      : 'independent_production_operational_proof_blocked',
    releaseCommit,
    verified,
    required,
    capabilities,
    externalIndependentRequired: true,
    conformanceCannotQualify: true,
  });
}

export async function queryFullProductionReadiness({
  root,
  runtimeRoot,
  packageRecoveryReadinessCommand,
  packageRecoveryReadinessCommandSha256,
  packageRecoveryReadinessCommandRequiredUid = 0,
  testOnlyPackageRecoveryReadinessCommandTrustRoot = null,
  ownerTrustStore,
  ownerTrustStoreSha256,
  ownerAcceptanceDocument,
  ownerAcceptanceDocumentSha256,
  ownerReferenceRequiredUid = 0,
  environment = process.env,
  workspaceRoot = HEPTA_WORKSPACE_ROOT,
  liveProviderCanaryRequested = false,
  activeReleaseAttestorVerification = false,
  clock = { now: () => new Date() },
  packageReadinessTimeoutMs = PACKAGE_READINESS_TIMEOUT_MS,
  automationReadinessQuery = queryAutomationReadiness,
  runProcess = runBoundedChildProcess,
  offhostWormVerifier = verifyOffhostWormTarget,
  operationalProofLoader = loadCapabilityOperationalProofs,
  ownerAcceptanceDocumentVerifier = verifyOwnerAcceptanceDocument,
  codeProvenanceReader = currentCodeProvenance,
} = {}) {
  if (!root || !runtimeRoot || !workspaceRoot
    || !Number.isSafeInteger(packageReadinessTimeoutMs)
    || packageReadinessTimeoutMs < 1
    || !Number.isSafeInteger(ownerReferenceRequiredUid)
    || ownerReferenceRequiredUid < 0
    || !Number.isSafeInteger(packageRecoveryReadinessCommandRequiredUid)
    || packageRecoveryReadinessCommandRequiredUid < 0
    || (packageRecoveryReadinessCommandRequiredUid !== 0
      && testOnlyPackageRecoveryReadinessCommandTrustRoot === null)) {
    throw new Error('full_production_readiness_query_inputs_invalid');
  }
  const selectedRoot = path.resolve(root);
  const selectedRuntimeRoot = path.resolve(runtimeRoot);
  const selectedWorkspaceRoot = path.resolve(workspaceRoot);
  const commandReferencePolicy = Object.freeze({
    requiredCommandUid: packageRecoveryReadinessCommandRequiredUid,
    trustedRoot: testOnlyPackageRecoveryReadinessCommandTrustRoot
      ?? path.parse(path.resolve(String(packageRecoveryReadinessCommand || ''))).root,
  });
  const ownerReferenceRoot = protectedOwnerReferenceRoot({
    ownerTrustStore,
    ownerAcceptanceDocument,
    requiredOwnerUid: ownerReferenceRequiredUid,
  });
  const ownerTrustStoreSnapshot = readPinnedOwnerReference({
    referenceRoot: ownerReferenceRoot,
    candidate: ownerTrustStore,
    expectedHash: ownerTrustStoreSha256,
    expectedName: 'OWNER_TRUST_STORE.json',
    requiredOwnerUid: ownerReferenceRequiredUid,
  });
  const ownerAcceptanceDocumentSnapshot = readPinnedOwnerReference({
    referenceRoot: ownerReferenceRoot,
    candidate: ownerAcceptanceDocument,
    expectedHash: ownerAcceptanceDocumentSha256,
    expectedName: 'CAPABILITY_OWNER_ACCEPTANCE.json',
    requiredOwnerUid: ownerReferenceRequiredUid,
  });
  const codeProvenance = codeProvenanceReader({
    workspaceRoot: selectedWorkspaceRoot,
    allowReleaseCommitEnvironment: false,
  });
  const packageRetentionRecovery = await queryPackageRetentionRecoveryReadiness({
    commandPath: packageRecoveryReadinessCommand,
    commandSha256: packageRecoveryReadinessCommandSha256,
    root: selectedRoot,
    runtimeRoot: selectedRuntimeRoot,
    workspaceRoot: selectedWorkspaceRoot,
    environment,
    runProcess,
    timeoutMs: packageReadinessTimeoutMs,
    observeNow: () => clock.now(),
    commandReferencePolicy,
  });
  const proofs = operationalProofLoader({
    runtimeRoot: selectedRuntimeRoot,
    workspaceRoot: selectedWorkspaceRoot,
    capabilityCatalog: CAPABILITY_CATALOG,
    releaseCommit: codeProvenance.commit,
    ownerTrustStoreSnapshot,
  });
  const ownerAcceptance = independentOwnerAcceptanceInspection({
    document: ownerAcceptanceDocumentSnapshot.document,
    trustStore: ownerTrustStoreSnapshot.document,
    verifyDocument: ownerAcceptanceDocumentVerifier,
  });
  const operationalProof = independentOperationalProofInspection({
    proofs,
    releaseCommit: codeProvenance.commit,
  });
  const contractPath = path.join(
    selectedWorkspaceRoot,
    'paper-core',
    'config',
    'offhost-worm-contract.v1.json',
  );
  const offhostContract = readRegularJsonFileSync(contractPath);
  if (offhostContract?.version !== 1
    || offhostContract.kind !== 'OffhostWormSnapshotContract'
    || typeof offhostContract.contractId !== 'string'
    || !offhostContract.contractId) {
    throw new Error('full_production_offhost_worm_contract_invalid');
  }
  const automationNow = clock.now();
  if (!(automationNow instanceof Date) || !Number.isFinite(automationNow.getTime())) {
    throw new Error('full_production_readiness_clock_invalid');
  }
  const automation = automationReadinessQuery({
    root: selectedRoot,
    runtimeRoot: selectedRuntimeRoot,
    environment,
    allowMissingStore: false,
    liveProviderCanaryRequested,
    requireFullyAutonomous: true,
    activeReleaseAttestorVerification,
    now: automationNow,
    liveActionClock: clock,
    codeProvenance,
  });
  const offhostWorm = offhostWormVerifier({
    workspaceRoot: selectedWorkspaceRoot,
    contract: offhostContract,
    requireCustody: true,
    now: automationNow,
  });
  const finalObservation = clock.now();
  if (!(finalObservation instanceof Date) || !Number.isFinite(finalObservation.getTime())) {
    throw new Error('full_production_readiness_clock_invalid');
  }
  assertBoundRegularJsonSnapshot(ownerTrustStoreSnapshot);
  assertBoundRegularJsonSnapshot(ownerAcceptanceDocumentSnapshot);
  return evaluateFullProductionReadiness({
    automationReport: automation.report,
    packageRetentionRecoveryInspection: packageRetentionRecovery.inspection,
    offhostWormCustodyInspection: offhostWorm,
    independentExternalOwnerAcceptanceInspection: ownerAcceptance,
    independentProductionOperationalProofInspection: operationalProof,
    offhostWormContractId: offhostContract.contractId,
    observedAt: finalObservation.toISOString(),
  });
}
