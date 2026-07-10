import {
  EXTERNAL_ACTIONS,
  canonicalExternalAction,
  canonicalProductLineId,
  canonicalProductLineIdOrNull as canonicalProductLineOrNull,
  normalizeText,
} from './contracts.mjs';
import { normalizeHumanFeedbackStage } from './human-feedback-contracts.mjs';
import { digest } from './hash-utils.mjs';
import {
  approvalArtifactDigest as artifactDigest,
  approvalChannelTaskDigest as channelTaskDigest,
  approvalEvidenceBundleStateDigest as evidenceBundleDigest,
  approvalEvidenceRefs as evidenceRefs,
  approvalPacketImmutablePayload,
  approvalFeedbackDefaultProductLine,
  approvalPlanDigest as planDigest,
  approvalProvenanceDigest,
  computeApprovalProvenanceHash,
  approvalReviewDigest as reviewDigest,
  computeApprovalPacketHash,
  computeFreshEvidenceBundleHash,
  defaultApprovalProvenance,
  freshEvidenceBundleImmutablePayload,
} from './approval-evidence-hashes.mjs';
import {
  buildExecutionGateRequest,
  evaluateExecutionGate,
} from './execution-gates.mjs';

export {
  approvalPacketImmutablePayload,
  approvalProvenanceDigest,
  computeApprovalProvenanceHash,
  computeApprovalPacketHash,
  computeFreshEvidenceBundleHash,
  freshEvidenceBundleImmutablePayload,
} from './approval-evidence-hashes.mjs';

export const APPROVAL_PACKET_VERSION = 1;
export const APPROVAL_POLICY_GATE_VERSION = 1;
export const FRESH_EVIDENCE_HANDSHAKE_VERSION = 1;

export const APPROVAL_POLICY_GATE_SAFETY = Object.freeze({
  localPolicyOnly: true,
  readsPacketFiles: false,
  writesPacketFiles: false,
  consumesApprovalPacket: false,
  appendsAuditLog: false,
  executesExternalAction: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  grantsExecutionPermission: false,
});

export const FRESH_EVIDENCE_HANDSHAKE_SAFETY = Object.freeze({
  localPlanOnly: true,
  readsPacketFiles: false,
  writesEvidenceFiles: false,
  runsSubprocesses: false,
  appendsAuditLog: false,
  executesExternalAction: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  grantsExecutionPermission: false,
});

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
const FRESH_EVIDENCE_PASS_THROUGH_KEYS = Object.freeze([
  'approval-hash',
  'approval-packet',
  'projection',
  'baseline',
]);

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function futureIso(now, ttlMs) {
  return new Date(new Date(now).getTime() + ttlMs).toISOString();
}

function normalizedMessagePreview(messagePreview) {
  return normalizeText(messagePreview || '') || null;
}

function legacyHexDigest(value) {
  return digest(value).replace(/^sha256:/, '');
}

export function approvalPolicyNormalizeAction(action) {
  const raw = String(action || '').toLowerCase();
  if (['control-model', 'control_model', 'semantic-intake', 'semantic_intake', 'next-action-advisor', 'next_action_advisor', 'advisor'].includes(raw)) return 'semantic';
  if (['provider-probe', 'provider_spend', 'provider-spend', 'model_spend', 'model-spend'].includes(raw)) return 'spend';
  if (raw === 'expand-5') return 'expand5';
  const canonical = canonicalExternalAction(raw);
  if ([EXTERNAL_ACTIONS.PROVIDER_SPEND, EXTERNAL_ACTIONS.MODEL_SPEND].includes(canonical)) return 'spend';
  if (canonical === EXTERNAL_ACTIONS.LIVE_PREPARE) return 'prepare';
  if (canonical === EXTERNAL_ACTIONS.LIVE_SUBMIT) return 'submit';
  if (canonical === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) return 'acceptance';
  if (canonical === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) return 'customer_message';
  return raw || 'spend';
}

export function approvalPolicyNormalizeEvidenceStage(stage) {
  const normalizedFeedbackStage = normalizeHumanFeedbackStage(stage);
  if (normalizedFeedbackStage.startsWith('human_feedback_')) return normalizedFeedbackStage;
  const normalized = String(stage || '').toLowerCase();
  const canonicalStageAction = canonicalExternalAction(normalized);
  if (canonicalStageAction === EXTERNAL_ACTIONS.LIVE_SUBMIT) return 'human_feedback_handoff';
  if (canonicalStageAction === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) return 'human_feedback_acceptance';
  if (normalized.startsWith('human-feedback-')) return normalized.replaceAll('-', '_');
  if (normalized.startsWith('consumer-feedback-')) return normalized.replace(/^consumer-feedback-/, 'human_feedback_').replaceAll('-', '_');
  if (normalized.startsWith('consumer_feedback_')) return normalized.replace(/^consumer_feedback_/, 'human_feedback_');
  if (normalized.startsWith('buyer-feedback-')) return normalized.replace(/^buyer-feedback-/, 'human_feedback_').replaceAll('-', '_');
  if (normalized.startsWith('buyer_feedback_')) return normalized.replace(/^buyer_feedback_/, 'human_feedback_');
  return normalized;
}

