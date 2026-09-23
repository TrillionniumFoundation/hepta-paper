import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  createAutonomousResearchReleaseBinding,
  verifyAutonomousResearchReleaseBinding,
} from '../../paper-domain/automation/autonomous-research-release-binding-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_LAUNCH_MODES,
  resolvePersistedAutonomousResearchLaunchMode,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  inspectAutonomousResearchMachineIntakeCampaignBinding,
} from './autonomous-research-machine-intake-supervision.mjs';
import {
  ResidentReactivationRequired,
} from './autonomous-research-resident-reactivation-required.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const PREREQUISITE_RECEIPT_KEYS = Object.freeze([
  'autonomousResearchResidentPrerequisiteIdentityHash',
  'autonomousResearchResidentPrerequisiteReceiptHash',
  'blockers',
  'codeWorktreeStateHash',
  'externalActionPerformed',
  'externalQualificationConfigurationIdentityHash',
  'externalQualificationConfigurationInspectionHash',
  'externalQualificationCostAuthority',
  'externalActionRecoveryConfigurationIdentityHash',
  'externalQualificationMaximumCostUsd',
  'externalQualificationTrustIdentityHash',
  'fullResearchQualificationExpiresAt',
  'globalQualificationBlockers',
  'globalQualificationReady',
  'infrastructureBlockers',
  'infrastructureReady',
  'inspectedAt',
  'kind',
  'networkActionPerformed',
  'operationMode',
  'providerCanaryPerformed',
  'ready',
  'releaseSignerChallengePerformed',
  'runtimeImageReproducibilityConfigurationIdentityHash',
  'runtimeImageReproducibilityExpiresAt',
  'runtimeImageReproducibilityTrustIdentityHash',
  'status',
  'version',
  'zeroCostAuthorityEvidenceScope',
].sort());

function canonicalTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function hashOrNull(value) {
  return value === null || SHA256.test(String(value || ''));
}

function blockerContractValid(receipt) {
  const infrastructure = receipt?.infrastructureBlockers;
  const global = receipt?.globalQualificationBlockers;
  const blockers = receipt?.blockers;
  if (![infrastructure, global, blockers].every(Array.isArray)
    || [...infrastructure, ...global, ...blockers]
      .some((value) => typeof value !== 'string' || !value)
    || new Set(infrastructure).size !== infrastructure.length
    || new Set(global).size !== global.length
    || new Set(blockers).size !== blockers.length) return false;
  return receipt.infrastructureReady === (infrastructure.length === 0)
    && receipt.globalQualificationReady === (global.length === 0)
    && JSON.stringify(blockers) === JSON.stringify([
    ...new Set([...infrastructure, ...global]),
  ]);
}

function costEvidenceContractValid(receipt) {
  const maximum = receipt?.externalQualificationMaximumCostUsd;
  const authority = receipt?.externalQualificationCostAuthority;
  const scope = receipt?.zeroCostAuthorityEvidenceScope;
  if (maximum === null || authority === null) {
    return maximum === null && authority === null && scope === null;
  }
  if (typeof maximum !== 'number' || !Number.isFinite(maximum)
    || maximum < 0 || maximum > 1_000) return false;
  if (authority === 'externally_operated_zero_cost') {
    return maximum === 0
      && scope === 'trusted_operator_assertion_not_external_billing_proof';
  }
  return authority === 'operator_declared_worst_case_usd'
    && maximum > 0 && scope === null;
}

