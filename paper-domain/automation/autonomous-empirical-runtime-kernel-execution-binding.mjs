import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyCampaignBenchmarkSelector } from './campaign-benchmark-selector.mjs';
import {
  verifyAutonomousEmpiricalExecutionProfileSelection,
  verifyAutonomousEmpiricalRuntimeCapabilityInspection,
} from './autonomous-empirical-execution-profile-policy.mjs';
import {
  AUTONOMOUS_ANALYSIS_KERNEL_ABI,
  AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY,
  autonomousEmpiricalPluginCompatibilityFor,
  autonomousLanguageRuntimeRegistryEntryFor,
  verifyLanguageRuntimeRegistryQualificationBinding,
} from './autonomous-language-runtime-kernel-registry.mjs';

function unique(values) {
  return Object.freeze([...new Set(values.filter(Boolean))]);
}

export function inspectAutonomousEmpiricalRuntimeKernelExecutionBinding({
  launchMode,
  protocolFamily,
  language,
  datasetMounts = [],
  benchmarkSelector = null,
  empiricalExecutionProfileSelection = null,
  empiricalRuntimeCapabilityInspection = null,
  runtimeImageReproducibilityInspection = null,
  observedAt = null,
  minimumRemainingValidityMs = 0,
} = {}) {
  const required = launchMode === 'production-run';
  const normalizedLanguage = String(language || '').trim().toLowerCase();
  const normalizedFamily = String(protocolFamily || '').trim();
  const blockers = [];
  let selectorVerification = null;
  let runtimeEntry = null;
  let pluginCompatibility = null;
  let runtimeCapability = null;
  if (required) {
    runtimeEntry = autonomousLanguageRuntimeRegistryEntryFor({
      language: normalizedLanguage,
      benchmarkFamily: normalizedFamily,
    });
    pluginCompatibility = autonomousEmpiricalPluginCompatibilityFor({
      language: normalizedLanguage,
      benchmarkFamily: normalizedFamily,
    });
    if (!runtimeEntry) blockers.push('autonomous_empirical_execution_runtime_unregistered');
    if (!pluginCompatibility) {
      blockers.push('autonomous_empirical_execution_plugin_runtime_incompatible');
    }
    if (!verifyAutonomousEmpiricalRuntimeCapabilityInspection(
      empiricalRuntimeCapabilityInspection,
      { requireRegisteredRuntime: true },
    )) {
      blockers.push('autonomous_empirical_execution_runtime_preflight_invalid');
    } else {
      runtimeCapability = empiricalRuntimeCapabilityInspection.languages[normalizedLanguage] || null;
    }
    if (!verifyAutonomousEmpiricalExecutionProfileSelection(
      empiricalExecutionProfileSelection,
      {
        protocolFamily: normalizedFamily,
        requireReady: true,
        runtimeCapabilityInspection: empiricalRuntimeCapabilityInspection,
        requireRuntimeCapabilityInspection: true,
        runtimeReproducibilityInspection: runtimeImageReproducibilityInspection,
        requireRegisteredRuntime: true,
        observedAt,
        minimumRemainingValidityMs,
      },
    )) {
      blockers.push('autonomous_empirical_execution_profile_registry_binding_invalid');
    }
    if (!verifyLanguageRuntimeRegistryQualificationBinding(
      empiricalExecutionProfileSelection?.runtimeRegistryQualificationBinding,
      {
        runtimeReproducibilityInspection: runtimeImageReproducibilityInspection,
        now: observedAt,
        minimumRemainingValidityMs,
      },
    )) {
      blockers.push('autonomous_empirical_execution_reproducibility_receipt_invalid');
    }
    selectorVerification = verifyCampaignBenchmarkSelector(benchmarkSelector, {
      benchmarkId: benchmarkSelector?.benchmarkId,
      datasetMounts,
    });
    if (!selectorVerification.valid
      || selectorVerification.expected?.experimentDesign?.benchmarkFamily !== normalizedFamily) {
      blockers.push('autonomous_empirical_execution_benchmark_selector_invalid');
    }
    const harness = selectorVerification?.expected?.experimentDesign?.benchmarkHarness || null;
    if (harness?.systemBenchmarkHarnessImplementationHash
        !== AUTONOMOUS_ANALYSIS_KERNEL_ABI.harnessImplementationHash
      || harness?.empiricalFamilyPluginPackageHash
        !== AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.pluginPackageHash
      || harness?.empiricalFamilyPluginRegistryHash
        !== AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.pluginRegistryHash
      || harness?.empiricalFamilyPluginStartupInspectionHash
        !== AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY.pluginStartupInspectionHash) {
      blockers.push('autonomous_empirical_execution_analysis_kernel_abi_mismatch');
    }
    if (runtimeEntry && runtimeCapability && (
      runtimeCapability.available !== true
      || runtimeCapability.image !== runtimeEntry.image
      || runtimeCapability.expectedDigest !== runtimeEntry.imageManifestDigest
      || runtimeCapability.observedDigest !== runtimeEntry.imageManifestDigest
      || runtimeCapability.runtimeRegistryEntryHash !== runtimeEntry.runtimeRegistryEntryHash
      || runtimeCapability.toolchainIdentityHash !== runtimeEntry.toolchainIdentityHash
      || runtimeCapability.analysisKernelAbiHash !== runtimeEntry.analysisKernelAbiHash
    )) blockers.push('autonomous_empirical_execution_runtime_identity_mismatch');
    if (runtimeEntry && pluginCompatibility && (
      empiricalExecutionProfileSelection?.selectedRuntimeRegistryEntryHash
        !== runtimeEntry.runtimeRegistryEntryHash
      || empiricalExecutionProfileSelection?.selectedToolchainIdentityHash
        !== runtimeEntry.toolchainIdentityHash
      || empiricalExecutionProfileSelection?.selectedEmpiricalPluginProfileHash
        !== pluginCompatibility.profileHash
      || empiricalExecutionProfileSelection?.analysisKernelAbiHash
        !== runtimeEntry.analysisKernelAbiHash
    )) blockers.push('autonomous_empirical_execution_selected_authority_mismatch');
  }
  const uniqueBlockers = unique(blockers);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousEmpiricalRuntimeKernelExecutionBinding',
    status: uniqueBlockers.length
      ? 'autonomous_empirical_runtime_kernel_execution_blocked'
      : required
        ? 'autonomous_empirical_runtime_kernel_execution_bound'
        : 'autonomous_empirical_runtime_kernel_execution_not_required',
    required,
    ready: uniqueBlockers.length === 0,
    qualificationScope: 'empirical-analysis-python-r-only-v1',
    formalAndManuscriptRuntimesCovered: false,
    language: normalizedLanguage || null,
    protocolFamily: normalizedFamily || null,
    languageRuntimeKernelRegistryHash: required
      ? AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY
        .autonomousLanguageRuntimeKernelRegistryHash : null,
    analysisKernelAbiHash: required ? AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash : null,
    runtimeRegistryEntryHash: runtimeEntry?.runtimeRegistryEntryHash || null,
    toolchainIdentityHash: runtimeEntry?.toolchainIdentityHash || null,
    empiricalPluginProfileHash: pluginCompatibility?.profileHash || null,
    empiricalExecutionProfileSelectionHash:
      empiricalExecutionProfileSelection
        ?.autonomousEmpiricalExecutionProfileSelectionHash || null,
    runtimeCapabilityInspectionHash:
      empiricalRuntimeCapabilityInspection
        ?.autonomousEmpiricalRuntimeCapabilityInspectionHash || null,
    runtimeReproducibilityReceiptHash:
      runtimeImageReproducibilityInspection?.receiptHash || null,
    runtimeRegistryQualificationBindingHash:
      empiricalExecutionProfileSelection
        ?.runtimeRegistryQualificationBindingHash || null,
    campaignBenchmarkSelectorHash:
      selectorVerification?.valid
        ? selectorVerification.expected.campaignBenchmarkSelectorHash : null,
    declarationAloneTreatedAsRuntimeQualification: false,
    blockers: uniqueBlockers,
  });
  return Object.freeze({
    ...payload,
    autonomousEmpiricalRuntimeKernelExecutionBindingHash: hashRecord(
      'AutonomousEmpiricalRuntimeKernelExecutionBinding',
      payload,
    ),
  });
}

export function assertAutonomousEmpiricalRuntimeKernelExecutionBinding(input) {
  const binding = inspectAutonomousEmpiricalRuntimeKernelExecutionBinding(input);
  if (!binding.ready) {
    const error = new Error(
      `autonomous_empirical_runtime_kernel_execution_blocked:${binding.blockers.join(',')}`,
    );
    error.retryable = false;
    error.receipt = binding;
    throw error;
  }
  return binding;
}