export function approvalPacketBodyHash(packet = {}) {
  const clone = { ...packet };
  delete clone.packetHash;
  delete clone.approvalHash;
  delete clone.approvedCommand;
  delete clone.paths;
  delete clone.approvalState;
  return legacyHexDigest(clone);
}

export function evidenceBundleBodyHash(bundle = {}) {
  const clone = { ...bundle };
  delete clone.bundleHash;
  delete clone.evidenceHash;
  delete clone.paths;
  delete clone.executionCommand;
  return legacyHexDigest(clone);
}

export function approvalPolicyState(packet = {}) {
  return {
    status: packet.approvalState?.status || 'issued',
    issuedAt: packet.approvalState?.issuedAt || packet.generatedAt || null,
    consumedAt: packet.approvalState?.consumedAt || null,
    consumedBy: packet.approvalState?.consumedBy || null,
    revokedAt: packet.approvalState?.revokedAt || null,
    revokedReason: packet.approvalState?.revokedReason || null,
    consumeCount: Number(packet.approvalState?.consumeCount || 0),
  };
}

export function approvalPolicyActionMatchesEvidenceStage(action, stage) {
  const expected = approvalPolicyNormalizeAction(action);
  const actual = approvalPolicyNormalizeAction(stage);
  const actualStage = approvalPolicyNormalizeEvidenceStage(stage);
  if (expected === actual) return true;
  if (['spend', 'semantic', 'expand5'].includes(expected) && actual === 'spend') return true;
  if (expected === 'spend' && actualStage === 'human_feedback_step') return true;
  if (['spend', 'semantic'].includes(expected) && actualStage === 'human_feedback_referee') return true;
  if (expected === 'submit' && ['human_feedback_handoff', 'human_feedback_delivery'].includes(actualStage)) return true;
  if (expected === 'acceptance' && actualStage === 'human_feedback_acceptance') return true;
  return false;
}

export function approvalPolicyActionMatchesApprovalPacket(expectedAction, packetAction) {
  const expected = approvalPolicyNormalizeAction(expectedAction);
  const packet = approvalPolicyNormalizeAction(packetAction);
  if (expected === packet) return true;
  if (expected === 'spend' && ['semantic', 'expand5'].includes(packet)) return true;
  if (packet === 'spend' && ['semantic', 'expand5'].includes(expected)) return true;
  if (expected === 'spend' && ['provider_spend', 'provider-spend', 'model_spend', 'model-spend'].includes(String(packetAction || '').toLowerCase())) return true;
  if (packet === 'spend' && ['provider_spend', 'provider-spend', 'model_spend', 'model-spend'].includes(String(expectedAction || '').toLowerCase())) return true;
  return false;
}

export function approvalPolicyApprovedCommandNeedsAutoFreshEvidence(action) {
  const normalized = approvalPolicyNormalizeAction(action);
  const raw = String(action || '').toLowerCase();
  return ['spend', 'semantic', 'expand5', 'import'].includes(normalized)
    || ['provider_spend', 'provider-spend', 'model_spend', 'model-spend', 'control-model', 'control_model', 'semantic-intake', 'semantic_intake', 'next-action-advisor', 'next_action_advisor', 'advisor'].includes(raw);
}

export function approvalPolicyApprovedCommandNeedsEvidenceHash(action) {
  const normalized = approvalPolicyNormalizeAction(action);
  return ['prepare', 'submit', 'acceptance', 'acceptance-prepare', 'customer_message'].includes(normalized);
}

export function approvalPolicyExpectedApprovedCommand(packet = {}) {
  const action = approvalPolicyNormalizeAction(packet.action);
  let command = String(packet.nextCommand || '').trim()
    + ' --policy ' + String(packet.policyProfile || '').trim()
    + ' --approval-hash ' + String(packet.packetHash || '').trim();
  if (action === 'submit' && packet.allowResubmit === true) command += ' --allow-resubmit';
  if (action === 'submit' && packet.allowMissingDuplicatePreflight === true) command += ' --allow-missing-duplicate-preflight';
  if (['prepare', 'submit'].includes(action) && packet.allowBlockedQualitySubmit === true) command += ' --allow-blocked-quality-submit';
  if (['acceptance', 'acceptance-prepare'].includes(action) && packet.ignoreExistingAcceptance === true) command += ' --ignore-existing-acceptance';
  if (approvalPolicyApprovedCommandNeedsAutoFreshEvidence(packet.action)) command += ' --auto-fresh-evidence';
  if (approvalPolicyApprovedCommandNeedsEvidenceHash(packet.action)) command += ' --evidence-hash <evidenceHash>';
  return command.trim();
}

