import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  buildResearchClosureReceipt,
  inspectResearchReportForClosure,
  verifyResearchClosureReceipt,
} from '../../paper-domain/automation/research-closure-receipt-contract.mjs';
import {
  formalClosureClaimBindingsFromProposalBinding,
  verifyGenericFormalCertificateIntakeClosureBinding,
} from '../../paper-domain/research/formal-certificate-intake.mjs';
import {
  verifyAutonomousSubmissionRequest,
} from '../../paper-domain/automation/autonomous-submission-contract.mjs';
import {
  fullResearchQualificationSigningPayloadHash,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import {
  buildVenueRequirementObservations,
  verifyAutonomousVenueComplianceReceipt,
} from '../../paper-domain/automation/autonomous-venue-compliance-contract.mjs';
import {
  deriveVenueRequirementObservationsFromSourceEvidence,
} from '../../paper-domain/automation/autonomous-venue-source-evidence-contract.mjs';
import {
  sealReceiptHash,
} from '../../paper-domain/evidence/receipt-hash-policy.mjs';
import {
  hashPaperRecord,
} from '../../paper-domain/contracts/primitives.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  genericManuscriptReleaseFixture,
  priorArtV2Fixture,
  productionResearchClosureFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import {
  assertProductionCampaignCapsuleRawDocuments,
} from './support/production-campaign-release-closure-fixture.mjs';
import {
  assertProductionExperimentClosureResult,
} from './support/production-experiment-closure-fixture.mjs';

function rehash(record, kind, hashField) {
  const { [hashField]: _oldHash, ...payload } = record;
  return Object.freeze({
    ...payload,
    [hashField]: hashRecord(kind, payload),
  });
}

function verifyFixtureClosure(fixture, receipt) {
  return verifyResearchClosureReceipt(receipt, {}, {
    verifyQualificationSignature: fixture.qualificationSignatureVerifier,
    verifyIndependentQualificationEvidence:
      fixture.qualificationIndependentEvidenceVerifier,
  });
}

function rehashResearchReportWithPaper(report, paperId) {
  const native = structuredClone(report.nativeResearchWorkerExecution);
  const worker = native.workerReceipts[0];
  const {
    nativeResearchWorkerExecutionReceiptHash: _oldWorkerHash,
    ...workerPayload
  } = worker;
  const changedTaskKey = `paper_factory:${paperId}`;
  const changedWorker = sealReceiptHash({
    ...workerPayload,
    paperId,
    taskKey: changedTaskKey,
  }, { hashField: 'nativeResearchWorkerExecutionReceiptHash' });
  const {
    nativeResearchWorkerExecutionReportHash: _oldReportHash,
    ...nativePayload
  } = native;
  const changedNativePayload = {
    ...nativePayload,
    paperId,
    taskKey: changedTaskKey,
    workerReceipts: [changedWorker],
    workerReceiptHashes: [
      changedWorker.nativeResearchWorkerExecutionReceiptHash,
    ],
  };
  const changedNative = Object.freeze({
    ...changedNativePayload,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord(
      'NativeResearchWorkerExecutionReport',
      changedNativePayload,
    ),
  });
  const { researchReportHash: _oldResearchHash, ...reportPayload } = report;
  const changedReportPayload = {
    ...reportPayload,
    paperId,
    taskKey: changedTaskKey,
    nativeResearchWorkerExecution: changedNative,
  };
  return Object.freeze({
    ...changedReportPayload,
    researchReportHash: hashPaperRecord(
      'PaperResearchVerifyReport',
      changedReportPayload,
    ),
  });
}

function rehashResearchReportWithCampaign(report, campaignId) {
  const proposalBinding = rehash({
    ...structuredClone(report.capabilities.proposalClaimToTheoremBinding),
    campaignId,
  }, 'ProposalClaimToTheoremBinding', 'proposalClaimToTheoremBindingHash');
  const sourceSnapshot = rehash({
    ...structuredClone(report.campaignResearchSourceSnapshot),
    campaignId,
    researchNodeId: `${campaignId}:2:research-verify`,
    researchAttemptId: `${campaignId}:research-attempt-1`,
  }, 'CampaignResearchSourceSnapshot', 'campaignResearchSourceSnapshotHash');
  const native = structuredClone(report.nativeResearchWorkerExecution);
  const worker = native.workerReceipts[0];
  const {
    nativeResearchWorkerExecutionReceiptHash: _oldWorkerHash,
    ...workerPayload
  } = worker;
  const changedWorker = sealReceiptHash({
    ...workerPayload,
    jobId: `${campaignId}:formal-job`,
    attemptId: `${campaignId}:formal-attempt-1`,
  }, { hashField: 'nativeResearchWorkerExecutionReceiptHash' });
  const {
    nativeResearchWorkerExecutionReportHash: _oldNativeHash,
    ...nativePayload
  } = native;
  const changedNativePayload = {
    ...nativePayload,
    workerReceipts: [changedWorker],
    workerReceiptHashes: [
      changedWorker.nativeResearchWorkerExecutionReceiptHash,
    ],
  };
  const changedNative = Object.freeze({
    ...changedNativePayload,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord(
      'NativeResearchWorkerExecutionReport',
      changedNativePayload,
    ),
  });
  const { researchReportHash: _oldResearchHash, ...reportPayload } = report;
  const changedReportPayload = {
    ...reportPayload,
    researchNodeId: sourceSnapshot.researchNodeId,
    researchAttemptId: sourceSnapshot.researchAttemptId,
    campaignResearchSourceSnapshotHash:
      sourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot: sourceSnapshot,
    proposalClaimToTheoremBindingHash:
      proposalBinding.proposalClaimToTheoremBindingHash,
    capabilities: {
      ...structuredClone(report.capabilities),
      proposalClaimToTheoremBinding: proposalBinding,
    },
    nativeResearchWorkerExecution: changedNative,
  };
  return Object.freeze({
    ...changedReportPayload,
    researchReportHash: hashPaperRecord(
      'PaperResearchVerifyReport',
      changedReportPayload,
    ),
  });
}

function rehashResearchReportWithFormalIntake(report, mutate) {
  const capabilities = structuredClone(report.capabilities);
  const changedIntake = structuredClone(capabilities.formalCertificateIntakes[0]);
  mutate(changedIntake);
  capabilities.formalCertificateIntakes = [rehash(
    changedIntake,
    'GenericFormalCertificateIntake',
    'genericFormalCertificateIntakeHash',
  )];
  const { researchReportHash: _oldResearchHash, ...reportPayload } = report;
  const changedReportPayload = {
    ...structuredClone(reportPayload),
    capabilities,
  };
  return Object.freeze({
    ...changedReportPayload,
    researchReportHash: hashPaperRecord(
      'PaperResearchVerifyReport',
      changedReportPayload,
    ),
  });
}

function rehashResearchReportWithNativeReplay(report, mutate) {
  const native = structuredClone(report.nativeResearchWorkerExecution);
  const worker = native.workerReceipts[0];
  const replay = worker.result.replayReceipt;
  mutate(replay);
  worker.result.replayReceipt = rehash(
    replay,
    'FormalCertificateReplayReceipt',
    'formalCertificateReplayReceiptHash',
  );
  worker.result.formalCertificateReplayReceiptHash =
    worker.result.replayReceipt.formalCertificateReplayReceiptHash;
  worker.resultHash = hashPaperRecord(
    'NativeResearchWorkerResult',
    worker.result,
  );
  const {
    nativeResearchWorkerExecutionReceiptHash: _oldWorkerHash,
    ledgerReceiptId,
    ...workerPayload
  } = worker;
  const resealedWorker = sealReceiptHash(workerPayload, {
    hashField: 'nativeResearchWorkerExecutionReceiptHash',
  });
  const changedWorker = Object.freeze({ ...resealedWorker, ledgerReceiptId });
  const {
    nativeResearchWorkerExecutionReportHash: _oldNativeHash,
    ...nativePayload
  } = native;
  const changedNativePayload = {
    ...nativePayload,
    workerReceipts: [changedWorker],
    workerReceiptHashes: [
      changedWorker.nativeResearchWorkerExecutionReceiptHash,
    ],
  };
  const changedNative = Object.freeze({
    ...changedNativePayload,
    nativeResearchWorkerExecutionReportHash: hashPaperRecord(
      'NativeResearchWorkerExecutionReport',
      changedNativePayload,
    ),
  });
  const { researchReportHash: _oldResearchHash, ...reportPayload } = report;
  const changedReportPayload = {
    ...structuredClone(reportPayload),
    nativeResearchWorkerExecution: changedNative,
  };
  return Object.freeze({
    ...changedReportPayload,
    researchReportHash: hashPaperRecord(
      'PaperResearchVerifyReport',
      changedReportPayload,
    ),
  });
}

function rehashNestedClosure(fixture, {
  bindingChanges = {},
  researchReport = fixture.manuscript.researchReport,
  complianceChanges = {},
} = {}) {
  const changedBinding = rehash({
    ...structuredClone(fixture.releaseBinding),
    ...bindingChanges,
    researchReportHash: researchReport.researchReportHash,
    proposalClaimToTheoremBindingHash:
      researchReport.proposalClaimToTheoremBindingHash,
    experimentRegistryHash: researchReport.experimentRegistryHash,
  }, 'AutonomousResearchReleaseBinding', 'autonomousResearchReleaseBindingHash');
  const campaignResearchSourceSnapshot =
    researchReport.campaignResearchSourceSnapshot;
  const changedPromotionCandidate = rehash({
    ...structuredClone(fixture.promotionCandidate),
    autonomousResearchReleaseBindingHash:
      changedBinding.autonomousResearchReleaseBindingHash,
    autonomousResearchReleaseBinding: changedBinding,
    researchReportHash: researchReport.researchReportHash,
    proposalClaimToTheoremBindingHash:
      researchReport.proposalClaimToTheoremBindingHash,
    experimentRegistryHash: researchReport.experimentRegistryHash,
    campaignResearchSourceSnapshotHash:
      campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot,
    researchVerifyNodeId: researchReport.researchNodeId,
    researchVerifyAttemptId: researchReport.researchAttemptId,
    researchVerifyLeaseGeneration: researchReport.researchLeaseGeneration,
  }, 'AutomationPromotionCandidate', 'automationPromotionCandidateHash');
  const changedBundle = rehash({
    ...structuredClone(fixture.releaseBundle),
    automationPromotionCandidateHash:
      changedPromotionCandidate.automationPromotionCandidateHash,
    autonomousResearchReleaseBindingHash:
      changedBinding.autonomousResearchReleaseBindingHash,
    autonomousResearchReleaseBinding: changedBinding,
    promotionCandidate: changedPromotionCandidate,
    researchReportHash: researchReport.researchReportHash,
    proposalClaimToTheoremBindingHash:
      researchReport.proposalClaimToTheoremBindingHash,
    experimentRegistryHash: researchReport.experimentRegistryHash,
    researchReport,
    campaignResearchSourceSnapshotHash:
      campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignResearchSourceSnapshot,
    researchVerifyNodeId: researchReport.researchNodeId,
    researchVerifyAttemptId: researchReport.researchAttemptId,
    researchVerifyLeaseGeneration: researchReport.researchLeaseGeneration,
  }, 'CampaignReleaseBundle', 'campaignReleaseBundleHash');
  const changedAuthority = Object.freeze({
    ...structuredClone(fixture.campaignReleaseAuthority),
    campaignReleaseBundleHash: changedBundle.campaignReleaseBundleHash,
    releaseBundle: changedBundle,
  });
  const qualificationReceipt = rehash({
    ...structuredClone(fixture.qualificationInspection.qualificationReceipt),
    campaignReleaseBundleHash: changedBundle.campaignReleaseBundleHash,
  }, 'FullResearchGoldenMicroCampaignQualificationReceipt',
  'fullResearchQualificationReceiptHash');
  const qualificationInspection = rehash({
    ...structuredClone(fixture.qualificationInspection),
    campaignReleaseBundleHash: changedBundle.campaignReleaseBundleHash,
    qualificationReceiptHash:
      qualificationReceipt.fullResearchQualificationReceiptHash,
    qualificationReceipt,
  }, 'FullResearchQualificationInspection',
  'fullResearchQualificationInspectionHash');
  const sourceEvidenceBase = structuredClone(
    complianceChanges.sourceEvidenceBundle || fixture.sourceEvidenceBundle,
  );
  const pdfInspectionReceipt = rehash({
    ...sourceEvidenceBase.pdfInspectionReceipt,
    campaignReleaseBundleHash: changedBundle.campaignReleaseBundleHash,
  }, 'DeterministicPdfPageInspectionReceipt',
  'deterministicPdfPageInspectionReceiptHash');
  const sourceInspectionReceipt = rehash({
    ...sourceEvidenceBase.sourceInspectionReceipt,
    campaignReleaseBundleHash: changedBundle.campaignReleaseBundleHash,
  }, 'AutonomousVenueSourceInspectionReceipt', 'sourceInspectionReceiptHash');
  const releaseArtifactEvidence = rehash({
    ...sourceEvidenceBase.releaseArtifactEvidence,
    campaignReleaseBundleHash: changedBundle.campaignReleaseBundleHash,
  }, 'VenueReleaseArtifactEvidence', 'venueReleaseArtifactEvidenceHash');
  const sourceEvidenceBundle = rehash({
    ...sourceEvidenceBase,
    sourceInspectionReceiptHash:
      sourceInspectionReceipt.sourceInspectionReceiptHash,
    sourceInspectionReceipt,
    pdfInspectionReceiptHash:
      pdfInspectionReceipt.deterministicPdfPageInspectionReceiptHash,
    pdfInspectionReceipt,
    venueReleaseArtifactEvidenceHash:
      releaseArtifactEvidence.venueReleaseArtifactEvidenceHash,
    releaseArtifactEvidence,
  }, 'AutonomousVenueSourceEvidenceBundle',
  'autonomousVenueSourceEvidenceBundleHash');
  const observationBase = structuredClone(
    complianceChanges.venueRequirementObservations
      || fixture.venueRequirementObservations,
  );
  const venueRequirementObservations = rehash({
    ...observationBase,
    sourceEvidenceBundleHash:
      sourceEvidenceBundle.autonomousVenueSourceEvidenceBundleHash,
    sourceInspectionReceiptHash:
      sourceInspectionReceipt.sourceInspectionReceiptHash,
  }, 'VenueRequirementObservations', 'venueRequirementObservationHash');
  const venueComplianceReceipt = rehash({
    ...structuredClone(fixture.venueComplianceReceipt),
    campaignReleaseBundleHash: changedBundle.campaignReleaseBundleHash,
    autonomousResearchReleaseBindingHash:
      changedBinding.autonomousResearchReleaseBindingHash,
    ...complianceChanges,
    sourceInspectionReceiptHash:
      sourceInspectionReceipt.sourceInspectionReceiptHash,
    sourceEvidenceBundleHash:
      sourceEvidenceBundle.autonomousVenueSourceEvidenceBundleHash,
    sourceEvidenceBundle,
    venueRequirementObservationHash:
      venueRequirementObservations.venueRequirementObservationHash,
    venueRequirementObservations,
  }, 'AutonomousVenueComplianceReceipt',
  'autonomousVenueComplianceReceiptHash');
  const closure = rehash({
    ...structuredClone(fixture.researchClosureReceipt),
    campaignReleaseAuthority: changedAuthority,
    campaignReleaseBundleHash: changedBundle.campaignReleaseBundleHash,
    qualificationInspection,
    qualificationReceiptHash:
      qualificationInspection.qualificationReceiptHash,
    venueComplianceReceipt,
    venueComplianceReceiptHash:
      venueComplianceReceipt.autonomousVenueComplianceReceiptHash,
    researchReportHash: changedBinding.researchReportHash,
    proposalClaimToTheoremBindingHash:
      changedBinding.proposalClaimToTheoremBindingHash,
    experimentRegistryHash: changedBinding.experimentRegistryHash,
    researchAgendaIrHash: changedBinding.researchAgendaIrHash,
    researchAgendaClaimBindingReceiptHash:
      changedBinding.researchAgendaClaimBindingReceiptHash,
    priorArtEvidenceReceiptHash: changedBinding.priorArtEvidenceReceiptHash,
    priorArtClaimAlignmentReceiptHash:
      changedBinding.priorArtClaimAlignmentReceiptHash,
    experimentIrExecutionAuthorityReceiptHash:
      changedBinding.experimentIrExecutionAuthorityReceiptHash,
    experimentReplayReceiptHash: changedBinding.experimentReplayReceiptHash,
    venueRequirementIrHash: changedBinding.venueRequirementIrHash,
  }, 'ResearchClosureReceipt', 'researchClosureReceiptHash');
  return Object.freeze({
    closure,
    changedBinding,
    changedBundle,
    campaignReleaseAuthority: changedAuthority,
    venueComplianceReceipt,
  });
}

function rehashVenueObservationAttack(fixture, mutate) {
  const changedObservationPayload = structuredClone(
    fixture.venueRequirementObservations,
  );
  mutate(changedObservationPayload);
  const changedObservations = rehash(
    changedObservationPayload,
    'VenueRequirementObservations',
    'venueRequirementObservationHash',
  );
  return rehashNestedClosure(fixture, {
    complianceChanges: {
      venueRequirementObservationHash:
        changedObservations.venueRequirementObservationHash,
      venueRequirementObservations: changedObservations,
    },
  });
}

function rehashVenueIrFileHashSwapAttack(fixture) {
  const sourceEvidenceBundle = structuredClone(fixture.sourceEvidenceBundle);
  const manuscriptIrFileHash = sourceEvidenceBundle.manuscriptIrFileHash;
  sourceEvidenceBundle.manuscriptIrFileHash =
    sourceEvidenceBundle.venueRequirementIrFileHash;
  sourceEvidenceBundle.venueRequirementIrFileHash = manuscriptIrFileHash;
  const changedSourceEvidenceBundle = rehash(
    sourceEvidenceBundle,
    'AutonomousVenueSourceEvidenceBundle',
    'autonomousVenueSourceEvidenceBundleHash',
  );
  const observations = structuredClone(fixture.venueRequirementObservations);
  observations.sourceEvidenceBundleHash =
    changedSourceEvidenceBundle.autonomousVenueSourceEvidenceBundleHash;
  observations.venueRequirementIrFileHash =
    changedSourceEvidenceBundle.venueRequirementIrFileHash;
  const changedObservations = rehash(
    observations,
    'VenueRequirementObservations',
    'venueRequirementObservationHash',
  );
  return rehashNestedClosure(fixture, {
    complianceChanges: {
      manuscriptIrFileHash: changedSourceEvidenceBundle.manuscriptIrFileHash,
      sourceEvidenceBundleHash:
        changedSourceEvidenceBundle.autonomousVenueSourceEvidenceBundleHash,
      sourceEvidenceBundle: changedSourceEvidenceBundle,
      venueRequirementObservationHash:
        changedObservations.venueRequirementObservationHash,
      venueRequirementObservations: changedObservations,
    },
  });
}

function forgedVerifiedNoncompliantSourceReceipt(fixture) {
  const sourceEvidence = structuredClone(fixture.sourceEvidenceBundle);
  const source = Buffer.from(
    sourceEvidence.sourceInspectionReceipt.manuscriptBytesBase64,
    'base64',
  ).toString('utf8').replace(
    `\\input{${fixture.releaseBinding.venueProfileSelection
      .venueTemplateAsset.relativePath}}\n`,
    '',
  );
  const sourceBytes = Buffer.from(source, 'utf8');
  const sourceTreeManifest = structuredClone(sourceEvidence.sourceTreeManifest);
  const mainRow = sourceTreeManifest.rows.find((row) => row.path === 'main.tex');
  mainRow.hash = hashBytes(sourceBytes);
  mainRow.bytes = sourceBytes.length;
  sourceTreeManifest.totalBytes = sourceTreeManifest.rows.reduce(
    (total, row) => total + row.bytes,
    0,
  );
  const changedSourceTreeManifest = rehash(
    sourceTreeManifest,
    'ScopedSourceTreeManifest',
    'sourceTreeManifestHash',
  );
  const sourceInspectionReceipt = rehash({
    ...sourceEvidence.sourceInspectionReceipt,
    manuscriptBytesBase64: sourceBytes.toString('base64'),
    manuscriptBytes: sourceBytes.length,
    renderedSourceHash: hashBytes(sourceBytes),
    sourceTreeManifestHash:
      changedSourceTreeManifest.sourceTreeManifestHash,
  }, 'AutonomousVenueSourceInspectionReceipt', 'sourceInspectionReceiptHash');
  const releaseArtifactEvidence = rehash({
    ...sourceEvidence.releaseArtifactEvidence,
    sourceTreeManifestHash:
      changedSourceTreeManifest.sourceTreeManifestHash,
  }, 'VenueReleaseArtifactEvidence', 'venueReleaseArtifactEvidenceHash');
  const changedSourceEvidence = rehash({
    ...sourceEvidence,
    sourceInspectionReceiptHash:
      sourceInspectionReceipt.sourceInspectionReceiptHash,
    sourceInspectionReceipt,
    sourceTreeManifestHash:
      changedSourceTreeManifest.sourceTreeManifestHash,
    sourceTreeManifest: changedSourceTreeManifest,
    venueReleaseArtifactEvidenceHash:
      releaseArtifactEvidence.venueReleaseArtifactEvidenceHash,
    releaseArtifactEvidence,
  }, 'AutonomousVenueSourceEvidenceBundle',
  'autonomousVenueSourceEvidenceBundleHash');
  const derived = deriveVenueRequirementObservationsFromSourceEvidence({
    sourceEvidenceBundle: changedSourceEvidence,
    venueRequirementIr: fixture.releaseBinding.venueRequirementIr,
  });
  const observations = buildVenueRequirementObservations({
    venueRequirementIr: fixture.releaseBinding.venueRequirementIr,
    sourceEvidenceBundle: changedSourceEvidence,
  });
  const receipt = rehash({
    ...structuredClone(fixture.venueComplianceReceipt),
    status: 'autonomous_venue_compliance_verified',
    blockers: [],
    renderedSourceHash: sourceInspectionReceipt.renderedSourceHash,
    sourceInspectionReceiptHash:
      sourceInspectionReceipt.sourceInspectionReceiptHash,
    sourceEvidenceBundleHash:
      changedSourceEvidence.autonomousVenueSourceEvidenceBundleHash,
    sourceEvidenceBundle: changedSourceEvidence,
    venueRequirementObservationHash:
      observations.venueRequirementObservationHash,
    venueRequirementObservations: observations,
  }, 'AutonomousVenueComplianceReceipt',
  'autonomousVenueComplianceReceiptHash');
  return Object.freeze({ derived, receipt });
}

function rehashedVerifiedOverPageAttack(fixture) {
  const pageCount = fixture.releaseBinding.venueProfileSelection.profile.maximumPages + 1;
  const venueRequirementObservations = rehash({
    ...structuredClone(fixture.venueRequirementObservations),
    pageCount,
  }, 'VenueRequirementObservations', 'venueRequirementObservationHash');
  return rehashNestedClosure(fixture, {
    complianceChanges: {
      status: 'autonomous_venue_compliance_verified',
      blockers: [],
      pageCount,
      venueRequirementObservationHash:
        venueRequirementObservations.venueRequirementObservationHash,
      venueRequirementObservations,
    },
  });
}

function rehashedFakeQualificationSignatureAttack(fixture) {
  const qualificationReceipt = rehash({
    ...structuredClone(
      fixture.qualificationInspection.qualificationReceipt,
    ),
    signature: Buffer.from('forged-qualification-signature', 'utf8')
      .toString('base64'),
  }, 'FullResearchGoldenMicroCampaignQualificationReceipt',
  'fullResearchQualificationReceiptHash');
  const qualificationInspection = rehash({
    ...structuredClone(fixture.qualificationInspection),
    ready: true,
    receiptAccepted: true,
    qualificationSignatureVerified: true,
    qualificationTimeWindowVerified: true,
    releasePointerVerified: true,
    independentVerifierVerified: true,
    fullDomainVerificationReady: true,
    qualificationReceiptHash:
      qualificationReceipt.fullResearchQualificationReceiptHash,
    qualificationReceipt,
  }, 'FullResearchQualificationInspection',
  'fullResearchQualificationInspectionHash');
  return rehash({
    ...structuredClone(fixture.researchClosureReceipt),
    qualificationReceiptHash:
      qualificationInspection.qualificationReceiptHash,
    qualificationInspection,
  }, 'ResearchClosureReceipt', 'researchClosureReceiptHash');
}

function rehashedSignedQualificationPriorArtSplice(fixture, priorArtEvidenceReceipt) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const original = fixture.qualificationInspection.qualificationReceipt;
  const {
    fullResearchQualificationReceiptHash: _receiptHash,
    signature: _signature,
    ...unsigned
  } = structuredClone(original);
  const changedUnsigned = {
    ...unsigned,
    independentHypothesisPriorArtReceiptHash:
      priorArtEvidenceReceipt.priorArtEvidenceReceiptHash,
    priorArtEvidenceReceipt,
  };
  const signingPayloadHash = fullResearchQualificationSigningPayloadHash(changedUnsigned);
  const signature = crypto.sign(
    null,
    Buffer.from(signingPayloadHash, 'utf8'),
    pair.privateKey,
  ).toString('base64');
  const qualificationReceipt = rehash({
    ...changedUnsigned,
    signature,
  }, 'FullResearchGoldenMicroCampaignQualificationReceipt',
  'fullResearchQualificationReceiptHash');
  const qualificationInspection = rehash({
    ...structuredClone(fixture.qualificationInspection),
    qualificationReceiptHash:
      qualificationReceipt.fullResearchQualificationReceiptHash,
    qualificationReceipt,
  }, 'FullResearchQualificationInspection',
  'fullResearchQualificationInspectionHash');
  const closure = rehash({
    ...structuredClone(fixture.researchClosureReceipt),
    qualificationReceiptHash:
      qualificationInspection.qualificationReceiptHash,
    qualificationInspection,
  }, 'ResearchClosureReceipt', 'researchClosureReceiptHash');
  const verifyQualificationSignature = (input = {}) => {
    try {
      return input.signingPayloadHash === signingPayloadHash
        && input.signature === signature
        && input.signedAt === qualificationReceipt.issuedAt
        && JSON.stringify(input.signer) === JSON.stringify(qualificationReceipt.signer)
        && crypto.verify(
          null,
          Buffer.from(input.signingPayloadHash, 'utf8'),
          pair.publicKey,
          Buffer.from(input.signature, 'base64'),
        );
    } catch { return false; }
  };
  assert.equal(verifyQualificationSignature({
    signingPayloadHash,
    signature,
    signer: qualificationReceipt.signer,
    signedAt: qualificationReceipt.issuedAt,
  }), true);
  return Object.freeze({ closure, verifyQualificationSignature });
}

