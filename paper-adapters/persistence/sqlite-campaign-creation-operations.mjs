import { sqlJson, sqlText } from '../../paper-ports/store-port.mjs';
import {
  inspectAutonomousResearchCampaignExecutionAdmission,
} from '../../paper-domain/automation/autonomous-research-campaign-execution-admission.mjs';
import {
  assertCampaignDefinition,
  assertCampaignDefinitionReplay,
  campaignDefinitionHash,
} from './campaign-definition-codec.mjs';

function campaignInitialExecutionState(spec) {
  const inspection = inspectAutonomousResearchCampaignExecutionAdmission(spec);
  if (!inspection.present) {
    return Object.freeze({ status: 'running', phase: 'dispatching', admissionHash: null });
  }
  if (!inspection.valid) throw new Error('campaign_execution_admission_invalid');
  return Object.freeze({
    status: 'paused',
    phase: 'admitted-not-authorized',
    admissionHash: inspection.binding.executionAdmissionHash,
  });
}

export function createCampaignCreationOperations({
  clock,
  mutation,
  eventStatement,
  readCampaignDefinitionSnapshot,
  getApi,
} = {}) {
  const exclusiveCreateConflict = (campaignId, cause = null) => {
    const error = new Error(`campaign_exclusive_create_conflict:${campaignId}`);
    error.code = 'campaign_exclusive_create_conflict';
    if (cause) error.cause = cause;
    return error;
  };

  function prepareCampaignCreation(spec, { exclusive }) {
    assertCampaignDefinition(spec);
    const initialExecutionState = campaignInitialExecutionState(spec);
    const existing = readCampaignDefinitionSnapshot(spec.campaignId);
    if (existing.campaign) {
      if (exclusive) throw exclusiveCreateConflict(spec.campaignId);
      assertCampaignDefinitionReplay(spec, existing.campaign, existing.nodes);
      return Object.freeze({ replay: existing.campaign });
    }
    const now = clock.nowIso();
    const admitted = initialExecutionState.status === 'paused';
    const paperMetadata = {
      source: 'paper_campaign_creation',
      campaignId: spec.campaignId,
      campaignPlanHash: spec.campaignPlanHash,
    };
    const statements = [
      `INSERT OR IGNORE INTO papers(slug,title,status,venue_target,paper_type,canonical_dir,source_dir,submission_dir,metadata_json,created_at,updated_at) VALUES(${sqlText(spec.paperId)},${sqlText(spec.paperId)},'draft',${sqlText(spec.venueTarget || '')},'campaign',${sqlText(spec.sourceWorkspace)},${sqlText(spec.sourceWorkspace)},'submission',${sqlJson(paperMetadata)},${sqlText(now)},${sqlText(now)});`,
      `INSERT INTO paper_campaigns(campaign_id,paper_id,status,max_rounds,spec_json,created_at,updated_at,last_resumed_at,parent_campaign_id,supersedes_campaign_id,recovery_of_campaign_id,current_phase) VALUES(${sqlText(spec.campaignId)},${sqlText(spec.paperId)},${sqlText(admitted ? 'paused' : 'queued')},${Math.max(1, Number(spec.maxRounds || 1))},${sqlJson(spec)},${sqlText(now)},${sqlText(now)},${admitted ? 'NULL' : sqlText(now)},${spec.parentCampaignId ? sqlText(spec.parentCampaignId) : 'NULL'},${spec.supersedesCampaignId ? sqlText(spec.supersedesCampaignId) : 'NULL'},${spec.recoveryOfCampaignId ? sqlText(spec.recoveryOfCampaignId) : 'NULL'},${sqlText(admitted ? initialExecutionState.phase : 'queued')});`,
    ];
    for (const node of spec.nodes) {
      statements.push(`INSERT INTO campaign_nodes(node_id,campaign_id,kind,round_index,status,priority,dependencies_json,spec_json,max_attempts,created_at,updated_at,role) VALUES(${sqlText(node.nodeId)},${sqlText(spec.campaignId)},${sqlText(node.kind)},${Number(node.roundIndex || 0)},'queued',${Number(node.priority || 100)},${sqlJson(node.dependencies || [])},${sqlJson(node)},${Math.max(1, Number(node.maxAttempts || 3))},${sqlText(now)},${sqlText(now)},${node.role ? sqlText(node.role) : 'NULL'});`);
    }
    if (!admitted) {
      statements.push(`UPDATE paper_campaigns SET status='running',current_phase='dispatching',updated_at=${sqlText(now)} WHERE campaign_id=${sqlText(spec.campaignId)} AND status='queued';`);
    }
    const eventRow = eventStatement(spec.campaignId, null, 'campaign_created', {
      nodeCount: spec.nodes.length,
      campaignDefinitionHash: campaignDefinitionHash(spec),
      executionAdmissionHash: initialExecutionState.admissionHash,
      initialStatus: initialExecutionState.status,
    }, now);
    statements.push(eventRow.sql);
    return Object.freeze({
      replay: null,
      statements: Object.freeze(statements),
      input: Object.freeze({ spec, admitted, initialExecutionState, now, eventRow }),
    });
  }

  function recoverCampaignCreation(spec, { exclusive, error }) {
    if (error?.committed) throw error;
    const raced = readCampaignDefinitionSnapshot(spec.campaignId);
    if (!raced.campaign) throw error;
    if (exclusive) throw exclusiveCreateConflict(spec.campaignId, error);
    assertCampaignDefinitionReplay(spec, raced.campaign, raced.nodes);
    return raced.campaign;
  }

  return {
    createCampaign(spec = {}) {
      const prepared = prepareCampaignCreation(spec, { exclusive: false });
      if (prepared.replay) return prepared.replay;
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lifecycle.createCampaign.v1',
          statements: prepared.statements,
          fallback: 'campaign_create_failed',
          input: prepared.input,
        });
      } catch (error) {
        return recoverCampaignCreation(spec, { exclusive: false, error });
      }
      return getApi().getCampaign(spec.campaignId);
    },
    createCampaignExclusive(spec = {}) {
      const prepared = prepareCampaignCreation(spec, { exclusive: true });
      try {
        mutation({
          databaseRole: 'native-store',
          operationId: 'native-store.campaign-lifecycle.createCampaignExclusive.v1',
          statements: prepared.statements,
          fallback: 'campaign_create_failed',
          input: prepared.input,
        });
      } catch (error) {
        return recoverCampaignCreation(spec, { exclusive: true, error });
      }
      return getApi().getCampaign(spec.campaignId);
    },
  };
}
