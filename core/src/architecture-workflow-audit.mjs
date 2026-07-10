#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash-utils.mjs';
import { publicApiSummary } from './index.mjs';
import {
  CHANNEL_IDS,
  EXTERNAL_ACTIONS,
  PRODUCT_LINE_IDS,
  canonicalProductLineId,
  createChannelTask,
  uniqueStrings,
} from './contracts.mjs';
import { routeProductLine } from './product-router.mjs';
import {
  registrySummary,
  validateWorkflowProfile,
  workflowProfileForProductLine,
} from './workflow-registry.mjs';
import { buildPlanOnlyDraft } from './plan-only.mjs';
import {
  buildChannelProductionPipelineContractSet,
  validateChannelProductionPipelineArtifact,
} from './channel-production-pipeline.mjs';
import { validateStateTransition } from './state-machine.mjs';
import { buildAgentDecisionNodeAuditReport } from './agent-decision-node-audit.mjs';
import { buildDesignReferenceTaxonomySyncGate } from './design-reference-taxonomy-sync-gate.mjs';
import { refpackOutcomeScoringSelftest } from './refpack-outcome-scoring.mjs';
import { promptArtifactCompilerSelftest } from './prompt-artifact-compiler.mjs';
import { promptReadinessGateSelftest } from './prompt-readiness-gate.mjs';
import { buildPromptProductionContractGate } from './prompt-production-contracts.mjs';
import { generationContractsSelftest } from './generation-contracts.mjs';
import { routeContractSelftest } from './route-contracts.mjs';
import { semanticVisualModelPolicySelftest } from './semantic-visual-model-policy.mjs';
import { nextActionAdvisorSelftest } from './next-action-advisor.mjs';
import { policyProfilesSelftest } from './policy-profiles.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

export const ARCHITECTURE_WORKFLOW_AUDIT_VERSION = 1;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportsDir = path.join(packageRoot, 'reports');

const REQUIRED_LATEST_REPORTS = Object.freeze([
  {
    key: 'architectureCheckpoint',
    filename: 'architecture-checkpoint-latest.json',
    hashKeys: ['checkpointHash'],
  },
  {
    key: 'agentDecisionNodeAudit',
    filename: 'agent-decision-node-audit-latest.json',
    hashKeys: ['auditHash'],
  },
  {
    key: 'designReferenceTaxonomySyncGate',
    filename: 'design-reference-taxonomy-sync-gate-latest.json',
    hashKeys: ['taxonomySyncGateHash'],
  },
  {
    key: 'promptProductionContractGate',
    filename: 'prompt-production-contract-gate-latest.json',
    hashKeys: ['promptProductionContractGateHash'],
  },
  {
    key: 'runtimeDryRunHarness',
    filename: 'runtime-dry-run-harness-latest.json',
    hashKeys: ['runtimeDryRunHarnessHash'],
  },
  {
    key: 'channelRunnerCoverageMatrix',
    filename: 'channel-runner-coverage-matrix-latest.json',
    hashKeys: ['channelRunnerCoverageMatrixHash'],
  },
  {
    key: 'postActionRuntimeStatus',
    filename: 'post-action-runtime-status-latest.json',
    hashKeys: ['postActionRuntimeStatusHash'],
  },
  {
    key: 'integrationDependencyGate',
    filename: 'integration-dependency-gate-latest.json',
    hashKeys: ['gateHash'],
  },
]);

