import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  CODEX_MODEL_AVAILABILITY_CANARY_MAXIMUM_AGE_MS,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const ACTIONS = new Set(['launch', 'resume', 'converge']);
const LAUNCH_MODES = new Set(['golden-bootstrap', 'production-run']);
const RESIDENT_SCOPE_ID = 'resident-autonomous-research-supervisor';
const DISPATCH_AUTHORIZATION_MAXIMUM_AGE_MS = 5 * 60 * 1000;
const AUTHORIZATION_KEYS = Object.freeze([
  'action',
  'autonomousResearchSupervisorDispatchAuthorizationHash',
  'campaignId',
  'campaignLeaseBindingHash',
  'campaignLeaseExpiresAt',
  'campaignLeaseGeneration',
  'campaignPlanHash',
  'dispatchCount',
  'expiresAt',
  'issuedAt',
  'kind',
  'launchMode',
  'providerCanaryExpiresAt',
  'providerCanaryObservedAt',
  'providerCanaryPairReceiptHash',
  'providerCanaryStateBindingHash',
  'providerConfigurationHash',
  'residentInstanceLeaseBindingHash',
  'residentInstanceLeaseExpiresAt',
  'residentInstanceLeaseGeneration',
  'residentInstanceScopeId',
  'scope',
  'status',
  'version',
].sort());
const privateAuthorizations = new WeakMap();

function canonicalTime(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp : null;
}

function observedTime(value, errorCode) {
  const observed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(observed.getTime())) throw new Error(errorCode);
  return observed;
}

function leaseBinding(lease) {
  const payload = Object.freeze({
    campaignId: String(lease?.campaignId || ''),
    ownerId: String(lease?.ownerId || ''),
    leaseGeneration: Number(lease?.leaseGeneration),
    leaseTokenHash: hashRecord('AutonomousResearchSupervisorCampaignLeaseToken', {
      leaseToken: String(lease?.leaseToken || ''),
    }),
  });
  return hashRecord('AutonomousResearchSupervisorCampaignLeaseBinding', payload);
}

function residentLeaseBinding(context) {
  const payload = Object.freeze({
    scopeId: RESIDENT_SCOPE_ID,
    kind: String(context?.kind || ''),
    stage: String(context?.stage || ''),
    ownerId: String(context?.ownerId || ''),
    leaseGeneration: Number(context?.leaseGeneration),
    leaseTokenHash: hashRecord('AutonomousResearchResidentInstanceLeaseToken', {
      leaseToken: String(context?.lease?.leaseToken || ''),
    }),
    leaseExpiresAt: String(context?.leaseExpiresAt || ''),
  });
  return hashRecord('AutonomousResearchResidentInstanceLeaseBinding', payload);
}

function providerCanaryStateBinding(state) {
  const payload = Object.freeze({
    campaignId: String(state?.campaignId || ''),
    dispatchCount: Number(state?.dispatchCount),
    providerCanaryIntervalMs: Number(state?.policy?.providerCanaryIntervalMs),
    lastProviderCanaryStatus: String(state?.lastProviderCanaryStatus || ''),
    lastProviderCanaryReceiptHash: String(state?.lastProviderCanaryReceiptHash || ''),
    lastProviderCanaryAt: String(state?.lastProviderCanaryAt || ''),
    leaseOwner: String(state?.leaseOwner || ''),
    leaseGeneration: Number(state?.leaseGeneration),
    leaseTokenHash: hashRecord('AutonomousResearchSupervisorCampaignLeaseToken', {
      leaseToken: String(state?.leaseToken || ''),
    }),
  });
  return hashRecord('AutonomousResearchSupervisorProviderCanaryStateBinding', payload);
}

