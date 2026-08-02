import {
  buildFormalDomainCoverageReceipt,
  verifyFormalDomainCoverageReceipt,
} from '../../paper-adapters/research-verify/formal-domain-coverage-receipt.mjs';
import {
  assertCurrentDynamicFormalExecutionAuthority,
  inspectConfiguredDynamicFormalExecutionAuthority,
} from '../../paper-adapters/research-verify/dynamic-formal-project-closure-readiness.mjs';
import {
  createFormalProofSearchOperationsExecutor,
} from '../../paper-adapters/research-verify/formal-proof-search-operations-executor.mjs';
import {
  configuredPinnedFormalSandboxRuntime,
} from '../../paper-adapters/research-verify/pinned-formal-sandbox-runtime-configuration.mjs';
import {
  FORMAL_DOMAIN_PROFILE_REGISTRY,
} from '../../paper-domain/research/formal-domain-profile-registry.mjs';
import { leanTypeIdentity } from '../../paper-domain/research/lean-type-identity.mjs';
import {
  createFormalProofSearchPlan,
  createTypedTheoremObligationBundle,
} from '../../paper-domain/research/typed-theorem-proof-search-contract.mjs';
import { createTheoremSpecification } from '../../paper-domain/research/theorem-specification.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const recordHash = (kind, profile) => hashRecord(kind, {
  formalDomainProfileHash: profile.formalDomainProfileHash,
  formalDomainProfileRegistryHash:
    FORMAL_DOMAIN_PROFILE_REGISTRY.formalDomainProfileRegistryHash,
});

export function buildFormalDomainQualificationTheoremSpecification(profile) {
  if (!FORMAL_DOMAIN_PROFILE_REGISTRY.profiles.some((candidate) => candidate === profile)) {
    throw new Error('formal_domain_qualification_profile_not_canonical');
  }
  const statement = `Kernel qualification diagnostic for ${profile.profileId}.`;
  const claimAuthorityBindingHash = recordHash(
    'FormalDomainQualificationClaimAuthorityBinding', profile,
  );
  const claimAuthorityBundleHash = recordHash(
    'FormalDomainQualificationClaimAuthorityBundle', profile,
  );
  const assumptions = Object.freeze([
    'Only the exact diagnostic Lean proposition is in scope.',
  ]);
  const quantifiers = Object.freeze([
    'Only the binders encoded in the canonical formal-domain profile are quantified.',
  ]);
  const negativeBoundaries = Object.freeze([
    'This diagnostic does not claim theorem discovery or domain completeness.',
  ]);
  const proofObligations = Object.freeze([
    'Elaborate the exact proposition in the pinned Mathlib closure without axioms and replay it in a fresh process.',
  ]);
  const manuscriptHash = recordHash('FormalDomainQualificationManuscript', profile);
  return createTheoremSpecification({
    paperId: 'formal-domain-production-qualification',
    campaignId: `formal-domain-qualification:${profile.profileId}`,
    sourceManuscriptPath: 'formal-domain-qualification.md',
    sourceManuscriptHash: manuscriptHash,
    formalClaimUniverseHash: recordHash('FormalDomainQualificationClaimUniverse', profile),
    claimAuthorityType: 'machine-policy-authorized',
    claimAuthorityBindingHash,
    claimAuthorityBundleHash,
    claims: [{
      claimKey: `formal-domain-qualification:${profile.profileId}`,
      title: `Formal domain qualification: ${profile.profileId}`,
      statement,
      assumptions,
      quantifiers,
      negativeBoundaries,
      proofObligations,
      evidenceObligations: [],
      manuscriptIntent: 'existing',
      manuscriptSource: {
        path: 'formal-domain-qualification.md',
        byteStart: 0,
        byteEnd: 1,
        contentHash: manuscriptHash,
        formalClaimUniverseEntryHash:
          recordHash('FormalDomainQualificationClaimUniverseEntry', profile),
      },
      proposalClaimSource: {
        claimAuthorityType: 'machine-policy-authorized',
        claimAuthorityBindingHash,
        claimAuthorityBundleHash,
        proposalClaimId: `formal-domain-qualification:${profile.profileId}`,
        proposalClaimText: statement,
        scientificClaimKey: `formal-domain-qualification:${profile.profileId}`,
        assumptions,
        quantifiers,
        negativeBoundaries,
        proofObligations,
        proposalClaimTextHash: hashBytes(Buffer.from(statement, 'utf8')),
        proposalClaimRecordHash:
          recordHash('FormalDomainQualificationProposalClaim', profile),
        proposalSeedContractBundleHash: null,
        approvedProposalSeedBindingHash: null,
        dynamicFormalClaimSeedHash:
          recordHash('FormalDomainQualificationDynamicClaimSeed', profile),
        leanDeclarationName: 'heptaFormalDomainQualification',
        leanTypeSource: profile.leanTypeSource,
        leanTypeSourceHash: hashBytes(Buffer.from(profile.leanTypeSource, 'utf8')),
        leanNormalizedTypeHash: leanTypeIdentity(profile.leanTypeSource).normalizedTypeHash,
        allowedImports: profile.allowedImports,
        formalClaimCapabilityScopeManifestHash:
          FORMAL_DOMAIN_PROFILE_REGISTRY.formalDomainProfileRegistryHash,
        formalClaimGeneratorReceiptHash:
          recordHash('FormalDomainQualificationClaimGeneratorReceipt', profile),
      },
    }],
  });
}