const WORKFLOW_STAGE_SOURCES = Object.freeze([
  {
    stageId: 'channel_task_intake',
    source: 'src/contracts.mjs',
    docs: 'docs/contract-json-schema.md',
    markers: ['createChannelTask', 'channelCapabilities'],
  },
  {
    stageId: 'product_line_decision',
    source: 'src/product-router.mjs',
    docs: 'docs/product-router.md',
    markers: ['agentSemanticRouteRequired: true', 'textRegexRoutingEnabled: false', 'textKeywordRoutingEnabled: false'],
  },
  {
    stageId: 'workflow_registry',
    source: 'src/workflow-registry.mjs',
    docs: 'docs/workflow-registry.md',
    markers: ['WORKFLOW_PROFILES', 'DIRECT_EXTERNAL_ACTIONS_BLOCKED', 'semanticPolicy'],
  },
  {
    stageId: 'plan_only_draft',
    source: 'src/plan-only.mjs',
    docs: 'docs/plan-only-adapter.md',
    markers: ['PLAN_ONLY_SAFETY', 'externalActionsRemainChannelOwned: true'],
  },
  {
    stageId: 'design_reference_resolution',
    source: 'src/llm-design-reference-resolver.mjs',
    docs: 'docs/design-reference-retrieval.md',
    markers: ["routingMode: 'model_semantic_locked'", "selectionAuthority: 'semantic_intake'", 'indexOverrideAllowed: false'],
  },
  {
    stageId: 'refpack_outcome_scoring',
    source: 'src/refpack-outcome-scoring.mjs',
    docs: 'docs/refpack-outcome-scoring.md',
    markers: ['RefpackOutcomeScoreReport', 'localScoringOnly: true', 'callsProviderOrModel: false', 'grantsExecutionPermission: false'],
  },
  {
    stageId: 'prompt_artifact_compiler',
    source: 'src/prompt-artifact-compiler.mjs',
    docs: 'docs/prompt-artifact-compiler.md',
    markers: ['PromptCompilerArtifact', 'PromptCompilerPlanSummary', 'localCompilationOnly: true', 'grantsExecutionPermission: false'],
  },
  {
    stageId: 'prompt_readiness_gate',
    source: 'src/prompt-readiness-gate.mjs',
    docs: 'docs/prompt-readiness-gate.md',
    markers: ['PromptReadinessGate', 'PromptSetStrategyGate', 'localGateOnly: true', 'grantsExecutionPermission: false'],
  },
  {
    stageId: 'prompt_production_contract',
    source: 'src/prompt-production-contracts.mjs',
    docs: 'docs/prompt-production-contracts.md',
    markers: ['PromptCompilerReport', 'PromptReadinessReport', 'validatesPromptCompilerReport: true', 'validatesPromptReadinessReport: true', 'grantsExecutionPermission: false'],
  },
  {
    stageId: 'generation_contracts',
    source: 'src/generation-contracts.mjs',
    docs: 'docs/generation-contracts.md',
    markers: ['GENERATION_STATUS', 'Generation request includes', 'localContractOnly: true', 'callsProviderOrModel: false', 'grantsExecutionPermission: false'],
  },
  {
    stageId: 'route_contracts',
    source: 'src/route-contracts.mjs',
    docs: 'docs/route-contracts.md',
    markers: ['ROUTE_CONTRACT_VERSION', 'localContractOnly: true', 'callsProviderOrModel: false', 'grantsExecutionPermission: false'],
  },
  {
    stageId: 'semantic_visual_model_policy',
    source: 'src/semantic-visual-model-policy.mjs',
    docs: 'docs/semantic-visual-model-policy.md',
    markers: ['SEMANTIC_VISUAL_MODEL_POLICY_VERSION', 'localPolicyOnly: true', 'callsProviderOrModel: false', 'grantsExecutionPermission: false'],
  },
  {
    stageId: 'approval_evidence_hashes',
    source: 'src/approval-packets.mjs',
    docs: 'docs/approval-packets.md',
    markers: ['ApprovalPacket', 'FreshEvidenceBundle'],
  },
  {
    stageId: 'policy_profiles',
    source: 'src/policy-profiles.mjs',
    docs: 'docs/policy-profiles.md',
    markers: ['POLICY_PROFILES', 'localPolicyOnly: true', 'callsProviderOrModel: false', 'grantsExecutionPermission: false'],
  },
  {
    stageId: 'execution_gate',
    source: 'src/execution-gates.mjs',
    docs: 'docs/execution-gates.md',
    markers: ['approval_required', 'fresh_evidence_required', 'human_feedback_approval_message_preview_required'],
  },
  {
    stageId: 'state_transition',
    source: 'src/state-machine.mjs',
    docs: 'docs/state-machine.md',
    markers: ['external_action_gate_not_allowed', 'plan_only_blockers_must_not_advance'],
  },
  {
    stageId: 'action_manifest',
    source: 'src/action-manifest.mjs',
    docs: 'docs/action-manifest.md',
    markers: ['ready_for_adapter', 'blocked_manifest', 'allowedChannelActions'],
  },
  {
    stageId: 'next_action_advisor',
    source: 'src/next-action-advisor.mjs',
    docs: 'docs/next-action-advisor.md',
    markers: ['localAdviceOnly: true', 'callsProviderOrModel: false', 'submitActionAllowed: false', 'grantsExecutionPermission: false'],
  },
  {
    stageId: 'adapter_handoff',
    source: 'src/adapter-handoff-outbox.mjs',
    docs: 'docs/adapter-handoff-outbox.md',
    markers: ['externalRunnerMustRecheckApproval', 'externalRunnerMustRecheckEvidence'],
  },
  {
    stageId: 'runner_registry',
    source: 'src/adapter-runner-registry.mjs',
    docs: 'docs/adapter-runner-registry.md',
    markers: ['runnerLocation', 'supportedActionIds', 'grantsExecutionPermission: false'],
  },
  {
    stageId: 'receipt_proof_inbox',
    source: 'src/adapter-dispatch-receipt-inbox.mjs',
    docs: 'docs/adapter-dispatch-receipt-inbox.md',
    markers: ['AdapterDispatchReceiptInbox', 'receiptHash'],
  },
  {
    stageId: 'post_action_runtime',
    source: 'src/post-action-runtime-status.mjs',
    docs: 'docs/post-action-runtime-status.md',
    markers: ['runtime_dry_run_harness', 'post_action_reconciliation_matrix'],
  },
]);

