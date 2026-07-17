import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  fullResearchQualificationSigningPayloadHash,
  providerPrincipalIndependenceAttestationSigningPayloadHash,
  verifyFullResearchQualificationReceipt,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import {
  buildAutonomousResearchMachineIntake,
  buildAutonomousResearchRecurringGoldenTemplate,
  materializeAutonomousResearchRecurringGoldenIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  createAutonomousResearchReleaseBinding,
} from '../../paper-domain/automation/autonomous-research-release-binding-contract.mjs';

const ISSUED_AT = '2026-07-15T08:00:00.000Z';
const NOW = new Date('2026-07-15T09:00:00.000Z');
const HASH = (label) => hashRecord('FullResearchQualificationTestHash', { label });

function hashed(kind, hashField, payload) {
  return Object.freeze({ ...payload, [hashField]: hashRecord(kind, payload) });
}

function capability(kind) {
  const author = kind === 'author';
  const recordKind = author ? 'CodexResearchAuthorCapabilityReceipt' : 'CodexFormalReviewerCapabilityReceipt';
  const hashField = author
    ? 'codexResearchAuthorCapabilityReceiptHash'
    : 'codexFormalReviewerCapabilityReceiptHash';
  const payload = {
    version: 1,
    kind: recordKind,
    status: author ? 'codex_research_author_capability_ready' : 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model: author ? 'author-model' : 'reviewer-model',
    codexVersion: 'codex-cli 1.0.0',
    codexBinaryIdentityHash: HASH('codex-binary'),
    credentialRootIdentityHash: HASH(author ? 'author-root' : 'reviewer-root'),
    credentialConfigIdentityHash: HASH(author ? 'author-config' : 'reviewer-config'),
    authenticationStatus: 'codex_authentication_verified',
    modelOptionVerified: true,
    selectedModelExecutionCanaryVerified: false,
    ...(author ? {
      workspaceWriteRequired: true,
      dynamicAttemptWorkspaceRequired: true,
      assuranceScope: 'filesystem_credential_root_runtime_and_model_selection_preflight',
      providerAccountIdentityAttested: false,
      externalActionPerformed: false,
    } : {
      authorProvider: 'codex',
      authorCredentialRootIdentityHash: HASH('author-root'),
      credentialIndependenceVerified: true,
      assuranceScope: 'filesystem_credential_root_and_principal_separation',
      providerAccountIndependenceVerified: false,
      readOnlyReviewRequired: true,
      dynamicAttemptWorkspaceRequired: true,
    }),
  };
  return hashed(recordKind, hashField, payload);
}

function canary(capabilityRecord, label, observedAt) {
  const observedAtMs = Date.parse(observedAt);
  const payload = {
    version: 1,
    kind: 'CodexModelAvailabilityCanaryReceipt',
    status: 'codex_model_live_canary_verified',
    provider: capabilityRecord.provider,
    model: capabilityRecord.model,
    codexVersion: capabilityRecord.codexVersion,
    codexBinaryIdentityHash: capabilityRecord.codexBinaryIdentityHash,
    credentialRootIdentityHash: capabilityRecord.credentialRootIdentityHash,
    credentialConfigIdentityHash: capabilityRecord.credentialConfigIdentityHash,
    authenticationStatus: capabilityRecord.authenticationStatus,
    selectedModelExecutionCanaryVerified: true,
    challengeHash: HASH(`${label}-challenge`),
    responseHash: HASH(`${label}-response`),
    observedAt,
    expiresAt: new Date(observedAtMs + 15 * 60 * 1000).toISOString(),
    externalActionPerformed: true,
    externalActionScope: 'single_read_only_ephemeral_model_canary',
  };
  return hashed('CodexModelAvailabilityCanaryReceipt', 'codexModelAvailabilityCanaryReceiptHash', payload);
}

