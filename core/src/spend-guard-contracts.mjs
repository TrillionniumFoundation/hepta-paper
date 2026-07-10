import { digest } from './hash-utils.mjs';

export const SPEND_GUARD_CONTRACT_VERSION = 1;

export const SPEND_GUARD_SAFETY = Object.freeze({
  localContractOnly: true,
  readsFiles: false,
  writesFiles: false,
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

export function normalizeSpendGuardAction(action) {
  const raw = String(action || 'spend').toLowerCase();
  if (['control-model', 'control_model', 'semantic-intake', 'semantic_intake', 'next-action-advisor', 'next_action_advisor', 'advisor'].includes(raw)) return 'spend';
  if (raw === 'semantic' || raw === 'expand5' || raw === 'provider-probe') return 'spend';
  return raw;
}

export function spendGuardSafeName(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function buildSpendGuardTokenPayload({
  tokenId,
  taskId,
  orderId = null,
  action = 'spend',
  providerId = null,
  policyProfile = null,
  approvalHash = null,
  evidenceHash = null,
  nowMs = Date.now(),
  ttlMs = 30 * 60 * 1000,
  maxUses = 1,
  parentStep = null,
  pid = null,
} = {}) {
  if (!tokenId) throw new Error('spend guard token payload requires tokenId');
  if (!taskId) throw new Error('spend guard token payload requires taskId');
  const now = Number(nowMs || Date.now());
  const payload = {
    version: SPEND_GUARD_CONTRACT_VERSION,
    tokenId,
    taskId: String(taskId),
    orderId: orderId == null ? null : String(orderId),
    action: normalizeSpendGuardAction(action),
    providerId: providerId || null,
    policyProfile: policyProfile || null,
    approvalHash: approvalHash || null,
    evidenceHash: evidenceHash || null,
    maxUses: Math.max(1, Number(maxUses || 1)),
    useCount: 0,
    useHistory: [],
    parentStep: parentStep || null,
    pid,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Number(ttlMs || 30 * 60 * 1000)).toISOString(),
    safety: SPEND_GUARD_SAFETY,
  };
  return {
    ...payload,
    tokenHash: digest(payload),
  };
}

export function spendGuardTokenIssues(token = {}, {
  taskId = null,
  action = 'spend',
  providerId = null,
  nowMs = Date.now(),
} = {}) {
  const issues = [];
  if (!token || typeof token !== 'object') return ['token missing'];
  if (taskId && String(token.taskId) !== String(taskId)) issues.push('task mismatch');
  if (normalizeSpendGuardAction(token.action) !== normalizeSpendGuardAction(action)) issues.push('action mismatch');
  const expiresAt = Date.parse(token.expiresAt || '');
  if (!Number.isFinite(expiresAt) || expiresAt <= Number(nowMs || Date.now())) issues.push('token expired');
  if (providerId && token.providerId && token.providerId !== 'auto' && providerId !== 'auto' && token.providerId !== providerId) issues.push('provider mismatch');
  const maxUses = Math.max(1, Number(token.maxUses || 1));
  const useCount = Math.max(0, Number(token.useCount || 0));
  if (useCount >= maxUses) issues.push('token exhausted');
  return issues;
}

export function verifySpendGuardPolicyHashBinding(controlGate = {}) {
  const approvalHash = controlGate?.approval?.packetHash || null;
  const evidenceHash = controlGate?.evidence?.bundleHash || null;
  const issues = [];
  if (!approvalHash) issues.push('approval_packet_hash_missing_after_policy_gate');
  if (!evidenceHash) issues.push('evidence_bundle_hash_missing_after_policy_gate');
  return {
    ok: issues.length === 0,
    approvalHash,
    evidenceHash,
    issues,
    status: issues.length ? 'blocked_spend_guard_policy_hash_binding' : 'pass_spend_guard_policy_hash_binding',
    bindingHash: issues.length ? null : digest({
      version: SPEND_GUARD_CONTRACT_VERSION,
      approvalHash,
      evidenceHash,
    }),
    safety: SPEND_GUARD_SAFETY,
  };
}

export function nextSpendGuardUseRecord({
  token = {},
  taskId = null,
  action = 'spend',
  providerId = null,
  parentStep = null,
  pid = null,
  at = new Date().toISOString(),
} = {}) {
  return {
    at,
    pid,
    taskId: taskId == null ? null : String(taskId),
    action: normalizeSpendGuardAction(action || token.action),
    providerId: providerId || null,
    parentStep: parentStep || null,
  };
}

export function applySpendGuardTokenUse(token = {}, record = {}) {
  const { tokenHash: _oldTokenHash, ...tokenPayload } = token || {};
  const nextPayload = {
    ...tokenPayload,
    useCount: Math.max(0, Number(token.useCount || 0)) + 1,
    lastUsedAt: record.at || new Date().toISOString(),
    useHistory: [
      ...(Array.isArray(token.useHistory) ? token.useHistory : []),
      record,
    ].slice(-50),
  };
  const tokenHash = digest(nextPayload);
  return {
    token: { ...nextPayload, tokenHash },
    tokenHash,
    safety: SPEND_GUARD_SAFETY,
  };
}

export function childSpendGuardTokenRequest({
  token = {},
  taskId = null,
  orderId = null,
  action = 'spend',
  providerId = null,
  maxUses = 1,
  parentStep = null,
} = {}) {
  return {
    version: SPEND_GUARD_CONTRACT_VERSION,
    taskId: taskId || token.taskId || null,
    orderId: orderId || token.orderId || null,
    action: normalizeSpendGuardAction(action || token.action),
    providerId: providerId || token.providerId || null,
    policyProfile: token.policyProfile || null,
    approvalHash: token.approvalHash || null,
    evidenceHash: token.evidenceHash || null,
    maxUses: Math.max(1, Number(maxUses || 1)),
    parentStep: parentStep || token.parentStep || null,
    safety: SPEND_GUARD_SAFETY,
  };
}

export function spendGuardContractsSelftest() {
  const nowMs = Date.parse('2026-06-21T00:00:00.000Z');
  const token = buildSpendGuardTokenPayload({
    tokenId: 'tok',
    taskId: '100',
    orderId: '200',
    action: 'control-model',
    providerId: 'openclaw-image',
    approvalHash: 'a',
    evidenceHash: 'e',
    nowMs,
    ttlMs: 60000,
    maxUses: 2,
    parentStep: 'selftest',
    pid: 1,
  });
  const validIssues = spendGuardTokenIssues(token, { taskId: '100', action: 'spend', providerId: 'openclaw-image', nowMs: nowMs + 1 });
  const mismatch = spendGuardTokenIssues(token, { taskId: 'other', action: 'spend', providerId: 'openclaw-image', nowMs: nowMs + 1 });
  const expired = spendGuardTokenIssues(token, { taskId: '100', action: 'spend', providerId: 'openclaw-image', nowMs: nowMs + 70000 });
  const binding = verifySpendGuardPolicyHashBinding({ approval: { packetHash: 'packet' }, evidence: { bundleHash: 'bundle' } });
  const missing = verifySpendGuardPolicyHashBinding({ approval: {}, evidence: { bundleHash: 'bundle' } });
  const record = nextSpendGuardUseRecord({ token, taskId: '100', action: 'spend', providerId: 'openclaw-image', parentStep: 'child', pid: 2, at: '2026-06-21T00:00:01.000Z' });
  const used = applySpendGuardTokenUse(token, record);
  const child = childSpendGuardTokenRequest({ token, maxUses: 3, parentStep: 'child' });
  const ok = token.action === 'spend'
    && token.tokenHash?.startsWith('sha256:')
    && validIssues.length === 0
    && mismatch.includes('task mismatch')
    && expired.includes('token expired')
    && binding.ok === true
    && missing.issues.includes('approval_packet_hash_missing_after_policy_gate')
    && used.token.useCount === 1
    && child.maxUses === 3
    && child.approvalHash === 'a'
    && child.safety.callsProviderOrModel === false;
  return { ok, token, validIssues, mismatch, expired, binding, missing, used, child, safety: SPEND_GUARD_SAFETY };
}
