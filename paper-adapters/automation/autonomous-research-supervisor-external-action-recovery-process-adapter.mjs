import fs from 'node:fs';
import path from 'node:path';

import {
  AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_RECOVERY_ACTION_KINDS,
  verifyAutonomousResearchSupervisorExternalActionRecoveryCapability,
  verifyAutonomousResearchSupervisorExternalActionRecoveryResolution,
} from '../../paper-domain/automation/autonomous-research-supervisor-external-action-recovery-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { runBoundedChildProcess } from './bounded-child-process.mjs';
import {
  invokeExternalResearchQualificationProcess,
  readExternalResearchQualificationProcessConfiguration,
} from './external-research-qualification-process-identity.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const CONFIG_ENV = 'HEPTA_AUTONOMOUS_RESEARCH_EXTERNAL_ACTION_RECOVERY_CONFIG';
const CONFIG_KEYS = Object.freeze([
  'actionConfigurationIdentityHashes', 'capabilityReceipt', 'kind',
  'processCommandRole', 'processConfigurationIdentityHash',
  'processConfigurationPath', 'version',
].sort());

function integrityConfigurationFile(candidate) {
  const requested = path.resolve(String(candidate || ''));
  const resolved = fs.realpathSync(requested);
  const stat = fs.statSync(resolved);
  if (requested !== resolved || !stat.isFile() || stat.size < 2 || stat.size > 256 * 1024
    || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || Number(stat.uid) !== process.getuid?.()) {
    throw new Error(
      'autonomous_research_supervisor_external_action_recovery_configuration_invalid',
    );
  }
  return resolved;
}

function actionIdentitiesValid(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify(AUTONOMOUS_RESEARCH_SUPERVISOR_EXTERNAL_ACTION_RECOVERY_ACTION_KINDS)
    && Object.values(value).every((item) => SHA256.test(String(item || '')));
}

function readConfigurationFile({ configPath = null, environment = process.env } = {}) {
  const selected = configPath || environment?.[CONFIG_ENV] || null;
  if (!selected) throw new Error(
    'autonomous_research_supervisor_external_action_recovery_configuration_required',
  );
  const absolute = integrityConfigurationFile(selected);
  let value;
  try { value = JSON.parse(fs.readFileSync(absolute, 'utf8')); }
  catch (error) {
    throw new Error(
      'autonomous_research_supervisor_external_action_recovery_configuration_invalid',
      { cause: error },
    );
  }
  if (!exactKeys(value, CONFIG_KEYS) || value.version !== 1
    || value.kind
      !== 'AutonomousResearchSupervisorExternalActionRecoveryProcessConfiguration'
    || value.processCommandRole !== 'qualifier'
    || !SHA256.test(String(value.processConfigurationIdentityHash || ''))
    || !actionIdentitiesValid(value.actionConfigurationIdentityHashes)
    || !value.capabilityReceipt || typeof value.capabilityReceipt !== 'object') {
    throw new Error(
      'autonomous_research_supervisor_external_action_recovery_configuration_invalid',
    );
  }
  const processConfigurationPath = path.isAbsolute(value.processConfigurationPath)
    ? value.processConfigurationPath
    : path.resolve(path.dirname(absolute), value.processConfigurationPath);
  return Object.freeze({ value, configPath: absolute, processConfigurationPath });
}

