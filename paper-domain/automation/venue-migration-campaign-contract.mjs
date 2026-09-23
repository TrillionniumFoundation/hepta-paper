import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

/**
 * A local venue migration is a planning identity, not a submission authority.
 * The contract deliberately carries the source venue as provenance while the
 * destination venue is only an input to the local manuscript/review campaign.
 */
export const VENUE_MIGRATION_CONTRACT_VERSION = 1;

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function safeSegment(value) {
  return String(value || 'unknown')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 160) || 'unknown';
}

function absolutePath(value, error = 'venue_migration_absolute_path_required') {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized.startsWith('/')) throw new Error(error);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function absoluteJoin(root, ...segments) {
  const base = absolutePath(root);
  return `${base === '/' ? '' : base}/${segments.map((segment) => String(segment).replace(/^\/+|\/+$/g, '')).join('/')}`;
}

function venueToken(value) {
  return text(value)?.toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
}

function metadataVenueCandidates(row) {
  const raw = row?.paper?.metadata_json;
  if (!raw) return [];
  let metadata;
  try { metadata = JSON.parse(raw); } catch { return []; }
  const classification = metadata?.paper_factory?.classification || {};
  return [
    classification.proposed_venue_target,
    classification.venue_family,
    metadata?.submission?.venue,
    metadata?.venueTarget,
  ].filter(Boolean).map(String);
}

/**
 * Return match evidence instead of a bare boolean so a broad migration can be
 * audited without guessing why a paper was selected.
 */
export function sourceVenueMatch(row, sourceVenue) {
  const expected = venueToken(sourceVenue);
  if (!expected) throw new Error('venue_migration_source_venue_required');
  const task = row?.task || {};
  const candidates = [
    task.venueTarget,
    task.registry?.submissionIntent?.venueTarget,
    row?.paper?.venue_target,
    ...metadataVenueCandidates(row),
    // Historical source/package names are accepted only as weak provenance;
    // explicit target/classification candidates are preferred and reported.
    task.sourceWorkspace,
    task.mainTex,
    row?.paper?.current_source_zip,
  ].filter(Boolean).map(String);
  const matches = candidates.filter((candidate) => venueToken(candidate) === expected
    || venueToken(candidate)?.includes(expected));
  const explicit = [
    task.venueTarget,
    task.registry?.submissionIntent?.venueTarget,
    row?.paper?.venue_target,
    ...metadataVenueCandidates(row),
  ].filter(Boolean).map(String);
  const explicitMatches = explicit.filter((candidate) => venueToken(candidate) === expected
    || venueToken(candidate)?.includes(expected));
  return Object.freeze({
    matched: matches.length > 0,
    sourceVenue: text(sourceVenue),
    sourceVenueToken: expected,
    evidence: Object.freeze([...new Set(matches)].sort()),
    explicitEvidence: Object.freeze([...new Set(explicitMatches)].sort()),
    confidence: explicitMatches.length ? 'explicit' : matches.length ? 'historical-path' : 'none',
  });
}

function normalizeTargetVenue(value) {
  const normalized = text(value);
  if (!normalized) throw new Error('venue_migration_target_venue_required');
  if (normalized.length > 128 || [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 32 || codePoint === 127;
  })) throw new Error('venue_migration_target_venue_invalid');
  return normalized;
}

function normalizeSourcePaperContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const profile = text(value.profile);
  const expectedProfile = new Set(['empirical_or_experiment_paper', 'theorem_or_proof_paper']);
  const proofReadiness = value.proofReadiness && typeof value.proofReadiness === 'object'
    && !Array.isArray(value.proofReadiness) ? value.proofReadiness : null;
  return Object.freeze({
    path: text(value.path),
    contractSchema: text(value.contractSchema),
    profile: expectedProfile.has(profile) ? profile : null,
    migrationState: text(value.migrationState),
    proofReadiness: proofReadiness ? Object.freeze({
      required: proofReadiness.required === true,
      requiredReportIds: Object.freeze(
        (Array.isArray(proofReadiness.required_reports) ? proofReadiness.required_reports : [])
          .map((report) => text(report?.id)).filter(Boolean).sort(),
      ),
    }) : null,
  });
}

function campaignIdFor({ paperId, runId, migrationKey }) {
  const suffix = text(runId) || `venue-migration-${migrationKey.slice('sha256:'.length, 22)}`;
  return `paper-campaign:${safeSegment(paperId)}:${safeSegment(suffix)}`;
}

/**
 * Build one deterministic queue entry. No directories or locks are created by
 * this function: worker-side COW preparation and SQLite generation-fenced
 * leases are the authoritative lock/isolation mechanisms.
 */
