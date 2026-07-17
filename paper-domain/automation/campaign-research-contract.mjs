import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { workspaceExecutionManifestHash, workspaceExecutionMerkleHash } from '../../workflow-kernel/runtime/workspace-execution-identity.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function safeRelative(value) {
  const normalized = String(value || '').replace(/\\/g, '/').trim();
  return normalized && !normalized.startsWith('/') && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split('/').some((part) => !part || part === '.' || part === '..');
}

function stableSnapshotRecords(values = [], { directory = false } = {}) {
  return (Array.isArray(values) ? values : []).map((value) => Object.freeze({
    path: String(value?.path || '').replace(/\\/g, '/'),
    mode: Number(value?.mode),
    ...(directory ? {} : { hash: String(value?.hash || '').toLowerCase(), bytes: Number(value?.bytes) }),
  })).sort((left, right) => left.path.localeCompare(right.path));
}

export function buildCampaignResearchSourceSnapshot({
  campaignId,
  paperId,
  researchNodeId,
  researchAttemptId,
  researchLeaseGeneration,
  verifiedSourceMerkleHash,
  verifiedSourceWorkspaceManifestHash,
  excludedRelativeRoots = [],
  excludedNames = [],
  fileRecords = [],
  directoryRecords = [],
} = {}) {
  const files = stableSnapshotRecords(fileRecords);
  const directories = stableSnapshotRecords(directoryRecords, { directory: true });
  const roots = [...new Set((excludedRelativeRoots || []).map((value) => String(value || '').replace(/\\/g, '/')).filter(Boolean))].sort();
  const names = [...new Set((excludedNames || []).map((value) => String(value || '').trim()).filter(Boolean))].sort();
  if (!campaignId || !paperId || !researchNodeId || !researchAttemptId || !Number.isInteger(Number(researchLeaseGeneration)) || Number(researchLeaseGeneration) < 1
    || !SHA256.test(String(verifiedSourceMerkleHash || '')) || !SHA256.test(String(verifiedSourceWorkspaceManifestHash || ''))) {
    throw new Error('campaign_research_source_snapshot_identity_required');
  }
  if (roots.some((value) => !safeRelative(value)) || names.some((value) => value.includes('/') || value.includes('\\') || value === '.' || value === '..')) {
    throw new Error('campaign_research_source_snapshot_exclusion_invalid');
  }
  if (files.some((value) => !safeRelative(value.path) || !SHA256.test(value.hash) || !Number.isInteger(value.mode)
    || value.mode < 0 || !Number.isSafeInteger(value.bytes) || value.bytes < 0)
    || directories.some((value) => !safeRelative(value.path) || !Number.isInteger(value.mode) || value.mode < 0)) {
    throw new Error('campaign_research_source_snapshot_record_invalid');
  }
  const allPaths = [...files.map((value) => value.path), ...directories.map((value) => value.path)];
  if (new Set(allPaths).size !== allPaths.length) throw new Error('campaign_research_source_snapshot_path_duplicate');
  if (workspaceExecutionMerkleHash(files) !== verifiedSourceMerkleHash
    || workspaceExecutionManifestHash(files, directories) !== verifiedSourceWorkspaceManifestHash) {
    throw new Error('campaign_research_source_snapshot_record_identity_mismatch');
  }
  const payload = {
    version: 1,
    kind: 'CampaignResearchSourceSnapshot',
    status: 'campaign_research_source_snapshot_verified',
    campaignId: String(campaignId),
    paperId: String(paperId),
    researchNodeId: String(researchNodeId),
    researchAttemptId: String(researchAttemptId),
    researchLeaseGeneration: Number(researchLeaseGeneration),
    verifiedSourceMerkleHash: String(verifiedSourceMerkleHash),
    verifiedSourceWorkspaceManifestHash: String(verifiedSourceWorkspaceManifestHash),
    excludedRelativeRoots: Object.freeze(roots),
    excludedNames: Object.freeze(names),
    fileRecords: Object.freeze(files),
    directoryRecords: Object.freeze(directories),
    fileCount: files.length,
    directoryCount: directories.length,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    campaignResearchSourceSnapshotHash: hashRecord('CampaignResearchSourceSnapshot', payload),
  });
}

