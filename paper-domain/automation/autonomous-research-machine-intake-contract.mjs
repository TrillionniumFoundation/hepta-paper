import { normalizeDatasetMounts } from './empirical-contract.mjs';
import { AUTONOMOUS_RESEARCH_POLICY_PROFILE } from './autonomous-research-policy-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  autonomousEmpiricalFamilyPluginProfileFor,
} from './autonomous-empirical-family-plugin-registry.mjs';
import {
  assertAutonomousResearchProfileResourceBudgetClosure,
  completeAutonomousResearchResourceBudgets,
  inspectAutonomousResearchProfileResourceBudgetClosure,
} from './autonomous-research-resource-budget-policy.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,191}$/;
const DOWNSTREAM_PAPER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const RECURRING_TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,131}$/;
const OBJECTIVE_PLACEHOLDER = /\b(?:TODO|TBD|placeholder|fill[ -]?in)\b/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINIMUM_EPOCH_MS = 60 * 60 * 1000;
const MAXIMUM_EPOCH_MS = 12 * 60 * 60 * 1000;
const BUDGET_KEYS = Object.freeze([
  'maxAgentCalls', 'maxCostUsd', 'maxCpuJobs', 'maxGpuJobs', 'maxMemoryMiB',
  'maxTokenCount', 'maxWallTimeMs',
]);
const INTAKE_KEYS = Object.freeze([
  'admissionCreatedAt', 'budgets', 'campaignId', 'datasetMounts', 'intakeHash',
  'intakeId', 'kind',
  'launchMode', 'objective', 'paperId', 'protocolFamily', 'providerConfigurationHash',
  'recurringGoldenProvenance', 'refereeCount', 'revisionRounds', 'version',
].sort());
const TEMPLATE_KEYS = Object.freeze([
  'budgets', 'datasetMounts', 'epochDurationMs', 'kind', 'objective', 'protocolFamily',
  'providerConfigurationHash', 'refereeCount', 'revisionRounds', 'templateHash',
  'templateId', 'version',
].sort());
const RECURRING_PROVENANCE_KEYS = Object.freeze([
  'epochDurationMs', 'epochStart', 'kind', 'sourceAuthorityHash', 'templateHash',
  'templateId', 'version',
].sort());

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point < 32 || point === 127;
  });
}

const AUTONOMOUS_RESEARCH_GOLDEN_RECURRING_DEFAULT_BUDGETS = Object.freeze({
  maxWallTimeMs: 2 * 60 * 60 * 1000,
  maxAgentCalls: 48,
  maxCpuJobs: 128,
  maxGpuJobs: 16,
  maxTokenCount: 300_000,
  maxCostUsd: 100,
  maxMemoryMiB: 8192,
});

export const AUTONOMOUS_RESEARCH_GOLDEN_RECURRING_HARD_BUDGETS = Object.freeze({
  ...AUTONOMOUS_RESEARCH_GOLDEN_RECURRING_DEFAULT_BUDGETS,
  maxAgentCalls: 512,
  maxCpuJobs: 32_768,
  maxGpuJobs: 32_768,
  maxTokenCount: 4_000_000,
});

function canonicalId(value, field) {
  const id = String(value || '');
  if (!SAFE_ID.test(id)) throw new Error(`autonomous_research_machine_intake_${field}_invalid`);
  return id;
}

function canonicalPaperId(value) {
  const id = String(value || '');
  if (!DOWNSTREAM_PAPER_ID.test(id)) {
    throw new Error('autonomous_research_machine_intake_paper_id_invalid');
  }
  return id;
}

function canonicalTemplateId(value) {
  const id = String(value || '');
  if (!RECURRING_TEMPLATE_ID.test(id)) {
    throw new Error('autonomous_research_machine_intake_template_id_invalid');
  }
  return id;
}

function canonicalInstant(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (typeof value !== 'string' || !Number.isFinite(date.getTime())
    || value !== date.toISOString()) {
    throw new Error(`autonomous_research_machine_intake_${field}_invalid`);
  }
  return value;
}

function canonicalObjective(value) {
  const objective = String(value || '').normalize('NFKC')
    .replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  // The proposal and generated hypothesis contracts cap their text at 8,000 code units.
  // Leave deterministic headroom for the protocol-specific statement wrapped around this value.
  if (!objective || objective.length > 7_000 || Buffer.byteLength(objective) > 8192
    || hasControlCharacters(objective) || OBJECTIVE_PLACEHOLDER.test(objective)) {
    throw new Error('autonomous_research_machine_intake_objective_invalid');
  }
  return objective;
}

