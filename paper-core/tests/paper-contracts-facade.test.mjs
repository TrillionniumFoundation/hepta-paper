import assert from 'node:assert/strict';
import test from 'node:test';
import * as facade from '../../paper-domain/contracts/index.mjs';
import * as product from '../../paper-domain/contracts/product-profile.mjs';
import * as proposal from '../../paper-domain/contracts/proposal-contracts.mjs';
import * as research from '../../paper-domain/contracts/research-contracts.mjs';
import * as workflow from '../../paper-domain/contracts/workflow-contracts.mjs';
import * as venue from '../../paper-domain/contracts/venue-contracts.mjs';

test('canonical contracts index exposes the bounded contract modules', () => {
  assert.equal(Object.keys(facade).length, 78);
  for (const module of [product, proposal, research, workflow, venue]) {
    for (const [name, value] of Object.entries(module)) assert.equal(facade[name], value, name);
  }
  const brief = proposal.createPaperIdeaBrief({ idea: 'Bounded contract modules' });
  assert.equal(brief.kind, 'PaperIdeaBrief');
  const task = workflow.createPaperTask({ paperId: 'fixture', canonicalDir: 'fixture' });
  assert.equal(task.kind, 'PaperTask');
  const claim = research.createClaimScopeContract({ paperTask: task, claims: ['claim'] });
  assert.equal(claim.kind, 'ClaimScopeContract');
});

test('submission contracts never promote the weaker typed research receipt hash', () => {
  const paperTask = workflow.createPaperTask({ paperId: 'fixture', canonicalDir: 'fixture' });
  const weakReceiptOnly = { researchVerifyReceiptHash: `sha256:${'a'.repeat(64)}` };
  const approval = facade.buildSubmissionApprovalPacket({
    paperTask,
    researchReport: weakReceiptOnly,
  });
  const venueEvidence = facade.buildFreshVenueEvidenceBundle({
    paperTask,
    venuePlan: {
      kind: 'VenueSubmissionPlan',
      status: 'local_dry_run_ready',
      venueSubmissionPlanHash: `sha256:${'b'.repeat(64)}`,
    },
    artifactPackage: { artifactPackageHash: `sha256:${'c'.repeat(64)}` },
    researchReport: weakReceiptOnly,
  });
  assert.equal(approval.researchReportHash, null);
  assert.equal(venueEvidence.researchReportHash, null);
});