export async function runConfiguredFormalDomainQualification({
  dynamicFormalExecutionAuthority,
  environment = process.env,
  runtimeRoot = null,
  spawnSyncImpl = undefined,
  temporaryRoot = undefined,
  formalProofSearchOperationsExecutor = null,
} = {}) {
  const selectedRuntimeRoot = runtimeRoot
    || String(environment.HEPTA_PAPER_RUNTIME_ROOT || '').trim()
    || null;
  const authorityOptions = {
    environment,
    ...(selectedRuntimeRoot
      ? { runtimeRoot: selectedRuntimeRoot, activeProbe: false } : {}),
    ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
  };
  const discoveredAuthority = dynamicFormalExecutionAuthority
    || inspectConfiguredDynamicFormalExecutionAuthority({
      ...authorityOptions,
      activeProbe: true,
      publishActiveProbeReceipt: Boolean(selectedRuntimeRoot),
    }).authority;
  const current = assertCurrentDynamicFormalExecutionAuthority(
    discoveredAuthority,
    authorityOptions,
  ).authority;
  const trustedSandboxRuntime = configuredPinnedFormalSandboxRuntime({
    environment,
    allowSystemDefault: true,
  });
  if (!trustedSandboxRuntime
    || trustedSandboxRuntime.image !== current.formalSandboxRuntimeImage
    || trustedSandboxRuntime.imageDigest !== current.formalSandboxRuntimeImageDigest) {
    throw new Error('formal_domain_qualification_sandbox_authority_mismatch');
  }
  const executor = formalProofSearchOperationsExecutor
    || createFormalProofSearchOperationsExecutor({
      trustedSandboxRuntime,
      temporaryRoot,
      dynamicFormalExecutionAuthority: current,
      dynamicFormalExecutionEnvironment: environment,
      dynamicFormalExecutionSpawnSync: spawnSyncImpl,
    });
  const evidencePackages = [];
  for (const profile of FORMAL_DOMAIN_PROFILE_REGISTRY.profiles) {
    assertCurrentDynamicFormalExecutionAuthority(current, authorityOptions);
    const theoremSpecification = buildFormalDomainQualificationTheoremSpecification(profile);
    const typedTheoremObligationBundle =
      createTypedTheoremObligationBundle(theoremSpecification);
    const formalProofSearchPlan =
      createFormalProofSearchPlan(typedTheoremObligationBundle);
    const formalProofSearchCandidate = formalProofSearchPlan.candidates.find((candidate) => (
      candidate.strategy === profile.requiredProofSearchStrategy
    ));
    if (!formalProofSearchCandidate) {
      throw new Error('formal_domain_qualification_strategy_unavailable');
    }
    const formalProofSearchOperationReceipt = await executor.execute({
      theoremSpecification,
      bundle: typedTheoremObligationBundle,
      plan: formalProofSearchPlan,
      candidate: formalProofSearchCandidate,
    });
    evidencePackages.push(Object.freeze({
      profileId: profile.profileId,
      theoremSpecification,
      typedTheoremObligationBundle,
      formalProofSearchPlan,
      formalProofSearchCandidate,
      formalProofSearchOperationReceipt,
    }));
  }
  assertCurrentDynamicFormalExecutionAuthority(current, authorityOptions);
  const receipt = buildFormalDomainCoverageReceipt({ evidencePackages });
  if (!verifyFormalDomainCoverageReceipt(receipt)) {
    throw new Error(`formal_domain_qualification_failed:${receipt.blockers.join(',')}`);
  }
  return receipt;
}
