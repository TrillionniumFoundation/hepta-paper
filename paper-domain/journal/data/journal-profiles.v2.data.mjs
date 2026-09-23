import {
  JOURNAL_PROFILES as V1_JOURNAL_PROFILES,
  PROFILE_POLICY_DEFAULTS as V1_PROFILE_POLICY_DEFAULTS,
  DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS,
  COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING as V1_DEADLINE_ROUTING,
} from './journal-profiles.v1.data.mjs';

const COMPOSITE_PROFILE_ID = 'colt_alt';
const compositeProfile = V1_JOURNAL_PROFILES.find(
  (profile) => profile.id === COMPOSITE_PROFILE_ID,
);
const compositePolicy = V1_PROFILE_POLICY_DEFAULTS[COMPOSITE_PROFILE_ID];
const compositeDeadlineRouting = V1_DEADLINE_ROUTING[COMPOSITE_PROFILE_ID];

if (!compositeProfile || !compositePolicy || !compositeDeadlineRouting) {
  throw new Error('journal_profile_v2_composite_source_missing');
}

function splitProfile({ id, label, aliases, identityKeyword }) {
  return Object.freeze({
    ...compositeProfile,
    id,
    label,
    aliases: Object.freeze([...aliases]),
    keywords: Object.freeze([
      identityKeyword,
      ...compositeProfile.keywords,
    ]),
    requirements: Object.freeze([...compositeProfile.requirements]),
    rubric: Object.freeze([...compositeProfile.rubric]),
  });
}

const SPLIT_PROFILES = Object.freeze([
  splitProfile({
    id: 'colt',
    label: 'COLT (Conference on Learning Theory)',
    aliases: ['colt', 'conference on learning theory'],
    identityKeyword: 'conference on learning theory',
  }),
  splitProfile({
    id: 'alt',
    label: 'ALT (Algorithmic Learning Theory)',
    aliases: ['alt', 'algorithmic learning theory'],
    identityKeyword: 'algorithmic learning theory',
  }),
]);

export const JOURNAL_PROFILES = Object.freeze(
  V1_JOURNAL_PROFILES.flatMap((profile) => (
    profile.id === COMPOSITE_PROFILE_ID ? SPLIT_PROFILES : [profile]
  )),
);

const {
  [COMPOSITE_PROFILE_ID]: _retiredCompositePolicy,
  ...retainedPolicyDefaults
} = V1_PROFILE_POLICY_DEFAULTS;

function splitPolicy() {
  return Object.freeze({
    ...compositePolicy,
    template: 'learning_theory_conference',
    disciplineTags: Object.freeze([...compositePolicy.disciplineTags]),
    evidenceRequirements: Object.freeze([...compositePolicy.evidenceRequirements]),
    deskRejectRules: Object.freeze([...compositePolicy.deskRejectRules]),
  });
}

export const PROFILE_POLICY_DEFAULTS = Object.freeze({
  ...retainedPolicyDefaults,
  colt: splitPolicy(),
  alt: splitPolicy(),
});

const {
  [COMPOSITE_PROFILE_ID]: _retiredCompositeDeadlineRouting,
  ...retainedDeadlineRouting
} = V1_DEADLINE_ROUTING;

function splitDeadlineRouting() {
  return Object.freeze({
    journalFallbackIds: Object.freeze([
      ...compositeDeadlineRouting.journalFallbackIds,
    ]),
  });
}

export const COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING = Object.freeze({
  ...retainedDeadlineRouting,
  colt: splitDeadlineRouting(),
  alt: splitDeadlineRouting(),
});

export { DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS };

export const RETIRED_AMBIGUOUS_JOURNAL_PROFILE_IDENTIFIERS = Object.freeze([
  'colt_alt',
  'colt/alt',
  'colt alt',
  'colt-alt',
  'colt/alt candidate',
]);

export const JOURNAL_PROFILE_DATA_REQUIREMENTS = Object.freeze({
  version: 2,
  retiredProfileIds: Object.freeze(['colt_alt']),
  requiredProfileIds: Object.freeze(['colt', 'alt']),
  requiredPolicyProfileIds: Object.freeze(['colt', 'alt']),
  requiredDeadlineRouteProfileIds: Object.freeze(['colt', 'alt']),
});