function canonicalProtocolFamily(value) {
  const family = String(value || '');
  if (!AUTONOMOUS_RESEARCH_POLICY_PROFILE.allowedProtocolFamilies.includes(family)) {
    throw new Error('autonomous_research_machine_intake_protocol_family_invalid');
  }
  return family;
}

function canonicalCount(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`autonomous_research_machine_intake_${field}_invalid`);
  }
  return value;
}

function canonicalBudgets(value) {
  if (!exactKeys(value, BUDGET_KEYS)) {
    throw new Error('autonomous_research_machine_intake_budgets_invalid');
  }
  const positiveInteger = ['maxWallTimeMs', 'maxAgentCalls', 'maxCpuJobs', 'maxTokenCount',
    'maxMemoryMiB'];
  if (positiveInteger.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 1)
    || !Number.isSafeInteger(value.maxGpuJobs) || value.maxGpuJobs < 0
    || typeof value.maxCostUsd !== 'number' || !Number.isFinite(value.maxCostUsd)
    || value.maxCostUsd <= 0) {
    throw new Error('autonomous_research_machine_intake_budgets_invalid');
  }
  return Object.freeze(Object.fromEntries(BUDGET_KEYS.map((key) => [key, value[key]])));
}

function goldenBudgets(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => !BUDGET_KEYS.includes(key))) {
    throw new Error('autonomous_research_recurring_golden_budgets_invalid');
  }
  const clamped = Object.fromEntries(BUDGET_KEYS.map((key) => {
    const ceiling = AUTONOMOUS_RESEARCH_GOLDEN_RECURRING_HARD_BUDGETS[key];
    const candidate = value[key] === undefined
      ? AUTONOMOUS_RESEARCH_GOLDEN_RECURRING_DEFAULT_BUDGETS[key] : value[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
      throw new Error('autonomous_research_recurring_golden_budgets_invalid');
    }
    return [key, Math.min(candidate, ceiling)];
  }));
  return canonicalBudgets(clamped);
}

function resourceClosedGoldenBudgets({
  templateId,
  family,
  revisionRounds,
  refereeCount,
  budgets,
}) {
  const profile = autonomousEmpiricalFamilyPluginProfileFor(family);
  if (!profile?.executionProfile) {
    throw new Error('autonomous_research_recurring_golden_profile_invalid');
  }
  const benchmarkSelector = Object.freeze({
    selectorType: 'authorized_dataset_mount',
    benchmarkSelectorHash: profile.autonomousEmpiricalFamilyPluginProfileHash,
    experimentDesign: Object.freeze({
      seedSchedule: profile.seedSchedule,
      minimumRepetitions: profile.minimumRepetitions,
    }),
  });
  const initial = goldenBudgets(budgets);
  const inspectionInput = {
    campaignId: `autonomous-research:golden-template:${templateId}`,
    revisionRounds,
    refereeCount,
    executionProfile: profile.executionProfile,
    empiricalExecutionProfileSelectionHash:
      profile.autonomousEmpiricalFamilyPluginProfileHash,
    benchmarkSelector,
  };
  const preview = inspectAutonomousResearchProfileResourceBudgetClosure({
    ...inspectionInput, budgets: initial,
  });
  const completed = goldenBudgets(completeAutonomousResearchResourceBudgets({
    requestedBudgets: budgets,
    effectiveBudgets: initial,
    requiredBudgets: preview.requiredBudgets,
  }));
  assertAutonomousResearchProfileResourceBudgetClosure({
    ...inspectionInput, budgets: completed,
  });
  return completed;
}

function canonicalDatasetMounts(value, protocolFamily) {
  if (!Array.isArray(value) || value.length !== 1 || Object.keys(value).length !== 1) {
    throw new Error('autonomous_research_machine_intake_dataset_mounts_invalid');
  }
  let mounts;
  try { mounts = normalizeDatasetMounts(value); }
  catch { throw new Error('autonomous_research_machine_intake_dataset_mounts_invalid'); }
  if (mounts[0].benchmarkFamily !== protocolFamily) {
    throw new Error('autonomous_research_machine_intake_dataset_protocol_mismatch');
  }
  return Object.freeze(mounts);
}

function sameRecord(value, expected, hashField) {
  return value?.[hashField] === expected?.[hashField]
    && hashRecord('AutonomousResearchMachineIntakeEquality', value)
      === hashRecord('AutonomousResearchMachineIntakeEquality', expected);
}