function schemaReceipt() {
  const payload = {
    version: 1,
    kind: 'ScopedSchemaVersionGateReceipt',
    status: 'scoped_schema_version_verified',
    rootKind: 'automation-status',
    requiredVersions: [21, 22, 23],
    observedVersions: [21, 22, 23],
    migrationHashes: { 21: HASH('migration-21'), 22: HASH('migration-22'), 23: HASH('migration-23') },
    blockers: [],
  };
  return hashed('ScopedSchemaVersionGateReceipt', 'scopedSchemaVersionGateReceiptHash', payload);
}

function proposalBinding() {
  const proposalClaimText = 'For every x, under assumption A, property P holds.';
  const payload = {
    version: 1,
    kind: 'ProposalClaimToTheoremBinding',
    status: 'proposal_claim_to_theorem_binding_verified',
    paperId: 'paper-golden',
    campaignId: 'campaign-golden',
    approvedProposalSeedBindingHash: HASH('approved-seed'),
    proposalSeedContractBundleHash: HASH('seed-bundle'),
    claimAuthorityType: 'operator-signed',
    claimAuthorityBindingHash: HASH('approved-seed'),
    claimAuthorityBundleHash: HASH('seed-bundle'),
    theoremSpecificationHash: HASH('theorem-spec'),
    reviewAgentReceiptHash: HASH('review-agent'),
    reviewerPrincipalId: 'reviewer-principal',
    relationPolicy: 'exact-semantic-equivalence-only-v1',
    proposalClaimCount: 1,
    theoremClaimCount: 1,
    entries: [{
      proposalClaimId: 'proposal-claim-1',
      theoremClaimId: 'theorem-claim-1',
      proposalClaimText,
      scientificClaimKey: 'golden-formal-claim',
      assumptions: ['Assumption A is fixed by the approved proposal.'],
      quantifiers: ['For every x in the approved proposal universe.'],
      negativeBoundaries: ['No conclusion is claimed outside the approved proposal universe.'],
      proofObligations: ['Establish property P under assumption A.'],
      proposalClaimTextHash: hashBytes(Buffer.from(proposalClaimText, 'utf8')),
      proposalClaimRecordHash: HASH('proposal-record'),
      theoremStatement: proposalClaimText,
      theoremSpecificationClaimHash: HASH('theorem-claim'),
      proposalToTheoremSemanticVerified: true,
      proposalToTheoremVerdict: 'equivalent',
      approvedNarrowingRationale: null,
    }],
    blockers: [],
  };
  return hashed('ProposalClaimToTheoremBinding', 'proposalClaimToTheoremBindingHash', payload);
}

function releaseAuthority(signer) {
  const binding = proposalBinding();
  const releaseBundleHash = HASH('release-bundle');
  const manifest = {
    status: 'research_evidence_capsule_ready',
    academicExperimentCount: 1,
    experimentCount: 1,
    experiments: [{
      experimentId: 'experiment-1',
      academicPromotionEligible: true,
      independentRecomputationImplementationVerified: true,
      recomputationIndependenceLevel: 'repository-separate-implementation-same-process-v1',
      rawEventRecomputationIndependenceContractHash: HASH('recomputation-independence-contract'),
      recomputationProcessIndependent: false,
    }],
  };
  const report = {
    promotionEligibility: { status: 'research_promotion_ready', blockers: [] },
    proposalClaimToTheoremBindingHash: binding.proposalClaimToTheoremBindingHash,
    capabilities: {
      proposalClaimToTheoremBinding: binding,
      formalCertificateIntakes: [{ status: 'formal_certificate_intake_verified' }],
      formalReplayReceipts: [{ status: 'formal_claim_replay_verified' }],
    },
    nativeResearchWorkerExecution: {
      workerReceipts: [{
        workerType: 'formal_verifier_lake',
        result: { status: 'formal_claim_verified', replayReceipt: { status: 'formal_claim_replay_verified' } },
      }],
    },
  };
  return {
    status: 'current_completed_release',
    campaignStatus: 'completed',
    packageNodeStatus: 'completed',
    campaignId: 'campaign-golden',
    paperId: 'paper-golden',
    campaignReleaseBundleHash: releaseBundleHash,
    promotedAt: '2026-07-15T07:55:00.000Z',
    releaseBundle: {
      status: 'campaign_release_bundle_prepared',
      campaignReleaseBundleHash: releaseBundleHash,
      proposalClaimToTheoremBindingHash: binding.proposalClaimToTheoremBindingHash,
      researchReport: report,
      researchEvidenceCapsuleManifest: manifest,
      researchExecutionReleaseAttestation: {
        ...signer,
        signedAt: '2026-07-15T07:50:00.000Z',
        validFrom: '2026-07-15T07:50:00.000Z',
        expiresAt: '2026-07-16T07:50:00.000Z',
      },
      packageOutput: { researchEvidenceCapsuleManifestFileHash: HASH('manifest-file') },
      createdAt: '2026-07-15T07:50:00.000Z',
    },
  };
}

function fixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const signer = {
    keyId: 'release-key', keyVersion: 'legacy-v1',
    subjectId: 'release-attestor', organization: 'release-office',
    role: 'research_execution_release_attestor', algorithm: 'ed25519',
  };
  const author = capability('author');
  const reviewer = capability('reviewer');
  const schema = schemaReceipt();
  const codeProvenance = {
    version: 2, packageVersion: '0.21.0', commit: 'a'.repeat(40), commitTree: 'b'.repeat(40),
    treeDirty: true, indexStateHash: HASH('index'), repositoryEntryCount: 999,
    repositoryContentHash: HASH('repo'), worktreeStateHash: HASH('worktree'),
  };
  const runtimeImageDigests = { python: HASH('python-image'), r: HASH('r-image') };
  const runtimeImageReproducibilityReceiptHash = HASH('runtime-reproducibility-receipt');
  const runtimeImageReproducibilityRequiredProfiles = ['python', 'pythonGpu', 'r'];
  const runtimeImageReproducibilityDefinitionManifestHashes = {
    python: HASH('python-definition'),
    pythonGpu: HASH('python-gpu-definition'),
    r: HASH('r-definition'),
  };
  const receiptAuthorCanary = canary(author, 'receipt-author', '2026-07-15T07:55:00.000Z');
  const receiptReviewerCanary = canary(reviewer, 'receipt-reviewer', '2026-07-15T07:55:00.000Z');
  const currentAuthorCanary = canary(author, 'current-author', '2026-07-15T08:55:00.000Z');
  const currentReviewerCanary = canary(reviewer, 'current-reviewer', '2026-07-15T08:55:00.000Z');
  const authority = releaseAuthority(signer);
  const principalAttestationUnsigned = {
    version: 1,
    kind: 'ProviderPrincipalIndependenceAttestation',
    status: 'provider_principal_independence_attested',
    assurance: 'external-operator-attested-distinct-provider-accounts-v1',
    authorCredentialConfigIdentityHash: author.credentialConfigIdentityHash,
    reviewerCredentialConfigIdentityHash: reviewer.credentialConfigIdentityHash,
    authorProviderAccountIdentityHash: HASH('author-account'),
    reviewerProviderAccountIdentityHash: HASH('reviewer-account'),
    signer,
    attestedAt: ISSUED_AT,
    expiresAt: '2026-07-16T08:00:00.000Z',
  };
  const principalAttestationSigned = {
    ...principalAttestationUnsigned,
    signature: crypto.sign(
      null,
      Buffer.from(hashRecord('ProviderPrincipalIndependenceAttestationSigningPayload', principalAttestationUnsigned), 'utf8'),
      pair.privateKey,
    ).toString('base64'),
  };
  const providerPrincipalIndependenceAttestation = {
    ...principalAttestationSigned,
    providerPrincipalIndependenceAttestationHash:
      hashRecord('ProviderPrincipalIndependenceAttestation', principalAttestationSigned),
  };
  const unsigned = {
    version: 1,
    kind: 'FullResearchGoldenMicroCampaignQualificationReceipt',
    status: 'full_research_golden_micro_campaign_qualified',
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
    codeProvenance,
    researchAuthorCapabilityReceipt: author,
    formalReviewerCapabilityReceipt: reviewer,
    campaignStoreSchemaReceipt: schema,
    runtimeImageDigests,
    runtimeImageReproducibilityReceiptHash,
    runtimeImageReproducibilityRequiredProfiles,
    runtimeImageReproducibilityDefinitionManifestHashes,
    researchAuthorProviderCanaryReceipt: receiptAuthorCanary,
    formalReviewerProviderCanaryReceipt: receiptReviewerCanary,
    providerPrincipalIndependenceAttestation,
    independentHypothesisPriorArtReviewVerified: true,
    independentHypothesisPriorArtReceiptHash: HASH('independent-prior-art-review'),
    signer,
    issuedAt: ISSUED_AT,
    expiresAt: '2026-07-16T08:00:00.000Z',
    externalActionPerformed: true,
  };
  const signature = crypto.sign(
    null,
    Buffer.from(hashRecord('FullResearchQualificationSigningPayload', unsigned), 'utf8'),
    pair.privateKey,
  ).toString('base64');
  const signed = { ...unsigned, signature };
  const receipt = {
    ...signed,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', signed),
  };
  const context = {
    now: NOW,
    codeProvenance,
    researchAuthorCapabilityReceipt: author,
    formalReviewerCapabilityReceipt: reviewer,
    campaignStoreSchemaReceipt: schema,
    runtimeImageDigests,
    runtimeImageReproducibilityInspection: {
      version: 1,
      kind: 'RuntimeImageReproducibilityReceiptInspection',
      status: 'runtime_image_reproducibility_verified',
      ready: true,
      receiptAccepted: true,
      receiptHash: runtimeImageReproducibilityReceiptHash,
      requiredProfiles: runtimeImageReproducibilityRequiredProfiles,
      definitionManifestHashes: runtimeImageReproducibilityDefinitionManifestHashes,
      blockers: [],
    },
    researchAuthorProviderCanaryReceipt: currentAuthorCanary,
    formalReviewerProviderCanaryReceipt: currentReviewerCanary,
    releaseAttestorInspection: {
      ready: true,
      ...signer,
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      expiresAt: '2027-07-01T00:00:00.000Z',
    },
    resolveCampaignReleaseAuthority: () => authority,
    verifyReleaseAttestation: () => true,
    verifyQualificationSignature: ({ signingPayloadHash, signature: value, signer: observed }) => (
      observed.keyId === signer.keyId
      && crypto.verify(null, Buffer.from(signingPayloadHash, 'utf8'), pair.publicKey, Buffer.from(value, 'base64'))
    ),
  };
  return { pair, signer, receipt, context, authority };
}

