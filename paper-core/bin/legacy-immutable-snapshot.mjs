#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { assertWorkspaceReleaseReady } from '../src/release-state-repository.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import {
  assertWorkspaceLayoutPhysicallyDecoupled,
  defaultLegacyPaperFactoryRoot,
  defaultPaperRuntimeRoot,
} from '../src/workspace-layout.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';
import {
  inspectLegacyReferenceArchive,
  selectCurrentLegacyImmutableSnapshotReceipt,
} from './release-evidence-legacy-immutable-snapshot.mjs';
import {
  releaseAttestationCodeProvenance,
} from './release-evidence-input-snapshot.mjs';
import { signReleasePayload } from './release-integrity-signing.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const {
  assertExactCleanCodeProvenance,
  publishJsonArtifactSet,
} = releaseIntegrityEvidence;

const modulePath = fileURLToPath(import.meta.url);
const defaultWorkspaceRoot = path.resolve(path.dirname(modulePath), '..', '..');
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const LEGACY_REFERENCE_ARCHIVE_BASENAME = 'paper-factory-control-plane-reference.tar.gz';

export function legacyImmutableSnapshotUsage() {
  return [
    'Usage: legacy-immutable-snapshot [--execute] [options]',
    '',
    '  (default)              Emit a read-only execution-required plan.',
    '  --execute              Set +i when needed and publish a signed v2 receipt.',
    '  --version VERSION      Exact current release package version.',
    '  --archive-path PATH    Explicit existing legacy reference archive.',
    '  --runtime-root PATH    Existing physically decoupled runtime root.',
    '  --workspace-root PATH  Release-ready source workspace.',
    '  --help                 Show this help without reading keys or writing files.',
    '',
    'Publication requires a clean release-ready workspace and an existing runtime signing key.',
    'Receipt and signature files are immutable-history, no-clobber artifacts.',
  ].join('\n');
}

export function parseLegacyImmutableSnapshotArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['execute', 'help'],
    valueFlags: ['archive-path', 'runtime-root', 'version', 'workspace-root'],
    positional: false,
  });
  if (args.help) return Object.freeze({ help: true, execute: false });
  if (args.version && !VERSION_PATTERN.test(args.version)) {
    throw new Error('legacy_immutable_snapshot_version_invalid');
  }
  return Object.freeze({
    help: false,
    execute: args.execute === true,
    version: args.version || null,
    archivePath: args['archive-path'] ? path.resolve(args['archive-path']) : null,
    runtimeRoot: args['runtime-root'] ? path.resolve(args['runtime-root']) : null,
    workspaceRoot: args['workspace-root'] ? path.resolve(args['workspace-root']) : null,
  });
}

export function expectedLegacyImmutableArchivePath({ legacyRoot, referenceVersion } = {}) {
  if (typeof legacyRoot !== 'string' || !path.isAbsolute(legacyRoot)
    || !VERSION_PATTERN.test(String(referenceVersion || ''))) {
    throw new Error('legacy_immutable_snapshot_expected_archive_identity_invalid');
  }
  return path.join(
    path.dirname(path.resolve(legacyRoot)),
    'hepta-paper-legacy-reference',
    referenceVersion,
    LEGACY_REFERENCE_ARCHIVE_BASENAME,
  );
}

function assertExpectedLegacyImmutableArchivePath({
  archivePath,
  legacyRoot,
  referenceVersion,
} = {}) {
  const expected = expectedLegacyImmutableArchivePath({ legacyRoot, referenceVersion });
  if (path.resolve(String(archivePath || '')) !== expected || archivePath !== expected) {
    throw new Error('legacy_immutable_snapshot_archive_path_outside_expected_target');
  }
  return expected;
}

function sameArchiveIdentity(actual, expected) {
  return actual.archivePath === expected.archivePath
    && actual.archiveHash === expected.archiveHash
    && actual.archiveDevice === expected.archiveDevice
    && actual.archiveInode === expected.archiveInode
    && actual.archiveSize === expected.archiveSize
    && actual.archiveMode === expected.archiveMode;
}

function exactAdministrativeProvenance({
  workspaceRoot,
  environment,
  captureCodeProvenance = currentCodeProvenance,
}) {
  return releaseAttestationCodeProvenance(assertExactCleanCodeProvenance(
    captureCodeProvenance({ workspaceRoot, allowReleaseCommitEnvironment: false }),
    { releaseCommitAssertion: environment.HEPTA_RELEASE_COMMIT },
  ));
}