function canonicalRecurringGoldenProvenance(value) {
  if (!exactKeys(value, RECURRING_PROVENANCE_KEYS)
    || value.version !== 1 || value.kind !== 'AutonomousResearchRecurringGoldenProvenance'
    || !SHA256.test(String(value.templateHash || ''))
    || !SHA256.test(String(value.sourceAuthorityHash || ''))
    || !Number.isSafeInteger(value.epochDurationMs)
    || value.epochDurationMs < MINIMUM_EPOCH_MS || value.epochDurationMs > MAXIMUM_EPOCH_MS
    || DAY_MS % value.epochDurationMs !== 0) {
    throw new Error('autonomous_research_recurring_golden_provenance_invalid');
  }
  const epochStart = canonicalInstant(value.epochStart, 'recurring_epoch_start');
  if (Date.parse(epochStart) % value.epochDurationMs !== 0) {
    throw new Error('autonomous_research_recurring_golden_provenance_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchRecurringGoldenProvenance',
    templateId: canonicalTemplateId(value.templateId),
    templateHash: value.templateHash,
    epochStart,
    epochDurationMs: value.epochDurationMs,
    sourceAuthorityHash: value.sourceAuthorityHash,
  });
}

export function buildAutonomousResearchMachineIntake({
  intakeId,
  paperId,
  campaignId,
  launchMode,
  objective,
  protocolFamily,
  datasetMounts,
  budgets,
  providerConfigurationHash,
  revisionRounds,
  refereeCount,
  admissionCreatedAt,
  recurringGoldenProvenance = null,
} = {}) {
  const normalizedPaperId = canonicalPaperId(paperId);
  const normalizedCampaignId = canonicalId(campaignId, 'campaign_id');
  if (normalizedCampaignId !== `autonomous-research:${normalizedPaperId}`) {
    throw new Error('autonomous_research_machine_intake_campaign_identity_invalid');
  }
  if (!['golden-bootstrap', 'production-run'].includes(launchMode)) {
    throw new Error('autonomous_research_machine_intake_launch_mode_invalid');
  }
  const provenance = recurringGoldenProvenance === null
    ? null : canonicalRecurringGoldenProvenance(recurringGoldenProvenance);
  if ((launchMode === 'golden-bootstrap') !== Boolean(provenance)) {
    throw new Error('autonomous_research_machine_intake_launch_source_invalid');
  }
  const admittedAt = canonicalInstant(admissionCreatedAt, 'admission_created_at');
  if (provenance) {
    const epochKey = provenance.epochStart.replace(/[-:.]/g, '');
    const expectedPaperId = `golden:${provenance.templateId}:${epochKey}`;
    if (normalizedPaperId !== expectedPaperId || admittedAt !== provenance.epochStart) {
      throw new Error('autonomous_research_recurring_golden_identity_invalid');
    }
  }
  const family = canonicalProtocolFamily(protocolFamily);
  const canonicalMounts = canonicalDatasetMounts(datasetMounts, family);
  const canonicalRevisionRounds = canonicalCount(
    revisionRounds, 'revision_rounds', 1, 10,
  );
  const canonicalRefereeCount = canonicalCount(refereeCount, 'referee_count', 2, 7);
  if (!SHA256.test(String(providerConfigurationHash || ''))) {
    throw new Error('autonomous_research_machine_intake_provider_configuration_hash_invalid');
  }
  const payload = Object.freeze({
    version: 2,
    kind: 'AutonomousResearchMachineIntake',
    intakeId: canonicalId(intakeId, 'intake_id'),
    paperId: normalizedPaperId,
    campaignId: normalizedCampaignId,
    launchMode,
    admissionCreatedAt: admittedAt,
    objective: canonicalObjective(objective),
    protocolFamily: family,
    datasetMounts: canonicalMounts,
    budgets: canonicalBudgets(budgets),
    providerConfigurationHash,
    recurringGoldenProvenance: provenance,
    revisionRounds: canonicalRevisionRounds,
    refereeCount: canonicalRefereeCount,
  });
  return Object.freeze({
    ...payload,
    intakeHash: hashRecord('AutonomousResearchMachineIntake', payload),
  });
}

export function verifyAutonomousResearchMachineIntake(value) {
  if (!exactKeys(value, INTAKE_KEYS) || value.version !== 2
    || value.kind !== 'AutonomousResearchMachineIntake' || !SHA256.test(String(value.intakeHash))) {
    return false;
  }
  try {
    return sameRecord(value, buildAutonomousResearchMachineIntake(value), 'intakeHash');
  } catch { return false; }
}

