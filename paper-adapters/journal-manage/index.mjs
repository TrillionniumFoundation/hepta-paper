import path from 'node:path';
import {
  ensureDir,
  normalizeText,
  nowIso,
  relativePath,
  uniqueStrings,
} from '../../paper-core/src/utils.mjs';
import { writeJsonFile } from '../artifacts/write-artifact.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contracts.mjs';
import {
  academicEvidenceReady,
  reviewAuthorityBlockers,
} from './review-authority.mjs';

import {
  COMPUTER_SCIENCE_CONFERENCE_DEADLINE_ROUTING,
  DEFAULT_CONFERENCE_DEADLINE_THRESHOLD_DAYS,
  JOURNAL_PROFILES,
  PROFILE_POLICY_DEFAULTS,
} from './journal-registry.mjs';
export { JOURNAL_PROFILES } from './journal-registry.mjs';

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
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date();
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

export function buildJournalConferenceRegistry({
  profiles = JOURNAL_PROFILES,
  createdAt = null,
} = {}) {
  const enrichedProfiles = profiles.map((profile) => enrichProfile(profile));
  const packet = {
    version: 1,
    kind: 'JournalConferenceRegistry',
    status: enrichedProfiles.length ? 'journal_conference_registry_ready' : 'journal_conference_registry_blocked',
    profileCount: enrichedProfiles.length,
    journalCount: enrichedProfiles.filter((profile) => profile.kind === 'journal').length,
    conferenceCount: enrichedProfiles.filter((profile) => profile.kind === 'conference').length,
    profileIds: enrichedProfiles.map((profile) => profile.id),
    profiles: enrichedProfiles,
    safety: {
      localOnly: true,
      generatedFromStaticProfiles: true,
      writesLegacyRegistry: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    journalConferenceRegistryHash: hashPaperRecord('JournalConferenceRegistry', packet),
  };
}

export function buildTargetSelectionPolicy({
  paperTask = null,
  target = null,
  hints = [],
  registry = null,
  fallbackId = 'neurips',
  createdAt = null,
} = {}) {
  const resolvedTarget = normalizeText(target || paperTask?.venueTarget || '');
  const blockers = [];
  const ranked = rankProfiles({
    target: resolvedTarget,
    hints: [paperTask?.title, paperTask?.paperType, paperTask?.paperId, ...(hints || [])],
    registry,
  });
  const fallbackProfile = registry?.profiles?.find((profile) => profile.id === fallbackId)
    || enrichProfile(JOURNAL_PROFILES.find((profile) => profile.id === fallbackId) || JOURNAL_PROFILES[0]);
  const primaryBeforeDeadline = ranked.find((item) => item.score > 0)
    || { profile: fallbackProfile, score: 0, fitScore: 35 };
  const deadlineRoutingDecision = buildAgentDeadlineRoutingDecision({
    primaryItem: primaryBeforeDeadline,
    ranked,
    registry,
    resolvedTarget,
    createdAt,
  });
  const primary = deadlineRoutingDecision.selectedItem || primaryBeforeDeadline;
  if (!primary?.profile?.id) blockers.push('target_selection_profile_missing');
  const backupTargets = ranked
    .filter((item) => item.profile.id !== primary.profile.id)
    .filter((item) => item.score > 0 || resolvedTarget)
    .slice(0, 3)
    .map((item) => ({
      journalId: item.profile.id,
      label: item.profile.label,
      kind: item.profile.kind,
      fitScore: item.fitScore,
      rationale: `backup target matched ${item.score} venue/domain signals`,
    }));
  const {
    selectedItem: _deadlineSelectedItem,
    ...deadlineRoutingDecisionPacket
  } = deadlineRoutingDecision;
  const riskLevel = primary.fitScore >= 75 ? 'low' : primary.fitScore >= 55 ? 'medium' : 'high';
  const selectionMode = resolvedTarget ? 'operator_requested_target' : 'agent_auto_selected_from_idea';
  const packet = {
    version: 1,
    kind: 'TargetSelectionPolicy',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'target_selection_policy_blocked' : 'target_selection_policy_ready',
    requestedTarget: resolvedTarget || null,
    selectionMode,
    autoSelected: !resolvedTarget,
    journalConferenceRegistryHash: registry?.journalConferenceRegistryHash || null,
    primaryTarget: {
      journalId: primary.profile.id,
      label: primary.profile.label,
      kind: primary.profile.kind,
      fitScore: primary.fitScore,
      riskLevel,
      profile: primary.profile,
    },
    preDeadlinePrimaryTarget: {
      journalId: primaryBeforeDeadline.profile.id,
      label: primaryBeforeDeadline.profile.label,
      kind: primaryBeforeDeadline.profile.kind,
      fitScore: primaryBeforeDeadline.fitScore,
    },
    backupTargets,
    agentDeadlineRoutingDecision: deadlineRoutingDecisionPacket,
    rationale: [
      resolvedTarget ? `proposal requested target ${resolvedTarget}` : 'target auto-selected from proposal idea and discipline',
      `primary target selected by ${primary.score} venue/domain signals`,
      deadlineRoutingDecision.routeApplied
        ? `agent deadline routing changed primary target from ${primaryBeforeDeadline.profile.label} to ${primary.profile.label}`
        : `agent deadline routing status ${deadlineRoutingDecision.status}`,
      `risk level ${riskLevel} from fit score ${primary.fitScore}`,
    ],
    lock: {
      requiredAtProposalStage: true,
      lockedForAutopilot: blockers.length === 0,
      retargetRequiresNewProposalGate: true,
      targetSelectionMode: selectionMode,
    },
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      deterministicSelection: true,
      agentDeadlineRouting: true,
      regexDeadlineRouting: false,
      modelCallPerformed: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    targetSelectionPolicyHash: hashPaperRecord('TargetSelectionPolicy', packet),
  };
}

export function buildJournalTargetProfile({
  paperTask = null,
  target = null,
  hints = [],
  registry = null,
  targetSelectionPolicy = null,
  fallbackId = 'neurips',
  createdAt = null,
} = {}) {
  const resolvedTarget = normalizeText(
    target || paperTask?.venueTarget || targetSelectionPolicy?.primaryTarget?.label || '',
  );
  const blockers = [];
  if (!resolvedTarget) blockers.push('target_journal_required');
  if (targetSelectionPolicy?.status && targetSelectionPolicy.status !== 'target_selection_policy_ready') {
    blockers.push('target_selection_policy_not_ready');
  }
  const profile = targetSelectionPolicy?.primaryTarget?.profile
    || enrichProfile(resolveJournalProfile({
      target: resolvedTarget,
      hints: [
        paperTask?.title,
        paperTask?.paperType,
        paperTask?.paperId,
        ...(hints || []),
      ],
      fallbackId,
    }));
  const packet = {
    version: 1,
    kind: 'JournalTargetProfile',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: blockers.length ? 'journal_target_profile_blocked' : 'journal_target_profile_ready',
    requestedTarget: resolvedTarget || null,
    journalConferenceRegistryHash: registry?.journalConferenceRegistryHash || null,
    targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || null,
    profile,
    requirements: profile.requirements || [],
    rubric: profile.rubric || [],
    venuePolicy: profile.policy || profilePolicy(profile),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      readsRegistryOnly: true,
      writesLegacyRegistry: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    journalTargetProfileHash: hashPaperRecord('JournalTargetProfile', packet),
  };
}

export function buildJournalRubricPacket({
  paperTask = null,
  targetProfile,
  targetSelectionPolicy = null,
  venueRubricManager = null,
  refereePool = null,
  roundIndex = null,
  sourceRecord = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  const profile = targetProfile?.profile || {};
  const packet = {
    version: 1,
    kind: 'JournalRubricPacket',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    roundIndex: Number.isFinite(Number(roundIndex)) ? Number(roundIndex) : null,
    status: blockers.length ? 'journal_rubric_packet_blocked' : 'journal_rubric_packet_ready',
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || targetProfile?.targetSelectionPolicyHash || null,
    venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
    freshRefereePoolHash: refereePool?.freshRefereePoolHash || null,
    journalId: profile.id || null,
    journalLabel: profile.label || null,
    requirements: profile.requirements || [],
    rubric: profile.rubric || [],
    reviewStyle: profile.policy?.reviewStyle || null,
    evidenceRequirements: profile.policy?.evidenceRequirements || [],
    deskRejectRules: profile.policy?.deskRejectRules || [],
    acceptanceCriteria: [
      'fresh_referee_verdict_accept',
      'current_review_has_zero_findings',
      'open_referee_issue_count_is_zero',
      'post_revision_package_is_submit_ready',
      'research_verify_has_real_evidence',
      'reviewed_submit_controlled_executor_receipt_recorded',
    ],
    sourceRecordHash: sourceRecord?.hash || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    journalRubricPacketHash: hashPaperRecord('JournalRubricPacket', packet),
  };
}

export function buildVenueRubricManager({
  paperTask = null,
  targetProfile,
  targetSelectionPolicy = null,
  roundIndex = null,
  sourceRecord = null,
  refereePool = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  const profile = targetProfile?.profile || {};
  const policy = profile.policy || profilePolicy(profile);
  const dimensions = uniqueStrings([...(profile.rubric || []), ...(policy.evidenceRequirements || [])], 32)
    .map((id) => ({
      id,
      required: true,
      gate: id.includes('evidence') || id.includes('proof') || id.includes('theorem')
        ? 'venue_evidence_gate'
        : 'fresh_referee_review',
    }));
  const packet = {
    version: 1,
    kind: 'VenueRubricManager',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    roundIndex: Number.isFinite(Number(roundIndex)) ? Number(roundIndex) : null,
    status: blockers.length ? 'venue_rubric_manager_blocked' : 'venue_rubric_manager_ready',
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || targetProfile?.targetSelectionPolicyHash || null,
    freshRefereePoolHash: refereePool?.freshRefereePoolHash || null,
    journalId: profile.id || null,
    journalLabel: profile.label || null,
    reviewStyle: policy.reviewStyle,
    dimensions,
    evidenceRequirements: policy.evidenceRequirements || [],
    deskRejectRules: policy.deskRejectRules || [],
    template: policy.template,
    pageLimit: policy.pageLimit,
    anonymity: policy.anonymity,
    sourceRecordHash: sourceRecord?.hash || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    venueRubricManagerHash: hashPaperRecord('VenueRubricManager', packet),
  };
}

export function buildFreshRefereePool({
  paperTask = null,
  targetProfile,
  roundIndex = 1,
  poolSize = 3,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  const profile = targetProfile?.profile || {};
  const policy = profile.policy || profilePolicy(profile);
  const focus = uniqueStrings([...(profile.rubric || []), ...(policy.evidenceRequirements || [])], 16);
  const personas = Array.from({ length: Math.max(1, Math.min(5, Number(poolSize) || 3)) }, (_, index) => {
    const seed = hashPaperRecord('FreshRefereePersonaSeed', {
      paperId: paperTask?.paperId || targetProfile?.paperId || null,
      roundIndex,
      journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
      index,
    }).replace(/^sha256:/, '').slice(0, 12);
    return {
      id: `fresh_referee_${roundIndex}_${profile.id || 'journal'}_${index + 1}_${seed}`,
      role: index === 0 ? 'primary_fresh_referee' : 'secondary_fresh_referee',
      reviewStyle: policy.reviewStyle,
      focusAreas: focus.slice(index, index + 5).length ? focus.slice(index, index + 5) : focus.slice(0, 5),
      independentFromPriorRound: true,
    };
  });
  const packet = {
    version: 1,
    kind: 'FreshRefereePool',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    roundIndex: Number(roundIndex) || 1,
    status: blockers.length ? 'fresh_referee_pool_blocked' : 'fresh_referee_pool_ready',
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    journalId: profile.id || null,
    personas,
    primaryRefereeId: personas[0]?.id || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      deterministicPersonas: true,
      modelCallPerformed: false,
      humanReviewPerformed: false,
      independentReviewPerformed: false,
      academicAcceptanceAuthority: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    freshRefereePoolHash: hashPaperRecord('FreshRefereePool', packet),
  };
}

export function buildVenueEvidenceGate({
  paperTask = null,
  targetProfile,
  venueRubricManager = null,
  researchReport = null,
  packageResult = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  if (venueRubricManager?.status && venueRubricManager.status !== 'venue_rubric_manager_ready') {
    blockers.push('venue_rubric_manager_not_ready');
  }
  const realEvidencePresent = academicEvidenceReady(researchReport);
  if (!realEvidencePresent) blockers.push('research_verify_attested_academic_evidence_missing');
  if (packageResult && packageResult?.artifactPackage?.submitReady !== true) {
    blockers.push('submit_ready_package_required_for_evidence_gate');
  }
  const profile = targetProfile?.profile || {};
  const policy = profile.policy || profilePolicy(profile);
  const packet = {
    version: 1,
    kind: 'VenueEvidenceGate',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    status: blockers.length ? 'venue_evidence_gate_blocked' : 'venue_evidence_gate_ready',
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
    journalId: profile.id || null,
    requiredEvidence: policy.evidenceRequirements || [],
    researchVerifyStatus: researchReport?.status || null,
    academicEvidenceStatus: researchReport?.academicEvidenceStatus || null,
    academicEvidenceEligible: researchReport?.academicEvidenceEligible === true,
    packageSubmitReady: packageResult?.artifactPackage?.submitReady === true,
    proposalSeedRejectedAsRealEvidence: researchReport?.status === 'proposal_seed_present',
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    venueEvidenceGateHash: hashPaperRecord('VenueEvidenceGate', packet),
  };
}

export function buildVenueLifecyclePolicy({
  paperTask = null,
  targetProfile,
  evidenceGate = null,
  lifecycle = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  if (evidenceGate?.status && evidenceGate.status !== 'venue_evidence_gate_ready') blockers.push('venue_evidence_gate_not_ready');
  const preflightReady = lifecycle?.reviewedSubmitPreflightPacket?.status === 'reviewed_submit_preflight_ready_for_external_executor';
  const controlledReceiptReady = lifecycle?.controlledExecutorReceipt?.status === 'controlled_external_executor_receipt_recorded';
  if (lifecycle && !preflightReady) blockers.push('reviewed_submit_preflight_not_ready');
  if (lifecycle && !controlledReceiptReady) blockers.push('controlled_executor_receipt_not_recorded');
  const profile = targetProfile?.profile || {};
  const policy = profile.policy || profilePolicy(profile);
  const packet = {
    version: 1,
    kind: 'VenueLifecyclePolicy',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    status: blockers.length ? 'venue_lifecycle_policy_blocked' : 'venue_lifecycle_policy_ready',
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    venueEvidenceGateHash: evidenceGate?.venueEvidenceGateHash || null,
    journalId: profile.id || null,
    deadlinePolicy: policy.deadlinePolicy,
    localRefereeAcceptAllowed: false,
    localWorkflowClosureAllowed: blockers.length === 0,
    reviewedSubmitControlledHandoffAllowed: preflightReady && controlledReceiptReady,
    liveExternalSubmissionAllowed: false,
    liveSubmissionBoundary: policy.liveSubmissionBoundary,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      externalActionPerformed: false,
      liveExternalSubmissionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    venueLifecyclePolicyHash: hashPaperRecord('VenueLifecyclePolicy', packet),
  };
}

export function buildJournalConferenceSystemPacket({
  paperTask = null,
  registry = null,
  targetSelectionPolicy = null,
  targetProfile = null,
  rubricPacket = null,
  venueRubricManager = null,
  freshRefereePool = null,
  evidenceGate = null,
  lifecyclePolicy = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  if (registry?.status !== 'journal_conference_registry_ready') blockers.push('journal_conference_registry_not_ready');
  if (targetSelectionPolicy?.status !== 'target_selection_policy_ready') blockers.push('target_selection_policy_not_ready');
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('journal_target_profile_not_ready');
  if (rubricPacket?.status !== 'journal_rubric_packet_ready') blockers.push('journal_rubric_packet_not_ready');
  if (venueRubricManager?.status && venueRubricManager.status !== 'venue_rubric_manager_ready') {
    blockers.push('venue_rubric_manager_not_ready');
  }
  const packet = {
    version: 1,
    kind: 'JournalConferenceSystemPacket',
    paperId: paperTask?.paperId || targetProfile?.paperId || null,
    taskKey: paperTask?.taskKey || targetProfile?.taskKey || null,
    status: blockers.length ? 'journal_conference_system_blocked' : 'journal_conference_system_ready',
    journalConferenceRegistryHash: registry?.journalConferenceRegistryHash || null,
    targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || null,
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    journalRubricPacketHash: rubricPacket?.journalRubricPacketHash || null,
    venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
    freshRefereePoolHash: freshRefereePool?.freshRefereePoolHash || null,
    venueEvidenceGateHash: evidenceGate?.venueEvidenceGateHash || null,
    venueLifecyclePolicyHash: lifecyclePolicy?.venueLifecyclePolicyHash || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      modelCallPerformed: false,
      externalActionPerformed: false,
      liveExternalSubmissionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    journalConferenceSystemPacketHash: hashPaperRecord('JournalConferenceSystemPacket', packet),
  };
}

export function buildFreshRefereeVerdict({
  paperTask,
  targetProfile,
  rubricPacket,
  venueRubricManager = null,
  refereePool = null,
  independentReviewAuthorityReceipt = null,
  evidenceGate = null,
  lifecyclePolicy = null,
  reviewReport,
  openIssueCount = 0,
  buildResult = null,
  packageResult = null,
  researchReport = null,
  lifecycle = null,
  roundIndex = 1,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('FreshRefereeVerdict requires paperTask');
  const blockers = [];
  if (targetProfile?.status !== 'journal_target_profile_ready') blockers.push('target_journal_profile_not_ready');
  if (rubricPacket?.status !== 'journal_rubric_packet_ready') blockers.push('journal_rubric_packet_not_ready');
  if (reviewReport?.status !== 'agent_referee_review_clear' || Number(reviewReport?.findingCount || 0) > 0) {
    blockers.push('fresh_referee_review_not_clear');
  }
  if (Number(openIssueCount || 0) > 0) blockers.push('open_referee_issues_remaining');
  const submitReadyPackage = packageResult?.artifactPackage?.submitReady === true;
  if (!submitReadyPackage) blockers.push('post_revision_package_not_submit_ready');
  if (venueRubricManager?.status && venueRubricManager.status !== 'venue_rubric_manager_ready') {
    blockers.push('venue_rubric_manager_not_ready');
  }
  if (refereePool?.status && refereePool.status !== 'fresh_referee_pool_ready') {
    blockers.push('fresh_referee_pool_not_ready');
  }
  blockers.push(...reviewAuthorityBlockers({ authorityReceipt: independentReviewAuthorityReceipt }));
  if (evidenceGate?.status) {
    if (evidenceGate.status !== 'venue_evidence_gate_ready') {
      blockers.push(...(evidenceGate.blockers || ['venue_evidence_gate_not_ready']));
    }
  } else if (!academicEvidenceReady(researchReport)) {
    blockers.push('research_verify_attested_academic_evidence_missing');
  }
  if (lifecyclePolicy?.status && lifecyclePolicy.status !== 'venue_lifecycle_policy_ready') {
    blockers.push(...(lifecyclePolicy.blockers || ['venue_lifecycle_policy_not_ready']));
  }
  if (lifecycle?.reviewedSubmitPreflightPacket?.status !== 'reviewed_submit_preflight_ready_for_external_executor') {
    blockers.push('reviewed_submit_preflight_not_ready');
  }
  if (lifecycle?.controlledExecutorReceipt?.status !== 'controlled_external_executor_receipt_recorded') {
    blockers.push('controlled_executor_receipt_not_recorded');
  }
  const refereeSeed = hashPaperRecord('FreshRefereeSeed', {
    paperId: paperTask.paperId,
    roundIndex,
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    journalRubricPacketHash: rubricPacket?.journalRubricPacketHash || null,
    venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
    freshRefereePoolHash: refereePool?.freshRefereePoolHash || null,
    independentRefereeAuthorityReceiptHash:
      independentReviewAuthorityReceipt?.independentRefereeAuthorityReceiptHash || null,
    venueEvidenceGateHash: evidenceGate?.venueEvidenceGateHash || null,
    venueLifecyclePolicyHash: lifecyclePolicy?.venueLifecyclePolicyHash || null,
    reviewReportHash: reviewReport?.agentRefereeReviewReportHash || null,
  }).replace(/^sha256:/, '').slice(0, 16);
  const independentAuthorityReady = independentReviewAuthorityReceipt
    ?.status === 'independent_referee_acceptance_verified';
  const verdict = blockers.length ? 'revise' : 'accept';
  const packet = {
    version: 1,
    kind: 'FreshRefereeVerdict',
    paperId: paperTask.paperId,
    taskKey: paperTask.taskKey,
    roundIndex,
    refereeId: `fresh_referee_${roundIndex}_${targetProfile?.profile?.id || 'journal'}_${refereeSeed}`,
    journalTargetProfileHash: targetProfile?.journalTargetProfileHash || null,
    journalRubricPacketHash: rubricPacket?.journalRubricPacketHash || null,
    venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
    freshRefereePoolHash: refereePool?.freshRefereePoolHash || null,
    independentRefereeAuthorityReceiptHash:
      independentReviewAuthorityReceipt?.independentRefereeAuthorityReceiptHash || null,
    venueEvidenceGateHash: evidenceGate?.venueEvidenceGateHash || null,
    venueLifecyclePolicyHash: lifecyclePolicy?.venueLifecyclePolicyHash || null,
    reviewReportHash: reviewReport?.agentRefereeReviewReportHash || null,
    verdict,
    status: verdict === 'accept' ? 'fresh_referee_accept' : 'fresh_referee_revise',
    reviewStatus: reviewReport?.status || null,
    reviewFindingCount: Number(reviewReport?.findingCount || 0),
    openIssueCount: Number(openIssueCount || 0),
    packageSubmitReady: submitReadyPackage,
    researchVerifyStatus: researchReport?.status || null,
    venueEvidenceGateStatus: evidenceGate?.status || null,
    venueLifecyclePolicyStatus: lifecyclePolicy?.status || null,
    reviewedSubmitPreflightStatus: lifecycle?.reviewedSubmitPreflightPacket?.status || null,
    controlledExecutorReceiptStatus: lifecycle?.controlledExecutorReceipt?.status || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      freshRefereePersona: true,
      localOnly: true,
      modelCallPerformed:
        independentReviewAuthorityReceipt?.safety?.modelCallPerformed === true,
      humanReviewPerformed:
        independentReviewAuthorityReceipt?.safety?.humanReviewPerformed === true,
      independentReviewPerformed: independentAuthorityReady,
      academicAcceptanceAuthority: independentAuthorityReady,
      sourceMutation: false,
      sqliteWrites: false,
      externalActionPerformed: false,
      liveExternalSubmissionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    freshRefereeVerdictHash: hashPaperRecord('FreshRefereeVerdict', packet),
  };
}

export async function runJournalManageAdapter({
  root = null,
  runtimeRoot = null,
  row = null,
  target = null,
  hints = [],
  researchReport = null,
  packageResult = null,
  lifecycle = null,
  roundIndex = null,
  execute = false,
} = {}) {
  const registry = buildJournalConferenceRegistry();
  const targetSelectionPolicy = buildTargetSelectionPolicy({
    paperTask: row?.task || null,
    target: target || row?.task?.venueTarget || null,
    hints,
    registry,
  });
  const targetProfile = buildJournalTargetProfile({
    paperTask: row?.task || null,
    target: target || row?.task?.venueTarget || null,
    registry,
    targetSelectionPolicy,
    hints,
  });
  const freshRefereePool = buildFreshRefereePool({
    paperTask: row?.task || null,
    targetProfile,
    roundIndex: roundIndex || 1,
  });
  const venueRubricManager = buildVenueRubricManager({
    paperTask: row?.task || null,
    targetProfile,
    targetSelectionPolicy,
    roundIndex,
    refereePool: freshRefereePool,
  });
  const rubricPacket = buildJournalRubricPacket({
    paperTask: row?.task || null,
    targetProfile,
    targetSelectionPolicy,
    venueRubricManager,
    refereePool: freshRefereePool,
    roundIndex,
  });
  const evidenceGate = buildVenueEvidenceGate({
    paperTask: row?.task || null,
    targetProfile,
    venueRubricManager,
    researchReport,
    packageResult,
  });
  const lifecyclePolicy = buildVenueLifecyclePolicy({
    paperTask: row?.task || null,
    targetProfile,
    evidenceGate,
    lifecycle,
  });
  const systemPacket = buildJournalConferenceSystemPacket({
    paperTask: row?.task || null,
    registry,
    targetSelectionPolicy,
    targetProfile,
    rubricPacket,
    venueRubricManager,
    freshRefereePool,
    evidenceGate,
    lifecyclePolicy,
  });
  if (runtimeRoot && row?.task?.paperId && execute) {
    const dir = path.join(runtimeRoot, 'journal-manage', row.task.paperId);
    await ensureDir(dir);
    await writeJsonFile(path.join(dir, 'JOURNAL_CONFERENCE_REGISTRY.json'), registry);
    await writeJsonFile(path.join(dir, 'TARGET_SELECTION_POLICY.json'), targetSelectionPolicy);
    await writeJsonFile(path.join(dir, 'JOURNAL_TARGET_PROFILE.json'), targetProfile);
    await writeJsonFile(path.join(dir, 'JOURNAL_RUBRIC_PACKET.json'), rubricPacket);
    await writeJsonFile(path.join(dir, 'VENUE_RUBRIC_MANAGER.json'), venueRubricManager);
    await writeJsonFile(path.join(dir, 'FRESH_REFEREE_POOL.json'), freshRefereePool);
    await writeJsonFile(path.join(dir, 'VENUE_EVIDENCE_GATE.json'), evidenceGate);
    await writeJsonFile(path.join(dir, 'VENUE_LIFECYCLE_POLICY.json'), lifecyclePolicy);
    await writeJsonFile(path.join(dir, 'JOURNAL_CONFERENCE_SYSTEM_PACKET.json'), systemPacket);
  }
  const report = {
    version: 1,
    kind: 'JournalManageAdapterReport',
    paperId: row?.task?.paperId || null,
    taskKey: row?.task?.taskKey || null,
    status: systemPacket.status === 'journal_conference_system_ready'
      ? 'journal_manage_ready'
      : 'journal_manage_blocked',
    registry,
    targetSelectionPolicy,
    targetProfile,
    rubricPacket,
    venueRubricManager,
    freshRefereePool,
    evidenceGate,
    lifecyclePolicy,
    systemPacket,
    source: {
      runtimeDir: runtimeRoot && row?.task?.paperId
        ? relativePath(root || path.dirname(runtimeRoot), path.join(runtimeRoot, 'journal-manage', row.task.paperId))
        : null,
    },
    safety: {
      localOnly: true,
      writesLegacyRegistry: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
  };
  return {
    ...report,
    journalManageAdapterReportHash: hashPaperRecord('JournalManageAdapterReport', report),
  };
}
