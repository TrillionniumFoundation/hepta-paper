import { digest } from './hash-utils.mjs';

export const HUMAN_FEEDBACK_LOOP_VERSION = 1;
export const HUMAN_FEEDBACK_SESSION_FILENAME = 'human-feedback-session-latest.json';
export const HUMAN_FEEDBACK_SESSION_ARCHIVE_DIR = 'human-feedback-sessions';
export const HUMAN_FEEDBACK_ROUNDS_DIR = 'human-feedback-rounds';

export const HUMAN_FEEDBACK_LOOP_SAFETY = Object.freeze({
  localContractOnly: true,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  grantsExecutionPermission: false,
});

export const HUMAN_FEEDBACK_LOOP_STATES = Object.freeze([
  'observing_feedback',
  'planning_round',
  'revising',
  'local_qa',
  'human_review',
  'awaiting_customer_response',
  'satisfied_closed',
  'blocked',
]);

export const HUMAN_FEEDBACK_SATISFACTION_STATES = Object.freeze([
  'unknown',
  'satisfied',
  'continue_requested',
  'ambiguous',
  'blocked',
]);

const SATISFIED_RE = /满意|可以了|可以的|可以\b|没问题|沒有问题|无问题|不用改|不需要改|就这样|确认|通过|定稿|验收|认可|ok\b|okay|approved?|accept(?:ed)?|looks good|no more changes/i;
const CONTINUE_RE = /修改|改一下|再改|调整|不对|不是|不行|不满意|还有|继续|重做|换成|补充|问题|错|差|不够|需要|希望|不要|别用|重新|revise|change|not right|more changes|needs? work/i;
const BLOCKED_RE = /取消|退款|投诉|终止|不要做了|不用做了|放弃|cancel|refund|complaint|stop work/i;

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function withoutHashFields(value, fields) {
  if (Array.isArray(value)) return value.map((item) => withoutHashFields(item, fields));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => !fields.has(key) && item !== undefined)
        .map(([key, item]) => [key, withoutHashFields(item, fields)]),
    );
  }
  return value;
}

export function hashHumanFeedbackLoop(value, omit = []) {
  const stripped = withoutHashFields(value, new Set(['sessionHash', 'roundHash', 'signalHash', ...omit]));
  return digest(stripped);
}

export function normalizeLoopState(value) {
  const normalized = compact(value).toLowerCase().replaceAll('-', '_');
  return HUMAN_FEEDBACK_LOOP_STATES.includes(normalized) ? normalized : null;
}

export function normalizeSatisfactionState(value) {
  const normalized = compact(value).toLowerCase().replaceAll('-', '_');
  return HUMAN_FEEDBACK_SATISFACTION_STATES.includes(normalized) ? normalized : null;
}

export function classifySatisfactionSignal({ text = '', decision = null } = {}) {
  const rawDecision = compact(decision).toLowerCase().replaceAll('-', '_');
  const value = compact(text);
  const matched = [];
  let state = 'ambiguous';
  let confidence = 0.45;

  if (['satisfied', 'approved', 'approve', 'accepted', 'accept', 'pass', 'close', 'done', 'ok'].includes(rawDecision)) {
    state = 'satisfied';
    confidence = 0.95;
    matched.push('explicit_satisfied_decision');
  } else if (['continue', 'revise', 'revision', 'needs_changes', 'change_requested', 'fail', 'failed'].includes(rawDecision)) {
    state = 'continue_requested';
    confidence = 0.92;
    matched.push('explicit_continue_decision');
  } else if (['blocked', 'cancelled', 'canceled', 'refund', 'stop'].includes(rawDecision)) {
    state = 'blocked';
    confidence = 0.92;
    matched.push('explicit_blocked_decision');
  }

  const continueProbe = value.replace(/没问题|沒有问题|无问题|沒問題|no problem|no more changes/ig, '');
  const hasBlocked = BLOCKED_RE.test(value);
  const hasSatisfied = SATISFIED_RE.test(value);
  const hasContinue = CONTINUE_RE.test(continueProbe);
  if (hasBlocked) matched.push('blocked_text');
  if (hasSatisfied) matched.push('satisfied_text');
  if (hasContinue) matched.push('continue_text');

  if (!rawDecision) {
    if (hasBlocked) {
      state = 'blocked';
      confidence = 0.86;
    } else if (hasSatisfied && !hasContinue) {
      state = 'satisfied';
      confidence = 0.84;
    } else if (hasContinue && !hasSatisfied) {
      state = 'continue_requested';
      confidence = 0.82;
    } else if (hasSatisfied && hasContinue) {
      state = 'ambiguous';
      confidence = 0.52;
    }
  } else if (state === 'satisfied' && hasContinue) {
    state = 'ambiguous';
    confidence = 0.58;
    matched.push('decision_text_conflict');
  } else if (state === 'continue_requested' && hasSatisfied) {
    state = 'ambiguous';
    confidence = 0.58;
    matched.push('decision_text_conflict');
  }

  return {
    state,
    confidence: Number(confidence.toFixed(2)),
    matched,
    requiresHumanReview: state === 'ambiguous' || confidence < 0.8,
  };
}

