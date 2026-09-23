import {
  buildSubmitReadyPackagePlan,
  buildVenueResolutionOperatorPacket,
  buildVenueRegistryAddPlan,
  buildVenueResolutionPacket,
} from '../../paper-domain/contracts/intake-resolution.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';

function tokenSet(value) {
  return new Set(normalizeText(value).toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
}

function scoreVenue(row, venue) {
  const paperTokens = tokenSet([
    row.task.paperId,
    row.task.title,
    row.task.paperType,
    row.task.sourceWorkspace,
  ].filter(Boolean).join(' '));
  const venueTokens = tokenSet([
    venue.venue_id,
    venue.venueId,
    venue.name,
    venue.kind,
    venue.cycle,
  ].filter(Boolean).join(' '));
  let score = 0;
  const reasons = [];
  for (const token of venueTokens) {
    if (paperTokens.has(token)) {
      score += 20;
      reasons.push(`token_match:${token}`);
    }
  }
  const title = normalizeText(`${row.task.paperId} ${row.task.title}`).toLowerCase();
  if (/neurips|deep|dqn|dql|rl|optimization/.test(title) && /neurips/i.test(venue.name || venue.venue_id || '')) {
    score += 10;
    reasons.push('ml_venue_hint');
  }
  if (/control|operations|optimization/.test(title) && /operations/i.test(venue.name || '')) {
    score += 8;
    reasons.push('or_venue_hint');
  }
  return {
    ...venue,
    score,
    reason: reasons.join(', ') || 'registry_available_manual_review_required',
  };
}

function candidateVenues(row, venues = []) {
  return (venues || [])
    .map((venue) => scoreVenue(row, venue))
    .filter((venue) => venue.score > 0)
    .sort((left, right) => right.score - left.score || normalizeText(left.name).localeCompare(normalizeText(right.name)))
    .slice(0, 5);
}

export async function runVenueResolveAdapter({
  row,
  venues = [],
  packageResult = null,
} = {}) {
  const submissionIntent = row.submissionIntent || row.task.registry?.submissionIntent || null;
  const warnings = [];
  const blockers = [];
  const sourceReady = row.state.draftStatus === 'source_tex_present';
  const packageReady = packageResult?.artifactPackage
    ? packageResult.artifactPackage.submitReady === true
    : ['package_present', 'package_ready'].includes(row.state.packageStatus);
  if (submissionIntent?.status !== 'needs_venue_decision') warnings.push('venue_resolution_not_required_for_row');
  if (!sourceReady) blockers.push('source_not_ready_for_venue_resolution');
  if (!packageReady) blockers.push('package_not_submit_ready_for_venue_resolution');
  const candidates = candidateVenues(row, venues);
  const packet = buildVenueResolutionPacket({
    paperTask: row.task,
    submissionIntent,
    candidates,
    packageReady,
    sourceReady,
  });
  const submitReadyPackagePlan = buildSubmitReadyPackagePlan({
    paperTask: row.task,
    artifactPackage: packageResult?.artifactPackage || null,
    buildStatus: packageResult?.artifactPackage?.buildStatus || row.state.compileStatus,
    blockers: packageResult?.blockers || [],
    warnings: packageResult?.warnings || [],
  });
  const venueRegistryAddPlan = buildVenueRegistryAddPlan({
    paperTask: row.task,
    venueResolutionPacket: packet,
  });
  const venueResolutionOperatorPacket = buildVenueResolutionOperatorPacket({
    paperTask: row.task,
    venueResolutionPacket: packet,
    submitReadyPackagePlan,
    venueRegistryAddPlan,
  });
  const report = {
    version: 1,
    kind: 'VenueResolveAdapterReport',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: submissionIntent?.status === 'needs_venue_decision'
      ? packet.status
      : 'venue_resolution_not_required',
    venueResolutionRequired: submissionIntent?.status === 'needs_venue_decision',
    sourceReady,
    packageReady,
    candidateCount: packet.candidateCount,
    packet,
    submitReadyPackagePlan,
    venueRegistryAddPlan,
    venueResolutionOperatorPacket,
    blockers: uniqueStrings([...blockers, ...(packet.blockers || [])], 32),
    warnings: uniqueStrings([...warnings, ...(packet.warnings || [])], 32),
    safety: {
      readsOnly: true,
      writesRegistry: false,
      writesSqlite: false,
      externalActionPerformed: false,
    },
  };
  return { ...report, venueResolveAdapterReportHash: hashPaperRecord('VenueResolveAdapterReport', report) };
}
