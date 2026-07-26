import {
  JOURNAL_PROFILES as RAW_JOURNAL_PROFILES,
  PROFILE_POLICY_DEFAULTS as RAW_PROFILE_POLICY_DEFAULTS,
  DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS as RAW_DEADLINE_THRESHOLD_DAYS,
  COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING as RAW_DEADLINE_ROUTING,
  JOURNAL_PROFILE_DATA_REQUIREMENTS as RAW_DATA_REQUIREMENTS,
  RETIRED_AMBIGUOUS_JOURNAL_PROFILE_IDENTIFIERS,
} from './data/journal-profiles.v2.data.mjs';

export const JOURNAL_PROFILE_DATA_VERSION = 2;

export const JOURNAL_PROFILE_SCHEMA_V1 = Object.freeze({
  required: Object.freeze(['id', 'label', 'kind', 'aliases', 'keywords', 'requirements', 'rubric']),
  kinds: Object.freeze(['conference', 'journal']),
  arrayFields: Object.freeze(['aliases', 'keywords', 'requirements', 'rubric']),
});

function validateProfile(profile, index) {
  const issues = [];
  for (const field of JOURNAL_PROFILE_SCHEMA_V1.required) {
    if (profile?.[field] === undefined || profile?.[field] === null) issues.push(`profile_${index}:${field}_required`);
  }
  if (!/^[a-z0-9][a-z0-9_]{1,63}$/.test(String(profile?.id || ''))) issues.push(`profile_${index}:id_invalid`);
  if (!JOURNAL_PROFILE_SCHEMA_V1.kinds.includes(profile?.kind)) issues.push(`profile_${index}:kind_invalid`);
  for (const field of JOURNAL_PROFILE_SCHEMA_V1.arrayFields) {
    if (!Array.isArray(profile?.[field]) || profile[field].some((item) => typeof item !== 'string' || !item.trim())) {
      issues.push(`profile_${index}:${field}_invalid`);
    }
  }
  return issues;
}