export function buildVenueMigrationEntry({
  row,
  sourceVenue,
  targetVenue,
  runtimeRoot,
  runId = null,
  mode = 'local-review-loop',
  rounds = 3,
  referees = 3,
} = {}) {
  const task = row?.task || {};
  const paperId = text(task.paperId);
  const sourceWorkspace = text(row?.sourceWorkspace || task.sourceWorkspace);
  if (!paperId || !task.semanticIdentityHash) {
    throw new Error('venue_migration_paper_identity_required');
  }
  if (!sourceWorkspace || !String(sourceWorkspace).startsWith('/')) {
    throw new Error(`venue_migration_source_workspace_absolute_required:${paperId || 'unknown'}`);
  }
  const source = text(sourceVenue);
  const target = normalizeTargetVenue(targetVenue);
  if (venueToken(source) === venueToken(target)) {
    throw new Error('venue_migration_source_and_target_must_differ');
  }
  const match = sourceVenueMatch(row, source);
  if (!match.matched) throw new Error(`venue_migration_source_venue_mismatch:${paperId}`);
  const normalizedRounds = Number(rounds);
  const normalizedReferees = Number(referees);
  if (!Number.isSafeInteger(normalizedRounds) || normalizedRounds < 1 || normalizedRounds > 20) {
    throw new Error('venue_migration_rounds_invalid');
  }
  if (!Number.isSafeInteger(normalizedReferees) || normalizedReferees < 1 || normalizedReferees > 20) {
    throw new Error('venue_migration_referees_invalid');
  }
  const sourcePaperContract = normalizeSourcePaperContract(row?.sourcePaperContract);
  const sourcePaperContractHash = sourcePaperContract
    ? hashRecord('VenueMigrationSourcePaperContract', sourcePaperContract)
    : null;
  const identityPayload = Object.freeze({
    version: VENUE_MIGRATION_CONTRACT_VERSION,
    kind: 'VenueMigrationCampaignIdentity',
    paperId,
    paperSemanticIdentityHash: task.semanticIdentityHash,
    sourceWorkspace: absolutePath(sourceWorkspace),
    sourceVenue: source,
    targetVenue: target,
    mode,
    rounds: normalizedRounds,
    referees: normalizedReferees,
    runId: text(runId),
  });
  const migrationKey = hashRecord('VenueMigrationCampaignIdentity', identityPayload);
  const campaignId = campaignIdFor({ paperId, runId, migrationKey });
  const workspaceRoot = absoluteJoin(runtimeRoot, 'campaign-attempt-workspaces', safeSegment(campaignId));
  // This is the campaign-level copy-on-write root.  It is intentionally
  // separate from the per-node attempt root: node attempts are allowed to
  // integrate their changes back into the campaign workspace, while the
  // canonical inventory workspace remains read-only throughout the run.
  const campaignWorkspaceRoot = absoluteJoin(
    runtimeRoot,
    'venue-migration-workspaces',
    safeSegment(runId || 'venue-migration'),
    safeSegment(paperId),
  );
  const bindingMarkerPath = absoluteJoin(
    runtimeRoot,
    'venue-migration-workspace-bindings',
    `${safeSegment(campaignId)}.json`,
  );
  const lockKey = hashRecord('VenueMigrationCampaignLock', Object.freeze({
    migrationKey,
    campaignId,
    sourceWorkspace: identityPayload.sourceWorkspace,
  }));
  const nodeKinds = Object.freeze([
    'compile',
    ...Array.from({ length: normalizedReferees }, (_, index) => `referee-${index + 1}`),
    'revise',
    'revalidate-compile',
    'revalidate-citations',
    'revalidate-artifacts',
    ...Array.from({ length: normalizedReferees }, (_, index) => `revision-referee-${index + 1}`),
    'convergence',
    'final-compile',
  ]);
  return Object.freeze({
    version: VENUE_MIGRATION_CONTRACT_VERSION,
    kind: 'VenueMigrationCampaignEntry',
    status: 'planned',
    paperId,
    title: text(task.title),
    sourceVenue: source,
    targetVenue: target,
    sourceVenueMatch: match,
    sourceWorkspace: identityPayload.sourceWorkspace,
    sourcePaperContract,
    sourcePaperContractHash,
    campaignId,
    migrationKey,
    idempotencyKey: migrationKey,
    lockKey,
    lockScope: `campaign:${campaignId}`,
    workspaceIsolation: Object.freeze({
      sourceWorkspace: identityPayload.sourceWorkspace,
      campaignWorkspaceRoot,
      attemptWorkspaceRoot: workspaceRoot,
      bindingMarkerPath,
      leaseScope: `campaign:${campaignId}`,
      sourceMutationPolicy: 'canonical_read_only',
      preparation: 'campaign_cow_then_worker_cow_clone_per_node_attempt',
    }),
    reviewPlan: Object.freeze({
      mode,
      rounds: normalizedRounds,
      referees: normalizedReferees,
      nodeKinds,
      externalSubmissionEnabled: false,
      networkUse: 'none',
    }),
  });
}

