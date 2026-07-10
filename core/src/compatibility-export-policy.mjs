import { digest } from './hash-utils.mjs';

export const COMPATIBILITY_EXPORT_POLICY_VERSION = 1;
export const COMPATIBILITY_EXPORT_FREEZE_MAX = 0;

export const COMPATIBILITY_EXPORT_POLICY_STATUSES = Object.freeze({
  LEGACY_COMPATIBILITY_EXPORT: 'legacy_compatibility_export',
  DEPRECATED_FOR_CHANNEL_RUNTIME: 'deprecated_for_channel_runtime',
  INTERNAL_REPORT_CHAIN: 'internal_report_chain',
});

export const COMPATIBILITY_EXPORT_REMOVAL_PHASES = Object.freeze({
  FREEZE_AND_MEASURE: 'phase_1_freeze_and_measure',
  FACADE_MIGRATION: 'phase_2_facade_migration',
  ROOT_INDEX_REMOVAL: 'phase_3_root_index_removal',
});

function entry({
  moduleId,
  group,
  status = COMPATIBILITY_EXPORT_POLICY_STATUSES.DEPRECATED_FOR_CHANNEL_RUNTIME,
  replacementSurface,
  replacementModuleIds = [],
  replacementScriptIds = [],
  removalPhase = COMPATIBILITY_EXPORT_REMOVAL_PHASES.FACADE_MIGRATION,
  notes,
}) {
  const effectiveReplacementModuleIds = group === 'read_only_report_chain' && replacementModuleIds.length === 0
    ? ['read-only-report-chain']
    : replacementModuleIds;
  return Object.freeze({
    moduleId,
    group,
    status,
    channelRuntimePolicy: 'forbidden_for_new_channel_runtime',
    replacementSurface,
    replacementModuleIds: Object.freeze([...effectiveReplacementModuleIds]),
    replacementScriptIds: Object.freeze([...replacementScriptIds]),
    removalPhase,
    notes,
  });
}

export const COMPATIBILITY_EXPORT_POLICY_ENTRIES = Object.freeze([]);

