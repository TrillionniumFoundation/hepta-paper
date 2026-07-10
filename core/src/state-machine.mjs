import {
  CORE_STAGES,
  EXTERNAL_ACTIONS,
  canonicalExternalAction,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { EXECUTION_GATE_DECISIONS } from './execution-gates.mjs';

export const STATE_MACHINE_VERSION = 1;

export const TRANSITION_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  BLOCKED: 'blocked',
});

const EXTERNAL_STAGE_ACTIONS = new Set([
  EXTERNAL_ACTIONS.PROVIDER_SPEND,
  EXTERNAL_ACTIONS.MODEL_SPEND,
  EXTERNAL_ACTIONS.LIVE_PREPARE,
  EXTERNAL_ACTIONS.LIVE_SUBMIT,
  EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
  EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
  EXTERNAL_ACTIONS.DEPLOYMENT,
]);

const STAGE_TRANSITIONS = Object.freeze({
  [CORE_STAGES.CHANNEL_DISCOVERED]: Object.freeze([
    CORE_STAGES.BRIEF_NORMALIZED,
    CORE_STAGES.BLOCKED,
  ]),
  [CORE_STAGES.BRIEF_NORMALIZED]: Object.freeze([
    CORE_STAGES.PLAN_READY,
    CORE_STAGES.BLOCKED,
  ]),
  [CORE_STAGES.PLAN_READY]: Object.freeze([
    CORE_STAGES.GENERATION_READY,
    CORE_STAGES.PACKAGE_READY,
    CORE_STAGES.BLOCKED,
  ]),
  [CORE_STAGES.GENERATION_READY]: Object.freeze([
    CORE_STAGES.PACKAGE_READY,
    CORE_STAGES.BLOCKED,
  ]),
  [CORE_STAGES.PACKAGE_READY]: Object.freeze([
    CORE_STAGES.REVIEW_READY,
    CORE_STAGES.BLOCKED,
  ]),
  [CORE_STAGES.REVIEW_READY]: Object.freeze([
    CORE_STAGES.PREPARE_READY,
    CORE_STAGES.SUBMIT_READY,
    CORE_STAGES.DELIVERY_READY,
    CORE_STAGES.BLOCKED,
  ]),
  [CORE_STAGES.PREPARE_READY]: Object.freeze([
    CORE_STAGES.SUBMIT_READY,
    CORE_STAGES.SUBMITTED_VERIFIED,
    CORE_STAGES.BLOCKED,
  ]),
  [CORE_STAGES.SUBMIT_READY]: Object.freeze([
    CORE_STAGES.SUBMITTED_VERIFIED,
    CORE_STAGES.BLOCKED,
  ]),
  [CORE_STAGES.SUBMITTED_VERIFIED]: Object.freeze([
    CORE_STAGES.SUBMITTED_VERIFIED,
    CORE_STAGES.DELIVERY_READY,
    CORE_STAGES.BLOCKED,
  ]),
  [CORE_STAGES.DELIVERY_READY]: Object.freeze([
    CORE_STAGES.DELIVERY_READY,
    CORE_STAGES.BLOCKED,
  ]),
  [CORE_STAGES.BLOCKED]: Object.freeze([]),
});

const ACTION_STAGE_RULES = Object.freeze({
  [EXTERNAL_ACTIONS.NONE]: Object.freeze({
    fromStages: Object.freeze(Object.values(CORE_STAGES)),
    toStages: Object.freeze(Object.values(CORE_STAGES)),
  }),
  [EXTERNAL_ACTIONS.PROVIDER_SPEND]: Object.freeze({
    fromStages: Object.freeze([CORE_STAGES.PLAN_READY, CORE_STAGES.GENERATION_READY]),
    toStages: Object.freeze([CORE_STAGES.GENERATION_READY, CORE_STAGES.PACKAGE_READY]),
  }),
  [EXTERNAL_ACTIONS.MODEL_SPEND]: Object.freeze({
    fromStages: Object.freeze([CORE_STAGES.BRIEF_NORMALIZED, CORE_STAGES.PLAN_READY, CORE_STAGES.PACKAGE_READY]),
    toStages: Object.freeze([CORE_STAGES.PLAN_READY, CORE_STAGES.GENERATION_READY, CORE_STAGES.REVIEW_READY]),
  }),
  [EXTERNAL_ACTIONS.LIVE_PREPARE]: Object.freeze({
    fromStages: Object.freeze([CORE_STAGES.REVIEW_READY, CORE_STAGES.PREPARE_READY]),
    toStages: Object.freeze([CORE_STAGES.PREPARE_READY, CORE_STAGES.SUBMIT_READY]),
  }),
  [EXTERNAL_ACTIONS.LIVE_SUBMIT]: Object.freeze({
    fromStages: Object.freeze([CORE_STAGES.PREPARE_READY, CORE_STAGES.SUBMIT_READY, CORE_STAGES.SUBMITTED_VERIFIED]),
    toStages: Object.freeze([CORE_STAGES.SUBMITTED_VERIFIED]),
  }),
  [EXTERNAL_ACTIONS.ACCEPTANCE_APPLY]: Object.freeze({
    fromStages: Object.freeze([CORE_STAGES.DELIVERY_READY]),
    toStages: Object.freeze([CORE_STAGES.DELIVERY_READY, CORE_STAGES.SUBMITTED_VERIFIED]),
  }),
  [EXTERNAL_ACTIONS.CUSTOMER_MESSAGE]: Object.freeze({
    fromStages: Object.freeze([CORE_STAGES.SUBMITTED_VERIFIED, CORE_STAGES.DELIVERY_READY]),
    toStages: Object.freeze([CORE_STAGES.SUBMITTED_VERIFIED, CORE_STAGES.DELIVERY_READY]),
  }),
  [EXTERNAL_ACTIONS.DEPLOYMENT]: Object.freeze({
    fromStages: Object.freeze([CORE_STAGES.REVIEW_READY, CORE_STAGES.DELIVERY_READY]),
    toStages: Object.freeze([CORE_STAGES.DELIVERY_READY]),
  }),
});

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes) || null,
  };
}