function readText(relativePath) {
  try {
    return fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');
  } catch {
    return null;
  }
}

export function latestReportHashBinding(report = {}, hashKeys = []) {
  for (const key of hashKeys) {
    if (report?.[key]) {
      return {
        hash: report[key],
        hashKey: key,
        genericHash: report?.hash || null,
        hashKeys,
        hashMissing: false,
        hashMismatch: Boolean(report?.hash && report.hash !== report[key]),
      };
    }
  }
  return {
    hash: null,
    hashKey: null,
    genericHash: report?.hash || null,
    hashKeys,
    hashMissing: true,
    hashMismatch: false,
  };
}

function readLatestReport({ key, filename, hashKeys }) {
  const filePath = path.join(reportsDir, filename);
  try {
    const report = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const hashBinding = latestReportHashBinding(report, hashKeys);
    return {
      key,
      filename,
      file: relativeToWorkspace(filePath),
      ok: report.ok === true,
      status: report.status || 'unknown_report_status',
      hash: hashBinding.hash,
      hashKey: hashBinding.hashKey,
      hashKeys: hashBinding.hashKeys,
      genericHash: hashBinding.genericHash,
      hashMissing: hashBinding.hashMissing,
      hashMismatch: hashBinding.hashMismatch,
      hashBindingOk: !hashBinding.hashMissing && !hashBinding.hashMismatch,
      summary: report.summary || {},
      blockerCount: Array.isArray(report.blockers) ? report.blockers.length : (report.summary?.blockerCount || 0),
      error: null,
    };
  } catch (error) {
    return {
      key,
      filename,
      file: relativeToWorkspace(filePath),
      ok: false,
      status: 'missing_or_invalid_report',
      hash: null,
      hashKey: null,
      hashKeys,
      genericHash: null,
      hashMissing: true,
      hashMismatch: false,
      hashBindingOk: false,
      summary: {},
      blockerCount: 0,
      error: error?.message || String(error),
    };
  }
}

function issue(code, notes = null, stageId = null) {
  return {
    code,
    stageId,
    notes: notes || null,
  };
}

function sourceStageAudit() {
  return WORKFLOW_STAGE_SOURCES.map((stage) => {
    const sourceText = readText(stage.source);
    const docsText = readText(stage.docs);
    const missingMarkers = sourceText
      ? stage.markers.filter((marker) => !sourceText.includes(marker))
      : [...stage.markers];
    const blockers = [
      !sourceText ? issue('workflow_stage_source_missing', stage.source, stage.stageId) : null,
      !docsText ? issue('workflow_stage_docs_missing', stage.docs, stage.stageId) : null,
      ...missingMarkers.map((marker) => issue('workflow_stage_source_marker_missing', `${stage.source}: ${marker}`, stage.stageId)),
    ].filter(Boolean);
    return {
      stageId: stage.stageId,
      source: stage.source,
      docs: stage.docs,
      markerCount: stage.markers.length,
      missingMarkerCount: missingMarkers.length,
      ok: blockers.length === 0,
      blockers,
    };
  });
}

function workflowProfileAudit() {
  const productLineValues = uniqueStrings(Object.values(PRODUCT_LINE_IDS).map(canonicalProductLineId), 64);
  const registry = registrySummary();
  const rows = productLineValues.map((productLineId) => {
    const profile = workflowProfileForProductLine(productLineId, { fallback: false });
    const validation = validateWorkflowProfile(profile);
    return {
      productLineId,
      profilePresent: Boolean(profile),
      workflowId: profile?.workflowId || null,
      defaultOutputMode: profile?.defaultOutputMode || null,
      semanticRequired: profile?.semanticPolicy?.required === true,
      referenceDigestOnly: profile?.referencePolicy?.digestOnly !== false,
      directExternalActionsBlocked: profile?.channelPolicy?.directExternalActionsBlocked || [],
      ok: Boolean(profile) && validation.ok,
      blockers: validation.issues || [{ code: 'workflow_profile_missing', productLineId }],
    };
  });
  const blockers = [
    ...(registry.profileCount !== productLineValues.length ? [
      issue('workflow_registry_profile_count_mismatch', `${registry.profileCount}/${productLineValues.length}`, 'workflow_registry'),
    ] : []),
    ...rows.flatMap((row) => (row.ok ? [] : row.blockers.map((blocker) => ({
      code: blocker.code || 'workflow_profile_invalid',
      stageId: 'workflow_registry',
      productLineId: row.productLineId,
      notes: blocker.message || blocker.productLineId || null,
    })))),
    ...rows.flatMap((row) => (
      row.directExternalActionsBlocked.includes(EXTERNAL_ACTIONS.LIVE_SUBMIT)
        ? []
        : [issue('workflow_profile_live_submit_not_blocked', row.productLineId, 'workflow_registry')]
    )),
  ];
  return {
    ok: blockers.length === 0,
    summary: registry,
    productLineCount: productLineValues.length,
    profileCount: registry.profileCount,
    rows,
    blockers,
  };
}

