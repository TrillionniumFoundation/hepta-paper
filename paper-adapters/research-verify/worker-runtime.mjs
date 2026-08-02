import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileRecord, pathWithin, readJsonIfExists, sha256File } from '../../workflow-kernel/runtime/file-utils.mjs';
import { inspectScopedPathSync, inspectScopedWriteTargetSync, readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { computeReceiptHash, sealReceiptHash } from '../../paper-domain/evidence/receipt-hash-policy.mjs';
import { buildFormalClaimContract } from '../../paper-domain/research/formal-claim-contract.mjs';
import { normalizeFormalProofObligationMappings } from '../../paper-domain/research/formal-proof-obligation-mapping.mjs';
import { verifyTheoremSpecification } from '../../paper-domain/research/theorem-specification.mjs';
import { verifyProposalClaimToTheoremBinding } from '../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import { directoryMerkleHash } from '../runtime/os-sandboxed-worker-runner.mjs';
import { canonicalClaimsFromWorkerPlan } from './canonical-claim-registry-reader.mjs';
import { executeNativeResearchWorker, NATIVE_RESEARCH_WORKER_TYPES } from './native-research-worker-execution.mjs';
import { NATIVE_RESEARCH_WORKER_JOB_LEASE_SECONDS, withJobAttemptLeaseHeartbeat } from './job-attempt-lease-heartbeat.mjs';
import { formalAcademicPromotionBlockers } from './formal-academic-promotion-policy.mjs';
import { formalReviewEnvelopeBlockers } from './formal-review-envelope-verifier.mjs';
import {
  independentlyVerifyFormalReadableProofWorkerResult,
} from './formal-readable-proof-verifier.mjs';
import {
  verifyDynamicFormalExecutionAuthority,
} from './dynamic-formal-project-closure-readiness.mjs';
import {
  verifyFormalExecutionSnapshotReceipt,
} from './formal-proof-search-workspace-repository.mjs';
export { NATIVE_RESEARCH_WORKER_TYPES };
export { formalAcademicPromotionBlockers } from './formal-academic-promotion-policy.mjs';
const WORKER_TYPE_SET = new Set(NATIVE_RESEARCH_WORKER_TYPES);
const normalizedText = (value) => String(value || '').normalize('NFKC')
  .replace(/\s+/g, ' ').trim();
const safeWorkerId = (value) => (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(value || ''))
  ? String(value || '') : null);
