import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertPinnedDirectoryChain,
  compareSemanticReleaseVersions,
  drillOffhostWormRestore,
  ensurePinnedChildDirectory,
  isSemanticReleaseVersion,
  openPinnedDirectory,
  publishManifestNoClobber,
  publishSnapshotObject,
  removePinnedChildExact,
} from './offhost-worm-security-repository.mjs';
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RELEASE_COMMIT = /^[a-f0-9]{40}$/;
const MAXIMUM_RELEASE_DOCUMENT_BYTES = 16 * 1024 * 1024;
const RELEASE_SIGNATURE_AUTHORITY_LIMIT =
  'build_and_archive_integrity_only_not_owner_academic_referee_or_submission_authority';
const POINTER_KEYS = Object.freeze([
  'bundleHash', 'bundlePath', 'commit', 'currentReleaseEvidencePointerHash', 'generatedAt',
  'kind', 'packageVersion', 'releaseEvidenceInputSnapshotHash', 'releaseStateSnapshotHash',
  'signaturePath', 'signatureVerified', 'version',
]);
const SIGNATURE_KEYS = Object.freeze([
  'algorithm', 'authorityLimit', 'kind', 'payloadHash', 'publicKeyFingerprint', 'publicKeyPem',
  'role', 'signature', 'version',
]);
const BUNDLE_KEYS = Object.freeze([
  'assetRecoveryStatus', 'authorityStatus', 'bindings', 'capabilityManifestEvidence', 'codeProvenance',
  'deletionDrillEvidence', 'disasterRecoveryStatus', 'evidenceClasses', 'externalActionPerformed',
  'generatedAt', 'immutableMatrixReference', 'kind', 'minimalDifferentialFixture',
  'productionStoreLogicalIntegrity', 'releaseEvidenceBundleHash', 'releaseProfile',
  'releaseStateSnapshot', 'releaseStateSnapshotHash', 'retirementStatus', 'status', 'trustLayers',
  'verificationReceipt', 'verificationReceiptEvidence', 'version',
]);
function exactKeys(value, expected) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
function stableFileIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    nlink: String(stat.nlink), size: String(stat.size), uid: String(stat.uid),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
  });
}
function directoryIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}
function sameIdentity(left, right) {
  return Boolean(left && right
    && Object.keys(left).every((key) => left[key] === right[key]));
}
function assertSafeDirectory(candidate, errorCode) {
  const selected = path.resolve(candidate);
  let stat;
  try { stat = fs.lstatSync(selected, { bigint: true }); } catch { throw new Error(errorCode); }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || fs.realpathSync(selected) !== selected) throw new Error(errorCode);
  let descriptor;
  try {
    descriptor = fs.openSync(
      selected,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | NO_FOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory()
      || !sameIdentity(directoryIdentity(stat), directoryIdentity(opened))) {
      throw new Error(errorCode);
    }
    return Object.freeze({ path: selected, identity: directoryIdentity(opened) });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
function assertDirectoryUnchanged(snapshot, errorCode) {
  const current = assertSafeDirectory(snapshot.path, errorCode);
  if (!sameIdentity(snapshot.identity, current.identity)) throw new Error(errorCode);
}
function openPinnedRegularFile(candidate, {
  errorCode = 'offhost_worm_source_unsafe',
  expectedIdentity = null,
  maximumBytes = null,
  readOnly = false,
} = {}) {
  const selected = path.resolve(candidate);
  let before;
  try { before = fs.lstatSync(selected, { bigint: true }); } catch { throw new Error(errorCode); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || (maximumBytes !== null && (before.size < 2n || before.size > BigInt(maximumBytes)))
    || (readOnly && (before.mode & 0o222n) !== 0n)) throw new Error(errorCode);
  let descriptor;
  try {
    descriptor = fs.openSync(selected, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const identity = stableFileIdentity(opened);
    if (!opened.isFile()
      || !sameIdentity(stableFileIdentity(before), identity)
      || (expectedIdentity && !sameIdentity(expectedIdentity, identity))) throw new Error(errorCode);
    return Object.freeze({ descriptor, path: selected, identity });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}
function assertPinnedPathUnchanged(pinned, errorCode) {
  let pathStat;
  try { pathStat = fs.lstatSync(pinned.path, { bigint: true }); } catch { throw new Error(errorCode); }
  const descriptorStat = fs.fstatSync(pinned.descriptor, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()
    || !sameIdentity(pinned.identity, stableFileIdentity(descriptorStat))
    || !sameIdentity(pinned.identity, stableFileIdentity(pathStat))) throw new Error(errorCode);
}
function readPinnedBytes(candidate, options = {}) {
  const pinned = openPinnedRegularFile(candidate, options);
  try {
    const bytes = fs.readFileSync(pinned.descriptor);
    if (String(bytes.length) !== pinned.identity.size) throw new Error(options.errorCode);
    assertPinnedPathUnchanged(pinned, options.errorCode);
    return Object.freeze({
      path: pinned.path,
      identity: pinned.identity,
      bytes,
      sha256: hashBytes(bytes),
    });
  } finally { fs.closeSync(pinned.descriptor); }
}
function parseCapturedJson(capture, errorCode) {
  try {
    const value = JSON.parse(capture.bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(errorCode);
    return value;
  } catch { throw new Error(errorCode); }
}
function filesystemImmutable(file) {
  const probe = spawnSync('lsattr', ['-d', file], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  const attributes = String(probe.stdout || '').trim().split(/\s+/, 1)[0] || '';
  return attributes.includes('i');
}
function selectionResult(status, { blockers = [], ...details } = {}) {
  return Object.freeze({
    version: 2,
    kind: 'VerifiedReleaseEvidenceSelection',
    status,
    ...details,
    sources: Object.freeze(details.sources || []),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
function captureAsSource(role, capture) {
  return Object.freeze({
    role,
    path: capture.path,
    sha256: capture.sha256,
    bytes: capture.bytes.length,
    identity: capture.identity,
    capturedBytesBase64: capture.bytes.toString('base64'),
  });
}
function assertCaptureCurrent(capture, errorCode) {
  let current;
  try { current = fs.lstatSync(capture.path, { bigint: true }); } catch { throw new Error(errorCode); }
  if (!current.isFile() || current.isSymbolicLink()
    || !sameIdentity(capture.identity, stableFileIdentity(current))) throw new Error(errorCode);
}
function loadPinnedReleasePublicKey(runtimeRoot) {
  const runtime = assertSafeDirectory(runtimeRoot, 'offhost_release_runtime_root_unsafe');
  const runtimeStat = fs.lstatSync(runtime.path, { bigint: true });
  const keyRootPath = path.join(runtime.path, 'release-signing');
  const keyRoot = assertSafeDirectory(keyRootPath, 'offhost_release_signing_root_unsafe');
  const keyRootStat = fs.lstatSync(keyRoot.path, { bigint: true });
  if ((keyRootStat.mode & 0o7777n) !== 0o700n || keyRootStat.uid !== runtimeStat.uid
    || JSON.stringify(fs.readdirSync(keyRoot.path).sort()) !== JSON.stringify([
      'release-integrity-ed25519-private.pem',
      'release-integrity-ed25519-public.pem',
    ])) throw new Error('offhost_release_signing_root_unsafe');
  const privateStat = fs.lstatSync(
    path.join(keyRoot.path, 'release-integrity-ed25519-private.pem'),
    { bigint: true },
  );
  if (!privateStat.isFile() || privateStat.isSymbolicLink() || privateStat.nlink !== 1n
    || privateStat.uid !== runtimeStat.uid || (privateStat.mode & 0o7777n) !== 0o600n) {
    throw new Error('offhost_release_signing_key_pair_unsafe');
  }
  const capture = readPinnedBytes(
    path.join(keyRoot.path, 'release-integrity-ed25519-public.pem'),
    {
      errorCode: 'offhost_release_public_key_unsafe',
      maximumBytes: 16 * 1024,
      readOnly: true,
    },
  );
  if (capture.identity.uid !== String(runtimeStat.uid)
    || ![0o400n, 0o444n].includes(BigInt(capture.identity.mode) & 0o7777n)) {
    throw new Error('offhost_release_public_key_unsafe');
  }
  const publicKeyPem = capture.bytes.toString('utf8');
  const publicKey = crypto.createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('offhost_release_public_key_invalid');
  }
  return Object.freeze({
    runtime,
    keyRoot,
    capture,
    publicKey,
    publicKeyPem,
    publicKeyFingerprint: hashBytes(publicKeyPem),
  });
}
function verifyReleaseSignature(bundle, signature, pinnedKey) {
  if (!exactKeys(signature, SIGNATURE_KEYS)
    || signature.version !== 1
    || signature.kind !== 'ReleaseIntegritySignature'
    || signature.role !== 'local_release_integrity'
    || signature.algorithm !== 'ed25519'
    || signature.authorityLimit !== RELEASE_SIGNATURE_AUTHORITY_LIMIT
    || signature.publicKeyPem !== pinnedKey.publicKeyPem
    || signature.publicKeyFingerprint !== pinnedKey.publicKeyFingerprint
    || !SHA256.test(String(signature.payloadHash || ''))
    || typeof signature.signature !== 'string') return false;
  const canonical = Buffer.from(JSON.stringify(bundle), 'utf8');
  const signatureBytes = Buffer.from(signature.signature, 'base64');
  return signature.payloadHash === hashBytes(canonical)
    && signatureBytes.length === 64
    && signatureBytes.toString('base64') === signature.signature
    && crypto.verify(null, canonical, pinnedKey.publicKey, signatureBytes);
}
function bundleReadyAndBound(bundle, { version, commit, pointer }) {
  if (!exactKeys(bundle, BUNDLE_KEYS)
    || bundle.version !== 2
    || bundle.kind !== 'ReleaseEvidenceBundle'
    || bundle.status !== 'code_release_evidence_ready'
    || bundle.releaseProfile !== 'code_release'
    || bundle.externalActionPerformed !== false
    || !SHA256.test(String(bundle.releaseEvidenceBundleHash || ''))
    || bundle.releaseEvidenceBundleHash !== pointer.bundleHash
    || bundle.generatedAt !== pointer.generatedAt
    || bundle.releaseStateSnapshotHash !== pointer.releaseStateSnapshotHash
    || !SHA256.test(String(bundle.bindings?.releaseEvidenceInputSnapshotHash || ''))
    || bundle.bindings.releaseEvidenceInputSnapshotHash
      !== pointer.releaseEvidenceInputSnapshotHash
    || bundle.codeProvenance?.version !== 2
    || bundle.codeProvenance?.kind !== 'CodeProvenance'
    || bundle.codeProvenance?.packageVersion !== version
    || bundle.codeProvenance?.commit !== commit
    || bundle.codeProvenance?.treeDirty !== false
    || bundle.codeProvenance?.evidenceEnvironment !== 'administrative'
    || bundle.codeProvenance?.evidenceClass !== 'release_attestation') return false;
  const { releaseEvidenceBundleHash: _bundleHash, ...payload } = bundle;
  if (hashRecord('ReleaseEvidenceBundle', payload) !== bundle.releaseEvidenceBundleHash) {
    return false;
  }
  const snapshot = bundle.releaseStateSnapshot;
  if (snapshot?.version !== 2
    || snapshot?.kind !== 'WorkspaceReleaseStateSnapshot'
    || snapshot?.status !== 'workspace_release_state_release_ready'
    || snapshot?.headCommit !== commit
    || snapshot?.releaseState?.ok !== true
    || snapshot?.releaseState?.state !== 'release_ready'
    || snapshot?.workspaceReleaseStateSnapshotHash !== bundle.releaseStateSnapshotHash) {
    return false;
  }
  const { workspaceReleaseStateSnapshotHash: _snapshotHash, ...snapshotPayload } = snapshot;
  return hashBytes(JSON.stringify(snapshotPayload)) === snapshot.workspaceReleaseStateSnapshotHash;
}
function validateReleaseCandidate({ runtimeRoot, version, commit, pinnedKey }) {
  if (!RELEASE_COMMIT.test(commit)) throw new Error('offhost_release_commit_invalid');
  const commitRoot = assertSafeDirectory(
    path.join(runtimeRoot, 'release-evidence', version, commit),
    'offhost_release_commit_root_unsafe',
  );
  const pointerCapture = readPinnedBytes(
    path.join(commitRoot.path, 'CURRENT_RELEASE_EVIDENCE.json'),
    {
      errorCode: 'offhost_release_pointer_unsafe',
      maximumBytes: MAXIMUM_RELEASE_DOCUMENT_BYTES,
      readOnly: true,
    },
  );
  const pointer = parseCapturedJson(pointerCapture, 'offhost_release_pointer_invalid');
  if (!exactKeys(pointer, POINTER_KEYS)
    || pointer.version !== 2
    || pointer.kind !== 'CurrentReleaseEvidencePointer'
    || pointer.packageVersion !== version
    || pointer.commit !== commit
    || pointer.signatureVerified !== true
    || !SHA256.test(String(pointer.bundleHash || ''))
    || !SHA256.test(String(pointer.releaseEvidenceInputSnapshotHash || ''))
    || !SHA256.test(String(pointer.releaseStateSnapshotHash || ''))
    || !SHA256.test(String(pointer.currentReleaseEvidencePointerHash || ''))
    || !Number.isFinite(Date.parse(String(pointer.generatedAt || '')))) {
    throw new Error('offhost_release_pointer_invalid');
  }
  const { currentReleaseEvidencePointerHash: _pointerHash, ...pointerPayload } = pointer;
  if (hashRecord('CurrentReleaseEvidencePointer', pointerPayload)
    !== pointer.currentReleaseEvidencePointerHash) {
    throw new Error('offhost_release_pointer_hash_invalid');
  }
  const token = pointer.bundleHash.slice('sha256:'.length);
  const expectedBundlePath = path.join(commitRoot.path, `RELEASE_EVIDENCE_BUNDLE_${token}.json`);
  const expectedSignaturePath = path.join(commitRoot.path, `RELEASE_EVIDENCE_SIGNATURE_${token}.json`);
  if (path.resolve(String(pointer.bundlePath || '')) !== expectedBundlePath
    || path.resolve(String(pointer.signaturePath || '')) !== expectedSignaturePath) {
    throw new Error('offhost_release_pointer_path_escape');
  }
  const bundleCapture = readPinnedBytes(expectedBundlePath, {
    errorCode: 'offhost_release_bundle_unsafe',
    maximumBytes: MAXIMUM_RELEASE_DOCUMENT_BYTES,
    readOnly: true,
  });
  const signatureCapture = readPinnedBytes(expectedSignaturePath, {
    errorCode: 'offhost_release_signature_unsafe',
    maximumBytes: MAXIMUM_RELEASE_DOCUMENT_BYTES,
    readOnly: true,
  });
  const bundle = parseCapturedJson(bundleCapture, 'offhost_release_bundle_invalid');
  const signature = parseCapturedJson(signatureCapture, 'offhost_release_signature_invalid');
  if (!bundleReadyAndBound(bundle, { version, commit, pointer })) {
    throw new Error('offhost_release_bundle_not_ready_or_bound');
  }
  if (!verifyReleaseSignature(bundle, signature, pinnedKey)) {
    throw new Error('offhost_release_signature_verification_failed');
  }
  for (const capture of [pointerCapture, bundleCapture, signatureCapture]) {
    assertCaptureCurrent(capture, 'offhost_release_source_changed_during_selection');
  }
  assertDirectoryUnchanged(commitRoot, 'offhost_release_commit_root_changed');
  return Object.freeze({
    packageVersion: version,
    commit,
    generatedAt: pointer.generatedAt,
    releaseEvidenceBundleHash: bundle.releaseEvidenceBundleHash,
    currentReleaseEvidencePointerHash: pointer.currentReleaseEvidencePointerHash,
    pinnedPublicKeyFingerprint: pinnedKey.publicKeyFingerprint,
    sources: Object.freeze([
      captureAsSource('release_evidence_pointer', pointerCapture),
      captureAsSource('release_evidence_bundle', bundleCapture),
      captureAsSource('release_evidence_signature', signatureCapture),
    ]),
  });
}
export function selectLatestVerifiedReleaseEvidence(runtimeRoot) {
  const selectedRuntimeRoot = path.resolve(runtimeRoot);
  const evidenceRootPath = path.join(selectedRuntimeRoot, 'release-evidence');
  let evidenceRoot;
  try { evidenceRoot = assertSafeDirectory(evidenceRootPath, 'offhost_release_evidence_root_unsafe'); }
  catch (error) {
    if (!fs.existsSync(evidenceRootPath)) {
      return selectionResult('release_evidence_selection_missing', {
        blockers: ['offhost_release_evidence_missing'],
      });
    }
    return selectionResult('release_evidence_selection_blocked', {
      blockers: [error.message],
    });
  }
  try {
    const initialNames = fs.readdirSync(evidenceRoot.path).sort();
    const versions = initialNames.filter((name) => isSemanticReleaseVersion(name))
      .sort((left, right) => (
        compareSemanticReleaseVersions(left, right) || left.localeCompare(right)
      ));
    if (!versions.length) {
      return selectionResult('release_evidence_selection_missing', {
        blockers: ['offhost_release_evidence_missing'],
      });
    }
    const version = versions.at(-1);
    const versionRoot = assertSafeDirectory(
      path.join(evidenceRoot.path, version),
      'offhost_release_version_root_unsafe',
    );
    const commits = fs.readdirSync(versionRoot.path).sort();
    if (!commits.length) throw new Error('offhost_release_highest_version_empty');
    const pinnedKey = loadPinnedReleasePublicKey(selectedRuntimeRoot);
    const candidates = commits.map((commit) => validateReleaseCandidate({
      runtimeRoot: selectedRuntimeRoot,
      version,
      commit,
      pinnedKey,
    }));
    if (JSON.stringify(fs.readdirSync(versionRoot.path).sort()) !== JSON.stringify(commits)
      || JSON.stringify(fs.readdirSync(evidenceRoot.path).sort()) !== JSON.stringify(initialNames)) {
      throw new Error('offhost_release_candidate_set_changed');
    }
    assertDirectoryUnchanged(versionRoot, 'offhost_release_version_root_changed');
    assertDirectoryUnchanged(evidenceRoot, 'offhost_release_evidence_root_changed');
    assertDirectoryUnchanged(pinnedKey.runtime, 'offhost_release_runtime_root_changed');
    assertDirectoryUnchanged(pinnedKey.keyRoot, 'offhost_release_signing_root_changed');
    assertCaptureCurrent(pinnedKey.capture, 'offhost_release_public_key_changed');
    candidates.sort((left, right) => left.generatedAt.localeCompare(right.generatedAt)
      || left.commit.localeCompare(right.commit));
    return selectionResult('release_evidence_selection_verified', candidates.at(-1));
  } catch (error) {
    return selectionResult('release_evidence_selection_blocked', {
      blockers: [error.message || 'offhost_release_evidence_invalid'],
    });
  }
}
export function resolveLatestReleaseEvidencePointer(runtimeRoot) {
  return selectLatestVerifiedReleaseEvidence(runtimeRoot);
}
export function verifyOffhostWormTarget({ workspaceRoot, contract, mountAvailableOverride = null, distinctDeviceOverride = null } = {}) {
  if (contract?.kind !== 'OffhostWormSnapshotContract' || contract?.version !== 1) throw new Error('v1 offhost WORM contract required');
  const targetMountRoot = path.resolve(process.env.HEPTA_OFFHOST_WORM_ROOT || contract.targetMountRoot);
  const mountProbe = spawnSync('findmnt', ['-rn', '--mountpoint', targetMountRoot, '-o', 'TARGET,SOURCE,FSTYPE'], { encoding: 'utf8' });
  const mountAvailable = mountAvailableOverride === null ? mountProbe.status === 0 : Boolean(mountAvailableOverride);
  let distinctDevice = false;
  let targetPathSafe = false;
  if (mountAvailable) {
    try {
      const workspace = assertSafeDirectory(workspaceRoot, 'offhost_worm_workspace_root_unsafe');
      const target = assertSafeDirectory(targetMountRoot, 'offhost_worm_target_root_unsafe');
      distinctDevice = fs.lstatSync(workspace.path).dev !== fs.lstatSync(target.path).dev;
      targetPathSafe = true;
    } catch {
      distinctDevice = false;
      targetPathSafe = false;
    }
  }
  if (distinctDeviceOverride !== null) distinctDevice = Boolean(distinctDeviceOverride);
  const blockers = [
    ...(mountAvailable ? [] : ['offhost_worm_target_unavailable']),
    ...(mountAvailable && !targetPathSafe ? ['offhost_worm_target_path_unsafe'] : []),
    ...(contract.requireDistinctFilesystemDevice && !distinctDevice ? ['offhost_worm_target_not_distinct_device'] : []),
  ];
  return Object.freeze({
    version: 1,
    kind: 'OffhostWormTargetStatus',
    status: blockers.length ? 'offhost_worm_target_blocked' : 'offhost_worm_target_ready',
    contractId: contract.contractId,
    targetMountRoot,
    mountAvailable,
    mountIdentity: mountAvailable ? String(mountProbe.stdout || '').trim() || 'test_override' : null,
    distinctDevice,
    currentProtectionLevel: contract.currentProtectionLevel || 'external_disk_unspecified_custody',
    offHostOrOffsiteCustodyQualified: contract.offHostOrOffsiteCustodyQualified === true,
    custodyStatus: contract.offHostOrOffsiteCustodyQualified === true
      ? 'offhost_or_offsite_custody_qualified'
      : 'offhost_or_offsite_custody_blocked',
    custodyBlockers: contract.offHostOrOffsiteCustodyQualified === true
      ? []
      : [
        ...(contract.offlineDetachmentOrObjectLockReceiptRequired ? ['offline_detachment_or_object_lock_receipt_missing'] : []),
        ...(contract.independentCustodyAttestationRequired ? ['independent_custody_attestation_missing'] : []),
      ],
    blockers,
  });
}
function hashPinnedFile(pinned, errorCode) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let offset = 0;
  for (;;) {
    const bytesRead = fs.readSync(pinned.descriptor, buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (String(offset) !== pinned.identity.size) throw new Error(errorCode);
  assertPinnedPathUnchanged(pinned, errorCode);
  return `sha256:${hash.digest('hex')}`;
}
function capturedBytes(source) {
  if (typeof source.capturedBytesBase64 !== 'string'
    || !exactKeys(source.identity, [
      'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size', 'uid',
    ])) throw new Error('offhost_worm_captured_source_invalid');
  const bytes = Buffer.from(source.capturedBytesBase64, 'base64');
  if (bytes.toString('base64') !== source.capturedBytesBase64
    || bytes.length !== source.bytes
    || hashBytes(bytes) !== source.sha256
    || String(bytes.length) !== source.identity.size) {
    throw new Error('offhost_worm_captured_source_invalid');
  }
  return bytes;
}
function prepareSnapshotSource(source) {
  const role = String(source?.role || '');
  if (!role || !source?.path) throw new Error('offhost_worm_source_invalid');
  const captured = Object.hasOwn(source, 'capturedBytesBase64') ? capturedBytes(source) : null;
  const pinned = openPinnedRegularFile(source.path, {
    errorCode: 'offhost_worm_source_unsafe',
    expectedIdentity: captured ? source.identity : null,
  });
  try {
    const sha256 = captured ? hashBytes(captured) : hashPinnedFile(pinned, 'offhost_worm_source_changed');
    const bytes = captured ? captured.length : Number(pinned.identity.size);
    if (!Number.isSafeInteger(bytes) || bytes < 1
      || (source.sha256 && source.sha256 !== sha256)
      || (source.bytes !== undefined && source.bytes !== bytes)) {
      throw new Error('offhost_worm_source_binding_invalid');
    }
    return Object.freeze({
      role,
      path: pinned.path,
      identity: pinned.identity,
      sha256,
      bytes,
      captured,
      pinned,
    });
  } catch (error) {
    fs.closeSync(pinned.descriptor);
    throw error;
  }
}
function publicSourceRow(source) {
  return Object.freeze({
    role: source.role, path: source.path, present: true, sha256: source.sha256,
    bytes: source.bytes, identity: source.identity,
    capturedBeforeSnapshot: Boolean(source.captured),
  });
}
export function createOffhostWormSnapshot({
  workspaceRoot,
  contract,
  sources = [],
  sourceBlockers = [],
  execute = false,
  mountAvailableOverride = null,
  distinctDeviceOverride = null,
  immutableOverride = null,
  faultInjector = null,
  signManifest = null,
  verifyManifestSignature = null,
} = {}) {
  const target = verifyOffhostWormTarget({
    workspaceRoot,
    contract,
    mountAvailableOverride,
    distinctDeviceOverride,
  });
  const blockers = [
    ...target.blockers,
    ...sourceBlockers.map((entry) => String(entry)),
    ...(execute ? [] : ['offhost_worm_snapshot_execute_required']),
    ...(execute && (typeof signManifest !== 'function'
      || typeof verifyManifestSignature !== 'function')
      ? ['offhost_worm_snapshot_manifest_authority_unavailable'] : []),
  ];
  const preparedSources = [];
  const sourceRows = [];
  const seenRoles = new Set();
  for (const source of sources) {
    const role = String(source?.role || 'invalid');
    if (seenRoles.has(role)) blockers.push(`offhost_worm_source_role_duplicate:${role}`);
    seenRoles.add(role);
    try {
      const prepared = prepareSnapshotSource(source);
      preparedSources.push(prepared);
      sourceRows.push(publicSourceRow(prepared));
    } catch {
      blockers.push(`offhost_worm_source_unsafe:${role}`);
      sourceRows.push(Object.freeze({
        role,
        path: source?.path ? path.resolve(source.path) : null,
        present: false,
        sha256: null,
        bytes: 0,
        identity: null,
        capturedBeforeSnapshot: false,
      }));
    }
  }
  faultInjector?.({ stage: 'after_sources_prepared', preparedSources });
  if (blockers.length) {
    for (const source of preparedSources) fs.closeSync(source.pinned.descriptor);
    return Object.freeze({
      version: 1,
      kind: 'OffhostWormSnapshotReceipt',
      status: 'offhost_worm_snapshot_blocked',
      execute,
      target,
      sources: sourceRows,
      copiedObjectCount: 0,
      immutableObjectCount: 0,
      blockers: [...new Set(blockers)],
    });
  }
  const subject = { contractId: contract.contractId, sources: sourceRows.map(({ role, sha256, bytes }) => ({ role, sha256, bytes })) };
  const snapshotId = hashRecord('OffhostWormSnapshotSubject', subject).replace(/^sha256:/, '');
  const snapshotRoot = path.join(target.targetMountRoot, 'hepta-paper-worm', snapshotId);
  const objectRoot = path.join(snapshotRoot, 'objects');
  let targetRoot;
  let wormDirectory;
  let snapshotDirectory;
  let objectDirectory;
  const objects = [];
  try {
    targetRoot = openPinnedDirectory(target.targetMountRoot, 'offhost_worm_target_root_unsafe');
    wormDirectory = ensurePinnedChildDirectory(
      targetRoot,
      'hepta-paper-worm',
      'offhost_worm_repository_root_unsafe',
    );
    snapshotDirectory = ensurePinnedChildDirectory(
      wormDirectory,
      snapshotId,
      'offhost_worm_snapshot_root_unsafe',
    );
    objectDirectory = ensurePinnedChildDirectory(
      snapshotDirectory,
      'objects',
      'offhost_worm_object_root_unsafe',
    );
    const directoryChain = [targetRoot, wormDirectory, snapshotDirectory, objectDirectory];
    assertPinnedDirectoryChain(directoryChain, 'offhost_worm_destination_chain_changed');
    for (const source of preparedSources) {
      const token = source.sha256.replace(/^sha256:/, '');
      const destination = path.join(objectRoot, token);
      let objectHash = null;
      let immutable = false;
      let publication = null;
      try {
        assertPinnedDirectoryChain(directoryChain, 'offhost_worm_destination_chain_changed');
        assertPinnedPathUnchanged(source.pinned, 'offhost_worm_source_changed_before_copy');
        faultInjector?.({ stage: 'before_source_copy', source, destination });
        assertPinnedDirectoryChain(directoryChain, 'offhost_worm_destination_chain_changed');
        publication = publishSnapshotObject(
          source,
          destination,
          objectDirectory,
          directoryChain,
        );
        objectHash = publication.objectHash;
        faultInjector?.({ stage: 'after_source_copy', source, destination });
        assertPinnedDirectoryChain(directoryChain, 'offhost_worm_destination_chain_changed');
        assertPinnedPathUnchanged(source.pinned, 'offhost_worm_source_changed_after_copy');
        if (objectHash !== source.sha256) {
          throw new Error('offhost_worm_object_hash_mismatch');
        }
        immutable = objectHash === source.sha256 && Boolean(immutableOverride);
        if (objectHash === source.sha256 && immutableOverride === null) {
          assertPinnedDirectoryChain(directoryChain, 'offhost_worm_destination_chain_changed');
          if (!filesystemImmutable(publication.descriptorPath)) {
            spawnSync('chattr', ['+i', publication.descriptorPath], { encoding: 'utf8' });
          }
          immutable = filesystemImmutable(publication.descriptorPath);
          assertPinnedDirectoryChain(directoryChain, 'offhost_worm_destination_chain_changed');
        }
      } catch {
        if (publication?.createdIdentity) {
          try {
            if (filesystemImmutable(publication.descriptorPath)) {
              spawnSync('chattr', ['-i', publication.descriptorPath], { encoding: 'utf8' });
            }
          } catch { /* Identity-bound removal below remains fail closed. */ }
          removePinnedChildExact(objectDirectory, publication.name, publication.createdIdentity);
        }
        blockers.push(`offhost_worm_source_changed_or_copy_failed:${source.role}`);
      }
      objects.push({
        role: source.role,
        sourceHash: source.sha256,
        objectPath: destination,
        objectHash,
        immutable,
      });
    }
    if (contract.requireFilesystemImmutableObjects
      && objects.some((object) => !object.immutable)) {
      blockers.push('offhost_worm_objects_not_filesystem_immutable');
    }
    if (blockers.length) {
      return Object.freeze({
        version: 1,
        kind: 'OffhostWormSnapshotReceipt',
        status: 'offhost_worm_snapshot_blocked',
        execute: true,
        target,
        sources: sourceRows,
        objects,
        copiedObjectCount: objects.length,
        immutableObjectCount: objects.filter((object) => object.immutable).length,
        blockers: [...new Set(blockers)],
      });
    }
    const payload = {
      version: 2,
      kind: 'OffhostWormSnapshotManifest',
      contractId: contract.contractId,
      snapshotId,
      protectionLevel: target.currentProtectionLevel,
      offHostOrOffsiteCustodyQualified: target.offHostOrOffsiteCustodyQualified,
      objects,
    };
    const unsignedManifest = Object.freeze({
      ...payload,
      manifestHash: hashRecord('OffhostWormSnapshotManifest', payload),
    });
    const signature = signManifest(unsignedManifest);
    if (!exactKeys(signature, SIGNATURE_KEYS)
      || verifyManifestSignature(unsignedManifest, signature) !== true) {
      throw new Error('offhost_worm_manifest_signature_invalid');
    }
    const manifest = Object.freeze({ ...unsignedManifest, signature });
    const manifestPath = path.join(snapshotRoot, 'OFFHOST_WORM_SNAPSHOT_MANIFEST.json');
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const publication = publishManifestNoClobber(
      manifestPath,
      manifestBytes,
      snapshotDirectory,
      [targetRoot, wormDirectory, snapshotDirectory],
    );
    faultInjector?.({ stage: 'after_manifest_publish', manifestPath });
    try {
      assertPinnedDirectoryChain(
        [targetRoot, wormDirectory, snapshotDirectory, objectDirectory],
        'offhost_worm_destination_chain_changed',
      );
    } catch (error) {
      if (publication.createdIdentity) {
        removePinnedChildExact(snapshotDirectory, publication.name, publication.createdIdentity);
      }
      throw error;
    }
    return Object.freeze({
      version: 2,
      kind: 'OffhostWormSnapshotReceipt',
      status: 'offhost_worm_snapshot_recorded',
      execute: true,
      target,
      snapshotRoot,
      manifestPath,
      manifestHash: manifest.manifestHash,
      signingKeyFingerprint: signature.publicKeyFingerprint,
      copiedObjectCount: objects.length,
      immutableObjectCount: objects.filter((object) => object.immutable).length,
      blockers: [],
    });
  } finally {
    for (const source of preparedSources) fs.closeSync(source.pinned.descriptor);
    for (const directory of [objectDirectory, snapshotDirectory, wormDirectory, targetRoot]) {
      if (directory?.descriptor !== undefined) fs.closeSync(directory.descriptor);
    }
  }
}
export { drillOffhostWormRestore };