function routerProbeAudit() {
  const textOnly = routeProductLine({
    channelId: CHANNEL_IDS.ZBJ,
    title: 'logo brand package design',
    rawCategory: 'logo vi brand',
    requirementText: 'need a logo and vi board',
  });
  const semantic = routeProductLine({
    channelId: CHANNEL_IDS.ZBJ,
    title: 'ordinary buyer title',
    semanticRoute: {
      productLineId: PRODUCT_LINE_IDS.LOGO_BRAND,
      selectionAuthority: 'agent_semantic_intake',
      routeDecisionHash: digest({ probe: 'semantic_route_logo_brand' }),
    },
  });
  const blockers = [
    ...(textOnly.productLineId === PRODUCT_LINE_IDS.GENERIC_DESIGN ? [] : [
      issue('text_only_product_route_not_fail_closed', textOnly.productLineId, 'product_line_decision'),
    ]),
    ...(textOnly.safety?.textRegexRoutingEnabled === false && textOnly.safety?.textKeywordRoutingEnabled === false ? [] : [
      issue('product_router_text_routing_safety_flags_not_false', null, 'product_line_decision'),
    ]),
    ...(semantic.productLineId === PRODUCT_LINE_IDS.LOGO_BRAND && semantic.routeAuthority === 'agent_semantic_intake' ? [] : [
      issue('semantic_route_contract_not_accepted', semantic.productLineId, 'product_line_decision'),
    ]),
  ];
  return {
    ok: blockers.length === 0,
    textOnly,
    semantic,
    blockers,
  };
}

function planOnlyProbeAudit() {
  const channelTask = createChannelTask({
    channelId: CHANNEL_IDS.ZBJ,
    externalId: 'architecture-workflow-probe',
    title: 'Architecture workflow probe',
    rawCategory: 'design',
    createdAt: '2026-06-14T00:00:00.000Z',
  });
  const ready = buildPlanOnlyDraft({
    channelTask,
    routeInput: {
      semanticRoute: {
        productLineId: PRODUCT_LINE_IDS.LOGO_BRAND,
        selectionAuthority: 'agent_semantic_intake',
        routeDecisionHash: digest({ probe: 'plan_only_logo_brand' }),
      },
    },
    requirementText: 'Build a logo and visual identity route plan from semantic intake.',
    createdAt: '2026-06-14T00:00:00.000Z',
  });
  const blocked = buildPlanOnlyDraft({
    channelTask,
    routeInput: {
      title: 'logo keyword should not be enough',
      category: 'logo',
    },
    requirementText: 'This text-only probe must fail closed in core.',
    createdAt: '2026-06-14T00:00:00.000Z',
  });
  const blockers = [
    ...(ready.status === 'plan_only_ready' ? [] : [
      issue('semantic_plan_only_not_ready', ready.status, 'plan_only_draft'),
    ]),
    ...(ready.safety?.externalActions === false && ready.externalActionsRemainChannelOwned === true ? [] : [
      issue('plan_only_external_action_boundary_broken', null, 'plan_only_draft'),
    ]),
    ...(blocked.status === 'blocked_plan_only' && blocked.blockers.includes('generic_design_requires_clarification') ? [] : [
      issue('text_only_plan_only_not_blocked', blocked.status, 'plan_only_draft'),
    ]),
  ];
  return {
    ok: blockers.length === 0,
    readyStatus: ready.status,
    blockedStatus: blocked.status,
    blockedBlockers: blocked.blockers,
    safety: ready.safety,
    blockers,
  };
}

function channelPipelineAudit() {
  const set = buildChannelProductionPipelineContractSet({
    createdAt: '2026-06-14T00:00:00.000Z',
  });
  const validation = validateChannelProductionPipelineArtifact(set);
  const blockers = [
    ...set.blockers.map((blocker) => issue(blocker.code, blocker.notes, 'adapter_handoff')),
    ...validation.blockers.map((blocker) => issue(blocker.code, blocker.notes, 'adapter_handoff')),
    ...(set.safety?.executesExternalAction === false && set.safety?.grantsExecutionPermission === false ? [] : [
      issue('channel_pipeline_set_claims_execution_permission', null, 'adapter_handoff'),
    ]),
  ];
  return {
    ok: blockers.length === 0,
    status: set.status,
    channelIds: set.channelIds,
    summary: set.summary,
    validationStatus: validation.status,
    blockers,
  };
}

