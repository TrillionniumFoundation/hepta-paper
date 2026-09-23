import {
  buildEvidenceBoundManuscriptIrDraft,
  finalizeEvidenceBoundManuscriptIr,
} from '../../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import {
  buildAgentWorkspacePostimageBinding,
} from '../../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  buildIsolatedAgentMergeReceipt,
  buildIsolatedAgentWorkspaceContentPolicy,
} from '../../../paper-domain/evidence/isolated-agent-merge-receipt-contract.mjs';
import {
  buildAutonomousResearchAgendaProductionReceipt,
  buildAutonomousResearchAgendaProductionRequest,
} from '../../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  createAutonomousHypothesisGenerationReceipt,
  createMachineProposedScientificClaimSet,
  selectMachineGeneratedAutonomousResearchAgenda,
} from '../../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  buildResearchAgendaIr,
} from '../../../paper-domain/automation/research-agenda-ir.mjs';
import {
  buildResearchAgendaClaimBindingReceipt,
} from '../../../paper-domain/automation/research-agenda-claim-binding-contract.mjs';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  importAutonomousResearchReleaseBindingForTest,
} from './production-experiment-closure-test-seam.mjs';
import {
  buildAutonomousResearchSeedBinding,
  buildAutonomousResearchSeedContractBundle,
  evaluateAutonomousResearchPolicy,
} from '../../../paper-domain/automation/autonomous-research-policy-contract.mjs';

const {
  createAutonomousResearchReleaseBinding,
} = await importAutonomousResearchReleaseBindingForTest();
import {
  evaluateAutonomousResearchQualificationEligibility,
} from '../../../paper-domain/automation/autonomous-research-readiness-policy.mjs';
import {
  buildPriorArtClaimAlignmentReceipt,
  conservativePriorArtClaimAlignmentRecords,
} from '../../../paper-domain/research/prior-art-claim-alignment-contract.mjs';
import {
  inspectAutonomousManuscriptSubstantiveAgentProse,
} from '../../../paper-domain/automation/trusted-autonomous-manuscript-render-contract.mjs';
import {
  buildVenueRequirementIr,
} from '../../../paper-domain/automation/venue-requirement-ir.mjs';
import {
  createProposalClaimToTheoremBinding,
} from '../../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import {
  createProofObligationContracts,
} from '../../../paper-domain/research/theorem-specification.mjs';
import {
  hashPaperRecord,
} from '../../../paper-domain/contracts/primitives.mjs';
import {
  sealReceiptHash,
  computeReceiptHash,
} from '../../../paper-domain/evidence/receipt-hash-policy.mjs';
import {
  buildFormalClaimBindingsManifest,
  buildFormalExecutionContract,
  buildFormalSourceManifest,
  nativeFormalClosureBindingFromExecution,
} from '../../../paper-domain/research/formal-certificate-intake.mjs';
import {
  buildCampaignResearchSourceSnapshot,
} from '../../../paper-domain/automation/campaign-research-contract.mjs';
import {
  productionExperimentClosureFixture,
} from './production-experiment-closure-fixture.mjs';
import {
  FIXED_TIME,
  completedAgentReceipt,
  digest,
  productionAgentAuthorityBindingFixture,
  productionContentLineageFixture,
  productionPriorArtAuthorityFixture,
  productionReviewerEvidenceFixture,
  productionSubmissionAuthoritiesFixture,
} from './autonomous-research-generalization-core-fixture.mjs';
import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import {
  workspaceExecutionManifestHash,
  workspaceExecutionMerkleHash,
} from '../../../workflow-kernel/runtime/workspace-execution-identity.mjs';

function formalArtifactWriteReceipt({
  paperId,
  label,
  path,
  hash,
  contentType,
} = {}) {
  const payload = {
    version: 2,
    kind: 'ArtifactWriteReceipt',
    repositoryId: `${paperId}:formal-artifact-repository`,
    role: `formal-${label}:${paperId}`,
    contentType,
    path,
    bytes: 64,
    hash,
    contentAddress: hash,
    manifestHash: digest(`${paperId}:${label}:manifest`),
    manifestPath: `manifests/${label}.json`,
    objectCreated: true,
    immutableObject: true,
    atomic: true,
    scopeRoot: `/fixture/runtime/${paperId}`,
    casRoot: `/fixture/cas/${paperId}`,
    scopedWriteTargetIdentityHash:
      digest(`${paperId}:${label}:scoped-write-target`),
    createdAt: FIXED_TIME,
    externalActionPerformed: false,
  };
  const writeReceiptHash = computeReceiptHash(payload, {
    hashField: 'writeReceiptHash',
  });
  return Object.freeze({
    ...payload,
    writeReceiptHash,
    ledgerReceiptId: `${paperId}:${label}:artifact-ledger`,
  });
}

