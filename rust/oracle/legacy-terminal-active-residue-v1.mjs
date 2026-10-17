#!/usr/bin/env node
// Differential tests only: real schema-25 legacy business path and fixed broker.
// This fixture never provides deployment admission or production authority.
import path from 'node:path';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { issueAutomationReconcilerWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { planLegacyTerminalActiveResidueSettlement as plan, executeLegacyTerminalActiveResidueSettlement as execute } from '../../paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs';
const args=process.argv.slice(2);
const value=(key,fallback=null)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
if(value('--timezone'))process.env.TZ=value('--timezone');
const database=value('--database'), root=path.dirname(database), now=value('--at','2026-08-01T05:00:00.000Z');
const times=JSON.parse(value('--times',JSON.stringify([now])));let clockIndex=0;
const clock={now:()=>new Date(now),nowIso:()=>times[Math.min(clockIndex++,times.length-1)]};
const store=createDefaultPaperStore({root,runtimeRoot:root,dbPath:database});
const checked=sql=>{const r=store.execute(sql);if(!r.ok)throw new Error(r.error||r.stderr);};
const campaignId=value('--campaign-id','legacy-campaign');
if(args.includes('--prepare')) {
  const campaign=createSqliteCampaignStore({store,clock:{now:()=>new Date(now),nowIso:()=>now}});
  campaign.createCampaign({campaignId:'legacy-campaign',paperId:'legacy-paper',nodes:[
    {nodeId:'legacy:terminal',kind:'agent',dependencies:[]},
    {nodeId:'legacy:expired-a',kind:'agent',dependencies:[]},
    {nodeId:'legacy:expired-b',kind:'agent',dependencies:[]},
    ...Array.from({length:Number(value('--queued','600'))},(_,i)=>({nodeId:`legacy:queued-${String(i).padStart(4,'0')}`,kind:'agent',dependencies:[]})),
  ]});
  campaign.createCampaign({campaignId:'other-campaign',paperId:'other-paper',nodes:[{nodeId:'other:queued',kind:'agent',dependencies:[]}]});
  checked("UPDATE paper_campaigns SET status='failed',stop_reason='historical_stop',revision=7 WHERE campaign_id='legacy-campaign'; UPDATE campaign_nodes SET status='failed_terminal',failure_class='historical_failure',node_revision=3 WHERE node_id='legacy:terminal';");
  for(const [id,ordinal] of [['a',1],['b',2]]) checked(`UPDATE campaign_nodes SET status='${ordinal===1?'running':'leased'}',lease_owner='dead-${ordinal}',lease_expires_at='2026-07-30T05:00:00.000Z',attempt_id='attempt-${ordinal}',lease_generation=${ordinal+4},node_revision=${ordinal+8} WHERE node_id='legacy:expired-${id}'`);
  checked("UPDATE campaign_nodes SET failure_class='保留↔é',failure_sha256='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',node_revision=3 WHERE node_id='legacy:queued-0000'");
}
const setup=value('--setup');
const changes={
  'policy-zero':"UPDATE paper_campaigns SET spec_json=json_set(spec_json,'$.terminalSiblingSettlementPolicyVersion',0) WHERE campaign_id='legacy-campaign'",
  'policy-one':"UPDATE paper_campaigns SET spec_json=json_set(spec_json,'$.terminalSiblingSettlementPolicyVersion',1) WHERE campaign_id='legacy-campaign'",
  'policy-text':"UPDATE paper_campaigns SET spec_json=json_set(spec_json,'$.terminalSiblingSettlementPolicyVersion','0') WHERE campaign_id='legacy-campaign'",
  'policy-false':"UPDATE paper_campaigns SET spec_json=json_set(spec_json,'$.terminalSiblingSettlementPolicyVersion',json('false')) WHERE campaign_id='legacy-campaign'",
  'policy-null':"UPDATE paper_campaigns SET spec_json=json_set(spec_json,'$.terminalSiblingSettlementPolicyVersion',json('null')) WHERE campaign_id='legacy-campaign'",
  'policy-real':"UPDATE paper_campaigns SET spec_json='{"+'"terminalSiblingSettlementPolicyVersion":0.0'+"}' WHERE campaign_id='legacy-campaign'",
  'nonterminal':"UPDATE paper_campaigns SET status='running' WHERE campaign_id='legacy-campaign'",
  'naive-lease':"UPDATE campaign_nodes SET lease_expires_at='2026-08-01T12:00:00' WHERE node_id='legacy:expired-a'",
  'offset-lease':"UPDATE campaign_nodes SET lease_expires_at='2026-07-30T09:30:00.123456+04:30' WHERE node_id='legacy:expired-a'",
  'expired-missing':"UPDATE campaign_nodes SET lease_expires_at=NULL WHERE node_id='legacy:expired-a'",
  'expired-invalid':"UPDATE campaign_nodes SET lease_expires_at='not-a-date' WHERE node_id='legacy:expired-a'",
  'unexpired':"UPDATE campaign_nodes SET lease_expires_at='2026-08-02T05:00:00.000Z' WHERE node_id='legacy:expired-a'",
  'integrating':"UPDATE campaign_nodes SET prepared_integration_status='integrating' WHERE node_id='legacy:expired-a'",
  'integrated':"UPDATE campaign_nodes SET prepared_integration_status='integrated' WHERE node_id='legacy:expired-a'",
  'stale-revision':"UPDATE campaign_nodes SET node_revision=node_revision+1 WHERE node_id='legacy:expired-b'",
  'stale-owner':"UPDATE campaign_nodes SET lease_owner='different-worker' WHERE node_id='legacy:expired-b'",
  'stale-generation':"UPDATE campaign_nodes SET lease_generation=lease_generation+1 WHERE node_id='legacy:expired-b'",
  'stale-expiry':"UPDATE campaign_nodes SET lease_expires_at='2026-07-31T05:00:00.000Z' WHERE node_id='legacy:expired-b'",
  'stale-parent':"UPDATE paper_campaigns SET revision=revision+1 WHERE campaign_id='legacy-campaign'",
  'stale-queued-count':"UPDATE campaign_nodes SET status='queued' WHERE node_id='legacy:terminal'",
  'same-count-queued':"UPDATE campaign_nodes SET node_revision=node_revision+1, failure_class='concurrent' WHERE node_id='legacy:queued-0000'",
  'clean':"UPDATE campaign_nodes SET status='skipped' WHERE node_id LIKE 'legacy:expired-%'",
  'lease':"INSERT INTO automation_resource_leases(lease_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,acquired_at,renewed_at,expires_at) VALUES('blocked-lease','global','old-owner','legacy-campaign',NULL,1,0,0,0,'2026-01-01','2026-01-01','2026-01-01')",
  'waiter-node':"INSERT INTO automation_resource_waiters(waiter_id,scope,owner_id,campaign_id,node_id,agent,cpu,gpu,memory_mib,requested_at,renewed_at,expires_at) VALUES('blocked-waiter','global','old-owner','other-campaign','legacy:terminal',1,0,0,0,'2026-01-01','2026-01-01','2026-01-01')",
};
if(setup){if(!changes[setup])throw new Error('unknown setup');checked(changes[setup]);}
if(value('--release-commit')!==null) process.env.HEPTA_RELEASE_COMMIT=value('--release-commit');
const ledger=createSqliteReceiptLedger({store,clock,issuerCapability:issueAutomationReconcilerWriter()});
const fault=value('--fault');let receiptLedger=ledger;
if(fault) receiptLedger={prepare(receipt,options){const prepared=ledger.prepare(receipt,options);
  if(changes[fault])checked(changes[fault]);
  else if(fault==='duplicate-receipt')checked(prepared.sql);
  else if(fault==='duplicate-event'){
    const hash=receipt.settlementEventHashes.at(-1),node=receipt.settledNodeIds.at(-1),id=`${campaignId}:${node}:${hash.slice(-24)}`;
    const result=store.run('INSERT INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(?,?,?,?,?,?,?)',[id,campaignId,node,'collision','{}',hash,now]);if(!result.ok)throw new Error(result.error);
  }else if(fault==='event-failure')checked("CREATE TEMP TRIGGER residue_test_fail BEFORE INSERT ON campaign_events BEGIN SELECT RAISE(ABORT,'injected_event_failure'); END");
  else if(fault==='receipt-failure')checked("CREATE TEMP TRIGGER residue_test_fail BEFORE INSERT ON receipt_ledger BEGIN SELECT RAISE(ABORT,'injected_receipt_failure'); END");
  else throw new Error('unknown fault');return prepared;
}};
const snapshot=()=>Object.fromEntries(store.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").rows.map(({name})=>[name,store.query(`SELECT * FROM "${name.replaceAll('"','""')}"`).rows]));
let result;
try {
  let report=null;
  if(!args.includes('--prepare-only')) report=args.includes('--execute')?execute({store,clock,receiptLedger,campaignId}):plan({store,clock,campaignId});
  result={ok:true,report,snapshot:snapshot(),clockCalls:clockIndex};
}catch(error){result={ok:false,error:String(error.message||error),snapshot:snapshot(),clockCalls:clockIndex};}
finally{store.close();}
process.stdout.write(`${JSON.stringify(result)}\n`);