function knownStages() {
  return Object.values(CORE_STAGES);
}

function knownActions() {
  return Object.values(EXTERNAL_ACTIONS);
}

function actionRequiresGate(action) {
  return EXTERNAL_STAGE_ACTIONS.has(action);
}

function gateAllowsAction(gateDecision, action) {
  const gateAction = canonicalExternalAction(gateDecision?.action || EXTERNAL_ACTIONS.NONE);
  return gateDecision?.allowed === true
    && gateDecision?.decision === EXECUTION_GATE_DECISIONS.ALLOW
    && gateAction === action;
}

function externalGateBindingBlockers({ taskKey, gateDecision }) {
  if (!gateDecision) return [];
  const blockers = [];
  const expectedTaskKey = normalizeText(taskKey || '');
  const gateTaskKey = normalizeText(gateDecision.taskKey || '');
  if (!normalizeText(gateDecision.approvalHash || '')) {
    blockers.push(issue('external_action_gate_approval_hash_required'));
  }
  if (!normalizeText(gateDecision.evidenceHash || '')) {
    blockers.push(issue('external_action_gate_evidence_hash_required'));
  }
  if (expectedTaskKey) {
    if (!gateTaskKey) {
      blockers.push(issue('external_action_gate_task_key_required'));
    } else if (gateTaskKey !== expectedTaskKey) {
      blockers.push(issue('external_action_gate_task_key_mismatch', `expected ${expectedTaskKey}, got ${gateTaskKey}`));
    }
  }
  return blockers;
}

function transitionAllowed(fromStage, toStage, { allowReopen = false } = {}) {
  if (allowReopen && fromStage === CORE_STAGES.BLOCKED) {
    return [
      CORE_STAGES.CHANNEL_DISCOVERED,
      CORE_STAGES.BRIEF_NORMALIZED,
      CORE_STAGES.PLAN_READY,
    ].includes(toStage);
  }
  return Boolean(STAGE_TRANSITIONS[fromStage]?.includes(toStage));
}

function planOnlyBlocked(planOnlyDraft) {
  return Boolean(planOnlyDraft?.blockers?.length || planOnlyDraft?.status === 'blocked_plan_only');
}

function validateActionStageRule({ fromStage, toStage, action }) {
  const blockers = [];
  const rule = ACTION_STAGE_RULES[action];
  if (!rule) {
    blockers.push(issue('unknown_transition_action'));
    return blockers;
  }
  if (!rule.fromStages.includes(fromStage)) {
    blockers.push(issue('action_from_stage_not_allowed', `${action} cannot run from ${fromStage}`));
  }
  if (!rule.toStages.includes(toStage)) {
    blockers.push(issue('action_to_stage_not_allowed', `${action} cannot move to ${toStage}`));
  }
  return blockers;
}

