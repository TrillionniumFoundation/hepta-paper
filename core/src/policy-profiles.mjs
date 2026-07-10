import { normalizeText } from './contracts.mjs';
import { EXECUTION_POLICIES } from './execution-gates.mjs';
import { digest } from './hash-utils.mjs';

export const POLICY_PROFILE_VERSION = 1;

export const POLICY_PROFILE_SAFETY = Object.freeze({
  localPolicyOnly: true,
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

export const POLICY_PROFILE_ACTIONS = Object.freeze({
  EXECUTE_PROVIDER: 'executeProvider',
  EXECUTE_SEMANTIC: 'executeSemantic',
  EXECUTE_IMPORT: 'executeImport',
  RESOLVE_LIVE: 'resolveLive',
  EXECUTE_PREPARE: 'executePrepare',
  SUBMIT: 'submit',
  EXTERNAL_NOTIFY: 'externalNotify',
});

export const POLICY_PROFILE_CAPABILITIES = Object.freeze({
  ALLOW_PROVIDER_SPEND: 'allowProviderSpend',
  ALLOW_SEMANTIC_SPEND: 'allowSemanticSpend',
  ALLOW_LOCAL_IMPORT: 'allowLocalImport',
  ALLOW_LIVE_READ: 'allowLiveRead',
  ALLOW_PREPARE_UPLOAD: 'allowPrepareUpload',
  ALLOW_SUBMIT: 'allowSubmit',
  ALLOW_EXTERNAL_NOTIFY: 'allowExternalNotify',
});

export const POLICY_ACTION_CHECKS = Object.freeze([
  Object.freeze([POLICY_PROFILE_ACTIONS.EXECUTE_PROVIDER, POLICY_PROFILE_CAPABILITIES.ALLOW_PROVIDER_SPEND, 'provider spend']),
  Object.freeze([POLICY_PROFILE_ACTIONS.EXECUTE_SEMANTIC, POLICY_PROFILE_CAPABILITIES.ALLOW_SEMANTIC_SPEND, 'semantic reviewer spend']),
  Object.freeze([POLICY_PROFILE_ACTIONS.EXECUTE_IMPORT, POLICY_PROFILE_CAPABILITIES.ALLOW_LOCAL_IMPORT, 'local import']),
  Object.freeze([POLICY_PROFILE_ACTIONS.RESOLVE_LIVE, POLICY_PROFILE_CAPABILITIES.ALLOW_LIVE_READ, 'live page read']),
  Object.freeze([POLICY_PROFILE_ACTIONS.EXECUTE_PREPARE, POLICY_PROFILE_CAPABILITIES.ALLOW_PREPARE_UPLOAD, 'prepare upload']),
  Object.freeze([POLICY_PROFILE_ACTIONS.SUBMIT, POLICY_PROFILE_CAPABILITIES.ALLOW_SUBMIT, 'real submit']),
  Object.freeze([POLICY_PROFILE_ACTIONS.EXTERNAL_NOTIFY, POLICY_PROFILE_CAPABILITIES.ALLOW_EXTERNAL_NOTIFY, 'external notification']),
]);

function profile({
  id,
  allowProviderSpend,
  allowSemanticSpend,
  allowLocalImport,
  allowLiveRead,
  allowPrepareUpload,
  allowSubmit,
  allowExternalNotify,
}) {
  return Object.freeze({
    id,
    allowProviderSpend: !!allowProviderSpend,
    allowSemanticSpend: !!allowSemanticSpend,
    allowLocalImport: !!allowLocalImport,
    allowLiveRead: !!allowLiveRead,
    allowPrepareUpload: !!allowPrepareUpload,
    allowSubmit: !!allowSubmit,
    allowExternalNotify: !!allowExternalNotify,
  });
}

export const POLICY_PROFILES = Object.freeze({
  [EXECUTION_POLICIES.SAFE_PLAN]: profile({
    id: EXECUTION_POLICIES.SAFE_PLAN,
    allowProviderSpend: false,
    allowSemanticSpend: false,
    allowLocalImport: false,
    allowLiveRead: false,
    allowPrepareUpload: false,
    allowSubmit: false,
    allowExternalNotify: false,
  }),
  [EXECUTION_POLICIES.SPEND_ALLOWED]: profile({
    id: EXECUTION_POLICIES.SPEND_ALLOWED,
    allowProviderSpend: true,
    allowSemanticSpend: true,
    allowLocalImport: true,
    allowLiveRead: false,
    allowPrepareUpload: false,
    allowSubmit: false,
    allowExternalNotify: false,
  }),
  [EXECUTION_POLICIES.PREPARE_ALLOWED]: profile({
    id: EXECUTION_POLICIES.PREPARE_ALLOWED,
    allowProviderSpend: true,
    allowSemanticSpend: true,
    allowLocalImport: true,
    allowLiveRead: true,
    allowPrepareUpload: true,
    allowSubmit: false,
    allowExternalNotify: false,
  }),
  [EXECUTION_POLICIES.SUBMIT_ALLOWED]: profile({
    id: EXECUTION_POLICIES.SUBMIT_ALLOWED,
    allowProviderSpend: true,
    allowSemanticSpend: true,
    allowLocalImport: true,
    allowLiveRead: true,
    allowPrepareUpload: true,
    allowSubmit: true,
    allowExternalNotify: true,
  }),
});

export function policyProfile(id = EXECUTION_POLICIES.SAFE_PLAN) {
  if (typeof id === 'object' && id) return id;
  const profileId = normalizeText(id || EXECUTION_POLICIES.SAFE_PLAN);
  const found = POLICY_PROFILES[profileId] || null;
  if (!found) throw new Error('unknown policy profile: ' + profileId);
  return found;
}

export function policyViolations({ profile = EXECUTION_POLICIES.SAFE_PLAN, actions = {} } = {}) {
  const resolved = policyProfile(profile);
  return POLICY_ACTION_CHECKS
    .filter(([action, capability]) => !!actions[action] && !resolved[capability])
    .map(([action, capability, label]) => ({
      action,
      capability,
      label,
      profile: resolved.id,
    }));
}

export function assertPolicyAllowed({ profile = EXECUTION_POLICIES.SAFE_PLAN, actions = {} } = {}) {
  const resolved = policyProfile(profile);
  const violations = policyViolations({ profile: resolved, actions });
  if (violations.length) {
    const error = new Error('policy profile blocks requested actions: ' + violations.map((item) => item.label).join(', '));
    error.violations = violations;
    error.policyProfile = resolved.id;
    throw error;
  }
  return {
    ok: true,
    profile: resolved,
    actions,
    safety: POLICY_PROFILE_SAFETY,
  };
}

export function summarizePolicyProfiles(profiles = POLICY_PROFILES) {
  const rows = Object.values(profiles).map((item) => ({
    id: item.id,
    allowedCapabilityCount: Object.values(POLICY_PROFILE_CAPABILITIES).filter((capability) => item[capability] === true).length,
    blockedCapabilityCount: Object.values(POLICY_PROFILE_CAPABILITIES).filter((capability) => item[capability] !== true).length,
  }));
  return {
    version: POLICY_PROFILE_VERSION,
    profileCount: rows.length,
    actionCount: POLICY_ACTION_CHECKS.length,
    rows,
    safety: POLICY_PROFILE_SAFETY,
    policyProfileSummaryHash: digest({
      version: POLICY_PROFILE_VERSION,
      rows,
      safety: POLICY_PROFILE_SAFETY,
    }),
  };
}

export function policyProfilesSelftest() {
  const blocked = policyViolations({
    profile: EXECUTION_POLICIES.SAFE_PLAN,
    actions: {
      executeProvider: true,
      executePrepare: true,
    },
  });
  const allowed = policyViolations({
    profile: EXECUTION_POLICIES.PREPARE_ALLOWED,
    actions: {
      executeProvider: true,
      executePrepare: true,
    },
  });
  const submitBlocked = policyViolations({
    profile: EXECUTION_POLICIES.PREPARE_ALLOWED,
    actions: {
      submit: true,
    },
  });
  const notifyBlocked = policyViolations({
    profile: EXECUTION_POLICIES.PREPARE_ALLOWED,
    actions: {
      externalNotify: true,
    },
  });
  const submitAllowed = assertPolicyAllowed({
    profile: EXECUTION_POLICIES.SUBMIT_ALLOWED,
    actions: {
      executeProvider: true,
      executeSemantic: true,
      executeImport: true,
      resolveLive: true,
      executePrepare: true,
      submit: true,
      externalNotify: true,
    },
  });
  const summary = summarizePolicyProfiles();
  const ok = blocked.length === 2
    && allowed.length === 0
    && submitBlocked.length === 1
    && notifyBlocked.length === 1
    && submitAllowed.ok === true
    && POLICY_PROFILE_SAFETY.localPolicyOnly === true
    && POLICY_PROFILE_SAFETY.callsProviderOrModel === false
    && POLICY_PROFILE_SAFETY.grantsExecutionPermission === false;
  return {
    ok,
    version: POLICY_PROFILE_VERSION,
    blocked,
    allowed,
    submitBlocked,
    notifyBlocked,
    submitAllowedProfile: submitAllowed.profile.id,
    profiles: POLICY_PROFILES,
    summary,
    safety: POLICY_PROFILE_SAFETY,
    policyProfileHash: digest({
      version: POLICY_PROFILE_VERSION,
      profiles: POLICY_PROFILES,
      checks: {
        blocked,
        allowed,
        submitBlocked,
        notifyBlocked,
        submitAllowedProfile: submitAllowed.profile.id,
      },
      safety: POLICY_PROFILE_SAFETY,
    }),
  };
}