export function approvalPolicyMaterializeApprovedCommand(command, evidenceHash) {
  const raw = String(command || '').trim();
  if (!raw || !evidenceHash) return null;
  if (raw.includes('<evidenceHash>')) return raw.replaceAll('<evidenceHash>', evidenceHash);
  if (/\s--evidence-hash=\S+/.test(raw)) return raw.replace(/\s--evidence-hash=\S+/, ' --evidence-hash=' + evidenceHash);
  if (/\s--evidence-hash\s+\S+/.test(raw)) return raw.replace(/\s--evidence-hash\s+\S+/, ' --evidence-hash ' + evidenceHash);
  return raw + ' --evidence-hash ' + evidenceHash;
}

export function approvalPolicyApprovedCommandIntegrityIssues(packet = {}) {
  const issues = [];
  if (!String(packet.approvedCommand || '').trim()) return issues;
  if (!String(packet.nextCommand || '').trim()) {
    issues.push('approval approved command requires a canonical next command');
  } else if (packet.packetHash && String(packet.approvedCommand) !== approvalPolicyExpectedApprovedCommand(packet)) {
    issues.push('approval approved command does not match immutable packet fields');
  }
  return issues;
}

function humanFeedbackValidationBlockerCodes(validation = {}) {
  return (validation?.blockers || [])
    .map((blocker) => String(blocker?.code || blocker || '').trim())
    .filter(Boolean);
}

export function approvalPolicyCustomerMessageApprovalIssues(packet = {}) {
  const issues = [];
  if (!String(packet.humanFeedbackRevisionContractHash || '').trim()) {
    issues.push('customer message approval must bind human feedback contract hash');
  }
  if (packet.actionEnvelope?.exactCommandRequired !== true) {
    issues.push('customer message approval requires an exact command envelope');
  }
  if (!String(packet.nextCommand || '').trim()) {
    issues.push('customer message approval requires a canonical next command');
  } else if (String(packet.actionEnvelope?.commandPreview || '').trim() !== String(packet.nextCommand || '').trim()) {
    issues.push('customer message approval exact command envelope mismatch');
  }
  if (!String(packet.approvedCommand || '').trim()) {
    issues.push('customer message approval requires an approved command');
  } else if (!/\s--evidence-hash(\s|=|$)/.test(String(packet.approvedCommand))) {
    issues.push('customer message approved command must require an evidence hash');
  } else if (packet.packetHash && String(packet.approvedCommand) !== approvalPolicyExpectedApprovedCommand(packet)) {
    issues.push('customer message approved command does not match immutable packet fields');
  }
  return issues;
}

export function approvalPolicyCustomerMessageEvidenceIssues(bundle = {}, packet = {}, {
  contractValidation = null,
  validateHumanFeedbackRevisionContract = null,
} = {}) {
  const issues = [];
  if (approvalPolicyNormalizeEvidenceStage(bundle.stage) !== 'human_feedback_message') {
    issues.push('customer message evidence must use human_feedback_message stage');
  }
  const packetApprovedCommand = approvalPolicyExpectedApprovedCommand(packet);
  const evidenceApprovedCommand = String(bundle.approval?.approvedCommand || '').trim();
  const packetNextCommand = String(packet.nextCommand || '').trim();
  const evidenceNextCommand = String(bundle.approval?.nextCommand || '').trim();
  const evidenceEnvelope = bundle.approvalActionEnvelope || bundle.approval?.actionEnvelope || {};
  const evidenceEnvelopeCommand = String(evidenceEnvelope.commandPreview || '').trim();
  if (!evidenceApprovedCommand) {
    issues.push('customer message evidence must carry an approved command');
  } else if (packetApprovedCommand && evidenceApprovedCommand !== packetApprovedCommand) {
    issues.push('customer message evidence approved command mismatch');
  }
  if (!evidenceNextCommand) {
    issues.push('customer message evidence must carry the approved next command');
  } else if (packetNextCommand && evidenceNextCommand !== packetNextCommand) {
    issues.push('customer message evidence next command mismatch');
  }
  if (evidenceEnvelope.exactCommandRequired !== true) {
    issues.push('customer message evidence requires an exact command envelope');
  }
  if (!evidenceEnvelopeCommand) {
    issues.push('customer message evidence must carry exact command envelope');
  } else if (packetNextCommand && evidenceEnvelopeCommand !== packetNextCommand) {
    issues.push('customer message evidence exact command envelope mismatch');
  }
  const expectedExecutionCommand = approvalPolicyMaterializeApprovedCommand(packetApprovedCommand, bundle.bundleHash);
  const evidenceExecutionCommand = String(bundle.executionCommand || '').trim();
  if (!evidenceExecutionCommand) {
    issues.push('customer message evidence execution command required');
  } else if (expectedExecutionCommand && evidenceExecutionCommand !== expectedExecutionCommand) {
    issues.push('customer message evidence execution command mismatch');
  }
  const evidenceContractHash = String(bundle.humanFeedbackRevisionContract?.contractHash || '').trim();
  const approvalContractHash = String(packet.humanFeedbackRevisionContractHash || '').trim();
  if (!evidenceContractHash) {
    issues.push('customer message evidence must carry human feedback contract hash');
  } else if (approvalContractHash && evidenceContractHash !== approvalContractHash) {
    issues.push('customer message approval/evidence contract hash mismatch');
  }
  let validation = contractValidation;
  if (!validation && typeof validateHumanFeedbackRevisionContract === 'function') {
    validation = validateHumanFeedbackRevisionContract(bundle.humanFeedbackRevisionContract, { stage: 'human_feedback_message' });
  }
  if (validation && validation.ok === false) {
    issues.push('customer message evidence human feedback contract invalid: ' + humanFeedbackValidationBlockerCodes(validation).join(','));
  }
  return issues;
}