export function verifyCampaignResearchSourceSnapshot(snapshot, expected = {}) {
  const blockers = [];
  if (snapshot?.version !== 1 || snapshot?.kind !== 'CampaignResearchSourceSnapshot'
    || snapshot?.status !== 'campaign_research_source_snapshot_verified') blockers.push('campaign_research_source_snapshot_shape_invalid');
  const files = stableSnapshotRecords(snapshot?.fileRecords);
  const directories = stableSnapshotRecords(snapshot?.directoryRecords, { directory: true });
  if (!SHA256.test(String(snapshot?.verifiedSourceMerkleHash || '')) || !SHA256.test(String(snapshot?.verifiedSourceWorkspaceManifestHash || ''))) {
    blockers.push('campaign_research_source_snapshot_identity_invalid');
  }
  if (files.length !== Number(snapshot?.fileCount) || directories.length !== Number(snapshot?.directoryCount)
    || files.some((value) => !safeRelative(value.path) || !SHA256.test(value.hash) || !Number.isInteger(value.mode)
      || value.mode < 0 || !Number.isSafeInteger(value.bytes) || value.bytes < 0)
    || directories.some((value) => !safeRelative(value.path) || !Number.isInteger(value.mode) || value.mode < 0)) {
    blockers.push('campaign_research_source_snapshot_records_invalid');
  }
  const roots = snapshot?.excludedRelativeRoots || [];
  const names = snapshot?.excludedNames || [];
  if (!Array.isArray(roots) || roots.some((value) => !safeRelative(value)) || !Array.isArray(names)
    || names.some((value) => !value || String(value).includes('/') || String(value).includes('\\') || value === '.' || value === '..')) {
    blockers.push('campaign_research_source_snapshot_exclusions_invalid');
  }
  const allPaths = [...files.map((value) => value.path), ...directories.map((value) => value.path)];
  if (new Set(allPaths).size !== allPaths.length) blockers.push('campaign_research_source_snapshot_path_duplicate');
  if (JSON.stringify(snapshot?.fileRecords || []) !== JSON.stringify(files)
    || JSON.stringify(snapshot?.directoryRecords || []) !== JSON.stringify(directories)
    || JSON.stringify(roots) !== JSON.stringify([...new Set(roots)].sort())
    || JSON.stringify(names) !== JSON.stringify([...new Set(names)].sort())) {
    blockers.push('campaign_research_source_snapshot_records_not_canonical');
  }
  if (!snapshot?.researchNodeId || !snapshot?.researchAttemptId || !Number.isInteger(Number(snapshot?.researchLeaseGeneration)) || Number(snapshot?.researchLeaseGeneration) < 1) {
    blockers.push('campaign_research_source_snapshot_attempt_identity_invalid');
  }
  if (workspaceExecutionMerkleHash(files) !== snapshot?.verifiedSourceMerkleHash
    || workspaceExecutionManifestHash(files, directories) !== snapshot?.verifiedSourceWorkspaceManifestHash) {
    blockers.push('campaign_research_source_snapshot_record_identity_mismatch');
  }
  if (snapshot) {
    const { campaignResearchSourceSnapshotHash: claimedHash, ...payload } = snapshot;
    if (!claimedHash || hashRecord('CampaignResearchSourceSnapshot', payload) !== claimedHash) blockers.push('campaign_research_source_snapshot_hash_invalid');
  }
  for (const [field, blocker] of [
    ['campaignId', 'campaign_research_source_snapshot_campaign_mismatch'],
    ['paperId', 'campaign_research_source_snapshot_paper_mismatch'],
    ['researchNodeId', 'campaign_research_source_snapshot_node_mismatch'],
    ['researchAttemptId', 'campaign_research_source_snapshot_attempt_mismatch'],
    ['researchLeaseGeneration', 'campaign_research_source_snapshot_lease_mismatch'],
    ['verifiedSourceMerkleHash', 'campaign_research_source_merkle_mismatch'],
    ['verifiedSourceWorkspaceManifestHash', 'campaign_research_source_manifest_mismatch'],
  ]) if (expected[field] && snapshot?.[field] !== expected[field]) blockers.push(blocker);
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}

function jsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableEvidenceRefs(values = []) {
  return (Array.isArray(values) ? values : []).map((value) => Object.freeze({
    ref: String(value?.ref || value?.path || '').trim() || null,
    path: String(value?.path || '').trim() || null,
    role: String(value?.role || '').trim() || null,
    hash: String(value?.hash || '').trim() || null,
    sizeBytes: Number.isFinite(Number(value?.sizeBytes)) ? Number(value.sizeBytes) : null,
  })).filter((value) => {
    if (!value.ref && !value.path) return false;
    const authorityLabel = `${value.role || ''}:${value.ref || ''}:${value.path || ''}`.toLowerCase();
    return !/workflow[-_]authority|receipt[-_]ledger|paperbatchcampaign/.test(authorityLabel);
  }).sort((left, right) => (
    `${left.ref || ''}:${left.path || ''}:${left.hash || ''}`.localeCompare(`${right.ref || ''}:${right.path || ''}:${right.hash || ''}`)
  ));
}

function stablePaperTask(paperTask) {
  return Object.freeze({
    version: paperTask.version || null,
    kind: 'PaperTask',
    channelId: paperTask.channelId || null,
    productLineId: paperTask.productLineId || null,
    workflowId: paperTask.workflowId || null,
    paperId: paperTask.paperId,
    taskKey: paperTask.taskKey,
    title: paperTask.title || paperTask.paperId,
    status: paperTask.status || null,
    venueTarget: paperTask.venueTarget || null,
    paperType: paperTask.paperType || null,
    canonicalDir: paperTask.canonicalDir || null,
    sourceWorkspace: paperTask.sourceWorkspace || null,
    mainTex: paperTask.mainTex || null,
    evidenceRefs: stableEvidenceRefs(paperTask.evidenceRefs),
    paperQualityProfile: paperTask.paperQualityProfile || null,
    paperQualityProfiles: Array.isArray(paperTask.paperQualityProfiles) ? [...new Set(paperTask.paperQualityProfiles.filter(Boolean))] : [],
    semanticIdentityVersion: paperTask.semanticIdentityVersion || null,
    semanticIdentityHash: paperTask.semanticIdentityHash,
  });
}

export function buildCampaignResearchVerificationInput({ paperId, paperTask, paperState = null } = {}) {
  if (!paperTask?.paperId || !paperTask?.taskKey || !paperTask?.semanticIdentityHash) {
    throw new Error('campaign_research_paper_task_identity_required');
  }
  if (paperTask.paperId !== paperId) throw new Error('campaign_research_paper_task_mismatch');
  const evidenceRefs = Array.isArray(paperState?.evidenceRefs)
    ? paperState.evidenceRefs
    : Array.isArray(paperTask.evidenceRefs) ? paperTask.evidenceRefs : [];
  const payload = {
    version: 1,
    kind: 'CampaignResearchVerificationInput',
    paperId,
    paperSemanticIdentityHash: paperTask.semanticIdentityHash,
    paperTask: stablePaperTask(paperTask),
    state: Object.freeze({ evidenceRefs: jsonValue(stableEvidenceRefs(evidenceRefs)) }),
  };
  return Object.freeze({
    ...payload,
    campaignResearchVerificationInputHash: hashRecord('CampaignResearchVerificationInput', payload),
  });
}

export function verifyCampaignResearchVerificationInput(input, { paperId = null } = {}) {
  const blockers = [];
  if (!input || input.version !== 1 || input.kind !== 'CampaignResearchVerificationInput') {
    blockers.push('campaign_research_verification_input_shape_invalid');
  }
  if (!input?.paperTask?.taskKey || !input?.paperTask?.semanticIdentityHash) {
    blockers.push('campaign_research_paper_task_identity_required');
  }
  if (input?.paperId !== input?.paperTask?.paperId || (paperId && input?.paperId !== paperId)) {
    blockers.push('campaign_research_paper_task_mismatch');
  }
  if (input?.paperSemanticIdentityHash !== input?.paperTask?.semanticIdentityHash) {
    blockers.push('campaign_research_semantic_identity_binding_invalid');
  }
  if (input) {
    const { campaignResearchVerificationInputHash: claimedHash, ...payload } = input;
    if (!claimedHash || hashRecord('CampaignResearchVerificationInput', payload) !== claimedHash) {
      blockers.push('campaign_research_verification_input_hash_invalid');
    }
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: [...new Set(blockers)] });
}
