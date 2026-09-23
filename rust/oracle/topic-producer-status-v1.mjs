// Owned actual profile and offline repository fixtures. No provider execution,
// authority hooks, live mutation acceptance or independent qualification.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
if(typeof process.argv[2]!=='string'||Buffer.byteLength(process.argv[2])>96*1024)throw Error('owned_topic_status_argument_bound');
const input=JSON.parse(process.argv[2]);const root=path.resolve(input.root);const stat=fs.lstatSync(root);
if(!root.startsWith(fs.realpathSync(os.tmpdir())+path.sep)||fs.realpathSync(root)!==root||!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o700||fs.readFileSync(path.join(root,'.owned-topic-profile-fixture'),'utf8')!=='owned topic profile fixture\n')throw Error('owned_topic_status_fixture_required');
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
import {readAutonomousResearchTopicProducerProfile as readProfile} from '../../paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs';
import {createAutonomousResearchTopicProducerRepository as createRepository} from '../../paper-adapters/automation/autonomous-research-topic-producer-repository.mjs';
import {createAutonomousResearchTopicProducerLiveAuthority as createAuthority} from '../../paper-application/automation/autonomous-research-topic-producer-live-authority.mjs';
import {inspectAutonomousResearchTopicProducerStatus as inspect} from '../../paper-adapters/automation/autonomous-research-topic-producer-status.mjs';
import {buildAutonomousResearchTopicProducerPlannedGeneration as buildPlanned,buildAutonomousResearchTopicProducerCapabilityReceipt as buildCapability,verifyAutonomousResearchTopicProducerCapabilityReceipt as verifyCapability} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
const EVIDENCE='owned_actual_topic_status_and_offline_repository_no_provider_execution_or_authority_acceptance';
const runtimeRoot=path.join(root,'runtime');const databasePath=path.join(runtimeRoot,'autonomous-research/topic-producer/topic-producer.sqlite');const stateFile=path.join(root,'status-fixture.json');
const hash=c=>'sha256:'+c.repeat(64);let callbacks=0;
function forbidden(){callbacks++;throw Error('owned_offline_fixture_forbids_authority_execution');}
function write(file,value){fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});fs.chmodSync(file,0o600);}
function loadProfile(){return readProfile({profilePath:path.join(root,'profile.json'),datasetRoot:path.join(root,'datasets'),environment:{}});}
function repository(data,profile,offlineProvision){
 const authority=createAuthority({runProviderCanary:forbidden,remeasureAuthorities:forbidden,clock:{now:()=>new Date(data.now)},hashRecord,providerCanaryPairMaximumCostUsd:0.25});
 return createRepository({runtimeRoot,machineIntakeConfigurationHash:data.configurationHash,producerProfile:profile,providerCanaryPairMaximumCostUsd:0.25,liveMutationAuthority:authority,create:true,offlineProvision});
}
function diagnostic(data){
 const loaded=loadProfile();
 return inspect({runtimeRoot,machineIntakeConfigurationHash:input.configurationHash??data.configurationHash,producerProfile:loaded.producerProfile,implementationSha256:loaded.implementationIdentity.implementationSha256,now:input.now??data.now});
}
function setup(){
 if(fs.existsSync(runtimeRoot))throw Error('owned_topic_status_runtime_already_exists');
 const loaded=loadProfile();const data={evidenceScope:EVIDENCE,root,runtimeRoot,databasePath,profile:loaded.producerProfile,configurationHash:hash('c'),now:input.now??'2026-09-22T00:00:00.000Z',lease:null,generation:null};
 if(!['empty','lease','planned'].includes(input.scenario))throw Error('owned_topic_status_setup_scenario_invalid');
 const actual=repository(data,loaded.producerProfile,true);
 try{
  if(input.scenario!=='empty')data.lease=actual.tryAcquireLease({ownerId:'owned-offline-status-fixture',leaseMs:60000,now:data.now});
  if(input.scenario==='planned')data.generation=actual.prepareGeneration({lease:data.lease,now:data.now});
 }finally{actual.close();}
 if(callbacks!==0)throw Error('owned_topic_status_unexpected_authority_callback');
 data.callbackCount=callbacks;data.expected=diagnostic(data);write(stateFile,data);return data;
}
function recordedCapability(data){
 const loaded=loadProfile();const db=new DatabaseSync(databasePath,{readOnly:true});let row;
 try{row=db.prepare('SELECT * FROM autonomous_research_topic_producer_generation ORDER BY generation_sequence DESC LIMIT 1').get();}finally{db.close();}
 if(!row)throw Error('owned_topic_status_generation_required');const planned=JSON.parse(row.planned_generation_json);
 const observedAt=input.observedAt??data.now;
 function inner(role){const payload={version:1,kind:'CodexModelAvailabilityCanaryReceipt',status:'codex_model_live_canary_verified',selectedModelExecutionCanaryVerified:true,externalActionPerformed:true,externalActionScope:'single_read_only_ephemeral_model_canary',observedAt,expiresAt:new Date(Date.parse(observedAt)+900000).toISOString(),fixtureEvidence:true,fixtureRole:role};return{...payload,codexModelAvailabilityCanaryReceiptHash:hashRecord('CodexModelAvailabilityCanaryReceipt',payload)};}
 const author=inner('research_author'),reviewer=inner('formal_reviewer');
 const payload={version:1,kind:'AutonomousResearchProviderCanaryPairReceipt',status:'autonomous_research_provider_canary_pair_verified',verified:true,externalActionPerformed:true,externalActionScope:'two_read_only_ephemeral_model_canaries',freshnessIntervalMs:900000,observedAt,autonomousResearchProviderConfigurationHash:loaded.producerProfile.providerConfigurationHash,researchAuthorCapabilityReceiptHash:hash('4'),formalReviewerCapabilityReceiptHash:hash('5'),researchAuthorProviderCanaryReceipt:author,formalReviewerProviderCanaryReceipt:reviewer,researchAuthorProviderCanaryReceiptHash:author.codexModelAvailabilityCanaryReceiptHash,formalReviewerProviderCanaryReceiptHash:reviewer.codexModelAvailabilityCanaryReceiptHash};
 const pair={...payload,providerCanaryPairReceiptHash:hashRecord('AutonomousResearchProviderCanaryPairReceipt',payload)};
 const options={producerProfile:loaded.producerProfile,machineIntakeConfigurationHash:data.configurationHash,generationSequence:planned.generationSequence,intake:planned.intake,providerCanaryPairReceipt:pair,plannedGeneration:planned,producerLeaseGeneration:1,producerLeaseTokenHash:hash('7'),residentLeaseGeneration:1,residentLeaseTokenHash:hash('8'),capabilityNonce:'producer-nonce:'+'a'.repeat(32),now:observedAt};
 const capability=buildCapability(options);
 if(!verifyCapability(capability,{...options,requireFresh:true}))throw Error('owned_recorded_capability_contract_invalid');
 return{evidenceScope:EVIDENCE,recordedCanaryClaimsOnly:true,providerCalls:callbacks,capability};
}
async function keeper(data){
 const loaded=loadProfile();const raw=new DatabaseSync(databasePath);raw.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN;');
 const before=raw.prepare('SELECT last_observed_at FROM autonomous_research_topic_producer_metadata WHERE singleton=1').get();
 const actual=repository(data,loaded.producerProfile,false);
 try{
  const renewed=actual.renewLease({lease:data.lease,leaseMs:60000,now:input.now});if(!renewed||callbacks!==0)throw Error('owned_topic_status_renewal_required');
  const retained=raw.prepare('SELECT last_observed_at FROM autonomous_research_topic_producer_metadata WHERE singleton=1').get();
  const expected=diagnostic(data);const checkpoint=new DatabaseSync(databasePath);let checkpointResult;
  try{checkpointResult=checkpoint.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();}finally{checkpoint.close();}
  if(before.last_observed_at!==retained.last_observed_at||expected.lastObservedAt!==input.now||before.last_observed_at===expected.lastObservedAt)throw Error('owned_topic_status_wal_transition_not_observed');
  process.stdout.write(JSON.stringify({profile:productionOracleProfile(),evidenceScope:EVIDENCE,ready:true,callbacks,before,retained,expected,checkpoint:checkpointResult})+'\n');
  await new Promise(resolve=>{const timer=setTimeout(resolve,180000);process.stdin.once('data',()=>{clearTimeout(timer);resolve();});process.stdin.resume();});
 }finally{actual.close();raw.exec('ROLLBACK;');raw.close();}
}
if(input.action==='keeper'){await keeper(JSON.parse(fs.readFileSync(stateFile,'utf8')));}
else{
 let result;try{let value;
  if(input.action==='setup')value=setup();
  else if(input.action==='inspect')value=diagnostic(JSON.parse(fs.readFileSync(stateFile,'utf8')));
  else if(input.action==='planned'){const data=JSON.parse(fs.readFileSync(stateFile,'utf8'));const loaded=loadProfile();value=buildPlanned({producerProfile:loaded.producerProfile,generationSequence:input.sequence,admissionCreatedAt:input.now??data.now,budgetReservationId:'owned-recorded-reservation-'+input.sequence});}
  else if(input.action==='recorded-capability')value=recordedCapability(JSON.parse(fs.readFileSync(stateFile,'utf8')));
  else if(input.action==='rehash'){const {[input.field]:ignored,...payload}=input.value;value={...payload,[input.field]:hashRecord(input.domain,payload)};}
  else throw Error('owned_topic_status_action_invalid');
  result={ok:true,value};
 }catch(error){result={ok:false,error:error.message};}
 process.stdout.write(JSON.stringify({profile:productionOracleProfile(),evidenceScope:EVIDENCE,...result}));
}