function pushFreshEvidenceArg(argv, args, key) {
  if (args?.[key] === undefined || args?.[key] === null || args?.[key] === false) return;
  argv.push('--' + key);
  if (args[key] !== true) argv.push(String(args[key]));
}

function blockerText(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value.code) return String(value.code);
  if (value.message) return String(value.message);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function blockerList(values = [], fallback = null) {
  const out = (values || []).map(blockerText).filter(Boolean);
  if (!out.length && fallback) out.push(fallback);
  return [...new Set(out)];
}

export function freshEvidenceHandshakeRequested(args = {}, { env = {} } = {}) {
  return !!(
    args['fresh-evidence']
    || args['auto-fresh-evidence']
    || env.ZBJ_AUTO_FRESH_EVIDENCE === '1'
  );
}

export function buildFreshEvidenceHandshakeCommands({
  taskId,
  stage = 'review',
  args = {},
  evidenceScript = 'src/steps/final-evidence-bundle.mjs',
  evidenceCommand = 'write',
  invariantScript = 'src/steps/invariant-gate.mjs',
  invariantCommand = 'summary',
  passThroughKeys = FRESH_EVIDENCE_PASS_THROUGH_KEYS,
} = {}) {
  if (!taskId) throw new Error('fresh evidence handshake command plan requires taskId');
  const evidence = [
    evidenceScript,
    evidenceCommand,
    '--task',
    String(taskId),
    '--stage',
    String(stage),
  ];
  for (const key of passThroughKeys) pushFreshEvidenceArg(evidence, args, key);
  const invariants = [
    invariantScript,
    invariantCommand,
    '--task',
    String(taskId),
    '--stage',
    String(stage),
  ];
  return { evidence, invariants };
}

export function buildFreshEvidenceHandshakePlan({
  taskId,
  stage = 'review',
  args = {},
  enabled = false,
  env = {},
  ...commandOptions
} = {}) {
  if (!taskId) throw new Error('fresh evidence handshake plan requires taskId');
  const shouldRun = enabled || freshEvidenceHandshakeRequested(args, { env });
  const commands = buildFreshEvidenceHandshakeCommands({ taskId, stage, args, ...commandOptions });
  return {
    ok: true,
    execute: false,
    taskId: String(taskId),
    stage: String(stage),
    requested: shouldRun,
    commands,
    next: shouldRun
      ? 'run write to refresh evidence and verify invariants locally'
      : 'fresh evidence handshake not requested',
    safety: FRESH_EVIDENCE_HANDSHAKE_SAFETY,
  };
}

export function summarizeFreshEvidenceHandshakeStep(step = {}) {
  return {
    ok: !!step.ok,
    code: step.code ?? null,
    durationMs: step.durationMs ?? null,
    command: step.command || null,
    parsedOk: step.parsed?.ok ?? null,
    blockerType: step.parsed?.blockerType || null,
    blockers: step.parsed?.blockers || step.parsed?.issues || null,
    error: step.error || null,
  };
}

