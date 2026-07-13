import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';
import { academicEvidenceReady, reviewAuthorityBlockers } from './review-authority.mjs';
import { JOURNAL_PROFILES } from './journal-registry.mjs';
import { tokenText, profileScore, resolveJournalProfile, defaultJournalFallbackIds, withConferenceDeadlineRouting, profilePolicy, enrichProfile, normalizeAsOfDate, deadlineDate, nextMonthlyDeadline, nextAnnualDeadline, daysUntilDeadline, deadlineAssessmentForProfile, rankedItemForProfile, chooseJournalFallback, buildAgentDeadlineRoutingDecision, rankProfiles } from './selection.mjs';

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

