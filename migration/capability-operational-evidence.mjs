import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashRecord } from '../workflow-kernel/record-hash.mjs';
import { currentCodeProvenance } from '../paper-adapters/runtime/code-provenance.mjs';
import {
  capabilityConformanceReceiptHash,
  capabilityConformanceReplayEvidenceHash,
  capabilityConformanceReplayManifestHash,
  capabilityProductionSubject,
  capabilityTargetBindings,
  capabilityVerificationCodeProvenance,
  capabilityVerificationCodeProvenanceHash,
  capabilityVerificationCodeProvenanceMatches,
  loadCapabilityConformanceProofs,
  loadCapabilityOperationalProofs,
  readBoundRegularJson,
  resolveCurrentCapabilityProductionSubject,
  verifyCapabilityConformanceReceipt,
} from './operational-proof-intake.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

export {
  capabilityConformanceReceiptHash,
  capabilityConformanceReplayEvidenceHash,
  capabilityConformanceReplayManifestHash,
  capabilityProductionSubject,
  capabilityTargetBindings,
  capabilityVerificationCodeProvenance,
  capabilityVerificationCodeProvenanceHash,
  resolveCurrentCapabilityProductionSubject,
  verifyCapabilityConformanceReceipt,
};

function hashBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hashFile(file) {
  return hashBytes(fs.readFileSync(file));
}

export function assertProductionCapabilityRefreshCodeProvenance({
  codeProvenance,
  declaredReleaseCommit = null,
} = {}) {
  const selected = capabilityVerificationCodeProvenance(codeProvenance);
  if (selected.treeDirty) {
    throw new Error('production_capability_refresh_clean_commit_required');
  }
  if (declaredReleaseCommit !== null
    && declaredReleaseCommit !== undefined
    && String(declaredReleaseCommit) !== selected.commit) {
    throw new Error('production_capability_refresh_release_commit_mismatch');
  }
  return selected;
}

export function assertCapabilityVerificationCodeProvenanceUnchanged({
  expected,
  actual,
  phase = 'postflight',
  requireClean = true,
} = {}) {
  const selectedExpected = requireClean
    ? assertProductionCapabilityRefreshCodeProvenance({ codeProvenance: expected })
    : capabilityVerificationCodeProvenance(expected);
  let selectedActual;
  try {
    selectedActual = requireClean
      ? assertProductionCapabilityRefreshCodeProvenance({
        codeProvenance: actual,
        declaredReleaseCommit: selectedExpected.commit,
      })
      : capabilityVerificationCodeProvenance(actual);
  } catch (error) {
    throw new Error(
      `capability_verification_code_provenance_changed:${phase}:${error.message}`,
    );
  }
  if (!capabilityVerificationCodeProvenanceMatches(selectedExpected, selectedActual)) {
    throw new Error(`capability_verification_code_provenance_changed:${phase}`);
  }
  return selectedActual;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function assertDirectoryIdentity(directory, expected, errorCode) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, expected)) {
    throw new Error(errorCode);
  }
  return stat;
}

function ensureDirectoryTreeNoSymlink(scopeRoot, directory) {
  const selectedRoot = path.resolve(scopeRoot);
  const selected = path.resolve(directory);
  const relative = path.relative(selectedRoot, selected);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('capability_replay_directory_outside_scope');
  }
  let cursor = selectedRoot;
  let stat = fs.lstatSync(cursor);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`capability_replay_directory_unsafe:${cursor}`);
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        fs.mkdirSync(cursor, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(cursor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`capability_replay_directory_unsafe:${cursor}`);
    }
  }
  return stat;
}

function artifactRelativePath(value) {
  const selected = String(value || '');
  if (!selected
    || selected.includes('\\')
    || path.posix.isAbsolute(selected)
    || path.posix.normalize(selected) !== selected
    || selected.startsWith('../')
    || selected === '.rollback'
    || selected.startsWith('.rollback/')) {
    throw new Error('capability_replay_artifact_path_invalid');
  }
  return selected;
}