function safeIdPart(value, fallback = 'item') {
  const cleaned = compact(value).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || fallback).slice(0, 80);
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[^0-9TZ]+/g, '').slice(0, 16);
}

function normalizedRef(item = {}, index = 0) {
  if (typeof item === 'string') return { kind: 'ref', ref: item };
  return {
    kind: compact(item.kind || item.type || 'ref') || 'ref',
    ref: compact(item.ref || item.path || item.messageId || item.id || `ref-${index + 1}`),
    hash: compact(item.hash || item.sha256) || null,
    notes: compact(item.notes || item.text || item.label) || null,
  };
}

function normalizeArtifact(item = {}, index = 0) {
  const rawSize = item.size ?? item.bytes;
  return {
    artifactId: compact(item.artifactId || item.id || `artifact-${String(index + 1).padStart(3, '0')}`),
    path: compact(item.path || item.ref || item.file) || null,
    filename: compact(item.filename || item.name) || null,
    hash: compact(item.hash || item.sha256) || null,
    size: Number.isFinite(Number(rawSize)) ? Number(rawSize) : null,
    role: compact(item.role || item.kind || 'revision_output') || 'revision_output',
    notes: compact(item.notes || item.description) || null,
  };
}

function normalizeAtomicChange(item = {}, index = 0) {
  if (typeof item === 'string') {
    return {
      id: `cf-${String(index + 1).padStart(3, '0')}`,
      status: index === 0 ? 'active' : 'pending',
      description: compact(item),
      sourceRefs: [],
      targetArtifactId: null,
    };
  }
  return {
    id: compact(item.id || item.changeId || item.stepId || `cf-${String(index + 1).padStart(3, '0')}`),
    status: compact(item.status || item.state || (index === 0 ? 'active' : 'pending')) || (index === 0 ? 'active' : 'pending'),
    description: compact(item.description || item.text || item.change || item.instruction || item.requirement),
    sourceRefs: asArray(item.sourceRefs || item.refs || item.sourceRef).map(normalizedRef),
    targetArtifactId: compact(item.targetArtifactId || item.artifactId) || null,
  };
}

export function createSatisfactionSignal(input = {}) {
  const observedAt = compact(input.observedAt || input.at) || new Date().toISOString();
  const classification = input.classification || classifySatisfactionSignal({
    text: input.text,
    decision: input.decision,
  });
  const base = {
    version: HUMAN_FEEDBACK_LOOP_VERSION,
    signalId: compact(input.signalId) || null,
    roundId: compact(input.roundId) || null,
    sourceKind: compact(input.sourceKind || 'customer_message'),
    sourceRef: input.sourceRef ? normalizedRef(input.sourceRef) : null,
    text: compact(input.text) || null,
    decision: compact(input.decision) || null,
    observedAt,
    reviewer: compact(input.reviewer) || null,
    classification,
    closesLoop: classification.state === 'satisfied' && classification.confidence >= 0.8,
    requiresHumanReview: classification.requiresHumanReview === true,
  };
  const signalHash = hashHumanFeedbackLoop(base);
  return {
    ...base,
    signalId: base.signalId || `cfs-${signalHash.slice(7, 19)}`,
    signalHash,
  };
}

