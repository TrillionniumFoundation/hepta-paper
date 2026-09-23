#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLegacyCapabilityMatrixV3 } from '../../migration/legacy-capability-matrix-v3.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { assertWorkspaceReleaseReady } from '../src/release-state-repository.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';
import {
  inspectLegacyReferenceArchive,
} from './release-evidence-legacy-immutable-snapshot.mjs';
import {
  releaseAttestationCodeProvenance,
} from './release-evidence-input-snapshot.mjs';
import { signReleasePayload } from './release-integrity-signing.mjs';
import {
  defaultLegacyPaperFactoryRoot,
  defaultPaperAssetRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyLegacyDifferentialReference } from '../../migration/legacy-reference-fixture.mjs';
import { resolveImmutableLegacyMatrixArchive } from '../../migration/legacy-matrix-reference.mjs';
import { copySqliteDatabase } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { prepareIsolatedRuntimeStore } from './isolated-runtime-store.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { bindIdentityBoundTemporaryDirectory } from '../../paper-composition/bootstrap/immutable-release-workspace-composition.mjs';

const {
  assertExactCleanCodeProvenance,
  ensurePrivateDirectoryWithinRuntime,
  removeExactPublishedFile,
  writeNoClobberJsonFile,
} = releaseIntegrityEvidence;

const modulePath = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = path.resolve(path.dirname(modulePath), '..', '..');

function exactProvenanceMatches(left, right) {
  return hashRecord('ExactCodeProvenance', left) === hashRecord('ExactCodeProvenance', right);
}

const COMMAND_RESULT_KEYS = Object.freeze([
  'args',
  'errorCode',
  'executable',
  'exitCode',
  'kind',
  'signal',
  'stderrHash',
  'stdoutHash',
  'timedOut',
  'version',
]);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function commandResult({ executable, args, result }) {
  const errorCode = typeof result?.error?.code === 'string' ? result.error.code : null;
  return Object.freeze({
    version: 1,
    kind: 'LegacyDeletionDrillCommandResult',
    executable,
    args: Object.freeze([...args]),
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    signal: typeof result?.signal === 'string' ? result.signal : null,
    errorCode,
    timedOut: errorCode === 'ETIMEDOUT',
    stdoutHash: hashRecord('CommandStdout', String(result?.stdout || '')),
    stderrHash: hashRecord('CommandStderr', String(result?.stderr || '')),
  });
}

export function isExactLegacyDeletionDrillCommandResult(value) {
  return exactKeys(value, COMMAND_RESULT_KEYS)
    && value.version === 1
    && value.kind === 'LegacyDeletionDrillCommandResult'
    && typeof value.executable === 'string' && value.executable.length > 0
    && Array.isArray(value.args) && value.args.every((argument) => typeof argument === 'string')
    && (value.exitCode === null || Number.isInteger(value.exitCode))
    && (value.signal === null || typeof value.signal === 'string')
    && (value.errorCode === null || typeof value.errorCode === 'string')
    && typeof value.timedOut === 'boolean'
    && /^sha256:[a-f0-9]{64}$/u.test(value.stdoutHash)
    && /^sha256:[a-f0-9]{64}$/u.test(value.stderrHash);
}

function commandPassed(result) {
  return isExactLegacyDeletionDrillCommandResult(result)
    && result.exitCode === 0 && result.signal === null
    && result.errorCode === null && result.timedOut === false;
}

function sameArchiveCapture(left, right) {
  return left?.archivePath === right?.archivePath
    && left?.archiveHash === right?.archiveHash
    && left?.archiveDevice === right?.archiveDevice
    && left?.archiveInode === right?.archiveInode
    && left?.archiveSize === right?.archiveSize
    && left?.archiveMode === right?.archiveMode
    && left?.archiveImmutable === right?.archiveImmutable;
}

function matrixSummary(matrix) {
  const ownerAccepted = matrix?.summary?.ownerAccepted;
  const ownerAcceptanceRequired = matrix?.summary?.entryCount;
  const operationallyProven = matrix?.summary?.operationallyProven;
  const operationallyNotProven = matrix?.summary?.operationallyNotProven;
  if (![ownerAccepted, ownerAcceptanceRequired, operationallyProven, operationallyNotProven]
    .every(Number.isSafeInteger)) throw new Error('legacy_deletion_drill_matrix_summary_invalid');
  return Object.freeze({
    ownerAccepted,
    ownerAcceptanceRequired,
    operationallyProven,
    operationalProofRequired: operationallyProven + operationallyNotProven,
  });
}

