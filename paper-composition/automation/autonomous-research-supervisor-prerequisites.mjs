import fs from 'node:fs';
import path from 'node:path';

import {
  inspectAutonomousResearchStateSafety,
} from './autonomous-research-state-safety-inspection.mjs';
import {
  composeAutonomousResearchStateBackupService,
} from '../bootstrap/autonomous-research-state-backup-composition.mjs';
import {
  composeAutonomousResearchOnlineMutationRuntimeActivation,
} from '../bootstrap/autonomous-research-online-mutation-composition.mjs';
import {
  createFullResearchQualificationReceiptPointerRepository,
} from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import {
  readExternalResearchQualificationProcessConfiguration,
} from '../../paper-adapters/automation/external-research-qualification-process-identity.mjs';
import {
  createAutonomousResearchStateRecoverabilityController,
} from '../../paper-application/automation/autonomous-research-state-recoverability-controller.mjs';

export const AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_SAFETY_CLOCK = Object.freeze({
  now: () => new Date(),
});

function emptyPlainOverrideBag(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === 0;
}

export function assertAutonomousResearchSupervisorStrictOverridePolicy({
  required,
  serviceOverrides,
  runtimeReproducibilityOverrides,
  dispatchCampaignOverride,
  providerCanaryOverride,
  renewQualificationOverride,
  readQualificationStateOverride,
  reconcileRuntimeOverride,
  stateSafetyInspector,
  stateSafetyActiveAuthorityRefresh,
  composeStateSafetyBackupService,
  stateSafetyClock,
  createQualificationPointerRepository,
  bootstrapExecutionContextIsDefault,
  composeSupervisorStateIsDefault,
} = {}) {
  if (!required) return;
  const forbidden = [
    ['serviceOverrides', !emptyPlainOverrideBag(serviceOverrides)],
    [
      'runtimeReproducibilityOverrides',
      !emptyPlainOverrideBag(runtimeReproducibilityOverrides),
    ],
    ['dispatchCampaignOverride', dispatchCampaignOverride != null],
    ['providerCanaryOverride', providerCanaryOverride != null],
    ['renewQualificationOverride', renewQualificationOverride != null],
    ['readQualificationStateOverride', readQualificationStateOverride != null],
    ['reconcileRuntimeOverride', reconcileRuntimeOverride != null],
    ['stateSafetyInspector', stateSafetyInspector !== undefined],
    [
      'stateSafetyActiveAuthorityRefresh',
      stateSafetyActiveAuthorityRefresh !== undefined,
    ],
    [
      'composeStateSafetyBackupService',
      composeStateSafetyBackupService !== undefined,
    ],
    [
      'stateSafetyClock',
      stateSafetyClock !== AUTONOMOUS_RESEARCH_SUPERVISOR_STATE_SAFETY_CLOCK,
    ],
    [
      'createQualificationPointerRepository',
      createQualificationPointerRepository !== undefined,
    ],
    ['bootstrapExecutionContext', bootstrapExecutionContextIsDefault !== true],
    ['composeSupervisorState', composeSupervisorStateIsDefault !== true],
  ];
  const violation = forbidden.find(([, present]) => present);
  if (violation) {
    throw new Error(
      `autonomous_research_supervisor_fully_autonomous_override_forbidden:${violation[0]}`,
    );
  }
}

export function assertAutonomousResearchSupervisorMachineIntakeConfiguration({
  required,
  configuredPath,
} = {}) {
  if (required && !configuredPath) {
    throw new Error('autonomous_research_supervisor_machine_intake_configuration_required');
  }
}

export function canonicalAutonomousResearchQualificationPointerEnvironment(
  environment,
  repository,
) {
  const canonicalPath = path.resolve(repository.qualificationReceiptPath);
  const configured = environment.HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT || null;
  if (configured) {
    const requested = path.resolve(String(configured));
    let requestedRealPath = requested;
    try { requestedRealPath = fs.realpathSync(requested); }
    catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error('autonomous_research_supervisor_qualification_pointer_path_invalid');
      }
    }
    let canonicalRealPath = canonicalPath;
    try { canonicalRealPath = fs.realpathSync(canonicalPath); }
    catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error('autonomous_research_supervisor_qualification_pointer_path_invalid');
      }
    }
    if (requested !== canonicalPath || requestedRealPath !== canonicalRealPath) {
      throw new Error('autonomous_research_supervisor_qualification_pointer_path_mismatch');
    }
  }
  return Object.freeze({
    ...environment,
    HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT: canonicalPath,
  });
}

