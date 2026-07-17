import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING, DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS, JOURNAL_PROFILES, PROFILE_POLICY_DEFAULTS } from './journal-registry.mjs';

function tokenText(values = []) {
  return values.map((value) => normalizeText(value).toLowerCase()).filter(Boolean).join(' ');
}

function profileScore(profile, text, tokens) {
  const values = [
    profile.id,
    profile.label,
    ...(profile.aliases || []),
    ...(profile.keywords || []),
  ];
  return values.reduce((sum, value) => {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized) return sum;
    if (/^[a-z0-9]+$/.test(normalized)) return sum + (tokens.has(normalized) ? 2 : 0);
    return sum + (text.includes(normalized) ? 2 : 0);
  }, 0);
}

export function resolveJournalProfile({ target = null, hints = [], fallbackId = 'neurips' } = {}) {
  const text = tokenText([target, ...hints]);
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const scored = JOURNAL_PROFILES.map((profile) => ({
    profile,
    score: profileScore(profile, text, tokens),
  })).sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id));
  return scored.find((item) => item.score > 0)?.profile
    || JOURNAL_PROFILES.find((profile) => profile.id === fallbackId)
    || JOURNAL_PROFILES[0];
}

function defaultJournalFallbackIds(profile = {}) {
  if (profile.kind !== 'conference') return [];
  const profileText = tokenText([
    profile.id,
    profile.label,
    ...(profile.keywords || []),
  ]);
  const profileTokens = new Set(profileText.split(/[^a-z0-9]+/).filter(Boolean));
  const journalScores = JOURNAL_PROFILES
    .filter((candidate) => candidate.kind === 'journal')
    .map((candidate, index) => ({
      id: candidate.id,
      score: profileScore(candidate, profileText, profileTokens),
      order: index,
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, 3)
    .map((item) => item.id);
  return uniqueStrings([...journalScores, 'jmlr', 'jacm'], 5);
}

function withConferenceDeadlineRouting(profile = {}, policy = {}) {
  if (profile.kind !== 'conference') return policy;
  const deadlineRouting = COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING[profile.id] || {};
  return {
    ...policy,
    deadlinePolicy: policy.deadlinePolicy || 'conference_deadline_required_before_live_submission',
    deadlineRouting: {
      kind: 'ComputerScienceConferenceDeadlineRoutingPolicy',
      computerScienceConference: true,
      agentJudged: true,
      routeWhenDeadlineTooFar: true,
      longHorizonThresholdDays: Number(deadlineRouting.longHorizonThresholdDays)
        || DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS,
      deadlineCadence: deadlineRouting.deadlineCadence || 'annual',
      recurringDayOfMonth: deadlineRouting.recurringDayOfMonth || null,
      deadlineCalendar: deadlineRouting.deadlineCalendar || [],
      journalFallbackIds: uniqueStrings(
        deadlineRouting.journalFallbackIds || defaultJournalFallbackIds(profile),
        8,
      ),
      explicitTargetDoesNotAutoRetarget: true,
      judgementBasis: [
        'profile_deadline_calendar',
        'days_until_next_deadline',
        'same_field_journal_fallback_fit',
        'operator_target_lock',
      ],
    },
  };
}

function profilePolicy(profile = {}) {
  const policy = PROFILE_POLICY_DEFAULTS[profile.id] || {
    disciplineTags: profile.keywords || [],
    template: `${profile.id || 'journal'}_template`,
    pageLimit: profile.kind === 'journal' ? 'journal_manuscript_with_appendix' : 'conference_format',
    anonymity: 'venue_specific',
    deadlinePolicy: 'venue_policy_required_before_live_submission',
    reviewStyle: 'venue_specific_referee_review',
    evidenceRequirements: ['real_research_evidence', 'clear_claim_scope', 'reproducibility_or_proof_support'],
    deskRejectRules: ['target_scope_mismatch', 'unsupported_core_claim'],
    liveSubmissionBoundary: 'controlled_receipt_only_until_live_adapter_exists',
  };
  return withConferenceDeadlineRouting(profile, policy);
}

function enrichProfile(profile = {}) {
  const policy = profilePolicy(profile);
  return {
    ...profile,
    policy,
    requirements: uniqueStrings([...(profile.requirements || []), ...(policy.evidenceRequirements || [])], 32),
  };
}

function normalizeAsOfDate(value = null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function deadlineDate(year, entry = {}) {
  const month = Number(entry.month);
  const day = Number(entry.day);
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
}

function nextMonthlyDeadline({ asOf, recurringDayOfMonth = 1 } = {}) {
  const day = Math.max(1, Math.min(28, Number(recurringDayOfMonth) || 1));
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth();
  for (let offset = 0; offset <= 18; offset += 1) {
    const candidate = new Date(Date.UTC(year, month + offset, day, 23, 59, 59));
    if (candidate.getTime() >= asOf.getTime()) {
      return {
        date: candidate,
        label: `estimated monthly deadline day ${day}`,
      };
    }
  }
  return null;
}

function nextAnnualDeadline({ asOf, calendar = [] } = {}) {
  const year = asOf.getUTCFullYear();
  const candidates = [];
  for (let yearOffset = 0; yearOffset <= 2; yearOffset += 1) {
    for (const entry of calendar || []) {
      const candidate = deadlineDate(year + yearOffset, entry);
      if (candidate && candidate.getTime() >= asOf.getTime()) {
        candidates.push({
          date: candidate,
          label: entry.label || 'estimated annual deadline',
        });
      }
    }
  }
  return candidates.sort((left, right) => left.date.getTime() - right.date.getTime())[0] || null;
}

function daysUntilDeadline(asOf, deadline) {
  if (!deadline) return null;
  const milliseconds = deadline.getTime() - asOf.getTime();
  return Math.max(0, Math.ceil(milliseconds / (24 * 60 * 60 * 1000)));
}

function deadlineAssessmentForProfile({ profile = {}, createdAt = null } = {}) {
  const deadlineRouting = profile.policy?.deadlineRouting || null;
  if (!deadlineRouting?.computerScienceConference) {
    return {
      status: 'deadline_routing_not_applicable',
      evaluated: false,
    };
  }
  const asOf = normalizeAsOfDate(createdAt);
  if (!asOf) {
    return {
      status: 'deadline_routing_reference_time_missing',
      evaluated: false,
    };
  }
  const nextDeadline = deadlineRouting.deadlineCadence === 'monthly'
    ? nextMonthlyDeadline({
      asOf,
      recurringDayOfMonth: deadlineRouting.recurringDayOfMonth,
    })
    : nextAnnualDeadline({
      asOf,
      calendar: deadlineRouting.deadlineCalendar,
    });
  const daysToDeadline = daysUntilDeadline(asOf, nextDeadline?.date || null);
  const thresholdDays = Number(deadlineRouting.longHorizonThresholdDays)
    || DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS;
  const tooFar = Number.isFinite(daysToDeadline) && daysToDeadline > thresholdDays;
  return {
    status: tooFar
      ? 'conference_deadline_too_far'
      : 'conference_deadline_within_agent_window',
    evaluated: true,
    evaluatedAt: asOf.toISOString(),
    thresholdDays,
    daysToDeadline,
    nextDeadline: nextDeadline
      ? {
        date: nextDeadline.date.toISOString().slice(0, 10),
        label: nextDeadline.label,
      }
      : null,
    deadlineCadence: deadlineRouting.deadlineCadence,
    routeWhenDeadlineTooFar: deadlineRouting.routeWhenDeadlineTooFar === true,
    journalFallbackIds: deadlineRouting.journalFallbackIds || [],
  };
}

function rankedItemForProfile(profile, ranked = []) {
  const rankedItem = ranked.find((item) => item.profile.id === profile.id);
  if (rankedItem) return rankedItem;
  return {
    profile,
    score: 0,
    fitScore: 45,
    order: Number.MAX_SAFE_INTEGER,
  };
}

function chooseJournalFallback({ conferenceItem = null, ranked = [], registry = null } = {}) {
  const profiles = registry?.profiles || JOURNAL_PROFILES.map((profile) => enrichProfile(profile));
  const fallbackIds = conferenceItem?.profile?.policy?.deadlineRouting?.journalFallbackIds || [];
  const fallbackItems = fallbackIds
    .map((journalId, index) => {
      const profile = profiles.find((candidate) => candidate.id === journalId && candidate.kind === 'journal');
      if (!profile) return null;
      const rankedItem = rankedItemForProfile(profile, ranked);
      return {
        ...rankedItem,
        fallbackOrder: index,
        agentFallbackScore: rankedItem.score * 2 + (fallbackIds.length - index),
      };
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.agentFallbackScore - left.agentFallbackScore
      || right.fitScore - left.fitScore
      || left.fallbackOrder - right.fallbackOrder
    ));
  return fallbackItems[0]
    || ranked.find((item) => item.profile.kind === 'journal' && item.score > 0)
    || null;
}

function buildAgentDeadlineRoutingDecision({
  primaryItem = null,
  ranked = [],
  registry = null,
  resolvedTarget = '',
  createdAt = null,
} = {}) {
  const initialProfile = primaryItem?.profile || null;
  const initialAssessment = deadlineAssessmentForProfile({ profile: initialProfile, createdAt });
  const explicitTarget = Boolean(resolvedTarget);
  if (!initialProfile || initialProfile.kind !== 'conference' || !initialAssessment.evaluated) {
    return {
      kind: 'AgentDeadlineRoutingDecision',
      status: 'deadline_routing_not_applicable',
      routeApplied: false,
      selectedItem: primaryItem,
      initialTarget: initialProfile
        ? { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind }
        : null,
      deadlineAssessment: initialAssessment,
      rationale: ['primary target is not a CS conference with deadline-routing metadata'],
    };
  }
  if (explicitTarget) {
    return {
      kind: 'AgentDeadlineRoutingDecision',
      status: 'explicit_target_preserved_deadline_risk_recorded',
      routeApplied: false,
      selectedItem: primaryItem,
      initialTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      selectedTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      deadlineAssessment: initialAssessment,
      rationale: [
        'operator requested a target venue, so agent records deadline risk without retargeting',
      ],
    };
  }
  const shouldRouteToJournal = initialAssessment.status === 'conference_deadline_too_far'
    && initialAssessment.routeWhenDeadlineTooFar;
  if (!shouldRouteToJournal) {
    return {
      kind: 'AgentDeadlineRoutingDecision',
      status: 'conference_deadline_within_agent_window',
      routeApplied: false,
      selectedItem: primaryItem,
      initialTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      selectedTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      deadlineAssessment: initialAssessment,
      rationale: ['conference deadline is close enough to keep the conference route'],
    };
  }
  const fallbackItem = chooseJournalFallback({ conferenceItem: primaryItem, ranked, registry });
  if (!fallbackItem) {
    return {
      kind: 'AgentDeadlineRoutingDecision',
      status: 'conference_deadline_too_far_no_journal_fallback',
      routeApplied: false,
      selectedItem: primaryItem,
      initialTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      selectedTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
      deadlineAssessment: initialAssessment,
      rationale: ['conference deadline is too far but no same-field journal fallback was available'],
    };
  }
  return {
    kind: 'AgentDeadlineRoutingDecision',
    status: 'conference_deadline_too_far_rerouted_to_journal',
    routeApplied: true,
    selectedItem: fallbackItem,
    initialTarget: { journalId: initialProfile.id, label: initialProfile.label, kind: initialProfile.kind },
    selectedTarget: {
      journalId: fallbackItem.profile.id,
      label: fallbackItem.profile.label,
      kind: fallbackItem.profile.kind,
    },
    deadlineAssessment: initialAssessment,
    journalFallbackConsidered: initialProfile.policy?.deadlineRouting?.journalFallbackIds || [],
    rationale: [
      `conference deadline is ${initialAssessment.daysToDeadline} days away, beyond ${initialAssessment.thresholdDays} day agent window`,
      `agent selected same-field journal fallback ${fallbackItem.profile.label}`,
    ],
  };
}

function rankProfiles({ target = null, hints = [], registry = null } = {}) {
  const profiles = registry?.profiles || JOURNAL_PROFILES.map((profile) => enrichProfile(profile));
  const text = tokenText([target, ...hints]);
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const targetText = normalizeText(target).toLowerCase();
  const broadJournalAutoSignal = /\b(broad impact|broad interest|interdisciplinary|scientific discovery|high impact|general audience|general interest)\b/.test(text);
  const csConferenceAutoSignal = /\b(computer science|artificial intelligence|ai|machine learning|deep learning|systems?|security|database|vision|nlp|graphics|architecture|programming language|software engineering|robotics)\b/.test(text);
  return profiles.map((profile, index) => {
    const broadGeneralJournalAutoSuppressed = !targetText
      && ['nature', 'science'].includes(profile.id)
      && !broadJournalAutoSignal;
    const baseScore = broadGeneralJournalAutoSuppressed ? 0 : profileScore(profile, text, tokens);
    const policyScore = (profile.policy?.disciplineTags || []).reduce((sum, tag) => {
      const normalized = normalizeText(tag).toLowerCase().replace(/_/g, ' ');
      return sum + (normalized && text.includes(normalized) ? 1 : 0);
    }, 0);
    const targetAliases = [
      profile.id,
      profile.label,
      ...(profile.aliases || []),
    ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
    const exactTargetBonus = targetText && targetAliases.includes(targetText) ? 10 : 0;
    const targetContainsBonus = targetText && targetAliases.some((alias) => (
      alias.length > 4 && (targetText.includes(alias) || alias.includes(targetText))
    )) ? 4 : 0;
    const conferenceAutoBonus = !targetText && csConferenceAutoSignal && profile.kind === 'conference' ? 1 : 0;
    const score = baseScore + policyScore + exactTargetBonus + conferenceAutoBonus;
    return {
      profile,
      score: score + targetContainsBonus,
      fitScore: Math.max(0, Math.min(100, 35 + (score + targetContainsBonus) * 10)),
      order: index,
    };
  }).sort((left, right) => right.score - left.score || left.order - right.order);
}


export { tokenText, profileScore, defaultJournalFallbackIds, withConferenceDeadlineRouting, profilePolicy, enrichProfile, normalizeAsOfDate, deadlineDate, nextMonthlyDeadline, nextAnnualDeadline, daysUntilDeadline, deadlineAssessmentForProfile, rankedItemForProfile, chooseJournalFallback, buildAgentDeadlineRoutingDecision, rankProfiles };
