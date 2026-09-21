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
  const broker=path.join(root,'authority.mjs');
  write(broker,`#!${process.execPath}\nimport {brokerMain} from ${JSON.stringify(import.meta.url)};\nawait brokerMain(${JSON.stringify(root)});\n`,0o700);
  const onlineProcess=path.join(root,'online-process.json'),backupProcess=path.join(root,'backup-process.json');
  write(onlineProcess,{version:1,kind:'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',authorityConfigurationPath:onlineConfiguration,authorityConfigurationSha256:hashBytes(fs.readFileSync(onlineConfiguration)),commandPath:broker,commandSha256:hashBytes(fs.readFileSync(broker)),fixedArguments:[],timeoutMs:10000});
  write(backupProcess,{version:2,kind:'AutonomousResearchStateBackupAuthorityProcessConfiguration',authorityId:'backup:initial-composition',keyId:'backup:key:initial-composition',commandPath:broker,commandSha256:hashBytes(fs.readFileSync(broker)),publicKeyPath:backupPublic,publicKeySha256:hashBytes(fs.readFileSync(backupPublic)),fixedArguments:[],timeoutMs:10000,maximumReservationLeaseMs:LEASE_MS,maximumHeadObservationAgeMs:LEASE_MS,onlineMutationAuthorityConfigurationPath:onlineConfiguration,onlineMutationAuthorityConfigurationSha256:hashBytes(fs.readFileSync(onlineConfiguration))});
  const value={root,runtime,workspace,backupRoot,manifest:stateDatabaseManifest,writerManifest:input.writerManifest,now:new Date().toISOString(),onlineConfiguration,onlineProcess,onlineProcessHash:hashBytes(fs.readFileSync(onlineProcess)),backupConfiguration:backupProcess,backupConfigurationHash:hashBytes(fs.readFileSync(backupProcess)),lease:{...lease,generation:lease.leaseGeneration},genesis,audit,inventory};
  write(path.join(root,'fixture.json'),value);return value;
}
export async function brokerMain(root){
  checkRoot(root);
  const f=JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8'));
  const q=JSON.parse(fs.readFileSync(0,'utf8'));
  fs.appendFileSync(path.join(root,'calls.jsonl'),`${JSON.stringify(q)}\n`,{mode:0o600});
  const trust=JSON.parse(fs.readFileSync(f.onlineConfiguration,'utf8'));
  const expiresAt=new Date(Date.parse(q.requestedAt)+LEASE_MS).toISOString();
  const globalSequence=f.audit.finalization.globalSequence,globalHash=f.audit.finalization.globalHash;
  const databaseHeads=f.genesis.map(i=>({databaseRole:i.databaseRole,databaseInstanceId:i.databaseInstanceId,sequence:i.databaseSequence,hash:i.databaseHash,schemaHash:i.schemaHash,stateHash:i.stateHash}));
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
  process.stdout.write(JSON.stringify(sign(receipt)));
}
if(pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    if(input.mode!=='fixture')throw Error('unknown_fixture_operation');
    process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:true,value:fixture(input.root)}));
  }catch(error){process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:false,error:error.message}));}
}