function validDeadlineCalendarEntry(entry) {
  const month = Number(entry?.month);
  const day = Number(entry?.day);
  if (!Number.isInteger(month) || month < 1 || month > 12
    || !Number.isInteger(day) || day < 1 || day > 31) return false;
  const candidate = new Date(Date.UTC(2000, month - 1, day));
  return candidate.getUTCFullYear() === 2000
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

export function validateJournalProfileDataset({
  profiles = RAW_JOURNAL_PROFILES,
  policyDefaults = RAW_PROFILE_POLICY_DEFAULTS,
  deadlineRouting = RAW_DEADLINE_ROUTING,
  dataRequirements = RAW_DATA_REQUIREMENTS,
} = {}) {
  const issues = [];
  if (!Array.isArray(profiles)) issues.push('profiles_array_required');
  const rows = Array.isArray(profiles) ? profiles : [];
  rows.forEach((profile, index) => issues.push(...validateProfile(profile, index)));
  const ids = rows.map((profile) => profile.id);
  const profilesById = new Map(rows.map((profile) => [profile.id, profile]));
  if (new Set(ids).size !== ids.length) issues.push('profile_ids_must_be_unique');
  if (!policyDefaults || typeof policyDefaults !== 'object' || Array.isArray(policyDefaults)) {
    issues.push('profile_policy_defaults_object_required');
  }
  if (!deadlineRouting || typeof deadlineRouting !== 'object' || Array.isArray(deadlineRouting)) {
    issues.push('deadline_routing_object_required');
  }
  for (const profileId of Object.keys(policyDefaults || {})) {
    if (!ids.includes(profileId)) issues.push(`profile_policy_unknown_profile:${profileId}`);
  }
  for (const [profileId, route] of Object.entries(deadlineRouting || {})) {
    if (!ids.includes(profileId)) issues.push(`deadline_route_unknown_profile:${profileId}`);
    if (route?.deadlineCalendar !== undefined && !Array.isArray(route.deadlineCalendar)) {
      issues.push(`deadline_route_calendar_invalid:${profileId}`);
    }
    if (Array.isArray(route?.deadlineCalendar)
      && route.deadlineCalendar.some((entry) => !validDeadlineCalendarEntry(entry))) {
      issues.push(`deadline_route_calendar_invalid:${profileId}`);
    }
    if (route?.deadlineCadence !== undefined
      && !['annual', 'monthly'].includes(route.deadlineCadence)) {
      issues.push(`deadline_route_cadence_invalid:${profileId}`);
    }
    if (route?.deadlineCadence === 'monthly'
      && (!Number.isInteger(Number(route.recurringDayOfMonth))
        || Number(route.recurringDayOfMonth) < 1
        || Number(route.recurringDayOfMonth) > 28)) {
      issues.push(`deadline_route_recurring_day_invalid:${profileId}`);
    }
    if (route?.journalFallbackIds !== undefined && !Array.isArray(route.journalFallbackIds)) {
      issues.push(`deadline_route_fallbacks_invalid:${profileId}`);
    }
    for (const fallbackId of Array.isArray(route?.journalFallbackIds)
      ? route.journalFallbackIds : []) {
      if (!profilesById.has(fallbackId)) {
        issues.push(`deadline_route_fallback_unknown:${profileId}:${fallbackId}`);
      } else if (profilesById.get(fallbackId).kind !== 'journal') {
        issues.push(`deadline_route_fallback_not_journal:${profileId}:${fallbackId}`);
      }
    }
  }
  for (const profile of rows.filter((row) => row.kind === 'conference')) {
    if (!deadlineRouting?.[profile.id]) {
      issues.push(`conference_deadline_route_required:${profile.id}`);
    }
  }
  for (const profileId of dataRequirements?.retiredProfileIds || []) {
    if (ids.includes(profileId)) issues.push(`retired_composite_profile_forbidden:${profileId}`);
  }
  for (const profileId of dataRequirements?.requiredProfileIds || []) {
    if (!ids.includes(profileId)) issues.push(`split_profile_required:${profileId}`);
  }
  for (const profileId of dataRequirements?.requiredPolicyProfileIds || []) {
    if (!policyDefaults?.[profileId]) issues.push(`split_profile_policy_required:${profileId}`);
  }
  for (const profileId of dataRequirements?.requiredDeadlineRouteProfileIds || []) {
    if (!deadlineRouting?.[profileId]) {
      issues.push(`split_profile_deadline_route_required:${profileId}`);
    }
  }
  return Object.freeze({
    version: 1,
    kind: 'JournalProfileDatasetValidation',
    status: issues.length ? 'journal_profile_dataset_blocked' : 'journal_profile_dataset_valid',
    profileCount: rows.length,
    issues: Object.freeze([...new Set(issues)]),
  });
}

export const JOURNAL_PROFILE_DATASET_VALIDATION = validateJournalProfileDataset();
if (JOURNAL_PROFILE_DATASET_VALIDATION.status !== 'journal_profile_dataset_valid') {
  throw new Error(`Invalid journal profile dataset: ${JOURNAL_PROFILE_DATASET_VALIDATION.issues.join(',')}`);
}

export const JOURNAL_PROFILES = RAW_JOURNAL_PROFILES;
export const PROFILE_POLICY_DEFAULTS = RAW_PROFILE_POLICY_DEFAULTS;
export const DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS = RAW_DEADLINE_THRESHOLD_DAYS;
export const COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING = RAW_DEADLINE_ROUTING;
export const JOURNAL_PROFILE_DATA_REQUIREMENTS = RAW_DATA_REQUIREMENTS;
export { RETIRED_AMBIGUOUS_JOURNAL_PROFILE_IDENTIFIERS };

export const JOURNAL_PROFILE_DATASET = Object.freeze({
  version: JOURNAL_PROFILE_DATA_VERSION,
  kind: 'JournalProfileDataset',
  profiles: JOURNAL_PROFILES,
  policyDefaults: PROFILE_POLICY_DEFAULTS,
  dataRequirements: JOURNAL_PROFILE_DATA_REQUIREMENTS,
  defaultConferenceDeadlineThresholdDays: DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS,
  computerScienceConferenceDeadlineRouting: COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING,
  validation: JOURNAL_PROFILE_DATASET_VALIDATION,
});
