import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { before, after, test } from 'node:test';
import { createNormalQualificationFixtureV1 } from './support/native-qualification-normal-fixture-v1.mjs';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';
import { createCampaignOneShotAttemptJournalRepository } from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs';
import { buildAutonomousResearchOneShotCampaignAttemptReservation, autonomousResearchOneShotTargetCampaignDefinitionHash, verifyAutonomousResearchOneShotCampaignExecutionBindingForHistoricalAudit, verifyAutonomousResearchOneShotCampaignAttemptReservationForHistoricalAudit } from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import { executionBinding, gatewayProviderRuntimeBinding, legacyProviderRuntimeBinding } from './support/autonomous-research-one-shot-campaign-attempt-fixture.mjs';
import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
let fixture;
const observed=[];
const call=(engine,values,additions={},...rest)=>fixture.run(engine,values,{NODE_NO_WARNINGS:'1',...additions},...rest);
const args=v=>['operator','autonomous-research-one-shot-campaign-attempt','--',...v];
const phases=['attempt_reserved','preconditions_verified','prepare_verified','provider_started','provider_completed','launch_started'];
const at='2026-08-03T00:00:00.000Z';
before(()=>{fixture=createNormalQualificationFixtureV1(['autonomous-research-one-shot-campaign-attempt']);});
after(()=>{process.stdout.write(`# one-shot-status-observations ${JSON.stringify(observed)}\n`);fixture?.close();});
function prepared(label,stage=0,terminal=null,variant=null,defaultPaths=false){
 const base=path.join(fixture.root,'one-shot-fixtures',label);
 const runtime=defaultPaths?path.join(path.dirname(fixture.root),'hepta-paper-runtime/native-runtime'):path.join(base,'native-runtime');
 const control=defaultPaths?path.join(path.dirname(runtime),'one-shot-campaign-control'):path.join(base,'control');
 fs.mkdirSync(runtime,{recursive:true,mode:0o700});
 const repository=createCampaignOneShotAttemptJournalRepository({controlRoot:control,runtimeRoot:runtime,create:true,clock:{now:()=>new Date(at)}});
 const binding=executionBinding();
 if(variant){binding.providerRuntimeBinding=variant();binding.providerRuntimeBindingHash=hashRecord('AutonomousResearchOneShotProviderRuntimeBinding',binding.providerRuntimeBinding);}
 const reservation=buildAutonomousResearchOneShotCampaignAttemptReservation({attemptId:`attempt-${label}`,idempotencyKey:hashRecord('OneShotNormalTest',{label}),campaignId:binding.targetCampaignDefinition.campaignId,protectedCampaignId:binding.protectedCampaignDefinition.campaignId,executionBinding:binding,reservedAt:at});
 let inspection=repository.reserveAttempt({reservation});
 for(let i=1;i<=stage;i+=1){inspection=repository.appendEvent({attemptId:reservation.attemptId,phase:phases[i],evidence:{ready:true,unicode:'é\ud800😀'},expectedSequence:inspection.events.length+1,expectedPhase:inspection.headPhase,expectedPreviousEventHash:inspection.headEventHash,recordedAt:at});}
 if(terminal){inspection=repository.finalizeAttempt({attemptId:reservation.attemptId,terminalStatus:terminal,outcome:{synthetic:true,externalActionPerformed:false},expectedSequence:inspection.events.length+1,expectedPhase:inspection.headPhase,expectedPreviousEventHash:inspection.headEventHash,completedAt:at});}
 repository.close();
 return {runtime,control,attempt:reservation.attemptId,database:path.join(control,'campaign-one-shot-attempt.sqlite'),argv:defaultPaths?['--attempt-id',reservation.attemptId]:['--attempt-id',reservation.attemptId,'--runtime-root',runtime,'--control-root',control]};
}
async function pair(v,scope,code=0,error=null){
 const before=fixture.snapshot(scope);const node=await call('node',args(v));const native=await call('native',args(v));
 assert.equal(node.status,code,node.stderr);assert.equal(native.status,node.status,native.stderr);
 if(code===0){assert.equal(native.stdout,node.stdout);assert.equal(native.stderr,node.stderr);}
 else{assert.equal(node.stdout,'');assert.equal(native.stdout,'');assert.ok(node.stderr.includes(error),node.stderr);assert.ok(native.stderr.includes(error),native.stderr);}
 assert.deepEqual(fixture.snapshot(scope),before);observed.push({v,node,native,effects:'full selected namespace unchanged',protocolFixture:true,liveProviderQualified:false});
 return code===0?JSON.parse(native.stdout):null;
}
test('normal_one_shot_status_complete_registry_grammar_help_and_precedence_match_original',async()=>{
 const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
 const producer=path.join(source,'docs/tools/generate-one-shot-status-contract.mjs');
 const pin=fixture.pin(producer);const generated=await call('oracle',[producer]);assert.equal(generated.status,0,generated.stderr);assert.equal(generated.stdout,fs.readFileSync(path.join(source,'rust/crates/hepta-paper-service/src/ordinary_one_shot/contract.v1.json'),'utf8'));assert.deepEqual(fixture.pin(producer),pin);
 const schema=resolveHeptaPaperCommand('operator','autonomous-research-one-shot-campaign-attempt').forwardedArgumentSchema;
 const cases=[['--'],['positional'],['-h'],['--json'],['--help','--unknown']];
 for(const key of schema.booleanFlags)cases.push([`--${key}=true`],[`--${key}`,`--${key}`]);
 for(const key of schema.valueFlags)cases.push([`--${key}`],[`--${key}=`],[`--${key}`,''],[`--${key}`,'--help'],[`--${key}=a`,`--${key}=b`]);
 for(const v of cases){const n=await call('node',args(v)),r=await call('native',args(v),{},fixture.unknown);assert.equal(n.status,2);assert.equal(r.status,2);assert.equal(r.stdout,'');assert.deepEqual(JSON.parse(r.stderr),JSON.parse(n.stderr));}
 for(const v of [['--help'],['--action=invalid','--attempt-id=missing','--root=ignored','--dataset-mount-file=unread','--help']]){const n=await call('node',args(v)),r=await call('native',args(v),{},fixture.unknown);assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,n.stdout);assert.equal(r.stderr,n.stderr);}
 for(const [v,error] of [[[],'autonomous_research_one_shot_attempt_id_required'],[['--action=wrong'],'autonomous_research_one_shot_action_invalid:wrong']]){const n=await call('node',args(v)),r=await call('native',args(v),{},fixture.unknown);assert.equal(n.status,1);assert.equal(r.status,1);assert.ok(n.stderr.includes(error));assert.ok(r.stderr.includes(error));}
});
test('normal_one_shot_status_full_phase_and_terminal_dispositions_preserve_original_raw_wire',async()=>{
 for(let stage=0;stage<6;stage+=1){const f=prepared(`phase-${stage}`,stage);const r=await pair(f.argv,path.dirname(f.runtime));assert.equal(r.headPhase,phases[stage]);if(stage===3)assert.equal(r.recoveryDisposition.status,'provider_outcome_unknown_no_replay');if(stage===5)assert.equal(r.recoveryDisposition.status,'launch_outcome_unknown_monitor_only');}
 const terminalCases=[[0,'blocked_pre_provider'],[1,'blocked_pre_provider'],[2,'blocked_pre_provider'],[4,'blocked_post_provider'],[3,'recovered_incomplete'],[5,'recovered_incomplete'],[5,'completed'],[5,'failed_terminal']];
 for(const [stage,status]of terminalCases){const f=prepared(`terminal-${stage}-${status}`,stage,status);const r=await pair(f.argv,path.dirname(f.runtime));assert.equal(r.recoveryDisposition.status,'terminal_replay');assert.equal(r.terminalReceipt.terminalStatus,status);}
 for(const [label,variant]of [['gateway',gatewayProviderRuntimeBinding],['legacy-provider',legacyProviderRuntimeBinding]]){const f=prepared(label,0,null,variant);await pair(f.argv,path.dirname(f.runtime));}
});
test('normal_one_shot_status_physical_defaults_ignored_options_and_relative_paths_match_node',async()=>{
 const f=prepared('default',0,null,null,true);await pair(f.argv,path.dirname(f.runtime));
 await pair([...f.argv,'--root=ignored-nonexistent','--dataset-mount-file=ignored-invalid'],path.dirname(f.runtime));
 const relative=prepared('relative');const rel=p=>path.relative(fixture.root,p);
 await pair(['--action=status','--attempt-id',relative.attempt,'--runtime-root',rel(relative.runtime),'--control-root',rel(relative.control)],path.dirname(relative.runtime));
 const n=await call('native',args(f.argv),{},fixture.unknown);assert.equal(n.status,1);assert.ok(n.stderr.includes('native_workspace_root_required'));
 const explicit=await call('native',args(f.argv),{HEPTA_PAPER_WORKSPACE_ROOT:fixture.root},fixture.unknown);assert.equal(explicit.status,0,explicit.stderr);
});
test('normal_one_shot_status_missing_identity_schema_selfhash_and_sidecars_refuse_without_repair',async()=>{
 const f=prepared('refusals');const dir=path.dirname(f.runtime);
 await pair(['--attempt-id=unissued','--runtime-root',f.runtime,'--control-root',f.control],dir,1,'autonomous_research_one_shot_attempt_missing');
 await pair(['--attempt-id=x','--runtime-root',f.runtime,'--control-root',path.join(dir,'missing')],dir,1,'autonomous_research_one_shot_attempt_missing');
 fs.chmodSync(f.control,0o755);await pair(f.argv,dir,1,'campaign_one_shot_attempt_control_root_invalid');fs.chmodSync(f.control,0o700);
 fs.chmodSync(f.database,0o644);await pair(f.argv,dir,1,'campaign_one_shot_attempt_journal_file_invalid');fs.chmodSync(f.database,0o600);
 for(const suffix of ['-wal','-shm','-journal']){const p=f.database+suffix;fs.writeFileSync(p,'',{mode:0o600});await pair(f.argv,dir,1,'campaign_one_shot_attempt_journal_sidecar_forbidden');fs.unlinkSync(p);}
 fs.renameSync(f.database,`${f.database}.held`);fs.symlinkSync(`${f.database}.held`,f.database);await pair(f.argv,dir,1,'campaign_one_shot_attempt_journal_file_invalid');fs.unlinkSync(f.database);fs.renameSync(`${f.database}.held`,f.database);
 await pair(f.argv,dir);
 const database=new DatabaseSync(f.database);
 const trigger=database.prepare("SELECT sql FROM sqlite_schema WHERE name='campaign_one_shot_attempt_events_no_update'").get().sql;
 database.exec('DROP TRIGGER campaign_one_shot_attempt_events_no_update;');database.close();
 await pair(f.argv,dir,1,'campaign_one_shot_attempt_journal_schema_invalid');
 const restore=new DatabaseSync(f.database);restore.exec(trigger);restore.close();await pair(f.argv,dir);
 const alter=new DatabaseSync(f.database);const guard=alter.prepare("SELECT sql FROM sqlite_schema WHERE name='campaign_one_shot_attempts_no_update'").get().sql;
 const raw=alter.prepare('SELECT reservation_json FROM campaign_one_shot_attempts').get().reservation_json;
 alter.exec('DROP TRIGGER campaign_one_shot_attempts_no_update;');const bad=JSON.parse(raw);bad.executionBinding.codeProvenance.tags.push('unbound-change');
 alter.prepare('UPDATE campaign_one_shot_attempts SET reservation_json=?').run(stableStringify(bad));alter.exec(guard);alter.close();
 await pair(f.argv,dir,1,'campaign_one_shot_attempt_journal_reservation_invalid');
 const retry=new DatabaseSync(f.database);retry.exec('DROP TRIGGER campaign_one_shot_attempts_no_update;');retry.prepare('UPDATE campaign_one_shot_attempts SET reservation_json=?').run(raw);retry.exec(guard);retry.close();await pair(f.argv,dir);
 // A valid journal larger than16MiB remains in the original256MiB domain.
 const larger=prepared('large');const fd=fs.openSync(larger.database,'r+');fs.ftruncateSync(fd,32*1024*1024);fs.closeSync(fd);
 await pair(larger.argv,path.dirname(larger.runtime));
});
test('normal_one_shot_status_unknown_entry_term_kill_preserve_journal_and_fresh_same_namespace_retry',async()=>{
 const f=prepared('interrupt',5);const dir=path.dirname(f.runtime);
 for(const engine of ['node','native'])for(const signal of ['SIGTERM','SIGKILL']){const before=fixture.snapshot(dir);const result=await call(engine,args(f.argv),{},fixture.binary,signal);assert.equal(result.status,null);assert.equal(result.signal,signal);assert.deepEqual(fixture.snapshot(dir),before);await pair(f.argv,dir);observed.push({engine,signal,scope:'actual unknown entry; no claimed database read phase',result});}
});
test('normal_one_shot_status_recomputed_historical_chains_refuse_without_mutation_or_permit',async()=>{
 for(const ordinal of [52,53,55,56]){
  const f=prepared(`historical-${ordinal}`);let binding=executionBinding();
  binding.targetCampaignDefinition={...binding.targetCampaignDefinition,campaignId:`autonomous-research:local-auto-20260730-${ordinal}`,paperId:`local-auto-20260730-${ordinal}`,datasetMountsHash:'sha256:586dd4d1edb5ca3efee48d02726a1c7cf2044a6afe81b34bc5821c1e97d9c520'};
  binding.targetCampaignDefinitionHash=autonomousResearchOneShotTargetCampaignDefinitionHash(binding.targetCampaignDefinition);
  if(ordinal===52)binding=Object.fromEntries(Object.entries(binding).filter(([key])=>!['providerRuntimeBinding','providerRuntimeBindingHash'].includes(key)));
  assert.equal(verifyAutonomousResearchOneShotCampaignExecutionBindingForHistoricalAudit(binding),true);
  const id=`historical-attempt-${ordinal}`;const idempotencyKey=hashRecord('OneShotNormalHistoricalTest',{ordinal});
  const payload={version:1,kind:'AutonomousResearchOneShotCampaignAttemptReservation',status:'attempt_reserved',attemptId:id,idempotencyKey,campaignId:binding.targetCampaignDefinition.campaignId,protectedCampaignId:binding.protectedCampaignDefinition.campaignId,executionBinding:binding,executionBindingHash:hashRecord('AutonomousResearchOneShotCampaignExecutionBinding',binding),reservedAt:at};
  const reservation={...payload,autonomousResearchOneShotCampaignAttemptReservationHash:hashRecord('AutonomousResearchOneShotCampaignAttemptReservation',payload)};
  assert.equal(verifyAutonomousResearchOneShotCampaignAttemptReservationForHistoricalAudit(reservation),true);
  const reservationHash=reservation.autonomousResearchOneShotCampaignAttemptReservationHash;
  const evidence={reservationHash};const eventPayload={version:1,kind:'AutonomousResearchOneShotCampaignAttemptEvent',attemptId:id,idempotencyKey,campaignId:reservation.campaignId,reservationHash,sequence:1,eventId:hashRecord('AutonomousResearchOneShotCampaignAttemptEventId',{attemptId:id,phase:'attempt_reserved',reservationHash,sequence:1}),phase:'attempt_reserved',previousEventHash:null,evidence,evidenceHash:hashRecord('AutonomousResearchOneShotCampaignAttemptEventEvidence',evidence),recordedAt:at};
  const event={...eventPayload,autonomousResearchOneShotCampaignAttemptEventHash:hashRecord('AutonomousResearchOneShotCampaignAttemptEvent',eventPayload)};
  const database=new DatabaseSync(f.database);
  try{database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');database.prepare('INSERT INTO campaign_one_shot_attempts(attempt_id,idempotency_key,campaign_id,protected_campaign_id,execution_binding_hash,reservation_hash,reservation_json,reserved_at) VALUES(?,?,?,?,?,?,?,?)').run(id,idempotencyKey,reservation.campaignId,reservation.protectedCampaignId,reservation.executionBindingHash,reservationHash,stableStringify(reservation),at);database.prepare('INSERT INTO campaign_one_shot_attempt_events(event_id,attempt_id,sequence,phase,previous_event_hash,event_hash,event_json,recorded_at) VALUES(?,?,?,?,?,?,?,?)').run(event.eventId,id,1,event.phase,null,event.autonomousResearchOneShotCampaignAttemptEventHash,stableStringify(event),at);database.exec('COMMIT;');}finally{database.close();}
  await pair(['--attempt-id',id,'--runtime-root',f.runtime,'--control-root',f.control],path.dirname(f.runtime),1,'autonomous_research_one_shot_historical_attempt_anchor_invalid');
  await pair(f.argv,path.dirname(f.runtime));
 }
});

test('normal_one_shot_status_active_journal_read_term_kill_retains_unknown_and_fresh_retry',async()=>{
 const f=prepared('active-read',3);const dir=path.dirname(f.runtime);const fd=fs.openSync(f.database,'r+');
 try{fs.ftruncateSync(fd,256*1024*1024);}finally{fs.closeSync(fd);}
 const expected=await pair(f.argv,dir);assert.equal(expected.recoveryDisposition.status,'provider_outcome_unknown_no_replay');
 for(const signal of ['SIGTERM','SIGKILL']){
  const before=fixture.snapshot(dir);const result=await call('native',args(f.argv),{},fixture.binary,signal,null,null,true,f.database);
  assert.equal(result.status,null);assert.equal(result.signal,signal);assert.ok(BigInt(result.readBarrier.readCounters.delta)>=64n*1024n);assert.deepEqual(result.readBarrier.identity,fixture.pin(f.database).identity);
  assert.deepEqual(fixture.snapshot(dir),before);const retry=await pair(f.argv,dir);assert.deepEqual(retry,expected);assert.equal(retry.recoveryDisposition.mayAppendProviderStarted,false);assert.equal(retry.recoveryDisposition.mayAppendLaunchStarted,false);
  observed.push({engine:'native',signal,scope:'actual original 256Mi journal descriptor with read progress and position-neutral pread; no VM instruction or durable phase claim',result,naturalGroupTerminationVerified:true,journalCreated:false,externalActionsReplayed:false});
 }
});
