import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const NEXT_ACTION_ADVISOR_VERSION = 1;
export const NEXT_ACTION_ADVISOR_PROVIDER_LOCAL = 'local';

export const NEXT_ACTION_GATE_IDS = Object.freeze({
  ENTRY_REFUND_GATE: 'entry_refund_gate',
  ALREADY_SUBMITTED: 'already_submitted',
  PLAN: 'plan',
  SEMANTIC_CONTRACT: 'semantic_contract',
  PROVIDER_PROBE: 'provider_probe',
  QA_PACKAGE_REVIEW: 'qa_package_review',
  FINAL_REVIEW: 'final_review',
  LIVE_RESOLVER: 'live_resolver',
  PREPARE_ONLY: 'prepare_only',
  SUBMIT_APPROVAL: 'submit_approval',
});

export const NEXT_ACTION_COMMAND_IDS = Object.freeze({
  HOLD_REFUND: 'hold_refund',
  HOLD_ALREADY_SUBMITTED: 'hold_already_submitted',
  CONTROL_MODEL_APPROVAL_PACKET: 'control_model_approval_packet',
  REPLAN_MODEL_SEMANTIC_GUARDED: 'replan_model_semantic_guarded',
  PROBE_GENERATION_ROUTE: 'probe_generation_route',
  REGENERATE_AFTER_CONTRACT: 'regenerate_after_contract',
  PACKAGE_REVIEW: 'package_review',
  REVISE_FROM_REFEREE: 'revise_from_referee',
  REPAIR_LOOP_PLAN: 'repair_loop_plan',
  SPEND_APPROVAL_PACKET: 'spend_approval_packet',
  REPAIR_LOOP_EXECUTE_GUARDED: 'repair_loop_execute_guarded',
  IMPORT_APPROVAL_PACKET: 'import_approval_packet',
  IMPORT_READY_GUARDED: 'import_ready_guarded',
  FINAL_VISUAL_SEMANTIC_REVIEW: 'final_visual_semantic_review',
  RESOLVE_LIVE_PATH: 'resolve_live_path',
  SUBMIT_APPROVAL_PACKET: 'submit_approval_packet',
  SUBMIT_LIVE_GUARDED: 'submit_live_guarded',
  DETERMINISTIC_NEXT: 'deterministic_next',
});

export const NEXT_ACTION_ADVISOR_SAFETY = Object.freeze({
  localAdviceOnly: true,
  executesExternalAction: false,
  callsProviderOrModel: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  deploys: false,
  fetchesChannelState: false,
  appliesLocalStateTransition: false,
  grantsExecutionPermission: false,
});

export const DEFAULT_NEXT_ACTION_COMMAND_TEMPLATES = Object.freeze({
  control_model_approval_packet: 'approval-packet write --task $TASK --action control-model --provider <provider> --budget-usd <budgetUsd>',
  replan_model_semantic_guarded: 'plan --task $TASK --semantic-provider <provider> --policy spend-allowed --approval-hash <approvalHash>',
  probe_generation_route: 'provider-probe plan --task $TASK --limit 1',
  regenerate_after_contract: 'provider-probe plan --task $TASK --limit 1',
  package_review: 'package-review --task $TASK',
  revise_from_referee: 'revise-generation write --task $TASK',
  repair_loop_plan: 'repair-loop plan --task $TASK --max-loops 2',
  spend_approval_packet: 'approval-packet write --task $TASK --action spend --provider auto --budget-usd <budgetUsd>',
  repair_loop_execute_guarded: 'repair-loop execute --task $TASK --policy spend-allowed --approval-hash <approvalHash> --evidence-hash <evidenceHash>',
  import_approval_packet: 'approval-packet write --task $TASK --action import --policy spend-allowed',
  import_ready_guarded: 'import-ready execute --task $TASK --approval-hash <approvalHash>',
  final_visual_semantic_review: 'final-review execute --task $TASK --semantic-provider <provider> --approval-hash <approvalHash>',
  resolve_live_path: 'live-resolver resolve --task $TASK --execute',
  submit_approval_packet: 'approval-packet write --task $TASK --action submit --policy submit-allowed',
  submit_live_guarded: 'submit-live --task $TASK --submit --policy submit-allowed --approval-hash <approvalHash> --evidence-hash <evidenceHash>',
});