function stateGateProbeAudit() {
  const blockedExternalTransition = validateStateTransition({
    taskKey: 'architecture-workflow-probe',
    fromStage: 'submit_ready',
    toStage: 'submitted_verified',
    action: EXTERNAL_ACTIONS.LIVE_SUBMIT,
  });
  const blockers = [
    ...(blockedExternalTransition.allowed === false
      && blockedExternalTransition.blockers.some((blocker) => blocker.code === 'external_action_gate_not_allowed')
      ? []
      : [issue('state_machine_external_action_without_gate_not_blocked', blockedExternalTransition.decision, 'state_transition')]),
  ];
  return {
    ok: blockers.length === 0,
    blockedExternalTransition: {
      decision: blockedExternalTransition.decision,
      allowed: blockedExternalTransition.allowed,
      blockers: blockedExternalTransition.blockers.map((blocker) => blocker.code),
    },
    blockers,
  };
}

function inMemoryGateAudit({ generatedAt }) {
  const agentDecision = buildAgentDecisionNodeAuditReport({ createdAt: generatedAt });
  const taxonomy = buildDesignReferenceTaxonomySyncGate({ generatedAt });
  const refpackOutcomeScoring = refpackOutcomeScoringSelftest();
  const promptArtifactCompiler = promptArtifactCompilerSelftest();
  const promptReadinessGate = promptReadinessGateSelftest();
  const promptProduction = buildPromptProductionContractGate({ generatedAt });
  const generationContracts = generationContractsSelftest();
  const routeContracts = routeContractSelftest();
  const semanticVisualModelPolicy = semanticVisualModelPolicySelftest();
  const nextActionAdvisor = nextActionAdvisorSelftest();
  const policyProfiles = policyProfilesSelftest();
  const blockers = [
    ...(agentDecision.ok ? [] : agentDecision.blockers.map((blocker) => issue(blocker.code, blocker.notes, 'product_line_decision'))),
    ...(agentDecision.summary?.regexRoutingAllowed === false ? [] : [
      issue('agent_decision_audit_regex_routing_not_forbidden', null, 'product_line_decision'),
    ]),
    ...(agentDecision.summary?.keywordRoutingAllowed === false ? [] : [
      issue('agent_decision_audit_keyword_routing_not_forbidden', null, 'product_line_decision'),
    ]),
    ...(agentDecision.summary?.agentSemanticDecisionRequired === true ? [] : [
      issue('agent_decision_audit_agent_semantic_not_required', null, 'product_line_decision'),
    ]),
    ...(taxonomy.ok ? [] : taxonomy.blockers.map((blocker) => issue(blocker.code, blocker.industryId || blocker.refpackId || blocker.notes, 'design_reference_resolution'))),
    ...(refpackOutcomeScoring.ok ? [] : [issue('refpack_outcome_scoring_selftest_failed', refpackOutcomeScoring.reportHash || null, 'refpack_outcome_scoring')]),
    ...(promptArtifactCompiler.ok ? [] : [issue('prompt_artifact_compiler_selftest_failed', promptArtifactCompiler.reportHash || promptArtifactCompiler.planHash, 'prompt_artifact_compiler')]),
    ...(promptReadinessGate.ok ? [] : [issue('prompt_readiness_gate_selftest_failed', promptReadinessGate.passA?.readinessHash || null, 'prompt_readiness_gate')]),
    ...(promptProduction.ok ? [] : promptProduction.blockers.map((blocker) => issue(blocker.code, blocker.notes, 'prompt_production_contract'))),
    ...(generationContracts.ok ? [] : [issue('generation_contracts_selftest_failed', generationContracts.manifestId || null, 'generation_contracts')]),
    ...(routeContracts.ok ? [] : [issue('route_contracts_selftest_failed', routeContracts.book?.contractHash || null, 'route_contracts')]),
    ...(semanticVisualModelPolicy.ok ? [] : [issue('semantic_visual_model_policy_selftest_failed', semanticVisualModelPolicy.policyHash || null, 'semantic_visual_model_policy')]),
    ...(nextActionAdvisor.ok ? [] : [issue('next_action_advisor_selftest_failed', nextActionAdvisor.adviceHash || null, 'next_action_advisor')]),
    ...(policyProfiles.ok ? [] : [issue('policy_profiles_selftest_failed', policyProfiles.policyProfileHash || null, 'policy_profiles')]),
  ];
  return {
    ok: blockers.length === 0,
    agentDecisionNodeAudit: {
      ok: agentDecision.ok,
      auditHash: agentDecision.auditHash,
      summary: agentDecision.summary,
    },
    designReferenceTaxonomySyncGate: {
      ok: taxonomy.ok,
      taxonomySyncGateHash: taxonomy.taxonomySyncGateHash,
      summary: taxonomy.summary,
    },
    refpackOutcomeScoring: {
      ok: refpackOutcomeScoring.ok,
      reportHash: refpackOutcomeScoring.reportHash || null,
      score: refpackOutcomeScoring.tech?.score || null,
    },
    promptArtifactCompiler: {
      ok: promptArtifactCompiler.ok,
      compilerHash: promptArtifactCompiler.compiler?.compilerHash || null,
      planHash: promptArtifactCompiler.planHash || null,
      reportHash: promptArtifactCompiler.reportHash || null,
    },
    promptReadinessGate: {
      ok: promptReadinessGate.ok,
      readinessHash: promptReadinessGate.passA?.readinessHash || null,
      strategyHash: promptReadinessGate.passA?.promptSetStrategy?.strategyHash || null,
    },
    promptProductionContractGate: {
      ok: promptProduction.ok,
      promptProductionContractGateHash: promptProduction.promptProductionContractGateHash,
      summary: promptProduction.summary,
    },
    generationContracts: {
      ok: generationContracts.ok,
      manifestId: generationContracts.manifestId,
      routeStrategyHash: generationContracts.requestRouteStrategyHash,
      localContractOnly: generationContracts.safety?.localContractOnly === true,
    },
    routeContracts: {
      ok: routeContracts.ok,
      bookContractHash: routeContracts.book?.contractHash || null,
      localContractOnly: routeContracts.safety?.localContractOnly === true,
    },
    semanticVisualModelPolicy: {
      ok: semanticVisualModelPolicy.ok,
      policyHash: semanticVisualModelPolicy.policyHash,
      localPolicyOnly: semanticVisualModelPolicy.safety?.localPolicyOnly === true,
    },
    nextActionAdvisor: {
      ok: nextActionAdvisor.ok,
      adviceHash: nextActionAdvisor.adviceHash,
      localAdviceOnly: nextActionAdvisor.local?.safety?.localAdviceOnly === true,
      submitActionAllowed: nextActionAdvisor.submitValidation?.submitActionAllowed === true,
    },
    policyProfiles: {
      ok: policyProfiles.ok,
      policyProfileHash: policyProfiles.policyProfileHash,
      profileCount: policyProfiles.summary?.profileCount || 0,
      localPolicyOnly: policyProfiles.safety?.localPolicyOnly === true,
    },
    blockers,
  };
}

