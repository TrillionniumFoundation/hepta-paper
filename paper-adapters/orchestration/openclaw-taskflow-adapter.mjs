import { assertTaskFlowPort } from '../../paper-ports/task-flow-port.mjs';

export function taskFlowPilotEnabled(env = process.env) {
  return String(env?.HEPTA_TASKFLOW_PILOT || '') === '1';
}

export function bindOpenClawTaskFlow({ api, ctx = null, sessionKey = null, requesterOrigin = null } = {}) {
  const runtime = api?.runtime?.tasks?.flow || null;
  if (!runtime) throw new Error('OpenClaw api.runtime.tasks.flow is required');
  const bound = ctx
    ? runtime.fromToolContext(ctx)
    : runtime.bindSession({ sessionKey, requesterOrigin });
  return assertTaskFlowPort(bound);
}

export function openClawTaskFlowRuntimeStatus({ api, enabled = taskFlowPilotEnabled() } = {}) {
  const canonicalRuntimePresent = Boolean(api?.runtime?.tasks?.flow);
  return Object.freeze({
    version: 1,
    kind: 'OpenClawTaskFlowRuntimeStatus',
    status: enabled && canonicalRuntimePresent
      ? 'taskflow_pilot_runtime_ready'
      : 'taskflow_pilot_runtime_blocked',
    enabled,
    canonicalRuntimePresent,
    canonicalEntrypoint: 'api.runtime.tasks.flow',
    businessSourceOfTruth: 'hepta_sqlite_and_verified_receipts',
    grantsSubmissionAuthority: false,
    externalActionPerformed: false,
    blockers: [
      ...(enabled ? [] : ['taskflow_pilot_feature_disabled']),
      ...(canonicalRuntimePresent ? [] : ['taskflow_canonical_runtime_missing']),
    ],
  });
}