export function validateStateTransition({
  taskKey = null,
  fromStage,
  toStage,
  action = EXTERNAL_ACTIONS.NONE,
  gateDecision = null,
  planOnlyDraft = null,
  allowReopen = false,
  reason = null,
} = {}) {
  const blockers = [];
  const warnings = [];
  const normalizedAction = canonicalExternalAction(action || EXTERNAL_ACTIONS.NONE);

  if (!taskKey) warnings.push(issue('task_key_missing', null, 'warning'));
  if (!knownStages().includes(fromStage)) blockers.push(issue('unknown_from_stage'));
  if (!knownStages().includes(toStage)) blockers.push(issue('unknown_to_stage'));
  if (!knownActions().includes(normalizedAction)) blockers.push(issue('unknown_transition_action'));

  if (knownStages().includes(fromStage) && knownStages().includes(toStage)) {
    if (!transitionAllowed(fromStage, toStage, { allowReopen })) {
      blockers.push(issue('transition_not_allowed', `${fromStage} -> ${toStage}`));
    }
  }

  if (toStage !== CORE_STAGES.BLOCKED && planOnlyBlocked(planOnlyDraft)) {
    blockers.push(issue('plan_only_blockers_must_not_advance', uniqueStrings(planOnlyDraft.blockers || [], 12).join(', ')));
  }

  if (normalizedAction !== EXTERNAL_ACTIONS.NONE) {
    blockers.push(...validateActionStageRule({ fromStage, toStage, action: normalizedAction }));
  }

  if (actionRequiresGate(normalizedAction) && !gateAllowsAction(gateDecision, normalizedAction)) {
    blockers.push(issue('external_action_gate_not_allowed'));
  }
  if (actionRequiresGate(normalizedAction)) {
    blockers.push(...externalGateBindingBlockers({ taskKey, gateDecision }));
  }

  if (toStage === CORE_STAGES.BLOCKED && !normalizeText(reason)) {
    warnings.push(issue('blocked_transition_reason_missing', null, 'warning'));
  }

  return {
    version: STATE_MACHINE_VERSION,
    kind: 'StateTransitionDecision',
    taskKey: taskKey || null,
    fromStage,
    toStage,
    action: normalizedAction,
    decision: blockers.length ? TRANSITION_DECISIONS.BLOCKED : TRANSITION_DECISIONS.ALLOW,
    allowed: blockers.length === 0,
    blockers,
    warnings,
    gateDecision: gateDecision
      ? {
        decision: gateDecision.decision,
        allowed: Boolean(gateDecision.allowed),
        action: gateDecision.action ? canonicalExternalAction(gateDecision.action) : null,
        policy: gateDecision.policy || null,
        approvalHash: gateDecision.approvalHash || null,
        evidenceHash: gateDecision.evidenceHash || null,
      }
      : null,
    safety: {
      validatesOnly: true,
      executesExternalAction: false,
      externalActionRequiresGate: actionRequiresGate(normalizedAction),
    },
  };
}

export function createAuditEvent({
  transitionDecision,
  reason = null,
  actor = 'core',
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!transitionDecision?.kind) throw new Error('AuditEvent requires transitionDecision');
  return {
    version: STATE_MACHINE_VERSION,
    kind: 'StateAuditEvent',
    taskKey: transitionDecision.taskKey,
    fromStage: transitionDecision.fromStage,
    toStage: transitionDecision.toStage,
    action: transitionDecision.action,
    decision: transitionDecision.decision,
    allowed: transitionDecision.allowed,
    reason: normalizeText(reason) || null,
    actor: normalizeText(actor || 'core'),
    blockerCodes: (transitionDecision.blockers || []).map((blocker) => blocker.code),
    warningCodes: (transitionDecision.warnings || []).map((warning) => warning.code),
    approvalHash: transitionDecision.gateDecision?.approvalHash || null,
    evidenceHash: transitionDecision.gateDecision?.evidenceHash || null,
    evidenceRefs: (evidenceRefs || []).map((item) => {
      if (typeof item === 'string') return { kind: 'path', ref: item };
      return {
        kind: item?.kind || 'path',
        ref: normalizeText(item?.ref || item?.path || item?.url || item?.id || ''),
        hash: normalizeText(item?.hash || '') || null,
      };
    }).filter((item) => item.ref),
    safety: {
      auditOnly: true,
      executesExternalAction: false,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
}

export function applyStateTransition(input = {}) {
  const transitionDecision = validateStateTransition(input);
  const auditEvent = createAuditEvent({
    transitionDecision,
    reason: input.reason || null,
    actor: input.actor || 'core',
    evidenceRefs: input.evidenceRefs || [],
    createdAt: input.createdAt || null,
  });
  return {
    version: STATE_MACHINE_VERSION,
    kind: 'StateTransitionResult',
    taskKey: transitionDecision.taskKey,
    stage: transitionDecision.allowed ? transitionDecision.toStage : transitionDecision.fromStage,
    previousStage: transitionDecision.fromStage,
    requestedStage: transitionDecision.toStage,
    allowed: transitionDecision.allowed,
    decision: transitionDecision,
    auditEvent,
    safety: {
      appliesLocalStateOnly: true,
      executesExternalAction: false,
    },
  };
}

export function summarizeAuditLedger(events = []) {
  const byAction = {};
  const byDecision = {};
  const byToStage = {};
  const blockerCodes = {};
  for (const event of events || []) {
    const action = canonicalExternalAction(event.action || EXTERNAL_ACTIONS.NONE);
    byAction[action] = (byAction[action] || 0) + 1;
    byDecision[event.decision] = (byDecision[event.decision] || 0) + 1;
    byToStage[event.toStage] = (byToStage[event.toStage] || 0) + 1;
    for (const code of event.blockerCodes || []) {
      blockerCodes[code] = (blockerCodes[code] || 0) + 1;
    }
  }
  return {
    version: STATE_MACHINE_VERSION,
    count: events.length,
    byAction,
    byDecision,
    byToStage,
    blockerCodes,
    safety: {
      auditOnly: true,
      executesExternalAction: events.some((event) => event.safety?.executesExternalAction === true),
    },
  };
}