export function normalizeNextActionText(value, limit = 500) {
  return normalizeText(String(value ?? '').replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n')).slice(0, limit);
}

export function normalizeNextActionProvider(provider) {
  const raw = String(provider || NEXT_ACTION_ADVISOR_PROVIDER_LOCAL).toLowerCase();
  if (raw === 'model') return 'openclaw-model';
  if (raw === 'none') return 'none';
  return raw;
}

function command(id, label, commandText, meta = {}) {
  return {
    id,
    label,
    command: commandText,
    externalCost: !!meta.externalCost,
    liveAction: !!meta.liveAction,
    submitAction: !!meta.submitAction,
    requiresApproval: !!meta.requiresApproval,
    notes: meta.notes || null,
  };
}

function taskCommand(taskId, suffix) {
  return String(suffix || '').replace(/\$TASK/g, String(taskId));
}

function commandTemplates(options = {}) {
  return {
    ...DEFAULT_NEXT_ACTION_COMMAND_TEMPLATES,
    ...(options.commandTemplates || {}),
  };
}

function templateCommand(id, taskId, options = {}) {
  const template = commandTemplates(options)[id];
  const value = typeof template === 'function' ? template({ taskId, options }) : template;
  return taskCommand(taskId, value);
}

function controlModelApprovalCommand(taskId = '$TASK', options = {}) {
  return templateCommand(NEXT_ACTION_COMMAND_IDS.CONTROL_MODEL_APPROVAL_PACKET, taskId, options);
}

function guardedSemanticPlanCommand(taskId = '$TASK', options = {}) {
  return templateCommand(NEXT_ACTION_COMMAND_IDS.REPLAN_MODEL_SEMANTIC_GUARDED, taskId, options);
}

export function buildNextActionCommandBank(item = {}, options = {}) {
  const taskId = item.taskId || '$TASK';
  const next = item.next || {};
  const gate = String(next.gate || '');
  const blocker = String(next.blocker || '');
  const bank = [];
  const add = (id, label, suffix, meta = {}) => bank.push(command(id, label, taskCommand(taskId, suffix), meta));
  const addTemplate = (id, label, meta = {}) => add(id, label, templateCommand(id, '$TASK', options), meta);

  if (gate === NEXT_ACTION_GATE_IDS.ENTRY_REFUND_GATE) {
    add(NEXT_ACTION_COMMAND_IDS.HOLD_REFUND, 'Hold: refund state is not actionable.', 'none: refund tasks are removed from the actionable queue', { notes: blocker || 'employer_refund_requested' });
    return bank;
  }

  if (gate === NEXT_ACTION_GATE_IDS.ALREADY_SUBMITTED) {
    add(NEXT_ACTION_COMMAND_IDS.HOLD_ALREADY_SUBMITTED, 'Hold: seller-side verified work already exists.', 'none: seller-side verified work already exists; use an explicit rework/resubmit flow if needed', { notes: blocker || 'seller_verified_work_exists' });
    return bank;
  }

  if (gate === NEXT_ACTION_GATE_IDS.PLAN) {
    add(NEXT_ACTION_COMMAND_IDS.CONTROL_MODEL_APPROVAL_PACKET, 'Prepare a human approval packet before a model semantic cache miss can spend quota.', controlModelApprovalCommand('$TASK', options), { externalCost: true, requiresApproval: true });
    add(NEXT_ACTION_COMMAND_IDS.REPLAN_MODEL_SEMANTIC_GUARDED, 'Rebuild the production plan with guarded model semantic intake.', guardedSemanticPlanCommand('$TASK', options), { externalCost: true, requiresApproval: true });
    return bank;
  }

  if (gate === NEXT_ACTION_GATE_IDS.SEMANTIC_CONTRACT) {
    add(NEXT_ACTION_COMMAND_IDS.CONTROL_MODEL_APPROVAL_PACKET, 'Prepare a human approval packet before refreshing the model semantic contract.', controlModelApprovalCommand('$TASK', options), { externalCost: true, requiresApproval: true });
    add(NEXT_ACTION_COMMAND_IDS.REPLAN_MODEL_SEMANTIC_GUARDED, 'Refresh the model semantic plan and semantic contract with spend approval.', guardedSemanticPlanCommand('$TASK', options), { externalCost: true, requiresApproval: true });
    addTemplate(NEXT_ACTION_COMMAND_IDS.PROBE_GENERATION_ROUTE, 'Rebuild a no-cost provider/generation route plan after semantic lock refresh.');
    addTemplate(NEXT_ACTION_COMMAND_IDS.REGENERATE_AFTER_CONTRACT, 'Regenerate only after the refreshed semantic contract is accepted.', { notes: 'provider route only; external generation remains gated by approval policy' });
    return bank;
  }

  if (gate === NEXT_ACTION_GATE_IDS.PROVIDER_PROBE) {
    addTemplate(NEXT_ACTION_COMMAND_IDS.PROBE_GENERATION_ROUTE, 'Choose the next provider/generation route without live submit.');
    if (/dryrun_only|missing_generation_manifest/.test(blocker)) {
      add(NEXT_ACTION_COMMAND_IDS.CONTROL_MODEL_APPROVAL_PACKET, 'Prepare a human approval packet if the stale/missing manifest requires model semantic replanning.', controlModelApprovalCommand('$TASK', options), { externalCost: true, requiresApproval: true });
      add(NEXT_ACTION_COMMAND_IDS.REPLAN_MODEL_SEMANTIC_GUARDED, 'Refresh plan first with guarded model semantic intake if the provider manifest is stale or missing.', guardedSemanticPlanCommand('$TASK', options), { externalCost: true, requiresApproval: true });
    }
    return bank;
  }

  if (gate === NEXT_ACTION_GATE_IDS.QA_PACKAGE_REVIEW) {
    addTemplate(NEXT_ACTION_COMMAND_IDS.PACKAGE_REVIEW, 'Review generated files and import only QA-passing artifacts.');
    addTemplate(NEXT_ACTION_COMMAND_IDS.REVISE_FROM_REFEREE, 'Convert package-referee feedback into revised generation prompts.');
    addTemplate(NEXT_ACTION_COMMAND_IDS.REPAIR_LOOP_PLAN, 'Run the bounded referee-to-generation repair loop in no-spend planning mode.');
    addTemplate(NEXT_ACTION_COMMAND_IDS.SPEND_APPROVAL_PACKET, 'Prepare a human approval packet before executable repair spends provider/referee quota.', { externalCost: true, requiresApproval: true });
    addTemplate(NEXT_ACTION_COMMAND_IDS.REPAIR_LOOP_EXECUTE_GUARDED, 'Execute the bounded repair loop only with spend approval and fresh evidence.', { externalCost: true, requiresApproval: true });
    addTemplate(NEXT_ACTION_COMMAND_IDS.IMPORT_APPROVAL_PACKET, 'Prepare a human approval packet before import mutates local case state.', { requiresApproval: true });
    addTemplate(NEXT_ACTION_COMMAND_IDS.IMPORT_READY_GUARDED, 'Refresh import-ready artifacts only with import approval and fresh evidence.', { requiresApproval: true });
    return bank;
  }

  if (gate === NEXT_ACTION_GATE_IDS.FINAL_REVIEW) {
    addTemplate(NEXT_ACTION_COMMAND_IDS.FINAL_VISUAL_SEMANTIC_REVIEW, 'Run final visual semantic review before prepare/submit.', { externalCost: true, requiresApproval: true });
    return bank;
  }

  if (gate === NEXT_ACTION_GATE_IDS.LIVE_RESOLVER) {
    addTemplate(NEXT_ACTION_COMMAND_IDS.RESOLVE_LIVE_PATH, 'Refresh live page state and classify the live submit path.');
    return bank;
  }

  if (gate === NEXT_ACTION_GATE_IDS.PREPARE_ONLY) {
    addTemplate(NEXT_ACTION_COMMAND_IDS.SUBMIT_APPROVAL_PACKET, 'Legacy prepare-only gate: write the real submit approval packet instead.', { requiresApproval: true });
    addTemplate(NEXT_ACTION_COMMAND_IDS.SUBMIT_LIVE_GUARDED, 'After seller-side duplicate check and current-chat approval, run the real submit path directly.', { liveAction: true, submitAction: true, requiresApproval: true });
    return bank;
  }

  if (gate === NEXT_ACTION_GATE_IDS.SUBMIT_APPROVAL) {
    addTemplate(NEXT_ACTION_COMMAND_IDS.SUBMIT_APPROVAL_PACKET, 'Prepare the separate human approval packet for the real submit click.', { requiresApproval: true, notes: 'this only writes the approval packet; it does not click submit' });
    addTemplate(NEXT_ACTION_COMMAND_IDS.SUBMIT_LIVE_GUARDED, 'Use only after current-chat approval and matching fresh evidence; this is the real submit path.', { liveAction: true, submitAction: true, requiresApproval: true });
    return bank;
  }

  if (next.command) add(NEXT_ACTION_COMMAND_IDS.DETERMINISTIC_NEXT, 'Run the deterministic next action.', next.command, { externalCost: !!next.externalCost, liveAction: !!next.liveAction });
  return bank;
}

function compactCheck(check) {
  return {
    id: normalizeNextActionText(check?.id, 120),
    status: normalizeNextActionText(check?.status, 60),
    blocking: check?.blocking !== false,
    notes: normalizeNextActionText(check?.notes || check?.message || '', 260),
  };
}

export function buildNextActionAdvisorContext(item = {}) {
  const semanticChecks = item.semanticIntake?.checks?.slice(0, 12).map(compactCheck) || [];
  const finalChecks = item.finalReviewChecks?.slice(0, 16).map(compactCheck) || [];
  return {
    taskId: item.taskId,
    orderId: item.orderId || null,
    title: normalizeNextActionText(item.title, 160),
    amount: item.amount || null,
    status: item.status || null,
    lastStep: item.lastStep || null,
    lastError: normalizeNextActionText(item.lastError, 220),
    workflowId: item.workflowId || null,
    industryId: item.industryId || null,
    subject: item.subject || null,
    semanticContractHash: item.semanticContractHash || null,
    manifestSemanticContractHash: item.manifestSemanticContractHash || null,
    providerId: item.providerId || null,
    requestCount: item.requestCount || 0,
    realResults: item.realResults || 0,
    importReadyFiles: item.importReadyFiles || 0,
    finalReviewDecision: item.finalReviewDecision || null,
    livePathBlockerType: item.livePathBlockerType || null,
    next: item.next || null,
    priority: item.priority || null,
    semanticChecks,
    finalChecks,
  };
}

export function buildLocalNextActionAdvice(item = {}, options = {}) {
  const commandBank = buildNextActionCommandBank(item, options);
  const next = item.next || {};
  const gate = String(next.gate || 'unknown');
  const blocker = String(next.blocker || '');
  let intent = 'continue';
  let summary = 'Continue through the deterministic next gate.';
  let recommendedCommandIds = commandBank.length ? [commandBank[0].id] : [];
  let humanReviewRequired = false;
  let confidence = 0.72;

  if (gate === NEXT_ACTION_GATE_IDS.ENTRY_REFUND_GATE) {
    intent = 'hold';
    summary = 'Refund state removes this task from the actionable queue.';
    confidence = 0.98;
  } else if (gate === NEXT_ACTION_GATE_IDS.ALREADY_SUBMITTED) {
    intent = 'hold';
    summary = 'Seller-side verified work already exists, so the dashboard must not suggest another submit path.';
    confidence = 0.98;
  } else if (gate === NEXT_ACTION_GATE_IDS.SEMANTIC_CONTRACT) {
    intent = 'repair_semantic_contract';
    summary = 'Refresh model semantic intake and rebuild downstream artifacts because the current package is not locked to the latest semantic contract.';
    recommendedCommandIds = commandBank.filter((cmd) => [
      NEXT_ACTION_COMMAND_IDS.CONTROL_MODEL_APPROVAL_PACKET,
      NEXT_ACTION_COMMAND_IDS.REPLAN_MODEL_SEMANTIC_GUARDED,
      NEXT_ACTION_COMMAND_IDS.PROBE_GENERATION_ROUTE,
    ].includes(cmd.id)).map((cmd) => cmd.id);
    confidence = 0.9;
  } else if (gate === NEXT_ACTION_GATE_IDS.PROVIDER_PROBE) {
    intent = /missing_generation_manifest|dryrun_only/.test(blocker) ? 'route_generation' : 'inspect_provider_route';
    summary = 'Resolve the generation/provider route before spending model/image quota.';
    recommendedCommandIds = commandBank.filter((cmd) => [
      NEXT_ACTION_COMMAND_IDS.PROBE_GENERATION_ROUTE,
      NEXT_ACTION_COMMAND_IDS.CONTROL_MODEL_APPROVAL_PACKET,
      NEXT_ACTION_COMMAND_IDS.REPLAN_MODEL_SEMANTIC_GUARDED,
    ].includes(cmd.id)).map((cmd) => cmd.id).slice(0, 3);
  } else if (gate === NEXT_ACTION_GATE_IDS.QA_PACKAGE_REVIEW) {
    intent = 'qa_generated_package';
    summary = 'Run package QA/import gates before any final semantic review.';
  } else if (gate === NEXT_ACTION_GATE_IDS.FINAL_REVIEW) {
    intent = 'final_visual_semantic_review';
    summary = 'Run final model visual semantic review; the current package is not yet safe for prepare.';
    humanReviewRequired = !!next.externalCost;
    confidence = 0.86;
  } else if (gate === NEXT_ACTION_GATE_IDS.LIVE_RESOLVER) {
    intent = 'resolve_live_state';
    summary = 'Refresh live state/path classification before any prepare attempt.';
    confidence = 0.84;
  } else if (gate === NEXT_ACTION_GATE_IDS.PREPARE_ONLY) {
    intent = 'submit_approval';
    summary = 'This is a legacy prepare-only gate; the current workflow skips prepare-only and goes to submit approval after seller-side duplicate checks.';
    recommendedCommandIds = commandBank.filter((cmd) => cmd.id === NEXT_ACTION_COMMAND_IDS.SUBMIT_APPROVAL_PACKET).map((cmd) => cmd.id);
    humanReviewRequired = true;
    confidence = 0.82;
  } else if (gate === NEXT_ACTION_GATE_IDS.SUBMIT_APPROVAL) {
    intent = 'submit_approval';
    summary = 'The package is ready for seller-side duplicate check and a human submit approval packet.';
    recommendedCommandIds = commandBank.filter((cmd) => cmd.id === NEXT_ACTION_COMMAND_IDS.SUBMIT_APPROVAL_PACKET).map((cmd) => cmd.id);
    humanReviewRequired = true;
    confidence = 0.9;
  } else if (gate === NEXT_ACTION_GATE_IDS.PLAN) {
    intent = 'replan';
    summary = 'No usable production plan exists; rebuild the plan first.';
  }

  const recommendedCommands = commandBank.filter((cmd) => recommendedCommandIds.includes(cmd.id));
  humanReviewRequired = humanReviewRequired || recommendedCommands.some((cmd) => cmd.requiresApproval || cmd.externalCost || cmd.liveAction);

  return {
    version: NEXT_ACTION_ADVISOR_VERSION,
    provider: NEXT_ACTION_ADVISOR_PROVIDER_LOCAL,
    intent,
    summary,
    recommendedCommandIds,
    commandBank,
    humanReviewRequired,
    confidence,
    hardGate: gate,
    hardBlocker: blocker || null,
    validation: {
      ok: true,
      issues: [],
      modelCannotOverrideHardGates: true,
      submitActionAllowed: false,
    },
    safety: { ...NEXT_ACTION_ADVISOR_SAFETY },
  };
}

export function buildNextActionAdvisorPrompt(item = {}, options = {}) {
  const context = buildNextActionAdvisorContext(item);
  const localAdvice = buildLocalNextActionAdvice(item, options);
  const promptIntro = options.promptIntro || 'You are a repair-route advisor for a production workflow.';
  return [
    promptIntro,
    'Choose the safest next repair path from the provided commandBank only.',
    'You must not invent commands. You must not approve live final submit. You must not override refund, duplicate, stale semantic contract, live-limit, captcha, deadline, or evidence hard gates.',
    'Return JSON only with this shape:',
    '{"intent":"repair_semantic_contract|route_generation|qa_generated_package|final_visual_semantic_review|resolve_live_state|submit_approval|hold|replan|continue","summary":"short reason","recommendedCommandIds":["id_from_commandBank"],"riskFlags":["..."],"humanReviewRequired":true,"confidence":0.0}',
    '',
    'taskContext:',
    JSON.stringify(context, null, 2),
    '',
    'commandBank:',
    JSON.stringify(localAdvice.commandBank, null, 2),
  ].join('\n');
}

export function parseNextActionJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/\x60\x60\x60(?:json)?\s*([\s\S]*?)\x60\x60\x60/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return {};
}

