// Archive-only compatibility model used by the migration differential harness.
export const LEGACY_PRODUCTION_CORE_COMMAND = 'paper-production-core-audit';
export const LEGACY_PRODUCTION_CORE_SCHEMA_ID = 'paper_factory.paper_production.core_audit.v1';
export const LEGACY_REPAIR_LOOP_COMMAND = 'paper-production-repair-loop';
export const LEGACY_REPAIR_LOOP_SCHEMA_ID = 'paper_factory.paper_production.repair_loop.v1';

export const LEGACY_PRODUCTION_STATES = Object.freeze({
  SOURCE_MISSING: 'SOURCE_MISSING',
  CONTRACT_MISSING: 'CONTRACT_MISSING',
  PROOF_BLOCKED: 'PROOF_BLOCKED',
  REPAIR_REQUESTED: 'REPAIR_REQUESTED',
  GATE_BLOCKED: 'GATE_BLOCKED',
  PACKAGE_BLOCKED: 'PACKAGE_BLOCKED',
  PREFLIGHT_BLOCKED: 'PREFLIGHT_BLOCKED',
  WARNING_REVIEW_BLOCKED: 'WARNING_REVIEW_BLOCKED',
  LOCAL_RELEASE_BLOCKED: 'LOCAL_RELEASE_BLOCKED',
  EXTERNAL_AUTH_REQUIRED: 'EXTERNAL_AUTH_REQUIRED',
  PRODUCTION_READY_LOCAL_ONLY: 'PRODUCTION_READY_LOCAL_ONLY',
});

const {
  SOURCE_MISSING,
  CONTRACT_MISSING,
  PROOF_BLOCKED,
  REPAIR_REQUESTED,
  GATE_BLOCKED,
  PACKAGE_BLOCKED,
  PREFLIGHT_BLOCKED,
  WARNING_REVIEW_BLOCKED,
  LOCAL_RELEASE_BLOCKED,
  EXTERNAL_AUTH_REQUIRED,
  PRODUCTION_READY_LOCAL_ONLY,
} = LEGACY_PRODUCTION_STATES;

const ATTENTION_STATES = new Set([EXTERNAL_AUTH_REQUIRED]);
const FAIL_STATES = new Set([
  SOURCE_MISSING,
  CONTRACT_MISSING,
  PROOF_BLOCKED,
  REPAIR_REQUESTED,
  GATE_BLOCKED,
  PACKAGE_BLOCKED,
  PREFLIGHT_BLOCKED,
  WARNING_REVIEW_BLOCKED,
  LOCAL_RELEASE_BLOCKED,
]);

export const LEGACY_PAPER_CONTRACT_CHAIN = Object.freeze([
  'PaperRegistryRecord',
  'SourceWorkspace',
  'ClaimInventory',
  'ClaimClassification',
  'EvidenceProvenance',
  'ProofOrQualityContract',
  'ProofReadinessReport',
  'RefereeRepairQueue',
  'GateRun',
  'ArtifactPackage',
  'SubmissionPreflight',
  'HandoffIndex',
  'LocalArchive',
  'ReleaseVerification',
  'ManualVenueAuthorization',
  'ExternalSubmissionReceipt',
]);

export const LEGACY_PAPER_PROFILES = Object.freeze([
  'theorem_or_proof_paper',
  'empirical_or_experiment_paper',
  'systems_or_artifact_paper',
  'survey_or_position_paper',
  'external_data_or_human_subjects_paper',
]);

const REPAIR_LOOP_TERMINAL_STATES = new Set([
  EXTERNAL_AUTH_REQUIRED,
  PRODUCTION_READY_LOCAL_ONLY,
]);