export function buildFreshEvidenceHandshakeResult({
  taskId = null,
  stage = 'review',
  args = {},
  enabled = false,
  env = {},
  evidenceStep = null,
  invariantStep = null,
} = {}) {
  const shouldRun = enabled || freshEvidenceHandshakeRequested(args, { env });
  if (!shouldRun) {
    return {
      ok: true,
      skipped: true,
      stage,
      evidenceHash: args['evidence-hash'] || null,
      next: 'fresh evidence handshake not requested',
      safety: FRESH_EVIDENCE_HANDSHAKE_SAFETY,
    };
  }
  const evidenceHash = evidenceStep?.parsed?.bundleHash || null;
  const blockers = [];
  if (!evidenceStep?.parsed) blockers.push('fresh_evidence_missing_json');
  if (evidenceStep?.parsed && evidenceStep.parsed.ok !== true) {
    blockers.push(...blockerList(evidenceStep.parsed.blockers, 'fresh_evidence_bundle_not_ready'));
  }
  if (!evidenceHash) blockers.push('fresh_evidence_hash_missing');
  if (!invariantStep?.parsed) blockers.push('fresh_evidence_invariant_missing_json');
  if (invariantStep?.parsed && invariantStep.parsed.ok !== true) {
    blockers.push(...blockerList(invariantStep.parsed.issues, 'fresh_evidence_invariants_failed'));
  }
  return {
    ok: blockers.length === 0,
    skipped: false,
    taskId: taskId ? String(taskId) : null,
    stage,
    evidenceHash,
    evidenceStep: summarizeFreshEvidenceHandshakeStep(evidenceStep),
    invariantStep: summarizeFreshEvidenceHandshakeStep(invariantStep),
    blockers: [...new Set(blockers)],
    next: blockers.length
      ? 'fix fresh evidence/invariant blockers before guarded execution'
      : 'pass --evidence-hash ' + evidenceHash + ' into the guarded command',
    safety: FRESH_EVIDENCE_HANDSHAKE_SAFETY,
  };
}

export function freshEvidenceHandshakeSelftest() {
  const plan = buildFreshEvidenceHandshakePlan({
    taskId: 999001,
    stage: 'spend',
    args: { 'approval-hash': 'packet-abc' },
  });
  const requested = freshEvidenceHandshakeRequested({ 'auto-fresh-evidence': true }, { env: {} });
  const skipped = buildFreshEvidenceHandshakeResult({
    taskId: 999001,
    stage: 'spend',
    args: {},
    enabled: false,
  });
  const passed = buildFreshEvidenceHandshakeResult({
    taskId: 999001,
    stage: 'spend',
    args: { 'auto-fresh-evidence': true },
    evidenceStep: {
      ok: true,
      code: 0,
      durationMs: 10,
      command: 'node src/steps/final-evidence-bundle.mjs write --task 999001 --stage spend',
      parsed: { ok: true, bundleHash: 'evidence-abc', blockers: [] },
    },
    invariantStep: {
      ok: true,
      code: 0,
      durationMs: 7,
      command: 'node src/steps/invariant-gate.mjs summary --task 999001 --stage spend',
      parsed: { ok: true, issues: [] },
    },
  });
  const blocked = buildFreshEvidenceHandshakeResult({
    taskId: 999001,
    stage: 'spend',
    enabled: true,
    evidenceStep: {
      ok: true,
      parsed: { ok: false, blockers: [{ code: 'approval_packet_not_ready' }] },
    },
    invariantStep: {
      ok: true,
      parsed: { ok: false, issues: ['evidence_source_stale'] },
    },
  });
  const ok = plan.ok === true
    && plan.commands.evidence.includes('--approval-hash')
    && plan.commands.invariants.includes('--stage')
    && requested === true
    && skipped.ok === true
    && skipped.skipped === true
    && passed.ok === true
    && passed.evidenceHash === 'evidence-abc'
    && passed.next.includes('evidence-abc')
    && blocked.ok === false
    && blocked.blockers.includes('approval_packet_not_ready')
    && blocked.blockers.includes('fresh_evidence_hash_missing')
    && blocked.blockers.includes('evidence_source_stale')
    && FRESH_EVIDENCE_HANDSHAKE_SAFETY.runsSubprocesses === false
    && FRESH_EVIDENCE_HANDSHAKE_SAFETY.grantsExecutionPermission === false;
  return {
    ok,
    version: FRESH_EVIDENCE_HANDSHAKE_VERSION,
    plan,
    skipped,
    passed,
    blocked,
    requested,
    handshakeHash: digest({
      version: FRESH_EVIDENCE_HANDSHAKE_VERSION,
      plan,
      passedHash: passed.evidenceHash,
      blockedBlockers: blocked.blockers,
      safety: FRESH_EVIDENCE_HANDSHAKE_SAFETY,
    }),
  };
}

