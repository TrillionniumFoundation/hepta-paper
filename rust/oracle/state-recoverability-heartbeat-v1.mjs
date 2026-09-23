// Independent real heartbeat/coordinator fixture. Only isolated /tmp roots and
// deterministic synthetic keys are accepted; no production authority is used.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
import {hashRecord,hashBytes} from '../../workflow-kernel/record-hash.mjs';
import * as contract from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {autonomousResearchOnlineWriterOperationManifestHash} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {createExternallyFencedSqliteMutationCoordinator} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs';
import {externallyFencedSqliteWriterPlanHash} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import {AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_MUTATION_PLANS as PLANS,AUTONOMOUS_RESEARCH_RESIDENT_INSTANCE_WRITER_ID as WRITER} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-mutation-plan.mjs';
import {createAutonomousResearchSupervisorInstanceRepository} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {resolveAutonomousResearchStateDatabaseInventory} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
const OP='resident-instance.supervisor-instance-repository.heartbeatInstanceLease.v1';
const PROTOCOL=contract.AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL;
const H=label=>hashRecord('RecoverabilityNativeFixture',{label});
const key=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,88)]),format:'der',type:'pkcs8'});
const publicKey=crypto.createPublicKey(key);
const sign=v=>({...v,signature:crypto.sign(null,Buffer.from(contract.autonomousResearchOnlineMutationSignedPayload(v)),key).toString('base64')});
const verify=receipt=>crypto.verify(null,Buffer.from(contract.autonomousResearchOnlineMutationSignedPayload(receipt)),publicKey,Buffer.from(receipt.signature,'base64'));
const write=(file,value)=>{fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});fs.chmodSync(file,0o600);};
function checkedRoot(root){if(!root.startsWith('/tmp/hepta-recoverability-e2e-')||fs.realpathSync(root)!==root||!fs.lstatSync(root).isDirectory())throw Error('isolated_fixture_required');}
function base(input){const result=JSON.parse(execFileSync(process.execPath,[path.join(import.meta.dirname,'state-recoverability-v1.mjs')],{input:JSON.stringify(input)}));if(!result.ok)throw Error(result.error);return result.value;}
function fixture(root){
 const f=base({root,mode:'fixture'}),plans={[OP]:PLANS[OP]},writer=f.writerManifest;
 writer.writers=[{writerId:WRITER,databaseRoles:['resident-instance'],operationIds:[OP],implementationHash:externallyFencedSqliteWriterPlanHash({writerId:WRITER,operationPlans:[plans[OP]]}),protocol:PROTOCOL}];
 const operation=writer.operations.find(o=>o.databaseRole==='resident-instance');Object.assign(operation,{operationId:OP,sourceFile:'paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs',entrypoint:'heartbeatInstanceLease'});
 const hash=autonomousResearchOnlineWriterOperationManifestHash(writer);
 for(const instance of f.inventory.instances){
  const db=new DatabaseSync(path.join(f.runtime,instance.sourceRelativePath));
  const trigger=db.prepare("SELECT sql FROM sqlite_schema WHERE name='autonomous_research_online_mutation_metadata_no_update'").get().sql;
  db.exec('DROP TRIGGER autonomous_research_online_mutation_metadata_no_update');
  db.prepare('UPDATE autonomous_research_online_mutation_authority_metadata SET writer_manifest_hash=?').run(hash);db.exec(trigger);db.close();
 }
 const online=JSON.parse(fs.readFileSync(f.onlineConfiguration));online.writerManifestHash=hash;write(f.onlineConfiguration,online);f.onlineConfigurationHash=hashBytes(fs.readFileSync(f.onlineConfiguration));
 const backup=JSON.parse(fs.readFileSync(f.backupConfiguration));backup.onlineMutationAuthorityConfigurationSha256=f.onlineConfigurationHash;write(f.backupConfiguration,backup);f.backupConfigurationHash=hashBytes(fs.readFileSync(f.backupConfiguration));
 f.inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:f.runtime,manifest:f.manifest});if(f.inventory.blockers.length)throw Error(JSON.stringify(f.inventory.blockers));
 f.plans=plans;write(path.join(root,'fixture.json'),f);return f;
}
function heartbeat(root,f,input){
 const raw=JSON.parse(fs.readFileSync(f.onlineConfiguration));
 const trust={version:1,kind:'AutonomousResearchOnlineMutationAuthorityTrust',authorityId:raw.authorityId,keyId:raw.keyId,scopeId:raw.scopeId,databaseScopeHash:raw.databaseScopeHash,writerManifestHash:raw.writerManifestHash,maximumReservationLeaseMs:raw.maximumReservationLeaseMs,maximumObservationAgeMs:raw.maximumObservationAgeMs};
 const journalFile=path.join(root,'journal-fixture.json');const previous=fs.existsSync(journalFile)?JSON.parse(fs.readFileSync(journalFile)):null;
 const sequence=previous?.entries.length||0;
 let heads=previous?.databaseHeads||f.inventory.instances.map(i=>({databaseRole:i.role,databaseInstanceId:i.instanceId,sequence:0,hash:H(`database:${i.instanceId}:0`),schemaHash:i.schemaHash,stateHash:H(`state:${i.instanceId}:0`)})).sort((a,b)=>a.databaseInstanceId.localeCompare(b.databaseInstanceId));
 let reservation=null,reserveRequest=null,finalizeRequest=null,finalization=null;
 const calls=[],marked=[],now=input.now||new Date(Date.parse(f.now)+1000*(sequence+1)).toISOString();
 const expires=new Date(Date.parse(now)+60000).toISOString();
 const shared={trust,verifySignature:verify,hashChangesetBase64:v=>hashBytes(Buffer.from(v,'base64'))};
 const client={protocol:PROTOCOL,trust,
  observeCurrentHead({request,now,expectedDatabaseInstances}){calls.push(request);const receipt=sign({version:1,kind:'AutonomousResearchOnlineMutationCurrentHeadReceipt',status:'autonomous_research_online_mutation_current_head_observed',authorityId:trust.authorityId,keyId:trust.keyId,requestHash:hashRecord(request.kind,request),protocol:PROTOCOL,scopeId:trust.scopeId,databaseScopeHash:trust.databaseScopeHash,writerManifestHash:trust.writerManifestHash,globalSequence:sequence,globalHash:previous?.globalHash||f.globalHash,databaseHeads:heads,unresolvedReservationCount:0,observedAt:now.toISOString(),expiresAt:expires});if(!contract.verifyAutonomousResearchOnlineMutationCurrentHead({receipt,request,now,expectedDatabaseInstances,...shared}))throw Error('fixture_head_invalid');return receipt;},
  reserveMutation({request,now}){calls.push(request);reserveRequest=request;const{requestedAt,requestedLeaseMs,...mirror}=request;reservation=sign({...mirror,kind:'AutonomousResearchOnlineMutationReservationReceipt',status:'autonomous_research_online_mutation_reserved',authorityId:trust.authorityId,keyId:trust.keyId,requestHash:hashRecord(request.kind,request),reservationId:`heartbeat:${sequence+1}`,globalSequence:sequence+1,globalHash:H(`global:${sequence+1}`),databaseSequence:sequence+1,databaseHash:H(`database:resident-instance:${sequence+1}`),issuedAt:now.toISOString(),expiresAt:expires});if(!contract.verifyAutonomousResearchOnlineMutationReservation({receipt:reservation,request,now,...shared}))throw Error('fixture_reservation_invalid');return reservation;},
  verifyStoredReservation({receipt,request}){return contract.verifyAutonomousResearchOnlineMutationReservation({receipt,request,now:new Date(receipt.issuedAt),...shared});},
  finalizeMutation({request,reservation,now}){calls.push(request);finalizeRequest=request;const{committedAt,...mirror}=request;finalization=sign({...mirror,kind:'AutonomousResearchOnlineMutationFinalizationReceipt',status:'autonomous_research_online_mutation_finalized',authorityId:trust.authorityId,keyId:trust.keyId,requestHash:hashRecord(request.kind,request),sideEffectPermitHash:H(`heartbeat-permit:${sequence+1}`),finalizedAt:now.toISOString()});if(!contract.verifyAutonomousResearchOnlineMutationFinalization({receipt:finalization,request,reservation,now,...shared}))throw Error('fixture_finalization_invalid');return finalization;},
  abortMutation(){throw Error('unexpected_fixture_abort');},resolveMutationAttempt(){throw Error('unexpected_fixture_resolution');},
 };
 const fence={markMutationFinalized:v=>marked.push(v),markMutationReconciliationRequired(){throw Error('unexpected_fixture_reconciliation');},assertCurrent(){throw Error('fixture_has_no_active_epoch');},reconcile(){throw Error('fixture_has_no_active_epoch');}};
 const coordinator=createExternallyFencedSqliteMutationCoordinator({authorityClient:client,manifest:f.writerManifest,operationPlans:f.plans,databaseInstances:heads.map(({databaseRole,databaseInstanceId,schemaHash})=>({databaseRole,databaseInstanceId,schemaHash})),recoverabilityEpochFence:fence,clock:{now:()=>new Date(now)}});
 const repository=createAutonomousResearchSupervisorInstanceRepository({runtimeRoot:f.runtime,create:true,offlineProvision:false,mutationCoordinator:coordinator,requireExternallyFencedMutations:false});
 let lease,row;try{lease=repository.heartbeatInstanceLease({lease:f.lease,cycleReceipt:input.cycle?{autonomousResearchSupervisorCycleReceiptHash:H('cycle:one')}:null,now:new Date(now)});row=repository.assertInstanceLease({lease,now:new Date(now)});}finally{repository.close();}
 if(!reservation||!finalization||!lease)throw Error('fixture_expected_real_heartbeat');
 heads=heads.map(h=>h.databaseInstanceId==='resident-instance'?{...h,sequence:reservation.databaseSequence,hash:reservation.databaseHash,stateHash:reservation.postStateHash}:h);
 const journal={entries:[...(previous?.entries||[]),{reserveRequest,reservationReceipt:reservation,finalizeRequest,finalizationReceipt:finalization}],databaseHeads:heads,globalHash:reservation.globalHash};
 if(input.scenario==='bad-signature')journal.entries.at(-1).finalizationReceipt.signature='invalid';
 write(journalFile,journal);
 if(['unrecorded-row','null-primary-key'].includes(input.scenario)){
  const instance=f.inventory.instances.find(i=>i.role==='native-store');const db=new DatabaseSync(path.join(f.runtime,instance.sourceRelativePath));
  db.exec(input.scenario==='unrecorded-row'?"UPDATE records SET value='not-signed' WHERE id='subject'":"INSERT INTO records(id,value) VALUES(NULL,'not-signed')");db.close();
 }
 const inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:f.runtime,manifest:f.manifest});
 return{lease,row,journal,calls,marked,inventory,now};
}
const input=JSON.parse(fs.readFileSync(0,'utf8'));
try{const root=path.resolve(input.root);checkedRoot(root);let value;if(input.mode==='fixture')value=fixture(root);else{const f=JSON.parse(fs.readFileSync(path.join(root,'fixture.json')));value=input.mode==='heartbeat'?heartbeat(root,f,input):base(input);}process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:true,value}));}catch(error){process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:false,error:error.message,stack:error.stack}));}