const REPAIR_LOOP_STATE_ACTIONS = Object.freeze([
  [SOURCE_MISSING, 'BLOCKED_SOURCE_MISSING', 'restore or declare source before repair automation can run'],
  [CONTRACT_MISSING, 'BLOCKED_CONTRACT_MISSING', 'declare paper profile and proof/quality contract before referee repair automation can run'],
  [PROOF_BLOCKED, 'SYNC_PROOF_BLOCKERS', 'sync proof-readiness blockers into referee repair requests'],
  [REPAIR_REQUESTED, 'RUN_REFEREE_REPAIR', 'run referee repair runner/orchestrator for open proof-readiness requests'],
  [GATE_BLOCKED, 'RUN_GATE', 'run or repair local gate after proof/referee blockers clear'],
  [PACKAGE_BLOCKED, 'RUN_PACKAGE_REBUILD', 'create/verify local packages after upstream paper state clears'],
  [PREFLIGHT_BLOCKED, 'RUN_SUBMISSION_PREFLIGHT', 'run submission preflight after package verification clears'],
  [WARNING_REVIEW_BLOCKED, 'RUN_WARNING_REVIEW', 'resolve or explicitly explain submission-preflight warnings before release'],
  [LOCAL_RELEASE_BLOCKED, 'RUN_RELEASE_VERIFY', 'freeze or verify local release after preflight clears'],
]);

function asInteger(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) return Number(value);
  return 0;
}

function statusForState(state) {
  if (FAIL_STATES.has(state)) return 'FAIL';
  if (ATTENTION_STATES.has(state)) return 'ATTENTION';
  return 'PASS';
}

function stage(name, status, detail = '', blocking = true, ref = null) {
  return {
    name,
    status,
    blocking: Boolean(blocking),
    detail,
    ref: ref || {},
  };
}

function missingOrStatus(value) {
  return value || 'MISSING';
}

function packageStatus(snapshot) {
  const artifactPackage = snapshot?.package || {};
  return missingOrStatus(artifactPackage.status || (artifactPackage.present ? 'PASS' : ''));
}

function preflightStatus(snapshot) {
  const preflight = snapshot?.submission_preflight || {};
  return missingOrStatus(preflight.status || (preflight.present ? 'PASS' : ''));
}

function releaseStatus(snapshot) {
  const release = snapshot?.release_verify || {};
  const status = missingOrStatus(release.status || (release.present ? 'PASS' : ''));
  if (status === 'PASS' && release.current_package_verify_semantics_pass === false) return 'FAIL';
  return status;
}

function warningReviewStatus(snapshot) {
  const warningReview = snapshot?.warning_review || {};
  const preflight = snapshot?.submission_preflight || {};
  const warningCount = asInteger(warningReview.warning_count ?? preflight.warning_count);
  const unresolvedCount = asInteger(warningReview.unresolved_count);
  const status = missingOrStatus(warningReview.status);
  if (warningCount <= 0 && status === 'MISSING') {
    return ['PASS', {
      warning_count: 0,
      unresolved_count: 0,
      status: 'NOT_REQUIRED',
      present: false,
    }];
  }
  if (status === 'PASS' && unresolvedCount === 0) return ['PASS', { ...warningReview }];
  return ['FAIL', { ...warningReview }];
}