function authorizationHashValid(authorization) {
  if (!authorization || !SHA256.test(String(
    authorization.autonomousResearchSupervisorDispatchAuthorizationHash || '',
  )) || JSON.stringify(Object.keys(authorization).sort())
    !== JSON.stringify(AUTHORIZATION_KEYS)) return false;
  const {
    autonomousResearchSupervisorDispatchAuthorizationHash: _hash,
    ...payload
  } = authorization;
  return hashRecord('AutonomousResearchSupervisorDispatchAuthorization', payload)
    === authorization.autonomousResearchSupervisorDispatchAuthorizationHash;
}

export function issueAutonomousResearchSupervisorDispatchAuthorization({
  campaignId,
  campaignPlanHash,
  launchMode,
  action,
  providerConfigurationHash,
  campaignLease,
  residentLeaseContext,
  providerCanaryState,
  now = new Date(),
  assertCampaignLease,
  readCampaignState,
} = {}) {
  const issuedAt = observedTime(
    now,
    'autonomous_research_supervisor_dispatch_authorization_clock_invalid',
  );
  const canaryObservedAtMs = canonicalTime(providerCanaryState?.lastProviderCanaryAt);
  const leaseExpiresAtMs = canonicalTime(providerCanaryState?.leaseExpiresAt);
  const residentLeaseExpiresAtMs = canonicalTime(residentLeaseContext?.leaseExpiresAt);
  const intervalMs = Math.min(
    Number(providerCanaryState?.policy?.providerCanaryIntervalMs || 0),
    CODEX_MODEL_AVAILABILITY_CANARY_MAXIMUM_AGE_MS,
  );
  const canaryExpiresAtMs = Number.isFinite(canaryObservedAtMs)
    ? canaryObservedAtMs + intervalMs : null;
  const leaseMatchesState = campaignLease?.campaignId === campaignId
    && providerCanaryState?.campaignId === campaignId
    && providerCanaryState?.leaseOwner === campaignLease?.ownerId
    && providerCanaryState?.leaseToken === campaignLease?.leaseToken
    && Number(providerCanaryState?.leaseGeneration) === Number(campaignLease?.leaseGeneration);
  const residentLease = residentLeaseContext?.lease;
  const residentLeaseValid = residentLeaseContext?.kind
      === 'AutonomousResearchResidentLeaseContext'
    && residentLeaseContext?.stage === 'before_campaign_dispatch'
    && residentLeaseContext?.ownerId === campaignLease?.ownerId
    && residentLease?.ownerId === residentLeaseContext?.ownerId
    && Number.isSafeInteger(Number(residentLeaseContext?.leaseGeneration))
    && Number(residentLeaseContext.leaseGeneration) >= 1
    && Number(residentLease?.leaseGeneration) === Number(residentLeaseContext.leaseGeneration)
    && typeof residentLease?.leaseToken === 'string' && residentLease.leaseToken.length > 0
    && canonicalTime(residentLease?.expiresAt) === residentLeaseExpiresAtMs
    && Number.isFinite(residentLeaseExpiresAtMs)
    && issuedAt.getTime() < residentLeaseExpiresAtMs
    && typeof residentLeaseContext?.assertCurrent === 'function';
  if (!campaignId || !ACTIONS.has(action)
    || !SHA256.test(String(campaignPlanHash || ''))
    || !LAUNCH_MODES.has(launchMode)
    || !SHA256.test(String(providerConfigurationHash || ''))
    || providerCanaryState?.lastProviderCanaryStatus !== 'verified'
    || !SHA256.test(String(providerCanaryState?.lastProviderCanaryReceiptHash || ''))
    || !Number.isFinite(canaryObservedAtMs) || !Number.isFinite(canaryExpiresAtMs)
    || intervalMs < 1 || issuedAt.getTime() < canaryObservedAtMs
    || issuedAt.getTime() >= canaryExpiresAtMs
    || !Number.isFinite(leaseExpiresAtMs) || issuedAt.getTime() >= leaseExpiresAtMs
    || !Number.isSafeInteger(Number(providerCanaryState?.dispatchCount))
    || Number(providerCanaryState.dispatchCount) < 1
    || !leaseMatchesState || !residentLeaseValid
    || typeof assertCampaignLease !== 'function'
    || typeof readCampaignState !== 'function') {
    throw new Error('autonomous_research_supervisor_dispatch_authorization_invalid');
  }
  let persistedCampaignState;
  try {
    assertCampaignLease({ lease: campaignLease, now: new Date(issuedAt) });
    residentLeaseContext.assertCurrent({ now: new Date(issuedAt) });
    persistedCampaignState = readCampaignState(campaignId);
  } catch {
    throw new Error('autonomous_research_supervisor_dispatch_authorization_invalid');
  }
  const canaryStateBindingHash = providerCanaryStateBinding(providerCanaryState);
  if (providerCanaryStateBinding(persistedCampaignState) !== canaryStateBindingHash) {
    throw new Error('autonomous_research_supervisor_dispatch_authorization_invalid');
  }
  const expiresAtMs = Math.min(
    canaryExpiresAtMs,
    leaseExpiresAtMs,
    residentLeaseExpiresAtMs,
    issuedAt.getTime() + DISPATCH_AUTHORIZATION_MAXIMUM_AGE_MS,
  );
  const payload = Object.freeze({
    version: 3,
    kind: 'AutonomousResearchSupervisorDispatchAuthorization',
    status: 'autonomous_research_supervisor_dispatch_authorized',
    scope: 'resident_supervisor_machine_intake_dispatch_v3',
    campaignId,
    campaignPlanHash,
    launchMode,
    action,
    providerConfigurationHash,
    providerCanaryPairReceiptHash: providerCanaryState.lastProviderCanaryReceiptHash,
    providerCanaryObservedAt: new Date(canaryObservedAtMs).toISOString(),
    providerCanaryExpiresAt: new Date(canaryExpiresAtMs).toISOString(),
    providerCanaryStateBindingHash: canaryStateBindingHash,
    campaignLeaseBindingHash: leaseBinding(campaignLease),
    campaignLeaseGeneration: Number(campaignLease.leaseGeneration),
    campaignLeaseExpiresAt: new Date(leaseExpiresAtMs).toISOString(),
    residentInstanceScopeId: RESIDENT_SCOPE_ID,
    residentInstanceLeaseBindingHash: residentLeaseBinding(residentLeaseContext),
    residentInstanceLeaseGeneration: Number(residentLeaseContext.leaseGeneration),
    residentInstanceLeaseExpiresAt: new Date(residentLeaseExpiresAtMs).toISOString(),
    dispatchCount: Number(providerCanaryState.dispatchCount),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
  const authorization = Object.freeze({
    ...payload,
    autonomousResearchSupervisorDispatchAuthorizationHash: hashRecord(
      'AutonomousResearchSupervisorDispatchAuthorization',
      payload,
    ),
  });
  privateAuthorizations.set(authorization, Object.freeze({
    campaignLease,
    residentLeaseContext,
    campaignPlanHash,
    launchMode,
    providerCanaryStateBindingHash: canaryStateBindingHash,
    assertCampaignLease,
    readCampaignState,
    readinessReserved: false,
    consumed: false,
  }));
  return authorization;
}

export function verifyAutonomousResearchSupervisorDispatchAuthorization({
  authorization,
  campaignId,
  campaignPlanHash,
  launchMode,
  action,
  providerConfigurationHash,
  now = new Date(),
  consume = false,
  reserveReadiness = false,
} = {}) {
  const privateState = privateAuthorizations.get(authorization);
  const observedAt = observedTime(
    now,
    'autonomous_research_supervisor_dispatch_authorization_clock_invalid',
  );
  const issuedAtMs = canonicalTime(authorization?.issuedAt);
  const expiresAtMs = canonicalTime(authorization?.expiresAt);
  const canaryObservedAtMs = canonicalTime(authorization?.providerCanaryObservedAt);
  const canaryExpiresAtMs = canonicalTime(authorization?.providerCanaryExpiresAt);
  const campaignLeaseExpiresAtMs = canonicalTime(authorization?.campaignLeaseExpiresAt);
  const residentLeaseExpiresAtMs = canonicalTime(
    authorization?.residentInstanceLeaseExpiresAt,
  );
  if (!privateState || privateState.consumed
    || (reserveReadiness && privateState.readinessReserved)
    || (reserveReadiness && consume)
    || typeof reserveReadiness !== 'boolean' || typeof consume !== 'boolean'
    || !authorizationHashValid(authorization)
    || authorization?.version !== 3
    || authorization?.kind !== 'AutonomousResearchSupervisorDispatchAuthorization'
    || authorization?.status !== 'autonomous_research_supervisor_dispatch_authorized'
    || authorization?.scope !== 'resident_supervisor_machine_intake_dispatch_v3'
    || authorization?.campaignId !== campaignId || authorization?.action !== action
    || authorization?.campaignPlanHash !== campaignPlanHash
    || authorization?.campaignPlanHash !== privateState.campaignPlanHash
    || !SHA256.test(String(authorization?.campaignPlanHash || ''))
    || authorization?.launchMode !== launchMode
    || authorization?.launchMode !== privateState.launchMode
    || !LAUNCH_MODES.has(authorization?.launchMode)
    || authorization?.providerConfigurationHash !== providerConfigurationHash
    || !SHA256.test(String(authorization?.providerCanaryPairReceiptHash || ''))
    || authorization?.providerCanaryStateBindingHash
      !== privateState.providerCanaryStateBindingHash
    || !SHA256.test(String(authorization?.providerCanaryStateBindingHash || ''))
    || authorization?.campaignLeaseBindingHash !== leaseBinding(privateState.campaignLease)
    || Number(authorization?.campaignLeaseGeneration)
      !== Number(privateState.campaignLease?.leaseGeneration)
    || authorization?.residentInstanceScopeId !== RESIDENT_SCOPE_ID
    || authorization?.residentInstanceLeaseBindingHash
      !== residentLeaseBinding(privateState.residentLeaseContext)
    || Number(authorization?.residentInstanceLeaseGeneration)
      !== Number(privateState.residentLeaseContext?.leaseGeneration)
    || !Number.isSafeInteger(Number(authorization?.dispatchCount))
    || Number(authorization.dispatchCount) < 1
    || !Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)
    || !Number.isFinite(canaryObservedAtMs) || !Number.isFinite(canaryExpiresAtMs)
    || !Number.isFinite(campaignLeaseExpiresAtMs)
    || !Number.isFinite(residentLeaseExpiresAtMs)
    || expiresAtMs !== Math.min(
      canaryExpiresAtMs,
      campaignLeaseExpiresAtMs,
      residentLeaseExpiresAtMs,
      issuedAtMs + DISPATCH_AUTHORIZATION_MAXIMUM_AGE_MS,
    )
    || canaryExpiresAtMs - canaryObservedAtMs
      > CODEX_MODEL_AVAILABILITY_CANARY_MAXIMUM_AGE_MS
    || observedAt.getTime() < issuedAtMs || observedAt.getTime() >= expiresAtMs
    || observedAt.getTime() < canaryObservedAtMs
    || observedAt.getTime() >= canaryExpiresAtMs) return false;
  try {
    privateState.assertCampaignLease({
      lease: privateState.campaignLease,
      now: new Date(observedAt),
    });
    privateState.residentLeaseContext.assertCurrent({
      now: new Date(observedAt),
    });
    if (providerCanaryStateBinding(
      privateState.readCampaignState(campaignId),
    ) !== privateState.providerCanaryStateBindingHash) return false;
  } catch {
    return false;
  }
  if (consume || reserveReadiness) {
    privateAuthorizations.set(authorization, Object.freeze({
      ...privateState,
      readinessReserved: privateState.readinessReserved || reserveReadiness,
      consumed: privateState.consumed || consume,
    }));
  }
  return true;
}