export function createHumanFeedbackRound(input = {}) {
  const createdAt = compact(input.createdAt) || new Date().toISOString();
  const roundIndex = Number.isFinite(Number(input.roundIndex)) && Number(input.roundIndex) > 0 ? Number(input.roundIndex) : 1;
  const atomicQueue = asArray(input.atomicQueue || input.changes || input.change).map(normalizeAtomicChange).filter((item) => item.id && item.description);
  const activeAtomicChangeId = compact(input.activeAtomicChangeId || input.activeChangeId)
    || atomicQueue.find((item) => /^active/i.test(item.status))?.id
    || atomicQueue[0]?.id
    || null;
  const signal = input.satisfactionSignal ? createSatisfactionSignal(input.satisfactionSignal) : null;
  const base = {
    version: HUMAN_FEEDBACK_LOOP_VERSION,
    roundId: compact(input.roundId) || `hfr-${String(roundIndex).padStart(3, '0')}-${timestampId(new Date(createdAt))}`,
    roundIndex,
    status: normalizeLoopState(input.status) || 'planning_round',
    createdAt,
    updatedAt: compact(input.updatedAt) || createdAt,
    evidence: input.evidence || null,
    selectedFeedbackRefs: asArray(input.selectedFeedbackRefs || input.feedbackRefs).map(normalizedRef),
    sourceWindow: input.sourceWindow || null,
    revisionContract: input.revisionContract || null,
    baselineInvariantLock: input.baselineInvariantLock || { locked: false, lockedFacts: [], invariantHashes: [] },
    atomicQueue,
    activeAtomicChangeId,
    targetArtifact: input.targetArtifact || null,
    outputArtifacts: asArray(input.outputArtifacts).map(normalizeArtifact),
    qaReports: asArray(input.qaReports).map(normalizedRef),
    humanReview: input.humanReview || null,
    customerResponse: input.customerResponse || null,
    satisfactionSignal: signal,
    blockers: asArray(input.blockers),
    warnings: asArray(input.warnings),
  };
  return {
    ...base,
    roundHash: hashHumanFeedbackLoop(base),
  };
}

export function createHumanFeedbackSession(input = {}) {
  const createdAt = compact(input.createdAt) || new Date().toISOString();
  const taskId = compact(input.taskId || input.task || input.orderId);
  const rounds = asArray(input.rounds).map((round, index) => createHumanFeedbackRound({
    ...round,
    roundIndex: round.roundIndex || index + 1,
  }));
  const latestRound = rounds[rounds.length - 1] || null;
  const base = {
    version: HUMAN_FEEDBACK_LOOP_VERSION,
    sessionId: compact(input.sessionId) || `hfr-session-${safeIdPart(taskId || input.orderId || 'task')}-${timestampId(new Date(createdAt))}`,
    taskId: taskId || null,
    orderId: compact(input.orderId) || null,
    channelId: compact(input.channelId || input.channel || 'zbj') || 'zbj',
    externalId: compact(input.externalId) || null,
    workflowId: 'human_feedback',
    customer: input.customer || null,
    targetArtifact: input.targetArtifact || null,
    sourceWindow: input.sourceWindow || null,
    status: normalizeLoopState(input.status) || latestRound?.status || 'observing_feedback',
    satisfactionState: normalizeSatisfactionState(input.satisfactionState)
      || latestRound?.satisfactionSignal?.classification?.state
      || 'unknown',
    currentRoundId: compact(input.currentRoundId) || latestRound?.roundId || null,
    roundCount: rounds.length,
    rounds,
    constraints: {
      externalActionsRequireApproval: true,
      mediaEvidenceFailClosed: true,
      atomicOneChangePerRound: true,
      unchangedRegressionRequired: true,
      downloadSince: compact(input.constraints?.downloadSince || input.downloadSince) || null,
      oldRecordDownloadPolicy: compact(input.constraints?.oldRecordDownloadPolicy || input.oldRecordDownloadPolicy) || 'audit_only',
      ...(input.constraints || {}),
    },
    gates: {
      customerMessage: 'approval_required',
      platformSubmit: 'approval_required',
      acceptance: 'approval_required',
      payment: 'approval_required',
      ...(input.gates || {}),
    },
    blockers: asArray(input.blockers),
    warnings: asArray(input.warnings),
    createdAt,
    updatedAt: compact(input.updatedAt) || createdAt,
    history: asArray(input.history),
  };
  return {
    ...base,
    sessionHash: hashHumanFeedbackLoop(base),
  };
}

export function appendRoundToSession(sessionInput, roundInput) {
  const session = createHumanFeedbackSession(sessionInput);
  const round = createHumanFeedbackRound({
    ...roundInput,
    roundIndex: session.rounds.length + 1,
  });
  return createHumanFeedbackSession({
    ...session,
    rounds: [...session.rounds, round],
    currentRoundId: round.roundId,
    status: round.status,
    satisfactionState: round.satisfactionSignal?.classification?.state || session.satisfactionState,
    updatedAt: new Date().toISOString(),
    history: [
      ...session.history,
      { at: new Date().toISOString(), event: 'round_appended', roundId: round.roundId, status: round.status },
    ],
  });
}

