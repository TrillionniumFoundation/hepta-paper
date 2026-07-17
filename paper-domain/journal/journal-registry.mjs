import {
  JOURNAL_PROFILES as RAW_JOURNAL_PROFILES,
  PROFILE_POLICY_DEFAULTS as RAW_PROFILE_POLICY_DEFAULTS,
  DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS as RAW_DEADLINE_THRESHOLD_DAYS,
  COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING as RAW_DEADLINE_ROUTING,
} from './data/journal-profiles.v1.data.mjs';

export const JOURNAL_PROFILE_DATA_VERSION = 1;

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

export function validateJournalProfileDataset({
  profiles = RAW_JOURNAL_PROFILES,
  policyDefaults = RAW_PROFILE_POLICY_DEFAULTS,
  deadlineRouting = RAW_DEADLINE_ROUTING,
} = {}) {
  const issues = [];
  if (!Array.isArray(profiles)) issues.push('profiles_array_required');
  const rows = Array.isArray(profiles) ? profiles : [];
  rows.forEach((profile, index) => issues.push(...validateProfile(profile, index)));
  const ids = rows.map((profile) => profile.id);
  if (new Set(ids).size !== ids.length) issues.push('profile_ids_must_be_unique');
  if (!policyDefaults || typeof policyDefaults !== 'object' || Array.isArray(policyDefaults)) {
    issues.push('profile_policy_defaults_object_required');
  }
  if (!deadlineRouting || typeof deadlineRouting !== 'object' || Array.isArray(deadlineRouting)) {
    issues.push('deadline_routing_object_required');
  }
  for (const [profileId, route] of Object.entries(deadlineRouting || {})) {
    if (!ids.includes(profileId)) issues.push(`deadline_route_unknown_profile:${profileId}`);
    if (route?.deadlineCalendar !== undefined && !Array.isArray(route.deadlineCalendar)) {
      issues.push(`deadline_route_calendar_invalid:${profileId}`);
    }
    if (route?.journalFallbackIds !== undefined && !Array.isArray(route.journalFallbackIds)) {
      issues.push(`deadline_route_fallbacks_invalid:${profileId}`);
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

export const JOURNAL_PROFILE_DATASET = Object.freeze({
  version: JOURNAL_PROFILE_DATA_VERSION,
  kind: 'JournalProfileDataset',
  profiles: JOURNAL_PROFILES,
  policyDefaults: PROFILE_POLICY_DEFAULTS,
  defaultConferenceDeadlineThresholdDays: DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS,
  computerScienceConferenceDeadlineRouting: COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING,
  validation: JOURNAL_PROFILE_DATASET_VALIDATION,
});