export function approvalPolicyGateSelftest() {
  const basePacket = {
    version: 1,
    generatedAt: '2026-06-14T00:00:00.000Z',
    taskId: 42,
    action: 'spend',
    policyProfile: 'spend-allowed',
    budgetUsd: 1,
    providerId: 'auto',
    artifacts: [],
    approvalState: { status: 'issued', consumeCount: 0 },
  };
  const packetHash = approvalPacketBodyHash(basePacket);
  const packet = { ...basePacket, packetHash, nextCommand: 'npm run flow:worker -- --task 42' };
  const evidence = {
    version: 1,
    generatedAt: '2026-06-14T00:00:01.000Z',
    stage: 'spend',
    task: { taskId: 42 },
    approval: { packetHash, policyProfile: 'spend-allowed', approvalState: { status: 'issued' }, artifacts: [] },
    ok: true,
    blockers: [],
  };
  const bundleHash = evidenceBundleBodyHash(evidence);
  const submitPacket = {
    ...packet,
    action: 'submit',
    policyProfile: 'submit-allowed',
    nextCommand: 'npm run pitch:submit-live -- --task 42 --submit --privacy 2',
    allowResubmit: true,
  };
  submitPacket.packetHash = approvalPacketBodyHash(submitPacket);
  const expectedSubmitCommand = approvalPolicyExpectedApprovedCommand(submitPacket);
  const customerMessageContractHash = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const customerMessagePacket = {
    ...packet,
    action: 'im_send',
    policyProfile: 'submit-allowed',
    nextCommand: 'node send-customer-message.mjs --task 42 --image approved.png',
    humanFeedbackRevisionContractHash: customerMessageContractHash,
    actionEnvelope: {
      action: 'customer_message',
      policyProfile: 'submit-allowed',
      commandPreview: 'node send-customer-message.mjs --task 42 --image approved.png',
      exactCommandRequired: true,
    },
  };
  customerMessagePacket.packetHash = approvalPacketBodyHash(customerMessagePacket);
  customerMessagePacket.approvedCommand = approvalPolicyExpectedApprovedCommand(customerMessagePacket);
  const customerMessageEvidence = {
    version: 1,
    generatedAt: '2026-06-14T00:00:02.000Z',
    stage: 'buyer-feedback-message',
    task: { taskId: 42 },
    approval: {
      packetHash: customerMessagePacket.packetHash,
      policyProfile: 'submit-allowed',
      approvedCommand: customerMessagePacket.approvedCommand,
      nextCommand: customerMessagePacket.nextCommand,
      approvalState: { status: 'issued' },
      artifacts: [],
    },
    approvalActionEnvelope: customerMessagePacket.actionEnvelope,
    humanFeedbackRevisionContract: { contractHash: customerMessageContractHash },
    ok: true,
    blockers: [],
  };
  customerMessageEvidence.bundleHash = evidenceBundleBodyHash(customerMessageEvidence);
  customerMessageEvidence.executionCommand = approvalPolicyMaterializeApprovedCommand(
    customerMessagePacket.approvedCommand,
    customerMessageEvidence.bundleHash,
  );
  const customerMessageApprovalIssues = approvalPolicyCustomerMessageApprovalIssues(customerMessagePacket);
  const customerMessageEvidenceIssues = approvalPolicyCustomerMessageEvidenceIssues(customerMessageEvidence, customerMessagePacket, {
    contractValidation: { ok: true, blockers: [] },
  });
  const customerMessageInvalidContractIssues = approvalPolicyCustomerMessageEvidenceIssues(customerMessageEvidence, customerMessagePacket, {
    contractValidation: { ok: false, blockers: [{ code: 'human_feedback_revision_contract_required' }] },
  });
  const checks = {
    packetHash,
    bundleHash,
    packetHashIgnoresMutableApprovalState: packetHash === approvalPacketBodyHash({
      ...basePacket,
      approvalState: { status: 'consumed', consumedAt: '2026-06-14T00:05:00.000Z', consumeCount: 1 },
      approvedCommand: 'tampered',
    }),
    bundleHashIgnoresExecutionCommand: bundleHash === evidenceBundleBodyHash({
      ...evidence,
      executionCommand: 'run --evidence-hash something',
    }),
    stageAlias: approvalPolicyNormalizeEvidenceStage('buyer-feedback-message'),
    camelStageAlias: approvalPolicyNormalizeEvidenceStage('humanFeedbackHandoff'),
    actionAlias: approvalPolicyNormalizeAction('next-action-advisor'),
    camelActionAlias: approvalPolicyNormalizeAction('consumerFeedbackMessage'),
    actionMatchesSpendProvider: approvalPolicyActionMatchesApprovalPacket('spend', 'provider-spend'),
    actionMatchesSpendSemantic: approvalPolicyActionMatchesApprovalPacket('spend', 'semantic'),
    actionMatchesSpendExpand: approvalPolicyActionMatchesApprovalPacket('spend', 'expand5'),
    actionMatchesHumanFeedbackReferee: approvalPolicyActionMatchesEvidenceStage('semantic', 'human_feedback_referee'),
    expectedSpendCommand: approvalPolicyExpectedApprovedCommand(packet),
    expectedSubmitCommand,
    materializedSubmitCommand: approvalPolicyMaterializeApprovedCommand(expectedSubmitCommand, bundleHash),
    commandIntegrityIssues: approvalPolicyApprovedCommandIntegrityIssues({
      ...submitPacket,
      approvedCommand: expectedSubmitCommand + ' --tampered',
    }),
    customerMessageApprovalIssues,
    customerMessageEvidenceIssues,
    customerMessageInvalidContractIssues,
    safety: APPROVAL_POLICY_GATE_SAFETY,
  };
  const ok = /^[a-f0-9]{64}$/.test(packetHash)
    && /^[a-f0-9]{64}$/.test(bundleHash)
    && checks.packetHashIgnoresMutableApprovalState
    && checks.bundleHashIgnoresExecutionCommand
    && checks.stageAlias === 'human_feedback_message'
    && checks.camelStageAlias === 'human_feedback_handoff'
    && checks.actionAlias === 'semantic'
    && checks.camelActionAlias === 'customer_message'
    && checks.actionMatchesSpendProvider
    && checks.actionMatchesSpendSemantic
    && checks.actionMatchesSpendExpand
    && checks.actionMatchesHumanFeedbackReferee
    && checks.expectedSpendCommand.endsWith('--auto-fresh-evidence')
    && checks.expectedSubmitCommand.includes('--allow-resubmit')
    && checks.expectedSubmitCommand.endsWith('--evidence-hash <evidenceHash>')
    && checks.materializedSubmitCommand.endsWith('--evidence-hash ' + bundleHash)
    && checks.commandIntegrityIssues.some((issue) => /approved command does not match/.test(issue))
    && checks.customerMessageApprovalIssues.length === 0
    && checks.customerMessageEvidenceIssues.length === 0
    && checks.customerMessageInvalidContractIssues.some((issue) => /human_feedback_revision_contract_required/.test(issue))
    && APPROVAL_POLICY_GATE_SAFETY.grantsExecutionPermission === false;
  return {
    ok,
    version: APPROVAL_POLICY_GATE_VERSION,
    checks,
    policyGateHash: digest({
      version: APPROVAL_POLICY_GATE_VERSION,
      packetHash,
      bundleHash,
      expectedSubmitCommand,
      safety: APPROVAL_POLICY_GATE_SAFETY,
    }),
  };
}

