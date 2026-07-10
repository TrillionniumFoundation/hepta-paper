import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { defaultPaperAssetRoot } from '../src/workspace-layout.mjs';
import { verifyColdVolumeContract } from '../src/cold-volume-contract.mjs';
import { verifyLegacyDifferentialReference } from '../../migration/legacy-reference-fixture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

export function contentTreeManifest(root, relativeRoots) {
  const rows = [];
  function walk(absolute, relative) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      rows.push({ path: relative, kind: 'symlink', target: fs.readlinkSync(absolute) });
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(absolute, name), path.join(relative, name));
      return;
    }
    if (stat.isFile()) rows.push({ path: relative.replace(/\\/g, '/'), kind: 'file', bytes: stat.size, sha256: sha256File(absolute) });
  }
  for (const relative of [...relativeRoots].sort()) {
    const absolute = path.join(root, relative);
    if (fs.existsSync(absolute)) walk(absolute, relative);
  }
  const payload = rows.map((row) => JSON.stringify(row)).join('\n');
  return {
    version: 1,
    kind: 'ContentTreeManifest',
    root,
    relativeRoots: [...relativeRoots],
    fileCount: rows.filter((row) => row.kind === 'file').length,
    symlinkCount: rows.filter((row) => row.kind === 'symlink').length,
    totalBytes: rows.reduce((sum, row) => sum + Number(row.bytes || 0), 0),
    rows,
    treeHash: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
  };
}

export function ensureReleaseSigningKey(runtimeRoot) {
  const keyRoot = path.join(runtimeRoot, 'release-signing');
  const privatePath = path.join(keyRoot, 'release-integrity-ed25519-private.pem');
  const publicPath = path.join(keyRoot, 'release-integrity-ed25519-public.pem');
  fs.mkdirSync(keyRoot, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o444 });
  }
  fs.chmodSync(privatePath, 0o600);
  fs.chmodSync(publicPath, 0o444);
  return { privatePath, publicPath, publicKeyPem: fs.readFileSync(publicPath, 'utf8') };
}

export function signReleasePayload(payload, runtimeRoot) {
  const key = ensureReleaseSigningKey(runtimeRoot);
  const canonical = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = crypto.sign(null, canonical, fs.readFileSync(key.privatePath)).toString('base64');
  const publicKeyFingerprint = `sha256:${crypto.createHash('sha256').update(key.publicKeyPem).digest('hex')}`;
  return {
    version: 1,
    kind: 'ReleaseIntegritySignature',
    role: 'local_release_integrity',
    algorithm: 'ed25519',
    publicKeyFingerprint,
    publicKeyPem: key.publicKeyPem,
    payloadHash: `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`,
    signature,
    authorityLimit: 'build_and_archive_integrity_only_not_owner_academic_referee_or_submission_authority',
  };
}