export function attestLegacyImmutableSnapshot({
  archivePath,
  runtimeRoot,
  legacyRoot = defaultLegacyPaperFactoryRoot(),
  workspaceRoot = defaultWorkspaceRoot,
  referenceVersion = null,
  environment = process.env,
  now = new Date(),
  spawnSyncImpl = spawnSync,
  captureReleaseState = assertWorkspaceReleaseReady,
  captureCodeProvenance = currentCodeProvenance,
} = {}) {
  if (environment.HEPTA_PAPER_RUNTIME_ISOLATED === '1') {
    throw new Error('legacy_immutable_snapshot_attestation_forbidden_in_isolated_runtime');
  }
  if (typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot)
    || typeof archivePath !== 'string' || !path.isAbsolute(archivePath)
    || path.resolve(archivePath) !== archivePath) {
    throw new Error('legacy_immutable_snapshot_paths_invalid');
  }
  assertWorkspaceLayoutPhysicallyDecoupled({ legacyRoot, runtimeRoot });
  const releaseStateBefore = captureReleaseState({ workspaceRoot });
  const codeProvenance = exactAdministrativeProvenance({
    workspaceRoot,
    environment,
    captureCodeProvenance,
  });
  if (releaseStateBefore.headCommit !== codeProvenance.commit) {
    throw new Error('legacy_immutable_snapshot_release_state_commit_mismatch');
  }
  const version = referenceVersion || codeProvenance.packageVersion;
  if (!VERSION_PATTERN.test(version) || version !== codeProvenance.packageVersion) {
    throw new Error('legacy_immutable_snapshot_reference_version_mismatch');
  }
  assertExpectedLegacyImmutableArchivePath({ archivePath, legacyRoot, referenceVersion: version });
  const before = inspectLegacyReferenceArchive({ archivePath, spawnSyncImpl });
  let immutableCommand = Object.freeze({ attempted: false, exitCode: null });
  if (!before.archiveImmutable) {
    const result = spawnSyncImpl('sudo', ['-n', 'chattr', '+i', '--', archivePath], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    immutableCommand = Object.freeze({
      attempted: true,
      exitCode: Number.isInteger(result?.status) ? result.status : null,
    });
    if (result?.status !== 0) throw new Error('legacy_immutable_snapshot_chattr_failed');
  }
  const capturedArchive = inspectLegacyReferenceArchive({ archivePath, spawnSyncImpl });
  if (!sameArchiveIdentity(capturedArchive, before) || capturedArchive.archiveImmutable !== true) {
    throw new Error('legacy_immutable_snapshot_archive_changed_or_not_immutable');
  }
  const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const payload = {
    version: 2,
    kind: 'LegacyReferenceImmutableSnapshotReceipt',
    status: 'legacy_reference_ext4_inode_immutable',
    codeProvenance,
    releaseStateSnapshot: releaseStateBefore,
    releaseStateSnapshotHash: releaseStateBefore.workspaceReleaseStateSnapshotHash,
    referenceVersion: version,
    archivePath: capturedArchive.archivePath,
    archiveHash: capturedArchive.archiveHash,
    archiveDevice: capturedArchive.archiveDevice,
    archiveInode: capturedArchive.archiveInode,
    archiveSize: capturedArchive.archiveSize,
    archiveMode: capturedArchive.archiveMode,
    filesystemMechanism: 'ext4_inode_immutable_flag',
    archiveImmutable: true,
    fullFilesystemWormClaimed: false,
    immutableContentObjectClaimed: true,
    destructiveDeletionPerformed: false,
    createdAt,
  };
  const receipt = Object.freeze({
    ...payload,
    immutableSnapshotReceiptHash: hashRecord(
      'LegacyReferenceImmutableSnapshotReceipt',
      payload,
    ),
  });
  const signature = Object.freeze(signReleasePayload(receipt, runtimeRoot, {
    allowKeyCreation: false,
    environment,
  }));
  const timestamp = Date.parse(createdAt);
  const token = receipt.immutableSnapshotReceiptHash.slice('sha256:'.length);
  const archiveRoot = path.dirname(archivePath);
  const candidateName = `IMMUTABLE_SNAPSHOT_RECEIPT_${timestamp}_${token}.json`;
  const signatureCandidateName = `IMMUTABLE_SNAPSHOT_SIGNATURE_${timestamp}_${token}.json`;
  const receiptPath = path.join(archiveRoot, candidateName);
  const signaturePath = path.join(archiveRoot, signatureCandidateName);
  const pointerPayload = {
    version: 2,
    kind: 'CurrentLegacyImmutableSnapshotPointer',
    referenceVersion: version,
    receiptPath,
    receiptHash: receipt.immutableSnapshotReceiptHash,
    signaturePath,
    signingKeyFingerprint: signature.publicKeyFingerprint,
    archivePath,
    archiveHash: capturedArchive.archiveHash,
    releaseStateSnapshotHash: releaseStateBefore.workspaceReleaseStateSnapshotHash,
    createdAt,
  };
  const pointer = Object.freeze({
    ...pointerPayload,
    currentLegacyImmutableSnapshotPointerHash: hashRecord(
      'CurrentLegacyImmutableSnapshotPointer',
      pointerPayload,
    ),
  });
  const assertStableSource = () => {
    captureReleaseState({
      workspaceRoot,
      expectedSnapshotHash: releaseStateBefore.workspaceReleaseStateSnapshotHash,
    });
    const currentProvenance = exactAdministrativeProvenance({
      workspaceRoot,
      environment,
      captureCodeProvenance,
    });
    if (hashRecord('ExactLegacyImmutableSnapshotCodeProvenance', currentProvenance)
      !== hashRecord('ExactLegacyImmutableSnapshotCodeProvenance', codeProvenance)) {
      throw new Error('legacy_immutable_snapshot_code_provenance_changed');
    }
    const currentArchive = inspectLegacyReferenceArchive({ archivePath, spawnSyncImpl });
    if (!sameArchiveIdentity(currentArchive, capturedArchive)
      || currentArchive.archiveImmutable !== true) {
      throw new Error('legacy_immutable_snapshot_archive_changed_before_publication');
    }
  };
  const assertPublishedSelection = () => {
    const selected = selectCurrentLegacyImmutableSnapshotReceipt({
      archivePath,
      runtimeRoot,
      expectedCodeProvenance: codeProvenance,
      expectedReleaseStateSnapshot: releaseStateBefore,
      now: new Date(createdAt),
      spawnSyncImpl,
    });
    if (selected.status !== 'legacy_immutable_snapshot_current_evidence_verified'
      || selected.receiptHash !== receipt.immutableSnapshotReceiptHash
      || selected.candidatePath !== receiptPath
      || selected.signaturePath !== signaturePath
      || selected.pinnedPublicKeyFingerprint !== signature.publicKeyFingerprint) {
      throw new Error('legacy_immutable_snapshot_published_selection_mismatch');
    }
  };
  assertStableSource();
  const publication = publishJsonArtifactSet({
    entries: [
      { path: receiptPath, value: receipt },
      { path: signaturePath, value: signature },
    ],
    pointerPath: path.join(archiveRoot, 'CURRENT_IMMUTABLE_SNAPSHOT.json'),
    pointerValue: pointer,
    beforePointer: () => {
      assertStableSource();
      assertPublishedSelection();
    },
    afterPointer: () => {
      assertStableSource();
      assertPublishedSelection();
    },
  });
  return Object.freeze({
    receipt,
    signature,
    receiptPath,
    signaturePath,
    pointer,
    publication,
    immutableCommand,
    externalActionPerformed: immutableCommand.attempted,
  });
}