function latestReportAudit({ requireLatestReports }) {
  const reports = Object.fromEntries(REQUIRED_LATEST_REPORTS.map((config) => {
    const report = readLatestReport(config);
    return [config.key, report];
  }));
  const reportBlockers = (report) => [
    ...(report.ok ? [] : [
      issue('architecture_workflow_required_latest_report_not_ok', `${report.filename}: ${report.error || report.status}`, report.key),
    ]),
    ...(report.ok && report.hashMissing ? [
      issue('architecture_workflow_required_latest_report_hash_missing', `${report.filename}: ${report.hashKeys.join(' | ')}`, report.key),
    ] : []),
    ...(report.ok && report.hashMismatch ? [
      issue('architecture_workflow_required_latest_report_hash_mismatch', `${report.filename}: ${report.hashKey} != hash`, report.key),
    ] : []),
  ];
  const blockers = requireLatestReports
    ? Object.values(reports).flatMap(reportBlockers)
    : [];
  return {
    ok: blockers.length === 0,
    requireLatestReports,
    reports,
    blockers,
  };
}

function safetyAudit(publicApi) {
  const unsafe = Object.entries(publicApi.safety || {})
    .filter(([key, value]) => key !== 'publicApiOnly' && value === true)
    .map(([key]) => key);
  const blockers = unsafe.map((key) => issue('public_api_safety_flag_unsafe', key, 'public_api'));
  return {
    ok: blockers.length === 0,
    safety: publicApi.safety,
    blockers,
  };
}