export function updateCurrentRound(sessionInput, patch = {}, event = 'round_updated') {
  const session = createHumanFeedbackSession(sessionInput);
  const currentRoundId = patch.roundId || session.currentRoundId;
  const rounds = session.rounds.map((round) => (
    round.roundId === currentRoundId
      ? createHumanFeedbackRound({ ...round, ...patch, updatedAt: new Date().toISOString() })
      : round
  ));
  const current = rounds.find((round) => round.roundId === currentRoundId) || rounds[rounds.length - 1] || null;
  return createHumanFeedbackSession({
    ...session,
    rounds,
    currentRoundId: current?.roundId || null,
    status: patch.sessionStatus || current?.status || session.status,
    satisfactionState: current?.satisfactionSignal?.classification?.state || session.satisfactionState,
    updatedAt: new Date().toISOString(),
    history: [...session.history, { at: new Date().toISOString(), event, roundId: current?.roundId || null }],
  });
}

export function validateHumanFeedbackLoopSession(input = {}) {
  const session = createHumanFeedbackSession(input);
  const blockers = [];
  const warnings = [];
  if (!session.taskId && !session.orderId) blockers.push({ code: 'human_feedback_session_task_or_order_required' });
  if (!normalizeLoopState(session.status)) blockers.push({ code: 'human_feedback_session_status_invalid', detail: session.status });
  if (!normalizeSatisfactionState(session.satisfactionState)) blockers.push({ code: 'human_feedback_satisfaction_state_invalid', detail: session.satisfactionState });
  for (const blocker of session.blockers || []) {
    blockers.push({
      code: blocker.code || 'human_feedback_session_blocker',
      detail: blocker.detail || blocker.details || null,
      source: blocker.source || 'session',
    });
  }
  if (session.constraints?.externalActionsRequireApproval !== true) blockers.push({ code: 'human_feedback_external_approval_gate_required' });
  if (session.constraints?.mediaEvidenceFailClosed !== true) blockers.push({ code: 'human_feedback_media_fail_closed_required' });
  if (session.gates?.customerMessage !== 'approval_required') blockers.push({ code: 'human_feedback_customer_message_gate_required' });
  if (session.gates?.platformSubmit !== 'approval_required') blockers.push({ code: 'human_feedback_platform_submit_gate_required' });

  const roundIds = new Set();
  for (const round of session.rounds) {
    if (roundIds.has(round.roundId)) blockers.push({ code: 'human_feedback_round_id_duplicate', detail: round.roundId });
    roundIds.add(round.roundId);
    if (!normalizeLoopState(round.status)) blockers.push({ code: 'human_feedback_round_status_invalid', detail: round.roundId });
    if (!round.selectedFeedbackRefs.length && !round.evidence) warnings.push({ code: 'human_feedback_round_feedback_refs_empty', detail: round.roundId });
    const activeItems = round.atomicQueue.filter((item) => item.id === round.activeAtomicChangeId);
    if (round.atomicQueue.length && activeItems.length !== 1) blockers.push({ code: 'human_feedback_active_atomic_change_required', detail: round.roundId });
    const [activeItem] = activeItems;
    if (activeItem && !activeItem.sourceRefs?.length) blockers.push({ code: 'human_feedback_active_atomic_change_source_ref_required', detail: round.roundId });
    if (activeItem && round.selectedFeedbackRefs.length) {
      const feedbackRefs = new Set(round.selectedFeedbackRefs.map((item) => item.ref).filter(Boolean));
      const activeFeedbackRefs = (activeItem.sourceRefs || [])
        .filter((item) => item.kind !== 'human_feedback_revision_contract')
        .map((item) => item.ref)
        .filter(Boolean);
      if (!activeFeedbackRefs.some((ref) => feedbackRefs.has(ref))) {
        blockers.push({ code: 'human_feedback_active_atomic_change_feedback_source_required', detail: round.roundId });
      }
    }
    if (activeItem && round.targetArtifact && !activeItem.targetArtifactId && !round.targetArtifact.artifactId) {
      blockers.push({ code: 'human_feedback_active_atomic_change_target_binding_required', detail: round.roundId });
    }
    if (['awaiting_customer_response', 'satisfied_closed'].includes(round.status)) {
      const decision = compact(round.humanReview?.decision).toLowerCase();
      if (!['pass', 'approved', 'approve'].includes(decision)) blockers.push({ code: 'human_feedback_human_review_pass_required_before_customer_response', detail: round.roundId });
      if (!round.outputArtifacts.length) blockers.push({ code: 'human_feedback_output_required_before_customer_response', detail: round.roundId });
      if (!round.qaReports.length) blockers.push({ code: 'human_feedback_qa_report_required_before_customer_response', detail: round.roundId });
      if (!round.revisionContract?.hash) blockers.push({ code: 'human_feedback_round_contract_hash_required_before_customer_response', detail: round.roundId });
      const baseline = round.baselineInvariantLock || {};
      const hasRegressionLock = baseline.locked === true
        && (asArray(baseline.lockedFacts).length || asArray(baseline.invariantHashes).length)
        && asArray(baseline.regressionChecks || baseline.checks).length;
      if (!hasRegressionLock) blockers.push({ code: 'human_feedback_baseline_invariant_lock_required_before_customer_response', detail: round.roundId });
    }
    if (round.satisfactionSignal?.classification?.state === 'satisfied' && !round.satisfactionSignal.closesLoop) {
      blockers.push({ code: 'human_feedback_satisfaction_signal_not_strong_enough', detail: round.roundId });
    }
    if (round.satisfactionSignal?.closesLoop) {
      const sourceKind = compact(round.satisfactionSignal.sourceKind).toLowerCase();
      if (sourceKind === 'customer_message' && !round.satisfactionSignal.sourceRef?.ref) {
        blockers.push({ code: 'human_feedback_customer_satisfaction_source_ref_required', detail: round.roundId });
      }
      if (sourceKind === 'human_review' && !round.satisfactionSignal.reviewer) {
        blockers.push({ code: 'human_feedback_human_satisfaction_reviewer_required', detail: round.roundId });
      }
    }
  }
  if (session.currentRoundId && !roundIds.has(session.currentRoundId)) blockers.push({ code: 'human_feedback_current_round_missing', detail: session.currentRoundId });
  if (session.status === 'satisfied_closed') {
    const current = session.rounds.find((round) => round.roundId === session.currentRoundId) || session.rounds[session.rounds.length - 1] || null;
    if (session.satisfactionState !== 'satisfied') blockers.push({ code: 'human_feedback_closed_requires_satisfied_state' });
    if (!current?.satisfactionSignal?.closesLoop) blockers.push({ code: 'human_feedback_closed_requires_satisfaction_signal' });
  }
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_human_feedback_loop' : 'human_feedback_loop_ready',
    session,
    blockers,
    warnings,
    safety: HUMAN_FEEDBACK_LOOP_SAFETY,
  };
}

