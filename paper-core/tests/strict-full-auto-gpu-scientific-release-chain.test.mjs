import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertInvocationOutput,
} from '../../paper-application/automation/strict-full-auto-acceptance-state.mjs';
import {
  strictFullAutoAcceptanceFixture as fixture,
  strictFullAutoAcceptanceOrchestratorFor as orchestratorFor,
  strictFullAutoAcceptanceSuccessfulOutput as successfulOutput,
  strictFullAutoAcceptanceSuccessfulRunner as successfulRunner,
} from './support/strict-full-auto-acceptance-fixture.mjs';

test('verified GPU release-chain failures propagate through production and final acceptance gates',
  async (t) => {
    const [gpuSupport, gpuAuthority, assuranceInspection, readinessQuery,
      recordHash] = await Promise.all([
      import('./support/gpu-scientific-campaign-release-fixture.mjs'),
      import('../../paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs'),
      import('../../paper-composition/automation/automation-readiness-research-assurance-authority-inspection.mjs'),
      import('../../paper-composition/automation/automation-readiness-query.mjs'),
      import('../../workflow-kernel/record-hash.mjs'),
    ]);
    const {
      GPU_AUTHORITY_EXPIRED_TIME, GPU_RELEASE_TIME,
      createGpuScientificCampaignReleaseFixture,
    } = gpuSupport;
    const { createGpuScientificCampaignPromotionAuthorityVerifier } = gpuAuthority;
    const { inspectPersistedCampaignResearchGpuScientificReleaseChain } =
      assuranceInspection;
    const { deriveFullyAutonomousResearchSystemStatus } = readinessQuery;
    const { hashRecord } = recordHash;
    const value = fixture(t);
    const plan = orchestratorFor(value.configurationPath, successfulRunner()).plan();
    const productionQualification = plan.steps.find((step) =>
      step.stepId === 'production-campaign-qualification').verify;
    const gpuFixture = await createGpuScientificCampaignReleaseFixture(t, {
      campaignId: 'strict-acceptance-gpu-release-chain', persistedProductionPlan: true,
    });
    const authorityVerifier = createGpuScientificCampaignPromotionAuthorityVerifier({
      trustStoreProvider: () => gpuFixture.qualification.trustStore,
      clock: { now: () => new Date(GPU_RELEASE_TIME) },
    });
    const planRow = {
      campaign_id: gpuFixture.campaign.campaignId,
      paper_id: gpuFixture.campaign.paperId,
      campaign_status: 'running',
      campaign_revision: 1,
      spec_json: JSON.stringify(gpuFixture.campaign.spec),
    };
    const gpuSpec = gpuFixture.campaign.spec.nodes.find((node) => (
      node.kind === 'gpu-scientific-execution'
    ));
    const researchSpec = gpuFixture.campaign.spec.nodes.find((node) => (
      node.kind === 'research-verify'
    ));
    const formalSpec = gpuFixture.campaign.spec.nodes.find((node) => (
      node.kind === 'formal-verify' && node.sourceClosureTerminal === true
    ));
    const gpuRow = {
      ...planRow,
      node_id: gpuFixture.gpu.node.nodeId,
      node_kind: 'gpu-scientific-execution',
      node_status: 'completed',
      attempt_id: gpuFixture.gpu.node.attemptId,
      lease_generation: gpuFixture.gpu.node.leaseGeneration,
      round_index: gpuSpec.roundIndex,
      node_revision: 6,
      dependencies_json: JSON.stringify(gpuSpec.dependencies),
      node_spec_json: JSON.stringify(gpuSpec),
      result_json: JSON.stringify(gpuFixture.gpu.node.result),
      result_sha256: gpuFixture.gpu.node.resultSha256,
      updated_at: GPU_RELEASE_TIME,
    };
    const formalResult = { status: 'formal-fixture-completed' };
    const formalRow = {
      ...planRow,
      node_id: formalSpec.nodeId,
      node_kind: formalSpec.kind,
      node_status: 'completed',
      attempt_id: 'strict-formal-fixture-attempt',
      lease_generation: 1,
      round_index: formalSpec.roundIndex,
      node_revision: 5,
      dependencies_json: JSON.stringify(formalSpec.dependencies),
      node_spec_json: JSON.stringify(formalSpec),
      result_json: JSON.stringify(formalResult),
      result_sha256: hashRecord('PaperCampaignNodeResult', formalResult),
      updated_at: GPU_RELEASE_TIME,
    };
    const persistedRows = (researchResult, {
      campaignStatus = 'running',
      campaignRevision = 1,
    } = {}) => [
      {
        ...planRow,
        campaign_status: campaignStatus,
        campaign_revision: campaignRevision,
        node_id: gpuFixture.packageInput.researchVerifyNode.nodeId,
        node_kind: 'research-verify',
        node_status: 'completed',
        attempt_id: gpuFixture.packageInput.researchVerifyNode.attemptId,
        lease_generation: gpuFixture.packageInput.researchVerifyNode.leaseGeneration,
        round_index: researchSpec.roundIndex,
        node_revision: 8,
        dependencies_json: JSON.stringify(researchSpec.dependencies),
        node_spec_json: JSON.stringify(researchSpec),
        result_json: JSON.stringify(researchResult),
        result_sha256: hashRecord('PaperCampaignNodeResult', researchResult),
        updated_at: GPU_RELEASE_TIME,
      },
      { ...gpuRow, campaign_status: campaignStatus,
        campaign_revision: campaignRevision },
      { ...formalRow, campaign_status: campaignStatus,
        campaign_revision: campaignRevision },
    ];
    const inspectPersisted = ({
      mutate = null,
      now = GPU_RELEASE_TIME,
      campaignStatus = 'running',
      campaignRevision = 1,
    } = {}) => {
      const researchResult = structuredClone(
        gpuFixture.packageInput.researchVerifyNode.result,
      );
      mutate?.(researchResult);
      return inspectPersistedCampaignResearchGpuScientificReleaseChain({
        store: {
          query(statement, parameters) {
            assert.match(statement, /gpu-scientific-execution/);
            assert.deepEqual(parameters, [gpuFixture.campaign.campaignId]);
            return {
              ok: true,
              rows: persistedRows(researchResult, {
                campaignStatus,
                campaignRevision,
              }),
            };
          },
        },
        campaignId: gpuFixture.campaign.campaignId,
        paperId: gpuFixture.campaign.paperId,
        expectedAgendaAuthorityInspection: Object.freeze({
          ready: true,
          campaignId: gpuFixture.campaign.campaignId,
          paperId: gpuFixture.campaign.paperId,
          campaignStatus: 'running',
          campaignRevision: 1,
          campaignPlanHash: gpuFixture.campaign.spec.campaignPlanHash,
        }),
        gpuScientificPromotionAuthorityVerifier: authorityVerifier,
        runtimeRoot: gpuFixture.runtimeRoot,
        now: new Date(now),
      });
    };
    const baseline = inspectPersisted();
    assert.equal(baseline.ready, true, JSON.stringify(baseline, null, 2));
    for (const [label, input, blocker] of [
      [
        'paused campaign cannot splice an older agenda snapshot',
        { campaignStatus: 'paused' },
        'gpu_scientific_current_campaign_status_invalid',
      ],
      [
        'revised campaign cannot splice an older agenda snapshot',
        { campaignRevision: 2 },
        'gpu_scientific_agenda_authority_snapshot_mismatch',
      ],
      [
        'malformed campaign revision cannot enter a readiness snapshot',
        { campaignRevision: 'invalid' },
        'gpu_scientific_current_campaign_revision_invalid',
      ],
    ]) {
      const inspection = inspectPersisted(input);
      assert.equal(inspection.ready, false, label);
      assert.ok(inspection.blockers.includes(blocker), label);
      assert.ok(inspection.blockers.includes(
        'gpu_scientific_agenda_authority_snapshot_mismatch',
      ), label);
    }
    const releaseChainFailures = [
      {
        label: 'self-consistent persisted research result omits GPU evidence',
        mutate(result) {
          delete result.gpuScientificQualificationEvidence;
          delete result.gpuScientificCampaignExecutionResultHash;
          delete result.gpuScientificArtifactBodyArchiveManifestHash;
          delete result.gpuScientificCampaignQualificationEvidenceHash;
        },
        assertComputedBlocker(inspection) {
          assert.ok(inspection.blockers.includes(
            'gpu_scientific_research_evidence_required',
          ));
        },
      },
      {
        label: 'artifact body archive missing',
        mutate(result) {
          delete result.gpuScientificQualificationEvidence.artifactArchiveManifest;
        },
        assertComputedBlocker(inspection) {
          assert.ok(inspection.blockers.includes(
            'gpu_scientific_research_evidence_invalid',
          ));
        },
      },
      {
        label: 'independent same-device replay missing',
        mutate(result) {
          delete result.gpuScientificQualificationEvidence.qualificationEvidence
            .gpuScientificCampaignSameDeviceReplayReceipt;
        },
        assertComputedBlocker(inspection) {
          assert.ok(inspection.blockers.includes(
            'gpu_scientific_current_authority_invalid',
          ));
        },
      },
      {
        label: 'production qualification missing',
        mutate(result) {
          delete result.gpuScientificQualificationEvidence.qualificationEvidence
            .gpuScientificCampaignProductionQualificationAuthority;
        },
        assertComputedBlocker(inspection) {
          assert.ok(inspection.blockers.includes(
            'gpu_scientific_current_authority_invalid',
          ));
        },
      },
      {
        label: 'release authority freshness expired',
        now: GPU_AUTHORITY_EXPIRED_TIME,
        assertComputedBlocker(inspection) {
          assert.ok(inspection.blockers.some((blocker) => (
            blocker.endsWith('same_device_replay:authority_expired'))));
          assert.ok(inspection.blockers.some((blocker) => (
            blocker.endsWith('production_qualification:authority_expired'))));
        },
      },
    ];
    for (const {
      label,
      mutate,
      now,
      assertComputedBlocker,
    } of releaseChainFailures) {
      const inspection = inspectPersisted({ mutate, now });
      assert.equal(inspection.ready, false, label);
      assertComputedBlocker(inspection);

      const productionOutput = structuredClone(successfulOutput(
        productionQualification,
      ));
      const assurance =
        productionOutput.autonomousResearchAssuranceAuthorityInspection;
      assurance.ready = inspection.ready;
      assurance.gpuScientificReleaseChainInspection = inspection;
      assurance.blockers = inspection.blockers;
      assert.throws(
        () => assertInvocationOutput(
          productionQualification,
          productionOutput,
          `production-campaign-qualification:${label}`,
        ),
        (error) => error?.code === 'STRICT_FULL_AUTO_ACCEPTANCE_NOT_READY'
          && error?.assertionPath
            === '/autonomousResearchAssuranceAuthorityInspection/ready',
      );
      const finalOutput = structuredClone(successfulOutput(
        plan.finalVerification,
      ));
      finalOutput.fullyAutonomousResearchSystemStatus =
        deriveFullyAutonomousResearchSystemStatus({
          readinessLevels: {
            productionReady: inspection.ready,
            status: inspection.ready
              ? 'automation_plane_production_ready'
              : 'automation_plane_production_blocked',
          },
          coreStatus: 'generic_domain_autonomous_research_system_ready',
        });
      finalOutput.productionGenericResearchQualificationReady =
        inspection.ready;
      finalOutput.fullResearchQualification.ready = inspection.ready;
      finalOutput.fullResearchQualification.receiptAccepted = inspection.ready;
      finalOutput.fullResearchQualification.gpuScientificReleaseChainInspection =
        inspection;
      finalOutput.fullResearchQualification.blockers = inspection.blockers;
      assert.throws(
        () => assertInvocationOutput(
          plan.finalVerification,
          finalOutput,
          `final-aggregate-live-verification:${label}`,
        ),
        (error) => error?.code === 'STRICT_FULL_AUTO_ACCEPTANCE_NOT_READY'
          && error?.assertionPath === '/fullyAutonomousResearchSystemStatus',
      );
    }
  });