function prerequisiteReceiptValid(receipt, { now } = {}) {
  const observedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(observedAt.getTime())
    || !exactKeys(receipt, PREREQUISITE_RECEIPT_KEYS)) return false;
  const {
    autonomousResearchResidentPrerequisiteReceiptHash: claimedHash,
    ...payload
  } = receipt || {};
  const expectedMode = receipt?.infrastructureReady !== true ? 'blocked'
    : receipt?.globalQualificationReady === true ? 'full' : 'bootstrap-only';
  const expectedStatus = expectedMode === 'blocked'
    ? 'autonomous_research_resident_infrastructure_blocked'
    : expectedMode === 'full'
      ? 'autonomous_research_resident_prerequisites_ready'
      : 'autonomous_research_resident_bootstrap_only';
  const infrastructureIdentityFields = [
    receipt.externalQualificationConfigurationInspectionHash,
    receipt.externalQualificationConfigurationIdentityHash,
    receipt.externalQualificationTrustIdentityHash,
    receipt.runtimeImageReproducibilityConfigurationIdentityHash,
    receipt.runtimeImageReproducibilityTrustIdentityHash,
    receipt.externalActionRecoveryConfigurationIdentityHash,
    receipt.codeWorktreeStateHash,
  ];
  const identity = Object.freeze({
    externalQualificationConfigurationInspectionHash:
      receipt.externalQualificationConfigurationInspectionHash,
    externalQualificationConfigurationIdentityHash:
      receipt.externalQualificationConfigurationIdentityHash,
    externalQualificationTrustIdentityHash:
      receipt.externalQualificationTrustIdentityHash,
    externalQualificationMaximumCostUsd:
      receipt.externalQualificationMaximumCostUsd,
    externalQualificationCostAuthority:
      receipt.externalQualificationCostAuthority,
    runtimeImageReproducibilityConfigurationIdentityHash:
      receipt.runtimeImageReproducibilityConfigurationIdentityHash,
    runtimeImageReproducibilityTrustIdentityHash:
      receipt.runtimeImageReproducibilityTrustIdentityHash,
    externalActionRecoveryConfigurationIdentityHash:
      receipt.externalActionRecoveryConfigurationIdentityHash,
    codeWorktreeStateHash: receipt.codeWorktreeStateHash,
  });
  return receipt?.version === 1
    && receipt?.kind === 'AutonomousResearchResidentPrerequisiteReceipt'
    && receipt.status === expectedStatus
    && typeof receipt?.ready === 'boolean'
    && typeof receipt?.infrastructureReady === 'boolean'
    && typeof receipt?.globalQualificationReady === 'boolean'
    && receipt.ready === (receipt.infrastructureReady === true
      && receipt.globalQualificationReady === true)
    && receipt?.operationMode === expectedMode
    && canonicalTimestamp(receipt.inspectedAt)
    && receipt.inspectedAt === observedAt.toISOString()
    && infrastructureIdentityFields.every(hashOrNull)
    && costEvidenceContractValid(receipt)
    && (receipt.fullResearchQualificationExpiresAt === null
      || canonicalTimestamp(receipt.fullResearchQualificationExpiresAt))
    && (receipt.runtimeImageReproducibilityExpiresAt === null
      || canonicalTimestamp(receipt.runtimeImageReproducibilityExpiresAt))
    && receipt.externalActionPerformed === false
    && receipt.networkActionPerformed === false
    && receipt.providerCanaryPerformed === false
    && receipt.releaseSignerChallengePerformed === false
    && blockerContractValid(receipt)
    && (!receipt.infrastructureReady || (
      infrastructureIdentityFields.every((value) => SHA256.test(String(value || '')))
      && receipt.externalQualificationMaximumCostUsd !== null
      && receipt.externalQualificationCostAuthority !== null
    ))
    && (!receipt.globalQualificationReady || (
      receipt.infrastructureReady
      && canonicalTimestamp(receipt.fullResearchQualificationExpiresAt)
      && canonicalTimestamp(receipt.runtimeImageReproducibilityExpiresAt)
      && Date.parse(receipt.fullResearchQualificationExpiresAt) > observedAt.getTime()
      && Date.parse(receipt.runtimeImageReproducibilityExpiresAt) > observedAt.getTime()
    ))
    && SHA256.test(String(
      receipt?.autonomousResearchResidentPrerequisiteIdentityHash || '',
    ))
    && receipt.autonomousResearchResidentPrerequisiteIdentityHash === hashRecord(
      'AutonomousResearchResidentPrerequisiteIdentity', identity,
    )
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchResidentPrerequisiteReceipt', payload) === claimedHash;
}