export function summarizeHumanFeedbackLoop(sessionInput = {}) {
  const validation = validateHumanFeedbackLoopSession(sessionInput);
  const session = validation.session;
  const current = session.rounds.find((round) => round.roundId === session.currentRoundId) || session.rounds[session.rounds.length - 1] || null;
  return {
    ok: validation.ok,
    status: validation.status,
    sessionId: session.sessionId,
    sessionHash: session.sessionHash,
    taskId: session.taskId,
    orderId: session.orderId,
    loopState: session.status,
    satisfactionState: session.satisfactionState,
    roundCount: session.roundCount,
    currentRoundId: session.currentRoundId,
    currentRoundStatus: current?.status || null,
    activeAtomicChange: current?.atomicQueue?.find((item) => item.id === current.activeAtomicChangeId) || null,
    latestSignal: current?.satisfactionSignal || null,
    blockers: validation.blockers,
    warnings: validation.warnings,
    gates: session.gates,
    constraints: session.constraints,
  };
}

export function humanFeedbackLoopSelftest() {
  const session = createHumanFeedbackSession({
    taskId: '900001',
    orderId: '800001',
    constraints: { downloadSince: '2026-06-10' },
  });
  const withRound = appendRoundToSession(session, {
    evidence: { sourceType: 'wechat_feedback_evidence', bundleHash: 'sha256:' + 'a'.repeat(64) },
    selectedFeedbackRefs: [{ kind: 'wechat_message', ref: 'wechat:wxid:1', hash: 'sha256:' + 'b'.repeat(64) }],
    revisionContract: { kind: 'human_feedback_revision_contract', ref: 'case/human-feedback-revision-contract-latest.json', hash: 'sha256:' + 'f'.repeat(64) },
    atomicQueue: [{ id: 'hfr-001', status: 'active', description: '把蓝色标题调浅', sourceRefs: ['wechat:wxid:1'] }],
    baselineInvariantLock: { locked: true, lockedFacts: ['keep layout'], invariantHashes: ['sha256:' + 'c'.repeat(64)], regressionChecks: ['layout unchanged'] },
  });
  const withReview = updateCurrentRound(withRound, {
    status: 'awaiting_customer_response',
    outputArtifacts: [{ path: 'delivery/revision.png', hash: 'sha256:' + 'd'.repeat(64), size: 12 }],
    qaReports: [{ kind: 'qa_report', ref: 'case/final-package-review-latest.json', hash: 'sha256:' + 'e'.repeat(64) }],
    humanReview: { decision: 'pass', reviewer: 'operator', reviewedAt: '2026-06-17T03:00:00.000Z' },
  }, 'review_passed');
  const signal = createSatisfactionSignal({ roundId: withReview.currentRoundId, text: '可以了，没问题', sourceRef: 'wechat:wxid:2' });
  const closed = updateCurrentRound(withReview, {
    status: 'satisfied_closed',
    sessionStatus: 'satisfied_closed',
    satisfactionSignal: signal,
    customerResponse: { sourceRef: 'wechat:wxid:2', text: '可以了，没问题' },
  }, 'satisfaction_signal_recorded');
  const reloadedClosed = createHumanFeedbackSession(closed);
  const closedValidation = validateHumanFeedbackLoopSession(closed);
  const continueSignal = createSatisfactionSignal({ text: '这里还要再改一下', sourceRef: 'wechat:wxid:3' });
  const unsafeClosed = createHumanFeedbackSession({ ...closed, status: 'satisfied_closed', satisfactionState: 'continue_requested', rounds: [{ ...closed.rounds[0], satisfactionSignal: continueSignal }] });
  const unsafeValidation = validateHumanFeedbackLoopSession(unsafeClosed);
  const prematureClosed = updateCurrentRound(withRound, {
    status: 'satisfied_closed',
    sessionStatus: 'satisfied_closed',
    satisfactionSignal: signal,
    customerResponse: { sourceRef: 'wechat:wxid:2', text: '可以了，没问题' },
  }, 'premature_satisfaction_signal');
  const prematureValidation = validateHumanFeedbackLoopSession(prematureClosed);
  const contractOnlySource = appendRoundToSession(session, {
    selectedFeedbackRefs: [{ kind: 'wechat_message', ref: 'wechat:wxid:1', hash: 'sha256:' + 'b'.repeat(64) }],
    revisionContract: { kind: 'human_feedback_revision_contract', ref: 'case/human-feedback-revision-contract-latest.json', hash: 'sha256:' + 'f'.repeat(64) },
    atomicQueue: [{
      id: 'hfr-001',
      status: 'active',
      description: '把蓝色标题调浅',
      sourceRefs: [{ kind: 'human_feedback_revision_contract', ref: 'case/human-feedback-revision-contract-latest.json', hash: 'sha256:' + 'f'.repeat(64) }],
    }],
    baselineInvariantLock: { locked: true, lockedFacts: ['keep layout'], regressionChecks: ['layout unchanged'] },
  });
  const contractOnlySourceValidation = validateHumanFeedbackLoopSession(contractOnlySource);
  const gateTampered = createHumanFeedbackSession({ ...session, gates: { customerMessage: 'open' } });
  const gateValidation = validateHumanFeedbackLoopSession(gateTampered);
  return {
    ok: closedValidation.ok
      && reloadedClosed.sessionHash === closed.sessionHash
      && closedValidation.session.satisfactionState === 'satisfied'
      && closedValidation.session.roundCount === 1
      && unsafeValidation.blockers.some((item) => item.code === 'human_feedback_closed_requires_satisfied_state')
      && prematureValidation.blockers.some((item) => item.code === 'human_feedback_output_required_before_customer_response')
      && contractOnlySourceValidation.blockers.some((item) => item.code === 'human_feedback_active_atomic_change_feedback_source_required')
      && gateValidation.blockers.some((item) => item.code === 'human_feedback_customer_message_gate_required'),
    safety: HUMAN_FEEDBACK_LOOP_SAFETY,
    closed: summarizeHumanFeedbackLoop(closed),
    unsafeBlockers: unsafeValidation.blockers,
    prematureBlockers: prematureValidation.blockers,
    contractOnlySourceBlockers: contractOnlySourceValidation.blockers,
    gateBlockers: gateValidation.blockers,
  };
}
