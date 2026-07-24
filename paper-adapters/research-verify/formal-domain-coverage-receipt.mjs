import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  FORMAL_DOMAIN_PROFILE_REGISTRY,
  REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
  formalDomainProfileFor,
  verifyFormalDomainProfileRegistry,
} from '../../paper-domain/research/formal-domain-profile-registry.mjs';
import {
  verifyFormalProofSearchPlan,
  verifyTypedTheoremObligationBundle,
} from '../../paper-domain/research/typed-theorem-proof-search-contract.mjs';
import {
  verifyDynamicFormalExecutionAuthority,
} from './dynamic-formal-project-closure-readiness.mjs';
import {
  verifyFormalProofSearchOperationReceipt,
} from './formal-proof-search-operations-executor.mjs';

const KEYS = Object.freeze([
  'blockers', 'dynamicFormalExecutionAuthorityHash', 'evidencePackages',
  'formalDomainCoverageReceiptHash', 'formalDomainProfileRegistryHash',
  'kind', 'profileEvidence', 'requiredProfileIds', 'status', 'version',
]);

function packageVerification(value) {
  const profile = formalDomainProfileFor(value?.profileId);
  const theoremSpecification = value?.theoremSpecification;
  const bundle = value?.typedTheoremObligationBundle;
  const plan = value?.formalProofSearchPlan;
  const candidate = value?.formalProofSearchCandidate;
  const operationReceipt = value?.formalProofSearchOperationReceipt;
  const obligation = bundle?.obligations?.length === 1 ? bundle.obligations[0] : null;
  const authority = operationReceipt?.dynamicFormalExecutionAuthority || null;
  const planVerification = verifyFormalProofSearchPlan(plan, { bundle });
  const operationVerification = verifyFormalProofSearchOperationReceipt(operationReceipt, {
    bundle,
    plan,
    candidate,
    expectedDynamicFormalExecutionAuthority: authority,
  });
  const valid = Boolean(profile
    && verifyTypedTheoremObligationBundle(bundle, { theoremSpecification })
    && planVerification.valid
    && plan?.candidates?.some((item) => JSON.stringify(item) === JSON.stringify(candidate))
    && operationVerification.valid
    && operationReceipt?.status === 'formal_proof_search_operations_verified'
    && operationReceipt?.machineSearchEstablished === true
    && operationReceipt?.replayMatched === true
    && verifyDynamicFormalExecutionAuthority(authority)
    && obligation?.leanTypeSourceHash === operationReceipt?.operationReceipts?.[0]?.goalBeforeHash
    && obligation?.typedTheoremDsl?.sourceLeanNormalizedTypeHash
      === profile.leanNormalizedTypeHash
    && obligation?.typedTheoremDsl?.typedTheoremDslHash === profile.typedTheoremDslHash
    && obligation?.typedTheoremDsl?.compiledLeanTypeSource === profile.leanTypeSource
    && JSON.stringify(obligation?.allowedImports) === JSON.stringify(profile.allowedImports));
  return Object.freeze({
    valid,
    profile,
    authority,
    summary: valid ? Object.freeze({
      profileId: profile.profileId,
      formalDomainProfileHash: profile.formalDomainProfileHash,
      typedTheoremObligationBundleHash: bundle.typedTheoremObligationBundleHash,
      formalProofSearchPlanHash: plan.formalProofSearchPlanHash,
      candidateId: candidate.candidateId,
      formalProofSearchOperationReceiptHash:
        operationReceipt.formalProofSearchOperationReceiptHash,
      selectedTacticExecutionReceiptHash:
        operationReceipt.selectedTacticExecutionReceiptHash,
      replayExecutionReceiptHash: operationReceipt.replayExecutionReceiptHash,
      dynamicFormalExecutionAuthorityHash: authority.dynamicFormalExecutionAuthorityHash,
    }) : null,
  });
}

export function buildFormalDomainCoverageReceipt({
  evidencePackages,
  registry = FORMAL_DOMAIN_PROFILE_REGISTRY,
} = {}) {
  const blockers = [];
  if (!verifyFormalDomainProfileRegistry(registry)) {
    blockers.push('formal_domain_coverage_registry_invalid');
  }
  const packages = Array.isArray(evidencePackages)
    ? Object.freeze([...evidencePackages]) : Object.freeze([]);
  const inspected = packages.map((value) => {
    try { return packageVerification(value); }
    catch {
      return Object.freeze({ valid: false, profile: null, authority: null, summary: null });
    }
  });
  const profileIds = packages.map((item) => item?.profileId).sort();
  if (JSON.stringify(profileIds) !== JSON.stringify(REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS)) {
    blockers.push('formal_domain_coverage_profile_set_incomplete');
  }
  if (inspected.some((item) => !item.valid)) {
    blockers.push('formal_domain_coverage_evidence_invalid');
  }
  const authorityHashes = new Set(inspected.map((item) => (
    item.authority?.dynamicFormalExecutionAuthorityHash || null
  )));
  if (authorityHashes.size !== 1 || authorityHashes.has(null)) {
    blockers.push('formal_domain_coverage_execution_authority_inconsistent');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const profileEvidence = Object.freeze(inspected.map((item) => item.summary).filter(Boolean)
    .sort((left, right) => left.profileId.localeCompare(right.profileId)));
  const payload = {
    version: 1,
    kind: 'FormalDomainCoverageReceipt',
    status: uniqueBlockers.length
      ? 'formal_domain_coverage_blocked' : 'formal_domain_coverage_verified',
    formalDomainProfileRegistryHash: registry?.formalDomainProfileRegistryHash || null,
    requiredProfileIds: REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
    dynamicFormalExecutionAuthorityHash:
      authorityHashes.size === 1 ? [...authorityHashes][0] : null,
    evidencePackages: packages,
    profileEvidence,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    formalDomainCoverageReceiptHash:
      hashRecord('FormalDomainCoverageReceipt', payload),
  });
}

export function verifyFormalDomainCoverageReceipt(receipt, {
  registry = FORMAL_DOMAIN_PROFILE_REGISTRY,
} = {}) {
  if (!receipt || JSON.stringify(Object.keys(receipt).sort())
    !== JSON.stringify([...KEYS].sort())) return false;
  let rebuilt = null;
  try {
    rebuilt = buildFormalDomainCoverageReceipt({
      evidencePackages: receipt.evidencePackages,
      registry,
    });
  } catch { return false; }
  return receipt.status === 'formal_domain_coverage_verified'
    && receipt.blockers.length === 0
    && JSON.stringify(rebuilt) === JSON.stringify(receipt);
}