export function runLegacyImmutableSnapshotCommand({
  argv = process.argv.slice(2),
  environment = process.env,
  now = new Date(),
  spawnSyncImpl = spawnSync,
} = {}) {
  const options = parseLegacyImmutableSnapshotArguments(argv);
  if (options.help) return legacyImmutableSnapshotUsage();
  if (!options.execute) {
    return Object.freeze({
      version: 1,
      kind: 'LegacyImmutableSnapshotExecutionPlan',
      status: 'legacy_immutable_snapshot_execute_required',
      execute: false,
      externalActionPerformed: false,
    });
  }
  const legacyRoot = defaultLegacyPaperFactoryRoot();
  const runtimeRoot = options.runtimeRoot
    || (environment.HEPTA_PAPER_RUNTIME_ROOT
      ? path.resolve(environment.HEPTA_PAPER_RUNTIME_ROOT)
      : defaultPaperRuntimeRoot());
  const workspaceRoot = options.workspaceRoot || defaultWorkspaceRoot;
  const version = options.version || currentCodeProvenance({
    workspaceRoot,
    allowReleaseCommitEnvironment: false,
  }).packageVersion;
  const archivePath = options.archivePath || path.join(
    path.dirname(legacyRoot),
    'hepta-paper-legacy-reference',
    version,
    LEGACY_REFERENCE_ARCHIVE_BASENAME,
  );
  return attestLegacyImmutableSnapshot({
    archivePath,
    runtimeRoot,
    legacyRoot,
    workspaceRoot,
    referenceVersion: version,
    environment,
    now,
    spawnSyncImpl,
  });
}

const invokedAsEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (invokedAsEntrypoint) {
  try {
    const result = runLegacyImmutableSnapshotCommand();
    process.stdout.write(`${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}