test('production closure preflight binds exported raw documents to capsule entries', () => {
  const original = Buffer.from('original-raw-events\n', 'utf8');
  const replay = Buffer.from('replay-raw-events\n', 'utf8');
  const run = (document) => ({
    rawEventArtifactHash: hashBytes(document),
    rawEventArtifactBytes: document.length,
  });
  const result = assertProductionExperimentClosureResult({
    originalRunReceipt: run(original),
    replayRunReceipt: run(replay),
    originalRawEventDocument: original,
    replayRawEventDocument: replay,
  });
  assert.equal(Object.isFrozen(result), true);
  const experiments = [{
    experimentId: 'preflight-experiment',
    executions: [
      {
        executionRole: 'original',
        rawEventArtifactHash: hashBytes(original),
        rawEventArtifactBytes: original.length,
      },
      {
        executionRole: 'independent-replay',
        rawEventArtifactHash: hashBytes(replay),
        rawEventArtifactBytes: replay.length,
      },
    ],
  }];
  assert.equal(assertProductionCampaignCapsuleRawDocuments({
    experiments,
    manuscript: {
      originalExperimentRawEventDocument: original,
      replayExperimentRawEventDocument: replay,
    },
  }), true);
  assert.throws(() => assertProductionExperimentClosureResult({
    ...result,
    replayRawEventDocument: null,
  }), /production_experiment_closure_raw_export_invalid:independent-replay/);
  assert.throws(() => assertProductionCampaignCapsuleRawDocuments({
    experiments,
    manuscript: {
      originalExperimentRawEventDocument: original,
      replayExperimentRawEventDocument: null,
    },
  }), /production_campaign_release_capsule_raw_document_invalid/);
});