function productionResearchReportFixture({
  paperId,
  campaignId,
  proposal,
  seedBindingHash,
  claimAuthorityBundleHash,
  experimentRegistry,
} = {}) {
  const formalClaimIndex = proposal.claims.findIndex((claim) => (
    claim.verificationMode === 'formal_kernel'
  ));
  const formalClaim = proposal.claims[formalClaimIndex];
  const dynamicSeed = proposal.dynamicFormalClaimSeed;
  const seedClaim = Object.freeze({
    id: `${proposal.paperId}:autonomous_claim:${formalClaimIndex + 1}`,
    kind: 'machine_proposed_claim_seed',
    status: 'machine_proposed_policy_authorized_for_bounded_execution',
    text: formalClaim.statement,
    scientificClaimKey: formalClaim.claimKey,
    verificationMode: formalClaim.verificationMode,
    assumptions: formalClaim.assumptions,
    quantifiers: formalClaim.quantifiers,
    negativeBoundaries: formalClaim.negativeBoundaries,
    proofObligations: formalClaim.proofObligations,
    empiricalObligations: formalClaim.empiricalObligations,
    machineProposedScientificClaimSetHash:
      proposal.machineProposedScientificClaimSetHash,
    dynamicFormalClaimSeedHash: dynamicSeed.dynamicFormalClaimSeedHash,
    leanDeclarationName: dynamicSeed.leanDeclarationName,
    leanTypeSource: dynamicSeed.leanTypeSource,
    leanTypeSourceHash: dynamicSeed.leanTypeSourceHash,
    leanNormalizedTypeHash: dynamicSeed.leanNormalizedTypeHash,
    allowedImports: dynamicSeed.allowedImports,
    formalClaimCapabilityScopeManifestHash:
      dynamicSeed.capabilityScopeManifestHash,
    formalClaimGeneratorReceiptHash: dynamicSeed.generatorReceiptHash,
  });
  const proposalClaimSource = Object.freeze({
    claimAuthorityType: 'machine-policy-authorized',
    claimAuthorityBindingHash: seedBindingHash,
    claimAuthorityBundleHash,
    proposalClaimId: seedClaim.id,
    proposalClaimText: formalClaim.statement,
    scientificClaimKey: formalClaim.claimKey,
    assumptions: formalClaim.assumptions,
    quantifiers: formalClaim.quantifiers,
    negativeBoundaries: formalClaim.negativeBoundaries,
    proofObligations: formalClaim.proofObligations,
    proposalClaimTextHash: hashBytes(Buffer.from(formalClaim.statement, 'utf8')),
    proposalClaimRecordHash:
      hashRecord('AutonomousResearchClaimRecord', seedClaim),
    proposalSeedContractBundleHash: null,
    approvedProposalSeedBindingHash: null,
    dynamicFormalClaimSeedHash: dynamicSeed.dynamicFormalClaimSeedHash,
    leanDeclarationName: dynamicSeed.leanDeclarationName,
    leanTypeSource: dynamicSeed.leanTypeSource,
    leanTypeSourceHash: dynamicSeed.leanTypeSourceHash,
    leanNormalizedTypeHash: dynamicSeed.leanNormalizedTypeHash,
    allowedImports: dynamicSeed.allowedImports,
    formalClaimCapabilityScopeManifestHash:
      dynamicSeed.capabilityScopeManifestHash,
    formalClaimGeneratorReceiptHash: dynamicSeed.generatorReceiptHash,
  });
  const theoremClaimPayload = {
    claimId: `${paperId}:theorem:${dynamicSeed.leanDeclarationName}`,
    statement: formalClaim.statement,
    proposalClaimSource,
  };
  const theoremClaim = Object.freeze({
    ...theoremClaimPayload,
    theoremSpecificationClaimHash:
      hashRecord('TheoremSpecificationClaim', theoremClaimPayload),
  });
  const theoremSpecificationPayload = {
    version: 1,
    kind: 'TheoremSpecification',
    paperId,
    proposalClaimLineageRequired: true,
    approvedProposalSeedBindingHash: null,
    proposalSeedContractBundleHash: null,
    claimAuthorityType: 'machine-policy-authorized',
    claimAuthorityBindingHash: seedBindingHash,
    claimAuthorityBundleHash,
    claims: [theoremClaim],
  };
  const theoremSpecification = Object.freeze({
    ...theoremSpecificationPayload,
    theoremSpecificationHash:
      hashRecord('TheoremSpecification', theoremSpecificationPayload),
  });
  const semanticReview = Object.freeze({
    claimId: theoremClaim.claimId,
    proposalClaimId: proposalClaimSource.proposalClaimId,
    proposalClaimRecordHash: proposalClaimSource.proposalClaimRecordHash,
    proposalClaimTextHash: proposalClaimSource.proposalClaimTextHash,
    proposalToTheoremSemanticVerified: true,
    proposalToTheoremVerdict: 'equivalent',
    approvedNarrowingRationale: null,
  });
  const proposalClaimToTheoremBinding = createProposalClaimToTheoremBinding({
    paperId,
    campaignId,
    theoremSpecification,
    reviews: [semanticReview],
    reviewAuthority: {
      reviewAgentReceiptHash: digest(`${paperId}:formal-semantic-review-agent`),
      reviewerPrincipalId: digest(`${paperId}:formal-semantic-reviewer-principal`),
    },
  });
  const theoremClaimId =
    proposalClaimToTheoremBinding.entries[0].theoremClaimId;
  const formalProofObligationContracts = createProofObligationContracts({
    claimKey: formalClaim.claimKey,
    proofObligations: formalClaim.proofObligations,
  });
  const formalSourceHash = digest(`${paperId}:formal-source`);
  const sourceFileRecords = Object.freeze([Object.freeze({
    path: 'Formal.lean',
    mode: 0o644,
    hash: formalSourceHash,
    bytes: 64,
  })]);
  const verifiedSourceMerkleHash =
    workspaceExecutionMerkleHash(sourceFileRecords);
  const verifiedSourceWorkspaceManifestHash =
    workspaceExecutionManifestHash(sourceFileRecords, []);
  const researchNodeId = `${campaignId}:research-verify`;
  const researchAttemptId = `${campaignId}:research-attempt-1`;
  const campaignResearchSourceSnapshot =
    buildCampaignResearchSourceSnapshot({
      campaignId,
      paperId,
      researchNodeId,
      researchAttemptId,
      researchLeaseGeneration: 1,
      verifiedSourceMerkleHash,
      verifiedSourceWorkspaceManifestHash,
      fileRecords: sourceFileRecords,
      directoryRecords: [],
    });
  const formalNodeId = `${campaignId}:formal-verify`;
  const formalAttemptId = `${campaignId}:formal-attempt-1`;
  const campaignFormalSourceSnapshot =
    buildCampaignResearchSourceSnapshot({
      campaignId,
      paperId,
      researchNodeId: formalNodeId,
      researchAttemptId: formalAttemptId,
      researchLeaseGeneration: 1,
      verifiedSourceMerkleHash,
      verifiedSourceWorkspaceManifestHash,
      fileRecords: sourceFileRecords,
      directoryRecords: [],
    });
  const researchSourceSnapshotHash =
    campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash;
  const formalToolchainHash = digest(`${paperId}:formal-toolchain`);
  const formalCertificateHash = digest(`${paperId}:formal-certificate`);
  const formalAdapterReceiptHash = digest(`${paperId}:formal-adapter`);
  const sourceArtifactWriteReceipt = formalArtifactWriteReceipt({
    paperId,
    label: 'formal-source',
    path: 'Formal.lean',
    hash: formalSourceHash,
    contentType: 'application/octet-stream',
  });
  const certificateArtifactWriteReceipt = formalArtifactWriteReceipt({
    paperId,
    label: 'formal-certificate',
    path: 'certificates/lean-certificate.json',
    hash: formalCertificateHash,
    contentType: 'application/json',
  });
  const formalSourceRecords = Object.freeze([Object.freeze({
    path: 'Formal.lean',
    hash: formalSourceHash,
    sourceReadReceiptHash: digest(`${paperId}:formal-source-read`),
    artifactWriteReceipt: sourceArtifactWriteReceipt,
    ledgerReceiptId: sourceArtifactWriteReceipt.ledgerReceiptId,
  })]);
  const formalClaimBindings = Object.freeze(
    formalProofObligationContracts.map((contract) => Object.freeze({
      claimId: theoremClaimId,
      obligationId: contract.obligationId,
      statementHash: hashBytes(Buffer.from(formalClaim.statement, 'utf8')),
    })),
  );
  const formalSourceManifest = buildFormalSourceManifest({
    verifierKind: 'lean',
    sourceRecords: formalSourceRecords,
  });
  const formalClaimBindingsManifest = buildFormalClaimBindingsManifest({
    claimBindings: formalClaimBindings,
  });
  const formalExecutionContract = buildFormalExecutionContract({
    verifierKind: 'lean',
    command: 'lean',
    certificateHash: formalCertificateHash,
    toolchainHash: formalToolchainHash,
    sourceManifestHash: formalSourceManifest.formalSourceManifestHash,
    claimBindingsHash:
      formalClaimBindingsManifest.formalClaimBindingsHash,
    certificateWriteReceiptHash:
      certificateArtifactWriteReceipt.writeReceiptHash,
    adapterReceiptHash: formalAdapterReceiptHash,
  });
  const formalExecutionPayload = {
    version: 1,
    kind: 'FormalVerifierExecutionReceipt',
    status: 'formal_verifier_execution_verified',
    verifierKind: 'lean',
    paperId,
    campaignId,
    researchSourceSnapshotHash,
    certificateHash: formalCertificateHash,
    sourceHashes: Object.freeze([formalSourceHash]),
    sourceManifestHash: formalSourceManifest.formalSourceManifestHash,
    claimBindingsHash:
      formalClaimBindingsManifest.formalClaimBindingsHash,
    certificateWriteReceiptHash:
      certificateArtifactWriteReceipt.writeReceiptHash,
    toolchainHash: formalToolchainHash,
    command: 'lean',
    adapterReceiptHash: formalAdapterReceiptHash,
    executionContractHash:
      formalExecutionContract.formalExecutionContractHash,
    isolationPolicyHash: formalExecutionContract.isolationPolicyHash,
    isolationReceiptHash: digest(`${paperId}:formal-isolation-receipt`),
    networkPolicy: 'none',
    secretAccessPerformed: false,
    sourceMutationDetected: false,
    externalActionPerformed: false,
    providerCallPerformed: false,
    commitPerformed: false,
    sourceMerkleHashBefore: digest(`${paperId}:generic-formal-source-merkle`),
    sourceMerkleHashAfter: digest(`${paperId}:generic-formal-source-merkle`),
    isolation: Object.freeze({
      kernelNetworkIsolationVerified: true,
      sourceReadOnlyVerified: true,
      ephemeralWorkRootVerified: true,
      separateOutputRootVerified: true,
    }),
    exitCode: 0,
    stdoutHash: digest(`${paperId}:formal-stdout`),
    stderrHash: digest(`${paperId}:formal-stderr`),
    runnerId: `${paperId}:formal-runner`,
    runnerDescriptorHash: digest(`${paperId}:formal-runner-descriptor`),
    createdAt: FIXED_TIME,
  };
  const formalExecutionReceipt = Object.freeze({
    ...formalExecutionPayload,
    receiptHash: computeReceiptHash(formalExecutionPayload, {
      hashField: 'receiptHash',
    }),
    ledgerReceiptId: `${paperId}:formal-execution-ledger`,
  });
  const formalReplayPayload = {
    version: 1,
    kind: 'FormalCertificateReplayReceipt',
    status: 'formal_claim_replay_verified',
    blockers: Object.freeze([]),
    originalCertificateBundleHash: digest(`${paperId}:formal-bundle:original`),
    rerunCertificateBundleHash: digest(`${paperId}:formal-bundle:replay`),
    projectManifestHash: digest(`${paperId}:formal-project-manifest`),
    systemAuditHash: digest(`${paperId}:formal-system-audit`),
    toolchainHash: digest(`${paperId}:formal-toolchain`),
    toolchain: 'leanprover/lean4:v4.30.0',
    toolchainRuntimeIdentity: Object.freeze({
      leanToolchainContentIdentityHash:
        digest(`${paperId}:lean-toolchain-content-identity`),
    }),
    formalProjectClosureHash: digest(`${paperId}:formal-project-closure`),
    leanReadableProofPrintAuditSetHash:
      digest(`${paperId}:formal-readable-proof-audit-set`),
    productionReadableProofReady: true,
    executionIdentity: Object.freeze({
      runnerIdentityHash: digest(`${paperId}:formal-runner-identity`),
    }),
    externalActionPerformed: false,
  };
  const formalReplayReceipt = Object.freeze({
    ...formalReplayPayload,
    formalCertificateReplayReceiptHash:
      hashRecord('FormalCertificateReplayReceipt', formalReplayPayload),
  });
  const formalClaimBindingReportPayload = {
    version: 1,
    kind: 'FormalClaimBindingReport',
    status: 'formal_claim_binding_verified',
    bindings: Object.freeze([Object.freeze({
        claimId: theoremClaimId,
        theoremName: dynamicSeed.leanDeclarationName,
        valid: true,
        manuscriptClaimHash:
          hashBytes(Buffer.from(formalClaim.statement, 'utf8')),
        expectedObligations: Object.freeze([...formalClaim.proofObligations].sort()),
        proofObligationContracts: formalProofObligationContracts,
        verifiedObligations: Object.freeze(
          formalProofObligationContracts.map((contract) => contract.obligationId).sort(),
        ),
    })]),
    blockers: Object.freeze([]),
  };
  const formalClaimBindingReport = Object.freeze({
    ...formalClaimBindingReportPayload,
    formalClaimBindingHash: hashRecord(
      'FormalClaimBindingReport',
      formalClaimBindingReportPayload,
    ),
  });
  const formalWorkerResult = Object.freeze({
    status: 'formal_claim_verified',
    claimId: theoremClaimId,
    theoremSpecificationClaimHash:
      theoremClaim.theoremSpecificationClaimHash,
    certificateBundleHash:
      formalReplayReceipt.originalCertificateBundleHash,
    formalCertificateReplayReceiptHash:
      formalReplayReceipt.formalCertificateReplayReceiptHash,
    projectManifestHash: formalReplayReceipt.projectManifestHash,
    formalProjectClosureHash: formalReplayReceipt.formalProjectClosureHash,
    toolchainHash: formalReplayReceipt.toolchainHash,
    systemAuditHash: formalReplayReceipt.systemAuditHash,
    leanReadableProofPrintAuditSetHash:
      formalReplayReceipt.leanReadableProofPrintAuditSetHash,
    projectFiles: Object.freeze([Object.freeze({
      projectPath: 'Formal.lean',
      hash: formalSourceHash,
      bytes: 64,
    })]),
    replayReceipt: formalReplayReceipt,
    claimBindingReport: formalClaimBindingReport,
  });
  const taskKey = `paper_factory:${paperId}`;
  const planHash = digest(`${paperId}:formal-worker-plan`);
  const engineHash = digest(`${paperId}:formal-worker-engine`);
  const formalWorkerPayload = {
    version: 1,
    kind: 'NativeResearchWorkerExecutionReceipt',
    paperId,
    taskKey,
    workerId: 'formal-verifier',
    workerType: 'formal_verifier_lake',
    jobId: `${paperId}:formal-job`,
    attemptId: `${paperId}:formal-attempt-1`,
    leaseGeneration: 1,
    status: 'native_research_worker_execution_verified',
    planHash,
    theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
    dynamicFormalExecutionAuthorityHash: null,
    workerDefinitionHash: digest(`${paperId}:formal-worker-definition`),
    engineHash,
    inputs: Object.freeze([Object.freeze({
      role: 'formal_project_source',
      path: 'Formal.lean',
      hash: formalSourceHash,
      expectedHash: formalSourceHash,
      sizeBytes: 64,
      scopedFileReadReceiptHash: digest(`${paperId}:formal-source-read`),
      verified: true,
    })]),
    sourceSnapshotHash: digest(`${paperId}:formal-source-snapshot`),
    sourceMerkleHashBefore: digest(`${paperId}:formal-source-merkle`),
    sourceMerkleHashAfter: digest(`${paperId}:formal-source-merkle`),
    sourceMutationDetected: false,
    claimIds: Object.freeze([theoremClaimId]),
    result: formalWorkerResult,
    resultHash: hashPaperRecord('NativeResearchWorkerResult', formalWorkerResult),
    academicEvidenceEligible: true,
    blockers: Object.freeze([]),
    safety: Object.freeze({
      boundedNativeWorker: true,
      allowlistedWorkerType: true,
      networkAccess: false,
      subprocessExecution: true,
      subprocessBoundedByWorkerRunnerPort: true,
      sourceMutation: false,
      writesRuntimeOnly: true,
      externalActionPerformed: false,
    }),
    executedAt: FIXED_TIME,
  };
  const sealedFormalWorkerReceipt = sealReceiptHash(formalWorkerPayload, {
    hashField: 'nativeResearchWorkerExecutionReceiptHash',
  });
  const formalWorkerReceipt = Object.freeze({
    ...sealedFormalWorkerReceipt,
    ledgerReceiptId: `${paperId}:native-formal-worker-ledger`,
  });
  const nativeResearchWorkerExecutionPayload = {
    version: 1,
    kind: 'NativeResearchWorkerExecutionReport',
    paperId,
    taskKey,
    status: 'native_research_workers_verified',
    executeRequested: true,
    planPath: 'RESEARCH_WORKER_PLAN.json',
    planHash,
    theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
    theoremSpecificationClaimHashes: Object.freeze([
      theoremClaim.theoremSpecificationClaimHash,
    ]),
    dynamicFormalExecutionAuthority: null,
    engineHash,
    workerTypeFilter: Object.freeze(['formal_verifier_lake']),
    plannedResearchWorkerCount: 1,
    executedResearchWorkerCount: 1,
    verifiedAcademicEvidenceWorkerCount: 1,
    workerReceipts: Object.freeze([formalWorkerReceipt]),
    workerReceiptHashes: Object.freeze([
      formalWorkerReceipt.nativeResearchWorkerExecutionReceiptHash,
    ]),
    blockers: Object.freeze([]),
    safety: Object.freeze({
      allowlistedWorkerTypes: Object.freeze(['formal_verifier_lake']),
      networkAccess: false,
      subprocessExecution: true,
      subprocessBoundedByWorkerRunnerPort: true,
      sourceMutation: false,
      writesRuntimeOnly: true,
      externalActionPerformed: false,
    }),
  };
  const nativeResearchWorkerExecution = Object.freeze({
    ...nativeResearchWorkerExecutionPayload,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord(
      'NativeResearchWorkerExecutionReport',
      nativeResearchWorkerExecutionPayload,
    ),
  });
  const nativeFormalClosureBinding = nativeFormalClosureBindingFromExecution(
    nativeResearchWorkerExecution,
    { paperId, campaignId, researchSourceSnapshotHash },
  );
  const authoritativeFormalReceiptPayload = {
    version: 1,
    kind: 'CampaignFormalVerificationReceipt',
    status: 'campaign_formal_verification_completed',
    paperId,
    campaignId,
    formalNodeId,
    formalAttemptId,
    formalLeaseGeneration: 1,
    verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash,
    campaignFormalSourceSnapshotHash:
      campaignFormalSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignFormalSourceSnapshot,
    nativeResearchWorkerExecutionReportHash:
      nativeResearchWorkerExecution.nativeResearchWorkerExecutionReportHash,
    nativeResearchWorkerExecution,
    proposalClaimToTheoremBinding,
    legacyFormalExecutionReceipt: formalExecutionReceipt,
    blockers: Object.freeze([]),
    externalActionPerformed: false,
  };
  const authoritativeFormalReceipt = Object.freeze({
    ...authoritativeFormalReceiptPayload,
    campaignFormalVerificationReceiptHash: hashRecord(
      'CampaignFormalVerificationReceipt',
      authoritativeFormalReceiptPayload,
    ),
  });
  const authoritativeFormalNode = Object.freeze({
    nodeId: formalNodeId,
    kind: 'formal-verify',
    status: 'completed',
    attemptId: formalAttemptId,
    leaseGeneration: 1,
    resultSha256: hashRecord(
      'PaperCampaignNodeResult',
      authoritativeFormalReceipt,
    ),
    result: authoritativeFormalReceipt,
  });
  const formalCertificateIntakePayload = {
    version: 4,
    kind: 'GenericFormalCertificateIntake',
    status: 'formal_certificate_intake_verified',
    paperId,
    campaignId,
    researchSourceSnapshotHash,
    verifierKind: 'lean',
    campaignFormalVerificationReceiptHash:
      authoritativeFormalReceipt.campaignFormalVerificationReceiptHash,
    authoritativeFormalNode,
    authoritativeFormalNodeResultHash:
      authoritativeFormalNode.resultSha256,
    authoritativeFormalReceipt,
    authoritativeFormalReceiptVerified: true,
    nativeResearchWorkerExecutionReportHash:
      nativeResearchWorkerExecution.nativeResearchWorkerExecutionReportHash,
    nativeResearchWorkerExecutionReceiptHash:
      formalWorkerReceipt.nativeResearchWorkerExecutionReceiptHash,
    nativeFormalCertificateBundleHash:
      formalWorkerResult.certificateBundleHash,
    nativeFormalCertificateReplayReceiptHash:
      formalWorkerResult.formalCertificateReplayReceiptHash,
    nativeFormalProjectManifestHash:
      formalWorkerResult.projectManifestHash,
    nativeFormalProjectClosureHash:
      formalWorkerResult.formalProjectClosureHash,
    nativeFormalToolchainHash: formalWorkerResult.toolchainHash,
    authoritativeSource: Object.freeze({
      path: 'Formal.lean',
      hash: formalSourceHash,
      bytes: 64,
      sourceReadReceiptHash:
        formalSourceRecords[0].sourceReadReceiptHash,
    }),
    claimBindings: formalClaimBindings,
    claimBindingsManifest: formalClaimBindingsManifest,
    claimBindingsHash:
      formalClaimBindingsManifest.formalClaimBindingsHash,
    nativeFormalClosureBinding,
    nativeFormalClosureBindingHash:
      nativeFormalClosureBinding.nativeFormalClosureBindingHash,
    trustedNativeFormalReceiptVerified: true,
    sourceSnapshotVerified: true,
    blockers: Object.freeze([]),
    externalActionPerformed: false,
  };
  const formalCertificateIntake = Object.freeze({
    ...formalCertificateIntakePayload,
    genericFormalCertificateIntakeHash: hashRecord(
      'GenericFormalCertificateIntake',
      formalCertificateIntakePayload,
    ),
  });
  const trustedFormalEvidence = Object.freeze([Object.freeze({
    status: 'trusted_formal_evidence_projected',
    nativeProjectionRequest: Object.freeze({
      authoritativeFormalNode,
    }),
  })]);
  const evidenceQualityGatePayload = {
    version: 7,
    kind: 'EvidenceQualityGate',
    status: 'evidence_quality_ready',
    workerLedgerVerifications: Object.freeze([Object.freeze({
      status: 'trusted_ledger_receipt_verified',
      receiptKind: 'NativeResearchWorkerExecutionReceipt',
      receiptHash:
        formalWorkerReceipt.nativeResearchWorkerExecutionReceiptHash,
      stream: 'jobs',
      writerKind: 'native-research-worker',
      writerTrusted: true,
      issuerPolicyVerified: true,
    })]),
    blockers: Object.freeze([]),
  };
  const evidenceQualityGate = Object.freeze({
    ...evidenceQualityGatePayload,
    evidenceQualityGateHash: hashRecord(
      'EvidenceQualityGate',
      evidenceQualityGatePayload,
    ),
  });
  const reportPayload = {
    version: 1,
    kind: 'PaperResearchVerifyReport',
    paperId,
    taskKey: `paper_factory:${paperId}`,
    status: 'verified',
    promotionEligibility: Object.freeze({
      status: 'research_promotion_ready', blockers: Object.freeze([]),
    }),
    proposalClaimToTheoremBindingHash:
      proposalClaimToTheoremBinding.proposalClaimToTheoremBindingHash,
    experimentRegistryHash: experimentRegistry.experimentRegistryHash,
    campaignResearchSourceSnapshotHash: researchSourceSnapshotHash,
    researchNodeId,
    researchAttemptId,
    researchLeaseGeneration: 1,
    verifiedSourceMerkleHash,
    verifiedSourceWorkspaceManifestHash,
    campaignResearchSourceSnapshot,
    capabilities: Object.freeze({
      proposalClaimToTheoremBinding,
      formalCertificateIntakes: Object.freeze([formalCertificateIntake]),
      formalReplayReceipts: Object.freeze([formalReplayReceipt]),
      experimentRegistry,
      trustedFormalEvidence,
      evidenceQualityGate,
    }),
    nativeResearchWorkerExecution,
  };
  return Object.freeze({
    ...reportPayload,
    researchReportHash: hashPaperRecord('PaperResearchVerifyReport', reportPayload),
  });
}

