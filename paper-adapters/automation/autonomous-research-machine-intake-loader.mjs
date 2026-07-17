import fs from 'node:fs';
import path from 'node:path';

import {
  materializeAutonomousResearchRecurringGoldenIntake,
  autonomousResearchRecurringGoldenEpochStart,
  verifyAutonomousResearchMachineIntake,
  verifyAutonomousResearchRecurringGoldenTemplate,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_FILE_BYTES = 1024 * 1024;
const CONFIGURATION_V1_KEYS = Object.freeze([
  'configurationHash', 'kind', 'machineAppendEnabled', 'recurringGoldenTemplates',
  'staticIntakeFiles', 'version',
].sort());
const CONFIGURATION_V2_KEYS = Object.freeze([
  ...CONFIGURATION_V1_KEYS,
  'machineProducerProfileHash',
].sort());
const STATIC_FILE_KEYS = Object.freeze(['intakeHash', 'path']);
const DAY_MS = 24 * 60 * 60 * 1000;

export const AUTONOMOUS_RESEARCH_MACHINE_INTAKE_CONFIGURATION_LIMITS = Object.freeze({
  maximumStaticIntakes: 256,
  maximumRecurringGoldenTemplates: 16,
  maximumRecurringGoldenCampaignsPerUtcDay: 24,
  maximumRecurringGoldenReservedCostUsdPerUtcDay: 2400,
  maximumRecurringGoldenReservedAgentCallsPerUtcDay: 1152,
  maximumRecurringGoldenReservedCpuJobsPerUtcDay: 3072,
  maximumRecurringGoldenReservedGpuJobsPerUtcDay: 384,
  maximumRecurringGoldenReservedTokenCountPerUtcDay: 7_200_000,
  maximumRecurringGoldenReservedWallTimeMsPerUtcDay: 48 * 60 * 60 * 1000,
});

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}