async function validateInputs({ sourceRoot, worker }) {
  const blockers = [];
  const inputSpecs = Array.isArray(worker.inputs) ? worker.inputs : [];
  if (!inputSpecs.length) blockers.push('research_worker_inputs_missing');
  const records = [];
  for (const input of inputSpecs) {
    const relative = String(input?.path || '');
    const absolutePath = path.resolve(sourceRoot, relative);
    const inputBlockers = [];
    if (!relative || !pathWithin(sourceRoot, absolutePath)) inputBlockers.push('research_worker_input_outside_source_workspace');
    const scopedRead = inputBlockers.length ? null : readScopedFileSync({ scopeRoot: sourceRoot, candidate: absolutePath });
    if (scopedRead && scopedRead.status !== 'scoped_file_read_verified') inputBlockers.push(...scopedRead.blockers);
    const record = scopedRead?.status === 'scoped_file_read_verified'
      ? { path: relative, hash: scopedRead.hash, sizeBytes: scopedRead.bytes, scopedFileReadReceiptHash: scopedRead.scopedFileReadReceiptHash }
      : null;
    if (!record) inputBlockers.push('research_worker_input_missing');
    if (!input?.sha256) inputBlockers.push('research_worker_input_hash_missing');
    if (record && record.hash !== input.sha256) inputBlockers.push('research_worker_input_hash_mismatch');
    blockers.push(...inputBlockers.map((blocker) => `${relative || 'unknown'}:${blocker}`));
    records.push({
      role: String(input?.role || 'research_worker_input'),
      path: relative || null,
      absolutePath,
      hash: record?.hash || null,
      expectedHash: input?.sha256 || null,
      verified: inputBlockers.length === 0,
    });
  }
  return { records, blockers };
}
function normalizedWorkerDefinition(worker) {
  return {
    id: String(worker.id || ''),
    type: String(worker.type || ''),
    evidenceClass: String(worker.evidenceClass || ''),
    syntheticInput: worker.syntheticInput,
    outcomesPreprogrammed: worker.outcomesPreprogrammed,
    claimIds: Array.isArray(worker.claimIds) ? worker.claimIds.map(String).sort() : [],
    inputs: (Array.isArray(worker.inputs) ? worker.inputs : []).map((input) => ({
      role: String(input?.role || 'research_worker_input'),
      path: String(input?.path || ''),
      sha256: String(input?.sha256 || ''),
    })),
    parameters: worker.parameters || {},
  };
}
function validatePersistedReceipt({ persisted, expected }) {
  const blockers = [];
  if (!persisted) blockers.push('native_research_worker_execution_receipt_missing');
  if (persisted && computeReceiptHash(persisted) !== persisted.nativeResearchWorkerExecutionReceiptHash) {
    blockers.push('native_research_worker_execution_receipt_hash_invalid');
  }
  for (const key of ['paperId', 'taskKey', 'workerId', 'workerType', 'jobId', 'attemptId', 'leaseGeneration', 'planHash', 'theoremSpecificationHash', 'dynamicFormalExecutionAuthorityHash', 'workerDefinitionHash', 'engineHash', 'resultHash']) {
    if (persisted && persisted[key] !== expected[key]) blockers.push(`native_research_worker_receipt_${key}_mismatch`);
  }
  if (persisted && JSON.stringify(persisted.inputs) !== JSON.stringify(expected.inputs)) {
    blockers.push('native_research_worker_receipt_inputs_mismatch');
  }
  if (persisted && persisted.status !== 'native_research_worker_execution_verified') {
    blockers.push('native_research_worker_receipt_not_verified');
  }
  return blockers;
}
export function verifyNativeResearchWorkerExecutionReport(report, {
  paperId = null,
  taskKey = null,
  requireFormalWorkers = false,
  theoremSpecificationHash = null,
  dynamicFormalExecutionAuthorityHash = null,
} = {}) {
  const blockers = [];
  const { nativeResearchWorkerExecutionReportHash: claimedHash, ...payload } = report || {};
  if (!report || report.version !== 1 || report.kind !== 'NativeResearchWorkerExecutionReport') {
    blockers.push('native_research_worker_execution_report_shape_invalid');
  }
  if (!claimedHash || hashPaperRecord('NativeResearchWorkerExecutionReport', payload) !== claimedHash) {
    blockers.push('native_research_worker_execution_report_hash_invalid');
  }
  if (paperId && report?.paperId !== paperId) blockers.push('native_research_worker_execution_report_paper_mismatch');
  if (taskKey && report?.taskKey !== taskKey) blockers.push('native_research_worker_execution_report_task_mismatch');
  if (theoremSpecificationHash && report?.theoremSpecificationHash !== theoremSpecificationHash) {
    blockers.push('native_research_worker_execution_report_theorem_specification_mismatch');
  }
  if (dynamicFormalExecutionAuthorityHash) {
    if (!verifyDynamicFormalExecutionAuthority(report?.dynamicFormalExecutionAuthority)
      || report.dynamicFormalExecutionAuthority.dynamicFormalExecutionAuthorityHash
        !== dynamicFormalExecutionAuthorityHash) {
      blockers.push('native_research_worker_dynamic_formal_authority_invalid');
    }
  } else if (report?.dynamicFormalExecutionAuthority != null) {
    blockers.push('native_research_worker_dynamic_formal_authority_unexpected');
  }
  if (report?.status !== 'native_research_workers_verified') blockers.push('native_research_workers_not_verified');
  if (Array.isArray(report?.blockers) && report.blockers.length) blockers.push('native_research_worker_execution_report_has_blockers');
  const receipts = Array.isArray(report?.workerReceipts) ? report.workerReceipts : [];
  if (!Array.isArray(report?.workerReceipts)) blockers.push('native_research_worker_receipts_invalid');
  const verifiedHashes = [];
  for (const receipt of receipts) {
    if (computeReceiptHash(receipt) !== receipt?.nativeResearchWorkerExecutionReceiptHash) {
      blockers.push(`native_research_worker_receipt_hash_invalid:${receipt?.workerId || 'missing'}`);
    }
    if (receipt?.resultHash !== hashPaperRecord('NativeResearchWorkerResult', receipt?.result)) {
      blockers.push(`native_research_worker_result_hash_invalid:${receipt?.workerId || 'missing'}`);
    }
    if (receipt?.paperId !== report?.paperId || receipt?.taskKey !== report?.taskKey
      || receipt?.planHash !== report?.planHash || receipt?.engineHash !== report?.engineHash
      || receipt?.theoremSpecificationHash !== report?.theoremSpecificationHash) {
      blockers.push(`native_research_worker_report_binding_invalid:${receipt?.workerId || 'missing'}`);
    }
    if (receipt?.status !== 'native_research_worker_execution_verified'
      || receipt?.academicEvidenceEligible !== true || receipt?.sourceMutationDetected === true) {
      blockers.push(`native_research_worker_receipt_not_verified:${receipt?.workerId || 'missing'}`);
    }
    if (receipt?.nativeResearchWorkerExecutionReceiptHash) {
      verifiedHashes.push(receipt.nativeResearchWorkerExecutionReceiptHash);
    }
  }
  if (Number(report?.plannedResearchWorkerCount) !== receipts.length
    || Number(report?.executedResearchWorkerCount) !== receipts.length
    || Number(report?.verifiedAcademicEvidenceWorkerCount) !== receipts.length
    || JSON.stringify(report?.workerReceiptHashes || []) !== JSON.stringify(verifiedHashes)) {
    blockers.push('native_research_worker_execution_report_counts_invalid');
  }
  const formalReceipts = receipts.filter((receipt) => receipt?.workerType === 'formal_verifier_lake');
  if (requireFormalWorkers && !formalReceipts.length) blockers.push('formal_lake_worker_receipt_required');
  if (requireFormalWorkers && (report?.executeRequested !== true
    || JSON.stringify(report?.workerTypeFilter) !== JSON.stringify(['formal_verifier_lake']))) {
    blockers.push('formal_verification_worker_scope_invalid');
  }
  if (requireFormalWorkers && receipts.some((receipt) => receipt?.workerType !== 'formal_verifier_lake')) {
    blockers.push('formal_verification_scope_contains_non_formal_worker');
  }
  for (const receipt of formalReceipts) {
    if (receipt?.result?.status !== 'formal_claim_verified'
      || receipt?.result?.replayReceipt?.status !== 'formal_claim_replay_verified'
      || !receipt?.result?.formalCertificateReplayReceiptHash) {
      blockers.push(`formal_lake_worker_receipt_incomplete:${receipt?.workerId || 'missing'}`);
    }
    const workerAuthorityMismatch = dynamicFormalExecutionAuthorityHash
      ? receipt?.dynamicFormalExecutionAuthorityHash
          !== dynamicFormalExecutionAuthorityHash
        || receipt?.result?.dynamicFormalExecutionAuthority
          ?.dynamicFormalExecutionAuthorityHash !== dynamicFormalExecutionAuthorityHash
      : receipt?.dynamicFormalExecutionAuthorityHash != null
        || receipt?.result?.dynamicFormalExecutionAuthority != null;
    if (workerAuthorityMismatch) {
      blockers.push(`formal_lake_worker_dynamic_formal_authority_mismatch:${receipt?.workerId || 'missing'}`);
    }
    if (dynamicFormalExecutionAuthorityHash) {
      const authority = report.dynamicFormalExecutionAuthority;
      if (!verifyFormalExecutionSnapshotReceipt(
        receipt?.result?.initialFormalExecutionSnapshotReceipt,
        {
          formalProjectClosureHash: authority.formalProjectClosureHash,
          formalProjectManifestHash: authority.formalProjectManifestHash,
        },
      ) || !verifyFormalExecutionSnapshotReceipt(
        receipt?.result?.finalFormalExecutionSnapshotReceipt,
        {
          formalProjectClosureHash: authority.formalProjectClosureHash,
          formalProjectManifestHash: authority.formalProjectManifestHash,
        },
      )) {
        blockers.push(`formal_lake_worker_execution_snapshot_invalid:${receipt?.workerId || 'missing'}`);
      }
      if (receipt?.result?.executionIdentity?.containerImageDigest
          !== authority.formalSandboxRuntimeImageDigest
        || receipt?.result?.replayReceipt?.executionIdentity?.containerImageDigest
          !== authority.formalSandboxRuntimeImageDigest
        || receipt?.result?.isolation?.immutableWorkRootVerified !== true) {
        blockers.push(`formal_lake_worker_sandbox_identity_mismatch:${receipt?.workerId || 'missing'}`);
      }
      const seal = receipt?.result?.formalProjectSnapshotSealReceipt;
      const { formalProjectSnapshotSealReceiptHash, ...sealPayload } = seal || {};
      if (!seal || formalProjectSnapshotSealReceiptHash
          !== hashRecord('FormalProjectSnapshotSealReceipt', sealPayload)
        || receipt?.result?.formalProjectSnapshotSealReceiptHash
          !== formalProjectSnapshotSealReceiptHash
        || seal.writableFileCount !== 0 || seal.writableDirectoryCount !== 0) {
        blockers.push(`formal_lake_worker_inner_snapshot_not_sealed:${receipt?.workerId || 'missing'}`);
      }
    }
    const readableProofVerification = independentlyVerifyFormalReadableProofWorkerResult(
      receipt?.result,
      { required: false },
    );
    blockers.push(...readableProofVerification.blockers.map((blocker) => (
      `formal_readable_proof:${receipt?.workerId || 'missing'}:${blocker}`
    )));
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze([...new Set(blockers)]) });
}
export function bindFormalReviewsToWorkers({
  workers = [],
  formalReviewEnvelope = null,
  theoremSpecification = null,
  paperId = null,
  canonicalClaimRegistry = null,
  workerPlanHash = null,
} = {}) {
  const specificationRequired = theoremSpecification !== null && theoremSpecification !== undefined;
  const specificationVerification = specificationRequired
    ? verifyTheoremSpecification(theoremSpecification, { paperId })
    : Object.freeze({ valid: false, blockers: Object.freeze([]) });
  const envelopeBlockers = formalReviewEnvelopeBlockers(formalReviewEnvelope, {
    paperId,
    manuscriptHash: canonicalClaimRegistry?.manuscriptHash || null,
    workerPlanHash,
    formalClaimUniverseHash: canonicalClaimRegistry?.formalClaimUniverseHash || null,
    canonicalClaimRegistryHash: canonicalClaimRegistry?.canonicalClaimRegistryHash || null,
    theoremSpecificationHash: specificationRequired && specificationVerification.valid
      ? theoremSpecification.theoremSpecificationHash
      : undefined,
  });
  const reviewByClaim = new Map((!envelopeBlockers.length && Array.isArray(formalReviewEnvelope?.reviews) ? formalReviewEnvelope.reviews : [])
    .map((review) => [String(review?.claimId || ''), review]));
  const specificationClaims = new Map((specificationVerification.valid ? theoremSpecification.claims : [])
    .map((claim) => [String(claim.claimId || ''), claim]));
  const bindingBlockers = [
    ...envelopeBlockers,
    ...specificationVerification.blockers.map((blocker) => `formal_theorem_specification:${blocker}`),
    ...(specificationVerification.valid
      && theoremSpecification.formalClaimUniverseHash !== canonicalClaimRegistry?.formalClaimUniverseHash
      ? ['formal_theorem_specification_claim_universe_mismatch'] : []),
  ];
  if (specificationVerification.valid && theoremSpecification.proposalClaimLineageRequired === true) {
    const proposalBindingVerification = verifyProposalClaimToTheoremBinding(
      formalReviewEnvelope?.proposalClaimToTheoremBinding,
      {
        paperId,
        theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
        approvedProposalSeedBindingHash: theoremSpecification.approvedProposalSeedBindingHash,
        proposalSeedContractBundleHash: theoremSpecification.proposalSeedContractBundleHash,
        claimAuthorityType: theoremSpecification.claimAuthorityType,
        claimAuthorityBindingHash: theoremSpecification.claimAuthorityBindingHash,
        claimAuthorityBundleHash: theoremSpecification.claimAuthorityBundleHash,
        reviewAgentReceiptHash: formalReviewEnvelope?.reviewAgentReceiptHash,
        reviewerPrincipalId: formalReviewEnvelope?.reviewerPrincipalId,
        theoremSpecification,
        reviews: formalReviewEnvelope?.reviews,
      },
    );
    bindingBlockers.push(...proposalBindingVerification.blockers.map((blocker) => `formal_proposal_lineage:${blocker}`));
    if (formalReviewEnvelope?.proposalClaimToTheoremBindingHash
      !== proposalBindingVerification.proposalClaimToTheoremBindingHash) {
      bindingBlockers.push('formal_proposal_lineage_envelope_hash_mismatch');
    }
  }
  const boundWorkers = workers.map((worker) => {
    if (worker.type !== 'formal_verifier_lake') return worker;
    const claimBindings = (Array.isArray(worker.parameters?.claimBindings) ? worker.parameters.claimBindings : []).map((binding) => {
      const canonicalClaim = canonicalClaimRegistry?.byClaimId?.get(String(binding?.claimId || '')) || null;
      const specificationClaim = specificationClaims.get(String(binding?.claimId || '')) || null;
      const review = reviewByClaim.get(String(binding?.claimId || ''));
      if (!canonicalClaim) {
        bindingBlockers.push(`formal_claim_canonical_registry_binding_missing:${binding?.claimId || 'missing'}`);
        return binding;
      }
      if (!review) {
        bindingBlockers.push(`formal_semantic_review_missing:${binding?.claimId || 'missing'}`);
        return binding;
      }
      const obligationMapping = normalizeFormalProofObligationMappings({
        proofObligationContracts: specificationClaim?.proofObligationContracts
          || binding?.proofObligationContracts,
        proofObligations: specificationClaim?.proofObligations
          || binding?.proofObligations || binding?.obligationNames,
        proofObligationMappings: binding?.proofObligationMappings,
        theoremName: binding?.theoremName,
      });
      if (!obligationMapping.valid) {
        bindingBlockers.push(...obligationMapping.blockers
          .map((blocker) => `formal_theorem_obligation_mapping:${binding?.claimId || 'missing'}:${blocker}`));
      }
      if (binding?.proofObligationContracts
        && JSON.stringify(binding.proofObligationContracts)
          !== JSON.stringify(specificationClaim?.proofObligationContracts || [])) {
        bindingBlockers.push(`formal_theorem_obligation_contract_mismatch:${binding?.claimId || 'missing'}`);
      }
      const specificationBindingValid = !specificationRequired || (specificationClaim
        && binding?.theoremSpecificationHash === theoremSpecification?.theoremSpecificationHash
        && binding?.theoremSpecificationClaimHash === specificationClaim.theoremSpecificationClaimHash
        && normalizedText(specificationClaim.statement) === normalizedText(canonicalClaim.text)
        && specificationClaim.manuscriptSource?.path === canonicalClaim.manuscriptPath
        && specificationClaim.manuscriptSource?.byteStart === canonicalClaim.manuscriptByteStart
        && specificationClaim.manuscriptSource?.byteEnd === canonicalClaim.manuscriptByteEnd
        && specificationClaim.manuscriptSource?.contentHash === canonicalClaim.manuscriptContentHash
        && specificationClaim.manuscriptSource?.formalClaimUniverseEntryHash === canonicalClaim.formalClaimUniverseEntryHash
        && JSON.stringify([...(specificationClaim.proofObligations || [])].map(String).sort())
          === JSON.stringify([...(binding.proofObligations || binding.obligationNames || [])].map(String).sort())
        && obligationMapping.valid);
      const dynamicFormalAuthority = specificationClaim?.proposalClaimSource
        ?.dynamicFormalClaimSeedHash
        ? specificationClaim.proposalClaimSource
        : null;
      const dynamicFormalBindingValid = !dynamicFormalAuthority || (
        binding?.theoremName === dynamicFormalAuthority.leanDeclarationName
        && binding?.expectedTypeHash === dynamicFormalAuthority.leanNormalizedTypeHash
      );
      if (!specificationBindingValid) {
        bindingBlockers.push(`formal_theorem_specification_binding_mismatch:${binding?.claimId || 'missing'}`);
        return binding;
      }
      if (!dynamicFormalBindingValid) {
        bindingBlockers.push(`formal_dynamic_claim_type_binding_mismatch:${binding?.claimId || 'missing'}`);
        return binding;
      }
      const exactReviewFields = [
        ['theoremName', binding.theoremName],
        ['theoremTypeHash', binding.expectedTypeHash],
        ['sourceStatementHash', binding.sourceStatementHash],
        ['manuscriptClaimHash', canonicalClaim.manuscriptClaimHash],
      ];
      const mismatches = exactReviewFields.filter(([field, value]) => !value || review?.[field] !== value);
      if (mismatches.length || review.status !== 'formal_semantic_review_verified'
        || review.semanticEquivalenceVerified !== true || review.verdict !== 'equivalent') {
        bindingBlockers.push(`formal_semantic_review_binding_mismatch:${binding?.claimId || 'missing'}`);
        return binding;
      }
      const reviewPayload = {
        version: 2, kind: 'FormalSemanticReviewReceipt', paperId, claimId: binding.claimId,
        theoremName: binding.theoremName,
        reviewEnvelopeHash: formalReviewEnvelope.formalSemanticReviewEnvelopeHash,
        theoremSpecificationHash: specificationClaim ? theoremSpecification.theoremSpecificationHash : null,
        theoremSpecificationClaimHash: specificationClaim?.theoremSpecificationClaimHash || null,
        proposalClaimToTheoremBindingHash:
          formalReviewEnvelope.proposalClaimToTheoremBindingHash || null,
        proposalClaimRecordHash: specificationClaim?.proposalClaimSource?.proposalClaimRecordHash || null,
        reviewerId: formalReviewEnvelope.reviewerPrincipalId,
        authorId: formalReviewEnvelope.authorPrincipalId,
        semanticEquivalenceVerified: review.semanticEquivalenceVerified === true, verdict: review.verdict || null,
      };
      const formalClaimContract = buildFormalClaimContract({
        claimId: binding.claimId,
        claimText: canonicalClaim.text,
        sourceLocator: canonicalClaim.sourceLocator,
        theoremName: binding.theoremName,
        theoremTypeHash: binding.expectedTypeHash,
        sourceStatementHash: binding.sourceStatementHash,
        proofObligations: binding.proofObligations || binding.obligationNames,
        proofObligationContracts: obligationMapping.contracts,
        proofObligationMappings: obligationMapping.mappings,
        manuscriptSourceIdentity: {
          path: canonicalClaim.manuscriptPath,
          byteStart: canonicalClaim.manuscriptByteStart,
          byteEnd: canonicalClaim.manuscriptByteEnd,
          contentHash: canonicalClaim.manuscriptContentHash,
          fileHash: canonicalClaim.manuscriptFileHash,
        },
        theoremSpecificationHash: specificationClaim ? theoremSpecification.theoremSpecificationHash : null,
        theoremSpecificationClaimHash: specificationClaim?.theoremSpecificationClaimHash || null,
        dynamicFormalClaimAuthority: dynamicFormalAuthority,
        semanticReview: {
          status: review.status,
          reviewerId: formalReviewEnvelope.reviewerPrincipalId,
          authorId: formalReviewEnvelope.authorPrincipalId,
          semanticEquivalenceVerified: review.semanticEquivalenceVerified,
          reviewReceiptHash: hashPaperRecord('FormalSemanticReviewReceipt', reviewPayload),
          reviewEnvelopeHash: formalReviewEnvelope.formalSemanticReviewEnvelopeHash,
          reviewNodeId: formalReviewEnvelope.reviewNodeId,
          reviewAttemptId: formalReviewEnvelope.reviewAttemptId,
          reviewAgentReceiptHash: formalReviewEnvelope.reviewAgentReceiptHash,
          authorNodeId: formalReviewEnvelope.authorNodeId,
          authorAgentReceiptHash: formalReviewEnvelope.authorAgentReceiptHash,
          reviewedManuscriptHash: formalReviewEnvelope.manuscriptHash,
          reviewedWorkerPlanHash: formalReviewEnvelope.workerPlanHash,
          theoremSpecificationHash: specificationClaim ? theoremSpecification.theoremSpecificationHash : null,
          theoremSpecificationClaimHash: specificationClaim?.theoremSpecificationClaimHash || null,
          proposalClaimToTheoremBindingHash:
            formalReviewEnvelope.proposalClaimToTheoremBindingHash || null,
          proposalClaimRecordHash: specificationClaim?.proposalClaimSource?.proposalClaimRecordHash || null,
        },
      });
      if (formalClaimContract.status !== 'formal_claim_contract_verified') {
        bindingBlockers.push(...formalClaimContract.blockers.map((item) => `${binding.claimId}:${item}`));
      }
      return {
        ...binding,
        claimText: canonicalClaim.text,
        sourceLocator: canonicalClaim.sourceLocator,
        manuscriptSource: {
          path: canonicalClaim.manuscriptPath,
          byteStart: canonicalClaim.manuscriptByteStart,
          byteEnd: canonicalClaim.manuscriptByteEnd,
          contentHash: canonicalClaim.manuscriptContentHash,
        },
        manuscriptClaimHash: formalClaimContract.manuscriptClaimHash,
        theoremSpecificationHash: specificationClaim ? theoremSpecification.theoremSpecificationHash : null,
        theoremSpecificationClaimHash: specificationClaim?.theoremSpecificationClaimHash || null,
        proposalClaimToTheoremBindingHash:
          formalReviewEnvelope.proposalClaimToTheoremBindingHash || null,
        proposalClaimRecordHash: specificationClaim?.proposalClaimSource?.proposalClaimRecordHash || null,
        proofObligationContracts: obligationMapping.contracts,
        proofObligationMappings: obligationMapping.mappings,
        ...(dynamicFormalAuthority ? {
          dynamicFormalClaimSeedHash: dynamicFormalAuthority.dynamicFormalClaimSeedHash,
          allowedImports: dynamicFormalAuthority.allowedImports,
        } : {}),
        formalClaimContract,
      };
    });
    return { ...worker, parameters: { ...(worker.parameters || {}), claimBindings } };
  });
  return Object.freeze({ workers: boundWorkers, blockers: [...new Set(bindingBlockers)] });
}

