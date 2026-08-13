import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  verifyAutonomousVenueComplianceReceipt as
    verifyProductionAutonomousVenueComplianceReceipt,
} from '../../paper-domain/automation/autonomous-venue-compliance-contract.mjs';
import {
  autonomousSubmissionQualificationInspectionValid,
} from '../../paper-domain/automation/autonomous-submission-qualification-inspection.mjs';
import {
  importAutonomousVenueComplianceContractForTest,
  importLocalAutonomousVenueComplianceInspectorForTest,
} from './support/production-experiment-closure-test-seam.mjs';
import {
  productionResearchClosureFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const [
  { verifyAutonomousVenueComplianceReceipt },
  {
    createLocalAutonomousVenueComplianceInspector,
    inspectLocalAutonomousVenueComplianceRuntime,
  },
] = await Promise.all([
  importAutonomousVenueComplianceContractForTest(),
  importLocalAutonomousVenueComplianceInspectorForTest(),
]);

const MANUSCRIPT_PROOF_FIELDS = Object.freeze([
  'trustedAutonomousManuscriptRenderReceiptHash',
  'evidenceBoundManuscriptIrHash',
  'manuscriptIrFileHash',
  'renderedManuscriptHash',
  'agentExecutionReceiptHash',
  'isolatedAgentMergeReceiptHash',
  'agentAuthoredSourceDraftHash',
  'agentAuthoredSourceDraftFileHash',
  'agentWorkspacePostimageBindingHash',
]);

test('venue compliance is gated by the archived IR, prior art, seed, agent proof, and PDFs', (t) => {
  const fixture = productionResearchClosureFixture({
    paperId: 'paper-generalized-1',
    campaignId: 'campaign-generalized-1',
  });
  t.after(() => fixture.cleanup());
  const releaseBinding = fixture.releaseBinding;
  const releaseFixture = fixture.manuscript;
  assert.equal(autonomousSubmissionQualificationInspectionValid(
    fixture.qualificationInspection,
    releaseBinding,
    fixture.campaignReleaseAuthority,
    MANUSCRIPT_PROOF_FIELDS,
    {
      verifyIndependentQualificationEvidence: () => true,
      verificationTime: fixture.closureTime,
    },
  ), true);
  const tamperedQualificationInspection =
    structuredClone(fixture.qualificationInspection);
  tamperedQualificationInspection.independentVerificationEvidence
    .configurationIdentityHash = releaseBinding.policyAuthorizationHash;
  const {
    fullResearchQualificationInspectionHash: _oldInspectionHash,
    ...tamperedQualificationInspectionPayload
  } = tamperedQualificationInspection;
  const rehashedTamperedQualificationInspection = {
    ...tamperedQualificationInspectionPayload,
    fullResearchQualificationInspectionHash: hashRecord(
      'FullResearchQualificationInspection',
      tamperedQualificationInspectionPayload,
    ),
  };
  assert.equal(autonomousSubmissionQualificationInspectionValid(
    rehashedTamperedQualificationInspection,
    releaseBinding,
    fixture.campaignReleaseAuthority,
    MANUSCRIPT_PROOF_FIELDS,
    {
      verifyIndependentQualificationEvidence: () => true,
      verificationTime: fixture.closureTime,
    },
  ), false);
  const inspector = createLocalAutonomousVenueComplianceInspector({
    runtimeRoot: fixture.runtimeRoot,
  });
  assert.equal(inspectLocalAutonomousVenueComplianceRuntime().ready, true);
  const complianceReceipt = inspector.inspect({
    campaignReleaseAuthority: fixture.campaignReleaseAuthority,
    venueProfileSelection: releaseFixture.venueProfileSelection,
  });
  assert.equal(verifyAutonomousVenueComplianceReceipt(complianceReceipt, {
    paperId: releaseBinding.paperId,
    campaignId: releaseBinding.campaignId,
    venueId: releaseFixture.venueProfileSelection.venueId,
    campaignReleaseAuthority: fixture.campaignReleaseAuthority,
    campaignReleaseBundleHash: fixture.releaseBundle.campaignReleaseBundleHash,
    trustedAutonomousManuscriptRenderReceiptHash:
      releaseBinding.trustedAutonomousManuscriptRenderReceiptHash,
    agentExecutionReceiptHash: releaseBinding.agentExecutionReceiptHash,
    isolatedAgentMergeReceiptHash: releaseBinding.isolatedAgentMergeReceiptHash,
  }), true);
  assert.equal(verifyProductionAutonomousVenueComplianceReceipt(
    complianceReceipt,
    { campaignReleaseAuthority: fixture.campaignReleaseAuthority },
  ), false, 'fixture-backed venue evidence must remain non-promotable');
  assert.equal(complianceReceipt.pageCount, fixture.venueComplianceReceipt.pageCount);
  assert.equal(Number.isSafeInteger(complianceReceipt.pageCount), true);
  assert.equal(complianceReceipt.pageCount > 0, true);
  assert.deepEqual(complianceReceipt.metadataPresent, [
    'abstract', 'authors', 'code_availability', 'conflict_of_interest',
    'data_availability', 'funding', 'keywords', 'title',
  ]);

  const sourceArchive = fixture.packageOutput.files.find(
    (artifact) => artifact.role === 'generated_source_zip',
  );
  assert.ok(sourceArchive);
  fs.appendFileSync(
    path.resolve(fixture.packageOutput.artifactBaseRoot, sourceArchive.path),
    'tampered-after-release',
  );
  assert.throws(() => inspector.inspect({
    campaignReleaseAuthority: fixture.campaignReleaseAuthority,
    venueProfileSelection: releaseFixture.venueProfileSelection,
  }), /autonomous_venue_compliance_release_artifacts_invalid/);
});