export function captureLegacyDeletionDrillDependencies({
  runtimeRoot,
  archivePath,
  fileSystem = fs,
  spawnSyncImpl = spawnSync,
  buildMatrix = buildLegacyCapabilityMatrixV3,
} = {}) {
  const archive = inspectLegacyReferenceArchive({ archivePath, fileSystem, spawnSyncImpl });
  const matrix = buildMatrix({ runtimeRoot });
  const summary = matrixSummary(matrix);
  const snapshot = Object.freeze({
    version: 1,
    kind: 'LegacyDeletionDrillDependencySnapshot',
    archive,
    matrixHash: hashRecord('LegacyDeletionDrillCapabilityMatrix', matrix),
    ...summary,
  });
  return Object.freeze({
    ...snapshot,
    dependencySnapshotHash: hashRecord('LegacyDeletionDrillDependencySnapshot', snapshot),
  });
}

function assertSameDependencies(expected, actual, stage) {
  if (expected?.dependencySnapshotHash !== actual?.dependencySnapshotHash
    || !sameArchiveCapture(expected?.archive, actual?.archive)) {
    throw new Error(`legacy_deletion_drill_inputs_changed_${stage}`);
  }
}

function extractPinnedArchive({ archive, drillRoot, spawnSyncImpl = spawnSync, fileSystem = fs }) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      archive.archivePath,
      fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0),
    );
    const before = fileSystem.fstatSync(descriptor);
    const selected = fileSystem.lstatSync(archive.archivePath);
    if (!before.isFile() || Number(before.nlink) !== 1
      || !selected.isFile() || selected.isSymbolicLink()
      || String(before.dev) !== archive.archiveDevice
      || String(before.ino) !== archive.archiveInode
      || before.size !== archive.archiveSize
      || selected.dev !== before.dev || selected.ino !== before.ino
      || archive.archiveImmutable !== true) {
      throw new Error('legacy_deletion_drill_archive_changed_before_extract');
    }
    const result = spawnSyncImpl('tar', ['-xzf', '/proc/self/fd/3', '-C', drillRoot], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
    });
    if (result?.error || result?.status !== 0) {
      throw new Error('legacy_reference_extract_failed');
    }
    const after = fileSystem.fstatSync(descriptor);
    const finalPath = fileSystem.lstatSync(archive.archivePath);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !finalPath.isFile() || finalPath.isSymbolicLink()
      || finalPath.dev !== before.dev || finalPath.ino !== before.ino) {
      throw new Error('legacy_deletion_drill_archive_changed_during_extract');
    }
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function runVerificationCommand({
  args,
  workspaceRoot,
  drillRoot,
  verificationRuntimeRoot,
  archivePath,
  environment,
  spawnSyncImpl = spawnSync,
}) {
  const result = spawnSyncImpl(process.execPath, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: {
      ...environment,
      PAPER_FACTORY_LEGACY_ROOT: drillRoot,
      HEPTA_PAPER_RUNTIME_ROOT: verificationRuntimeRoot,
      HEPTA_PAPER_RUNTIME_ISOLATED: '1',
      HEPTA_LEGACY_REFERENCE_PREPARED: '1',
      HEPTA_LEGACY_REFERENCE_ARCHIVE: archivePath,
    },
    timeout: 240000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return commandResult({ executable: process.execPath, args, result });
}

export function classifyLegacyDeletionDrill({
  checks,
  policyChecks,
  sqliteQuickCheck,
  minimalDifferentialFixture,
  archiveImmutable,
  ownerAccepted,
  ownerAcceptanceRequired,
  operationallyProven,
  operationalProofRequired,
} = {}) {
  const technicalBlockers = [];
  const authorizationBlockers = [];
  if (!Array.isArray(checks) || checks.length < 1
    || !checks.every(isExactLegacyDeletionDrillCommandResult)) {
    technicalBlockers.push('legacy_reference_differential_result_contract_invalid');
  } else if (!checks.every(commandPassed)) {
    technicalBlockers.push('legacy_reference_differential_replay_failed');
  }
  if (!Array.isArray(policyChecks) || policyChecks.length < 1
    || !policyChecks.every(isExactLegacyDeletionDrillCommandResult)) {
    technicalBlockers.push('legacy_matrix_policy_result_contract_invalid');
  } else if (!policyChecks.every(commandPassed)) {
    technicalBlockers.push('legacy_matrix_policy_check_failed');
  }
  if (sqliteQuickCheck !== 'ok') {
    technicalBlockers.push('legacy_database_restore_quick_check_failed');
  }
  if (minimalDifferentialFixture?.status !== 'legacy_differential_reference_verified') {
    technicalBlockers.push('minimal_legacy_differential_fixture_invalid');
  }
  if (archiveImmutable !== true) {
    technicalBlockers.push('legacy_reference_archive_not_filesystem_immutable');
  }
  if (!Number.isSafeInteger(ownerAcceptanceRequired) || ownerAcceptanceRequired < 1
    || !Number.isSafeInteger(ownerAccepted) || ownerAccepted < 0
    || ownerAccepted > ownerAcceptanceRequired) {
    authorizationBlockers.push('owner_acceptance_required_count_invalid');
  } else if (ownerAccepted !== ownerAcceptanceRequired) {
    authorizationBlockers.push('owner_acceptance_incomplete');
  }
  if (!Number.isSafeInteger(operationalProofRequired) || operationalProofRequired < 1
    || !Number.isSafeInteger(operationallyProven) || operationallyProven < 0
    || operationallyProven > operationalProofRequired) {
    authorizationBlockers.push('operational_proof_required_count_invalid');
  } else if (operationallyProven !== operationalProofRequired) {
    authorizationBlockers.push('operational_proof_incomplete');
  }
  const technicalReleaseReady = technicalBlockers.length === 0;
  const physicalDeletionAuthorized = technicalReleaseReady
    && authorizationBlockers.length === 0;
  return Object.freeze({
    technicalReleaseReady,
    physicalDeletionAuthorized,
    technicalBlockers: Object.freeze(technicalBlockers),
    authorizationBlockers: Object.freeze(authorizationBlockers),
    blockers: Object.freeze([...technicalBlockers, ...authorizationBlockers]),
  });
}

function pathPresentNoFollow(candidate, fileSystem = fs) {
  try {
    fileSystem.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function createLegacyDeletionDrillTemporaryDirectory({
  temporaryParent = os.tmpdir(),
} = {}) {
  const root = fs.mkdtempSync(path.join(temporaryParent, 'hepta-legacy-deletion-drill-'));
  return bindIdentityBoundTemporaryDirectory(root);
}

export async function verifyLegacyDeletionDrill({
  workspaceRoot = defaultWorkspaceRoot,
  runtimeRoot = defaultPaperRuntimeRoot(),
  legacyRoot = defaultLegacyPaperFactoryRoot(),
  archivePath = resolveImmutableLegacyMatrixArchive(),
  environment = process.env,
  spawnSyncImpl = spawnSync,
  captureDependencies = captureLegacyDeletionDrillDependencies,
  temporaryParent = os.tmpdir(),
} = {}) {
  const dependenciesBefore = captureDependencies({ runtimeRoot, archivePath, spawnSyncImpl });
  const temporaryDirectory = createLegacyDeletionDrillTemporaryDirectory({ temporaryParent });
  const drillRoot = temporaryDirectory.root;
  try {
    extractPinnedArchive({
      archive: dependenciesBefore.archive,
      drillRoot,
      spawnSyncImpl,
    });
    const verificationRuntimeRoot = path.join(drillRoot, 'verification-runtime');
    fs.mkdirSync(verificationRuntimeRoot, { mode: 0o700 });
    const productionStorePath = path.join(runtimeRoot, 'hepta-paper.sqlite');
    const verificationStorePath = path.join(verificationRuntimeRoot, 'hepta-paper.sqlite');
    if (fs.existsSync(productionStorePath)) {
      await copySqliteDatabase({
        sourcePath: productionStorePath,
        destinationPath: verificationStorePath,
      });
    } else {
      prepareIsolatedRuntimeStore({
        root: defaultPaperAssetRoot(),
        runtimeRoot: verificationRuntimeRoot,
        dbPath: verificationStorePath,
      });
    }
    const retirementEvidenceRoot = path.join(runtimeRoot, 'legacy-retirement');
    if (fs.existsSync(retirementEvidenceRoot)) {
      fs.cpSync(retirementEvidenceRoot, path.join(verificationRuntimeRoot, 'legacy-retirement'), {
        recursive: true,
        dereference: false,
      });
    }
    const command = (args) => runVerificationCommand({
      args,
      workspaceRoot,
      drillRoot,
      verificationRuntimeRoot,
      archivePath,
      environment,
      spawnSyncImpl,
    });
    const policyChecks = [
      command(['migration/tests/matrix-integrity.mjs']),
    ];
    const checks = [
      command(['migration/tests/p0-production-core-differential.mjs']),
      command(['migration/tests/p1-referee-revision-differential.mjs']),
    ];
    const sqlite = spawnSyncImpl('sqlite3', [
      '-readonly',
      path.join(drillRoot, 'paper_factory.sqlite'),
      'PRAGMA quick_check;',
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000 });
    const fixtureVerification = verifyLegacyDifferentialReference();
    const dependenciesAfter = captureDependencies({ runtimeRoot, archivePath, spawnSyncImpl });
    assertSameDependencies(dependenciesBefore, dependenciesAfter, 'during_verification');
    const sqliteQuickCheck = String(sqlite?.stdout || '').trim();
    const classification = classifyLegacyDeletionDrill({
      checks,
      policyChecks,
      sqliteQuickCheck,
      minimalDifferentialFixture: fixtureVerification,
      archiveImmutable: dependenciesBefore.archive.archiveImmutable,
      ownerAccepted: dependenciesBefore.ownerAccepted,
      ownerAcceptanceRequired: dependenciesBefore.ownerAcceptanceRequired,
      operationallyProven: dependenciesBefore.operationallyProven,
      operationalProofRequired: dependenciesBefore.operationalProofRequired,
    });
    const liveLegacyRootPresent = pathPresentNoFollow(legacyRoot);
    return Object.freeze({
      version: 1,
      kind: 'LegacyPhysicalDeletionAndRestoreDrillVerification',
      status: classification.technicalReleaseReady
        ? 'legacy_reference_restore_drill_verification_passed'
        : 'legacy_reference_restore_drill_verification_blocked',
      archivePath: dependenciesBefore.archive.archivePath,
      archiveHash: dependenciesBefore.archive.archiveHash,
      archiveDevice: dependenciesBefore.archive.archiveDevice,
      archiveInode: dependenciesBefore.archive.archiveInode,
      archiveSize: dependenciesBefore.archive.archiveSize,
      archiveMode: dependenciesBefore.archive.archiveMode,
      dependencySnapshotHash: dependenciesBefore.dependencySnapshotHash,
      matrixHash: dependenciesBefore.matrixHash,
      checks,
      policyChecks,
      sqliteQuickCheck,
      minimalDifferentialFixture: fixtureVerification,
      archiveImmutable: dependenciesBefore.archive.archiveImmutable,
      ownerAccepted: dependenciesBefore.ownerAccepted,
      ownerAcceptanceRequired: dependenciesBefore.ownerAcceptanceRequired,
      operationallyProven: dependenciesBefore.operationallyProven,
      operationalProofRequired: dependenciesBefore.operationalProofRequired,
      technicalReleaseReady: classification.technicalReleaseReady,
      physicalDeletionEligible: classification.physicalDeletionAuthorized,
      technicalBlockers: classification.technicalBlockers,
      authorizationBlockers: classification.authorizationBlockers,
      blockers: classification.blockers,
      destructiveDeletionPerformed: !liveLegacyRootPresent,
      liveLegacyRootPresent,
      restoredFromReferenceArchive: true,
      signingKeyRead: false,
      runtimeEvidenceWritten: false,
      externalActionPerformed: false,
      verifiedAt: new Date().toISOString(),
    });
  } finally {
    temporaryDirectory.cleanup();
  }
}

function captureAttestationInputs({
  workspaceRoot,
  runtimeRoot,
  archivePath,
  environment,
  captureReleaseState,
  captureCodeProvenance,
  captureDependencies,
  spawnSyncImpl,
}) {
  const releaseState = captureReleaseState({ workspaceRoot });
  const provenance = assertExactCleanCodeProvenance(captureCodeProvenance({
    workspaceRoot,
    allowReleaseCommitEnvironment: false,
  }), { releaseCommitAssertion: environment.HEPTA_RELEASE_COMMIT });
  if (releaseState.headCommit !== provenance.commit) {
    throw new Error('legacy_deletion_drill_release_state_commit_mismatch');
  }
  const dependencies = captureDependencies({ runtimeRoot, archivePath, spawnSyncImpl });
  const snapshot = Object.freeze({
    version: 1,
    kind: 'LegacyDeletionDrillAttestationInputSnapshot',
    releaseStateSnapshotHash: releaseState.workspaceReleaseStateSnapshotHash,
    provenanceHash: hashRecord('ExactCodeProvenance', provenance),
    dependencySnapshotHash: dependencies.dependencySnapshotHash,
  });
  return Object.freeze({
    releaseState,
    provenance,
    dependencies,
    attestationInputSnapshotHash: hashRecord(
      'LegacyDeletionDrillAttestationInputSnapshot',
      snapshot,
    ),
  });
}

function assertSameAttestationInputs(expected, actual, stage) {
  if (expected.attestationInputSnapshotHash !== actual.attestationInputSnapshotHash
    || !exactProvenanceMatches(expected.provenance, actual.provenance)) {
    throw new Error(`legacy_deletion_drill_inputs_changed_${stage}`);
  }
  assertSameDependencies(expected.dependencies, actual.dependencies, stage);
}

export async function attestLegacyDeletionDrill({
  workspaceRoot = defaultWorkspaceRoot,
  runtimeRoot = defaultPaperRuntimeRoot(),
  legacyRoot = defaultLegacyPaperFactoryRoot(),
  archivePath = resolveImmutableLegacyMatrixArchive(),
  environment = process.env,
  spawnSyncImpl = spawnSync,
  captureReleaseState = assertWorkspaceReleaseReady,
  captureCodeProvenance = currentCodeProvenance,
  captureDependencies = captureLegacyDeletionDrillDependencies,
  verifyDrill = verifyLegacyDeletionDrill,
  signPayload = signReleasePayload,
  ensureOutputRoot = ensurePrivateDirectoryWithinRuntime,
  publishReceipt = writeNoClobberJsonFile,
  rollbackPublication = removeExactPublishedFile,
  now = new Date(),
} = {}) {
  if (environment.HEPTA_PAPER_RUNTIME_ISOLATED === '1') throw new Error('legacy_deletion_drill_attestation_forbidden_in_isolated_runtime');
  const baseline = captureAttestationInputs({
    workspaceRoot,
    runtimeRoot,
    archivePath,
    environment,
    captureReleaseState,
    captureCodeProvenance,
    captureDependencies,
    spawnSyncImpl,
  });
  const verification = await verifyDrill({
    workspaceRoot,
    runtimeRoot,
    legacyRoot,
    archivePath,
    environment,
    spawnSyncImpl,
    captureDependencies,
  });
  if (verification.dependencySnapshotHash !== baseline.dependencies.dependencySnapshotHash) {
    throw new Error('legacy_deletion_drill_verification_dependency_snapshot_mismatch');
  }
  const afterVerification = captureAttestationInputs({
    workspaceRoot,
    runtimeRoot,
    archivePath,
    environment,
    captureReleaseState,
    captureCodeProvenance,
    captureDependencies,
    spawnSyncImpl,
  });
  assertSameAttestationInputs(baseline, afterVerification, 'during_verification');
  const codeProvenance = releaseAttestationCodeProvenance(baseline.provenance);
  const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const payload = {
    version: 2,
    kind: 'LegacyPhysicalDeletionAndRestoreDrillReceipt',
    status: !verification.technicalReleaseReady
      ? 'legacy_reference_restore_drill_blocked'
      : verification.physicalDeletionEligible
        ? 'legacy_reference_restore_drill_passed_deletion_allowed'
        : 'legacy_reference_restore_drill_passed_deletion_blocked',
    codeProvenance,
    releaseStateSnapshot: baseline.releaseState,
    releaseStateSnapshotHash: baseline.releaseState.workspaceReleaseStateSnapshotHash,
    archivePath: verification.archivePath,
    archiveHash: verification.archiveHash,
    checks: verification.checks,
    policyChecks: verification.policyChecks,
    sqliteQuickCheck: verification.sqliteQuickCheck,
    minimalDifferentialFixture: verification.minimalDifferentialFixture,
    archiveImmutable: verification.archiveImmutable,
    ownerAccepted: verification.ownerAccepted,
    ownerAcceptanceRequired: verification.ownerAcceptanceRequired,
    operationallyProven: verification.operationallyProven,
    operationalProofRequired: verification.operationalProofRequired,
    physicalDeletionAllowed: verification.physicalDeletionEligible,
    blockers: verification.blockers,
    destructiveDeletionPerformed: verification.destructiveDeletionPerformed,
    liveLegacyRootPresent: verification.liveLegacyRootPresent,
    restoredFromReferenceArchive: verification.restoredFromReferenceArchive,
    createdAt,
  };
  const receipt = {
    ...payload,
    legacyPhysicalDeletionAndRestoreDrillReceiptHash: hashRecord(
      'LegacyPhysicalDeletionAndRestoreDrillReceipt',
      payload,
    ),
  };
  const beforeSigning = captureAttestationInputs({
    workspaceRoot,
    runtimeRoot,
    archivePath,
    environment,
    captureReleaseState,
    captureCodeProvenance,
    captureDependencies,
    spawnSyncImpl,
  });
  assertSameAttestationInputs(baseline, beforeSigning, 'before_signing');
  const signature = signPayload(receipt, runtimeRoot, {
    allowKeyCreation: false,
    environment,
  });
  const beforePublication = captureAttestationInputs({
    workspaceRoot,
    runtimeRoot,
    archivePath,
    environment,
    captureReleaseState,
    captureCodeProvenance,
    captureDependencies,
    spawnSyncImpl,
  });
  assertSameAttestationInputs(baseline, beforePublication, 'before_publication');
  const outputRoot = path.join(runtimeRoot, 'legacy-retirement', 'deletion-drills');
  ensureOutputRoot(runtimeRoot, outputRoot);
  const receiptToken = receipt.legacyPhysicalDeletionAndRestoreDrillReceiptHash.slice('sha256:'.length);
  const receiptPath = path.join(
    outputRoot,
    `LEGACY_DELETION_DRILL_${Date.parse(createdAt)}_${receiptToken}.json`,
  );
  let publication;
  try {
    publication = publishReceipt(receiptPath, { ...receipt, signature });
    const afterPublication = captureAttestationInputs({
      workspaceRoot,
      runtimeRoot,
      archivePath,
      environment,
      captureReleaseState,
      captureCodeProvenance,
      captureDependencies,
      spawnSyncImpl,
    });
    assertSameAttestationInputs(baseline, afterPublication, 'after_publication');
  } catch (error) {
    if (publication && !rollbackPublication(publication)) {
      throw new Error(`legacy_deletion_drill_publication_rollback_incomplete:${error.message}`);
    }
    throw error;
  }
  return Object.freeze({ verification, receipt, signature, receiptPath, publication });
}

export function legacyDeletionDrillUsage() {
  return [
    'Usage:',
    '  node paper-core/bin/legacy-deletion-drill.mjs',
    '  node paper-core/bin/legacy-deletion-drill.mjs --attest --execute',
    '',
    'The default mode performs isolated verification and does not publish evidence.',
    'Attestation requires both --attest and the explicit --execute authority.',
  ].join('\n');
}

export function parseLegacyDeletionDrillArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['attest', 'execute', 'help'],
    valueFlags: [],
    positional: false,
  });
  if (args.help) return Object.freeze({ mode: 'help', execute: false });
  if (args.attest) return Object.freeze({ mode: 'attest', execute: args.execute === true });
  if (args.execute) throw new Error('legacy_deletion_drill_attest_required_for_execute');
  return Object.freeze({ mode: 'verify', execute: false });
}