export function verifyReleaseIntegritySignature(payload, signature) {
  if (signature?.kind !== 'ReleaseIntegritySignature' || signature?.role !== 'local_release_integrity') return false;
  const canonical = Buffer.from(JSON.stringify(payload), 'utf8');
  const payloadHash = `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
  if (payloadHash !== signature.payloadHash) return false;
  return crypto.verify(null, canonical, signature.publicKeyPem, Buffer.from(signature.signature, 'base64'));
}

export function buildReleaseEvidenceBundle({ runtimeRoot, legacyRoot } = {}) {
  const codeProvenance = currentCodeProvenance();
  const verificationRoot = path.join(runtimeRoot, 'release-evidence', 'verification-receipts');
  const verificationFiles = fs.existsSync(verificationRoot)
    ? fs.readdirSync(verificationRoot).filter((name) => name.endsWith('.json')).sort()
    : [];
  const verificationReceipt = verificationFiles.length
    ? JSON.parse(fs.readFileSync(path.join(verificationRoot, verificationFiles.at(-1)), 'utf8'))
    : null;
  const legacyDb = path.join(legacyRoot, 'paper_factory.sqlite');
  const archiveRoot = path.join(path.dirname(legacyRoot), 'hepta-paper-legacy-reference', codeProvenance.packageVersion);
  const archivePath = path.join(archiveRoot, 'paper-factory-control-plane-reference.tar.gz');
  const archiveReceiptPath = path.join(archiveRoot, 'LEGACY_ARCHIVE_READ_ONLY_RECEIPT.json');
  const immutableReceiptFiles = fs.existsSync(archiveRoot)
    ? fs.readdirSync(archiveRoot).filter((name) => name.startsWith('IMMUTABLE_SNAPSHOT_RECEIPT_') && name.endsWith('.json')).sort()
    : [];
  const immutableReceiptPath = immutableReceiptFiles.length ? path.join(archiveRoot, immutableReceiptFiles.at(-1)) : null;
  const immutableReceipt = immutableReceiptPath ? JSON.parse(fs.readFileSync(immutableReceiptPath, 'utf8')) : null;
  const deletionDrillRoot = path.join(runtimeRoot, 'legacy-retirement', 'deletion-drills');
  const deletionDrillFiles = fs.existsSync(deletionDrillRoot)
    ? fs.readdirSync(deletionDrillRoot).filter((name) => name.endsWith('.json')).sort()
    : [];
  const deletionDrillPath = deletionDrillFiles.length ? path.join(deletionDrillRoot, deletionDrillFiles.at(-1)) : null;
  const deletionDrill = deletionDrillPath ? JSON.parse(fs.readFileSync(deletionDrillPath, 'utf8')) : null;
  const trustStorePath = path.join(runtimeRoot, 'trust', 'AUTHORITY_TRUST_STORE.json');
  const matrixPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'migration', 'legacy-semantic-migration-matrix.json');
  const workspaceRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const coldVolumeContractPath = path.join(workspaceRoot, 'paper-core', 'config', 'cold-volume-contract.v1.json');
  const coldVolumeContract = JSON.parse(fs.readFileSync(coldVolumeContractPath, 'utf8'));
  const coldVolumeStatus = verifyColdVolumeContract({
    assetRoot: defaultPaperAssetRoot(),
    contract: coldVolumeContract,
    contractPath: coldVolumeContractPath,
  });
  const minimalDifferentialFixture = verifyLegacyDifferentialReference();
  const payload = {
    version: 1,
    kind: 'ReleaseEvidenceBundle',
    status: !codeProvenance.treeDirty
      && verificationReceipt?.status === 'isolated_verification_passed'
      && fs.existsSync(archivePath)
      && deletionDrill?.status === 'legacy_reference_restore_drill_passed_deletion_blocked'
      && immutableReceipt?.status === 'legacy_reference_ext4_inode_immutable'
      && coldVolumeStatus.contractValid
      && minimalDifferentialFixture.status === 'legacy_differential_reference_verified'
      ? 'release_evidence_bundle_ready'
      : 'release_evidence_bundle_blocked',
    codeProvenance,
    generatedAt: new Date().toISOString(),
    verificationReceipt,
    bindings: {
      migrationMatrixHash: sha256File(matrixPath),
      legacyDatabaseHash: fs.existsSync(legacyDb) ? sha256File(legacyDb) : null,
      capabilityVerificationManifestHash: (() => {
        const file = path.join(runtimeRoot, 'release-evidence', 'current', 'CAPABILITY_VERIFICATION_MANIFEST.json');
        return fs.existsSync(file) ? sha256File(file) : null;
      })(),
      legacyReferenceArchiveHash: fs.existsSync(archivePath) ? sha256File(archivePath) : null,
      legacyReadOnlyReceiptHash: fs.existsSync(archiveReceiptPath) ? sha256File(archiveReceiptPath) : null,
      deletionRestoreDrillReceiptHash: deletionDrillPath ? sha256File(deletionDrillPath) : null,
      legacyImmutableSnapshotReceiptHash: immutableReceiptPath ? sha256File(immutableReceiptPath) : null,
      minimalLegacyDifferentialFixtureHash: minimalDifferentialFixture.archiveSha256,
      coldVolumeContractHash: coldVolumeStatus.contractHash,
      runtimeHygieneExportHash: (() => {
        const file = path.join(runtimeRoot, 'quarantine', 'pre-v0.5-runtime-evidence', 'CONTAMINATED_RECEIPTS.json');
        return fs.existsSync(file) ? sha256File(file) : null;
      })(),
    },
    authorityStatus: {
      trustStorePresent: fs.existsSync(trustStorePath),
      requiredRoles: ['academic_evidence_authority', 'independent_referee', 'submission_operator', 'live_executor_authorizer'],
      authorityInferredFromReleaseSignature: false,
    },
    retirementStatus: {
      restoreDrillStatus: deletionDrill?.status || 'missing',
      physicalDeletionAllowed: Boolean(deletionDrill?.physicalDeletionAllowed),
      destructiveDeletionPerformed: false,
      immutableSnapshotStatus: immutableReceipt?.status || 'missing',
      immutableContentObjectClaimed: immutableReceipt?.immutableContentObjectClaimed === true,
    },
    assetRecoveryStatus: coldVolumeStatus,
    minimalDifferentialFixture,
    evidenceClasses: {
      technical: 'isolated verification only',
      operational: 'requires production-bound receipts and is not inferred here',
      ownerAcceptance: 'requires an external capability owner signature and is not inferred here',
    },
    externalActionPerformed: false,
  };
  return { ...payload, releaseEvidenceBundleHash: hashRecord('ReleaseEvidenceBundle', payload) };
}

export function writeSignedReleaseEvidence({ runtimeRoot, legacyRoot } = {}) {
  const bundle = buildReleaseEvidenceBundle({ runtimeRoot, legacyRoot });
  const signature = signReleasePayload(bundle, runtimeRoot);
  const root = path.join(runtimeRoot, 'release-evidence', bundle.codeProvenance.packageVersion, bundle.codeProvenance.commit || 'unknown');
  fs.mkdirSync(root, { recursive: true });
  const token = bundle.releaseEvidenceBundleHash.replace(/^sha256:/, '');
  const bundlePath = path.join(root, `RELEASE_EVIDENCE_BUNDLE_${token}.json`);
  const signaturePath = path.join(root, `RELEASE_EVIDENCE_SIGNATURE_${token}.json`);
  fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o444 });
  fs.writeFileSync(signaturePath, `${JSON.stringify(signature, null, 2)}\n`, { mode: 0o444 });
  const signatureVerified = verifyReleaseIntegritySignature(bundle, signature);
  const pointer = {
    version: 1,
    kind: 'CurrentReleaseEvidencePointer',
    packageVersion: bundle.codeProvenance.packageVersion,
    commit: bundle.codeProvenance.commit,
    bundlePath,
    bundleHash: bundle.releaseEvidenceBundleHash,
    signaturePath,
    signatureVerified,
    generatedAt: bundle.generatedAt,
  };
  fs.writeFileSync(path.join(root, 'CURRENT_RELEASE_EVIDENCE.json'), `${JSON.stringify(pointer, null, 2)}\n`);
  return { bundle, signature, signatureVerified, bundlePath, signaturePath, root };
}
