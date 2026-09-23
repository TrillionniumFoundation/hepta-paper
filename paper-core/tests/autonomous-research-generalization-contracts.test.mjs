import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  buildDynamicFormalClaimSeed,
  verifyDynamicFormalClaimSeed,
} from '../../paper-domain/research/dynamic-formal-claim-seed-contract.mjs';
import {
  verifyEvidenceBoundManuscriptIr,
} from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import {
  verifyPriorArtEvidenceReceipt,
} from '../../paper-domain/research/prior-art-evidence-contract.mjs';
import {
  buildAgentWorkspacePostimageBinding,
} from '../../paper-domain/evidence/agent-execution-receipt-contract.mjs';
import {
  buildPriorArtServiceConfiguration,
  createHttpPriorArtRetrievalAdapter,
} from '../../paper-adapters/automation/http-prior-art-retrieval-adapter.mjs';
import {
  FIXED_TIME,
  digest,
  manuscriptIrFixture,
  priorArtFixture,
} from './support/autonomous-research-generalization-fixture.mjs';

test('structured prior art, evidence-bound prose, and dynamic Lean claims fail closed on tamper', async () => {
  const priorArtReceipt = priorArtFixture();
  assert.deepEqual(verifyPriorArtEvidenceReceipt(priorArtReceipt, {
    paperId: 'paper-generalized-1',
    agendaSelectionReceiptHash: digest('agenda'),
    requireVerified: true,
  }), {
    valid: true,
    ready: true,
    status: 'prior_art_evidence_verification_verified',
    priorArtEvidenceReceiptHash: priorArtReceipt.priorArtEvidenceReceiptHash,
    blockers: [],
  });
  const priorArtConfiguration = buildPriorArtServiceConfiguration({
    serviceId: 'prior-art-service-1',
    endpoint: 'https://prior-art.example.test/retrieve',
    serviceIdentityHash: digest('prior-art-service-identity'),
    tokenEnvironmentVariable: 'PRIOR_ART_TEST_TOKEN',
  });
  const priorArtAdapter = createHttpPriorArtRetrievalAdapter({
    configuration: priorArtConfiguration,
    environment: { PRIOR_ART_TEST_TOKEN: 'secret-token' },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(url, priorArtConfiguration.endpoint);
      assert.equal(init.headers.authorization, 'Bearer secret-token');
      assert.equal(body.paperId, priorArtReceipt.paperId);
      return {
        ok: true,
        async json() {
          return {
            requestHash: body.requestHash,
            serviceId: priorArtConfiguration.serviceId,
            serviceIdentityHash: priorArtConfiguration.serviceIdentityHash,
            externalActionPerformed: true,
            priorArtEvidenceReceipt: priorArtReceipt,
          };
        },
      };
    },
  });
  const retrievedPriorArt = await priorArtAdapter.retrieve({
    paperId: priorArtReceipt.paperId,
    objective: 'Map bounded evidence-bound research systems.',
    protocolFamily: 'rl_stochastic_control_benchmark',
    agendaSelectionReceiptHash: digest('agenda'),
    generatorPrincipalId: 'research-author-1',
    createdAt: FIXED_TIME,
  });
  assert.equal(retrievedPriorArt.priorArtEvidenceReceiptHash,
    priorArtReceipt.priorArtEvidenceReceiptHash);
  const manuscript = manuscriptIrFixture({ priorArtReceipt });
  assert.equal(verifyEvidenceBoundManuscriptIr(manuscript.manuscriptIr, {
    paperId: 'paper-generalized-1',
    authorityBindings: manuscript.authorityBindings,
    priorArtReceipt,
    agentExecutionReceipt: manuscript.agentExecutionReceipt,
    requireAgentAuthoredProse: true,
  }).valid, true);
  assert.equal(manuscript.manuscriptIr.unboundScientificProseAccepted, false);
  assert.equal(manuscript.manuscriptIr.openWorldNoveltyClaimed, false);
  assert.equal(manuscript.manuscriptIr.authorship.agentWorkspacePostimageBindingHash,
    manuscript.agentExecutionReceipt.agentWorkspacePostimageBinding
      .agentWorkspacePostimageBindingHash);

  const capabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1', 'registered-template-v1'],
    empiricalFamilies: ['rl_stochastic_control_benchmark'],
    priorArtMode: 'structured-ranked-deduplicated-v2',
    reviewerPrincipalCount: 3,
    reviewerTrustDomainCount: 3,
    replayMode: 'external-trust-domain-v1',
    venueMode: 'submission-enabled-v1',
  });
  const dynamicClaim = buildDynamicFormalClaimSeed({
    claimKey: 'identity-on-natural-numbers',
    statement: 'Every natural number equals itself.',
    assumptions: ['The quantified value has type Nat.'],
    quantifiers: ['For every natural number n.'],
    negativeBoundaries: ['No empirical performance claim follows from this theorem.'],
    proofObligations: ['Kernel replay must verify the exact normalized Lean type.'],
    leanDeclarationName: 'dynamicIdentity',
    leanTypeSource: '∀ n : Nat, n = n',
    allowedImports: ['Mathlib'],
    generatorReceiptHash: digest('generator'),
    capabilityScopeManifestHash:
      capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
  });
  assert.equal(verifyDynamicFormalClaimSeed(dynamicClaim).valid, true);

  const priorArtTamper = structuredClone(priorArtReceipt);
  priorArtTamper.works[0].title = 'Rewritten title';
  assert.equal(verifyPriorArtEvidenceReceipt(priorArtTamper).valid, false);
  const manuscriptTamper = structuredClone(manuscript.manuscriptIr);
  manuscriptTamper.sections[0].blocks[0].text = 'Unbound universal scientific truth.';
  assert.equal(verifyEvidenceBoundManuscriptIr(manuscriptTamper, {
    authorityBindings: manuscript.authorityBindings,
    priorArtReceipt,
    agentExecutionReceipt: manuscript.agentExecutionReceipt,
  }).valid, false);
  const receiptTamper = structuredClone(manuscript.agentExecutionReceipt);
  receiptTamper.agentWorkspacePostimageBinding = buildAgentWorkspacePostimageBinding({
    changedPaths: ['AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json'],
    files: [{
      path: 'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
      hash: digest('different-draft'),
    }],
  });
  assert.equal(verifyEvidenceBoundManuscriptIr(manuscript.manuscriptIr, {
    authorityBindings: manuscript.authorityBindings,
    priorArtReceipt,
    agentExecutionReceipt: receiptTamper,
  }).valid, false);
  const dynamicTamper = structuredClone(dynamicClaim);
  dynamicTamper.leanTypeSource = 'True';
  assert.equal(verifyDynamicFormalClaimSeed(dynamicTamper).valid, false);
});