export function genericManuscriptReleaseFixture({
  paperId = 'paper-generalized-1',
  campaignId = 'campaign-generalized-1',
  launchMode = 'production-run',
  objective = 'Produce a bounded machine-authored research argument.',
  protocolFamily = 'ml_algorithm_benchmark',
  campaignPlanHash = digest('generic-release-plan'),
  proposalHash: _legacyProposalHash = null,
  policyAuthorizationHash = digest('generic-release-policy'),
  seedBindingHash = digest('generic-release-seed'),
  renderedManuscriptHash = null,
  externalSubmission = true,
  includeProof = true,
  includeResearchReport = false,
  machineIntake = null,
  machineIntakeAdmission = null,
  bindingPreparation = null,
} = {}) {
  void _legacyProposalHash;
  const preliminaryPriorArtAuthority = productionPriorArtAuthorityFixture({ paperId });
  const { externalCapabilityTrustInspection } = preliminaryPriorArtAuthority;
  const productionAuthorityBinding = productionAgentAuthorityBindingFixture({
    externalCapabilityTrustInspection,
    providerConfigurationHash:
      machineIntake?.providerConfigurationHash || digest('agent-provider-configuration'),
  });
  const capabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1'],
    empiricalFamilies: [protocolFamily],
    priorArtMode: 'structured-ranked-deduplicated-v2',
    reviewerPrincipalCount: 2,
    reviewerTrustDomainCount: 2,
    replayMode: 'external-trust-domain-v1',
    venueMode: externalSubmission ? 'submission-enabled-v1' : 'profile-selected-v1',
  });
  const initialContentLineage = productionContentLineageFixture({
    paperId,
    protocolFamily,
    capabilityScopeManifest,
    productionAuthorityBinding,
  });
  const hypothesisDraft = Object.freeze({
    empiricalHypothesis: Object.freeze({
      statement: [
        `Within the preregistered ${protocolFamily} evaluation universe,`,
        `the intervention defined by "${objective}" improves the primary`,
        'metric over the fixed control by at least the preregistered minimum effect.',
      ].join(' '),
      assumptions: Object.freeze([
        'The signed population, intervention, comparator, variables, and exclusions are fixed before execution.',
        'Every original run has an isolated deterministic rerun under the same hash-bound plan.',
      ]),
      quantifiers: Object.freeze([
        'For every seed and repetition in the operator-authorized evaluation schedule.',
      ]),
      negativeBoundaries: Object.freeze([
        `No claim is made outside the preregistered ${protocolFamily} population.`,
        'The deterministic rerun is not represented as independent scientific replication.',
      ]),
      empiricalObligations: Object.freeze([
        'Execute the registered treatment, control, and ablation schedule.',
        'Preserve and replay the raw event artifacts under the exact frozen plan.',
      ]),
    }),
    formalSupportClaim: Object.freeze({
      statement: initialContentLineage.dynamicFormalClaimSeed.statement,
      assumptions: initialContentLineage.dynamicFormalClaimSeed.assumptions,
      quantifiers: initialContentLineage.dynamicFormalClaimSeed.quantifiers,
      negativeBoundaries:
        initialContentLineage.dynamicFormalClaimSeed.negativeBoundaries,
      proofObligations:
        initialContentLineage.dynamicFormalClaimSeed.proofObligations,
    }),
  });
  const hypothesisGenerationReceipt = createAutonomousHypothesisGenerationReceipt({
    draft: hypothesisDraft,
    principalId: productionAuthorityBinding.authorPrincipalId,
    provider: productionAuthorityBinding.authorProvider,
    model: productionAuthorityBinding.authorModel,
    externalActionPerformed: true,
    generatedAt: FIXED_TIME,
  });
  const productionContentLineage = productionContentLineageFixture({
    paperId,
    protocolFamily,
    capabilityScopeManifest,
    productionAuthorityBinding,
    dynamicFormalClaimSeed: initialContentLineage.dynamicFormalClaimSeed,
    outputHash: hypothesisGenerationReceipt.outputHash,
  });
  const agendaRequest = buildAutonomousResearchAgendaProductionRequest({
    paperId,
    allowedProtocolFamilies: [protocolFamily],
    productionAuthorityBinding,
    producerContractHash: digest(`${paperId}:agenda-producer-contract`),
  });
  const agendaReceipt = buildAutonomousResearchAgendaProductionReceipt({
    request: agendaRequest,
    selectedObjective: objective,
    selectedProtocolFamily: protocolFamily,
    agentExecutionReceipt: completedAgentReceipt({
      executorId: 'fixture-agenda-author',
      agentId: productionAuthorityBinding.authorPrincipalId,
      changedPaths: [],
      productionAuthorityBinding,
    }),
    producerId: productionAuthorityBinding.authorPrincipalId,
    generatedAt: FIXED_TIME,
  });
  const agendaSelectionReceipt = selectMachineGeneratedAutonomousResearchAgenda({
    paperId,
    researchAgendaProducerReceipt: agendaReceipt,
    selectedAt: FIXED_TIME,
  });
  const proposal = createMachineProposedScientificClaimSet({
    paperId,
    objective,
    protocolFamily,
    draft: hypothesisDraft,
    generationReceipt: hypothesisGenerationReceipt,
    agendaSelectionReceipt,
    dynamicFormalClaimSeed: productionContentLineage.dynamicFormalClaimSeed,
    researchContentProducerReceipt:
      productionContentLineage.researchContentProducerReceipt,
    createdAt: FIXED_TIME,
  });
  const researchAgendaIr = buildResearchAgendaIr({
    agendaProductionReceipt: agendaReceipt,
    researchQuestion: 'Does the registered intervention improve the signed primary metric?',
    primaryClaim: proposal.claims[0].statement,
    dataRequirements: {
      population: 'Rows admitted by the signed dataset contract.',
      intervention: 'Registered treatment implementation.',
      comparator: 'Registered baseline implementation.',
      estimand: 'Paired mean primary-metric difference.',
      requiredVariables: ['outcome', 'treatment_assignment'],
      datasetConstraints: [
        'read-only signed dataset mount',
        'no post-freeze filtering',
      ],
    },
    falsifiers: ['Non-positive paired primary-metric difference.'],
    negativeBoundaries: [
      'No population claim is made outside the operator-signed dataset semantics.',
    ],
    formalTargets: [proposal.claims[1].statement],
    priorArtQueryPlan: [
      'registered autonomous intervention paired estimand evidence-bound research',
    ],
    venueConstraints: {
      paperType: 'research_article',
      requiredSections: ['methods', 'results', 'limitations'],
      artifactRequired: true,
      anonymousReviewRequired: true,
    },
    resourceFeasibility: {
      maximumWallTimeMs: 3_600_000,
      maximumMemoryBytes: 4_294_967_296,
      maximumCpuCount: 4,
      executionEnvironment: 'signed-docker-runtime-v1',
    },
  });
  const agendaClaimBindingReceipt = buildResearchAgendaClaimBindingReceipt({
    researchAgendaIr,
    proposal,
  });
  const exactPriorArtAuthority = productionPriorArtAuthorityFixture({
    paperId,
    agendaSelectionReceiptHash: proposal.agendaSelectionReceiptHash,
    researchAgendaIr,
  });
  if (exactPriorArtAuthority.externalCapabilityTrustInspection
      .autonomousResearchExternalCapabilityTrustInspectionHash
    !== externalCapabilityTrustInspection
      .autonomousResearchExternalCapabilityTrustInspectionHash) {
    throw new Error('generic_fixture_prior_art_trust_identity_drift');
  }
  const {
    priorArtReceipt,
    authorityBundle: priorArtAuthorityVerificationBundle,
    trustConfiguration: priorArtAuthorityTrustConfiguration,
  } = exactPriorArtAuthority;
  const priorArtClaimAlignmentReceipt = buildPriorArtClaimAlignmentReceipt({
    researchAgendaIr,
    priorArtEvidenceReceipt: priorArtReceipt,
    agendaSelectionReceiptHash: proposal.agendaSelectionReceiptHash,
    alignments: conservativePriorArtClaimAlignmentRecords({
      researchAgendaIr,
      priorArtEvidenceReceipt: priorArtReceipt,
    }),
  });
  const priorArtHash = priorArtReceipt.priorArtEvidenceReceiptHash;
  const sourceDraft = buildEvidenceBoundManuscriptIrDraft({
    paperId,
    title: 'Agent-authored bounded result',
    sections: [
      {
        sectionId: 'abstract',
        heading: 'Abstract',
        blocks: [{
          type: 'prose',
          blockId: 'abstract-scope',
          claimClass: 'scope',
          text: 'This manuscript reports only claims bound to machine-verifiable evidence.',
          evidenceRefs: [priorArtHash],
        }],
      },
      {
        sectionId: 'methods',
        heading: 'Methods',
        blocks: [
          { type: 'slot', blockId: 'empirical-claims-slot', slot: 'empirical_claims' },
          { type: 'slot', blockId: 'formal-support-slot', slot: 'formal_support' },
        ],
      },
      {
        sectionId: 'results',
        heading: 'Results',
        blocks: [{
          type: 'slot', blockId: 'empirical-results-slot', slot: 'empirical_results',
        }],
      },
      {
        sectionId: 'limitations',
        heading: 'Limitations',
        blocks: [{
          type: 'prose',
          blockId: 'open-world-limitation',
          claimClass: 'limitation',
          text: 'Finite retrieval and verification do not guarantee novelty or scientific truth.',
          evidenceRefs: [priorArtHash],
        }],
      },
    ],
  });
  const systemSeedDraft = buildEvidenceBoundManuscriptIrDraft({
    paperId,
    title: 'System-seeded bounded research report',
    sections: [
      {
        sectionId: 'abstract',
        heading: 'Abstract',
        blocks: [{
          type: 'prose',
          blockId: 'abstract-scope',
          claimClass: 'scope',
          text: 'The system seed summarizes a declared protocol without adding autonomous scientific interpretation.',
          evidenceRefs: [priorArtHash],
        }],
      },
      {
        sectionId: 'methods',
        heading: 'Methods',
        blocks: [
          { type: 'slot', blockId: 'empirical-claims-slot', slot: 'empirical_claims' },
          { type: 'slot', blockId: 'formal-support-slot', slot: 'formal_support' },
        ],
      },
      {
        sectionId: 'results',
        heading: 'Results',
        blocks: [{
          type: 'slot', blockId: 'empirical-results-slot', slot: 'empirical_results',
        }],
      },
      {
        sectionId: 'limitations',
        heading: 'Limitations',
        blocks: [{
          type: 'prose',
          blockId: 'open-world-limitation',
          claimClass: 'limitation',
          text: 'The system seed makes no claim beyond its finite configured evidence authorities.',
          evidenceRefs: [priorArtHash],
        }],
      },
    ],
  });
  const substantiveInspection = inspectAutonomousManuscriptSubstantiveAgentProse({
    draft: sourceDraft,
    systemSeedDraft,
  });
  if (!substantiveInspection.valid) {
    throw new Error('generic_manuscript_fixture_substantive_prose_invalid');
  }
  const sourceDraftFile = Buffer.from(JSON.stringify(sourceDraft), 'utf8');
  const sourceDraftHash = hashBytes(sourceDraftFile);
  const manuscriptHash = renderedManuscriptHash || digest(`${campaignId}:main.tex`);
  const draftPath = 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json';
  const delegate = completedAgentReceipt({
    executorId: 'fixture-research-author',
    agentId: 'research-author',
    changedPaths: [draftPath],
  });
  const postimage = buildAgentWorkspacePostimageBinding({
    changedPaths: delegate.changedPaths,
    files: [{ path: draftPath, hash: sourceDraftHash }],
  });
  const before = [{ path: draftPath, hash: digest(`${campaignId}:draft-before`) }];
  const after = [{ path: draftPath, hash: sourceDraftHash }];
  const merge = buildIsolatedAgentMergeReceipt({
    delegateExecutorId: delegate.executorId,
    delegateAgentExecutionReceipt: delegate,
    changedPaths: delegate.changedPaths,
    agentWorkspacePostimageBinding: postimage,
    sourcePreimage: before,
    isolatedPreimage: before,
    isolatedPostimage: after,
    sourcePostimage: after,
    workspaceContentPolicy: buildIsolatedAgentWorkspaceContentPolicy(),
  });
  const mergedAgentReceipt = Object.freeze({
    ...delegate,
    agentWorkspacePostimageBinding: postimage,
    isolatedAgentMergeReceiptHash: merge.isolatedAgentMergeReceiptHash,
    isolatedAgentMergeReceipt: merge,
  });
  const manuscriptIr = finalizeEvidenceBoundManuscriptIr({
    draft: sourceDraft,
    authorityBindings: [{ kind: 'prior-art-evidence', hash: priorArtHash }],
    priorArtReceipt,
    agentExecutionReceipt: mergedAgentReceipt,
  });
  const manuscriptIrHash = manuscriptIr.evidenceBoundManuscriptIrHash;
  const manuscriptIrFileHash = hashBytes(Buffer.from(JSON.stringify(manuscriptIr), 'utf8'));
  const seedPayload = {
    version: 1,
    kind: 'AutonomousResearchSeedContractBundle',
    paperId,
    campaignId,
    seedBindingHash,
  };
  const seedBundle = Object.freeze({
    ...seedPayload,
    autonomousResearchSeedContractBundleHash:
      hashRecord('AutonomousResearchSeedContractBundle', seedPayload),
  });
  const submission = externalSubmission
    ? productionSubmissionAuthoritiesFixture({
      paperId,
      protocolFamily,
      objective,
      requireExternalSubmission: launchMode === 'production-run',
    })
    : { venueProfileSelection: null, submissionMetadataReceipt: null };
  const venueRequirementIr = submission.venueProfileSelection
    ? buildVenueRequirementIr({
      researchAgendaIr,
      venueProfileSelection: submission.venueProfileSelection,
    }) : null;
  const renderPayload = {
    version: 6,
    kind: 'TrustedAutonomousManuscriptRenderReceipt',
    status: 'trusted_autonomous_manuscript_rendered',
    paperId,
    campaignId,
    manuscriptPath: 'main.tex',
    manuscriptHash,
    evidenceBoundManuscriptIrHash: manuscriptIrHash,
    manuscriptIrFileHash,
    manuscriptIrPath: 'AUTONOMOUS_MANUSCRIPT_IR.json',
    sectionModel: 'evidence-bound-manuscript-ir-v1',
    manuscriptProductionMode: 'agent-authored-evidence-bound-ir-v1',
    requireAgentAuthoredProse: true,
    agentAuthoredRenderedProseAccepted: true,
    substantiveAgentProseVerified: true,
    substantivelyRewrittenSectionCount:
      substantiveInspection.substantivelyRewrittenSectionCount,
    substantivelyRewrittenBlockCount:
      substantiveInspection.substantivelyRewrittenBlockCount,
    agentAuthoredRenderedProseReceiptHash: delegate.agentExecutionReceiptHash,
    substantiveAgentProseInspectionHash:
      substantiveInspection.autonomousManuscriptSubstantiveAgentProseInspectionHash,
    substantiveAgentProseInspection: substantiveInspection,
    systemSeedManuscriptIrDraft: systemSeedDraft,
    systemSeedManuscriptIrDraftHash: substantiveInspection.systemSeedDraftHash,
    agentAuthoredSourceDraft: sourceDraft,
    agentAuthoredSourceDraftHash: sourceDraftHash,
    agentAuthoredSourceDraftFileHash: sourceDraftHash,
    agentWorkspacePostimageBindingHash: postimage.agentWorkspacePostimageBindingHash,
    priorArtEvidenceReceiptHash: priorArtHash,
    seedBundleHash: seedBundle.autonomousResearchSeedContractBundleHash,
    venueProfileSelectionHash:
      submission.venueProfileSelection?.autonomousVenueProfileSelectionReceiptHash || null,
    submissionMetadataReceiptHash:
      submission.submissionMetadataReceipt?.autonomousSubmissionMetadataReceiptHash || null,
    venueRequirementIrHash: venueRequirementIr?.venueRequirementIrHash || null,
    venueRequirementIrFileHash: venueRequirementIr
      ? hashBytes(Buffer.from(JSON.stringify(venueRequirementIr), 'utf8')) : null,
    venueRequirementIrPath: venueRequirementIr
      ? 'AUTONOMOUS_VENUE_REQUIREMENT_IR.json' : null,
    anonymousReviewApplied: venueRequirementIr?.anonymousReview === true,
    venueTemplateAssetApplicationMode:
      submission.venueProfileSelection?.venueTemplateAsset?.applicationMode || null,
    venueTemplateAssetPath:
      submission.venueProfileSelection?.venueTemplateAsset?.relativePath || null,
    venueTemplateAssetHash:
      submission.venueProfileSelection?.venueTemplateAsset?.templateAssetHash || null,
    venueTemplateAssetFileHash:
      submission.venueProfileSelection?.venueTemplateAsset?.templateAssetHash || null,
    unboundScientificProseAccepted: false,
    externalActionPerformed: false,
  };
  const renderReceipt = Object.freeze({
    ...renderPayload,
    trustedAutonomousManuscriptRenderReceiptHash:
      hashRecord('TrustedAutonomousManuscriptRenderReceipt', renderPayload),
  });
  const resultPayload = {
    version: 1,
    kind: 'CampaignTrustedAutonomousManuscriptResult',
    status: 'campaign_trusted_autonomous_manuscript_completed',
    agentExecutionReceiptHash: delegate.agentExecutionReceiptHash,
    agentExecutionReceipt: mergedAgentReceipt,
    changedPaths: delegate.changedPaths,
    trustedAutonomousManuscriptRenderReceiptHash:
      renderReceipt.trustedAutonomousManuscriptRenderReceiptHash,
    trustedAutonomousManuscriptRenderReceipt: renderReceipt,
  };
  const result = Object.freeze({
    ...resultPayload,
    campaignTrustedAutonomousManuscriptResultHash:
      hashRecord('CampaignTrustedAutonomousManuscriptResult', resultPayload),
  });
  const trustedAutonomousManuscriptResult = includeProof ? Object.freeze({
    nodeId: `${campaignId}:revise`,
    attemptId: 'attempt:revise:1',
    leaseGeneration: 1,
    resultHash: hashRecord('PaperCampaignNodeResult', result),
    result,
  }) : null;
  const generatedPreparationPayload = {
    launchMode,
    proposal,
    policyAuthorization: { autonomousResearchPolicyAuthorizationHash: policyAuthorizationHash },
    seedBinding: { autonomousResearchSeedBindingHash: seedBindingHash },
    capabilityScopeManifest,
    capabilityScopeManifestHash:
      capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
    researchAgendaProducerReceipt: agendaReceipt,
    researchAgendaIr,
    agendaClaimBindingReceipt,
    dynamicFormalClaimSeed: productionContentLineage.dynamicFormalClaimSeed,
    researchContentProducerReceipt:
      productionContentLineage.researchContentProducerReceipt,
    externalCapabilityTrustInspection,
    externalCapabilityTrustInspectionHash:
      externalCapabilityTrustInspection
        .autonomousResearchExternalCapabilityTrustInspectionHash,
    priorArtReceipt,
    priorArtAuthorityVerificationBundle,
    priorArtAuthorityVerificationBundleHash:
      priorArtAuthorityVerificationBundle
        .priorArtRetrievalAuthorityVerificationBundleHash,
    priorArtAuthorityTrustConfiguration,
    priorArtAuthorityTrustConfigurationHash:
      priorArtAuthorityTrustConfiguration.priorArtAuthorityTrustConfigurationHash,
    priorArtClaimAlignmentReceipt,
    venueRequirementIr,
    venueTemplateAsset: submission.venueProfileSelection?.venueTemplateAsset || null,
    venueTemplateAssetBundleHash:
      submission.venueProfileSelection?.venueTemplateAssetBundleHash || null,
    venueTemplateAssetAuthorityConfigurationHash:
      submission.venueProfileSelection?.venueAuthorityConfigurationHash || null,
    observedAt: FIXED_TIME,
    venueProfileSelection: submission.venueProfileSelection,
    submissionMetadataReceipt: submission.submissionMetadataReceipt,
    autonomousResearchProviderConfigurationHash:
      productionAuthorityBinding.autonomousResearchProviderConfigurationHash,
    researchPrincipalPoolHash:
      productionAuthorityBinding.runtimePrincipalBinding.researchPrincipalPoolHash,
    runtimePrincipalBinding: productionAuthorityBinding.runtimePrincipalBinding,
    runtimePrincipalBindingHash: productionAuthorityBinding.runtimePrincipalBindingHash,
    productionAuthorityBinding,
    productionAuthorityBindingHash:
      productionAuthorityBinding.autonomousResearchAgentProductionAuthorityBindingHash,
  };
  if (machineIntake) {
    generatedPreparationPayload.autonomousResearchProviderConfigurationHash =
      machineIntake.providerConfigurationHash;
  }
  if (machineIntakeAdmission) {
    generatedPreparationPayload.autonomousResearchMachineIntakeAdmissionHash =
      machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash;
  }
  const generatedPreparation = Object.freeze({
    ...generatedPreparationPayload,
    autonomousResearchLoopPreparationReportHash: hashRecord(
      'AutonomousResearchLoopPreparationReport',
      generatedPreparationPayload,
    ),
  });
  const releasePreparation = bindingPreparation || generatedPreparation;
  const recursiveClosureRequested = externalSubmission === true
    && (launchMode === 'production-run' || includeResearchReport === true);
  const experimentClosure = recursiveClosureRequested
    ? productionExperimentClosureFixture({
      campaignId,
      paperId,
      campaignPlanHash,
      researchAgendaIr,
      researchAgendaProducerReceipt: agendaReceipt,
      proposal,
      researchAgendaClaimBindingReceipt: agendaClaimBindingReceipt,
    }) : null;
  const researchReport = experimentClosure
    ? productionResearchReportFixture({
      paperId,
      campaignId,
      proposal,
      seedBindingHash,
      claimAuthorityBundleHash:
        seedBundle.autonomousResearchSeedContractBundleHash,
      experimentRegistry: experimentClosure.experimentRegistry,
    }) : null;
  const reviewerEvidence = launchMode === 'production-run'
    ? productionReviewerEvidenceFixture({
      campaignId,
      campaignPlanHash,
      paperId,
      manuscriptHash,
      runtimePrincipalBinding: productionAuthorityBinding.runtimePrincipalBinding,
    }) : Object.freeze({});
  const releaseBinding = createAutonomousResearchReleaseBinding({
    campaignId,
    paperId,
    campaignPlanHash,
    preparation: releasePreparation,
    machineIntake,
    machineIntakeAdmission,
    manuscriptPath: 'main.tex',
    renderedManuscriptHash: manuscriptHash,
    evidenceBoundManuscriptIrHash: manuscriptIrHash,
    manuscriptIrFileHash,
    agentAuthoredSourceDraft: sourceDraft,
    agentAuthoredSourceDraftFileHash: sourceDraftHash,
    trustedAutonomousManuscriptResult,
    researchReport,
    experimentIrExecutionAuthorityReceipt:
      experimentClosure?.experimentIrExecutionAuthorityReceipt || null,
    experimentReplayReceipt:
      experimentClosure?.experimentReplayReceipt || null,
    ...reviewerEvidence,
  });
  return Object.freeze({
    releaseBinding,
    refereeConvergenceDecision: reviewerEvidence.refereeConvergenceDecision || null,
    reviewerEvidenceAuthority: reviewerEvidence.reviewerEvidenceAuthority || null,
    preparation: releasePreparation,
    generatedPreparation,
    trustedAutonomousManuscriptResult,
    sourceDraft,
    manuscriptIr,
    manuscriptIrFileHash,
    priorArtReceipt,
    seedBundle,
    agentExecutionReceipt: mergedAgentReceipt,
    venueProfileSelection: submission.venueProfileSelection,
    submissionMetadataReceipt: submission.submissionMetadataReceipt,
    researchAgendaIr,
    agendaClaimBindingReceipt,
    priorArtClaimAlignmentReceipt,
    venueRequirementIr,
    experimentIrExecutionAuthorityReceipt:
      experimentClosure?.experimentIrExecutionAuthorityReceipt || null,
    experimentReplayReceipt:
      experimentClosure?.experimentReplayReceipt || null,
    originalExperimentRunReceipt:
      experimentClosure?.originalRunReceipt || null,
    replayExperimentRunReceipt:
      experimentClosure?.replayRunReceipt || null,
    originalExperimentRawEventDocument:
      experimentClosure?.originalRawEventDocument || null,
    replayExperimentRawEventDocument:
      experimentClosure?.replayRawEventDocument || null,
    experimentRegistry:
      experimentClosure?.experimentRegistry || null,
    experimentRegistryAuthorityVerifier:
      experimentClosure?.experimentRegistryAuthorityVerifier || null,
    researchReport,
  });
}