function resign(f, mutate) {
  const { signature: _signature, fullResearchQualificationReceiptHash: _hash, ...unsigned } = f.receipt;
  const changed = mutate(structuredClone(unsigned));
  const signature = crypto.sign(
    null,
    Buffer.from(hashRecord('FullResearchQualificationSigningPayload', changed), 'utf8'),
    f.pair.privateKey,
  ).toString('base64');
  const signed = { ...changed, signature };
  return { ...signed, fullResearchQualificationReceiptHash: hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', signed) };
}

function globallyBoundAuthority(f, { launchMode }) {
  const providerConfigurationHash = HASH(`provider:${launchMode}`);
  const sourceAuthorityHash = HASH(`configuration:${launchMode}`);
  const datasetMounts = [{
    name: `qualification-${launchMode}`,
    source: `/datasets/qualification-${launchMode}`,
    readOnly: true,
    manifestHash: HASH(`dataset:${launchMode}`),
    licenseId: 'CC0-1.0',
    benchmarkFamily: 'ml_algorithm_benchmark',
  }];
  let intake;
  if (launchMode === 'golden-bootstrap') {
    const template = buildAutonomousResearchRecurringGoldenTemplate({
      templateId: 'persistent-global-qualification',
      epochDurationMs: 12 * 60 * 60 * 1000,
      objective: 'Continuously verify the persisted global qualification authority.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts,
      providerConfigurationHash,
      revisionRounds: 1,
      refereeCount: 2,
    });
    intake = materializeAutonomousResearchRecurringGoldenIntake({
      template,
      now: new Date(ISSUED_AT),
      sourceAuthorityHash,
    });
  } else {
    intake = buildAutonomousResearchMachineIntake({
      intakeId: 'intake:paper-golden',
      paperId: 'paper-golden',
      campaignId: 'autonomous-research:paper-golden',
      launchMode: 'production-run',
      objective: 'Verify that production qualification remains campaign local.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts,
      budgets: {
        maxWallTimeMs: 60 * 60 * 1000,
        maxAgentCalls: 8,
        maxCpuJobs: 8,
        maxGpuJobs: 0,
        maxTokenCount: 10_000,
        maxCostUsd: 10,
        maxMemoryMiB: 2048,
      },
      providerConfigurationHash,
      revisionRounds: 1,
      refereeCount: 2,
      admissionCreatedAt: ISSUED_AT,
    });
  }
  const campaignId = intake.campaignId;
  const paperId = intake.paperId;
  const admission = buildAutonomousResearchMachineIntakeAdmission({
    intake,
    sourceKind: launchMode === 'golden-bootstrap' ? 'recurring-golden' : 'machine',
    sourceAuthorityHash,
  });
  const preparation = {
    launchMode,
    autonomousResearchProviderConfigurationHash: providerConfigurationHash,
    autonomousResearchMachineIntakeAdmissionHash:
      admission.autonomousResearchMachineIntakeAdmissionHash,
    proposal: { machineProposedScientificClaimSetHash: HASH(`proposal:${launchMode}`) },
    policyAuthorization: {
      autonomousResearchPolicyAuthorizationHash: HASH(`policy:${launchMode}`),
    },
    seedBinding: { autonomousResearchSeedBindingHash: HASH(`seed:${launchMode}`) },
  };
  const campaignPlanHash = HASH(`plan:${launchMode}`);
  const releaseBinding = createAutonomousResearchReleaseBinding({
    campaignId,
    paperId,
    campaignPlanHash,
    preparation,
    machineIntake: intake,
    machineIntakeAdmission: admission,
  });
  const authority = structuredClone(f.authority);
  authority.campaignId = campaignId;
  authority.paperId = paperId;
  authority.releaseBundle.campaignPlanHash = campaignPlanHash;
  authority.releaseBundle.autonomousResearchReleaseBinding = releaseBinding;
  authority.releaseBundle.autonomousResearchReleaseBindingHash =
    releaseBinding.autonomousResearchReleaseBindingHash;
  return {
    authority,
    receipt: resign(f, (value) => ({ ...value, campaignId, paperId })),
  };
}

test('a fresh attestor-signed qualification bound to current code, providers, schema, images and full release verifies', () => {
  const f = fixture();
  assert.match(providerPrincipalIndependenceAttestationSigningPayloadHash(
    f.receipt.providerPrincipalIndependenceAttestation,
  ), /^sha256:/);
  assert.equal(fullResearchQualificationSigningPayloadHash(f.receipt),
    hashRecord('FullResearchQualificationSigningPayload', (() => {
      const { signature: _signature, fullResearchQualificationReceiptHash: _hash, ...payload } = f.receipt;
      return payload;
    })()));
  const result = verifyFullResearchQualificationReceipt(f.receipt, f.context);
  assert.equal(result.ready, true, JSON.stringify(result.blockers));
  assert.equal(result.receiptAccepted, true);
  assert.equal(result.campaignReleaseBundleHash, f.authority.campaignReleaseBundleHash);
  assert.equal(result.independentHypothesisPriorArtReviewVerified, true);
  assert.equal(
    result.independentHypothesisPriorArtReceiptHash,
    f.receipt.independentHypothesisPriorArtReceiptHash,
  );
});

test('persisted global readiness rejects an authentic production-run qualification substitution', () => {
  const goldenFixture = fixture();
  const golden = globallyBoundAuthority(goldenFixture, { launchMode: 'golden-bootstrap' });
  const verified = verifyFullResearchQualificationReceipt(golden.receipt, {
    ...goldenFixture.context,
    requireGlobalGoldenAuthority: true,
    resolveCampaignReleaseAuthority: () => golden.authority,
  });
  assert.equal(verified.ready, true, JSON.stringify(verified.blockers));

  const productionFixture = fixture();
  const production = globallyBoundAuthority(productionFixture, { launchMode: 'production-run' });
  const substituted = verifyFullResearchQualificationReceipt(production.receipt, {
    ...productionFixture.context,
    requireGlobalGoldenAuthority: true,
    resolveCampaignReleaseAuthority: () => production.authority,
  });
  assert.equal(substituted.ready, false);
  assert.ok(substituted.blockers.includes(
    'golden_micro_campaign_global_golden_qualification_authority_required',
  ));
});

test('qualification attacks fail closed at every required binding', () => {
  const attacks = [
    ['code_worktree_identity_mismatch', (r) => { r.codeProvenance.worktreeStateHash = HASH('wrong-worktree'); return r; }],
    ['research_author_configuration_mismatch', (r) => { r.researchAuthorCapabilityReceipt.model = 'substitute-model'; return r; }],
    ['formal_reviewer_configuration_mismatch', (r) => { r.formalReviewerCapabilityReceipt.credentialRootIdentityHash = r.researchAuthorCapabilityReceipt.credentialRootIdentityHash; return r; }],
    ['provider_account_independence_not_verified', (r) => { r.providerPrincipalIndependenceAttestation.reviewerProviderAccountIdentityHash = r.providerPrincipalIndependenceAttestation.authorProviderAccountIdentityHash; return r; }],
    ['store_schema_mismatch', (r) => { r.campaignStoreSchemaReceipt.observedVersions = [21, 22]; return r; }],
    ['runtime_image_digests_mismatch', (r) => { r.runtimeImageDigests.python = HASH('tag-repoint'); return r; }],
    ['runtime_image_reproducibility_binding_invalid', (r) => {
      r.runtimeImageReproducibilityReceiptHash = HASH('stale-reproducibility'); return r;
    }],
    ['research_author_provider_canary_invalid', (r) => { r.researchAuthorProviderCanaryReceipt.responseHash = HASH('fake-response'); return r; }],
    ['independent_hypothesis_prior_art_qualification_invalid', (r) => { r.independentHypothesisPriorArtReviewVerified = false; return r; }],
    ['independent_hypothesis_prior_art_qualification_invalid', (r) => { delete r.independentHypothesisPriorArtReceiptHash; return r; }],
    ['independent_hypothesis_prior_art_qualification_invalid', (r) => { r.independentHypothesisPriorArtReceiptHash = 'not-a-hash'; return r; }],
    ['release_attestor_identity_mismatch', (r) => { r.signer.keyId = 'attacker-key'; return r; }],
    ['release_attestor_identity_mismatch', (r) => { r.signer.keyVersion = 'attacker-version'; return r; }],
    ['release_pointer_mismatch', (r) => { r.campaignReleaseBundleHash = HASH('unrelated-release'); return r; }],
  ];
  for (const [blocker, mutation] of attacks) {
    const f = fixture();
    const result = verifyFullResearchQualificationReceipt(resign(f, mutation), f.context);
    assert.equal(result.ready, false, blocker);
    assert.ok(result.blockers.some((item) => item.includes(blocker)), JSON.stringify(result.blockers));
  }
});

test('legacy qualification receipts without a reproducibility receipt binding fail closed', () => {
  const f = fixture();
  const legacy = resign(f, (receipt) => {
    delete receipt.runtimeImageReproducibilityReceiptHash;
    delete receipt.runtimeImageReproducibilityRequiredProfiles;
    delete receipt.runtimeImageReproducibilityDefinitionManifestHashes;
    return receipt;
  });
  const result = verifyFullResearchQualificationReceipt(legacy, f.context);
  assert.ok(result.blockers.includes(
    'golden_micro_campaign_runtime_image_reproducibility_binding_invalid',
  ));
});

test('expired, stale, non-formal, non-academic and untrusted releases cannot qualify', () => {
  {
    const f = fixture();
    const result = verifyFullResearchQualificationReceipt(f.receipt, { ...f.context, now: new Date('2026-07-16T08:00:00.000Z') });
    assert.ok(result.blockers.includes('golden_micro_campaign_qualification_receipt_outside_time_window'));
  }
  for (const [blocker, alter] of [
    ['golden_micro_campaign_release_not_fresh', (a) => { a.releaseBundle.createdAt = '2026-07-13T00:00:00.000Z'; }],
    ['golden_micro_campaign_release_attestation_outside_time_window', (a) => { a.releaseBundle.researchExecutionReleaseAttestation.expiresAt = '2026-07-15T08:30:00.000Z'; }],
    ['golden_micro_campaign_formal_release_required', (a) => { a.releaseBundle.researchReport.capabilities.formalReplayReceipts = []; }],
    ['golden_micro_campaign_academic_empirical_release_required', (a) => { a.releaseBundle.researchEvidenceCapsuleManifest.academicExperimentCount = 0; }],
    ['golden_micro_campaign_recomputation_implementation_independence_required', (a) => {
      a.releaseBundle.researchEvidenceCapsuleManifest.experiments[0]
        .independentRecomputationImplementationVerified = false;
    }],
  ]) {
    const f = fixture();
    const authority = structuredClone(f.authority);
    alter(authority);
    const result = verifyFullResearchQualificationReceipt(f.receipt, {
      ...f.context,
      resolveCampaignReleaseAuthority: () => authority,
    });
    assert.ok(result.blockers.includes(blocker), JSON.stringify(result.blockers));
  }
});

test('qualification rejects authentic but stale or future live provider canaries', () => {
  for (const [label, observedAt] of [
    ['stale', '2026-07-15T08:00:00.000Z'],
    ['future', '2026-07-15T09:01:00.000Z'],
  ]) {
    const f = fixture();
    const result = verifyFullResearchQualificationReceipt(f.receipt, {
      ...f.context,
      researchAuthorProviderCanaryReceipt: canary(
        f.context.researchAuthorCapabilityReceipt,
        `${label}-current-author`,
        observedAt,
      ),
    });
    assert.ok(result.blockers.includes(
      'golden_micro_campaign_research_author_provider_canary_invalid',
    ), JSON.stringify(result.blockers));
  }
});

test('self-signed, hash-tampered, missing live-canary and unverifiable current-release receipts fail closed', () => {
  const f = fixture();
  const tampered = structuredClone(f.receipt);
  tampered.paperId = 'attacker-paper';
  assert.ok(verifyFullResearchQualificationReceipt(tampered, f.context).blockers.includes(
    'golden_micro_campaign_qualification_receipt_hash_invalid',
  ));

  const attackerPair = crypto.generateKeyPairSync('ed25519');
  const { signature: _signature, fullResearchQualificationReceiptHash: _hash, ...unsigned } = f.receipt;
  const attackerSignature = crypto.sign(
    null,
    Buffer.from(hashRecord('FullResearchQualificationSigningPayload', unsigned), 'utf8'),
    attackerPair.privateKey,
  ).toString('base64');
  const attackerSigned = { ...unsigned, signature: attackerSignature };
  const attackerReceipt = {
    ...attackerSigned,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', attackerSigned),
  };
  assert.ok(verifyFullResearchQualificationReceipt(attackerReceipt, f.context).blockers.includes(
    'golden_micro_campaign_qualification_signature_invalid',
  ));
  assert.ok(verifyFullResearchQualificationReceipt(f.receipt, {
    ...f.context,
    researchAuthorProviderCanaryReceipt: null,
  }).blockers.includes('golden_micro_campaign_research_author_provider_canary_invalid'));
  assert.ok(verifyFullResearchQualificationReceipt(f.receipt, {
    ...f.context,
    resolveCampaignReleaseAuthority: () => { throw new Error('store unavailable'); },
  }).blockers.includes('golden_micro_campaign_release_authority_verification_failed'));
});
