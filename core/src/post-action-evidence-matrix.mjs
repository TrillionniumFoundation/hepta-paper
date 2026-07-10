import {
  CORE_STAGES,
  EXTERNAL_ACTIONS,
  canonicalExternalAction,
  canonicalPackageRole,
  normalizeText,
  uniqueStrings,
} from './contracts.mjs';
import { ADAPTER_RECEIPT_STATUS, ADAPTER_RESULT_STATUS, buildAdapterRunReceipt } from './adapter-receipt.mjs';
import { actionEvidenceContract } from './adapter-runner-sdk.mjs';
import { CHANNEL_STATE_PROOF_STATUS, buildChannelStateProof } from './channel-state-proof.mjs';
import {
  buildRuntimeDryRunHarnessRecords,
  buildRuntimeDryRunHarnessReport,
} from './runtime-dry-run-harness.mjs';
import { digest } from './hash-utils.mjs';

export const POST_ACTION_EVIDENCE_MATRIX_VERSION = 1;

export const POST_ACTION_EVIDENCE_MATRIX_STATUS = Object.freeze({
  PASS: 'pass_post_action_evidence_matrix',
  FAIL: 'fail_post_action_evidence_matrix',
});

const FIXED_CREATED_AT = '2026-06-08T07:50:00.000Z';

function issue(code, notes = null, level = 'error') {
  return {
    level,
    code,
    notes: normalizeText(notes || '') || null,
  };
}