test('assurance snapshot rejects a changed canonical experiment generation',
  async () => {
    const {
      automationReadinessExperimentInspectionMatchesRows,
    } = await import(
      '../../paper-composition/automation/automation-readiness-experiment-ir-authority-inspection.mjs'
    );
    const inspection = Object.freeze({
      ready: true,
      nodeId: 'experiment-replay',
      nodeAttemptId: 'replay-attempt',
      nodeLeaseGeneration: 3,
      nodeRoundIndex: 2,
      nodeRevision: 7,
      nodeStatus: 'completed',
      resultHash: 'sha256:replay',
      originalNodeId: 'experiment-original',
      originalNodeAttemptId: 'original-attempt',
      originalNodeLeaseGeneration: 2,
      originalNodeRoundIndex: 1,
      originalNodeRevision: 5,
      originalNodeStatus: 'completed',
      originalResultHash: 'sha256:original',
    });
    const row = ({
      nodeId,
      attemptId,
      leaseGeneration,
      roundIndex,
      revision,
      status,
      resultHash,
    }) => Object.freeze({
      node_id: nodeId,
      attempt_id: attemptId,
      lease_generation: leaseGeneration,
      round_index: roundIndex,
      node_revision: revision,
      node_status: status,
      result_sha256: resultHash,
    });
    const canonicalRows = Object.freeze({
      ready: true,
      replay: Object.freeze({ row: row({
        nodeId: inspection.nodeId,
        attemptId: inspection.nodeAttemptId,
        leaseGeneration: inspection.nodeLeaseGeneration,
        roundIndex: inspection.nodeRoundIndex,
        revision: inspection.nodeRevision,
        status: inspection.nodeStatus,
        resultHash: inspection.resultHash,
      }) }),
      original: Object.freeze({ row: row({
        nodeId: inspection.originalNodeId,
        attemptId: inspection.originalNodeAttemptId,
        leaseGeneration: inspection.originalNodeLeaseGeneration,
        roundIndex: inspection.originalNodeRoundIndex,
        revision: inspection.originalNodeRevision,
        status: inspection.originalNodeStatus,
        resultHash: inspection.originalResultHash,
      }) }),
    });
    assert.equal(automationReadinessExperimentInspectionMatchesRows(
      inspection,
      canonicalRows,
    ), true);
    assert.equal(automationReadinessExperimentInspectionMatchesRows(
      inspection,
      {
        ...canonicalRows,
        replay: { row: { ...canonicalRows.replay.row, node_revision: 8 } },
      },
    ), false);
  });
