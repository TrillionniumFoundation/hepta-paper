import { buildVenueSubmissionPlan } from '../../paper-domain/contracts/index.mjs';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';

function matchVenue(venues = [], target = '') {
  const normalized = normalizeText(target).toLowerCase();
  if (!normalized) return null;
  return venues.find((venue) => normalizeText(venue.name).toLowerCase() === normalized)
    || venues.find((venue) => normalized.includes(normalizeText(venue.name).toLowerCase()))
    || venues.find((venue) => normalizeText(venue.venue_id).toLowerCase() === normalized)
    || null;
}

export function buildSubmissionVenuePlan({
  row,
  venues = [],
  artifactPackage = null,
  mode = 'local-dry-run',
} = {}) {
  const venue = row.venue || matchVenue(venues, row.task.venueTarget);
  return buildVenueSubmissionPlan({
    paperTask: row.task,
    venue,
    artifactPackage,
    mode,
    warnings: venue ? [] : ['venue_registry_match_missing'],
  });
}