export function parseNextActionModelRun(stdout) {
  const wrapped = parseNextActionJsonObject(stdout);
  if (wrapped?.outputs?.[0]?.text !== undefined) return String(wrapped.outputs[0].text || '');
  if (wrapped?.text !== undefined) return String(wrapped.text || '');
  return String(stdout || '');
}

export function validateNextActionModelAdvice(modelAdvice = {}, localAdvice = {}) {
  const allowed = new Set((localAdvice.commandBank || []).map((cmd) => cmd.id));
  const issues = [];
  const rawIds = Array.isArray(modelAdvice.recommendedCommandIds) ? modelAdvice.recommendedCommandIds.map(String) : [];
  const recommendedCommandIds = rawIds.filter((id) => allowed.has(id));
  const rejectedCommandIds = rawIds.filter((id) => !allowed.has(id));
  if (rejectedCommandIds.length) issues.push({ id: 'advisor_rejected_unknown_command', notes: rejectedCommandIds.join(',') });
  const selectedCommands = (localAdvice.commandBank || []).filter((cmd) => recommendedCommandIds.includes(cmd.id));
  if (selectedCommands.some((cmd) => cmd.submitAction)) issues.push({ id: 'advisor_submit_action_rejected', notes: 'model cannot approve final submit' });
  const safeIds = selectedCommands.filter((cmd) => !cmd.submitAction).map((cmd) => cmd.id);
  return {
    ok: issues.length === 0 && safeIds.length > 0,
    issues,
    recommendedCommandIds: safeIds.length ? safeIds : localAdvice.recommendedCommandIds,
    selectedCommands: (localAdvice.commandBank || []).filter((cmd) => (safeIds.length ? safeIds : localAdvice.recommendedCommandIds).includes(cmd.id)),
    rejectedCommandIds,
    modelCannotOverrideHardGates: true,
    submitActionAllowed: false,
  };
}