export function buildApprovalPacket({
  action,
  policy,
  channelTask = null,
  plan = null,
  artifactPackage = null,
  reviewReport = null,
  messagePreview = null,
  reason = null,
  requestedBy = 'operator',
  budgetUsd = null,
  estimatedCostUsd = null,
  approved = false,
  approvedBy = null,
  expiresAt = null,
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
  approvalProvenance = null,
  evidenceRefs: refs = [],
  createdAt = null,
} = {}) {
  const normalizedAction = canonicalExternalAction(action);
  if (!normalizedAction || normalizedAction === EXTERNAL_ACTIONS.NONE) throw new Error('ApprovalPacket requires a concrete external action');
  if (!policy) throw new Error('ApprovalPacket requires policy');
  const timestamp = createdAt || nowIso();
  const boundMessagePreview = normalizedMessagePreview(messagePreview);
  const feedbackProductLine = approvalFeedbackDefaultProductLine(action);
  const ok = Boolean(approved);
  const status = ok ? 'approved' : 'pending_approval';
  const approvedByValue = ok ? normalizeText(approvedBy || requestedBy || 'operator') : null;
  const expiresAtValue = expiresAt || futureIso(timestamp, ttlMs);
  const taskKey = channelTask?.taskKey || plan?.taskKey || artifactPackage?.taskKey || reviewReport?.taskKey || null;
  const channelId = channelTask?.channelId || plan?.channelId || artifactPackage?.channelId || reviewReport?.channelId || null;
  const externalId = channelTask?.externalId || plan?.externalId || artifactPackage?.externalId || reviewReport?.externalId || null;
  const boundApprovalProvenance = approvalProvenanceDigest(approvalProvenance) || (ok
    ? defaultApprovalProvenance({
      action: normalizedAction,
      policy,
      taskKey,
      channelId,
      externalId,
      requestedBy,
      approvedBy: approvedByValue,
      reason,
      createdAt: timestamp,
    })
    : null);
  const immutable = {
    version: APPROVAL_PACKET_VERSION,
    action: normalizedAction,
    policy,
    ok,
    status,
    approvedBy: approvedByValue,
    expiresAt: expiresAtValue,
    taskKey,
    channelId,
    externalId,
    productLineId: canonicalProductLineOrNull(plan?.productLineId || artifactPackage?.productLineId || reviewReport?.productLineId || feedbackProductLine),
    workflowId: canonicalProductLineOrNull(plan?.workflowId || artifactPackage?.workflowId || reviewReport?.workflowId || feedbackProductLine),
    reason: normalizeText(reason || '') || null,
    requestedBy: normalizeText(requestedBy || '') || 'operator',
    budgetUsd: Number.isFinite(Number(budgetUsd)) ? Number(budgetUsd) : null,
    estimatedCostUsd: Number.isFinite(Number(estimatedCostUsd)) ? Number(estimatedCostUsd) : null,
    channelTask: channelTaskDigest(channelTask),
    plan: planDigest(plan),
    artifactPackage: artifactDigest(artifactPackage),
    reviewReport: reviewDigest(reviewReport),
    approvalProvenance: boundApprovalProvenance,
    ...(boundMessagePreview ? { messagePreview: boundMessagePreview } : {}),
    evidenceRefs: evidenceRefs(refs),
  };
  const approvalHash = computeApprovalPacketHash(immutable);
  return {
    version: APPROVAL_PACKET_VERSION,
    kind: 'ApprovalPacket',
    ...immutable,
    approvalHash,
    hash: approvalHash,
    createdAt: timestamp,
    safety: {
      packetOnly: true,
      executesExternalAction: false,
      sourceSnapshotRedacted: true,
    },
  };
}

