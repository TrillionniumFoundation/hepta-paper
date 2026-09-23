#!/usr/bin/env node
// Differential fixture only. This invokes the real offline schema-25 business
// operation and issuer broker; it is not an operational writer admission.
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { executeAutomationRuntimeReconciliation } from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { issueAutomationReconcilerWriter } from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
const args=process.argv.slice(2);
const value=(name,fallback=null)=>{ const i=args.indexOf(name); return i<0?fallback:args[i+1]; };
const database=value('--database');
const now=value('--at','2026-07-13T08:00:00.000Z');
const fault=value('--fault');
if(value('--release-commit')!==null) process.env.HEPTA_RELEASE_COMMIT=value('--release-commit');
const root=path.dirname(database);
const store=createDefaultPaperStore({root,runtimeRoot:root,dbPath:database});
const samples=JSON.parse(value('--clock-samples','null'));
const clockCalls=[];
let clockIndex=0;
const sample=(kind)=>{
  clockCalls.push(kind);
  if(!samples) return now;
  const next=samples[clockIndex++];
  if(!next || next.kind!==kind) throw new Error('fixture_clock_order_invalid');
  if(next.error) throw new Error(next.error);
  return next.value;
};
const clock={now:()=>new Date(sample('now')),nowIso:()=>sample('nowIso')};
const ledger=createSqliteReceiptLedger({store,clock,issuerCapability:issueAutomationReconcilerWriter()});
const faults={
  'stale-node':"UPDATE campaign_nodes SET status='completed',node_revision=node_revision+1 WHERE node_id='node-3'",
  'stale-resource':"UPDATE automation_resource_leases SET renewed_at='2026-07-13T07:59:00.000Z' WHERE lease_id='expired-lease'",
  'stale-campaign':"UPDATE paper_campaigns SET revision=revision+1 WHERE campaign_id='campaign-2'",
  'stale-active':"UPDATE campaign_nodes SET prepared_integration_status='integrated' WHERE node_id='node-4'",
  'stale-generation':"UPDATE campaign_nodes SET lease_generation=lease_generation+1 WHERE node_id='node-4'",
  'stale-expiry':"UPDATE campaign_nodes SET lease_expires_at='2026-07-13T09:00:00.000Z' WHERE node_id='node-4'",
  'stale-campaign-lineage':"UPDATE paper_campaigns SET revision=revision+1 WHERE campaign_id='campaign-4'",
  'stale-waiter':"UPDATE automation_resource_waiters SET owner_id='replacement-owner' WHERE waiter_id='expired-waiter'",
};
const snapshot=()=>Object.fromEntries(store.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").rows.map(({name})=>[name,store.query(`SELECT * FROM "${name.replaceAll('"','""')}"`).rows.sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0)]));
let result;
try {
  let receiptLedger=ledger;
  if(fault) receiptLedger={prepare(receipt,options){
    const prepared=ledger.prepare(receipt,options);
    if(fault==='duplicate-receipt') store.execute(prepared.sql);
    else if(fault==='duplicate-event') {
      const node=store.query("SELECT n.node_id,n.campaign_id,c.status AS campaign_status,c.stop_reason FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id WHERE n.node_id='node-3'").rows[0];
      const payload={version:1,kind:'campaign_terminal_child_closed',campaignId:node.campaign_id,nodeId:node.node_id,detail:{campaignStatus:node.campaign_status,campaignStopReason:node.stop_reason||null,reconciliationPlanHash:receipt.reconciliationPlanHash},createdAt:now};
      const eventHash=hashRecord('PaperCampaignEvent',payload);
      const eventId=`${node.campaign_id}:${now}:${eventHash.slice(-16)}`;
      const inserted=store.run('INSERT INTO campaign_events(event_id,campaign_id,node_id,kind,event_json,event_sha256,created_at) VALUES(?,?,?,?,?,?,?)',[eventId,node.campaign_id,node.node_id,payload.kind,JSON.stringify(payload),eventHash,now]);
      if(!inserted.ok) throw new Error(inserted.error);
    }
    else if(fault==='event-failure') store.execute("CREATE TEMP TRIGGER reconciliation_test_fail BEFORE INSERT ON campaign_events BEGIN SELECT RAISE(ABORT,'injected_event_failure'); END");
    else if(fault==='receipt-failure') store.execute("CREATE TEMP TRIGGER reconciliation_test_fail BEFORE INSERT ON receipt_ledger BEGIN SELECT RAISE(ABORT,'injected_receipt_failure'); END");
    else if(faults[fault]) store.execute(faults[fault]);
    else throw new Error('unknown fixture fault');
    return prepared;
  }};
  const receipts=[];
  for(let i=0;i<Number(value('--repeat','1'));i++) receipts.push(executeAutomationRuntimeReconciliation({store,clock,receiptLedger,campaignId:value('--campaign-id'),noProgressSeconds:Number(value('--no-progress-seconds','1800'))}));
  result={ok:true,receipts,snapshot:snapshot(),clockCalls};
} catch(error) { result={ok:false,error:String(error.message||error),snapshot:snapshot(),clockCalls}; }
finally { store.close(); }
process.stdout.write(`${JSON.stringify(result)}\n`);