function byId(entries = COMPATIBILITY_EXPORT_POLICY_ENTRIES) {
  return new Map(entries.map((item) => [item.moduleId, item]));
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function validateCompatibilityExportPolicy({
  publicModules = [],
  compatibilityModules = [],
  scriptIds = [],
  entries = COMPATIBILITY_EXPORT_POLICY_ENTRIES,
  freezeMax = COMPATIBILITY_EXPORT_FREEZE_MAX,
} = {}) {
  const publicSet = new Set(publicModules);
  const compatibilitySet = new Set(compatibilityModules);
  const scriptSet = new Set(scriptIds);
  const entryMap = byId(entries);
  const statusSet = new Set(Object.values(COMPATIBILITY_EXPORT_POLICY_STATUSES));
  const removalPhaseSet = new Set(Object.values(COMPATIBILITY_EXPORT_REMOVAL_PHASES));
  const blockers = [];

  if (compatibilityModules.length > freezeMax) {
    blockers.push({
      code: 'compatibility_export_freeze_exceeded',
      notes: `CORE_COMPATIBILITY_MODULES has ${compatibilityModules.length} modules; freeze cap is ${freezeMax}. Remove legacy exports instead of adding new ones.`,
    });
  }

  for (const moduleId of compatibilityModules) {
    if (!entryMap.has(moduleId)) {
      blockers.push({
        code: 'compatibility_export_policy_missing',
        moduleId,
        notes: `${moduleId} is exported as compatibility but has no deprecation/removal policy.`,
      });
    }
  }

  for (const item of entries) {
    if (!compatibilitySet.has(item.moduleId)) {
      blockers.push({
        code: 'compatibility_export_policy_orphan',
        moduleId: item.moduleId,
        notes: `${item.moduleId} has policy but is not in CORE_COMPATIBILITY_MODULES.`,
      });
    }
    if (!statusSet.has(item.status)) {
      blockers.push({
        code: 'compatibility_export_policy_status_invalid',
        moduleId: item.moduleId,
        notes: `${item.moduleId} has invalid status ${item.status}.`,
      });
    }
    if (!removalPhaseSet.has(item.removalPhase)) {
      blockers.push({
        code: 'compatibility_export_policy_removal_phase_invalid',
        moduleId: item.moduleId,
        notes: `${item.moduleId} has invalid removal phase ${item.removalPhase}.`,
      });
    }
    if (item.channelRuntimePolicy !== 'forbidden_for_new_channel_runtime') {
      blockers.push({
        code: 'compatibility_export_policy_channel_runtime_not_forbidden',
        moduleId: item.moduleId,
        notes: `${item.moduleId} must remain forbidden for new channel runtime imports.`,
      });
    }
    if (!item.replacementSurface) {
      blockers.push({
        code: 'compatibility_export_policy_replacement_missing',
        moduleId: item.moduleId,
        notes: `${item.moduleId} must name a replacement surface.`,
      });
    }
    if (!item.replacementModuleIds.length && !item.replacementScriptIds.length) {
      blockers.push({
        code: 'compatibility_export_policy_replacement_binding_missing',
        moduleId: item.moduleId,
        notes: `${item.moduleId} must bind to at least one stable module or package script.`,
      });
    }
    for (const replacementModuleId of item.replacementModuleIds) {
      if (!publicSet.has(replacementModuleId)) {
        blockers.push({
          code: 'compatibility_export_policy_replacement_module_not_public',
          moduleId: item.moduleId,
          notes: `${item.moduleId} replacement module ${replacementModuleId} is not in CORE_PUBLIC_MODULES.`,
        });
      }
      if (compatibilitySet.has(replacementModuleId)) {
        blockers.push({
          code: 'compatibility_export_policy_replacement_module_compatibility',
          moduleId: item.moduleId,
          notes: `${item.moduleId} replacement module ${replacementModuleId} is itself a compatibility export.`,
        });
      }
    }
    for (const replacementScriptId of item.replacementScriptIds) {
      if (!scriptSet.has(replacementScriptId)) {
        blockers.push({
          code: 'compatibility_export_policy_replacement_script_missing',
          moduleId: item.moduleId,
          notes: `${item.moduleId} replacement script ${replacementScriptId} is not present in package.json.`,
        });
      }
    }
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_compatibility_export_policy' : 'pass_compatibility_export_policy',
    blockerCount: blockers.length,
    blockers,
  };
}

export function summarizeCompatibilityExportPolicy({
  publicModules = [],
  compatibilityModules = [],
  scriptIds = [],
  generatedAt = new Date().toISOString(),
  entries = COMPATIBILITY_EXPORT_POLICY_ENTRIES,
  freezeMax = COMPATIBILITY_EXPORT_FREEZE_MAX,
} = {}) {
  const validation = validateCompatibilityExportPolicy({
    publicModules,
    compatibilityModules,
    scriptIds,
    entries,
    freezeMax,
  });
  const summary = {
    entryCount: entries.length,
    compatibilityModuleCount: compatibilityModules.length,
    freezeMax,
    freezeRemainingGrowth: Math.max(0, freezeMax - compatibilityModules.length),
    zeroCompatibilityInvariant: freezeMax === 0 && compatibilityModules.length === 0 && entries.length === 0,
    coveredCompatibilityModuleCount: compatibilityModules.filter((moduleId) => byId(entries).has(moduleId)).length,
    byStatus: countBy(entries, (item) => item.status),
    byGroup: countBy(entries, (item) => item.group),
    byRemovalPhase: countBy(entries, (item) => item.removalPhase),
    modulesWithoutReplacementModules: entries.filter((item) => !item.replacementModuleIds.length).map((item) => item.moduleId),
    modulesWithoutReplacementScripts: entries.filter((item) => !item.replacementScriptIds.length).map((item) => item.moduleId),
  };
  const policy = {
    version: COMPATIBILITY_EXPORT_POLICY_VERSION,
    kind: 'CompatibilityExportPolicy',
    status: validation.status,
    ok: validation.ok,
    generatedAt,
    summary,
    entries: entries.map((item) => ({ ...item })),
    validation,
    safety: {
      localOnly: true,
      readOnly: true,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
  const policyHash = digest({
    version: policy.version,
    kind: policy.kind,
    status: policy.status,
    summary: policy.summary,
    entries: policy.entries,
    validation: policy.validation,
    safety: policy.safety,
  });
  return {
    ...policy,
    policyHash,
    hash: policyHash,
  };
}