export async function runNativeResearchWorkers({
  root,
  sourceRoot,
  runtimeRoot,
  paperTask,
  execute = false,
  jobReceiptStore = null,
  artifactRepositoryFactory = null,
  formalReviewEnvelope = null,
  theoremSpecification = null,
  campaignEvidenceContext = null,
  workerTypes = null,
  trustedFormalSandboxRuntime = null,
  dynamicFormalExecutionAuthority = null,
  dynamicFormalExecutionEnvironment = process.env,
} = {}) {
  const planPath = sourceRoot ? path.join(sourceRoot, 'RESEARCH_WORKER_PLAN.json') : null;
  const plan = planPath ? await readJsonIfExists(planPath) : null;
  const reportBlockers = [];
  if (!sourceRoot || !planPath) reportBlockers.push('research_worker_source_workspace_missing');
  if (!plan) reportBlockers.push('research_worker_plan_missing');
  if (plan && (plan.version !== 1 || plan.kind !== 'NativeResearchWorkerPlan')) {
    reportBlockers.push('research_worker_plan_schema_invalid');
  }
  if (plan && plan.paperId !== paperTask?.paperId) reportBlockers.push('research_worker_plan_paper_id_mismatch');
  if (plan && plan.taskKey !== paperTask?.taskKey) reportBlockers.push('research_worker_plan_task_key_mismatch');
  const planRecord = planPath && plan ? await fileRecord(root, planPath, 'native_research_worker_plan') : null;
  const canonicalClaimRegistry = plan
    ? canonicalClaimsFromWorkerPlan({ sourceRoot, paperTask, plan })
    : null;
  const declaredWorkers = Array.isArray(plan?.workers) ? plan.workers : [];
  const selectedWorkerTypes = workerTypes === null
    ? null
    : new Set((Array.isArray(workerTypes) ? workerTypes : []).map(String));
  if (selectedWorkerTypes && [...selectedWorkerTypes].some((workerType) => !WORKER_TYPE_SET.has(workerType))) {
    reportBlockers.push('native_research_worker_type_filter_invalid');
  }
  const selectedWorkers = selectedWorkerTypes
    ? declaredWorkers.filter((worker) => selectedWorkerTypes.has(String(worker?.type || '')))
    : declaredWorkers;
  const bound = bindFormalReviewsToWorkers({
    workers: selectedWorkers,
    formalReviewEnvelope,
    theoremSpecification,
    paperId: paperTask?.paperId || null,
    canonicalClaimRegistry,
    workerPlanHash: planRecord?.hash || null,
  });
  const workers = bound.workers;
  if (workers.some((worker) => worker.type === 'formal_verifier_lake')) {
    reportBlockers.push(...(canonicalClaimRegistry?.blockers || ['canonical_claim_registry_required']), ...bound.blockers);
  }
  if (dynamicFormalExecutionAuthority
    && !verifyDynamicFormalExecutionAuthority(dynamicFormalExecutionAuthority)) {
    reportBlockers.push('native_research_worker_dynamic_formal_authority_invalid');
  }
  if (plan && (!declaredWorkers.length || declaredWorkers.length > 16)) reportBlockers.push('research_worker_plan_worker_count_invalid');
  if (selectedWorkerTypes && !workers.length) reportBlockers.push('native_research_worker_type_filter_empty');
  const workerIds = declaredWorkers.map((worker) => safeWorkerId(worker.id));
  if (workerIds.some((id) => !id)) reportBlockers.push('research_worker_id_invalid');
  if (new Set(workerIds.filter(Boolean)).size !== workerIds.filter(Boolean).length) reportBlockers.push('research_worker_id_duplicate');
  const engineFiles = [
    fileURLToPath(import.meta.url),
    fileURLToPath(new URL('./native-research-worker-execution.mjs', import.meta.url)),
    fileURLToPath(new URL('./formal-verifier.mjs', import.meta.url)),
    fileURLToPath(new URL('./lake-formal-verifier.mjs', import.meta.url)),
    fileURLToPath(new URL('../runtime/os-sandboxed-worker-runner.mjs', import.meta.url)),
  ];
  const engineHash = hashPaperRecord('NativeResearchWorkerEngine', {
    files: await Promise.all(engineFiles.map(async (file) => ({ file: path.basename(file), hash: await sha256File(file) }))),
    workerTypes: NATIVE_RESEARCH_WORKER_TYPES,
  });
  const outputDir = runtimeRoot && paperTask?.paperId
    ? path.join(runtimeRoot, 'research-workers', paperTask.paperId)
    : null;
  if (!outputDir || !pathWithin(runtimeRoot, outputDir)) reportBlockers.push('research_worker_runtime_output_invalid');
  if (execute && !artifactRepositoryFactory) reportBlockers.push('artifact_repository_factory_not_injected');
  if (execute && outputDir) {
    const prospective = inspectScopedWriteTargetSync({ scopeRoot: runtimeRoot, candidate: path.join(outputDir, '.scope-check') });
    if (prospective.status !== 'scoped_write_target_verified') {
      reportBlockers.push('research_worker_runtime_output_unsafe', ...prospective.blockers);
    } else {
      await fs.mkdir(outputDir, { recursive: true });
      const outputIdentity = inspectScopedPathSync({ scopeRoot: runtimeRoot, candidate: outputDir, expect: 'directory', forbidHardlinks: false });
      if (outputIdentity.status !== 'scoped_file_identity_verified') reportBlockers.push('research_worker_runtime_output_unsafe', ...outputIdentity.blockers);
    }
  }
  const artifactRepository = outputDir && artifactRepositoryFactory && !reportBlockers.includes('research_worker_runtime_output_unsafe')
    ? artifactRepositoryFactory(outputDir)
    : null;
  const receipts = [];
  for (const worker of workers) {
    const blockers = [];
    const id = safeWorkerId(worker.id);
    if (!id) blockers.push('research_worker_id_invalid');
    if (!WORKER_TYPE_SET.has(worker.type)) blockers.push('native_research_worker_type_not_allowed');
    if (worker.evidenceClass !== 'research_evidence') blockers.push('research_worker_evidence_class_invalid');
    if (worker.syntheticInput !== false) blockers.push('research_worker_synthetic_input_not_eligible');
    if (worker.outcomesPreprogrammed !== false) blockers.push('research_worker_preprogrammed_outcomes_not_eligible');
    if (!Array.isArray(worker.claimIds) || !worker.claimIds.length) blockers.push('research_worker_claim_ids_missing');
    const inputValidation = await validateInputs({ root, sourceRoot, worker });
    blockers.push(...inputValidation.blockers);
    const campaignExecutionScopeHash = campaignEvidenceContext?.researchNodeId
      ? hashPaperRecord('CampaignResearchWorkerExecutionScope', {
        campaignId: campaignEvidenceContext.campaignId || null,
        paperId: paperTask?.paperId || null,
        researchNodeId: campaignEvidenceContext.researchNodeId,
        researchAttemptId: campaignEvidenceContext.researchAttemptId || null,
        researchLeaseGeneration: campaignEvidenceContext.researchLeaseGeneration || null,
        verificationIteration: Number.isSafeInteger(campaignEvidenceContext.verificationIteration)
          ? campaignEvidenceContext.verificationIteration
          : null,
      })
      : null;
    const jobId = `research-worker:${paperTask?.paperId || 'paper'}:${id || 'invalid'}${campaignExecutionScopeHash ? `:${campaignExecutionScopeHash.slice(-16)}` : ''}`;
    let attempt = null;
    if (execute && jobReceiptStore && id) {
      jobReceiptStore.createJob({
        jobId,
        deduplicationKey: `${paperTask?.paperId}:${planRecord?.hash}:${formalReviewEnvelope?.formalSemanticReviewEnvelopeHash || 'no-review'}:${id}:${campaignExecutionScopeHash || 'standalone'}`,
        paperId: paperTask?.paperId,
        kind: `research-worker:${worker.type}`,
        priority: Number(worker.priority || 100),
        workerDefinitionHash: hashPaperRecord('NativeResearchWorkerDefinition', normalizedWorkerDefinition(worker)),
      });
      const lease = jobReceiptStore.acquireLease({ jobId, workerId: id, leaseSeconds: NATIVE_RESEARCH_WORKER_JOB_LEASE_SECONDS });
      if (!lease) blockers.push('research_worker_job_lease_unavailable');
      else attempt = jobReceiptStore.recordAttempt({ jobId, workerId: id, leaseGeneration: lease.leaseGeneration });
    }
    const { result, sourceMerkleHashBefore, sourceMerkleHashAfter } = await withJobAttemptLeaseHeartbeat(
      jobReceiptStore, attempt, async (signal) => {
        const sourceMerkleHashBefore = sourceRoot ? directoryMerkleHash(sourceRoot) : null;
        const result = blockers.length
          ? { status: 'native_research_worker_blocked', blockers }
          : await executeNativeResearchWorker(worker, inputValidation.records, {
            sourceRoot,
            signal,
            trustedFormalSandboxRuntime,
            dynamicFormalExecutionAuthority,
            dynamicFormalExecutionEnvironment,
          });
        const sourceMerkleHashAfter = sourceRoot ? directoryMerkleHash(sourceRoot) : null;
        return { result, sourceMerkleHashBefore, sourceMerkleHashAfter };
      },
    );
    const sourceMutationDetected = sourceMerkleHashBefore !== sourceMerkleHashAfter;
    if (sourceMutationDetected) blockers.push('native_research_worker_source_mutation_detected');
    blockers.push(...(result.blockers || []));
    blockers.push(...formalAcademicPromotionBlockers(worker, result));
    const workerDefinitionHash = hashPaperRecord(
      'NativeResearchWorkerDefinition',
      normalizedWorkerDefinition(worker),
    );
    const resultHash = hashPaperRecord('NativeResearchWorkerResult', result);
    const baseReceipt = {
      version: 1,
      kind: 'NativeResearchWorkerExecutionReceipt',
      paperId: paperTask?.paperId || null,
      taskKey: paperTask?.taskKey || null,
      workerId: id,
      workerType: worker.type || null,
      jobId,
      attemptId: attempt?.attemptId || null,
      leaseGeneration: attempt?.leaseGeneration || null,
      status: blockers.length
        ? 'native_research_worker_execution_blocked'
        : 'native_research_worker_execution_verified',
      planHash: planRecord?.hash || null,
      theoremSpecificationHash: theoremSpecification?.theoremSpecificationHash || null,
      dynamicFormalExecutionAuthorityHash: worker.type === 'formal_verifier_lake'
        ? dynamicFormalExecutionAuthority?.dynamicFormalExecutionAuthorityHash || null
        : null,
      workerDefinitionHash,
      engineHash,
      inputs: inputValidation.records.map(({ absolutePath: _absolutePath, ...record }) => record),
      sourceSnapshotHash: hashPaperRecord('NativeResearchWorkerInputSnapshot', inputValidation.records.map(({ absolutePath: _absolutePath, ...record }) => record)),
      sourceMerkleHashBefore,
      sourceMerkleHashAfter,
      sourceMutationDetected,
      claimIds: Array.isArray(worker.claimIds) ? worker.claimIds.map(String) : [],
      result,
      resultHash,
      academicEvidenceEligible: blockers.length === 0,
      blockers: [...new Set(blockers)],
      safety: {
        boundedNativeWorker: true,
        allowlistedWorkerType: WORKER_TYPE_SET.has(worker.type),
        networkAccess: false,
        subprocessExecution: ['formal_verifier_lean', 'formal_verifier_lake'].includes(worker.type),
        subprocessBoundedByWorkerRunnerPort: ['formal_verifier_lean', 'formal_verifier_lake'].includes(worker.type),
        sourceMutation: sourceMutationDetected,
        writesRuntimeOnly: Boolean(execute),
        externalActionPerformed: false,
      },
      executedAt: execute ? new Date().toISOString() : null,
    };
    if (execute) {
      let receipt = sealReceiptHash(baseReceipt, { hashField: 'nativeResearchWorkerExecutionReceiptHash' });
      if (jobReceiptStore && attempt) {
        const completed = receipt.status === 'native_research_worker_execution_verified'
          ? jobReceiptStore.completeJob({ jobId, attemptId: attempt.attemptId, workerId: attempt.workerId, leaseGeneration: attempt.leaseGeneration, receipt })
          : jobReceiptStore.failJob({ jobId, attemptId: attempt.attemptId, workerId: attempt.workerId, leaseGeneration: attempt.leaseGeneration, failureClass: 'worker_verification_failed', retryable: false, receipt });
        receipt = { ...receipt, ledgerReceiptId: completed.ledgerReceipt?.receiptId || completed.result_receipt_id || null };
      }
      if (artifactRepository && id) {
        await artifactRepository.writeJson(path.join(outputDir, `${id}.receipt.json`), receipt, {
          role: 'native_research_worker_execution_receipt',
        });
      }
      receipts.push(receipt);
    } else {
      const persisted = outputDir && id
        ? await readJsonIfExists(path.join(outputDir, `${id}.receipt.json`))
        : null;
      const expected = {
        ...baseReceipt,
        attemptId: persisted?.attemptId || null,
        leaseGeneration: persisted?.leaseGeneration || null,
        executedAt: persisted?.executedAt || null,
      };
      const persistedBlockers = validatePersistedReceipt({ persisted, expected });
      receipts.push(persistedBlockers.length
        ? {
          ...expected,
          status: 'native_research_worker_execution_verification_blocked',
          academicEvidenceEligible: false,
          blockers: [...new Set([...expected.blockers, ...persistedBlockers])],
          nativeResearchWorkerExecutionReceiptHash: persisted?.nativeResearchWorkerExecutionReceiptHash || null,
        }
        : persisted);
    }
  }
  const verifiedReceipts = receipts.filter((receipt) => (
    receipt.status === 'native_research_worker_execution_verified'
    && receipt.academicEvidenceEligible === true
  ));
  const report = {
    version: 1,
    kind: 'NativeResearchWorkerExecutionReport',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: reportBlockers.length || verifiedReceipts.length !== workers.length
      ? 'native_research_workers_blocked'
      : 'native_research_workers_verified',
    executeRequested: Boolean(execute),
    planPath: planRecord?.path || null,
    planHash: planRecord?.hash || null,
    theoremSpecificationHash: theoremSpecification?.theoremSpecificationHash || null,
    theoremSpecificationClaimHashes: Object.freeze((theoremSpecification?.claims || [])
      .map((claim) => claim.theoremSpecificationClaimHash)),
    dynamicFormalExecutionAuthority,
    engineHash,
    workerTypeFilter: selectedWorkerTypes ? [...selectedWorkerTypes].sort() : null,
    plannedResearchWorkerCount: workers.length,
    executedResearchWorkerCount: verifiedReceipts.length,
    verifiedAcademicEvidenceWorkerCount: verifiedReceipts.length,
    workerReceipts: receipts,
    workerReceiptHashes: verifiedReceipts.map((receipt) => receipt.nativeResearchWorkerExecutionReceiptHash),
    blockers: [...new Set([
      ...reportBlockers,
      ...receipts.flatMap((receipt) => receipt.blockers || []),
    ])],
    safety: {
      allowlistedWorkerTypes: [...NATIVE_RESEARCH_WORKER_TYPES],
      networkAccess: false,
      subprocessExecution: workers.some((worker) => ['formal_verifier_lean', 'formal_verifier_lake'].includes(worker.type)),
      subprocessBoundedByWorkerRunnerPort: true,
      sourceMutation: receipts.some((receipt) => receipt.sourceMutationDetected === true),
      writesRuntimeOnly: Boolean(execute),
      externalActionPerformed: false,
    },
  };
  const hashed = {
    ...report,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord('NativeResearchWorkerExecutionReport', report),
  };
  if (execute && outputDir && artifactRepository) {
    await artifactRepository.writeJson(path.join(outputDir, 'RESEARCH_WORKER_EXECUTION_REPORT.json'), hashed, {
      role: 'native_research_worker_execution_report',
    });
  }
  return hashed;
}