export function buildVenueMigrationManifest({
  rows = [],
  sourceVenue,
  targetVenue,
  runtimeRoot,
  runId = null,
  mode = 'local-review-loop',
  rounds = 3,
  referees = 3,
} = {}) {
  const entries = rows
    .filter((row) => sourceVenueMatch(row, sourceVenue).matched)
    .map((row) => buildVenueMigrationEntry({
      row, sourceVenue, targetVenue, runtimeRoot, runId, mode, rounds, referees,
    }))
    .sort((left, right) => left.paperId.localeCompare(right.paperId));
  const paperIds = entries.map((entry) => entry.paperId);
  if (new Set(paperIds).size !== paperIds.length) {
    throw new Error('venue_migration_duplicate_paper_id');
  }
  const payload = Object.freeze({
    version: VENUE_MIGRATION_CONTRACT_VERSION,
    kind: 'VenueMigrationCampaignManifest',
    status: entries.length ? 'venue_migration_manifest_ready' : 'venue_migration_manifest_empty',
    sourceVenue: text(sourceVenue),
    targetVenue: normalizeTargetVenue(targetVenue),
    mode,
    runId: text(runId),
    entryCount: entries.length,
    entries: Object.freeze(entries),
    externalSubmissionEnabled: false,
    networkUse: 'none',
  });
  return Object.freeze({
    ...payload,
    manifestHash: hashRecord('VenueMigrationCampaignManifest', payload),
  });
}

export function buildVenueMigrationReviewQueue(manifest, {
  observedAt = null,
  campaignPlans = [],
  workspaceBindings = [],
} = {}) {
  if (manifest?.kind !== 'VenueMigrationCampaignManifest' || !manifest?.manifestHash) {
    throw new Error('venue_migration_manifest_required');
  }
  const plansByPaper = new Map((campaignPlans || []).map((plan) => [plan.paperId, plan]));
  const bindingsByPaper = new Map((workspaceBindings || []).map((binding) => [binding.paperId, binding]));
  const queue = Object.freeze(manifest.entries.map((entry) => {
    const plan = plansByPaper.get(entry.paperId) || null;
    const binding = bindingsByPaper.get(entry.paperId) || null;
    if (plan && plan.campaignId !== entry.campaignId) {
      throw new Error(`venue_migration_campaign_id_mismatch:${entry.paperId}`);
    }
    return Object.freeze({
    paperId: entry.paperId,
    campaignId: entry.campaignId,
    campaignPlanHash: plan?.campaignPlanHash || null,
    idempotencyKey: entry.idempotencyKey,
    lockKey: entry.lockKey,
      sourceVenue: entry.sourceVenue,
      targetVenue: entry.targetVenue,
      sourcePaperProfile: entry.sourcePaperContract?.profile || null,
      sourcePaperContractHash: entry.sourcePaperContractHash || null,
      qualityBindingPolicy: entry.sourcePaperContract?.profile
        ? 'source_profile_recorded_requires_explicit_campaign_quality_binding'
        : 'source_profile_missing_review_required',
      status: entry.status,
    reviewMode: entry.reviewPlan.mode,
    rounds: entry.reviewPlan.rounds,
    referees: entry.reviewPlan.referees,
      expectedNodeKinds: entry.reviewPlan.nodeKinds,
      campaignWorkspaceRoot: entry.workspaceIsolation.campaignWorkspaceRoot,
      workspaceRoot: entry.workspaceIsolation.attemptWorkspaceRoot,
      sourceMutationPolicy: entry.workspaceIsolation.sourceMutationPolicy,
      workspaceBindingHash: binding?.venueMigrationWorkspaceBindingHash || null,
      workspaceStatus: binding?.status || 'planned_not_materialized',
      externalSubmissionEnabled: false,
    });
  }));
  const payload = Object.freeze({
    version: VENUE_MIGRATION_CONTRACT_VERSION,
    kind: 'VenueMigrationReviewQueue',
    status: 'venue_migration_review_queue_ready',
    manifestHash: manifest.manifestHash,
    observedAt: observedAt || null,
    queue,
    entryCount: queue.length,
    externalSubmissionEnabled: false,
    networkUse: 'none',
  });
  return Object.freeze({
    ...payload,
    reviewQueueHash: hashRecord('VenueMigrationReviewQueue', payload),
  });
}
