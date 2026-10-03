// Actual incumbent builders over an inventory captured by its normal owner.
// This oracle is not an execution or provider-authority fixture.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {buildTargetScopeReceipt} from '../../../../../paper-domain/automation/target-scope-policy.mjs';
import {bindPaperTaskQualityProfile,paperWorkflowRow} from '../../../../../paper-domain/contracts/workflow-contracts.mjs';
import {buildBatchCampaignCommand} from '../../../../../paper-application/automation/batch-campaign-command.mjs';
import {buildWorkflowAuthorityLineage,buildCanonicalPaperStatusReadProjection} from '../../../../../paper-domain/workflow/operational-authority-policy.mjs';
import {buildBatchReport,renderBatchConsole} from '../../../../../paper-composition/reporting/batch-report-writer.mjs';
assert.equal(process.version,'v22.23.1');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const {options}=input;
const rows=input.scan.rows.map(row=>options.qualityProfile?{...row,task:bindPaperTaskQualityProfile(row.task,options.qualityProfile)}:row);
const scan={...input.scan,rows};
const target=buildTargetScopeReceipt({mode:options.mode,execute:options.execute,requestedPaperIds:options.paperIds,selectedTasks:rows.map(row=>row.task),inventorySource:scan.inventorySource,inventoryFallback:scan.inventoryFallback,limit:options.limit,requireExplicitScope:options.execute});
let results=[];
try {
 for(const row of rows) {
  const command=target.status==='target_scope_verified'&&row.sourceDir?buildBatchCampaignCommand({paperTask:row.task,paperState:row.state,sourceWorkspace:row.sourceDir,mode:options.mode,maxRounds:options.maxRounds,targetScopeReceipt:target,venueTarget:options.targetOverride,qualityProfile:options.qualityProfile,languages:options.languages}):null;
  const recordedAt=new Date().toISOString();
  const campaignQueue={version:1,kind:'PaperBatchCampaignQueueStatus',status:command?'paper_campaign_planned_not_queued':'paper_campaign_not_applicable',executionStatus:command?'planned_not_queued':'not_applicable',workflowExecutionPerformed:false,campaignId:command?.campaignId||null,campaignPlanHash:command?.campaignPlanHash||null,nodeCount:command?.campaignPlan?.nodes?.length||0,nodeKinds:[...new Set((command?.campaignPlan?.nodes||[]).map(node=>node.kind))].sort(),requestedMode:command?.requestedMode||options.mode,effectiveMode:command?.campaignPlan?.mode||null,releaseHandoffRequired:command?.campaignPlan?.releaseHandoffRequired===true,externalSubmissionEnabled:command?.campaignPlan?.externalSubmissionEnabled===true,idempotentReplay:false};
  results.push({paperId:row.task.paperId,task:row.task,state:row.state,campaignCommand:command,campaignPlan:command?.campaignPlan||null,campaignSubmission:null,campaignQueue,workflowStateProjection:null,workflowAuthorityLineage:buildWorkflowAuthorityLineage({paperId:row.task.paperId,mode:options.mode,execute:false,workflowReceiptHash:null,campaignId:command?.campaignId||null,campaignPlanHash:command?.campaignPlanHash||null,legacyProjectionRequested:false,recordedAt}),workflowAuthorityLedgerEntry:null,paperStatusProjection:buildCanonicalPaperStatusReadProjection({paperId:row.task.paperId,observedStatus:row.task.registry?.status||null,state:row.state,recordedAt}),workflowRow:paperWorkflowRow(row.state)});
 }
 const report=buildBatchReport({...options,scan,results,targetScopeReceipt:target});
 process.stdout.write(JSON.stringify({ok:true,scan,target,results,report,console:renderBatchConsole(report)}));
}catch(error){process.stdout.write(JSON.stringify({ok:false,scan,target,error:error.message}));}