test('production research closure fixture is recursive and rejects rehashed agenda/paper splices', {
  timeout: 30 * 60 * 1_000,
}, (t) => {
  const fixture = productionResearchClosureFixture({
    paperId: 'paper-production-closure-fixture',
    campaignId: 'campaign-production-closure-fixture',
  });
  t.after(() => fixture.cleanup());
  assert.equal(fixture.releaseBinding.version, 4);
  assert.equal(fixture.manuscript.experimentRegistry.version, 4);
  assert.equal(fixture.manuscript.experimentRegistry.status, 'experiment_registry_ready');
  assert.equal(fixture.manuscript.experimentRegistry.academicExperimentCount, 1);
  assert.equal(fixture.venueComplianceReceipt.version, 3);
  const releaseCreatedAt = Date.parse(fixture.releaseBundle.createdAt);
  const qualificationIssuedAt = Date.parse(
    fixture.qualificationInspection.qualificationReceipt.issuedAt,
  );
  const closureTime = Date.parse(fixture.researchClosureReceipt.closedAt);
  const requestTime = Date.parse(fixture.submissionRequest.requestedAt);
  const qualificationExpiresAt = Date.parse(
    fixture.qualificationInspection.qualificationReceipt.expiresAt,
  );
  assert.ok(releaseCreatedAt < qualificationIssuedAt);
  assert.ok(qualificationIssuedAt <= closureTime);
  assert.ok(qualificationIssuedAt <= requestTime);
  assert.ok(closureTime < qualificationExpiresAt);
  assert.ok(requestTime < qualificationExpiresAt);
  assert.equal(
    fixture.sourceInspectionReceipt.renderedSourceHash,
    fixture.releaseBinding.renderedManuscriptHash,
  );
  assert.equal(
    Buffer.from(
      fixture.sourceInspectionReceipt.manuscriptBytesBase64,
      'base64',
    ).toString('utf8'),
    fixture.mainSource,
  );
  assert.equal(
    fixture.sourceEvidenceBundle.venueRequirementIrFileHash,
    hashBytes(Buffer.from(JSON.stringify(fixture.releaseBinding.venueRequirementIr), 'utf8')),
  );
  assert.notEqual(
    fixture.sourceEvidenceBundle.venueRequirementIrFileHash,
    fixture.sourceEvidenceBundle.manuscriptIrFileHash,
  );
  assert.equal(fixture.submissionRequest.version, 6);
  assert.equal(verifyFixtureClosure(fixture, fixture.researchClosureReceipt), true);
  assert.equal(
    verifyResearchClosureReceipt(fixture.researchClosureReceipt),
    false,
    'closure verification must fail closed without a qualification signature verifier',
  );
  assert.throws(() => buildResearchClosureReceipt({
    campaignReleaseAuthority: fixture.campaignReleaseAuthority,
    qualificationInspection: fixture.qualificationInspection,
    venueComplianceReceipt: fixture.venueComplianceReceipt,
    closedAt: fixture.closureTime,
  }), /research_closure_receipt_input_invalid/);
  assert.equal(
    verifyFixtureClosure(
      fixture,
      rehashedFakeQualificationSignatureAttack(fixture),
    ),
    false,
    'rehashed qualification booleans and a forged signature must be rejected',
  );
  const proposalBinding = fixture.manuscript.researchReport.capabilities
    .proposalClaimToTheoremBinding;
  const expectedFormalClaimBindings =
    formalClosureClaimBindingsFromProposalBinding(proposalBinding);
  const formalIntakeContext = {
    paperId: fixture.releaseBinding.paperId,
    campaignId: fixture.releaseBinding.campaignId,
    researchSourceSnapshotHash:
      fixture.releaseBundle.campaignResearchSourceSnapshotHash,
    taskKey: fixture.manuscript.researchReport.taskKey,
    expectedClaimBindings: expectedFormalClaimBindings,
    proposalBinding,
    nativeResearchWorkerExecution:
      fixture.manuscript.researchReport.nativeResearchWorkerExecution,
  };
  assert.equal(verifyGenericFormalCertificateIntakeClosureBinding(
    fixture.manuscript.researchReport.capabilities.formalCertificateIntakes[0],
    formalIntakeContext,
  ).valid, true);
  const formalIntakeSplices = [
    ['same-paper old-campaign', (intake) => {
      intake.campaignId = 'campaign-old-formal-intake';
    }, 'formal_certificate_intake_campaign_mismatch'],
    ['wrong source snapshot', (intake) => {
      intake.researchSourceSnapshotHash = hashRecord(
        'WrongFormalResearchSourceSnapshot',
        { paperId: fixture.releaseBinding.paperId },
      );
    }, 'formal_certificate_intake_research_source_snapshot_mismatch'],
    ['wrong statement', (intake) => {
      intake.claimBindings[0].statementHash = hashBytes(
        Buffer.from('attacker-selected same-paper theorem statement', 'utf8'),
      );
    }, 'formal_certificate_intake_claim_binding_mismatch'],
    ['wrong obligation', (intake) => {
      intake.claimBindings[0].obligationId = `obligation:${hashRecord(
        'WrongFormalProofObligation',
        { paperId: fixture.releaseBinding.paperId },
      ).slice('sha256:'.length)}`;
    }, 'formal_certificate_intake_claim_binding_mismatch'],
  ];
  for (const [label, mutate, expectedBlocker] of formalIntakeSplices) {
    const researchReport = rehashResearchReportWithFormalIntake(
      fixture.manuscript.researchReport,
      mutate,
    );
    const changedIntake = researchReport.capabilities.formalCertificateIntakes[0];
    const intakeVerification = verifyGenericFormalCertificateIntakeClosureBinding(
      changedIntake,
      formalIntakeContext,
    );
    assert.equal(intakeVerification.valid, false);
    assert.ok(intakeVerification.blockers.includes(expectedBlocker));
    const attack = rehashNestedClosure(fixture, { researchReport });
    const reportInspection = inspectResearchReportForClosure(
      researchReport,
      attack.changedBundle,
      attack.changedBinding,
    );
    assert.equal(
      reportInspection.checks.formal_certificate_intakes,
      false,
      `${label} splice must fail the closure report's formal-intake comparison`,
    );
    assert.equal(
      verifyFixtureClosure(fixture, attack.closure),
      false,
      `${label} splice must be rejected after every outer hash is recomputed`,
    );
  }
  const thinFormalReport = rehashResearchReportWithFormalIntake(
    fixture.manuscript.researchReport,
    (intake) => {
      for (const key of Object.keys(intake)) delete intake[key];
      Object.assign(intake, {
        version: 3,
        kind: 'GenericFormalCertificateIntake',
        status: 'formal_certificate_intake_verified',
        paperId: fixture.releaseBinding.paperId,
        campaignId: fixture.releaseBinding.campaignId,
        researchSourceSnapshotHash:
          fixture.releaseBundle.campaignResearchSourceSnapshotHash,
        claimBindings: expectedFormalClaimBindings,
        trustedLedgerReceiptsVerified: true,
        trustedNativeFormalReceiptVerified: true,
        artifactSourcesVerified: true,
        blockers: [],
        externalActionPerformed: false,
      });
    },
  );
  const thinFormalAttack = rehashNestedClosure(fixture, {
    researchReport: thinFormalReport,
  });
  assert.equal(inspectResearchReportForClosure(
    thinFormalReport,
    thinFormalAttack.changedBundle,
    thinFormalAttack.changedBinding,
  ).checks.formal_certificate_intakes, false);
  assert.equal(verifyFixtureClosure(fixture, thinFormalAttack.closure), false,
    'synthetic thin v3 intake must fail after every outer hash is recomputed');

  const embeddedReceiptTamperReport = rehashResearchReportWithFormalIntake(
    fixture.manuscript.researchReport,
    (intake) => { intake.certificate.artifactWriteReceipt.bytes += 1; },
  );
  const embeddedReceiptTamper = rehashNestedClosure(fixture, {
    researchReport: embeddedReceiptTamperReport,
  });
  assert.equal(inspectResearchReportForClosure(
    embeddedReceiptTamperReport,
    embeddedReceiptTamper.changedBundle,
    embeddedReceiptTamper.changedBinding,
  ).checks.formal_certificate_intakes, false);
  assert.equal(verifyFixtureClosure(fixture, embeddedReceiptTamper.closure), false,
    'embedded ArtifactWriteReceipt tamper must fail after outer resealing');

  const nativeReplaySpliceReport = rehashResearchReportWithNativeReplay(
    fixture.manuscript.researchReport,
    (replay) => {
      replay.projectManifestHash = hashRecord(
        'SamePaperAlternateFormalProjectManifest',
        { paperId: fixture.releaseBinding.paperId },
      );
    },
  );
  const nativeReplaySplice = rehashNestedClosure(fixture, {
    researchReport: nativeReplaySpliceReport,
  });
  const nativeReplayInspection = inspectResearchReportForClosure(
    nativeReplaySpliceReport,
    nativeReplaySplice.changedBundle,
    nativeReplaySplice.changedBinding,
  );
  assert.equal(nativeReplayInspection.checks.native_formal_execution, true,
    'alternate replay remains internally valid as native evidence');
  assert.equal(nativeReplayInspection.checks.formal_certificate_intakes, false,
    'generic intake anchor must reject the alternate native replay');
  assert.equal(verifyFixtureClosure(fixture, nativeReplaySplice.closure), false,
    'same-paper alternate native replay must fail recursive closure');
  const priorArtLineageSplices = [
    ['agenda', priorArtV2Fixture({
      paperId: fixture.releaseBinding.paperId,
      agendaSelectionReceiptHash: hashRecord('SamePaperAgendaSplice', { version: 1 }),
      researchAgendaIrHash: fixture.releaseBinding.researchAgendaIrHash,
      priorArtQueryPlan: fixture.releaseBinding.researchAgendaIr.priorArtQueryPlan,
    })],
    ['query', priorArtV2Fixture({
      paperId: fixture.releaseBinding.paperId,
      agendaSelectionReceiptHash:
        fixture.releaseBinding.proposal.agendaSelectionReceiptHash,
      researchAgendaIrHash: fixture.releaseBinding.researchAgendaIrHash,
      priorArtQueryPlan: ['attacker-selected same-paper prior-art query'],
    })],
    ['receipt-hash', priorArtV2Fixture({
      paperId: fixture.releaseBinding.paperId,
      agendaSelectionReceiptHash:
        fixture.releaseBinding.proposal.agendaSelectionReceiptHash,
      researchAgendaIrHash: fixture.releaseBinding.researchAgendaIrHash,
      priorArtQueryPlan: fixture.releaseBinding.researchAgendaIr.priorArtQueryPlan,
      signatureVerificationReceiptHash:
        hashRecord('SamePaperPriorArtReviewSignatureSplice', { version: 1 }),
    })],
  ];
  for (const [label, priorArtEvidenceReceipt] of priorArtLineageSplices) {
    const attack = rehashedSignedQualificationPriorArtSplice(
      fixture,
      priorArtEvidenceReceipt,
    );
    assert.equal(verifyResearchClosureReceipt(attack.closure, {}, {
      verifyQualificationSignature: attack.verifyQualificationSignature,
      verifyIndependentQualificationEvidence:
        fixture.qualificationIndependentEvidenceVerifier,
    }), false, `same-paper ${label} prior-art splice must be rejected`);
  }
  assert.equal(verifyAutonomousSubmissionRequest(fixture.submissionRequest, {
    authorityObservedAt: fixture.closureTime,
    requireResearchClosure: true,
    verifyCurrentCampaignReleaseAuthority: () => true,
    verifyQualificationAuthority: () => true,
    verifyQualificationSignature: fixture.qualificationSignatureVerifier,
    verifyIndependentQualificationEvidence:
      fixture.qualificationIndependentEvidenceVerifier,
    verifyVenueComplianceAuthority: () => true,
    verifyPortalConfigurationAuthority: () => true,
  }), true);

  const forgedNoncompliant = forgedVerifiedNoncompliantSourceReceipt(fixture);
  assert.equal(forgedNoncompliant.derived.templateAssetPresent, false);
  assert.equal(
    forgedNoncompliant.receipt.status,
    'autonomous_venue_compliance_verified',
  );
  assert.deepEqual(forgedNoncompliant.receipt.blockers, []);
  assert.equal(verifyAutonomousVenueComplianceReceipt(
    forgedNoncompliant.receipt,
    { campaignReleaseAuthority: fixture.campaignReleaseAuthority },
  ), false);

  const observationAttacks = [
    ['page-count', (observations) => {
      observations.pageCount += 1;
    }],
    ['document-class', (observations) => {
      observations.documentClass = observations.documentClass === 'article'
        ? 'report' : 'article';
    }],
    ['bibliography-style', (observations) => {
      observations.bibliographyStyle = 'forged-bibliography-style';
    }],
    ['citation-style', (observations) => {
      observations.citationStyle = 'forged-citation-style';
    }],
    ['word-count', (observations) => {
      observations.totalWordCount += 1;
    }],
    ['anonymous-review', (observations) => {
      observations.anonymousReviewSatisfied =
        !observations.anonymousReviewSatisfied;
    }],
    ['template-asset', (observations) => {
      observations.templateAssetPresent = !observations.templateAssetPresent;
    }],
    ['disclosure', (observations) => {
      observations.satisfiedDisclosureRequirements =
        observations.satisfiedDisclosureRequirements.slice(1);
    }],
    ['artifact', (observations) => {
      observations.artifactPresent = !observations.artifactPresent;
    }],
    ['supplement', (observations) => {
      observations.supplementPolicySatisfied =
        !observations.supplementPolicySatisfied;
    }],
  ];
  for (const [label, mutate] of observationAttacks) {
    const attack = rehashVenueObservationAttack(fixture, mutate);
    assert.equal(
      verifyFixtureClosure(fixture, attack.closure),
      false,
      `${label} observation splice must be rejected after every outer hash is recomputed`,
    );
  }
  const venueIrHashSwap = rehashVenueIrFileHashSwapAttack(fixture);
  assert.equal(
    verifyFixtureClosure(fixture, venueIrHashSwap.closure),
    false,
    'VenueRequirementIR/manuscript IR file-hash swap must be rejected after every outer hash is recomputed',
  );

  const overPage = rehashedVerifiedOverPageAttack(fixture);
  assert.equal(
    overPage.venueComplianceReceipt.status,
    'autonomous_venue_compliance_verified',
  );
  assert.deepEqual(overPage.venueComplianceReceipt.blockers, []);
  assert.equal(verifyAutonomousVenueComplianceReceipt(
    overPage.venueComplianceReceipt,
    { campaignReleaseAuthority: overPage.campaignReleaseAuthority },
  ), false);
  assert.equal(
    verifyFixtureClosure(fixture, overPage.closure),
    false,
    'over-page receipt must be rejected after forged verified status and every outer hash is recomputed',
  );

  const donor = genericManuscriptReleaseFixture({
    paperId: 'paper-cross-agenda-donor',
    campaignId: 'campaign-cross-agenda-donor',
    launchMode: 'golden-bootstrap',
    externalSubmission: true,
  });
  const agendaSplice = rehashNestedClosure(fixture, {
    bindingChanges: {
      researchAgendaProductionReceiptHash:
        donor.preparation.researchAgendaProducerReceipt
          .autonomousResearchAgendaProductionReceiptHash,
      researchAgendaProductionReceipt:
        donor.preparation.researchAgendaProducerReceipt,
      researchAgendaIrHash: donor.researchAgendaIr.researchAgendaIrHash,
      researchAgendaIr: donor.researchAgendaIr,
      researchAgendaClaimBindingReceiptHash:
        donor.agendaClaimBindingReceipt.researchAgendaClaimBindingReceiptHash,
      researchAgendaClaimBindingReceipt: donor.agendaClaimBindingReceipt,
      priorArtEvidenceReceiptHash:
        donor.priorArtReceipt.priorArtEvidenceReceiptHash,
      priorArtEvidenceReceipt: donor.priorArtReceipt,
      priorArtClaimAlignmentReceiptHash:
        donor.priorArtClaimAlignmentReceipt.priorArtClaimAlignmentReceiptHash,
      priorArtClaimAlignmentReceipt: donor.priorArtClaimAlignmentReceipt,
      venueRequirementIrHash: donor.venueRequirementIr.venueRequirementIrHash,
      venueRequirementIr: donor.venueRequirementIr,
    },
    complianceChanges: {
      researchAgendaIrHash: donor.researchAgendaIr.researchAgendaIrHash,
      researchAgendaIr: donor.researchAgendaIr,
      venueRequirementIrHash: donor.venueRequirementIr.venueRequirementIrHash,
      venueRequirementIr: donor.venueRequirementIr,
    },
  });
  assert.equal(verifyFixtureClosure(fixture, agendaSplice.closure), false);

  const crossPaperReport = rehashResearchReportWithPaper(
    fixture.manuscript.researchReport,
    'paper-cross-report-donor',
  );
  const paperSplice = rehashNestedClosure(fixture, {
    researchReport: crossPaperReport,
  });
  assert.equal(verifyFixtureClosure(fixture, paperSplice.closure), false);

  const crossCampaignReport = rehashResearchReportWithCampaign(
    fixture.manuscript.researchReport,
    'campaign-old-formal-source',
  );
  const campaignSplice = rehashNestedClosure(fixture, {
    researchReport: crossCampaignReport,
  });
  assert.equal(
    verifyFixtureClosure(fixture, campaignSplice.closure),
    false,
    'same-paper old-campaign formal/source lineage splice must be rejected after recursive rehashing',
  );
});
