// Isolated initial-composition fixture. The incumbent schema executor and
// resident repository create real SQLite state; actual Ed25519 process receipts
// bind every observation to the signed schema genesis. This is not deployment.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {fixture as databaseFixture, createAuthority, transitionInput, stateDatabaseManifest}
  from '../../paper-core/tests/support/autonomous-research-online-schema-transition-fixture.mjs';
import {createAutonomousResearchSupervisorInstanceRepository}
  from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {planAutonomousResearchOnlineSchemaTransition, executeAutonomousResearchOnlineSchemaTransition}
  from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';
import {validateAutonomousResearchOnlineSchemaTransitionAuditReceipt}
  from '../../paper-adapters/automation/autonomous-research-online-schema-transition-completion.mjs';
import {resolveAutonomousResearchStateDatabaseInventory}
  from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {createAutonomousResearchOnlineMutationReceiptVerifier}
  from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import * as schema from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import * as online from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {autonomousResearchOnlineUnresolvedReservationSetHash}
  from '../../paper-domain/automation/autonomous-research-online-unresolved-reservation-contract.mjs';
import {autonomousResearchStateBackupAuthoritySignaturePayload as backupPayload}
  from '../../paper-adapters/automation/autonomous-research-state-backup-authority.mjs';
import {hashBytes,hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
import {createExternallyFencedSqliteMutationCoordinator} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs';
import {AUTONOMOUS_RESEARCH_ONLINE_MUTATION_OPERATION_PLANS} from '../../paper-composition/bootstrap/autonomous-research-online-mutation-operation-plans.mjs';

const REPO=path.resolve(import.meta.dirname,'../..');
const LEASE_MS=900000;
const privateKey=seed=>crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,seed)]),type:'pkcs8',format:'der'});
const onlineKey=privateKey(103),backupKey=privateKey(104);
const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value[key]]));
const sign=(value,key=onlineKey,payload=online.autonomousResearchOnlineMutationSignedPayload)=>{
  const body={...value};delete body.signature;
  return {...body,signature:crypto.sign(null,Buffer.from(payload(body)),key).toString('base64')};
};
const write=(file,value,mode=0o600)=>{
  fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode});fs.chmodSync(file,mode);
};
function checkRoot(root){
  if(!root.startsWith('/tmp/hepta-online-initial-composition-')||fs.realpathSync(root)!==root||!fs.lstatSync(root).isDirectory())throw Error('isolated_fixture_required');
}
function fixture(root){
  checkRoot(root);
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace,{mode:0o700});
  for(const name of ['paper-adapters','paper-application','paper-composition','paper-core','paper-domain','paper-ports','workflow-kernel','store'])
    fs.cpSync(path.join(REPO,name),path.join(workspace,name),{recursive:true,dereference:true});
  fs.symlinkSync(path.join(REPO,'node_modules'),path.join(workspace,'node_modules'));
  const generated=databaseFixture({after(){}}),runtime=path.join(root,'runtime');
  fs.renameSync(generated.runtimeRoot,runtime);fs.rmdirSync(generated.parent);
  // Provision the real source-owned lease table/row before any schema inventory
  // or signatures, replacing the schema fixture's generic required-table stub.
  const residentPath=path.join(runtime,'autonomous-research/supervisor/resident-instance.sqlite');
  const residentDatabase=new DatabaseSync(residentPath);
  residentDatabase.exec('DROP TABLE autonomous_research_supervisor_instance;');residentDatabase.close();
  const resident=createAutonomousResearchSupervisorInstanceRepository({runtimeRoot:runtime});
  const lease=resident.acquireInstanceLease({ownerId:'resident:initial-composition-fixture',now:new Date(),leaseMs:1800000,heartbeatMs:30000});
  resident.close();if(!lease)throw Error('actual_resident_lease_required');
  const backupRoot=path.join(runtime,'backups/autonomous-research-state');fs.mkdirSync(backupRoot,{recursive:true,mode:0o700});
  const raw=createAuthority(runtime),clock={now:()=>new Date()};
  const onlinePublic=path.join(root,'online-public.json'),backupPublic=path.join(root,'backup-public.json');
  write(onlinePublic,{version:1,kind:'AutonomousResearchOnlineMutationAuthorityPublicKey',authorityId:raw.client.trust.authorityId,keyId:raw.client.trust.keyId,algorithm:'ed25519',publicKeyPem:crypto.createPublicKey(onlineKey).export({type:'spki',format:'pem'})});
  write(backupPublic,{version:1,kind:'AutonomousResearchStateBackupAuthorityPublicKey',authorityId:'backup:initial-composition',keyId:'backup:key:initial-composition',algorithm:'ed25519',publicKeyPem:crypto.createPublicKey(backupKey).export({type:'spki',format:'pem'})});
  const onlineConfiguration=path.join(root,'online-configuration.json');
  write(onlineConfiguration,{...raw.client.trust,kind:'AutonomousResearchOnlineMutationAuthorityConfiguration',maximumReservationLeaseMs:LEASE_MS,maximumObservationAgeMs:LEASE_MS,publicKeyPath:onlinePublic,publicKeySha256:hashBytes(fs.readFileSync(onlinePublic))});
  const verifier=createAutonomousResearchOnlineMutationReceiptVerifier({configurationPath:onlineConfiguration});
  const verify=(name,options)=>schema[name]({...options,trust:verifier.trust,verifySignature:verifier.verifySignedReceipt});
  let genesis;
  const client={trust:verifier.trust,
    reserveSchemaTransition(options){const receipt=sign(raw.client.reserveSchemaTransition(options));genesis=receipt.databaseGenesis;return receipt;},
    finalizeSchemaTransition(options){return sign({...raw.client.finalizeSchemaTransition(options),globalSequence:genesis[0].globalSequence,globalHash:genesis[0].globalHash});},
    observeSchemaTransition(options){return sign({...raw.client.observeSchemaTransition(options),globalSequence:genesis[0].globalSequence,globalHash:genesis[0].globalHash,expiresAt:new Date(options.now.getTime()+LEASE_MS).toISOString()});},
    verifyStoredReservation:options=>verify('verifyAutonomousResearchOnlineSchemaTransitionReservation',options),
    verifyHistoricalReservation:options=>verify('verifyAutonomousResearchOnlineSchemaTransitionReservation',{...options,now:new Date(options.receipt.issuedAt)}),
    verifyHistoricalFinalization:options=>verify('verifyAutonomousResearchOnlineSchemaTransitionFinalization',{...options,now:new Date(options.receipt.finalizedAt)}),
    verifyHistoricalObservation:options=>verify('verifyAutonomousResearchOnlineSchemaTransitionObservation',{...options,now:new Date(options.receipt.observedAt)}),
  };
  const input=transitionInput({runtimeRoot:runtime},clock,{client});
  const planned=planAutonomousResearchOnlineSchemaTransition(input);
  const execution=executeAutonomousResearchOnlineSchemaTransition({...input,expectedTransitionId:planned.plan.transitionId});
  if(execution.status!=='autonomous_research_online_schema_transition_ready')throw Error('actual_schema_execution_failed');
  const audit=JSON.parse(fs.readFileSync(path.join(runtime,'autonomous-research/online-schema-transition/FINAL.json'),'utf8'));
  const inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:runtime,manifest:stateDatabaseManifest});
  validateAutonomousResearchOnlineSchemaTransitionAuditReceipt({receipt:audit,inventory,writerManifest:input.writerManifest,authorityClient:client});
  if(audit.finalization.globalSequence!==0||audit.finalization.globalHash!==genesis[0].globalHash)throw Error('schema_genesis_head_binding_failed');
  // Retain the exact original report and raw files before any later heartbeat.
  const checkpointRoot=path.join(root,'checkpoint');fs.mkdirSync(checkpointRoot,{mode:0o700});fs.mkdirSync(path.join(checkpointRoot,'databases'),{mode:0o700});
  write(path.join(checkpointRoot,'POST_INVENTORY.json'),inventory);
  inventory.instances.forEach((instance,index)=>{
    const source=path.join(runtime,instance.sourceRelativePath),target=path.join(checkpointRoot,'databases',`${String(index).padStart(3,'0')}.sqlite`);
    fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);fs.chmodSync(target,0o600);
    if(instance.walFileIdentity!==null){fs.copyFileSync(`${source}-wal`,`${target}-wal`,fs.constants.COPYFILE_EXCL);fs.chmodSync(`${target}-wal`,0o600);}
  });
  if(resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:runtime,manifest:stateDatabaseManifest}).inventoryHash!==inventory.inventoryHash)throw Error('source_changed_during_checkpoint_capture');
  const broker=path.join(root,'authority.mjs');
  write(broker,`#!${process.execPath}\nimport {brokerMain} from ${JSON.stringify(import.meta.url)};\nawait brokerMain(${JSON.stringify(root)});\n`,0o700);
  const onlineProcess=path.join(root,'online-process.json'),backupProcess=path.join(root,'backup-process.json');
  write(onlineProcess,{version:1,kind:'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',authorityConfigurationPath:onlineConfiguration,authorityConfigurationSha256:hashBytes(fs.readFileSync(onlineConfiguration)),commandPath:broker,commandSha256:hashBytes(fs.readFileSync(broker)),fixedArguments:[],timeoutMs:10000});
  write(backupProcess,{version:2,kind:'AutonomousResearchStateBackupAuthorityProcessConfiguration',authorityId:'backup:initial-composition',keyId:'backup:key:initial-composition',commandPath:broker,commandSha256:hashBytes(fs.readFileSync(broker)),publicKeyPath:backupPublic,publicKeySha256:hashBytes(fs.readFileSync(backupPublic)),fixedArguments:[],timeoutMs:10000,maximumReservationLeaseMs:LEASE_MS,maximumHeadObservationAgeMs:LEASE_MS,onlineMutationAuthorityConfigurationPath:onlineConfiguration,onlineMutationAuthorityConfigurationSha256:hashBytes(fs.readFileSync(onlineConfiguration))});
  const value={root,runtime,workspace,backupRoot,checkpointRoot,manifest:stateDatabaseManifest,writerManifest:input.writerManifest,now:new Date().toISOString(),onlineConfiguration,onlineProcess,onlineProcessHash:hashBytes(fs.readFileSync(onlineProcess)),backupConfiguration:backupProcess,backupConfigurationHash:hashBytes(fs.readFileSync(backupProcess)),lease:{...lease,generation:lease.leaseGeneration},genesis,audit,inventory};
  write(path.join(root,'fixture.json'),value);return value;
}
export async function brokerMain(root){
  checkRoot(root);
  const f=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8'));
  const q=JSON.parse(fs.readFileSync(0,'utf8'));
  fs.appendFileSync(path.join(root,'calls.jsonl'),`${JSON.stringify(q)}\n`,{mode:0o600});
  const trust=JSON.parse(fs.readFileSync(f.onlineConfiguration,'utf8'));
  const expiresAt=new Date(Date.parse(q.requestedAt)+LEASE_MS).toISOString();
  const journal=readJournal(root),{globalSequence,globalHash,databaseHeads}=currentHead(f,journal);
  const common={version:1,authorityId:trust.authorityId,keyId:trust.keyId,requestHash:hashRecord(q.kind,q)};
  const scope=pick(q,['protocol','scopeId','databaseScopeHash','writerManifestHash']);
  const onlineBase={...common,...scope,globalSequence,globalHash,expiresAt};
  let receipt;
  if(q.kind==='AutonomousResearchOnlineSchemaTransitionObserveRequest'){
    const original=f.audit.observeRequest;
    for(const key of ['version','protocol','scopeId','databaseScopeHash','writerManifestHash','transitionId','transitionInventoryHash','schemaBundleHash','finalizationReceiptHash','postInventoryHash','postPristineRuntimeStateHash'])
      if(q[key]!==original[key])throw Error('historical_schema_request_mismatch');
    receipt={...onlineBase,kind:'AutonomousResearchOnlineSchemaTransitionObservationReceipt',status:'autonomous_research_online_schema_transition_observed_finalized',...pick(q,['transitionId','transitionInventoryHash','schemaBundleHash','finalizationReceiptHash','postInventoryHash','postPristineRuntimeStateHash']),transitionState:'finalized',observedAt:q.requestedAt};
  }else if(q.kind==='AutonomousResearchOnlineUnresolvedReservationListRequest'){
    receipt={...q,...common,kind:'AutonomousResearchOnlineUnresolvedReservationListReceipt',status:'autonomous_research_online_unresolved_reservations_observed',unresolvedReservations:[],unresolvedReservationCount:0,unresolvedReservationSetHash:autonomousResearchOnlineUnresolvedReservationSetHash([]),observedAt:q.requestedAt,expiresAt};
  }else if(q.kind==='AutonomousResearchOnlineMutationCurrentHeadRequest'){
    receipt={...onlineBase,kind:'AutonomousResearchOnlineMutationCurrentHeadReceipt',status:'autonomous_research_online_mutation_current_head_observed',databaseHeads,unresolvedReservationCount:0,observedAt:q.requestedAt};
  }else if(q.kind==='AutonomousResearchOnlineMutationActiveChallengeRequest'){
    receipt={...onlineBase,kind:'AutonomousResearchOnlineMutationActiveChallengeReceipt',status:'autonomous_research_online_mutation_active_challenge_verified',databaseHeads,challengeNonce:q.challengeNonce,challengedAt:q.requestedAt};
  }else if(q.kind==='AutonomousResearchOnlineMutationScopeRequest'){
    receipt={...onlineBase,kind:'AutonomousResearchOnlineMutationScopeReceipt',status:'autonomous_research_online_mutation_scope_observed',observedAt:q.requestedAt,...pick(q,['staticInspectionReceiptHash','astGateReceiptHash','codeProvenanceHash','operationCount','operationIds','requiredDatabaseRoles','coveredDatabaseRoles'])};
  }else {
    const base={version:1,authorityId:'backup:initial-composition',keyId:'backup:key:initial-composition',requestHash:hashRecord(q.kind,q),databaseScopeHash:q.databaseScopeHash,headSequence:globalSequence,headHash:globalHash};
    if(q.kind==='AutonomousResearchStateBackupAuthorityReserveRequest'){
      receipt={...base,kind:'AutonomousResearchStateBackupAuthorityReservation',status:'autonomous_research_state_backup_authority_reserved',reservationId:`backup:${hashRecord(q.kind,q).slice(7,31)}`,inventoryHash:q.inventoryHash,databaseInstanceIds:q.databaseInstanceIds,issuedAt:q.requestedAt,expiresAt,mutationFenceProtocol:'external-linearizable-reserve-apply-finalize-v1',allRegisteredMutationsFenced:true};
    }else if(q.kind==='AutonomousResearchStateBackupAuthorityFinalizeRequest'){
      receipt={...base,kind:'AutonomousResearchStateBackupAuthorityFinalization',status:'autonomous_research_state_backup_authority_finalized',reservationId:q.reservationId,inventoryHash:q.inventoryHash,snapshotContentHash:q.snapshotContentHash,finalizedAt:q.requestedAt,allRegisteredMutationsFencedThroughFinalize:true};
    }else if(q.kind==='AutonomousResearchStateBackupAuthorityCurrentHeadRequest'){
      receipt={...base,kind:'AutonomousResearchStateBackupAuthorityCurrentHead',status:'autonomous_research_state_backup_authority_head_observed',reservationId:q.reservationId,observedAt:q.requestedAt,expiresAt,mutationFenceProtocol:'external-linearizable-restore-validation-v1',allRegisteredMutationsFenced:true};
    }else throw Error(`unexpected_fixture_authority_operation:${q.kind}`);
    process.stdout.write(JSON.stringify(sign(receipt,backupKey,backupPayload)));return;
  }
  let wire=JSON.stringify(sign(receipt));
  // JSON spelling does not alter the authenticated ECMAScript Number value.
  // Alternate representations exercise the native retained-chain comparison.
  if(f.alternateIntegralHeadSpellings&&fs.readFileSync(path.join(root,'calls.jsonl'),'utf8').trim().split('\n').length%2===0)
    wire=wire.replace(/"(globalSequence|sequence)":(\d+)(?=[,}])/g,'"$1":$2.0');
  process.stdout.write(wire);
}
function readJournal(root){const file=path.join(root,'journal-fixture.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;}
function currentHead(f,journal){
  return journal?{globalSequence:journal.entries.at(-1).reservationReceipt.globalSequence,globalHash:journal.globalHash,databaseHeads:journal.databaseHeads}:{globalSequence:f.audit.finalization.globalSequence,globalHash:f.audit.finalization.globalHash,databaseHeads:f.genesis.map(i=>({databaseRole:i.databaseRole,databaseInstanceId:i.databaseInstanceId,sequence:i.databaseSequence,hash:i.databaseHash,schemaHash:i.schemaHash,stateHash:i.stateHash}))};
}
function heartbeat(root,input){
  checkRoot(root);const f=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8')),prior=readJournal(root);
  const raw=JSON.parse(fs.readFileSync(f.onlineConfiguration,'utf8'));
  const trust={...pick(raw,['authorityId','keyId','scopeId','databaseScopeHash','writerManifestHash','maximumReservationLeaseMs','maximumObservationAgeMs']),version:1,kind:'AutonomousResearchOnlineMutationAuthorityTrust'};
  const PROTOCOL=online.AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL;
  const before=currentHead(f,prior),now=input.now||new Date().toISOString(),expiresAt=new Date(Date.parse(now)+LEASE_MS).toISOString();
  const H=label=>hashRecord('InitialCompositionSignedHeartbeatFixture',{label});
  const verifySignature=receipt=>crypto.verify(null,Buffer.from(online.autonomousResearchOnlineMutationSignedPayload(receipt)),crypto.createPublicKey(onlineKey),Buffer.from(receipt.signature,'base64'));
  const shared={trust,verifySignature,hashChangesetBase64:value=>hashBytes(Buffer.from(value,'base64'))};
  const calls=[],marked=[];let reserveRequest,reservation,finalizeRequest,finalization;
  const client={protocol:PROTOCOL,trust,
    observeCurrentHead({request,now,expectedDatabaseInstances}){calls.push(request);const receipt=sign({...pick(trust,['authorityId','keyId','scopeId','databaseScopeHash','writerManifestHash']),version:1,kind:'AutonomousResearchOnlineMutationCurrentHeadReceipt',status:'autonomous_research_online_mutation_current_head_observed',protocol:PROTOCOL,requestHash:hashRecord(request.kind,request),...before,unresolvedReservationCount:0,observedAt:now.toISOString(),expiresAt});if(!online.verifyAutonomousResearchOnlineMutationCurrentHead({receipt,request,now,expectedDatabaseInstances,...shared}))throw Error('fixture_head_invalid');return receipt;},
    reserveMutation({request,now}){calls.push(request);reserveRequest=request;const {requestedAt,requestedLeaseMs,...mirror}=request;reservation=sign({...mirror,kind:'AutonomousResearchOnlineMutationReservationReceipt',status:'autonomous_research_online_mutation_reserved',authorityId:trust.authorityId,keyId:trust.keyId,requestHash:hashRecord(request.kind,request),reservationId:`heartbeat:${before.globalSequence+1}`,globalSequence:request.globalPreviousSequence+1,globalHash:H(`global:${before.globalSequence+1}`),databaseSequence:request.databasePreviousSequence+1,databaseHash:H(`database:${request.databaseInstanceId}:${request.databasePreviousSequence+1}`),issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+request.requestedLeaseMs).toISOString()});if(!online.verifyAutonomousResearchOnlineMutationReservation({receipt:reservation,request,now,...shared}))throw Error('fixture_reservation_invalid');return reservation;},
    verifyStoredReservation({receipt,request}){return online.verifyAutonomousResearchOnlineMutationReservation({receipt,request,now:new Date(receipt.issuedAt),...shared});},
    finalizeMutation({request,reservation,now}){calls.push(request);finalizeRequest=request;const {committedAt,...mirror}=request;finalization=sign({...mirror,kind:'AutonomousResearchOnlineMutationFinalizationReceipt',status:'autonomous_research_online_mutation_finalized',authorityId:trust.authorityId,keyId:trust.keyId,requestHash:hashRecord(request.kind,request),sideEffectPermitHash:H(`permit:${before.globalSequence+1}`),finalizedAt:now.toISOString()});if(!online.verifyAutonomousResearchOnlineMutationFinalization({receipt:finalization,request,reservation,now,...shared}))throw Error('fixture_finalization_invalid');return finalization;},
    abortMutation(){throw Error('unexpected_fixture_abort');},resolveMutationAttempt(){throw Error('unexpected_fixture_resolution');},
  };
  // This test-only callback records the actual finalize notification; it does
  // not create an active epoch or bypass an activation validation in production.
  const fence={markMutationFinalized:value=>marked.push(value),markMutationReconciliationRequired:value=>marked.push({reconciliation:value}),assertCurrent(){throw Error('fixture_has_no_active_epoch');},reconcile(){throw Error('fixture_has_no_active_epoch');}};
  const coordinator=createExternallyFencedSqliteMutationCoordinator({authorityClient:client,manifest:f.writerManifest,operationPlans:AUTONOMOUS_RESEARCH_ONLINE_MUTATION_OPERATION_PLANS,databaseInstances:before.databaseHeads.map(({databaseRole,databaseInstanceId,schemaHash})=>({databaseRole,databaseInstanceId,schemaHash})),recoverabilityEpochFence:fence,clock:{now:()=>new Date(now)}});
  const repository=createAutonomousResearchSupervisorInstanceRepository({runtimeRoot:f.runtime,create:true,offlineProvision:false,mutationCoordinator:coordinator,requireExternallyFencedMutations:false});
  let lease,row;try{lease=repository.heartbeatInstanceLease({lease:prior?.lease||f.lease,cycleReceipt:{autonomousResearchSupervisorCycleReceiptHash:H(`cycle:${before.globalSequence+1}`)},now:new Date(now)});row=repository.assertInstanceLease({lease,now:new Date(now)});}finally{repository.close();}
  if(!lease||!reservation||!finalization||marked.length!==1)throw Error('actual_signed_heartbeat_required');
  const databaseHeads=before.databaseHeads.map(head=>head.databaseInstanceId===reservation.databaseInstanceId?{...head,sequence:reservation.databaseSequence,hash:reservation.databaseHash,stateHash:reservation.postStateHash}:head);
  const journal={lease,entries:[...(prior?.entries||[]),{reserveRequest,reservationReceipt:reservation,finalizeRequest,finalizationReceipt:finalization}],globalHash:reservation.globalHash,databaseHeads};
  write(path.join(root,'journal-fixture.json'),journal);
  const inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:f.runtime,manifest:f.manifest});if(inventory.blockers.length)throw Error('heartbeat_inventory_invalid');
  return {lease,row,journal,inventory,calls,marked,now};
}
if(pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    const value=input.mode==='fixture'?fixture(input.root):input.mode==='heartbeat'?heartbeat(input.root,input):(()=>{throw Error('unknown_fixture_operation');})();
    process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:true,value}));
  }catch(error){process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:false,error:error.message}));}
}