export function evaluateLegacyProductionSnapshot(input = {}) {
  const snapshot = { ...(input || {}) };
  const proof = { ...(snapshot.proof_readiness || {}) };
  const gate = { ...(snapshot.latest_gate || {}) };
  const repair = { ...(snapshot.repair_queue || {}) };
  const slug = snapshot.slug || '';
  const sourceReady = Boolean(snapshot.source_ready);
  const contractDeclared = Boolean(proof.contract_declared);
  const proofBlockers = asInteger(proof.blocker_count);
  const proofBlocking = Boolean(proof.workflow_readiness_blocking) || proofBlockers > 0;
  const repairRequested = asInteger(repair.open_proof_blocker_count) > 0;
  const gateStatus = missingOrStatus(gate.status);
  const artifactPackageStatus = packageStatus(snapshot);
  const submissionPreflightStatus = preflightStatus(snapshot);
  const [warningStatus, warningSnapshot] = warningReviewStatus(snapshot);
  const localReleaseStatus = releaseStatus(snapshot);
  const externalAuthorized = Boolean(snapshot.manual_venue_authorization?.external_action_authorized);
  const stages = [];
  let upstreamBlocked = false;

  function addStage(name, status, detail = '', blocking = true, ref = null) {
    let effectiveStatus = status;
    let effectiveBlocking = blocking;
    let effectiveDetail = detail;
    if (upstreamBlocked && status === 'FAIL') {
      effectiveStatus = 'SKIP';
      effectiveBlocking = false;
      effectiveDetail = `blocked_by_upstream:${detail}`;
    }
    stages.push(stage(name, effectiveStatus, effectiveDetail, effectiveBlocking, ref));
    if (effectiveBlocking && effectiveStatus === 'FAIL') upstreamBlocked = true;
  }

  addStage('SourceWorkspace', sourceReady ? 'PASS' : 'FAIL', snapshot.main_tex || 'missing main tex');
  addStage(
    'ProofOrQualityContract',
    contractDeclared ? 'PASS' : 'FAIL',
    proof.proof_state || 'missing declared proof/quality contract',
    true,
    { proof_readiness_hash: proof.proof_readiness_hash || '' },
  );
  addStage(
    'ProofReadinessReport',
    proofBlocking ? 'FAIL' : (contractDeclared ? 'PASS' : 'SKIP'),
    (proof.failed_report_ids || []).join(',') || proof.proof_state || '',
    true,
    { blocker_count: proofBlockers },
  );
  addStage(
    'RefereeRepairQueue',
    repairRequested ? 'ATTENTION' : (!proofBlocking ? 'PASS' : 'FAIL'),
    `open_proof_blockers=${repair.open_proof_blocker_count ?? 0}`,
    proofBlocking && !repairRequested,
    repair,
  );
  addStage('GateRun', gateStatus === 'PASS' ? 'PASS' : 'FAIL', gateStatus, true, gate);
  addStage(
    'ArtifactPackage',
    artifactPackageStatus === 'PASS' ? 'PASS' : 'FAIL',
    artifactPackageStatus,
    true,
    snapshot.package || {},
  );
  addStage(
    'SubmissionPreflight',
    submissionPreflightStatus === 'PASS' ? 'PASS' : 'FAIL',
    submissionPreflightStatus,
    true,
    snapshot.submission_preflight || {},
  );
  addStage('WarningReview', warningStatus === 'PASS' ? 'PASS' : 'FAIL', warningStatus, true, warningSnapshot);
  addStage(
    'ReleaseVerification',
    localReleaseStatus === 'PASS' ? 'PASS' : 'FAIL',
    localReleaseStatus,
    true,
    snapshot.release_verify || {},
  );
  addStage(
    'ManualVenueAuthorization',
    externalAuthorized ? 'PASS' : 'ATTENTION',
    externalAuthorized ? 'external_action_authorized' : 'external_action_not_authorized',
    false,
    snapshot.manual_venue_authorization || {},
  );

  let productionState;
  let nextAction;
  if (!sourceReady) {
    productionState = SOURCE_MISSING;
    nextAction = 'restore or declare the source workspace and main tex';
  } else if (!contractDeclared) {
    productionState = CONTRACT_MISSING;
    nextAction = 'declare the paper-specific proof/quality contract';
  } else if (proofBlocking && repairRequested) {
    productionState = REPAIR_REQUESTED;
    nextAction = 'dispatch or complete the open proof-readiness repair requests';
  } else if (proofBlocking) {
    productionState = PROOF_BLOCKED;
    nextAction = 'sync proof blockers into the referee repair queue';
  } else if (gateStatus !== 'PASS') {
    productionState = GATE_BLOCKED;
    nextAction = 'run or repair the paper gate';
  } else if (artifactPackageStatus !== 'PASS') {
    productionState = PACKAGE_BLOCKED;
    nextAction = 'create and verify a local package after upstream gates pass';
  } else if (submissionPreflightStatus !== 'PASS') {
    productionState = PREFLIGHT_BLOCKED;
    nextAction = 'run or repair submission preflight';
  } else if (warningStatus !== 'PASS') {
    productionState = WARNING_REVIEW_BLOCKED;
    nextAction = 'run or repair warning review before local release';
  } else if (localReleaseStatus !== 'PASS') {
    productionState = LOCAL_RELEASE_BLOCKED;
    nextAction = 'freeze and verify the local release archive';
  } else if (!externalAuthorized) {
    productionState = EXTERNAL_AUTH_REQUIRED;
    nextAction = 'request explicit human venue/external submission authorization';
  } else {
    productionState = PRODUCTION_READY_LOCAL_ONLY;
    nextAction = 'ready for authorized external submission handoff';
  }

  const blockingStages = stages.filter((item) => item.blocking && item.status === 'FAIL');
  return {
    slug,
    status: statusForState(productionState),
    production_state: productionState,
    next_action: nextAction,
    source_ready: sourceReady,
    proof_blocked: proofBlocking,
    proof_blocker_count: proofBlockers,
    repair_requested: repairRequested,
    open_proof_blocker_count: asInteger(repair.open_proof_blocker_count),
    stage_checks: stages,
    blocking_stage_count: blockingStages.length,
    blocking_stages: blockingStages,
    inputs: snapshot,
  };
}