export function bindGenericGoldenPreparationFixture({
  basePreparation,
  machineIntake,
  machineIntakeAdmission,
  campaignPlanHash = digest(`golden-preparation:${machineIntake?.campaignId || 'unknown'}`),
} = {}) {
  const fixtureInput = {
    campaignId: machineIntake?.campaignId,
    paperId: machineIntake?.paperId,
    launchMode: machineIntake?.launchMode,
    objective: machineIntake?.objective,
    protocolFamily: machineIntake?.protocolFamily,
    campaignPlanHash,
    externalSubmission: true,
    machineIntake,
    machineIntakeAdmission,
  };
  const draft = genericManuscriptReleaseFixture(fixtureInput);
  const policyAuthorization = evaluateAutonomousResearchPolicy({
    proposal: draft.preparation.proposal,
    externalDatasetAuthorityVerified: true,
    requestedRevisionRounds: machineIntake?.revisionRounds,
    requestedRefereeCount: machineIntake?.refereeCount,
    evaluatedAt: machineIntake?.admissionCreatedAt,
  });
  const seedBundle = buildAutonomousResearchSeedContractBundle({
    proposal: draft.preparation.proposal,
    policyAuthorization,
    evidencePlan: ['Bind every promoted claim to independently verified evidence.'],
    reproducibilityPlan: ['Require an isolated deterministic replay.'],
    createdAt: machineIntake?.admissionCreatedAt,
  });
  const seedBinding = buildAutonomousResearchSeedBinding({ seedBundle });
  const fixture = genericManuscriptReleaseFixture({
    ...fixtureInput,
    policyAuthorizationHash:
      policyAuthorization.autonomousResearchPolicyAuthorizationHash,
    seedBindingHash: seedBinding.autonomousResearchSeedBindingHash,
  });
  const {
    autonomousResearchLoopPreparationReportHash: _baseHash,
    ...basePayload
  } = basePreparation || {};
  const {
    autonomousResearchLoopPreparationReportHash: _fixtureHash,
    ...fixturePreparationPayload
  } = fixture.preparation || {};
  const merged = {
    ...basePayload,
    ...fixturePreparationPayload,
    policyAuthorization,
    seedBundle,
    seedBinding,
    launchMode: machineIntake?.launchMode,
    autonomousResearchProviderConfigurationHash:
      machineIntake?.providerConfigurationHash,
    autonomousResearchMachineIntakeAdmission: machineIntakeAdmission,
    autonomousResearchMachineIntakeAdmissionHash:
      machineIntakeAdmission?.autonomousResearchMachineIntakeAdmissionHash,
    empiricalRuntimeCapabilityInspection:
      basePreparation?.empiricalRuntimeCapabilityInspection,
    runtimeImageReproducibilityInspection:
      basePreparation?.runtimeImageReproducibilityInspection,
    empiricalExecutionProfileSelection:
      basePreparation?.empiricalExecutionProfileSelection,
    principalSeparation: basePreparation?.principalSeparation,
    researchPrincipalPool: basePreparation?.researchPrincipalPool,
    topologyTemplate: basePreparation?.topologyTemplate,
    topologyInspection: basePreparation?.topologyInspection,
    datasetLaunchInspection: basePreparation?.datasetLaunchInspection,
    createdAt: machineIntake?.admissionCreatedAt,
  };
  const qualificationEligibility = evaluateAutonomousResearchQualificationEligibility({
    proposal: merged.proposal,
    policyAuthorization,
    seedBundle,
    seedBinding,
    principalSeparation: merged.principalSeparation,
    topologyInspection: merged.topologyInspection,
    datasetLaunchInspection: merged.datasetLaunchInspection,
    empiricalRuntimeCapabilityInspection:
      merged.empiricalRuntimeCapabilityInspection,
    empiricalExecutionProfileSelection:
      merged.empiricalExecutionProfileSelection,
    runtimeImageReproducibilityInspection:
      merged.runtimeImageReproducibilityInspection,
    launchMode: merged.launchMode,
    observedAt: merged.createdAt,
  });
  const payload = {
    ...merged,
    status: qualificationEligibility.status,
    qualificationEligibility,
    autonomousExecutionLaunchReady:
      qualificationEligibility.autonomousExecutionLaunchReady,
    qualificationRequestEligible:
      qualificationEligibility.qualificationRequestEligible,
    campaignFullyQualified: false,
    fullAutomaticResearchWritingReady: false,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchLoopPreparationReportHash:
      hashRecord('AutonomousResearchLoopPreparationReport', payload),
  });
}