export function buildFreshEvidenceBundle({
  approvalPacket,
  action = approvalPacket?.action,
  channelTask = null,
  plan = null,
  artifactPackage = null,
  reviewReport = null,
  prepareEvidence = null,
  duplicatePreflight = null,
  messagePreview = null,
  deliveryArtifactBound = false,
  deploymentTarget = null,
  buildEvidence = null,
  ok = true,
  expiresAt = null,
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
  approvalProvenance = null,
  evidenceRefs: refs = [],
  createdAt = null,
} = {}) {
  if (!approvalPacket?.approvalHash) throw new Error('FreshEvidenceBundle requires approvalPacket');
  const normalizedAction = canonicalExternalAction(action);
  if (!normalizedAction || normalizedAction === EXTERNAL_ACTIONS.NONE) throw new Error('FreshEvidenceBundle requires a concrete external action');
  const timestamp = createdAt || nowIso();
  const okValue = Boolean(ok);
  const expiresAtValue = expiresAt || futureIso(timestamp, ttlMs);
  const feedbackProductLine = approvalFeedbackDefaultProductLine(action);
  const boundApprovalProvenance = approvalProvenanceDigest(approvalProvenance || approvalPacket?.approvalProvenance);
  const immutable = {
    version: APPROVAL_PACKET_VERSION,
    action: normalizedAction,
    approvalHash: approvalPacket.approvalHash,
    ok: okValue,
    expiresAt: expiresAtValue,
    taskKey: approvalPacket.taskKey || channelTask?.taskKey || plan?.taskKey || artifactPackage?.taskKey || reviewReport?.taskKey || null,
    channelId: approvalPacket.channelId || channelTask?.channelId || plan?.channelId || artifactPackage?.channelId || reviewReport?.channelId || null,
    externalId: approvalPacket.externalId || channelTask?.externalId || plan?.externalId || artifactPackage?.externalId || reviewReport?.externalId || null,
    productLineId: canonicalProductLineOrNull(approvalPacket.productLineId || plan?.productLineId || artifactPackage?.productLineId || reviewReport?.productLineId || feedbackProductLine),
    workflowId: canonicalProductLineOrNull(approvalPacket.workflowId || plan?.workflowId || artifactPackage?.workflowId || reviewReport?.workflowId || feedbackProductLine),
    approvalProvenance: boundApprovalProvenance,
    state: evidenceBundleDigest({
      action: normalizedAction,
      channelTask,
      plan,
      artifactPackage,
      reviewReport,
      prepareEvidence,
      duplicatePreflight,
      messagePreview,
      deliveryArtifactBound,
      deploymentTarget,
      buildEvidence,
      evidenceRefs: refs,
    }),
  };
  const evidenceHash = computeFreshEvidenceBundleHash(immutable);
  return {
    version: APPROVAL_PACKET_VERSION,
    kind: 'FreshEvidenceBundle',
    ...immutable,
    evidenceHash,
    hash: evidenceHash,
    evidenceRefs: evidenceRefs(refs),
    createdAt: timestamp,
    safety: {
      bundleOnly: true,
      executesExternalAction: false,
      sourceSnapshotRedacted: true,
    },
  };
}

export function buildApprovedExecutionGateRequest({
  approvalPacket,
  evidenceBundle,
  action = approvalPacket?.action,
  policy = approvalPacket?.policy,
  channelTask = null,
  plan = null,
  generationJob = null,
  artifactPackage = null,
  reviewReport = null,
  prepareEvidence = null,
  duplicatePreflight = null,
  estimatedCostUsd = approvalPacket?.estimatedCostUsd,
  messagePreview = null,
  deliveryArtifactBound = false,
  deploymentTarget = null,
  buildEvidence = null,
} = {}) {
  return buildExecutionGateRequest({
    action,
    policy,
    channelTask,
    plan,
    generationJob,
    artifactPackage,
    reviewReport,
    approval: approvalPacket,
    evidenceBundle,
    prepareEvidence,
    duplicatePreflight,
    estimatedCostUsd,
    messagePreview,
    deliveryArtifactBound,
    deploymentTarget,
    buildEvidence,
  });
}

export function evaluateApprovedExecution({
  approvalPacket,
  evidenceBundle,
  ...request
} = {}) {
  return evaluateExecutionGate(buildApprovedExecutionGateRequest({
    approvalPacket,
    evidenceBundle,
    ...request,
  }));
}