export function summarizeLegacyProductionEvaluations(values = []) {
  const evaluations = (values || []).map((item) => ({ ...(item || {}) }));
  const stateCounts = {};
  const statusCounts = {};
  for (const item of evaluations) {
    const stateName = item.production_state || '';
    const statusName = item.status || '';
    stateCounts[stateName] = (stateCounts[stateName] || 0) + 1;
    statusCounts[statusName] = (statusCounts[statusName] || 0) + 1;
  }
  const sortedStateCounts = Object.fromEntries(Object.entries(stateCounts).sort(([left], [right]) => left.localeCompare(right)));
  const failCount = statusCounts.FAIL || 0;
  const attentionCount = statusCounts.ATTENTION || 0;
  return {
    status: failCount ? 'FAIL' : (attentionCount ? 'ATTENTION' : 'PASS'),
    paper_count: evaluations.length,
    pass_count: statusCounts.PASS || 0,
    fail_count: failCount,
    attention_count: attentionCount,
    state_counts: sortedStateCounts,
    source_missing_count: stateCounts[SOURCE_MISSING] || 0,
    contract_missing_count: stateCounts[CONTRACT_MISSING] || 0,
    proof_blocked_count: evaluations.filter((item) => item.proof_blocked).length,
    repair_requested_count: stateCounts[REPAIR_REQUESTED] || 0,
    gate_blocked_count: stateCounts[GATE_BLOCKED] || 0,
    package_blocked_count: stateCounts[PACKAGE_BLOCKED] || 0,
    preflight_blocked_count: stateCounts[PREFLIGHT_BLOCKED] || 0,
    warning_review_blocked_count: stateCounts[WARNING_REVIEW_BLOCKED] || 0,
    local_release_blocked_count: stateCounts[LOCAL_RELEASE_BLOCKED] || 0,
    external_auth_required_count: stateCounts[EXTERNAL_AUTH_REQUIRED] || 0,
    production_ready_local_only_count: stateCounts[PRODUCTION_READY_LOCAL_ONLY] || 0,
    proof_blocker_count: evaluations.reduce((sum, item) => sum + asInteger(item.proof_blocker_count), 0),
    open_proof_blocker_count: evaluations.reduce((sum, item) => sum + asInteger(item.open_proof_blocker_count), 0),
  };
}

export function buildLegacyProductionAudit({
  paperSnapshots = [],
  label = '',
  createdAt,
  skipped = [],
} = {}) {
  if (!createdAt) throw new Error('buildLegacyProductionAudit requires deterministic createdAt');
  const papers = paperSnapshots.map(evaluateLegacyProductionSnapshot);
  const summary = summarizeLegacyProductionEvaluations(papers);
  return {
    created_at: createdAt,
    command: LEGACY_PRODUCTION_CORE_COMMAND,
    status: summary.status,
    label: label || '',
    report_schema: {
      schema_id: LEGACY_PRODUCTION_CORE_SCHEMA_ID,
      stable_top_level_fields: [
        'created_at',
        'command',
        'status',
        'label',
        'report_schema',
        'paper_contract_chain',
        'paper_profiles',
        'summary',
        'papers',
        'skipped',
        'boundary',
      ],
      stable_summary_fields: [
        'paper_count',
        'pass_count',
        'fail_count',
        'attention_count',
        'state_counts',
        'contract_missing_count',
        'proof_blocked_count',
        'repair_requested_count',
        'external_auth_required_count',
      ],
      deprecated_fields: [],
      notes: [
        'A paper has exactly one highest-priority production_state.',
        'Missing proof/quality contract is production-blocking even when lower proof-readiness reports are migration ATTENTION.',
        'External submission is never implied by local package, preflight, archive, or release verification.',
      ],
    },
    paper_contract_chain: [...LEGACY_PAPER_CONTRACT_CHAIN],
    paper_profiles: [...LEGACY_PAPER_PROFILES],
    summary,
    papers,
    skipped: [...(skipped || [])],
    boundary: {
      source_mutation_performed: false,
      package_mutation_performed: false,
      archive_mutation_performed: false,
      provider_model_call_performed: false,
      external_action_performed: false,
      secret_material_read_performed: false,
      commit_performed: false,
    },
  };
}