function goldenBootstrapCampaignBlockers({ campaign, record } = {}) {
  const blockers = [];
  let persistedMode = null;
  try {
    persistedMode = resolvePersistedAutonomousResearchLaunchMode({
      campaign,
      requestedLaunchMode: AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP,
    });
  } catch (error) { blockers.push(String(error?.message || error)); }
  const binding = inspectAutonomousResearchMachineIntakeCampaignBinding({
    campaign,
    record,
    requireRecord: true,
  });
  if (!binding.ready) blockers.push(binding.reason);
  const plan = campaign?.spec || null;
  const intake = plan?.autonomousResearchMachineIntake || null;
  const admission = plan?.autonomousResearchMachineIntakeAdmission || null;
  if (persistedMode?.legacyLaunchModeMissing === true
    || intake?.launchMode !== AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP
    || !intake?.recurringGoldenProvenance
    || admission?.sourceKind !== 'recurring-golden'
    || record?.sourceKind !== 'recurring-golden'
    || record?.sourceAuthorityHash !== admission?.sourceAuthorityHash
    || record?.intakeHash !== intake?.intakeHash) {
    blockers.push('autonomous_research_supervisor_bootstrap_campaign_provenance_invalid');
  }
  try {
    const releaseBinding = createAutonomousResearchReleaseBinding({
      campaignId: campaign?.campaignId,
      paperId: campaign?.paperId,
      campaignPlanHash: plan?.campaignPlanHash,
      preparation: plan?.autonomousResearchPreparation,
      machineIntake: intake,
      machineIntakeAdmission: admission,
    });
    const authority = releaseBinding?.globalGoldenQualificationAuthority || null;
    const releaseInspection = verifyAutonomousResearchReleaseBinding(releaseBinding, {
      campaignId: campaign?.campaignId,
      paperId: campaign?.paperId,
      campaignPlanHash: plan?.campaignPlanHash,
      launchMode: AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP,
      proposalHash: plan?.autonomousResearchPreparation?.proposal
        ?.machineProposedScientificClaimSetHash,
      policyAuthorizationHash: plan?.autonomousResearchPreparation?.policyAuthorization
        ?.autonomousResearchPolicyAuthorizationHash,
      seedBindingHash: plan?.autonomousResearchPreparation?.seedBinding
        ?.autonomousResearchSeedBindingHash,
      globalGoldenQualificationAuthorityHash:
        authority?.autonomousResearchGlobalGoldenQualificationAuthorityHash,
    });
    if (!authority || releaseInspection.valid !== true) {
      blockers.push(...releaseInspection.blockers,
        'autonomous_research_supervisor_bootstrap_release_binding_invalid');
    }
  } catch {
    blockers.push('autonomous_research_supervisor_bootstrap_release_binding_invalid');
  }
  return Object.freeze([...new Set(blockers.filter(Boolean))]);
}

