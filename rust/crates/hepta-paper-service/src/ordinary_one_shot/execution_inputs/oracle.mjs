import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const from=relative=>import(pathToFileURL(path.join(input.source,relative)));
const { createDefaultPaperStore }=await from('paper-adapters/persistence/store-provider.mjs');
const { createSqliteCampaignStore }=await from('paper-adapters/persistence/sqlite-campaign-store.mjs');
const { inspectAutonomousResearchOneShotProtectedCampaign }=await from('paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs');
const { sqlText }=await from('paper-ports/store-port.mjs');
fs.mkdirSync(input.runtime,{mode:0o755});
const dbPath=path.join(input.runtime,'hepta-paper.sqlite');
const store=createDefaultPaperStore({root:input.source,runtimeRoot:input.runtime,dbPath,targetVersion:25});
const clock={now:()=>new Date('2026-08-03T00:00:00.000Z'),nowIso:()=> '2026-08-03T00:00:00.000Z'};
const campaigns=createSqliteCampaignStore({store,clock});
const protectedId='autonomous-research:local-auto-20260730-51';
const targetId='autonomous-research:local-auto-20260730-57';
try {
  if(!input.profile.startsWith('missing')) {
    campaigns.createCampaign({campaignId:protectedId,paperId:'local-auto-20260730-51',
      metadata:{rawString:'UTF16: \ud800 and 😀',number:1e-7},
      nodes:Array.from({length:66},(_,i)=>({nodeId:protectedId+':'+i,kind:i===0?'author':'review',dependencies:[],priority:i}))});
    const updates=store.execute(`UPDATE paper_campaigns SET status='failed',current_review_round=0,agent_call_count=1,priced_agent_call_count=0 WHERE campaign_id=${sqlText(protectedId)};
      UPDATE campaign_nodes SET status='skipped' WHERE campaign_id=${sqlText(protectedId)};
      UPDATE campaign_nodes SET status='failed_terminal',failure_class='agent_usage_unknown_terminal',failure_json=${sqlText(JSON.stringify({message:'unknown',value:'\udfff'}))} WHERE node_id=${sqlText(protectedId+':0')};`);
    if(!updates.ok)throw Error(updates.error);
    if(input.profile==='active') {
      const result=store.execute(`UPDATE campaign_nodes SET status='running',lease_owner='actual-lease' WHERE node_id=${sqlText(protectedId+':1')}`);
      if(!result.ok)throw Error(result.error);
    }
    if(input.profile.startsWith('malformed-prepared')) {
      const result=store.execute(`UPDATE campaign_nodes SET prepared_result_json='{}',prepared_result_sha256='sha256:${'0'.repeat(64)}' WHERE node_id=${sqlText(protectedId+':0')}`);
      if(!result.ok)throw Error(result.error);
    }
  }
  if(input.profile==='target') campaigns.createCampaign({campaignId:targetId,paperId:'local-auto-20260730-57',nodes:[{nodeId:targetId+':first',kind:'author',dependencies:[],priority:100}]});
  if(input.profile==='counts') {
    const result=store.execute(`INSERT INTO automation_resource_leases(lease_id,scope,owner_id,campaign_id,acquired_at,renewed_at,expires_at) VALUES('fixture-lease','global','fixture-owner',${sqlText(protectedId)},'2026-08-03','2026-08-03','2026-08-04');
      INSERT INTO automation_resource_waiters(waiter_id,scope,owner_id,campaign_id,requested_at,renewed_at,expires_at) VALUES('fixture-waiter','global','fixture-owner',${sqlText(protectedId)},'2026-08-03','2026-08-03','2026-08-04');
      INSERT INTO submissions(slug) VALUES('local-auto-20260730-51');
      INSERT INTO receipt_ledger(receipt_id,stream,kind,status,receipt_json,receipt_sha256,created_at) VALUES('fixture-receipt','fixture','fixture','observed',${sqlText(JSON.stringify({campaignId:protectedId}))},'fixture','2026-08-03');`);
    if(!result.ok)throw Error(result.error);
  }
  if(input.profile.endsWith('ledger')) {
    const result=store.execute(`INSERT INTO receipt_ledger(receipt_id,stream,kind,status,receipt_json,receipt_sha256,created_at) VALUES('fixture-malformed','fixture','fixture','observed','{','fixture','2026-08-03');`);
    if(!result.ok)throw Error(result.error);
  }
  if(input.profile==='large-cell' || input.profile==='large-logical') {
    const n=input.profile==='large-cell'?1024*1024+1:550000;
    const result=store.execute(`UPDATE campaign_nodes SET result_json=${sqlText(JSON.stringify({large:'x'.repeat(n)}))} WHERE node_id IN (${sqlText(protectedId+':1')},${sqlText(protectedId+':2')});`);
    if(!result.ok)throw Error(result.error);
  }
  let result;
  try {result={definition:inspectAutonomousResearchOneShotProtectedCampaign({store,campaignStore:campaigns}),target:campaigns.getCampaign(targetId)};}
  catch(error){result={error:error.message};}
  process.stdout.write(JSON.stringify(result));
} finally {store.close();}