export function buildArchitectureWorkflowAudit({
  generatedAt = new Date().toISOString(),
  requireLatestReports = true,
} = {}) {
  const publicApi = publicApiSummary();
  const stages = sourceStageAudit();
  const workflowProfiles = workflowProfileAudit();
  const routerProbes = routerProbeAudit();
  const planOnlyProbes = planOnlyProbeAudit();
  const channelPipeline = channelPipelineAudit();
  const stateGateProbe = stateGateProbeAudit();
  const inMemoryGates = inMemoryGateAudit({ generatedAt });
  const latestReports = latestReportAudit({ requireLatestReports });
  const safety = safetyAudit(publicApi);
  const blockers = [
    ...stages.flatMap((stage) => stage.blockers),
    ...workflowProfiles.blockers,
    ...routerProbes.blockers,
    ...planOnlyProbes.blockers,
    ...channelPipeline.blockers,
    ...stateGateProbe.blockers,
    ...inMemoryGates.blockers,
    ...latestReports.blockers,
    ...safety.blockers,
  ];
  const summary = {
    stageCount: stages.length,
    stagePassCount: stages.filter((stage) => stage.ok).length,
    publicModuleCount: publicApi.moduleCount,
    compatibilityModuleCount: publicApi.compatibilityModuleCount,
    workflowProfileCount: workflowProfiles.profileCount,
    productLineCount: workflowProfiles.productLineCount,
    routeTextOnlyFailsClosed: routerProbes.textOnly.productLineId === PRODUCT_LINE_IDS.GENERIC_DESIGN,
    semanticRouteAccepted: routerProbes.semantic.productLineId === PRODUCT_LINE_IDS.LOGO_BRAND,
    planOnlyReadyProbePassed: planOnlyProbes.readyStatus === 'plan_only_ready',
    planOnlyTextProbeBlocked: planOnlyProbes.blockedStatus === 'blocked_plan_only',
    channelPipelineReady: channelPipeline.status === 'ready_channel_production_pipeline_contract_set',
    channelPipelineExecutesExternalAction: channelPipeline.summary?.safety?.executesExternalAction === true,
    stateGateBlocksExternalActionWithoutAllow: stateGateProbe.ok,
    agentDecisionNodeAuditHash: inMemoryGates.agentDecisionNodeAudit.auditHash,
    designReferenceTaxonomySyncGateHash: inMemoryGates.designReferenceTaxonomySyncGate.taxonomySyncGateHash,
    refpackOutcomeScoringHash: inMemoryGates.refpackOutcomeScoring.reportHash,
    refpackOutcomeScoringPass: inMemoryGates.refpackOutcomeScoring.ok,
    promptReadinessGateHash: inMemoryGates.promptReadinessGate.readinessHash,
    promptReadinessGatePass: inMemoryGates.promptReadinessGate.ok,
    promptProductionContractGateHash: inMemoryGates.promptProductionContractGate.promptProductionContractGateHash,
    promptProductionContractGatePass: inMemoryGates.promptProductionContractGate.ok,
    generationContractsPass: inMemoryGates.generationContracts.ok,
    generationContractsManifestId: inMemoryGates.generationContracts.manifestId,
    routeContractsPass: inMemoryGates.routeContracts.ok,
    routeContractsBookHash: inMemoryGates.routeContracts.bookContractHash,
    semanticVisualModelPolicyPass: inMemoryGates.semanticVisualModelPolicy.ok,
    semanticVisualModelPolicyHash: inMemoryGates.semanticVisualModelPolicy.policyHash,
    nextActionAdvisorPass: inMemoryGates.nextActionAdvisor.ok,
    nextActionAdvisorHash: inMemoryGates.nextActionAdvisor.adviceHash,
    policyProfilesPass: inMemoryGates.policyProfiles.ok,
    policyProfilesHash: inMemoryGates.policyProfiles.policyProfileHash,
    latestReportCount: Object.keys(latestReports.reports).length,
    latestReportPassCount: Object.values(latestReports.reports).filter((report) => report.ok && report.hashBindingOk).length,
    blockerCount: blockers.length,
    regexRoutingAllowed: inMemoryGates.agentDecisionNodeAudit.summary?.regexRoutingAllowed === true,
    keywordRoutingAllowed: inMemoryGates.agentDecisionNodeAudit.summary?.keywordRoutingAllowed === true,
    agentSemanticDecisionRequired: inMemoryGates.agentDecisionNodeAudit.summary?.agentSemanticDecisionRequired === true,
  };
  const auditHash = digest({
    version: ARCHITECTURE_WORKFLOW_AUDIT_VERSION,
    stages: stages.map((stage) => ({
      stageId: stage.stageId,
      source: stage.source,
      docs: stage.docs,
      markerCount: stage.markerCount,
      missingMarkerCount: stage.missingMarkerCount,
      ok: stage.ok,
    })),
    workflowProfiles: {
      productLineCount: workflowProfiles.productLineCount,
      profileCount: workflowProfiles.profileCount,
      rows: workflowProfiles.rows.map((row) => ({
        productLineId: row.productLineId,
        workflowId: row.workflowId,
        ok: row.ok,
      })),
    },
    routerProbes: {
      textOnlyProductLineId: routerProbes.textOnly.productLineId,
      semanticProductLineId: routerProbes.semantic.productLineId,
    },
    planOnlyProbes: {
      readyStatus: planOnlyProbes.readyStatus,
      blockedStatus: planOnlyProbes.blockedStatus,
      blockedBlockers: planOnlyProbes.blockedBlockers,
    },
    channelPipeline: {
      status: channelPipeline.status,
      channelIds: channelPipeline.channelIds,
      summary: channelPipeline.summary,
    },
    stateGateProbe: stateGateProbe.blockedExternalTransition,
    inMemoryGates: {
      agentDecisionNodeAuditHash: inMemoryGates.agentDecisionNodeAudit.auditHash,
      designReferenceTaxonomySyncGateHash: inMemoryGates.designReferenceTaxonomySyncGate.taxonomySyncGateHash,
      refpackOutcomeScoringHash: inMemoryGates.refpackOutcomeScoring.reportHash,
      promptReadinessGateHash: inMemoryGates.promptReadinessGate.readinessHash,
      promptProductionContractGateHash: inMemoryGates.promptProductionContractGate.promptProductionContractGateHash,
      generationContractsManifestId: inMemoryGates.generationContracts.manifestId,
      nextActionAdvisorHash: inMemoryGates.nextActionAdvisor.adviceHash,
    },
    latestReports: Object.fromEntries(Object.entries(latestReports.reports).map(([key, report]) => [key, {
      ok: report.ok,
      status: report.status,
      hash: report.hash,
    }])),
    safety: publicApi.safety,
    blockers,
  });
  return {
    version: ARCHITECTURE_WORKFLOW_AUDIT_VERSION,
    kind: 'DesignProductionCoreArchitectureWorkflowAudit',
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_architecture_workflow_audit' : 'pass_architecture_workflow_audit',
    generatedAt,
    architectureWorkflowAuditHash: auditHash,
    summary,
    stages,
    publicApi: {
      version: publicApi.version,
      stableModules: publicApi.modules,
      compatibilityModules: publicApi.compatibilityModules,
      safety: publicApi.safety,
    },
    workflowProfiles,
    routerProbes,
    planOnlyProbes,
    channelPipeline,
    stateGateProbe,
    inMemoryGates,
    latestReports,
    safety,
    blockers,
    boundaries: {
      localAuditOnly: true,
      executesExternalAction: false,
      callsProvider: false,
      callsModel: false,
      opensBrowser: false,
      uploads: false,
      submits: false,
      sendsMessage: false,
      pays: false,
      acceptsDelivery: false,
      deploys: false,
      grantsExecutionPermission: false,
    },
  };
}