function secureJsonFile(candidate, label) {
  const absolute = path.resolve(candidate);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch { throw new Error(`autonomous_research_machine_intake_${label}_file_invalid`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2
    || stat.size > MAXIMUM_FILE_BYTES || (stat.mode & 0o022) !== 0) {
    throw new Error(`autonomous_research_machine_intake_${label}_file_invalid`);
  }
  let document;
  try { document = JSON.parse(fs.readFileSync(absolute, 'utf8')); }
  catch { throw new Error(`autonomous_research_machine_intake_${label}_json_invalid`); }
  return Object.freeze({ absolute, document });
}

function recurringDailyExposure(templates) {
  return templates.reduce((totals, template) => {
    const campaigns = DAY_MS / template.epochDurationMs;
    return Object.freeze({
      campaigns: totals.campaigns + campaigns,
      maxCostUsd: totals.maxCostUsd + (campaigns * template.budgets.maxCostUsd),
      maxAgentCalls: totals.maxAgentCalls + (campaigns * template.budgets.maxAgentCalls),
      maxCpuJobs: totals.maxCpuJobs + (campaigns * template.budgets.maxCpuJobs),
      maxGpuJobs: totals.maxGpuJobs + (campaigns * template.budgets.maxGpuJobs),
      maxTokenCount: totals.maxTokenCount + (campaigns * template.budgets.maxTokenCount),
      maxWallTimeMs: totals.maxWallTimeMs + (campaigns * template.budgets.maxWallTimeMs),
    });
  }, Object.freeze({
    campaigns: 0,
    maxCostUsd: 0,
    maxAgentCalls: 0,
    maxCpuJobs: 0,
    maxGpuJobs: 0,
    maxTokenCount: 0,
    maxWallTimeMs: 0,
  }));
}

function recurringExposureWithinLimits(templates) {
  const totals = recurringDailyExposure(templates);
  const limits = AUTONOMOUS_RESEARCH_MACHINE_INTAKE_CONFIGURATION_LIMITS;
  return totals.campaigns <= limits.maximumRecurringGoldenCampaignsPerUtcDay
    && totals.maxCostUsd <= limits.maximumRecurringGoldenReservedCostUsdPerUtcDay
    && totals.maxAgentCalls <= limits.maximumRecurringGoldenReservedAgentCallsPerUtcDay
    && totals.maxCpuJobs <= limits.maximumRecurringGoldenReservedCpuJobsPerUtcDay
    && totals.maxGpuJobs <= limits.maximumRecurringGoldenReservedGpuJobsPerUtcDay
    && totals.maxTokenCount <= limits.maximumRecurringGoldenReservedTokenCountPerUtcDay
    && totals.maxWallTimeMs <= limits.maximumRecurringGoldenReservedWallTimeMsPerUtcDay;
}

function requireProductionOneShot(intake) {
  if (intake.launchMode !== 'production-run' || intake.recurringGoldenProvenance !== null) {
    throw new Error('autonomous_research_machine_intake_one_shot_production_required');
  }
  return intake;
}

export function buildAutonomousResearchMachineIntakeConfiguration({
  staticIntakeFiles = [],
  recurringGoldenTemplates = [],
  machineAppendEnabled = true,
  machineProducerProfileHash = null,
} = {}) {
  if (!Array.isArray(staticIntakeFiles) || !Array.isArray(recurringGoldenTemplates)
    || typeof machineAppendEnabled !== 'boolean'
    || staticIntakeFiles.length > AUTONOMOUS_RESEARCH_MACHINE_INTAKE_CONFIGURATION_LIMITS
      .maximumStaticIntakes
    || recurringGoldenTemplates.length > AUTONOMOUS_RESEARCH_MACHINE_INTAKE_CONFIGURATION_LIMITS
      .maximumRecurringGoldenTemplates
    || staticIntakeFiles.some((candidate) => !exactKeys(candidate, STATIC_FILE_KEYS)
      || !path.isAbsolute(candidate.path) || !SHA256.test(String(candidate.intakeHash || '')))
    || new Set(staticIntakeFiles.map((candidate) => candidate.path)).size
      !== staticIntakeFiles.length
    || new Set(staticIntakeFiles.map((candidate) => candidate.intakeHash)).size
      !== staticIntakeFiles.length
    || recurringGoldenTemplates.some((template) => (
      !verifyAutonomousResearchRecurringGoldenTemplate(template)
    ))
    || new Set(recurringGoldenTemplates.map((template) => template.templateId)).size
      !== recurringGoldenTemplates.length
    || !recurringExposureWithinLimits(recurringGoldenTemplates)
    || (machineProducerProfileHash !== null
      && (!SHA256.test(String(machineProducerProfileHash || ''))
        || machineAppendEnabled !== true))) {
    throw new Error('autonomous_research_machine_intake_configuration_invalid');
  }
  const payload = Object.freeze({
    version: machineProducerProfileHash === null ? 1 : 2,
    kind: 'AutonomousResearchMachineIntakeConfiguration',
    staticIntakeFiles: Object.freeze(staticIntakeFiles.map((candidate) => Object.freeze({
      path: candidate.path,
      intakeHash: candidate.intakeHash,
    }))),
    recurringGoldenTemplates: Object.freeze([...recurringGoldenTemplates]),
    machineAppendEnabled,
    ...(machineProducerProfileHash === null ? {} : { machineProducerProfileHash }),
  });
  return Object.freeze({
    ...payload,
    configurationHash: hashRecord('AutonomousResearchMachineIntakeConfiguration', payload),
  });
}

export function verifyAutonomousResearchMachineIntakeConfiguration(value) {
  const keys = value?.version === 1 ? CONFIGURATION_V1_KEYS
    : value?.version === 2 ? CONFIGURATION_V2_KEYS : null;
  if (!keys || !exactKeys(value, keys)
    || value.kind !== 'AutonomousResearchMachineIntakeConfiguration'
    || !SHA256.test(String(value.configurationHash || ''))) return false;
  try {
    const expected = buildAutonomousResearchMachineIntakeConfiguration(value);
    return hashRecord('AutonomousResearchMachineIntakeConfigurationEquality', value)
      === hashRecord('AutonomousResearchMachineIntakeConfigurationEquality', expected);
  } catch { return false; }
}

export function readAutonomousResearchMachineIntakeConfiguration({
  configPath = null,
  environment = process.env,
  validateStaticContent = true,
} = {}) {
  if (typeof validateStaticContent !== 'boolean') {
    throw new Error('autonomous_research_machine_intake_configuration_read_policy_invalid');
  }
  const requested = configPath || environment.HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG;
  if (!requested) throw new Error('autonomous_research_machine_intake_configuration_required');
  const loaded = secureJsonFile(requested, 'configuration');
  if (!verifyAutonomousResearchMachineIntakeConfiguration(loaded.document)) {
    throw new Error('autonomous_research_machine_intake_configuration_invalid');
  }
  if (validateStaticContent) {
    for (const candidate of loaded.document.staticIntakeFiles) {
      const intake = requireProductionOneShot(
        readStaticAutonomousResearchMachineIntake(candidate.path).intake,
      );
      if (intake.intakeHash !== candidate.intakeHash) {
        throw new Error('autonomous_research_machine_intake_static_content_drift');
      }
    }
  }
  return Object.freeze({
    configPath: loaded.absolute,
    configuration: loaded.document,
  });
}

export function readStaticAutonomousResearchMachineIntake(candidate) {
  const loaded = secureJsonFile(candidate, 'static');
  if (!verifyAutonomousResearchMachineIntake(loaded.document)) {
    throw new Error('autonomous_research_machine_intake_static_document_invalid');
  }
  return Object.freeze({ intakePath: loaded.absolute, intake: loaded.document });
}

export function loadConfiguredAutonomousResearchMachineIntakes({
  configuration,
  repository,
  now = new Date(),
  operationMode = 'full',
} = {}) {
  if (!verifyAutonomousResearchMachineIntakeConfiguration(configuration)
    || !repository || typeof repository.appendIntake !== 'function'
    || !['full', 'bootstrap-only'].includes(operationMode)) {
    throw new Error('autonomous_research_machine_intake_loader_dependencies_invalid');
  }
  const results = [];
  // Qualification renewal is time-critical. A malformed one-shot must not starve the
  // current recurring Golden epoch, so recurring sources are admitted first and each
  // source error is isolated in the load report.
  for (const template of configuration.recurringGoldenTemplates) {
    const epochStart = autonomousResearchRecurringGoldenEpochStart({ template, now });
    try {
      results.push(repository.appendIntake({
        intake: materializeAutonomousResearchRecurringGoldenIntake({
          template,
          now,
          sourceAuthorityHash: configuration.configurationHash,
        }),
        sourceKind: 'recurring-golden',
        sourceRef: `${template.templateId}@${epochStart}`,
        sourceAuthorityHash: configuration.configurationHash,
        sourceTemplate: template,
        now,
      }));
    } catch (error) {
      results.push(Object.freeze({
        inserted: false,
        idempotent: false,
        sourceKind: 'recurring-golden',
        sourceRef: `${template.templateId}@${epochStart}`,
        error: String(error?.message || error),
      }));
    }
  }
  for (const candidate of operationMode === 'full' ? configuration.staticIntakeFiles : []) {
    try {
      const loaded = readStaticAutonomousResearchMachineIntake(candidate.path);
      requireProductionOneShot(loaded.intake);
      if (loaded.intake.intakeHash !== candidate.intakeHash) {
        throw new Error('autonomous_research_machine_intake_static_content_drift');
      }
      results.push(repository.appendIntake({
        intake: loaded.intake,
        sourceKind: 'static-file',
        sourceRef: loaded.intakePath,
        sourceAuthorityHash: configuration.configurationHash,
        now,
      }));
    } catch (error) {
      results.push(Object.freeze({
        inserted: false,
        idempotent: false,
        sourceKind: 'static-file',
        sourceRef: candidate.path,
        error: String(error?.message || error),
      }));
    }
  }
  return Object.freeze({
    configurationHash: configuration.configurationHash,
    attemptedCount: results.length,
    insertedCount: results.filter((result) => result.inserted).length,
    idempotentCount: results.filter((result) => result.idempotent).length,
    errorCount: results.filter((result) => result.error).length,
    results: Object.freeze(results),
  });
}

export function appendMachineAutonomousResearchIntake({
  configuration,
  repository,
  intake,
  topicProducerCapabilityReceipt = null,
  topicProducerAppendAuthorization = null,
  now = new Date(),
} = {}) {
  if (!verifyAutonomousResearchMachineIntakeConfiguration(configuration)
    || configuration.machineAppendEnabled !== true) {
    throw new Error('autonomous_research_machine_intake_machine_append_disabled');
  }
  if (!repository || typeof repository.appendMachineIntake !== 'function') {
    throw new Error('autonomous_research_machine_intake_loader_dependencies_invalid');
  }
  requireProductionOneShot(intake);
  if (configuration.version === 2 && (
    topicProducerCapabilityReceipt?.producerProfileHash
      !== configuration.machineProducerProfileHash
    || !topicProducerAppendAuthorization
  )) {
    throw new Error('autonomous_research_machine_intake_producer_capability_required');
  }
  return repository.appendMachineIntake({
    intake,
    sourceAuthorityHash: configuration.configurationHash,
    topicProducerCapabilityReceipt,
    topicProducerAppendAuthorization,
    now,
  });
}
