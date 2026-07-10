import {
  CHANNEL_IDS,
  EXTERNAL_ACTIONS,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import {
  ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE,
  isExternalWorkspaceRunnerLocation,
} from './adapter-runner-location-boundary.mjs';
import { digest } from './hash-utils.mjs';

export const CHANNEL_PRODUCTION_PIPELINE_VERSION = 1;

export const CHANNEL_PRODUCTION_PIPELINE_STATUS = Object.freeze({
  READY: 'ready_channel_production_pipeline_contract',
  BLOCKED: 'blocked_channel_production_pipeline_contract',
});

export const CHANNEL_PRODUCTION_PIPELINE_SET_STATUS = Object.freeze({
  READY: 'ready_channel_production_pipeline_contract_set',
  BLOCKED: 'blocked_channel_production_pipeline_contract_set',
});

export const CHANNEL_PRODUCTION_PIPELINE_VALIDATION_STATUS = Object.freeze({
  PASS: 'pass_channel_production_pipeline_validation',
  FAIL: 'fail_channel_production_pipeline_validation',
});

const COMMON_STAGES = Object.freeze([
  ['channel_task', 'ChannelTask', 'normalize channel-native task/order into a redacted local task contract'],
  ['creative_brief', 'CreativeBrief', 'semantic subject, product line, constraints, references, and attachment evidence'],
  ['production_plan', 'ProductionPlanEnvelope', 'workflow profile, output mode, artifact policy, live rules, and external action gates'],
  ['artifact_package', 'ArtifactPackage', 'submit-ready or delivery-ready file set with hashes and provenance'],
  ['review_report', 'ReviewReport', 'business-quality and safety review bound to the exact package'],
  ['channel_submission', 'ChannelSubmission', 'planned channel action descriptor bound to approval/evidence'],
  ['adapter_run_receipt', 'AdapterRunReceipt', 'external runner result returned after a guarded runner executes outside core'],
  ['channel_state_proof', 'ChannelStateProof', 'independent read-only channel proof for receipt verification'],
]);

const CHANNEL_SPEC = Object.freeze({
  [CHANNEL_IDS.ZBJ]: Object.freeze({
    runnerId: 'zbj-auto-intake.live-runner',
    runnerLocation: '../zbj-auto-intake',
    supportedActions: [
      'zbj.providerSpendGuarded',
      'zbj.modelSpendGuarded',
      'zbj.pitchPrepareOnly',
      'zbj.pitchSubmitLive',
      'zbj.acceptanceApplyLive',
      'zbj.customerMessagePreview',
    ],
    unsupportedActions: [],
    receiptEvidence: ['worksId', 'submissionId', 'prepareEvidence', 'messageId', 'messagePreviewHash', 'humanFeedbackRevisionContractHash', 'acceptanceId'],
    proofEvidence: ['sellerSideMyWorks', 'workNo', 'uploadedFileCount', 'acceptanceHistoryRow', 'imMessageId', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    channelDifferences: [
      'seller-side duplicate preflight is mandatory before live submit',
      'GeeTest is a stop boundary, not an evasion target',
      'refund/deadline/no seller entry gates remove tasks from actionable queues',
    ],
  }),
  [CHANNEL_IDS.EPWK]: Object.freeze({
    runnerId: 'epwk-auto-intake.live-runner',
    runnerLocation: '../epwk-auto-intake',
    supportedActions: [
      'epwk.providerSpendGuarded',
      'epwk.modelSpendGuarded',
      'epwk.prepareOnly',
      'epwk.submitLive',
      'epwk.workModifyLive',
      'epwk.bidSubmitLive',
      'epwk.customerMessageLive',
      'epwk.acceptanceApplyLive',
    ],
    unsupportedActions: ['epwk.settlementFollowup'],
    receiptEvidence: ['prepareEvidence', 'uploadHandleRenderSnapshot', 'workId', 'submissionId', 'uploadedArtifactNames', 'messagePreviewHash', 'humanFeedbackRevisionContractHash', 'acceptanceDeliveryPackageHash'],
    proofEvidence: ['manuscriptRenderState', 'accountGateState', 'preparedFileList', 'workbackProof', 'manuscriptWorkId', 'imChannelProof', 'messagePreviewHash', 'humanFeedbackRevisionContractHash', 'acceptanceStateProof'],
    channelDifferences: [
      'live submit is supported only through the guarded EPWK runner and still requires account/shop/workback gates',
      'manuscript page may need detail-page taskData injection instead of a direct URL load',
      'file count and size limits are EPWK-specific and must not reuse ZBJ live rules',
      'buyer IM and acceptance run through guarded live adapters, then require independent seller-side proof before ledger verification',
    ],
  }),
  [CHANNEL_IDS.HEPTA]: Object.freeze({
    runnerId: 'hepta.delivery-runner',
    runnerLocation: '../hepta',
    supportedActions: [
      'hepta.providerSpendGuarded',
      'hepta.modelSpendGuarded',
      'hepta.deliveryDeploy',
      'hepta.customerMessagePreview',
    ],
    unsupportedActions: ['hepta.liveSubmit', 'hepta.acceptanceApply'],
    receiptEvidence: ['deploymentId', 'buildId', 'deliveryUrl', 'messagePreviewId', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    proofEvidence: ['deploymentStatus', 'deliveryArtifactIndex', 'checkoutOrOrderFixture', 'messagePreviewHash', 'humanFeedbackRevisionContractHash'],
    channelDifferences: [
      'Hepta has delivery/deployment proofs instead of live pitch upload proofs',
      'buyer-facing copy must stay free of local/dev/mock/debug wording',
      'mobile/top-design referee evidence stays separate from channel submit evidence',
    ],
  }),
});

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code: normalizeText(code),
    notes: normalizeText(notes || '') || null,
  };
}

function normalizeRefs(values = []) {
  return (values || []).map((item) => {
    if (typeof item === 'string') return { kind: 'path', ref: item };
    return {
      kind: item?.kind || 'path',
      ref: normalizeText(item?.ref || item?.path || item?.url || item?.id || ''),
      hash: normalizeText(item?.hash || '') || null,
      notes: normalizeText(item?.notes || '') || null,
    };
  }).filter((item) => item.ref);
}

function contractHashInput(contract) {
  return {
    version: contract.version,
    kind: contract.kind,
    status: contract.status,
    ready: contract.ready,
    channelId: contract.channelId,
    runner: contract.runner,
    stages: contract.stages,
    actionBoundary: contract.actionBoundary,
    evidenceBoundary: contract.evidenceBoundary,
    channelDifferences: contract.channelDifferences,
    blockers: contract.blockers,
    warnings: contract.warnings,
    safety: contract.safety,
  };
}

function blockersFor({ channelId, spec, stages, safety }) {
  const blockers = [];
  if (![CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA].includes(channelId)) blockers.push(issue('unsupported_channel_pipeline_contract', channelId));
  if (!spec) blockers.push(issue('channel_pipeline_spec_missing', channelId));
  if (!spec?.runnerId) blockers.push(issue('pipeline_runner_id_required'));
  if (!spec?.runnerLocation) {
    blockers.push(issue('pipeline_runner_location_required'));
  } else if (!isExternalWorkspaceRunnerLocation(spec.runnerLocation)) {
    blockers.push(issue(ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE, spec.runnerLocation));
  }
  if (!stages.length) blockers.push(issue('pipeline_stages_required'));
  for (const [stageId, contractKind] of COMMON_STAGES) {
    if (!stages.some((stage) => stage.stageId === stageId && stage.contractKind === contractKind)) {
      blockers.push(issue('common_pipeline_stage_missing', stageId));
    }
  }
  for (const key of ['executesExternalAction', 'fetchesChannelState', 'uploads', 'submits', 'sendsMessages', 'acceptsDelivery', 'pays', 'deploys', 'grantsExecutionPermission', 'readyForExecution']) {
    if (safety?.[key] === true) blockers.push(issue(`unsafe_channel_pipeline_claims_${key}`));
  }
  return blockers;
}

export function buildChannelProductionPipelineContract({
  channelId,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const spec = CHANNEL_SPEC[channelId] || null;
  const stages = COMMON_STAGES.map(([stageId, contractKind, purpose], index) => ({
    order: index + 1,
    stageId,
    contractKind,
    purpose,
    redactedByDefault: true,
    sourceSnapshotOptInOnly: true,
    hashBound: index >= 2,
  }));
  const safety = {
    pipelineContractOnly: true,
    executesExternalAction: false,
    fetchesChannelState: false,
    uploads: false,
    submits: false,
    sendsMessages: false,
    acceptsDelivery: false,
    pays: false,
    deploys: false,
    grantsExecutionPermission: false,
    readyForExecution: false,
  };
  const blockers = blockersFor({ channelId, spec, stages, safety });
  const contract = {
    version: CHANNEL_PRODUCTION_PIPELINE_VERSION,
    kind: 'ChannelProductionPipelineContract',
    status: blockers.length ? CHANNEL_PRODUCTION_PIPELINE_STATUS.BLOCKED : CHANNEL_PRODUCTION_PIPELINE_STATUS.READY,
    ready: blockers.length === 0,
    channelId: channelId || null,
    runner: {
      runnerId: spec?.runnerId || null,
      runnerLocation: spec?.runnerLocation || null,
      executeOutsideCore: true,
      coreOnlyBuildsHandoff: true,
      runnerLocationMustBeExternalWorkspace: true,
      runnerLocationExternalWorkspace: isExternalWorkspaceRunnerLocation(spec?.runnerLocation),
    },
    stages,
    actionBoundary: {
      supportedActions: uniqueStrings(spec?.supportedActions || [], 16),
      unsupportedActions: uniqueStrings(spec?.unsupportedActions || [], 16),
      externalActions: [
        EXTERNAL_ACTIONS.PROVIDER_SPEND,
        EXTERNAL_ACTIONS.MODEL_SPEND,
        EXTERNAL_ACTIONS.LIVE_PREPARE,
        EXTERNAL_ACTIONS.LIVE_SUBMIT,
        EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
        EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
        EXTERNAL_ACTIONS.DEPLOYMENT,
      ],
      currentApprovalRequired: true,
      freshEvidenceRequired: true,
      replayGuardRequired: true,
    },
    evidenceBoundary: {
      receiptEvidence: uniqueStrings(spec?.receiptEvidence || [], 16),
      proofEvidence: uniqueStrings(spec?.proofEvidence || [], 16),
      rawSourceSnapshotDefault: false,
      redactPrivateDataByDefault: true,
    },
    channelDifferences: uniqueStrings(spec?.channelDifferences || [], 16),
    blockers,
    warnings: [
      issue('channel_pipeline_contract_descriptor_only', 'This contract aligns channel pipeline stages and never runs adapters.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety,
    createdAt: createdAt || new Date().toISOString(),
  };
  const pipelineContractHash = digest(contractHashInput(contract));
  return {
    ...contract,
    pipelineContractHash,
    hash: pipelineContractHash,
  };
}

function setHashInput(set) {
  return {
    version: set.version,
    kind: set.kind,
    status: set.status,
    ready: set.ready,
    channelIds: set.channelIds,
    contractHashes: set.contractHashes,
    summary: set.summary,
    blockers: set.blockers,
    warnings: set.warnings,
    safety: set.safety,
  };
}

export function summarizeChannelProductionPipelineContracts(contracts = []) {
  const byStatus = {};
  const byChannel = {};
  const unsupportedActionCounts = {};
  for (const contract of contracts || []) {
    byStatus[contract.status] = (byStatus[contract.status] || 0) + 1;
    byChannel[contract.channelId || 'unknown'] = (byChannel[contract.channelId || 'unknown'] || 0) + 1;
    unsupportedActionCounts[contract.channelId || 'unknown'] = contract.actionBoundary?.unsupportedActions?.length || 0;
  }
  return {
    version: CHANNEL_PRODUCTION_PIPELINE_VERSION,
    count: contracts.length,
    readyCount: contracts.filter((contract) => contract.ready === true).length,
    commonStageCount: COMMON_STAGES.length,
    byStatus,
    byChannel,
    unsupportedActionCounts,
    safety: {
      executesExternalAction: contracts.some((contract) => contract.safety?.executesExternalAction === true),
      grantsExecutionPermission: contracts.some((contract) => contract.safety?.grantsExecutionPermission === true),
      readyForExecution: contracts.some((contract) => contract.safety?.readyForExecution === true),
    },
  };
}

export function buildChannelProductionPipelineContractSet({
  channelIds = [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA],
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const contracts = uniqueStrings(channelIds, 8).map((channelId) => buildChannelProductionPipelineContract({
    channelId,
    evidenceRefs,
    createdAt,
  }));
  const blockers = contracts.flatMap((contract) => (contract.blockers || []).map((blocker) => ({
    ...blocker,
    notes: normalizeText([contract.channelId, blocker.notes].filter(Boolean).join(': ')) || null,
  })));
  const summary = summarizeChannelProductionPipelineContracts(contracts);
  const set = {
    version: CHANNEL_PRODUCTION_PIPELINE_VERSION,
    kind: 'ChannelProductionPipelineContractSet',
    status: blockers.length ? CHANNEL_PRODUCTION_PIPELINE_SET_STATUS.BLOCKED : CHANNEL_PRODUCTION_PIPELINE_SET_STATUS.READY,
    ready: blockers.length === 0,
    channelIds: contracts.map((contract) => contract.channelId),
    contractHashes: Object.fromEntries(contracts.map((contract) => [contract.channelId, contract.pipelineContractHash])),
    contracts,
    summary,
    blockers,
    warnings: [
      issue('channel_pipeline_contract_set_descriptor_only', 'This set aligns ZBJ, EPWK, and Hepta production pipelines without running channel actions.', 'warning'),
    ],
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      pipelineContractSetOnly: true,
      executesExternalAction: false,
      fetchesChannelState: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      grantsExecutionPermission: false,
      readyForExecution: false,
    },
    createdAt: createdAt || new Date().toISOString(),
  };
  const pipelineContractSetHash = digest(setHashInput(set));
  return {
    ...set,
    pipelineContractSetHash,
    hash: pipelineContractSetHash,
  };
}

function validationBlockers(artifact, recomputedHash) {
  const blockers = [];
  if (!artifact || !['ChannelProductionPipelineContract', 'ChannelProductionPipelineContractSet'].includes(artifact.kind)) {
    blockers.push(issue('invalid_channel_production_pipeline_artifact'));
    return blockers;
  }
  const semanticHash = artifact.kind === 'ChannelProductionPipelineContractSet'
    ? normalizeText(artifact.pipelineContractSetHash || '')
    : normalizeText(artifact.pipelineContractHash || '');
  const genericHash = normalizeText(artifact.hash || '');
  if (!semanticHash) blockers.push(issue('channel_pipeline_hash_required'));
  if (!semanticHash) {
    blockers.push(issue(
      artifact.kind === 'ChannelProductionPipelineContractSet'
        ? 'channel_pipeline_set_hash_alias_required'
        : 'channel_pipeline_hash_alias_required',
    ));
  }
  if (!genericHash) blockers.push(issue('channel_pipeline_generic_hash_required'));
  if (semanticHash && genericHash && semanticHash !== genericHash) {
    blockers.push(issue('channel_pipeline_hash_alias_mismatch'));
  }
  if (semanticHash && recomputedHash && semanticHash !== recomputedHash) blockers.push(issue('channel_pipeline_hash_content_mismatch'));
  if (artifact.kind === 'ChannelProductionPipelineContract') {
    for (const [stageId] of COMMON_STAGES) {
      if (!artifact.stages?.some((stage) => stage.stageId === stageId)) blockers.push(issue('common_pipeline_stage_missing', stageId));
    }
    if (artifact.status === CHANNEL_PRODUCTION_PIPELINE_STATUS.READY && artifact.ready !== true) blockers.push(issue('ready_pipeline_without_ready_flag'));
    if (artifact.status === CHANNEL_PRODUCTION_PIPELINE_STATUS.READY && (artifact.blockers || []).length) blockers.push(issue('ready_pipeline_has_blockers'));
    const runnerLocation = normalizeText(artifact.runner?.runnerLocation || '');
    if (!runnerLocation) {
      blockers.push(issue('pipeline_runner_location_required'));
    } else if (!isExternalWorkspaceRunnerLocation(runnerLocation)) {
      blockers.push(issue(ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE, runnerLocation));
    }
  } else {
    for (const required of [CHANNEL_IDS.ZBJ, CHANNEL_IDS.EPWK, CHANNEL_IDS.HEPTA]) {
      if (!artifact.channelIds?.includes(required)) blockers.push(issue('required_channel_pipeline_missing', required));
    }
    for (const contract of artifact.contracts || []) {
      const expected = artifact.contractHashes?.[contract.channelId];
      const actual = contract.pipelineContractHash;
      if (expected && actual && expected !== actual) blockers.push(issue('channel_pipeline_set_hash_binding_mismatch', contract.channelId));
      blockers.push(...validationBlockers(contract, digest(contractHashInput(contract))).map((blocker) => issue(blocker.code, normalizeText([contract.channelId, blocker.notes].filter(Boolean).join(': ')) || null)));
    }
  }
  for (const key of ['executesExternalAction', 'fetchesChannelState', 'uploads', 'submits', 'sendsMessages', 'acceptsDelivery', 'pays', 'deploys', 'grantsExecutionPermission', 'readyForExecution']) {
    if (artifact.safety?.[key] === true || artifact[key] === true) blockers.push(issue(`unsafe_channel_pipeline_claims_${key}`));
  }
  return blockers;
}

export function validateChannelProductionPipelineArtifact(artifact = null) {
  const recomputedHash = artifact?.kind === 'ChannelProductionPipelineContractSet'
    ? digest(setHashInput(artifact))
    : (artifact?.kind === 'ChannelProductionPipelineContract' ? digest(contractHashInput(artifact)) : null);
  const blockers = validationBlockers(artifact, recomputedHash);
  const validation = {
    version: CHANNEL_PRODUCTION_PIPELINE_VERSION,
    kind: 'ChannelProductionPipelineValidation',
    status: blockers.length ? CHANNEL_PRODUCTION_PIPELINE_VALIDATION_STATUS.FAIL : CHANNEL_PRODUCTION_PIPELINE_VALIDATION_STATUS.PASS,
    ok: blockers.length === 0,
    artifactKind: normalizeText(artifact?.kind || ''),
    artifactHash: normalizeText(artifact?.pipelineContractSetHash || artifact?.pipelineContractHash || ''),
    recomputedHash,
    blockers,
    warnings: [
      issue('channel_pipeline_validation_is_local_only', 'This validator reads saved descriptors only.', 'warning'),
    ],
    safety: {
      validationOnly: true,
      executesExternalAction: false,
      fetchesChannelState: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      grantsExecutionPermission: false,
      readyForExecution: false,
    },
  };
  return {
    ...validation,
    validationHash: digest({
      version: validation.version,
      kind: validation.kind,
      status: validation.status,
      ok: validation.ok,
      artifactKind: validation.artifactKind,
      artifactHash: validation.artifactHash,
      recomputedHash: validation.recomputedHash,
      blockers: validation.blockers,
      warnings: validation.warnings,
      safety: validation.safety,
    }),
  };
}

export function channelProductionPipelineSelftest() {
  const set = buildChannelProductionPipelineContractSet({
    createdAt: '2026-05-25T00:00:00.000Z',
  });
  const validation = validateChannelProductionPipelineArtifact(set);
  const epwk = set.contracts.find((contract) => contract.channelId === CHANNEL_IDS.EPWK);
  const hepta = set.contracts.find((contract) => contract.channelId === CHANNEL_IDS.HEPTA);
  const tampered = validateChannelProductionPipelineArtifact({
    ...set,
    contracts: set.contracts.map((contract) => (contract.channelId === CHANNEL_IDS.HEPTA
      ? { ...contract, safety: { ...contract.safety, deploys: true } }
      : contract)),
  });
  const coreLocalRunner = validateChannelProductionPipelineArtifact({
    ...set,
    contracts: set.contracts.map((contract) => (contract.channelId === CHANNEL_IDS.ZBJ
      ? {
        ...contract,
        runner: {
          ...contract.runner,
          runnerLocation: './src',
        },
      }
      : contract)),
  });
  const strippedSetAlias = validateChannelProductionPipelineArtifact({
    ...set,
    pipelineContractSetHash: undefined,
  });
  const strippedContractAlias = validateChannelProductionPipelineArtifact({
    ...set,
    contracts: set.contracts.map((contract) => (contract.channelId === CHANNEL_IDS.ZBJ
      ? { ...contract, pipelineContractHash: undefined }
      : contract)),
  });
  const ok = set.ready === true
    && set.contracts.length === 3
    && set.summary.commonStageCount === COMMON_STAGES.length
    && epwk?.actionBoundary.supportedActions.includes('epwk.submitLive')
    && epwk?.actionBoundary.supportedActions.includes('epwk.workModifyLive')
    && epwk?.actionBoundary.supportedActions.includes('epwk.bidSubmitLive')
    && epwk?.actionBoundary.supportedActions.includes('epwk.customerMessageLive')
    && epwk?.actionBoundary.supportedActions.includes('epwk.acceptanceApplyLive')
    && !epwk?.actionBoundary.unsupportedActions.includes('epwk.submitLive')
    && !epwk?.actionBoundary.unsupportedActions.includes('epwk.workModifyLive')
    && !epwk?.actionBoundary.unsupportedActions.includes('epwk.bidSubmitLive')
    && !epwk?.actionBoundary.unsupportedActions.includes('epwk.customerMessageLive')
    && epwk?.actionBoundary.unsupportedActions.includes('epwk.settlementFollowup')
    && hepta?.evidenceBoundary.receiptEvidence.includes('deploymentId')
    && validation.ok === true
    && tampered.ok === false
    && coreLocalRunner.ok === false
    && coreLocalRunner.blockers.some((blocker) => blocker.code === ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE)
    && strippedSetAlias.ok === false
    && strippedSetAlias.blockers.some((blocker) => blocker.code === 'channel_pipeline_hash_required')
    && strippedSetAlias.blockers.some((blocker) => blocker.code === 'channel_pipeline_set_hash_alias_required')
    && strippedContractAlias.ok === false
    && strippedContractAlias.blockers.some((blocker) => blocker.code === 'channel_pipeline_hash_required')
    && strippedContractAlias.blockers.some((blocker) => blocker.code === 'channel_pipeline_hash_alias_required')
    && set.safety.executesExternalAction === false
    && set.safety.readyForExecution === false;
  return { ok, set, validation, tampered, coreLocalRunner, strippedSetAlias, strippedContractAlias };
}
