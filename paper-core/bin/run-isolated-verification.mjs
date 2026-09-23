#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildSqliteLogicalIntegrityReport,
  copySqliteDatabase,
  createReadOnlyPaperStore,
} from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { assertWorkspaceLayoutPhysicallyDecoupled, defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import {
  inspectIsolatedVerificationPreflight,
  isolatedVerificationCodeProvenanceMatches,
} from '../src/isolated-verification-policy.mjs';
import { buildIsolatedVerificationReceipt } from '../src/isolated-verification-receipt-contract.mjs';
import {
  inspectIsolatedVerificationCapabilityManifest,
  publishIsolatedVerificationReceiptArtifacts,
} from './isolated-verification-receipt-publication.mjs';
import { assertWorkspaceReleaseReady } from '../src/release-state-repository.mjs';
import { sha256StableFileSyncNoFollow } from '../../workflow-kernel/runtime/file-utils.mjs';
import { prepareImmutableLegacyMatrixReference } from '../../migration/legacy-matrix-reference.mjs';
import { prepareIsolatedRuntimeStore } from './isolated-runtime-store.mjs';
import { inspectTrackedProductionGraph } from '../verification/tracked-production-graph.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';
import {
  bindIdentityBoundTemporaryDirectory,
  createNonReentrantCleanup,
  prepareImmutableReleaseWorkspace,
} from '../../paper-composition/bootstrap/immutable-release-workspace-composition.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mode = process.argv[2] || 'test';
if (!['test', 'ci', 'release'].includes(mode)) throw new Error(`Unsupported isolated verification mode: ${mode}`);
function currentVerificationCodeProvenance({
  allowReleaseCommitEnvironment,
  selectedWorkspaceRoot = workspaceRoot,
} = {}) {
  return Object.freeze({
    ...currentCodeProvenance({
      workspaceRoot: selectedWorkspaceRoot,
      allowReleaseCommitEnvironment,
    }),
    evidenceEnvironment: 'verification',
    evidenceClass: 'technical_conformance',
  });
}
const inheritedReleaseCommit = mode === 'release'
  ? process.env.HEPTA_RELEASE_COMMIT || null
  : null;
const provenanceBefore = currentVerificationCodeProvenance({
  allowReleaseCommitEnvironment: mode !== 'release',
});
const verificationPreflight = inspectIsolatedVerificationPreflight({
  mode,
  codeProvenance: provenanceBefore,
  declaredReleaseCommit: inheritedReleaseCommit,
});
const releaseStateSnapshot = mode === 'release'
  ? assertWorkspaceReleaseReady({ workspaceRoot })
  : null;
const immutableReleaseWorkspace = mode === 'release'
  ? prepareImmutableReleaseWorkspace({
    candidateWorkspaceRoot: workspaceRoot,
    expectedCodeProvenance: provenanceBefore,
    expectedReleaseStateSnapshot: releaseStateSnapshot,
    codeProvenanceMatches: isolatedVerificationCodeProvenanceMatches,
    inspectReleaseState({ workspaceRoot: selectedWorkspaceRoot, expectedSnapshotHash }) {
      return assertWorkspaceReleaseReady({
        workspaceRoot: selectedWorkspaceRoot,
        expectedSnapshotHash,
      });
    },
  })
  : null;
const executionWorkspaceRoot = immutableReleaseWorkspace?.workspaceRoot || workspaceRoot;
const cleanupImmutableReleaseWorkspace = createNonReentrantCleanup(
  () => immutableReleaseWorkspace?.cleanup(),
);
if (immutableReleaseWorkspace) process.once('exit', cleanupImmutableReleaseWorkspace);
const productionGraphTracking = mode === 'release'
  ? inspectTrackedProductionGraph({ workspaceRoot: executionWorkspaceRoot })
  : null;
const verificationPreflightBlockers = [
  ...verificationPreflight.blockers,
  ...(releaseStateSnapshot && releaseStateSnapshot.headCommit !== provenanceBefore.commit
    ? ['isolated_verification_release_state_commit_mismatch']
    : []),
  ...(productionGraphTracking?.blockers || []),
];
if (verificationPreflightBlockers.length) {
  throw new Error(`isolated_verification_preflight_blocked:${verificationPreflightBlockers.join(',')}`);
}
const productionRuntimeRoot = defaultPaperRuntimeRoot();
if (mode === 'release') {
  assertWorkspaceLayoutPhysicallyDecoupled({
    assetRoot: defaultPaperAssetRoot(),
    runtimeRoot: productionRuntimeRoot,
  });
}
const releaseSigningKey = mode === 'release'
  ? releaseIntegrityEvidence.loadExistingReleaseSigningKey(
    productionRuntimeRoot,
    { includePrivate: true },
  )
  : null;
const releaseSigningKeyIdentity = releaseSigningKey
  ? Object.freeze({
    publicKeyPem: releaseSigningKey.publicKeyPem,
    publicKeyFingerprint: releaseSigningKey.publicKeyFingerprint,
  })
  : null;
if (Buffer.isBuffer(releaseSigningKey?.privateKeyPem)) releaseSigningKey.privateKeyPem.fill(0);
const isolatedRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-paper-${mode}-`));
const ownedIsolatedRuntimeRoot = bindIdentityBoundTemporaryDirectory(isolatedRuntimeRoot);
const cleanupIsolatedRuntimeRoot = createNonReentrantCleanup(
  () => ownedIsolatedRuntimeRoot.cleanup(),
);
const isolatedDb = path.join(isolatedRuntimeRoot, 'hepta-paper.sqlite');
const productionDb = path.join(productionRuntimeRoot, 'hepta-paper.sqlite');

if (mode === 'release' && fs.existsSync(productionDb)) {
  const preflight = spawnSync(process.execPath, ['paper-core/bin/hepta-store.mjs', 'status', '--require-trust-clean'], { cwd: executionWorkspaceRoot, env: process.env, encoding: 'utf8' });
  if (preflight.status !== 0) throw new Error(`production_store_trust_preflight_blocked:${String(preflight.stdout || preflight.stderr || '').slice(-2000)}`);
}

function sha(file) {
  try {
    return sha256StableFileSyncNoFollow(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

const productionHashBefore = sha(productionDb);
const legacyReference = prepareImmutableLegacyMatrixReference();
const cleanupLegacyReference = createNonReentrantCleanup(() => legacyReference.cleanup());
process.once('exit', cleanupLegacyReference);
const productionLogicalBefore = fs.existsSync(productionDb)
  ? buildSqliteLogicalIntegrityReport({ dbPath: productionDb, store: createReadOnlyPaperStore({ dbPath: productionDb }) })
  : null;
if (fs.existsSync(productionDb)) await copySqliteDatabase({ sourcePath: productionDb, destinationPath: isolatedDb });
for (const relative of ['owner-acceptance', 'operational-proof', 'conformance-proof', 'trust', 'authority-inbox']) {
  const source = path.join(productionRuntimeRoot, relative);
  const target = path.join(isolatedRuntimeRoot, relative);
  if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true, dereference: false });
}
prepareIsolatedRuntimeStore({
  root: defaultPaperAssetRoot(),
  runtimeRoot: isolatedRuntimeRoot,
  dbPath: isolatedDb,
  initialize(store) {
    if (!fs.existsSync(productionDb)) {
      const inserted = store.execute("INSERT OR IGNORE INTO papers(slug,title,canonical_dir,source_dir,status) VALUES('verification_fixture','Verification fixture','verification_fixture','','draft');");
      if (!inserted.ok) throw new Error(inserted.error || 'isolated_verification_fixture_write_failed');
    }
  },
});
const env = {
  ...process.env,
  HEPTA_PAPER_RUNTIME_ROOT: isolatedRuntimeRoot,
  HEPTA_PAPER_RUNTIME_ISOLATED: '1',
  HEPTA_PRODUCTION_RUNTIME_ROOT: productionRuntimeRoot,
  HEPTA_EVIDENCE_ENVIRONMENT: 'verification',
  HEPTA_EVIDENCE_CLASS: 'technical_conformance',
  HEPTA_RELEASE_COMMIT: provenanceBefore.commit || '',
  HEPTA_LEGACY_REFERENCE_PREPARED: '1',
  HEPTA_LEGACY_REFERENCE_ARCHIVE: legacyReference.archivePath,
  PAPER_FACTORY_LEGACY_ROOT: legacyReference.root,
};
const startedAt = new Date().toISOString();
const result = spawnSync('npm', ['run', `${mode}:inner`], {
  cwd: executionWorkspaceRoot,
  env,
  encoding: 'utf8',
  stdio: ['inherit', 'inherit', 'inherit'],
});
const productionLogicalAfter = fs.existsSync(productionDb)
  ? buildSqliteLogicalIntegrityReport({ dbPath: productionDb, store: createReadOnlyPaperStore({ dbPath: productionDb }) })
  : null;
const productionHashAfter = sha(productionDb);
const provenanceAfter = currentVerificationCodeProvenance({
  allowReleaseCommitEnvironment: mode !== 'release',
  selectedWorkspaceRoot: executionWorkspaceRoot,
});
const completedReleaseStateSnapshot = mode === 'release'
  ? assertWorkspaceReleaseReady({
    workspaceRoot: executionWorkspaceRoot,
    expectedSnapshotHash: releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
  })
  : null;
const graphReceiptProjection = productionGraphTracking
  ? Object.freeze({
    version: productionGraphTracking.version,
    kind: productionGraphTracking.kind,
    status: productionGraphTracking.status,
    moduleCount: productionGraphTracking.moduleCount,
    edgeCount: productionGraphTracking.edgeCount,
    trackedModuleCount: productionGraphTracking.trackedModuleCount,
    indexBoundModuleCount: productionGraphTracking.indexBoundModuleCount,
    allProductionModulesTracked: productionGraphTracking.allProductionModulesTracked,
    productionGraphManifestHash: productionGraphTracking.productionGraphManifestHash,
    blockers: Object.freeze([...(productionGraphTracking.blockers || [])]),
  })
  : null;
const capabilityManifest = path.join(
  isolatedRuntimeRoot,
  'audits',
  'capability-verification',
  'CAPABILITY_VERIFICATION_MANIFEST.json',
);
const completedAt = new Date().toISOString();
const capabilityManifestInspection = mode === 'release'
  ? inspectIsolatedVerificationCapabilityManifest({
    capabilityManifestPath: capabilityManifest,
    expectedCodeProvenance: provenanceBefore,
    notAfter: completedAt,
  })
  : null;
const receipt = buildIsolatedVerificationReceipt({
  mode,
  codeProvenance: provenanceBefore,
  completedCodeProvenance: provenanceAfter,
  releaseStateSnapshot,
  completedReleaseStateSnapshot,
  productionGraphTracking: graphReceiptProjection,
  startedAt,
  completedAt,
  exitCode: result.status,
  isolatedStoreHash: sha(isolatedDb),
  productionStoreHashBefore: productionHashBefore,
  productionStoreHashAfter: productionHashAfter,
  productionLogicalHashBefore: productionLogicalBefore?.logicalDatabaseHash || null,
  productionLogicalHashAfter: productionLogicalAfter?.logicalDatabaseHash || null,
  productionLogicalIntegrityStatusBefore: productionLogicalBefore?.status || null,
  productionLogicalIntegrityStatusAfter: productionLogicalAfter?.status || null,
  productionLogicalIntegrityBlockersBefore: productionLogicalBefore?.blockers || [],
  productionLogicalIntegrityBlockersAfter: productionLogicalAfter?.blockers || [],
  blockers: capabilityManifestInspection?.blockers || [],
});
let outputDocument = receipt;
if (mode === 'release') {
  const signature = releaseIntegrityEvidence.signReleasePayload(
    receipt,
    productionRuntimeRoot,
    { allowKeyCreation: false },
  );
  if (!releaseIntegrityEvidence.verifyReleaseIntegritySignature(receipt, signature, {
    pinnedPublicKeyPem: releaseSigningKeyIdentity.publicKeyPem,
    pinnedPublicKeyFingerprint: releaseSigningKeyIdentity.publicKeyFingerprint,
  })) {
    throw new Error('isolated_verification_release_signature_identity_mismatch');
  }
  outputDocument = Object.freeze({ ...receipt, signature });
  const assertPublicationBoundary = () => {
    const current = currentVerificationCodeProvenance({ allowReleaseCommitEnvironment: false });
    if (!isolatedVerificationCodeProvenanceMatches(provenanceBefore, current)) {
      throw new Error('isolated_verification_publication_code_provenance_changed');
    }
    const releaseState = assertWorkspaceReleaseReady({
      workspaceRoot,
      expectedSnapshotHash: releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    });
    if (releaseState.headCommit !== current.commit) {
      throw new Error('isolated_verification_publication_release_state_commit_mismatch');
    }
    const immutableCurrent = currentVerificationCodeProvenance({
      allowReleaseCommitEnvironment: false,
      selectedWorkspaceRoot: executionWorkspaceRoot,
    });
    if (!isolatedVerificationCodeProvenanceMatches(provenanceBefore, immutableCurrent)) {
      throw new Error('isolated_verification_immutable_workspace_provenance_changed');
    }
    assertWorkspaceReleaseReady({
      workspaceRoot: executionWorkspaceRoot,
      expectedSnapshotHash: releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
    });
  };
  publishIsolatedVerificationReceiptArtifacts({
    runtimeRoot: productionRuntimeRoot,
    signedDocument: outputDocument,
    capabilityManifestPath: receipt.status === 'isolated_verification_passed'
      ? capabilityManifest
      : null,
    signCurrentPointer(pointer) {
      return releaseIntegrityEvidence.signReleasePayload(
        pointer,
        productionRuntimeRoot,
        { allowKeyCreation: false },
      );
    },
    beforePublish: assertPublicationBoundary,
    afterPublish: assertPublicationBoundary,
  });
}
process.stdout.write(`${JSON.stringify(outputDocument, null, 2)}\n`);
cleanupLegacyReference();
process.removeListener('exit', cleanupLegacyReference);
if (immutableReleaseWorkspace) {
  cleanupImmutableReleaseWorkspace();
  process.removeListener('exit', cleanupImmutableReleaseWorkspace);
}
if (receipt.status === 'isolated_verification_passed') cleanupIsolatedRuntimeRoot();
else process.stderr.write(`Isolated verification runtime retained: ${isolatedRuntimeRoot}\n`);
if (receipt.status !== 'isolated_verification_passed') {
  process.exitCode = result.status || 1;
}