function fsyncDirectory(directory, expectedIdentity = null) {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | NO_FOLLOW,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory()
      || (expectedIdentity && !sameIdentity(stat, expectedIdentity))) {
      throw new Error('capability_replay_directory_identity_changed');
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function createCapabilityReplayArtifactPublisher({
  runtimeRoot,
  publicationId = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`,
} = {}) {
  if (typeof runtimeRoot !== 'string'
    || !runtimeRoot
    || typeof publicationId !== 'string'
    || !/^[A-Za-z0-9._-]+$/.test(publicationId)
    || publicationId === '.'
    || publicationId === '..') {
    throw new Error('capability_replay_publication_configuration_invalid');
  }
  const selectedRuntimeRoot = path.resolve(runtimeRoot);
  const runtimeIdentity = ensureDirectoryTreeNoSymlink(selectedRuntimeRoot, selectedRuntimeRoot);
  const proofRoot = path.join(selectedRuntimeRoot, 'conformance-proof');
  const proofRootIdentity = ensureDirectoryTreeNoSymlink(selectedRuntimeRoot, proofRoot);
  const stagingParent = path.join(proofRoot, '.publication-staging');
  const stagingParentIdentity = ensureDirectoryTreeNoSymlink(proofRoot, stagingParent);
  const stagingRoot = path.join(stagingParent, publicationId);
  try {
    fs.mkdirSync(stagingRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('capability_replay_publication_id_conflict');
    }
    throw error;
  }
  const stagingRootIdentity = fs.lstatSync(stagingRoot);
  if (!stagingRootIdentity.isDirectory() || stagingRootIdentity.isSymbolicLink()) {
    throw new Error('capability_replay_staging_root_unsafe');
  }
  const rollbackRoot = path.join(stagingRoot, '.rollback');
  fs.mkdirSync(rollbackRoot, { mode: 0o700 });
  const rollbackRootIdentity = fs.lstatSync(rollbackRoot);
  if (!rollbackRootIdentity.isDirectory() || rollbackRootIdentity.isSymbolicLink()) {
    throw new Error('capability_replay_rollback_root_unsafe');
  }
  const staged = new Map();
  let closed = false;

  function assertPublisherRoots() {
    assertDirectoryIdentity(
      selectedRuntimeRoot,
      runtimeIdentity,
      'capability_replay_runtime_root_identity_changed',
    );
    assertDirectoryIdentity(
      proofRoot,
      proofRootIdentity,
      'capability_replay_proof_root_identity_changed',
    );
    assertDirectoryIdentity(
      stagingParent,
      stagingParentIdentity,
      'capability_replay_staging_parent_identity_changed',
    );
    assertDirectoryIdentity(
      stagingRoot,
      stagingRootIdentity,
      'capability_replay_staging_root_identity_changed',
    );
    assertDirectoryIdentity(
      rollbackRoot,
      rollbackRootIdentity,
      'capability_replay_rollback_root_identity_changed',
    );
  }

  function discard() {
    if (closed) return;
    assertPublisherRoots();
    const cleanupContainer = fs.mkdtempSync(
      path.join(stagingParent, `.discard-${publicationId}-`),
    );
    fs.chmodSync(cleanupContainer, 0o700);
    const cleanupContainerIdentity = fs.lstatSync(cleanupContainer);
    const cleanupRoot = path.join(cleanupContainer, 'owned');
    let moved = false;
    try {
      assertDirectoryIdentity(
        stagingParent,
        stagingParentIdentity,
        'capability_replay_staging_parent_identity_changed',
      );
      fs.renameSync(stagingRoot, cleanupRoot);
      moved = true;
      closed = true;
      fsyncDirectory(stagingParent, stagingParentIdentity);
      fsyncDirectory(cleanupContainer, cleanupContainerIdentity);
      const movedIdentity = fs.lstatSync(cleanupRoot);
      if (!movedIdentity.isDirectory()
        || movedIdentity.isSymbolicLink()
        || !sameIdentity(movedIdentity, stagingRootIdentity)) {
        const error = new Error('capability_replay_staging_root_identity_changed');
        error.quarantinedPath = cleanupRoot;
        throw error;
      }
      fs.rmSync(cleanupRoot, { recursive: true, force: false });
      fs.rmdirSync(cleanupContainer);
      fsyncDirectory(stagingParent, stagingParentIdentity);
    } catch (error) {
      if (!moved) {
        try {
          assertDirectoryIdentity(
            cleanupContainer,
            cleanupContainerIdentity,
            'capability_replay_cleanup_container_identity_changed',
          );
          fs.rmdirSync(cleanupContainer);
          fsyncDirectory(stagingParent, stagingParentIdentity);
        } catch {
          // An uncertain cleanup container is preserved rather than recursively deleted.
        }
      }
      throw error;
    }
  }

  function assertArtifactContent(entry, candidatePath, prefix) {
    let descriptor;
    try {
      descriptor = fs.openSync(candidatePath, fs.constants.O_RDONLY | NO_FOLLOW);
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (!before.isFile()
        || !sameIdentity(before, entry.identity)
        || Number(before.mode & 0o777n) !== 0o400) {
        throw new Error(`${prefix}_identity_changed:${entry.relative}`);
      }
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor, { bigint: true });
      const pathIdentity = fs.lstatSync(candidatePath, { bigint: true });
      if (!after.isFile()
        || !pathIdentity.isFile()
        || pathIdentity.isSymbolicLink()
        || !sameIdentity(before, after)
        || !sameIdentity(after, pathIdentity)
        || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs
        || BigInt(bytes.length) !== after.size) {
        throw new Error(`${prefix}_identity_changed:${entry.relative}`);
      }
      if (bytes.length !== entry.bytes || hashBytes(bytes) !== entry.contentHash) {
        throw new Error(`${prefix}_content_changed:${entry.relative}`);
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  function rollbackPublishedArtifact(entry, finalDirectoryIdentity) {
    const quarantinePath = path.join(
      rollbackRoot,
      `${crypto.randomBytes(16).toString('hex')}.artifact`,
    );
    try {
      fs.renameSync(entry.finalPath, quarantinePath);
    } catch (error) {
      return error?.code === 'ENOENT';
    }
    const finalDirectory = path.dirname(entry.finalPath);
    const movedIdentity = fs.lstatSync(quarantinePath, { bigint: true });
    if (sameIdentity(movedIdentity, entry.identity)) {
      fsyncDirectory(finalDirectory, finalDirectoryIdentity);
      fsyncDirectory(rollbackRoot, rollbackRootIdentity);
      fs.unlinkSync(quarantinePath);
      fsyncDirectory(rollbackRoot, rollbackRootIdentity);
      return true;
    }
    try {
      fs.linkSync(quarantinePath, entry.finalPath);
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    const restoredIdentity = fs.lstatSync(entry.finalPath, { bigint: true });
    if (!sameIdentity(restoredIdentity, movedIdentity)) return false;
    fsyncDirectory(finalDirectory, finalDirectoryIdentity);
    fs.unlinkSync(quarantinePath);
    fsyncDirectory(rollbackRoot, rollbackRootIdentity);
    return true;
  }

  function stageJson(relativePath, value) {
    if (closed) throw new Error('capability_replay_publication_closed');
    const relative = artifactRelativePath(relativePath);
    if (staged.has(relative)) throw new Error('capability_replay_artifact_already_staged');
    const stagingPath = path.join(stagingRoot, ...relative.split('/'));
    const finalPath = path.join(proofRoot, ...relative.split('/'));
    assertPublisherRoots();
    const stagingDirectory = path.dirname(stagingPath);
    const stagingDirectoryIdentity = ensureDirectoryTreeNoSymlink(
      stagingRoot,
      stagingDirectory,
    );
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    const contentHash = hashBytes(bytes);
    const descriptor = fs.openSync(
      stagingPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    let identity;
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.fchmodSync(descriptor, 0o400);
      fs.fsyncSync(descriptor);
      identity = fs.fstatSync(descriptor, { bigint: true });
    } finally {
      fs.closeSync(descriptor);
    }
    assertDirectoryIdentity(
      stagingDirectory,
      stagingDirectoryIdentity,
      'capability_replay_staging_directory_identity_changed',
    );
    const pathIdentity = fs.lstatSync(stagingPath, { bigint: true });
    if (!identity.isFile()
      || !pathIdentity.isFile()
      || pathIdentity.isSymbolicLink()
      || !sameIdentity(identity, pathIdentity)
      || identity.size !== BigInt(bytes.length)
      || Number(identity.mode & 0o777n) !== 0o400) {
      throw new Error('capability_replay_staging_artifact_unsafe');
    }
    staged.set(relative, Object.freeze({
      relative,
      stagingPath,
      finalPath,
      identity,
      bytes: bytes.length,
      contentHash,
    }));
    return Object.freeze({
      relativePath: relative,
      runtimeRelativePath: `conformance-proof/${relative}`,
      bytes: bytes.length,
      contentHash,
    });
  }

  async function publish({
    relativePaths = [...staged.keys()],
    beforePublish = null,
    afterPublish = null,
  } = {}) {
    if (closed) throw new Error('capability_replay_publication_closed');
    const selected = relativePaths.map((relative) => staged.get(artifactRelativePath(relative)));
    if (selected.some((entry) => !entry)
      || new Set(relativePaths).size !== relativePaths.length
      || selected.length !== staged.size) {
      throw new Error('capability_replay_publication_set_mismatch');
    }
    assertPublisherRoots();
    const finalDirectoryIdentities = new Map();
    for (const entry of selected) {
      assertArtifactContent(entry, entry.stagingPath, 'capability_replay_staging_artifact');
      const finalDirectory = path.dirname(entry.finalPath);
      const finalDirectoryIdentity = ensureDirectoryTreeNoSymlink(proofRoot, finalDirectory);
      finalDirectoryIdentities.set(finalDirectory, finalDirectoryIdentity);
      try {
        fs.lstatSync(entry.finalPath);
        throw new Error(`capability_replay_no_clobber_conflict:${entry.relative}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const published = [];
    try {
      if (beforePublish) await beforePublish();
      for (const entry of selected) {
        assertPublisherRoots();
        assertArtifactContent(entry, entry.stagingPath, 'capability_replay_staging_artifact');
        const finalDirectory = path.dirname(entry.finalPath);
        const finalDirectoryIdentity = finalDirectoryIdentities.get(finalDirectory);
        assertDirectoryIdentity(
          finalDirectory,
          finalDirectoryIdentity,
          'capability_replay_final_directory_identity_changed',
        );
        try {
          fs.linkSync(entry.stagingPath, entry.finalPath);
        } catch (error) {
          if (error?.code === 'EEXIST') {
            throw new Error(`capability_replay_no_clobber_conflict:${entry.relative}`);
          }
          throw error;
        }
        published.push(entry);
        assertArtifactContent(entry, entry.finalPath, 'capability_replay_published_artifact');
        fsyncDirectory(finalDirectory, finalDirectoryIdentity);
      }
      if (afterPublish) await afterPublish();
      assertPublisherRoots();
      for (const entry of selected) {
        assertArtifactContent(entry, entry.finalPath, 'capability_replay_published_artifact');
      }
    } catch (error) {
      const rollbackIncomplete = [];
      for (const entry of [...published].reverse()) {
        try {
          const rolledBack = rollbackPublishedArtifact(
            entry,
            finalDirectoryIdentities.get(path.dirname(entry.finalPath)),
          );
          if (!rolledBack) rollbackIncomplete.push(entry.relative);
        } catch (rollbackError) {
          rollbackIncomplete.push(entry.relative);
        }
      }
      if (rollbackIncomplete.length) {
        throw new Error(
          `capability_replay_publication_rollback_incomplete:${rollbackIncomplete.join(',')}:${error.message}`,
        );
      }
      discard();
      throw error;
    }
    const publishedPaths = selected.map((entry) => entry.finalPath);
    discard();
    return Object.freeze({
      version: 2,
      kind: 'CapabilityReplayArtifactPublicationReceipt',
      status: 'capability_replay_artifacts_published',
      atomicNoClobber: true,
      artifactCount: publishedPaths.length,
      publishedPaths: Object.freeze(publishedPaths),
    });
  }

  return Object.freeze({
    version: 2,
    kind: 'CapabilityReplayArtifactPublisher',
    proofRoot,
    stagingRoot,
    stageJson,
    publish,
    discard,
  });
}

export function capabilityEvidencePath(runtimeRoot) {
  return path.join(path.resolve(runtimeRoot), 'audits', 'capability-verification', 'CAPABILITY_VERIFICATION_MANIFEST.json');
}

export function validateCapabilityOperationalEvidence({
  runtimeRoot,
  evidence = null,
  codeProvenance = currentCodeProvenance({ allowReleaseCommitEnvironment: false }),
} = {}) {
  let manifest = evidence;
  if (!manifest && runtimeRoot) {
    const candidates = [capabilityEvidencePath(runtimeRoot)];
    for (const candidate of candidates) {
      try {
        manifest = readBoundRegularJson(runtimeRoot, candidate);
        if (manifest?.kind === 'CapabilityVerificationManifest') break;
      } catch { manifest = null; }
    }
  }
  const receipts = new Map();
  if (manifest?.kind !== 'CapabilityVerificationManifest' || manifest?.version !== 2) return receipts;
  let currentProvenance;
  let manifestProvenance;
  try {
    currentProvenance = capabilityVerificationCodeProvenance(codeProvenance);
    manifestProvenance = capabilityVerificationCodeProvenance(
      manifest.codeProvenance,
      { exact: true },
    );
    if (!capabilityVerificationCodeProvenanceMatches(currentProvenance, manifestProvenance)
      || manifest.codeProvenanceHash
        !== capabilityVerificationCodeProvenanceHash(manifestProvenance)) return receipts;
    const {
      capabilityVerificationManifestHash: claimedManifestHash,
      ...manifestPayload
    } = manifest;
    if (!claimedManifestHash
      || hashRecord('CapabilityVerificationManifest', manifestPayload)
        !== claimedManifestHash) return receipts;
  } catch {
    return receipts;
  }
  for (const receipt of manifest.receipts || []) {
    if (receipt?.version !== 2 || receipt?.kind !== 'CapabilityVerificationReceipt') continue;
    const { capabilityVerificationReceiptHash: claimedHash, ledgerReceiptId, ...payload } = receipt;
    if (!claimedHash || hashRecord('CapabilityVerificationReceipt', payload) !== claimedHash) continue;
    try {
      const receiptProvenance = capabilityVerificationCodeProvenance(
        receipt.codeProvenance,
        { exact: true },
      );
      if (!capabilityVerificationCodeProvenanceMatches(receiptProvenance, manifestProvenance)
        || receipt.codeProvenanceHash
          !== capabilityVerificationCodeProvenanceHash(receiptProvenance)) continue;
    } catch { continue; }
    const testFile = path.join(workspaceRoot, receipt.test?.path || '');
    if (!fs.existsSync(testFile) || hashFile(testFile) !== receipt.test?.sha256) continue;
    const targetsValid = (receipt.targets || []).length > 0 && receipt.targets.every((target) => {
      const targetFile = path.join(workspaceRoot, target.path || '');
      return fs.existsSync(targetFile) && hashFile(targetFile) === target.sha256;
    });
    if (!targetsValid || receipt.status !== 'capability_implementation_verified' || receipt.test?.result !== 'passed') continue;
    receipts.set(receipt.capabilityId, Object.freeze({ ...receipt, ledgerReceiptId }));
  }
  return receipts;
}

export async function executeCapabilityVerification({
  runtimeRoot,
  receiptLedger,
  artifactRepositoryFactory,
  clock,
  capabilityCatalog,
  codeProvenance = currentCodeProvenance({ allowReleaseCommitEnvironment: false }),
  codeProvenanceProvider = () => currentCodeProvenance({
    allowReleaseCommitEnvironment: false,
  }),
  requireCleanCodeProvenance = false,
} = {}) {
  if (!runtimeRoot || !receiptLedger || !artifactRepositoryFactory || !clock || !capabilityCatalog) {
    throw new Error('Capability verification requires runtimeRoot, receiptLedger, artifactRepositoryFactory, clock and capabilityCatalog');
  }
  const selectedCodeProvenance = requireCleanCodeProvenance
    ? assertProductionCapabilityRefreshCodeProvenance({ codeProvenance })
    : capabilityVerificationCodeProvenance(codeProvenance);
  assertCapabilityVerificationCodeProvenanceUnchanged({
    expected: selectedCodeProvenance,
    actual: codeProvenanceProvider(),
    phase: 'preflight',
    requireClean: requireCleanCodeProvenance,
  });
  const codeProvenanceHash = capabilityVerificationCodeProvenanceHash(selectedCodeProvenance);
  const operationalProofs = loadCapabilityOperationalProofs({
    runtimeRoot,
    workspaceRoot,
    capabilityCatalog,
    releaseCommit: selectedCodeProvenance.commit,
  });
  const conformanceProofs = loadCapabilityConformanceProofs({
    runtimeRoot,
    workspaceRoot,
    capabilityCatalog,
    releaseCommit: selectedCodeProvenance.commit,
    codeProvenance: selectedCodeProvenance,
  });
  const receiptPayloads = [];
  for (const capabilityId of Object.keys(capabilityCatalog).sort()) {
    const catalog = capabilityCatalog[capabilityId];
    const testPath = `migration/tests/capabilities/${capabilityId}.test.mjs`;
    const testFile = path.join(workspaceRoot, testPath);
    const targetFile = path.join(workspaceRoot, catalog.target);
    const result = spawnSync(process.execPath, ['--test', testFile], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, HEPTA_CAPABILITY_VERIFICATION: '1' },
    });
    const operational = operationalProofs.get(capabilityId);
    const conformance = conformanceProofs.get(capabilityId);
    const payload = {
      version: 2,
      kind: 'CapabilityVerificationReceipt',
      capabilityId,
      status: result.status === 0 && !result.error
        ? 'capability_implementation_verified'
        : 'capability_implementation_blocked',
      executedAt: clock.nowIso(),
      test: {
        path: testPath,
        sha256: hashFile(testFile),
        result: result.status === 0 && !result.error ? 'passed' : 'failed',
        exitCode: result.status,
        stdoutHash: hashBytes(String(result.stdout || '')),
        stderrHash: hashBytes(String(result.stderr || result.error?.message || '')),
      },
      targets: [{ path: catalog.target, sha256: hashFile(targetFile) }],
      executionClass: 'release_capability_conformance',
      conformanceProof: Boolean(conformance?.conformanceReceiptHashes?.length),
      conformanceReceiptHashes: conformance?.conformanceReceiptHashes || [],
      conformanceIssuerAssurances: conformance?.issuerAssurances || [],
      operationalProof: Boolean(operational?.operationalReceiptHashes?.length),
      operationalReceiptHashes: operational?.operationalReceiptHashes || [],
      externalActionPerformed: false,
      codeProvenance: selectedCodeProvenance,
      codeProvenanceHash,
    };
    const capabilityVerificationReceiptHash = hashRecord('CapabilityVerificationReceipt', payload);
    receiptPayloads.push({ ...payload, capabilityVerificationReceiptHash });
  }
  assertCapabilityVerificationCodeProvenanceUnchanged({
    expected: selectedCodeProvenance,
    actual: codeProvenanceProvider(),
    phase: 'postflight',
    requireClean: requireCleanCodeProvenance,
  });
  const receipts = receiptPayloads.map((receipt) => {
    const ledger = receiptLedger.record(receipt, { stream: 'capability-verification' });
    return { ...receipt, ledgerReceiptId: ledger.receiptId };
  });
  const manifestPayload = {
    version: 2,
    kind: 'CapabilityVerificationManifest',
    status: receipts.every((receipt) => receipt.status === 'capability_implementation_verified')
      ? 'capability_verification_complete'
      : 'capability_verification_blocked',
    generatedAt: clock.nowIso(),
    capabilityCount: receipts.length,
    passedCount: receipts.filter((receipt) => receipt.status === 'capability_implementation_verified').length,
    codeProvenance: selectedCodeProvenance,
    codeProvenanceHash,
    receipts,
  };
  const manifest = {
    ...manifestPayload,
    capabilityVerificationManifestHash: hashRecord('CapabilityVerificationManifest', manifestPayload),
  };
  assertCapabilityVerificationCodeProvenanceUnchanged({
    expected: selectedCodeProvenance,
    actual: codeProvenanceProvider(),
    phase: 'publication',
    requireClean: requireCleanCodeProvenance,
  });
  const target = capabilityEvidencePath(runtimeRoot);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const repository = artifactRepositoryFactory(path.dirname(target));
  const writeReceipt = await repository.writeJson(target, manifest, {
    role: 'capability_verification_manifest',
    atomic: true,
  });
  return { manifest, writeReceipt };
}