export function createAutonomousResearchSupervisorAutonomyFence({
  required = false,
  inspectPrerequisites = null,
  assertDynamicInfrastructureCurrent = null,
  clock,
} = {}) {
  if (assertDynamicInfrastructureCurrent !== null
    && typeof assertDynamicInfrastructureCurrent !== 'function') {
    throw new Error('autonomous_research_supervisor_dynamic_infrastructure_fence_invalid');
  }
  let startupIdentityHash = null;

  function inspectReceipt() {
    if (!required) return null;
    let receipt;
    const inspectedAt = clock.now();
    try { receipt = inspectPrerequisites({ now: inspectedAt }); }
    catch (error) {
      return Object.freeze({
        ready: false,
        operationMode: 'blocked',
        reason: String(error?.message
          || 'autonomous_research_supervisor_full_prerequisite_inspection_failed'),
        receipt: null,
      });
    }
    if (!prerequisiteReceiptValid(receipt, { now: inspectedAt })) {
      return Object.freeze({
        ready: false,
        operationMode: 'blocked',
        reason: 'autonomous_research_supervisor_full_prerequisite_receipt_invalid',
        receipt,
      });
    }
    const identityHash = receipt.autonomousResearchResidentPrerequisiteIdentityHash;
    if (receipt.infrastructureReady !== true) {
      return Object.freeze({
        ready: false,
        operationMode: 'blocked',
        reason: receipt.infrastructureBlockers?.[0]
          || 'autonomous_research_supervisor_infrastructure_prerequisites_blocked',
        receipt,
      });
    }
    if (startupIdentityHash && identityHash !== startupIdentityHash) {
      throw new ResidentReactivationRequired({
        source: 'resident_prerequisite',
        reason: 'autonomous_research_supervisor_infrastructure_identity_rotated',
        startupIdentityHash,
        observedIdentityHash: identityHash,
        receiptHash: receipt.autonomousResearchResidentPrerequisiteReceiptHash,
      });
    }
    return Object.freeze({
      ready: true,
      operationMode: receipt.operationMode,
      reason: null,
      receipt,
    });
  }

  function inspectCurrent({
    campaign = null,
    record = null,
    residentLeaseContext = null,
    requireFullOperationMode = false,
    action = null,
  } = {}) {
    if (typeof requireFullOperationMode !== 'boolean'
      || (action !== null && (typeof action !== 'string' || !action))) {
      return Object.freeze({
        ready: false,
        operationMode: 'blocked',
        reason: 'autonomous_research_supervisor_autonomy_fence_request_invalid',
        receipt: null,
      });
    }
    if (!required) return Object.freeze({ ready: true, operationMode: 'unrestricted' });
    const inspection = inspectReceipt();
    if (!inspection.ready) return inspection;
    if (assertDynamicInfrastructureCurrent) {
      try {
        const dynamic = assertDynamicInfrastructureCurrent({
          action: action || 'autonomous_research_supervisor_dynamic_infrastructure_check',
          residentLeaseContext,
        });
        if (typeof dynamic?.then === 'function' || dynamic?.ready !== true) {
          throw new Error('autonomous_research_supervisor_dynamic_infrastructure_not_current');
        }
      } catch (error) {
        if (error?.authorityEvidenceRenewalFatal === true) throw error;
        return Object.freeze({
          ...inspection,
          ready: false,
          operationMode: 'blocked',
          reason: String(error?.message || error),
          dynamicInfrastructureError: error,
        });
      }
    }
    if (residentLeaseContext) {
      let instance;
      try { instance = residentLeaseContext.assertCurrent({ now: clock.now() }); }
      catch (error) {
        return Object.freeze({ ...inspection, ready: false,
          operationMode: 'blocked', reason: String(error?.message || error) });
      }
      if (instance?.fullyAutonomousPrerequisiteIdentityHash !== startupIdentityHash) {
        return Object.freeze({ ...inspection, ready: false, operationMode: 'blocked',
        reason: 'autonomous_research_supervisor_resident_prerequisite_identity_mismatch' });
      }
    }
    if (requireFullOperationMode && inspection.operationMode !== 'full') {
      return Object.freeze({ ...inspection, ready: false,
        reason: 'autonomous_research_supervisor_full_operation_mode_required' });
    }
    if (campaign) {
      const campaignInspection = inspectCampaign({
        campaign,
        record,
        operationMode: inspection.operationMode,
      });
      if (!campaignInspection.ready) return Object.freeze({ ...inspection, ready: false,
        reason: campaignInspection.reason,
        campaignBlockers: campaignInspection.blockers });
    }
    return inspection;
  }

  function inspectCampaign({ campaign, record, operationMode } = {}) {
    if (!required) {
      return Object.freeze({ ready: true, reason: null, blockers: Object.freeze([]) });
    }
    if (operationMode === 'full') {
      const binding = inspectAutonomousResearchMachineIntakeCampaignBinding({
        campaign,
        record,
        requireRecord: true,
      });
      const blockers = Object.freeze(binding.ready && binding.machineBound === true
        ? [] : [binding.reason
          || 'autonomous_research_machine_intake_campaign_missing']);
      return Object.freeze({
        ready: blockers.length === 0,
        reason: blockers[0] || null,
        blockers,
      });
    }
    if (operationMode !== 'bootstrap-only') {
      const blockers = Object.freeze([
        'autonomous_research_supervisor_infrastructure_prerequisites_blocked',
      ]);
      return Object.freeze({ ready: false, reason: blockers[0], blockers });
    }
    const blockers = goldenBootstrapCampaignBlockers({ campaign, record });
    return Object.freeze({
      ready: blockers.length === 0,
      reason: blockers[0] || null,
      blockers,
    });
  }

  function inspectStartup() {
    if (!required) return null;
    const inspection = inspectReceipt();
    if (!inspection.ready) {
      throw new Error(`autonomous_research_supervisor_infrastructure_prerequisites_blocked:${
        inspection.reason}`);
    }
    startupIdentityHash = inspection.receipt
      .autonomousResearchResidentPrerequisiteIdentityHash;
    return inspection.receipt;
  }

  function assertCurrent(input = {}) {
    const inspection = inspectCurrent(input);
    if (!inspection.ready) {
      if (inspection.dynamicInfrastructureError) {
        throw inspection.dynamicInfrastructureError;
      }
      throw new Error(`autonomous_research_supervisor_autonomy_fence_blocked:${
        inspection.reason}:action=${input.action || 'unspecified'}`);
    }
    return inspection;
  }

  return Object.freeze({ inspectStartup, inspectCurrent, inspectCampaign, assertCurrent });
}
