// Rust differential owners prefix the existing release_replay/oracle-input-guard.mjs.
/* global readBoundedReplayInput */
import fs from 'node:fs';
import path from 'node:path';
import {createDefaultPaperStore} from './paper-adapters/persistence/store-provider.mjs';
import {createSqliteCampaignStore} from './paper-adapters/persistence/sqlite-campaign-store.mjs';
import {createPaperTask} from './paper-domain/contracts/workflow-contracts.mjs';
import {buildPaperCampaignPlan} from './paper-domain/automation/campaign-plan.mjs';
import {createSystemClock} from './paper-adapters/runtime/system-clock.mjs';
import {runPaperBatch} from './paper-composition/batch/paper-batch-application.mjs';
import {persistBatchReport} from './paper-composition/reporting/batch-report-writer.mjs';
import {withArtifactWriteContext} from './paper-adapters/artifacts/artifact-write-context.mjs';
import {createFilesystemReportReceiptLedger} from './paper-adapters/artifacts/filesystem-report-receipt-ledger.mjs';
import {createFilesystemArtifactRepository} from './paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import {verifyArtifactWriteReceiptSource} from './paper-adapters/artifacts/artifact-write-receipt-verifier.mjs';
const input=readBoundedReplayInput('referee');
if(input.cases.length!==1||input.cases[0].name!=='local_report' ||input.cases[0].args.length!==1)throw new Error('local_report_case');
const fixture=input.cases[0].args[0];if(!path.isAbsolute(fixture)||fs.realpathSync(fixture)!==fixture)throw new Error('fixed_fixture_path');
const assets=path.join(fixture,'assets'),runtimeRoot=path.join(fixture,'runtime'),sourceWorkspace=path.join(assets,'drafts/local-report-paper');
fs.mkdirSync(assets,{mode:0o700});fs.mkdirSync(runtimeRoot,{mode:0o700});fs.mkdirSync(sourceWorkspace,{recursive:true,mode:0o700});fs.writeFileSync(path.join(sourceWorkspace,'main.tex'),'\\documentclass{article}\n\\begin{document}Actual local report input.\\end{document}\n',{flag:'wx',mode:0o600});
const database=path.join(runtimeRoot,'hepta-paper.sqlite'),store=createDefaultPaperStore({root:assets,runtimeRoot,dbPath:database});
try{
 const task=createPaperTask({paperId:'local-report-paper',title:'Real report fixture',status:'draft',venueTarget:'Local Planning Venue',canonicalDir:'drafts/local-report-paper',sourceWorkspace:'drafts/local-report-paper',mainTex:'drafts/local-report-paper/main.tex',createdAt:'2026-10-02T00:00:00.000Z'});
 const plan=buildPaperCampaignPlan({paperId:task.paperId,sourceWorkspace,campaignId:'local-report-registration',mode:'local-build',maxRounds:1,paperTask:task,paperState:null,languages:['latex']});
 const registered=createSqliteCampaignStore({store,clock:createSystemClock()}).createCampaign(plan);if(registered.paperId!==task.paperId)throw new Error('registration_failed');
 if(!store.run('INSERT INTO venues(venue_id,name,kind,cycle,deadline,metadata_json) VALUES(?,?,?,?,?,?);',['local-planning-venue','Local Planning Venue','local','2026','2026-12-31','{}']).ok)throw new Error('venue_setup_failed');
 if(!store.checkpoint({mode:'TRUNCATE'}).ok)throw new Error('fixture_checkpoint_failed');
}finally{store.close();}
const report=await runPaperBatch({root:assets,runtimeRoot,mode:'local-dry-run',inventorySource:'hepta',paperIds:['local-report-paper'],qualityProfile:'survey_or_position',execute:false,writeReport:false,maxRounds:2});
if(report.kind!=='PaperBatchRunReport'||report.results.length!==1||report.results[0].campaignPlan.nodes.length!==6)throw new Error('actual_full_report_required');
const clock=createSystemClock(),ledger=createFilesystemReportReceiptLedger({scopeRoot:runtimeRoot,receiptRoot:path.join(runtimeRoot,'report-receipts'),clock}),receipts=[];
const receiptLedger={record(receipt,options){const actual=ledger.record(receipt,options);if(actual.writerTrusted!==false)throw new Error('local_trust_changed');receipts.push({...receipt,ledgerReceiptId:actual.receiptId});return actual;}};
await withArtifactWriteContext({artifactRepositoryFactory:scopeRoot=>createFilesystemArtifactRepository({scopeRoot,casRoot:path.join(runtimeRoot,'report-artifact-cas'),receiptLedger,clock})},()=>persistBatchReport(report));
if(receipts.length!==5)throw new Error('five_actual_writes_required');
const actual=receipts.map(receipt=>{const proof=verifyArtifactWriteReceiptSource({receipt});if(proof.status!=='artifact_write_receipt_source_verified')throw new Error('original_receipt_proof_failed');return {path:receipt.path,role:receipt.role,contentType:receipt.contentType,bytes:fs.readFileSync(path.join(receipt.scopeRoot,receipt.path)).toString('base64'),receipt};});
process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},reportWire:JSON.stringify(report),actual,writerTrusted:false,businessStoreMutated:false}));