export function assertAutonomousResearchSupervisorStateSafety({
  required,
  workspaceRoot,
  runtimeRoot,
  environment,
  inspector = inspectAutonomousResearchStateSafety,
  composeStateBackupService = composeAutonomousResearchStateBackupService,
  activateMutationRuntime = composeAutonomousResearchOnlineMutationRuntimeActivation,
  clock = { now: () => new Date() },
} = {}) {
  if (!required) return;
  const authorityProcessConfigurationPath = environment
    ?.HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG || null;
  const authorityConfigurationPath = environment
    ?.HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG || null;
  let backupService = null;
  let inventory = null;
  let mutationCoordinator = null;
  let authorityEvidenceRenewalAdapter = null;
  let stateRecoverabilityController = null;
  let activationReceipt = null;
  let onlineAntiRollbackInspection = null;
  if (authorityProcessConfigurationPath && authorityConfigurationPath) {
    try {
      backupService = composeStateBackupService({
        workspaceRoot,
        runtimeRoot,
        authorityConfigurationPath:
          environment.HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG || null,
        onlineMutationAuthorityProcessConfigurationPath:
          authorityProcessConfigurationPath,
      });
      inventory = backupService.inventory();
      const latestRestoreDrill = backupService.offhostSources();
      const initialVerifiedHead = Number.isSafeInteger(latestRestoreDrill?.headSequence)
        && /^sha256:[0-9a-f]{64}$/.test(String(latestRestoreDrill?.headHash || ''))
        ? Object.freeze({
          globalSequence: latestRestoreDrill.headSequence,
          globalHash: latestRestoreDrill.headHash,
        }) : null;
      stateRecoverabilityController =
        createAutonomousResearchStateRecoverabilityController({
          service: backupService,
          clock,
          initialVerifiedHead,
          assertResidentLease({ residentLeaseContext, now }) {
            if (residentLeaseContext?.kind
                !== 'AutonomousResearchResidentLeaseContext'
              || typeof residentLeaseContext.assertCurrent !== 'function'
              || !residentLeaseContext.lease) return false;
            try {
              const current = residentLeaseContext.assertCurrent({ now });
              return current?.ownerId === residentLeaseContext.lease.ownerId
                && current?.leaseToken === residentLeaseContext.lease.leaseToken
                && Number(current?.leaseGeneration)
                  === Number(residentLeaseContext.lease.leaseGeneration);
            } catch { return false; }
          },
        });
      const activation = activateMutationRuntime({
        workspaceRoot,
        runtimeRoot,
        inventory,
        latestRestoreDrill,
        resolveInventory: () => backupService.inventory(),
        authorityProcessConfigurationPath,
        authorityConfigurationPath,
        recoverabilityEpochFence: stateRecoverabilityController,
        clock,
      });
      if (activation?.activeInspection?.status
          !== 'autonomous_research_online_anti_rollback_ready'
        || activation.activeInspection.inspectionMode
          !== 'active-external-authority-challenge') {
        throw new Error('autonomous_research_online_runtime_activation_evidence_invalid');
      }
      mutationCoordinator = activation?.coordinator || null;
      authorityEvidenceRenewalAdapter =
        activation?.authorityEvidenceRenewalAdapter || null;
      activationReceipt = activation?.receipt || null;
      onlineAntiRollbackInspection = activation?.activeInspection || null;
      stateRecoverabilityController.markMutationFinalized({
        globalSequence: activation.receipt.authorityGlobalSequence,
        globalHash: activation.receipt.authorityGlobalHash,
      });
    } catch { /* the fixed fail-closed error below is the public contract */ }
  }
  let inspection = null;
  try {
    inspection = inspector({
      workspaceRoot,
      runtimeRoot,
      now: clock.now(),
      environment,
      stateBackupService: backupService,
      mutationCoordinator,
      onlineAntiRollbackInspection,
    });
  } catch { /* the fixed fail-closed error below is the public contract */ }
  if (inspection?.ready !== true) {
    throw new Error('autonomous_research_supervisor_state_safety_required');
  }
  if (mutationCoordinator?.inspectStatus?.().status
      !== 'externally_fenced_sqlite_mutation_coordinator_ready'
    || activationReceipt?.status
      !== 'autonomous_research_online_mutation_runtime_activated'
    || activationReceipt?.coordinatorRuntimeReady !== true) {
    throw new Error('autonomous_research_supervisor_state_safety_required');
  }
  return Object.freeze({
    inspection,
    inventory,
    mutationCoordinator,
    authorityEvidenceRenewalAdapter,
    stateRecoverabilityController,
    activationReceipt,
  });
}

export function prepareAutonomousResearchSupervisorQualificationPrerequisites({
  runtimeRoot,
  environment,
  externalQualificationConfigPath = null,
  publicationMutationCoordinator = null,
  requireExternallyFencedPublication = false,
  createQualificationPointerRepository =
    createFullResearchQualificationReceiptPointerRepository,
} = {}) {
  const receiptPointerRepository = createQualificationPointerRepository({
    runtimeRoot,
    mutationCoordinator: publicationMutationCoordinator,
    offlineProvision: !requireExternallyFencedPublication,
    requireExternallyFencedMutations: requireExternallyFencedPublication,
  });
  const effectiveEnvironment = canonicalAutonomousResearchQualificationPointerEnvironment(
    environment,
    receiptPointerRepository,
  );
  const configuredExternalQualificationPath = externalQualificationConfigPath
    || effectiveEnvironment.HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG || null;
  const externalQualificationConfiguration = configuredExternalQualificationPath
    ? readExternalResearchQualificationProcessConfiguration({
      configPath: configuredExternalQualificationPath,
      environment: effectiveEnvironment,
    }) : null;
  return Object.freeze({
    receiptPointerRepository,
    effectiveEnvironment,
    configuredExternalQualificationPath,
    externalQualificationConfiguration,
  });
}
