import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import { PAPER_CORE_VERSION, hashPaperRecord, normalizedId, normalizeRefs } from './primitives.mjs';

function normalizeContractItems(values = [], fallbackPrefix = 'item', limit = 64) {
  return (values || []).slice(0, limit).map((item, index) => {
    if (typeof item === 'string') {
      return {
        id: `${fallbackPrefix}:${index + 1}`,
        text: normalizeText(item),
        status: 'observed',
        evidenceRefs: [],
      };
    }
    return {
      id: normalizedId(item?.id || item?.key || item?.claim_id || item?.obligation_id, `${fallbackPrefix}:${index + 1}`),
      text: normalizeText(item?.text || item?.claim || item?.obligation || item?.description || ''),
      status: normalizeText(item?.status || item?.state || 'observed') || 'observed',
      kind: normalizeText(item?.kind || item?.type || '') || null,
      evidenceRefs: normalizeRefs(item?.evidenceRefs || item?.evidence_refs || item?.evidence || []),
      sourceLocator: normalizeText(item?.sourceLocator || item?.source_locator || item?.locator || '') || null,
    };
  }).filter((item) => item.text || item.sourceLocator || item.evidenceRefs.length);
}

export function createClaimScopeContract({
  paperTask,
  claims = [],
  evidenceRefs = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('ClaimScopeContract requires paperTask');
  const normalizedClaims = normalizeContractItems(claims, `${paperTask.paperId}:claim`, 96);
  const contractBlockers = [...(blockers || [])];
  const contractWarnings = [...(warnings || [])];
  if (!normalizedClaims.length) contractWarnings.push('claim_scope_requires_manual_extraction');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'ClaimScopeContract',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: contractBlockers.length ? 'blocked_claim_scope' : (normalizedClaims.length ? 'claim_scope_detected' : 'manual_claim_scope_needed'),
    claimCount: normalizedClaims.length,
    claims: normalizedClaims,
    evidenceRefs: normalizeRefs(evidenceRefs),
    blockers: uniqueStrings(contractBlockers, 32),
    warnings: uniqueStrings(contractWarnings, 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...contract, claimScopeContractHash: hashPaperRecord('ClaimScopeContract', contract) };
}

export function createProofObligationContract({
  paperTask,
  obligations = [],
  evidenceRefs = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('ProofObligationContract requires paperTask');
  const normalizedObligations = normalizeContractItems(obligations, `${paperTask.paperId}:proof`, 96);
  const contractWarnings = [...(warnings || [])];
  if (!normalizedObligations.length) contractWarnings.push('proof_obligations_require_manual_review');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'ProofObligationContract',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'blocked_proof_obligations' : (normalizedObligations.length ? 'proof_obligations_detected' : 'manual_proof_review_needed'),
    proofObligationCount: normalizedObligations.length,
    obligations: normalizedObligations,
    evidenceRefs: normalizeRefs(evidenceRefs),
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(contractWarnings, 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
      claimsMachineCheckedProof: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...contract, proofObligationContractHash: hashPaperRecord('ProofObligationContract', contract) };
}

export function createEvidenceMatrixContract({
  paperTask,
  evidenceItems = [],
  evidenceRefs = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('EvidenceMatrixContract requires paperTask');
  const normalizedEvidence = normalizeContractItems(evidenceItems, `${paperTask.paperId}:evidence`, 160);
  const contractWarnings = [...(warnings || [])];
  if (!normalizedEvidence.length && !(evidenceRefs || []).length) contractWarnings.push('evidence_matrix_empty');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'EvidenceMatrixContract',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'blocked_evidence_matrix' : (normalizedEvidence.length || (evidenceRefs || []).length ? 'evidence_matrix_present' : 'manual_evidence_review_needed'),
    evidenceItemCount: normalizedEvidence.length,
    evidenceItems: normalizedEvidence,
    evidenceRefs: normalizeRefs(evidenceRefs),
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(contractWarnings, 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...contract, evidenceMatrixContractHash: hashPaperRecord('EvidenceMatrixContract', contract) };
}

export function createReproducibilityContract({
  paperTask,
  artifacts = [],
  evidenceRefs = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('ReproducibilityContract requires paperTask');
  const normalizedArtifacts = normalizeContractItems(artifacts, `${paperTask.paperId}:repro`, 96);
  const contractWarnings = [...(warnings || [])];
  if (!normalizedArtifacts.length) contractWarnings.push('reproducibility_contract_requires_manual_review');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'ReproducibilityContract',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'blocked_reproducibility' : (normalizedArtifacts.length ? 'reproducibility_evidence_present' : 'manual_reproducibility_review_needed'),
    reproducibilityItemCount: normalizedArtifacts.length,
    artifacts: normalizedArtifacts,
    evidenceRefs: normalizeRefs(evidenceRefs),
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(contractWarnings, 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...contract, reproducibilityContractHash: hashPaperRecord('ReproducibilityContract', contract) };
}

export function buildPaperResearchVerifyReceipt({
  paperTask,
  claimScopeContract,
  proofObligationContract,
  evidenceMatrixContract,
  reproducibilityContract,
  legacyCatalogReferences = [],
  evidenceRefs = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('PaperResearchVerifyReceipt requires paperTask');
  const receiptBlockers = [
    ...(blockers || []),
    ...(claimScopeContract?.blockers || []),
    ...(proofObligationContract?.blockers || []),
    ...(evidenceMatrixContract?.blockers || []),
    ...(reproducibilityContract?.blockers || []),
  ];
  const typedContracts = {
    claimScopeContractHash: claimScopeContract?.claimScopeContractHash || null,
    proofObligationContractHash: proofObligationContract?.proofObligationContractHash || null,
    evidenceMatrixContractHash: evidenceMatrixContract?.evidenceMatrixContractHash || null,
    reproducibilityContractHash: reproducibilityContract?.reproducibilityContractHash || null,
    legacyCatalogReferenceHashes: (legacyCatalogReferences || [])
      .map((receipt) => receipt.paperResearchWorkerBridgeReceiptHash)
      .filter(Boolean),
  };
  const observedEvidenceCount = normalizeRefs(evidenceRefs).length
    + Number(evidenceMatrixContract?.evidenceItemCount || 0)
    + Number(reproducibilityContract?.reproducibilityItemCount || 0);
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperResearchVerifyReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: receiptBlockers.length ? 'blocked' : (observedEvidenceCount ? 'evidence_present' : 'manual_review_needed'),
    typedContracts,
    observedEvidenceCount,
    evidenceRefs: normalizeRefs(evidenceRefs),
    blockers: uniqueStrings(receiptBlockers, 32),
    warnings: uniqueStrings([
      ...(warnings || []),
      ...(claimScopeContract?.warnings || []),
      ...(proofObligationContract?.warnings || []),
      ...(evidenceMatrixContract?.warnings || []),
      ...(reproducibilityContract?.warnings || []),
    ], 64),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
      claimsMachineCheckedProof: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...receipt, researchVerifyReceiptHash: hashPaperRecord('PaperResearchVerifyReceipt', receipt) };
}

export function buildPaperResearchWorkerBridgeReceipt({
  paperTask,
  worker,
  role,
  contractHashes = {},
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !worker?.path) throw new Error('PaperResearchWorkerBridgeReceipt requires paperTask and worker');
  const normalizedEvidenceRefs = normalizeRefs(evidenceRefs);
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperResearchWorkerBridgeReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    workerId: normalizeText(worker.id || worker.filename || worker.path),
    workerPath: normalizeText(worker.path),
    workerHash: normalizeText(worker.hash || '') || null,
    role: normalizeText(role || worker.role || 'evidence') || 'evidence',
    status: normalizedEvidenceRefs.length ? 'worker_bridge_evidence_bound' : 'worker_bridge_available_no_evidence',
    executionMode: 'discovery_only_no_import_no_execute',
    contractHashes: {
      claimScopeContractHash: contractHashes.claimScopeContractHash || null,
      proofObligationContractHash: contractHashes.proofObligationContractHash || null,
      evidenceMatrixContractHash: contractHashes.evidenceMatrixContractHash || null,
      reproducibilityContractHash: contractHashes.reproducibilityContractHash || null,
    },
    evidenceRefs: normalizedEvidenceRefs,
    safety: {
      importsOldControlPlane: false,
      executesWorker: false,
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
      claimsMachineCheckedProof: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...receipt,
    paperResearchWorkerBridgeReceiptHash: hashPaperRecord('PaperResearchWorkerBridgeReceipt', receipt),
  };
}