export function legacyRepairLoopFrontier(auditReport = {}) {
  const report = { ...(auditReport || {}) };
  const summary = { ...(report.summary || {}) };
  const papers = (report.papers || []).map((item) => ({ ...(item || {}) }));
  const stateCounts = { ...(summary.state_counts || {}) };
  if (!papers.length) {
    return {
      action: 'NO_TARGETS',
      terminal: true,
      state: '',
      paper_count: 0,
      slugs: [],
      reason: 'no selected papers',
    };
  }
  const failing = asInteger(summary.fail_count);
  if (failing === 0) {
    const terminalStates = [...new Set(papers
      .map((item) => item.production_state || '')
      .filter((stateName) => REPAIR_LOOP_TERMINAL_STATES.has(stateName)))]
      .sort();
    return {
      action: 'LOCAL_PRODUCTION_COMPLETE',
      terminal: true,
      state: terminalStates.join(','),
      paper_count: papers.length,
      slugs: papers.map((item) => item.slug || ''),
      reason: 'local production core has no failing states',
    };
  }
  for (const [stateName, action, reason] of REPAIR_LOOP_STATE_ACTIONS) {
    const count = asInteger(stateCounts[stateName]);
    if (count <= 0) continue;
    return {
      action,
      terminal: action.startsWith('BLOCKED_'),
      state: stateName,
      paper_count: count,
      slugs: papers.filter((item) => item.production_state === stateName).map((item) => item.slug || ''),
      reason,
    };
  }
  return {
    action: 'BLOCKED_UNKNOWN_STATE',
    terminal: true,
    state: '',
    paper_count: failing,
    slugs: papers.filter((item) => item.status === 'FAIL').map((item) => item.slug || ''),
    reason: 'production audit failed with no recognized repair-loop frontier',
  };
}

export function legacyRepairLoopFrontierSlugShard(frontier = {}, workerLimit = 0) {
  const action = frontier?.action || '';
  const slugs = (frontier?.slugs || []).filter(Boolean);
  const limit = Math.max(0, asInteger(workerLimit));
  let selected = [...slugs];
  let deferred = [];
  if (action === 'RUN_REFEREE_REPAIR' && limit > 0) {
    selected = slugs.slice(0, limit);
    deferred = slugs.slice(limit);
  }
  return {
    worker_limit: limit,
    worker_limit_applied: action === 'RUN_REFEREE_REPAIR' && limit > 0,
    frontier_slugs: [...slugs],
    selected_slugs: selected,
    deferred_slugs: deferred,
  };
}

export function resolveLegacyArtifactLabel({
  requestedLabel = '',
  latestLabel = '',
  requestedPackageCount = 0,
  requestedPresentCount,
} = {}) {
  const requested = requestedLabel || '';
  const latest = latestLabel || '';
  const packageCount = asInteger(requestedPackageCount);
  const presentCount = requestedPresentCount === undefined || requestedPresentCount === null
    ? packageCount
    : asInteger(requestedPresentCount);
  if (requested && presentCount > 0) {
    return {
      artifact_label: requested,
      artifact_label_source: 'requested_label',
      fallback_from_label: '',
      requested_package_count: packageCount,
      requested_present_count: presentCount,
    };
  }
  if (latest && latest !== requested) {
    return {
      artifact_label: latest,
      artifact_label_source: 'latest_package_label',
      fallback_from_label: requested,
      requested_package_count: packageCount,
      requested_present_count: presentCount,
    };
  }
  return {
    artifact_label: requested || latest,
    artifact_label_source: requested ? 'requested_label' : (latest ? 'latest_package_label' : ''),
    fallback_from_label: '',
    requested_package_count: packageCount,
    requested_present_count: presentCount,
  };
}