export function buildAutonomousResearchRecurringGoldenTemplate({
  templateId,
  epochDurationMs,
  objective,
  protocolFamily,
  datasetMounts,
  budgets = {},
  providerConfigurationHash,
  revisionRounds,
  refereeCount,
} = {}) {
  if (!Number.isSafeInteger(epochDurationMs) || epochDurationMs < MINIMUM_EPOCH_MS
    || epochDurationMs > MAXIMUM_EPOCH_MS || DAY_MS % epochDurationMs !== 0) {
    throw new Error('autonomous_research_recurring_golden_epoch_invalid');
  }
  const family = canonicalProtocolFamily(protocolFamily);
  const canonicalMounts = canonicalDatasetMounts(datasetMounts, family);
  const canonicalRevisionRounds = canonicalCount(
    revisionRounds, 'revision_rounds', 1, 10,
  );
  const canonicalRefereeCount = canonicalCount(refereeCount, 'referee_count', 2, 7);
  if (!SHA256.test(String(providerConfigurationHash || ''))) {
    throw new Error('autonomous_research_machine_intake_provider_configuration_hash_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchRecurringGoldenTemplate',
    templateId: canonicalTemplateId(templateId),
    epochDurationMs,
    objective: canonicalObjective(objective),
    protocolFamily: family,
    datasetMounts: canonicalMounts,
    budgets: resourceClosedGoldenBudgets({
      templateId,
      family,
      revisionRounds: canonicalRevisionRounds,
      refereeCount: canonicalRefereeCount,
      budgets,
    }),
    providerConfigurationHash,
    revisionRounds: canonicalRevisionRounds,
    refereeCount: canonicalRefereeCount,
  });
  return Object.freeze({
    ...payload,
    templateHash: hashRecord('AutonomousResearchRecurringGoldenTemplate', payload),
  });
}

export function verifyAutonomousResearchRecurringGoldenTemplate(value) {
  if (!exactKeys(value, TEMPLATE_KEYS) || value.version !== 1
    || value.kind !== 'AutonomousResearchRecurringGoldenTemplate'
    || !SHA256.test(String(value.templateHash))) return false;
  try {
    const expected = buildAutonomousResearchRecurringGoldenTemplate(value);
    return hashRecord('AutonomousResearchRecurringGoldenTemplateEquality', value)
      === hashRecord('AutonomousResearchRecurringGoldenTemplateEquality', expected);
  } catch { return false; }
}

export function autonomousResearchRecurringGoldenEpochStart({ template, now } = {}) {
  if (!verifyAutonomousResearchRecurringGoldenTemplate(template)) {
    throw new Error('autonomous_research_recurring_golden_template_invalid');
  }
  const observed = now instanceof Date ? now : new Date(now);
  if (now === null || now === undefined || !Number.isFinite(observed.getTime())) {
    throw new Error('autonomous_research_machine_intake_clock_invalid');
  }
  return new Date(
    Math.floor(observed.getTime() / template.epochDurationMs) * template.epochDurationMs,
  ).toISOString();
}

export function materializeAutonomousResearchRecurringGoldenIntake({
  template,
  now,
  sourceAuthorityHash,
} = {}) {
  const epochStart = autonomousResearchRecurringGoldenEpochStart({ template, now });
  if (!SHA256.test(String(sourceAuthorityHash || ''))) {
    throw new Error('autonomous_research_recurring_golden_source_authority_invalid');
  }
  const epochKey = epochStart.replace(/[-:.]/g, '');
  const paperId = `golden:${template.templateId}:${epochKey}`;
  return buildAutonomousResearchMachineIntake({
    intakeId: `intake:${paperId}`,
    paperId,
    campaignId: `autonomous-research:${paperId}`,
    launchMode: 'golden-bootstrap',
    admissionCreatedAt: epochStart,
    objective: template.objective,
    protocolFamily: template.protocolFamily,
    datasetMounts: template.datasetMounts,
    budgets: template.budgets,
    providerConfigurationHash: template.providerConfigurationHash,
    recurringGoldenProvenance: Object.freeze({
      version: 1,
      kind: 'AutonomousResearchRecurringGoldenProvenance',
      templateId: template.templateId,
      templateHash: template.templateHash,
      epochStart,
      epochDurationMs: template.epochDurationMs,
      sourceAuthorityHash,
    }),
    revisionRounds: template.revisionRounds,
    refereeCount: template.refereeCount,
  });
}

export function verifyAutonomousResearchRecurringGoldenIntake({
  intake,
  template,
  sourceAuthorityHash,
} = {}) {
  if (!verifyAutonomousResearchMachineIntake(intake)
    || !verifyAutonomousResearchRecurringGoldenTemplate(template)
    || intake.launchMode !== 'golden-bootstrap'
    || intake.recurringGoldenProvenance?.templateHash !== template.templateHash
    || intake.recurringGoldenProvenance?.sourceAuthorityHash !== sourceAuthorityHash) return false;
  try {
    const expected = materializeAutonomousResearchRecurringGoldenIntake({
      template,
      now: new Date(intake.recurringGoldenProvenance.epochStart),
      sourceAuthorityHash,
    });
    return sameRecord(intake, expected, 'intakeHash');
  } catch { return false; }
}