function loadConfiguration(options = {}) {
  const loaded = readConfigurationFile(options);
  const processConfiguration = readExternalResearchQualificationProcessConfiguration({
    configPath: loaded.processConfigurationPath,
    environment: options.environment || process.env,
  });
  if (processConfiguration.configurationIdentityHash
      !== loaded.value.processConfigurationIdentityHash) {
    throw new Error(
      'autonomous_research_supervisor_external_action_recovery_process_identity_changed',
    );
  }
  const command = processConfiguration.qualifier;
  const capabilityReceiptHash = loaded.value.capabilityReceipt
    .autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash || null;
  const configurationIdentityHash = hashRecord(
    'AutonomousResearchSupervisorExternalActionRecoveryConfigurationIdentity',
    {
      processConfigurationIdentityHash: processConfiguration.configurationIdentityHash,
      processCommandIdentityHash: command.commandIdentityHash,
      recoveryTrustIdentityHash: processConfiguration.trustIdentityHash,
      capabilityReceiptHash,
      actionConfigurationIdentityHashes: loaded.value.actionConfigurationIdentityHashes,
    },
  );
  return Object.freeze({
    configPath: loaded.configPath,
    processConfigurationPath: loaded.processConfigurationPath,
    processConfiguration,
    command,
    capabilityReceipt: Object.freeze({ ...loaded.value.capabilityReceipt }),
    actionConfigurationIdentityHashes: Object.freeze({
      ...loaded.value.actionConfigurationIdentityHashes,
    }),
    configurationIdentityHash,
    trustIdentityHash: processConfiguration.trustIdentityHash,
    capabilityReceiptHash,
  });
}

function capabilityReady(configuration, now) {
  return verifyAutonomousResearchSupervisorExternalActionRecoveryCapability(
    configuration.capabilityReceipt,
    {
      trustedSigner: configuration.processConfiguration.trustedSigner,
      publicKeyPem: configuration.processConfiguration.publicKey,
      processIdentityHash: configuration.command.commandIdentityHash,
      recoveryProcessConfigurationIdentityHash:
        configuration.processConfiguration.configurationIdentityHash,
      recoveryTrustIdentityHash: configuration.trustIdentityHash,
      now,
    },
  ) && JSON.stringify(configuration.capabilityReceipt.actionConfigurationIdentityHashes)
    === JSON.stringify(configuration.actionConfigurationIdentityHashes);
}

export function readAutonomousResearchSupervisorExternalActionRecoveryConfiguration(options = {}) {
  return loadConfiguration(options);
}

export function inspectAutonomousResearchSupervisorExternalActionRecoveryConfiguration({
  configPath = null,
  environment = process.env,
  now = new Date(),
} = {}) {
  try {
    const configuration = loadConfiguration({ configPath, environment });
    const ready = capabilityReady(configuration, now);
    return Object.freeze({
      version: 1,
      kind: 'AutonomousResearchSupervisorExternalActionRecoveryConfigurationInspection',
      ready,
      signedCapabilityVerified: ready,
      configurationIdentityHash: configuration.configurationIdentityHash,
      processIdentityHash: configuration.command.commandIdentityHash,
      trustIdentityHash: configuration.trustIdentityHash,
      capabilityReceiptHash: configuration.capabilityReceiptHash,
      actionConfigurationIdentityHashes: configuration.actionConfigurationIdentityHashes,
      blocker: ready ? null
        : 'autonomous_research_supervisor_external_action_recovery_capability_not_verified',
      externalActionPerformed: false,
    });
  } catch (error) {
    return Object.freeze({
      version: 1,
      kind: 'AutonomousResearchSupervisorExternalActionRecoveryConfigurationInspection',
      ready: false,
      signedCapabilityVerified: false,
      configurationIdentityHash: null,
      processIdentityHash: null,
      trustIdentityHash: null,
      capabilityReceiptHash: null,
      actionConfigurationIdentityHashes: null,
      blocker: String(error?.message || error),
      externalActionPerformed: false,
    });
  }
}

function recoveryRequest(input, action, configuration) {
  const attempt = input?.attempt;
  const actionConfigurationIdentityHash = configuration
    .actionConfigurationIdentityHashes?.[attempt?.actionKind];
  if (!['lookup', 'resume'].includes(action)
    || !attempt || typeof attempt !== 'object'
    || !SAFE_ID.test(String(attempt.actionKind || ''))
    || !SHA256.test(String(attempt.idempotencyKey || ''))
    || !SHA256.test(String(attempt.markerHash || ''))
    || !SHA256.test(String(attempt.reservationHash || ''))
    || (attempt.progressHash !== null && !SHA256.test(String(attempt.progressHash || '')))
    || attempt.actionConfigurationIdentityHash !== actionConfigurationIdentityHash) {
    throw new Error('autonomous_research_supervisor_external_action_recovery_request_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorExternalActionRecoveryProcessRequest',
    action,
    actionKind: attempt.actionKind,
    actionConfigurationIdentityHash,
    idempotencyKey: attempt.idempotencyKey,
    markerHash: attempt.markerHash,
    reservationHash: attempt.reservationHash,
    progressHash: attempt.progressHash,
    marker: attempt.marker,
    progress: attempt.progress,
    priorResolutionHash: input?.priorResolutionHash || null,
    recoveryConfigurationIdentityHash: configuration.configurationIdentityHash,
    recoveryTrustIdentityHash: configuration.trustIdentityHash,
    recoveryCapabilityReceiptHash: configuration.capabilityReceiptHash,
  });
}