export function nextActionAdvisorSelftest(options = {}) {
  const item = {
    taskId: 100,
    title: 'Logo task',
    status: 'generating',
    workflowId: 'logo_brand',
    next: {
      gate: NEXT_ACTION_GATE_IDS.SEMANTIC_CONTRACT,
      blocker: 'semantic_contract_missing,semantic_contract_generation_lock_missing',
      externalCost: false,
      liveAction: false,
    },
    priority: { score: 70 },
  };
  const local = buildLocalNextActionAdvice(item, options);
  const submitLocal = buildLocalNextActionAdvice({
    taskId: 101,
    next: { gate: NEXT_ACTION_GATE_IDS.SUBMIT_APPROVAL, blocker: null },
  }, options);
  const prompt = buildNextActionAdvisorPrompt(item, options);
  const validation = validateNextActionModelAdvice({
    intent: 'repair_semantic_contract',
    recommendedCommandIds: [NEXT_ACTION_COMMAND_IDS.REPLAN_MODEL_SEMANTIC_GUARDED, 'submit_live_now'],
    summary: 'Repair semantic lock first.',
    confidence: 0.8,
  }, local);
  const submitValidation = validateNextActionModelAdvice({
    intent: 'submit_approval',
    recommendedCommandIds: [NEXT_ACTION_COMMAND_IDS.SUBMIT_LIVE_GUARDED],
  }, submitLocal);
  const adviceHash = digest({
    localIntent: local.intent,
    localRecommended: local.recommendedCommandIds,
    submitIntent: submitLocal.intent,
    submitRecommended: submitLocal.recommendedCommandIds,
    validationRecommended: validation.recommendedCommandIds,
    submitValidationIssues: submitValidation.issues.map((issue) => issue.id),
    safety: local.safety,
  });
  const ok = local.intent === 'repair_semantic_contract'
    && local.recommendedCommandIds.includes(NEXT_ACTION_COMMAND_IDS.REPLAN_MODEL_SEMANTIC_GUARDED)
    && submitLocal.intent === 'submit_approval'
    && submitLocal.recommendedCommandIds.includes(NEXT_ACTION_COMMAND_IDS.SUBMIT_APPROVAL_PACKET)
    && prompt.includes('commandBank')
    && validation.rejectedCommandIds.includes('submit_live_now')
    && validation.recommendedCommandIds.includes(NEXT_ACTION_COMMAND_IDS.REPLAN_MODEL_SEMANTIC_GUARDED)
    && submitValidation.submitActionAllowed === false
    && submitValidation.issues.some((issue) => issue.id === 'advisor_submit_action_rejected')
    && submitValidation.recommendedCommandIds.includes(NEXT_ACTION_COMMAND_IDS.SUBMIT_APPROVAL_PACKET)
    && validation.submitActionAllowed === false
    && local.safety.localAdviceOnly === true
    && local.safety.callsProviderOrModel === false
    && local.safety.grantsExecutionPermission === false;
  return { ok, adviceHash, local, submitLocal, validation, submitValidation };
}
