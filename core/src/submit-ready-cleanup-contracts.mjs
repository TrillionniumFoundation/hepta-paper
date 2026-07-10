import path from 'node:path';
import { digest } from './hash-utils.mjs';

export const SUBMIT_READY_CLEANUP_CONTRACT_VERSION = 1;

export const SUBMIT_READY_CLEANUP_SAFETY = Object.freeze({
  localContractOnly: true,
  readsFiles: false,
  writesFiles: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  grantsExecutionPermission: false,
});

export const SUBMIT_READY_CLEANUP_ARTIFACT_EXTS = Object.freeze([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.bmp',
  '.gif',
  '.tif',
  '.tiff',
  '.pdf',
]);

const ARTIFACT_EXTS = new Set(SUBMIT_READY_CLEANUP_ARTIFACT_EXTS);

export function slashPath(input) {
  return String(input || '').replace(/\\/g, '/');
}

export function isSubmitReadyArtifactFile(file) {
  return ARTIFACT_EXTS.has(path.extname(String(file || '')).toLowerCase());
}

function cloneJson(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

export function resolveSubmitReadyKeepFiles({ caseDir, keepFiles = [], caseIndex = null } = {}) {
  const keep = new Map();
  const resolvedCaseDir = path.resolve(caseDir || '.');
  const add = (file, source = 'explicit') => {
    if (!file) return;
    const full = path.isAbsolute(file) ? path.resolve(file) : path.resolve(resolvedCaseDir, file);
    keep.set(full, { path: full, relativePath: slashPath(path.relative(resolvedCaseDir, full)), source });
  };
  for (const file of keepFiles || []) add(file, 'explicit');
  for (const item of caseIndex?.artifacts || []) {
    if (item?.submitReady && item.path) add(item.path, 'case-index-submitReady');
  }
  for (const item of caseIndex?.files || []) {
    if (item?.submitReady && item.path) add(item.path, 'case-index-file-submitReady');
  }
  for (const [relativePath, meta] of caseIndex?.manifest?.artifacts ? Object.entries(caseIndex.manifest.artifacts) : []) {
    if (meta?.submitReady) add(relativePath, 'case-manifest-submitReady');
  }
  return keep;
}

export function classifySubmitReadyCleanupPath({ file, caseDir, keepPathSet = new Set() } = {}) {
  if (!file || !caseDir) return { keep: false, cleanup: false, skipReason: 'missing_path_or_case_dir' };
  const resolvedCaseDir = path.resolve(caseDir);
  const full = path.resolve(file);
  const normalizedKeep = keepPathSet instanceof Set ? keepPathSet : new Set(keepPathSet || []);
  if (!full.startsWith(resolvedCaseDir + path.sep)) {
    return { path: full, keep: false, cleanup: false, skipReason: 'outside_case_dir' };
  }
  if (!isSubmitReadyArtifactFile(full)) {
    return { path: full, keep: false, cleanup: false, skipReason: 'not_artifact_file' };
  }
  if (normalizedKeep.has(full)) {
    return { path: full, keep: true, cleanup: false, skipReason: 'submit_ready_keep_file' };
  }
  const relativePath = slashPath(path.relative(resolvedCaseDir, full));
  const dirname = slashPath(path.dirname(relativePath));
  if (!dirname || dirname === '.') {
    return { path: full, relativePath, keep: false, cleanup: true, reason: 'root_intermediate_not_submit_ready' };
  }
  if (/^generation\/generated(?:\/|$)/i.test(relativePath)) {
    return { path: full, relativePath, keep: false, cleanup: true, reason: 'generated_copy_or_intermediate' };
  }
  if (/^generation\/superseded/i.test(relativePath)) {
    return { path: full, relativePath, keep: false, cleanup: true, reason: 'superseded_intermediate' };
  }
  return { path: full, relativePath, keep: false, cleanup: false, skipReason: 'non_cleanup_artifact_location' };
}

export function submitReadyCleanupCandidateRecord({
  taskId = null,
  taskDir = null,
  taskRoot = null,
  caseDir,
  candidate,
  size = 0,
  sha256 = null,
  keepMatches = [],
} = {}) {
  const full = path.resolve(candidate?.path || '');
  const reason = (keepMatches || []).length
    ? 'duplicate_of_submit_ready_' + (candidate?.reason || 'artifact')
    : candidate?.reason;
  return {
    taskId,
    taskDir,
    path: full,
    relativePath: candidate?.relativePath || slashPath(path.relative(path.resolve(caseDir || '.'), full)),
    reason,
    size: Number(size || 0),
    sha256,
    keepMatches: keepMatches || [],
    rootRelativePath: taskRoot ? slashPath(path.relative(path.resolve(taskRoot), full)) : null,
  };
}

export function updateSubmitReadyCaseIndex({ index, movedRelSet, updatedAt = null } = {}) {
  if (!index || typeof index !== 'object') return { changed: false, index };
  const next = cloneJson(index);
  const moved = movedRelSet instanceof Set ? movedRelSet : new Set(movedRelSet || []);
  let changed = false;
  const shouldKeep = (item) => {
    const rel = slashPath(item?.relativePath || '');
    const hit = rel && moved.has(rel);
    if (hit) changed = true;
    return !hit;
  };
  if (Array.isArray(next.artifacts)) next.artifacts = next.artifacts.filter(shouldKeep);
  if (Array.isArray(next.files)) next.files = next.files.filter(shouldKeep);
  if (next.manifest?.artifacts && typeof next.manifest.artifacts === 'object') {
    for (const rel of moved) {
      if (Object.prototype.hasOwnProperty.call(next.manifest.artifacts, rel)) {
        delete next.manifest.artifacts[rel];
        changed = true;
      }
    }
    if (moved.has(slashPath(next.manifest.selectedRelativePath || ''))) {
      next.manifest.selectedRelativePath = null;
      changed = true;
    }
  }
  if (changed) {
    next.fileCount = Array.isArray(next.files) ? next.files.length : next.fileCount;
    next.artifactCount = Array.isArray(next.artifacts) ? next.artifacts.length : next.artifactCount;
    next.submitReadyCount = Array.isArray(next.artifacts) ? next.artifacts.filter((item) => item?.submitReady).length : next.submitReadyCount;
    const latest = Array.isArray(next.artifacts) ? next.artifacts.at(-1) : null;
    const selected = Array.isArray(next.artifacts) ? next.artifacts.find((item) => item?.selectedForSubmit) : null;
    next.latestVersion = latest?.version || null;
    next.latestFile = latest?.relativePath || null;
    next.selectedVersion = selected?.version || null;
    next.selectedFile = selected?.relativePath || null;
    next.updatedAt = updatedAt || new Date().toISOString();
  }
  return { changed, index: next };
}

export function updateSubmitReadyCaseManifest({ manifest, movedRelSet, updatedAt = null } = {}) {
  if (!manifest || typeof manifest !== 'object') return { changed: false, manifest };
  if (!manifest.artifacts || typeof manifest.artifacts !== 'object') return { changed: false, manifest };
  const next = cloneJson(manifest);
  const moved = movedRelSet instanceof Set ? movedRelSet : new Set(movedRelSet || []);
  let changed = false;
  for (const rel of moved) {
    if (Object.prototype.hasOwnProperty.call(next.artifacts, rel)) {
      delete next.artifacts[rel];
      changed = true;
    }
  }
  if (moved.has(slashPath(next.selectedRelativePath || ''))) {
    next.selectedRelativePath = null;
    changed = true;
  }
  if (changed) next.updatedAt = updatedAt || new Date().toISOString();
  return { changed, manifest: next };
}

export function submitReadyCleanupCheck(result, { reviewedAt = null } = {}) {
  if (!result) {
    return { id: 'final_submit_ready_cleanup', status: 'review', label: 'Submit-ready cleanup did not run.', notes: null, blocking: true };
  }
  if (result.skippedFiles) {
    return {
      id: 'final_submit_ready_cleanup',
      status: 'fail',
      label: 'Final package cleanup completed with skipped files.',
      notes: `${result.skippedFiles} skipped; deleted ${result.deletedFiles ?? result.movedFiles ?? 0}`,
      blocking: true,
      reviewedAt: reviewedAt || new Date().toISOString(),
    };
  }
  return {
    id: 'final_submit_ready_cleanup',
    status: 'pass',
    label: 'Final package keeps only root submit-ready artifacts; generated/intermediate artifact copies were removed from active case tree.',
    notes: `deleted ${result.deletedFiles ?? result.movedFiles ?? 0} files (${result.deletedBytes ?? result.movedBytes ?? 0} bytes) via ${result.deleteMode || 'fs.rm'}`,
    blocking: true,
    reviewedAt: reviewedAt || new Date().toISOString(),
  };
}

export function submitReadyCleanupContractHash(result = {}) {
  return digest({
    version: SUBMIT_READY_CLEANUP_CONTRACT_VERSION,
    taskId: result.taskId || null,
    planned: (result.planned || []).map((item) => ({
      relativePath: item.relativePath,
      reason: item.reason,
      size: item.size,
      sha256: item.sha256,
    })),
    deletedFiles: result.deletedFiles ?? result.movedFiles ?? 0,
    skippedFiles: result.skippedFiles || 0,
    metadata: result.metadata || null,
  });
}

export function submitReadyCleanupContractsSelftest() {
  const caseDir = '/tmp/task-1__order-2/case';
  const keep = resolveSubmitReadyKeepFiles({
    caseDir,
    keepFiles: ['final-a.png'],
    caseIndex: {
      artifacts: [{ submitReady: true, path: path.join(caseDir, 'final-b.png') }],
      manifest: { artifacts: { 'final-c.pdf': { submitReady: true } } },
    },
  });
  const root = classifySubmitReadyCleanupPath({ file: path.join(caseDir, 'draft.png'), caseDir, keepPathSet: new Set(keep.keys()) });
  const generated = classifySubmitReadyCleanupPath({ file: path.join(caseDir, 'generation/generated/old.png'), caseDir, keepPathSet: new Set(keep.keys()) });
  const keepHit = classifySubmitReadyCleanupPath({ file: path.join(caseDir, 'final-a.png'), caseDir, keepPathSet: new Set(keep.keys()) });
  const index = {
    artifacts: [
      { relativePath: 'final-a.png', submitReady: true, version: 'v001' },
      { relativePath: 'draft.png', submitReady: false, version: 'v002' },
    ],
    files: [{ relativePath: 'draft.png' }],
    manifest: { selectedRelativePath: 'draft.png', artifacts: { 'final-a.png': {}, 'draft.png': {} } },
  };
  const updated = updateSubmitReadyCaseIndex({ index, movedRelSet: new Set(['draft.png']), updatedAt: '2026-06-21T00:00:00.000Z' });
  const check = submitReadyCleanupCheck({ skippedFiles: 0, deletedFiles: 1, deletedBytes: 4, deleteMode: 'fs.rm' }, { reviewedAt: '2026-06-21T00:00:00.000Z' });
  return {
    ok: keep.size === 3
      && root.reason === 'root_intermediate_not_submit_ready'
      && generated.reason === 'generated_copy_or_intermediate'
      && keepHit.keep === true
      && updated.changed
      && updated.index.artifacts.length === 1
      && check.status === 'pass',
    version: SUBMIT_READY_CLEANUP_CONTRACT_VERSION,
    safety: SUBMIT_READY_CLEANUP_SAFETY,
    cleanupHash: submitReadyCleanupContractHash({ taskId: 1, planned: [root], deletedFiles: 1 }),
  };
}