export async function runLegacyDeletionDrillCommand({
  argv = process.argv.slice(2),
  environment = process.env,
  attestDrill = attestLegacyDeletionDrill,
  verifyDrill = verifyLegacyDeletionDrill,
} = {}) {
  const options = parseLegacyDeletionDrillArguments(argv);
  if (options.mode === 'help') return legacyDeletionDrillUsage();
  if (options.mode === 'attest' && environment.HEPTA_PAPER_RUNTIME_ISOLATED === '1') {
    throw new Error('legacy_deletion_drill_attestation_forbidden_in_isolated_runtime');
  }
  if (options.mode === 'attest' && !options.execute) {
    throw new Error('legacy_deletion_drill_attestation_execute_required');
  }
  if (options.mode === 'attest') {
    const result = await attestDrill({ environment });
    return result.receipt;
  }
  return verifyDrill({ environment });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const report = await runLegacyDeletionDrillCommand();
    process.stdout.write(`${typeof report === 'string' ? report : JSON.stringify(report, null, 2)}\n`);
    if (typeof report !== 'string') {
      const passed = report.kind === 'LegacyPhysicalDeletionAndRestoreDrillReceipt'
        ? report.status.startsWith('legacy_reference_restore_drill_passed')
        : report.status === 'legacy_reference_restore_drill_verification_passed';
      if (!passed) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}
