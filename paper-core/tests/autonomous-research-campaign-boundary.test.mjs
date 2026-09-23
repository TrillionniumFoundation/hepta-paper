import assert from 'node:assert/strict';
import test from 'node:test';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildAutonomousResearchCampaignPlan,
  enqueuePreparedAutonomousResearchCampaign,
  executeAutonomousResearchCampaign,
  requireAutonomousResearchAdmissionPreflightExecutionInspection,
} from '../../paper-application/automation/autonomous-research-campaign.mjs';

const H = (label) => hashRecord('AutonomousCampaignTestHash', { label });

test('campaign public command boundaries reject malformed stores, actions, ids, and preflight evidence', async () => {
  assert.throws(() => enqueuePreparedAutonomousResearchCampaign({ campaignStore: {} }),
    /campaign_store_required/);
  const emptyStore = {
    createCampaign() { throw new Error('create_not_expected'); },
    getCampaign() { return null; },
    listNodes() { return []; },
    resumeCampaign() { throw new Error('resume_not_expected'); },
  };
  await assert.rejects(executeAutonomousResearchCampaign({
    action: 'invalid-action',
    campaignStore: emptyStore,
  }), /campaign_action_invalid/);
  await assert.rejects(executeAutonomousResearchCampaign({
    action: 'status',
    campaignStore: emptyStore,
  }), /campaign_id_required/);
  await assert.rejects(executeAutonomousResearchCampaign({
    action: 'status',
    campaignId: 'missing-campaign',
    campaignStore: emptyStore,
  }), /campaign_not_found/);
  await assert.rejects(executeAutonomousResearchCampaign({
    action: 'launch',
    campaignId: 'launch-without-preparation',
    campaignStore: emptyStore,
  }), /launch_dependencies_not_ready/);
  await assert.rejects(executeAutonomousResearchCampaign({
    action: 'status',
    readinessReport: {
      kind: 'AutonomousResearchReadinessCompositionReport',
      loopPreparation: { proposal: { paperId: 'wrapped-preparation-paper' } },
    },
    campaignStore: emptyStore,
  }), /campaign_not_found:autonomous-research:wrapped-preparation-paper/);
  assert.throws(() => buildAutonomousResearchCampaignPlan({
    loopPreparation: { autonomousExecutionLaunchReady: false },
    materialization: { status: 'autonomous_research_workspace_materialized' },
  }), /campaign_launch_not_ready/);

  const inspectionPayload = {
    version: 1,
    kind: 'AutonomousResearchAdmissionPreflightExecutionInspection',
    sandbox: 'bubblewrap-unshare-net-read-only-root-v1',
    processCount: 8,
    localDockerDaemonProbeCount: 2,
    localProcessActionPerformed: true,
    localDaemonActionPerformed: true,
    networkActionPerformed: false,
    externalActionPerformed: false,
  };
  const inspection = {
    ...inspectionPayload,
    autonomousResearchAdmissionPreflightExecutionInspectionHash: hashRecord(
      'AutonomousResearchAdmissionPreflightExecutionInspection',
      inspectionPayload,
    ),
  };
  assert.equal(requireAutonomousResearchAdmissionPreflightExecutionInspection(inspection),
    inspection);
  for (const [label, candidate] of [
    ['null', null],
    ['prototype', Object.assign(Object.create(null), inspection)],
    ['keys', { ...inspection, extra: true }],
    ['sandbox', { ...inspection, sandbox: 'none' }],
    ['process count', { ...inspection, processCount: 7 }],
    ['daemon count', { ...inspection, localDockerDaemonProbeCount: 1 }],
    ['process action', { ...inspection, localProcessActionPerformed: false }],
    ['daemon action', { ...inspection, localDaemonActionPerformed: false }],
    ['network action', { ...inspection, networkActionPerformed: true }],
    ['external action', { ...inspection, externalActionPerformed: true }],
    ['hash', {
      ...inspection,
      autonomousResearchAdmissionPreflightExecutionInspectionHash: H('bad-preflight'),
    }],
  ]) {
    assert.throws(() => requireAutonomousResearchAdmissionPreflightExecutionInspection(candidate),
      /preflight_execution_inspection_invalid/, label);
  }
});
