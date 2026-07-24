import { spawnSync } from 'node:child_process';
import {
  releaseAttestorInspectionReady,
} from './autonomous-research-readiness-inspections.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectAutonomousResearchCampaignExecutionAdmission,
} from '../../paper-domain/automation/autonomous-research-campaign-execution-admission.mjs';
import {
  verifyAutonomousResearchSupervisorDispatchAuthorization,
} from '../../paper-application/automation/autonomous-research-supervisor-dispatch-authorization.mjs';
import {
  verifyAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';

const LIVE_RELEASE_ATTESTOR_BLOCKERS = new Set([
  'research_execution_release_attestor_production_backend_not_ready',
]);

function staticProductionAttestorConfigurationReady(inspection) {
  return releaseAttestorInspectionReady(inspection)
    && inspection?.backendKind === 'external-kms-command'
    && inspection?.backendProductionEligible === true
    && inspection?.hardwareProtected === true
    && inspection?.privateKeyExportable === false
    && inspection?.externalSignerProcess === true
    && inspection?.privateKeyLoadedIntoMainProcess === false
    && inspection?.credentialMaterialReadByMainProcess === false
    && inspection?.backendProbeExternalActionAttempted === false
    && inspection?.activeSignerChallengeExternalActionAttempted === false
    && inspection?.externalActionPerformed === false;
}

function localEndpoint(value) {
  if (!value) return true;
  try {
    const hostname = new URL(String(value)).hostname.replace(/^\[|\]$/g, '');
    return ['127.0.0.1', '::1', 'localhost'].includes(hostname);
  } catch { return false; }
}

export function createAutonomousResearchAdmissionPreflightSandbox({
  environment = process.env,
  spawnSyncImpl = spawnSync,
  bubblewrap = 'bwrap',
} = {}) {
  if ((environment.DOCKER_HOST
      && environment.DOCKER_HOST !== 'unix:///var/run/docker.sock')
    || environment.DOCKER_CONTEXT
    || !localEndpoint(environment.OLLAMA_HOST)
    || !localEndpoint(environment.OPENCLAW_GATEWAY_URL)) {
    throw new Error('autonomous_research_enqueue_remote_endpoint_forbidden');
  }
  let processCount = 0;
  let localDockerDaemonProbeCount = 0;
  const invoke = (executable, args = [], options = {}) => {
    const dockerInspect = String(executable).split('/').at(-1) === 'docker'
      && args.length === 3 && args[0] === 'image' && args[1] === 'inspect';
    const codexPreflight = JSON.stringify(args) === JSON.stringify(['--version'])
      || JSON.stringify(args) === JSON.stringify(['exec', '--help'])
      || JSON.stringify(args) === JSON.stringify(['login', 'status']);
    if (!dockerInspect && !codexPreflight) {
      throw new Error('autonomous_research_enqueue_preflight_command_forbidden');
    }
    processCount += 1;
    if (dockerInspect) localDockerDaemonProbeCount += 1;
    const childEnvironment = {
      ...(options.env || {}),
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    };
    for (const key of [
      'ALL_PROXY', 'DOCKER_CONTEXT', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
      'OLLAMA_HOST', 'OPENCLAW_GATEWAY_URL', 'all_proxy', 'http_proxy', 'https_proxy',
      'no_proxy',
    ]) delete childEnvironment[key];
    return spawnSyncImpl(bubblewrap, [
      '--unshare-user-try', '--unshare-net', '--die-with-parent', '--new-session',
      '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--',
      executable, ...args,
    ], { ...options, env: childEnvironment });
  };
  return Object.freeze({
    spawnSyncImpl: invoke,
    inspection() {
      const payload = Object.freeze({
        version: 1,
        kind: 'AutonomousResearchAdmissionPreflightExecutionInspection',
        sandbox: 'bubblewrap-unshare-net-read-only-root-v1',
        processCount,
        localDockerDaemonProbeCount,
        localProcessActionPerformed: processCount > 0,
        localDaemonActionPerformed: localDockerDaemonProbeCount > 0,
        networkActionPerformed: false,
        externalActionPerformed: false,
      });
      return Object.freeze({
        ...payload,
        autonomousResearchAdmissionPreflightExecutionInspectionHash: hashRecord(
          'AutonomousResearchAdmissionPreflightExecutionInspection', payload,
        ),
      });
    },
  });
}

export function createAutonomousResearchMachineIntakeActionFence({
  intake,
  machineIntakeAdmission,
  intakeLeaseRepository,
  intakeLease,
  residentLeaseContext,
  assertAutonomyCurrent,
  runtimeSignal,
  currentTime,
  productionLaunchMode,
} = {}) {
  if (typeof intakeLeaseRepository?.assertIntakeLease !== 'function'
    || typeof intakeLeaseRepository?.renewIntakeLease !== 'function' || !intakeLease) {
    throw new Error('autonomous_research_machine_intake_lease_required');
  }
  if (!residentLeaseContext || typeof assertAutonomyCurrent !== 'function'
    || typeof currentTime !== 'function') {
    throw new Error('autonomous_research_machine_intake_autonomy_fence_required');
  }
  return ({ renew = false, action = 'machine_intake_enqueue' } = {}) => {
    const fenceNow = currentTime();
    intakeLeaseRepository.assertIntakeLease({ ...intakeLease, now: fenceNow });
    if (renew && !intakeLeaseRepository.renewIntakeLease({
      ...intakeLease, leaseMs: 30 * 60 * 1000, now: fenceNow,
    })) throw new Error('autonomous_research_machine_intake_lease_lost');
    if (runtimeSignal?.aborted) {
      throw new Error(String(runtimeSignal.reason || 'autonomous_research_machine_intake_aborted'));
    }
    const inspection = assertAutonomyCurrent({
      action, intake, machineIntakeAdmission, residentLeaseContext,
      requireFullOperationMode: intake?.launchMode === productionLaunchMode,
    });
    if (typeof inspection?.then === 'function') {
      throw new Error('autonomous_research_machine_intake_autonomy_fence_must_be_synchronous');
    }
    const allowedModes = intake?.launchMode === productionLaunchMode
      ? ['full', 'unrestricted'] : ['bootstrap-only', 'full', 'unrestricted'];
    if (inspection?.ready !== true
      || !allowedModes.includes(inspection?.operationMode)) {
      throw new Error('autonomous_research_machine_intake_autonomy_fence_blocked');
    }
    return inspection;
  };
}

export function verifyAutonomousResearchSupervisorReadinessAuthorization({
  authorization,
  campaign,
  launchMode,
  action,
  providerConfigurationHash,
  now,
  reserveReadiness = false,
} = {}) {
  const inspection = inspectAutonomousResearchCampaignExecutionAdmission(campaign?.spec);
  const supplied = authorization !== null && authorization !== undefined;
  if ((inspection.present && (!inspection.valid || !supplied))
    || (!inspection.present && supplied)
    || (inspection.valid && inspection.present
      && inspection.binding.campaignId !== campaign?.campaignId)) {
    throw new Error('autonomous_research_supervisor_dispatch_authorization_invalid');
  }
  if (!supplied) return false;
  if (!verifyAutonomousResearchSupervisorDispatchAuthorization({
    authorization,
    campaignId: campaign.campaignId,
    campaignPlanHash: inspection.binding.campaignPlanHash,
    launchMode,
    action,
    providerConfigurationHash,
    now,
    reserveReadiness,
  })) throw new Error('autonomous_research_supervisor_dispatch_authorization_invalid');
  return true;
}

export function buildAutonomousResearchProductionAdmissionReadiness({
  residentPrerequisites,
  releaseAttestorInspection,
  capabilityScopeManifest = null,
  researchAgendaProducerReceipt = null,
  now = new Date(),
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const fullExpiresAt = Date.parse(String(
    residentPrerequisites?.fullResearchQualificationExpiresAt || '',
  ));
  const runtimeExpiresAt = Date.parse(String(
    residentPrerequisites?.runtimeImageReproducibilityExpiresAt || '',
  ));
  const cachedQualificationReady = residentPrerequisites?.infrastructureReady === true
    && residentPrerequisites?.globalQualificationReady === true
    && residentPrerequisites?.operationMode === 'full'
    && residentPrerequisites?.externalActionPerformed === false
    && residentPrerequisites?.networkActionPerformed === false
    && Number.isFinite(nowMs) && fullExpiresAt > nowMs && runtimeExpiresAt > nowMs;
  const capabilityScopeReady = verifyAutonomousResearchCapabilityScopeManifest(
    capabilityScopeManifest,
  ) && capabilityScopeManifest.genericDeclaredCapability === true
    && capabilityScopeManifest.agendaMode === 'machine-generated';
  const machineGeneratedAgendaReady = capabilityScopeReady
    && verifyAutonomousResearchAgendaProductionReceipt(researchAgendaProducerReceipt).valid
    && capabilityScopeManifest.empiricalFamilies.includes(
      researchAgendaProducerReceipt?.selectedProtocolFamily,
    )
    && JSON.stringify(researchAgendaProducerReceipt?.allowedProtocolFamilies)
      === JSON.stringify(capabilityScopeManifest.empiricalFamilies);
  const productionGenericCapabilityReady = capabilityScopeReady
    && machineGeneratedAgendaReady;
  const report = buildAutonomousResearchProductionEnqueueReadiness({
    automationOperationalReady: cachedQualificationReady,
    academicEmpiricalReady: cachedQualificationReady,
    researchExecutionReleaseAttestorReady: releaseAttestorInspection?.ready === true,
    runtimeImageReproducibilityReady: cachedQualificationReady,
    fullResearchQualificationReady: cachedQualificationReady,
    liveProviderCanaryRequested: false,
    externalActionPerformed: false,
    researchExecutionReleaseAttestor: releaseAttestorInspection,
    fullAutomaticResearchWritingBlockers: [
      ...(residentPrerequisites?.blockers || []),
      ...(capabilityScopeReady
        ? [] : ['autonomous_research_generic_declared_capability_scope_required']),
      ...(machineGeneratedAgendaReady
        ? [] : ['autonomous_research_machine_generated_agenda_receipt_required']),
    ],
    productionGenericCapabilityReady,
    autonomousResearchCapabilityScopeManifest: capabilityScopeManifest,
    researchAgendaProducerReceipt,
  });
  return Object.freeze({
    ...report,
    residentPrerequisites,
    runtimeImageReproducibility: Object.freeze({
      remainingValidityMs: cachedQualificationReady ? runtimeExpiresAt - nowMs : 0,
    }),
    fullResearchQualification: Object.freeze({
      remainingValidityMs: cachedQualificationReady ? fullExpiresAt - nowMs : 0,
    }),
    productionGenericCapabilityReady,
    autonomousResearchCapabilityScopeManifestHash:
      capabilityScopeManifest?.autonomousResearchCapabilityScopeManifestHash || null,
    researchAgendaProductionReceiptHash:
      researchAgendaProducerReceipt?.autonomousResearchAgendaProductionReceiptHash || null,
  });
}

export function buildAutonomousResearchProductionEnqueueReadiness(report) {
  const staticAttestorReady = staticProductionAttestorConfigurationReady(
    report?.researchExecutionReleaseAttestor,
  );
  const inspectionWasPure = report?.externalActionPerformed === false
    && report?.liveProviderCanaryRequested === false;
  const productionGenericCapabilityReady =
    report?.productionGenericCapabilityReady === true
    || report?.fullyAutonomousResearchSystemReady === true;
  const blockers = Object.freeze([
    ...(report?.fullAutomaticResearchWritingBlockers || [])
      .filter((blocker) => !LIVE_RELEASE_ATTESTOR_BLOCKERS.has(blocker)),
    ...(staticAttestorReady
      ? [] : ['research_execution_release_attestor_static_production_config_not_ready']),
    ...(inspectionWasPure ? [] : ['production_enqueue_readiness_external_action_forbidden']),
    ...(productionGenericCapabilityReady
      ? [] : ['autonomous_research_production_generic_capability_required']),
  ]);
  const productionEnqueueAdmissionReady = blockers.length === 0
    && report?.automationOperationalReady === true
    && report?.academicEmpiricalReady === true
    && report?.researchExecutionReleaseAttestorReady === true
    && report?.runtimeImageReproducibilityReady === true
    && report?.fullResearchQualificationReady === true
    && productionGenericCapabilityReady;
  return Object.freeze({
    ...report,
    productionEnqueueAdmissionReady,
    productionGenericCapabilityReady,
    productionEnqueueAdmissionScope:
      'local-current-config-and-cached-qualification-only-no-live-provider-or-kms-action',
    productionEnqueueAdmissionBlockers: blockers,
  });
}