function token(value) {
  return normalizeText(value || '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function syntheticArtifactNames(scenario) {
  const count = Math.max(1, Number(scenario?.handoff?.artifactCount || 2));
  const action = canonicalExternalAction(scenario.handoff.action);
  return Array.from({ length: count }, (_, index) => `${scenario.handoff.channelId}-${token(action)}-${String(index + 1).padStart(2, '0')}.png`);
}

function hash(label, scenarioId) {
  return digest({ kind: 'post-action-evidence-matrix-fixture', label, scenarioId });
}

function transitionForAction(action) {
  const canonicalAction = canonicalExternalAction(action);
  if (canonicalAction === EXTERNAL_ACTIONS.PROVIDER_SPEND || canonicalAction === EXTERNAL_ACTIONS.MODEL_SPEND) {
    return { fromStage: CORE_STAGES.PLAN_READY, toStage: CORE_STAGES.GENERATION_READY };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.LIVE_PREPARE) {
    return { fromStage: CORE_STAGES.REVIEW_READY, toStage: CORE_STAGES.PREPARE_READY };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.LIVE_SUBMIT) {
    return { fromStage: CORE_STAGES.SUBMIT_READY, toStage: CORE_STAGES.SUBMITTED_VERIFIED };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) {
    return { fromStage: CORE_STAGES.DELIVERY_READY, toStage: CORE_STAGES.DELIVERY_READY };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) {
    return { fromStage: CORE_STAGES.SUBMITTED_VERIFIED, toStage: CORE_STAGES.SUBMITTED_VERIFIED };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.DEPLOYMENT) {
    return { fromStage: CORE_STAGES.REVIEW_READY, toStage: CORE_STAGES.DELIVERY_READY };
  }
  return { fromStage: CORE_STAGES.REVIEW_READY, toStage: CORE_STAGES.REVIEW_READY };
}

function previewAndManifest(runtimeRecord) {
  const scenario = runtimeRecord.reportScenario;
  const handoff = scenario.handoff;
  const manifest = runtimeRecord.base.manifest;
  const preview = runtimeRecord.preview;
  const artifactNames = preview?.payload?.artifactNames?.length
    ? preview.payload.artifactNames
    : syntheticArtifactNames(scenario);
  return {
    manifest,
    preview,
    artifactNames,
    hashes: {
      manifestHash: scenario.hashes.manifestHash,
      previewHash: scenario.hashes.previewHash,
      approvalHash: scenario.hashes.approvalHash,
      evidenceHash: scenario.hashes.evidenceHash,
      approvalProvenanceHash: scenario.hashes.approvalProvenanceHash
        || preview?.payload?.approvalProvenanceHash
        || preview?.adapter?.requiredHashes?.approvalProvenanceHash
        || manifest?.payload?.approvalProvenanceHash
        || null,
      platformStateSnapshotHash: hash('platform-state-snapshot', scenario.scenarioId),
      dryRunReplayHash: hash('dry-run-replay', scenario.scenarioId),
    },
  };
}

function successExternalResult(action, scenarioId, artifactNames, messagePreviewHash = null, humanFeedbackRevisionContractHash = null) {
  const canonicalAction = canonicalExternalAction(action);
  const baseId = `${token(canonicalAction)}-${token(scenarioId)}`;
  if (canonicalAction === EXTERNAL_ACTIONS.PROVIDER_SPEND) {
    return { providerRunId: `provider-${baseId}`, cacheKey: `provider-cache-${baseId}`, externalResultId: `external-${baseId}` };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.MODEL_SPEND) {
    return { modelRunId: `model-${baseId}`, cacheKey: `model-cache-${baseId}`, externalResultId: `external-${baseId}` };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.LIVE_PREPARE) {
    return { prepareId: `prepare-${baseId}`, externalResultId: `external-${baseId}`, prepareEvidenceOk: true, uploadedArtifactNames: artifactNames };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.LIVE_SUBMIT) {
    return {
      worksId: `works-${baseId}`,
      submissionId: `submission-${baseId}`,
      externalResultId: `external-${baseId}`,
      humanFeedbackRevisionContractHash: normalizeText(humanFeedbackRevisionContractHash || '') || null,
      totalMyWorks: 1,
      worksIsHidden: true,
      buyerIsHide: false,
      uploadedArtifactNames: artifactNames,
    };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.ACCEPTANCE_APPLY) {
    return {
      acceptanceId: `acceptance-${baseId}`,
      externalResultId: `external-${baseId}`,
      humanFeedbackRevisionContractHash: normalizeText(humanFeedbackRevisionContractHash || '') || null,
    };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.CUSTOMER_MESSAGE) {
    return {
      messageId: `message-${baseId}`,
      externalResultId: `external-${baseId}`,
      messagePreviewHash: normalizeText(messagePreviewHash || '') || null,
      humanFeedbackRevisionContractHash: normalizeText(humanFeedbackRevisionContractHash || '') || null,
    };
  }
  if (canonicalAction === EXTERNAL_ACTIONS.DEPLOYMENT) {
    return {
      deploymentId: `deploy-${baseId}`,
      buildId: `build-${baseId}`,
      url: `https://hepta.example/${baseId}`,
      externalResultId: `external-${baseId}`,
      buildEvidenceOk: true,
    };
  }
  return {};
}

function successStateEvidence(action, receipt, externalResult, artifactNames) {
  const canonicalAction = canonicalExternalAction(action);
  return {
    ok: true,
    verified: true,
    landed: canonicalAction === EXTERNAL_ACTIONS.LIVE_SUBMIT || canonicalAction === EXTERNAL_ACTIONS.DEPLOYMENT,
    receiptHash: receipt.receiptHash,
    externalId: receipt.payload.externalId,
    stateText: 'synthetic post-action channel proof verified',
    promptGenerationBinding: receipt.hashBinding?.promptGenerationBinding || receipt.payload?.promptGenerationBinding || null,
    artifactNames,
    artifactCount: artifactNames.length,
    totalMyWorks: externalResult.totalMyWorks,
    worksId: externalResult.worksId,
    submissionId: externalResult.submissionId,
    prepareId: externalResult.prepareId,
    acceptanceId: externalResult.acceptanceId,
    messageId: externalResult.messageId,
    messagePreviewHash: externalResult.messagePreviewHash,
    humanFeedbackRevisionContractHash: externalResult.humanFeedbackRevisionContractHash,
    deploymentId: externalResult.deploymentId,
    buildId: externalResult.buildId,
    providerRunId: externalResult.providerRunId,
    modelRunId: externalResult.modelRunId,
    cacheKey: externalResult.cacheKey,
    url: externalResult.url,
    worksIsHidden: externalResult.worksIsHidden,
    buyerIsHide: externalResult.buyerIsHide,
    prepareEvidenceOk: externalResult.prepareEvidenceOk,
    buildEvidenceOk: externalResult.buildEvidenceOk,
  };
}

function hasValue(object, field) {
  const value = object?.[field];
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== '';
}

function stripFields(object, fields) {
  const stripped = { ...object };
  for (const field of fields || []) delete stripped[field];
  return stripped;
}

function tamperFirstStateField(stateEvidence, fields) {
  const field = fields.find((item) => hasValue(stateEvidence, item));
  if (!field) return stateEvidence;
  const tampered = { ...stateEvidence };
  if (typeof tampered[field] === 'boolean') tampered[field] = !tampered[field];
  else if (typeof tampered[field] === 'number') tampered[field] += 1;
  else if (Array.isArray(tampered[field])) tampered[field] = [...tampered[field], 'tampered-extra.png'];
  else tampered[field] = `tampered-${tampered[field]}`;
  return tampered;
}

function rowForRuntimeRecord(runtimeRecord) {
  const scenario = runtimeRecord.reportScenario;
  const { manifest, preview, artifactNames, hashes } = previewAndManifest(runtimeRecord);
  const action = canonicalExternalAction(scenario.handoff.action);
  const contract = actionEvidenceContract(action);
  const expectedHumanFeedbackRevisionContractHash = normalizeText(
    preview?.payload?.humanFeedbackRevisionContractHash
      || manifest?.payload?.humanFeedbackRevisionContractHash
      || '',
  ) || null;
  const receiptResultFields = uniqueStrings([
    ...contract.receiptResultFields,
    ...(expectedHumanFeedbackRevisionContractHash ? ['humanFeedbackRevisionContractHash'] : []),
  ], 32);
  const stateProofFields = uniqueStrings([
    ...contract.stateProofFields,
    ...(expectedHumanFeedbackRevisionContractHash ? ['humanFeedbackRevisionContractHash'] : []),
  ], 32);
  const externalResult = successExternalResult(
    action,
    scenario.scenarioId,
    artifactNames,
    preview?.payload?.messagePreviewHash,
    preview?.payload?.humanFeedbackRevisionContractHash,
  );
  const receipt = buildAdapterRunReceipt({
    preview,
    manifest,
    resultStatus: ADAPTER_RESULT_STATUS.SUCCESS,
    externalResult,
    reportedHashes: hashes,
    runnerId: scenario.handoff.runnerId || 'post-action-evidence-matrix.synthetic-runner',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-evidence-matrix' }],
    createdAt: FIXED_CREATED_AT,
  });
  const proof = buildChannelStateProof({
    receipt,
    stateEvidence: successStateEvidence(action, receipt, externalResult, artifactNames),
    verifierId: 'post-action-evidence-matrix.synthetic-proof',
    evidenceRefs: [{ kind: 'fixture', ref: 'post-action-evidence-matrix' }],
    observedAt: FIXED_CREATED_AT,
    createdAt: FIXED_CREATED_AT,
  });
  const missingReceipt = buildAdapterRunReceipt({
    preview,
    manifest,
    resultStatus: ADAPTER_RESULT_STATUS.SUCCESS,
    externalResult: stripFields(externalResult, receiptResultFields),
    reportedHashes: hashes,
    runnerId: scenario.handoff.runnerId || 'post-action-evidence-matrix.synthetic-runner',
    createdAt: FIXED_CREATED_AT,
  });
  const missingProof = buildChannelStateProof({
    receipt,
    stateEvidence: {
      ok: true,
      verified: true,
      receiptHash: receipt.receiptHash,
      stateText: 'synthetic proof intentionally missing action fields',
    },
    verifierId: 'post-action-evidence-matrix.synthetic-proof',
    observedAt: FIXED_CREATED_AT,
    createdAt: FIXED_CREATED_AT,
  });
  const tamperedProof = buildChannelStateProof({
    receipt,
    stateEvidence: tamperFirstStateField(
      successStateEvidence(action, receipt, externalResult, artifactNames),
      stateProofFields,
    ),
    verifierId: 'post-action-evidence-matrix.synthetic-proof',
    observedAt: FIXED_CREATED_AT,
    createdAt: FIXED_CREATED_AT,
  });

  const receiptFieldsPresent = receiptResultFields.filter((field) => hasValue(receipt.result.external, field));
  const stateProofFieldsPresent = stateProofFields.filter((field) => hasValue(proof.evidence, field));
  const manifestChannelId = manifest.channelId || manifest.adapter?.channelId || null;
  const manifestActionId = manifest.actionId || manifest.adapter?.actionId || null;
  const packageRole = canonicalPackageRole(
    scenario.handoff?.packageRole
      || preview?.payload?.packageRole
      || manifest?.payload?.packageRole
      || '',
  ) || null;
  const manifestPackageRole = canonicalPackageRole(manifest?.payload?.packageRole || '') || null;
  const previewPackageRole = canonicalPackageRole(preview?.payload?.packageRole || '') || null;
  const handoffIdentityContinuity = manifestChannelId === scenario.handoff.channelId
    && manifestActionId === scenario.handoff.actionId
    && canonicalExternalAction(manifest.action) === action
    && action === canonicalExternalAction(scenario.handoff.action)
    && manifest.taskKey === scenario.handoff.taskKey
    && preview.payload?.taskKey === scenario.handoff.taskKey
    && (!packageRole || (manifestPackageRole === packageRole && previewPackageRole === packageRole));
  const manifestHashContinuity = receipt.hashBinding?.manifestHash === scenario.hashes.manifestHash
    && receipt.hashBinding?.manifestHash === manifest.manifestHash;
  const previewHashContinuity = receipt.hashBinding?.previewHash === scenario.hashes.previewHash
    && receipt.hashBinding?.previewHash === preview.previewHash;
  const approvalHashContinuity = receipt.hashBinding?.approvalHash === scenario.hashes.approvalHash;
  const evidenceHashContinuity = receipt.hashBinding?.evidenceHash === scenario.hashes.evidenceHash;
  const receiptFeedbackContractHashContinuity = !expectedHumanFeedbackRevisionContractHash
    || receipt.payload?.humanFeedbackRevisionContractHash === expectedHumanFeedbackRevisionContractHash;
  const proofFeedbackContractHashContinuity = !expectedHumanFeedbackRevisionContractHash
    || proof.payload?.humanFeedbackRevisionContractHash === expectedHumanFeedbackRevisionContractHash;
  const blockers = [];
  if (receipt.status !== ADAPTER_RECEIPT_STATUS.ACCEPTED || receipt.accepted !== true) {
    blockers.push(issue('accepted_receipt_missing', `${scenario.scenarioId}: ${receipt.blockers.map((item) => item.code).join(', ')}`));
  }
  if (proof.status !== CHANNEL_STATE_PROOF_STATUS.VERIFIED || proof.verified !== true) {
    blockers.push(issue('verified_state_proof_missing', `${scenario.scenarioId}: ${proof.blockers.map((item) => item.code).join(', ')}`));
  }
  if (receiptFieldsPresent.length !== receiptResultFields.length) {
    blockers.push(issue('receipt_contract_fields_missing', `${scenario.scenarioId}: ${receiptResultFields.filter((field) => !receiptFieldsPresent.includes(field)).join(', ')}`));
  }
  if (stateProofFieldsPresent.length !== stateProofFields.length) {
    blockers.push(issue('state_proof_contract_fields_missing', `${scenario.scenarioId}: ${stateProofFields.filter((field) => !stateProofFieldsPresent.includes(field)).join(', ')}`));
  }
  if (missingReceipt.status !== ADAPTER_RECEIPT_STATUS.BLOCKED) {
    blockers.push(issue('missing_receipt_fields_not_blocked', scenario.scenarioId));
  }
  if (missingProof.status !== CHANNEL_STATE_PROOF_STATUS.BLOCKED) {
    blockers.push(issue('missing_state_proof_fields_not_blocked', scenario.scenarioId));
  }
  if (tamperedProof.status !== CHANNEL_STATE_PROOF_STATUS.BLOCKED) {
    blockers.push(issue('tampered_state_proof_fields_not_blocked', scenario.scenarioId));
  }
  if (!handoffIdentityContinuity) blockers.push(issue('runtime_handoff_identity_not_preserved', scenario.scenarioId));
  if (!manifestHashContinuity) blockers.push(issue('runtime_manifest_hash_not_preserved', scenario.scenarioId));
  if (!previewHashContinuity) blockers.push(issue('runtime_preview_hash_not_preserved', scenario.scenarioId));
  if (!approvalHashContinuity) blockers.push(issue('runtime_approval_hash_not_preserved', scenario.scenarioId));
  if (!evidenceHashContinuity) blockers.push(issue('runtime_evidence_hash_not_preserved', scenario.scenarioId));
  if (!receiptFeedbackContractHashContinuity) blockers.push(issue('runtime_receipt_feedback_contract_hash_not_preserved', scenario.scenarioId));
  if (!proofFeedbackContractHashContinuity) blockers.push(issue('runtime_proof_feedback_contract_hash_not_preserved', scenario.scenarioId));

  return {
    scenarioId: scenario.scenarioId,
    channelId: scenario.handoff.channelId,
    actionId: scenario.handoff.actionId,
    action,
    packageRole,
    receiptResultFields,
    receiptFieldsPresent,
    stateProofFields,
    stateProofFieldsPresent,
    receiptStatus: receipt.status,
    receiptHash: receipt.receiptHash,
    runtimeManifestHash: scenario.hashes.manifestHash,
    runtimePreviewHash: scenario.hashes.previewHash,
    runtimeApprovalHash: scenario.hashes.approvalHash,
    runtimeEvidenceHash: scenario.hashes.evidenceHash,
    receiptManifestHash: receipt.hashBinding?.manifestHash || null,
    receiptPreviewHash: receipt.hashBinding?.previewHash || null,
    receiptApprovalHash: receipt.hashBinding?.approvalHash || null,
    receiptEvidenceHash: receipt.hashBinding?.evidenceHash || null,
    humanFeedbackRevisionContractHash: expectedHumanFeedbackRevisionContractHash,
    handoffIdentityContinuity,
    manifestHashContinuity,
    previewHashContinuity,
    approvalHashContinuity,
    evidenceHashContinuity,
    receiptFeedbackContractHashContinuity,
    proofFeedbackContractHashContinuity,
    proofStatus: proof.status,
    proofHash: proof.proofHash,
    missingReceiptStatus: missingReceipt.status,
    missingReceiptBlockers: uniqueStrings(missingReceipt.blockers.map((item) => item.code), 32),
    missingProofStatus: missingProof.status,
    missingProofBlockers: uniqueStrings(missingProof.blockers.map((item) => item.code), 32),
    tamperedProofStatus: tamperedProof.status,
    tamperedProofBlockers: uniqueStrings(tamperedProof.blockers.map((item) => item.code), 32),
    blockers,
  };
}

export function buildPostActionEvidenceMatrixReport({ generatedAt = new Date().toISOString() } = {}) {
  const runtimeReport = buildRuntimeDryRunHarnessReport({ generatedAt: FIXED_CREATED_AT });
  const { records: runtimeRecords } = buildRuntimeDryRunHarnessRecords();
  const readyRecords = runtimeRecords.filter((record) => record.reportScenario.readyForExternalRunner === true);
  const rows = readyRecords.map(rowForRuntimeRecord);
  const blockers = [
    ...(runtimeReport.ok === true ? [] : [issue('runtime_dry_run_harness_not_ready')]),
    ...rows.flatMap((row) => row.blockers),
  ];
  const actionClasses = uniqueStrings(rows.map((row) => row.action), 32);
  const summary = {
    routeCount: rows.length,
    actionClassCount: actionClasses.length,
    actionClasses,
    acceptedReceiptCount: rows.filter((row) => row.receiptStatus === ADAPTER_RECEIPT_STATUS.ACCEPTED).length,
    verifiedStateProofCount: rows.filter((row) => row.proofStatus === CHANNEL_STATE_PROOF_STATUS.VERIFIED).length,
    blockedMissingReceiptFieldCount: rows.filter((row) => row.missingReceiptStatus === ADAPTER_RECEIPT_STATUS.BLOCKED).length,
    blockedMissingStateProofFieldCount: rows.filter((row) => row.missingProofStatus === CHANNEL_STATE_PROOF_STATUS.BLOCKED).length,
    blockedTamperedStateProofFieldCount: rows.filter((row) => row.tamperedProofStatus === CHANNEL_STATE_PROOF_STATUS.BLOCKED).length,
    handoffIdentityContinuityCount: rows.filter((row) => row.handoffIdentityContinuity).length,
    manifestHashContinuityCount: rows.filter((row) => row.manifestHashContinuity).length,
    previewHashContinuityCount: rows.filter((row) => row.previewHashContinuity).length,
    approvalHashContinuityCount: rows.filter((row) => row.approvalHashContinuity).length,
    evidenceHashContinuityCount: rows.filter((row) => row.evidenceHashContinuity).length,
    packageRoleRouteCount: rows.filter((row) => row.packageRole).length,
    feedbackReceiptContractHashContinuityCount: rows.filter((row) => row.receiptFeedbackContractHashContinuity).length,
    feedbackProofContractHashContinuityCount: rows.filter((row) => row.proofFeedbackContractHashContinuity).length,
    humanFeedbackPackageRoleBoundRouteCount: rows.filter((row) => (
      row.humanFeedbackRevisionContractHash && row.packageRole
    )).length,
    routeBlockerCount: rows.reduce((sum, row) => sum + row.blockers.length, 0),
  };
  if (summary.routeCount !== 20) blockers.push(issue('post_action_matrix_route_count_unexpected', `${summary.routeCount}/20`));
  if (summary.actionClassCount !== 7) blockers.push(issue('post_action_matrix_action_class_count_unexpected', `${summary.actionClassCount}/7`));
  const humanFeedbackRows = rows.filter((row) => row.humanFeedbackRevisionContractHash);
  if (summary.handoffIdentityContinuityCount !== summary.routeCount) blockers.push(issue('post_action_handoff_identity_continuity_incomplete', `${summary.handoffIdentityContinuityCount}/${summary.routeCount}`));
  if (summary.manifestHashContinuityCount !== summary.routeCount) blockers.push(issue('post_action_manifest_hash_continuity_incomplete', `${summary.manifestHashContinuityCount}/${summary.routeCount}`));
  if (summary.previewHashContinuityCount !== summary.routeCount) blockers.push(issue('post_action_preview_hash_continuity_incomplete', `${summary.previewHashContinuityCount}/${summary.routeCount}`));
  if (summary.approvalHashContinuityCount !== summary.routeCount) blockers.push(issue('post_action_approval_hash_continuity_incomplete', `${summary.approvalHashContinuityCount}/${summary.routeCount}`));
  if (summary.evidenceHashContinuityCount !== summary.routeCount) blockers.push(issue('post_action_evidence_hash_continuity_incomplete', `${summary.evidenceHashContinuityCount}/${summary.routeCount}`));
  if (summary.packageRoleRouteCount !== summary.routeCount) blockers.push(issue('post_action_package_role_continuity_incomplete', `${summary.packageRoleRouteCount}/${summary.routeCount}`));
  if (summary.feedbackReceiptContractHashContinuityCount !== summary.routeCount) blockers.push(issue('post_action_receipt_feedback_contract_hash_continuity_incomplete', `${summary.feedbackReceiptContractHashContinuityCount}/${summary.routeCount}`));
  if (summary.feedbackProofContractHashContinuityCount !== summary.routeCount) blockers.push(issue('post_action_proof_feedback_contract_hash_continuity_incomplete', `${summary.feedbackProofContractHashContinuityCount}/${summary.routeCount}`));
  if (summary.humanFeedbackPackageRoleBoundRouteCount !== humanFeedbackRows.length) blockers.push(issue('post_action_human_feedback_package_role_not_bound', `${summary.humanFeedbackPackageRoleBoundRouteCount}/${humanFeedbackRows.length}`));
  const status = blockers.length
    ? POST_ACTION_EVIDENCE_MATRIX_STATUS.FAIL
    : POST_ACTION_EVIDENCE_MATRIX_STATUS.PASS;
  const matrixHash = digest({
    version: POST_ACTION_EVIDENCE_MATRIX_VERSION,
    status,
    summary,
    rows: rows.map((row) => ({
      scenarioId: row.scenarioId,
      channelId: row.channelId,
      actionId: row.actionId,
      action: row.action,
      packageRole: row.packageRole,
      receiptResultFields: row.receiptResultFields,
      stateProofFields: row.stateProofFields,
      handoffIdentityContinuity: row.handoffIdentityContinuity,
      manifestHashContinuity: row.manifestHashContinuity,
      previewHashContinuity: row.previewHashContinuity,
      approvalHashContinuity: row.approvalHashContinuity,
      evidenceHashContinuity: row.evidenceHashContinuity,
      humanFeedbackRevisionContractHash: row.humanFeedbackRevisionContractHash,
      receiptFeedbackContractHashContinuity: row.receiptFeedbackContractHashContinuity,
      proofFeedbackContractHashContinuity: row.proofFeedbackContractHashContinuity,
      receiptStatus: row.receiptStatus,
      proofStatus: row.proofStatus,
      missingReceiptStatus: row.missingReceiptStatus,
      missingReceiptBlockers: row.missingReceiptBlockers,
      missingProofStatus: row.missingProofStatus,
      missingProofBlockers: row.missingProofBlockers,
      tamperedProofStatus: row.tamperedProofStatus,
      tamperedProofBlockers: row.tamperedProofBlockers,
      blockerCodes: row.blockers.map((item) => item.code),
    })),
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    blockers,
  });
  return {
    version: POST_ACTION_EVIDENCE_MATRIX_VERSION,
    kind: 'PostActionEvidenceMatrixReport',
    status,
    ok: blockers.length === 0,
    generatedAt,
    runtimeDryRunHarnessHash: runtimeReport.runtimeDryRunHarnessHash,
    summary,
    rows,
    blockers,
    safety: {
      syntheticFixturesOnly: true,
      executesExternalAction: false,
      fetchesChannelState: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      callsProvider: false,
      callsModel: false,
      grantsExecutionPermission: false,
    },
    postActionEvidenceMatrixHash: matrixHash,
    hash: matrixHash,
  };
}