export function architectureWorkflowAuditMarkdown(report) {
  const lines = [
    '# Architecture Workflow Audit',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.architectureWorkflowAuditHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Workflow stages: ${report.summary.stagePassCount}/${report.summary.stageCount}`,
    `- Public modules: ${report.summary.publicModuleCount}`,
    `- Compatibility modules: ${report.summary.compatibilityModuleCount}`,
    `- Workflow profiles: ${report.summary.workflowProfileCount}/${report.summary.productLineCount}`,
    `- Text-only route fails closed: ${report.summary.routeTextOnlyFailsClosed}`,
    `- Semantic route accepted: ${report.summary.semanticRouteAccepted}`,
    `- Plan-only ready probe: ${report.summary.planOnlyReadyProbePassed}`,
    `- Plan-only text probe blocked: ${report.summary.planOnlyTextProbeBlocked}`,
    `- Channel pipeline ready: ${report.summary.channelPipelineReady}`,
    `- State gate blocks external action without ALLOW: ${report.summary.stateGateBlocksExternalActionWithoutAllow}`,
    `- Refpack outcome scoring: ${report.summary.refpackOutcomeScoringPass}`,
    `- Prompt production contract gate: ${report.summary.promptProductionContractGatePass}`,
    `- Generation contracts: ${report.summary.generationContractsPass}`,
    `- Next-action advisor: ${report.summary.nextActionAdvisorPass}`,
    `- Latest reports: ${report.summary.latestReportPassCount}/${report.summary.latestReportCount}`,
    `- Regex routing allowed: ${report.summary.regexRoutingAllowed}`,
    `- Keyword routing allowed: ${report.summary.keywordRoutingAllowed}`,
    `- Agent semantic decision required: ${report.summary.agentSemanticDecisionRequired}`,
    '',
    '## Workflow Stages',
    '',
    ...report.stages.map((stage) => `- ${stage.ok ? 'PASS' : 'FAIL'} ${stage.stageId}: ${stage.source} / ${stage.docs}`),
    '',
    '## Bound Reports',
    '',
    ...Object.values(report.latestReports.reports).map((bound) => `- ${bound.ok && bound.hashBindingOk ? 'PASS' : 'FAIL'} ${bound.key}: ${bound.filename}${bound.hash ? ` ${bound.hash}` : ''}`),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((blocker) => `- ${blocker.code}${blocker.stageId ? ` (${blocker.stageId})` : ''}${blocker.notes ? `: ${blocker.notes}` : ''}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local audit only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, IM/message send, acceptance, payment, deployment, channel-state fetch, or state mutation.',
    '- Does not grant external execution permission.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function writeArchitectureWorkflowAuditReport({
  outDir = reportsDir,
  requireLatestReports = true,
} = {}) {
  const report = buildArchitectureWorkflowAudit({ requireLatestReports });
  const files = writeLatestReportPair({
    report,
    fileId: 'architecture-workflow-audit-latest.json',
    markdown: architectureWorkflowAuditMarkdown(report),
    outputDir: outDir,
  });
  return {
    report,
    files,
  };
}

function main() {
  const strict = process.argv.includes('--strict');
  const { report, files } = writeArchitectureWorkflowAuditReport({
    requireLatestReports: true,
  });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    architectureWorkflowAuditHash: report.architectureWorkflowAuditHash,
    summary: report.summary,
    blockers: report.blockers.map((blocker) => blocker.code),
    reportFiles: {
      json: relativeToWorkspace(files.latestJson),
      md: relativeToWorkspace(files.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !report.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