export function createAutonomousResearchSupervisorExternalActionRecoveryProcessAdapter({
  configPath = null,
  environment = process.env,
  clock = { now: () => new Date() },
  runProcess = runBoundedChildProcess,
} = {}) {
  const startup = loadConfiguration({ configPath, environment });
  function currentConfiguration() {
    const current = loadConfiguration({ configPath: startup.configPath, environment });
    if (current.configurationIdentityHash !== startup.configurationIdentityHash) {
      throw new Error(
        'autonomous_research_supervisor_external_action_recovery_configuration_rotated',
      );
    }
    return current;
  }
  function inspectCapabilities({ now = clock.now() } = {}) {
    let configuration;
    try { configuration = currentConfiguration(); }
    catch { configuration = null; }
    const signedCapabilityVerified = Boolean(configuration)
      && capabilityReady(configuration, now);
    return Object.freeze({
      ready: signedCapabilityVerified,
      signedCapabilityVerified,
      authoritativeSignedLookupSupported: signedCapabilityVerified,
      definitiveNotFoundSupported: signedCapabilityVerified,
      idempotentResumeSupported: signedCapabilityVerified,
      actionKinds: startup.capabilityReceipt.actionKinds,
      actionConfigurationIdentityHashes: startup.actionConfigurationIdentityHashes,
      configurationIdentityHash: startup.configurationIdentityHash,
      processIdentityHash: startup.command.commandIdentityHash,
      trustIdentityHash: startup.trustIdentityHash,
      capabilityReceiptHash: startup.capabilityReceiptHash,
    });
  }
  async function invoke(action, input = {}) {
    const now = clock.now();
    const configuration = currentConfiguration();
    if (!capabilityReady(configuration, now)) {
      throw new Error(
        'autonomous_research_supervisor_external_action_recovery_capability_not_current',
      );
    }
    const request = recoveryRequest(input, action, configuration);
    const resolution = await invokeExternalResearchQualificationProcess(
      configuration.command,
      request,
      {
        cwd: path.dirname(configuration.processConfigurationPath),
        environment,
        runProcess,
        signal: input.signal || null,
        timeoutMs: input.timeoutMs || null,
      },
    );
    if (!verifyAutonomousResearchSupervisorExternalActionRecoveryResolution(resolution, {
      trustedSigner: configuration.processConfiguration.trustedSigner,
      publicKeyPem: configuration.processConfiguration.publicKey,
      actionKind: request.actionKind,
      actionConfigurationIdentityHash: request.actionConfigurationIdentityHash,
      idempotencyKey: request.idempotencyKey,
      markerHash: request.markerHash,
      reservationHash: request.reservationHash,
      progressHash: request.progressHash,
      recoveryConfigurationIdentityHash: request.recoveryConfigurationIdentityHash,
      recoveryTrustIdentityHash: request.recoveryTrustIdentityHash,
      recoveryCapabilityReceiptHash: request.recoveryCapabilityReceiptHash,
      now: clock.now(),
    })) {
      throw new Error(
        'autonomous_research_supervisor_external_action_recovery_response_invalid',
      );
    }
    return Object.freeze(resolution);
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchSupervisorExternalActionRecoveryPort',
    configurationIdentityHash: startup.configurationIdentityHash,
    inspectCapabilities,
    async lookup(input) { return invoke('lookup', input); },
    async resume(input) { return invoke('resume', input); },
  });
}
