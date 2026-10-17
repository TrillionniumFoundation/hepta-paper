// Synthetic keys and isolated ten-database runtime only. Never contact an
// external authority or accept a production runtime path.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
import {hashRecord,hashBytes} from '../../workflow-kernel/record-hash.mjs';
import {AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS as RESIDENT_SCHEMA,AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS as MUTATION_SCHEMA} from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {AUTONOMOUS_RESEARCH_ONLINE_MUTATION_REQUIRED_SCHEMA_OBJECTS as MUTATION,AUTONOMOUS_RESEARCH_RESIDENT_AUTHORITY_JOURNAL_REQUIRED_SCHEMA_OBJECTS as RESIDENT} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {createAutonomousResearchSupervisorInstanceRepository} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {resolveAutonomousResearchStateDatabaseInventory,inspectSqliteDatabase} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {createAutonomousResearchStateBackup,drillAutonomousResearchStateRestore,resolveLatestAutonomousResearchStateBackupSources,observeAutonomousResearchStateBackupCurrentHead} from '../../paper-adapters/automation/autonomous-research-state-backup-repository.mjs';
import {createAutonomousResearchStateBackupAuthorityProcessClient,autonomousResearchStateBackupAuthoritySignaturePayload as backupPayload} from '../../paper-adapters/automation/autonomous-research-state-backup-authority.mjs';
import {createAutonomousResearchStateRecoverabilityController} from '../../paper-application/automation/autonomous-research-state-recoverability-controller.mjs';
import * as online from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
const NOW='2026-09-16T12:00:00.000Z';
const H=label=>hashRecord('RecoverabilityNativeFixture',{label});
const privateKey=seed=>crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,seed)]),type:'pkcs8',format:'der'});
const backupKey=privateKey(77),onlineKey=privateKey(88);
const publicPem=key=>crypto.createPublicKey(key).export({type:'spki',format:'pem'});
const write=(file,value,mode=0o600)=>{fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode});fs.chmodSync(file,mode);};
function checkRoot(root){if(!root.startsWith('/tmp/hepta-recoverability-e2e-')||fs.realpathSync(root)!==root||!fs.lstatSync(root).isDirectory())throw Error('isolated_fixture_required');}
function fixture(root){
 checkRoot(root);
 const runtime=path.join(root,'runtime');fs.mkdirSync(runtime,{mode:0o700});
 const manifest=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,'../../paper-core/config/autonomous-research-state-databases.v1.json')));
 const writerFixture=JSON.parse(execFileSync(process.execPath,[path.join(import.meta.dirname,'sqlite-mutation-coordinator-v1.mjs')],{input:'[{"operation":"fixture"}]'})).results[0].value;
 const resident=createAutonomousResearchSupervisorInstanceRepository({runtimeRoot:runtime});const lease=resident.acquireInstanceLease({ownerId:'resident:owner',now:new Date(NOW),leaseMs:120000,heartbeatMs:1000});resident.close();
 for(const definition of manifest.databases){
  definition.requiredSchemaObjects=[...MUTATION,'table:records',...(definition.role==='resident-instance'?[...RESIDENT,'table:autonomous_research_supervisor_instance']:[])].sort();
  const file=path.join(runtime,definition.relativePath);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const db=new DatabaseSync(file);db.exec("CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT);INSERT INTO records VALUES('subject','before');CREATE TABLE resident_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL) STRICT;INSERT INTO resident_state VALUES(1,0);");
  for(const sql of MUTATION_SCHEMA)db.exec(sql);if(definition.role==='resident-instance')for(const sql of RESIDENT_SCHEMA)db.exec(sql);db.close();fs.chmodSync(file,0o600);
 }
 let inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:runtime,manifest});if(inventory.blockers.length)throw Error(JSON.stringify(inventory.blockers));
 for(const instance of inventory.instances){const db=new DatabaseSync(path.join(runtime,instance.sourceRelativePath));db.prepare('INSERT INTO autonomous_research_online_mutation_authority_metadata(singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at) VALUES(1,1,?,?,?,?,?,?,?,0,?,0,?,?,?)').run(writerFixture.trust.protocol||'external-linearizable-reserve-apply-finalize-v1',instance.role,instance.instanceId,instance.schemaContractId,instance.schemaHash,inventory.databaseScopeHash,writerFixture.trust.writerManifestHash,H('global:0'),H(`database:${instance.instanceId}:0`),H(`state:${instance.instanceId}:0`),NOW);db.close();}
 inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:runtime,manifest});
 const onlinePublic=path.join(root,'online-public.json');write(onlinePublic,{version:1,kind:'AutonomousResearchOnlineMutationAuthorityPublicKey',authorityId:'authority:test',keyId:'key:test',algorithm:'ed25519',publicKeyPem:publicPem(onlineKey)});
 const onlineConfiguration=path.join(root,'online-configuration.json');write(onlineConfiguration,{version:1,kind:'AutonomousResearchOnlineMutationAuthorityConfiguration',authorityId:'authority:test',keyId:'key:test',scopeId:'scope:test',databaseScopeHash:inventory.databaseScopeHash,writerManifestHash:writerFixture.trust.writerManifestHash,publicKeyPath:onlinePublic,publicKeySha256:hashBytes(fs.readFileSync(onlinePublic)),maximumReservationLeaseMs:60000,maximumObservationAgeMs:60000});
 const backupPublic=path.join(root,'backup-public.json');write(backupPublic,{version:1,kind:'AutonomousResearchStateBackupAuthorityPublicKey',authorityId:'backup:authority',keyId:'backup:key',algorithm:'ed25519',publicKeyPem:publicPem(backupKey)});
 const command=path.join(root,'unused-raw-transport.py');write(command,'#!/usr/bin/python3\nprint("{}")\n',0o700);
 const backupConfiguration=path.join(root,'backup-configuration.json');write(backupConfiguration,{version:2,kind:'AutonomousResearchStateBackupAuthorityProcessConfiguration',authorityId:'backup:authority',keyId:'backup:key',commandPath:command,commandSha256:hashBytes(fs.readFileSync(command)),publicKeyPath:backupPublic,publicKeySha256:hashBytes(fs.readFileSync(backupPublic)),fixedArguments:[],timeoutMs:1000,maximumReservationLeaseMs:60000,maximumHeadObservationAgeMs:60000,onlineMutationAuthorityConfigurationPath:onlineConfiguration,onlineMutationAuthorityConfigurationSha256:hashBytes(fs.readFileSync(onlineConfiguration))});
 const value={runtime,backupRoot:path.join(runtime,'backups/autonomous-research-state'),manifest,writerManifest:writerFixture.manifest,lease,now:NOW,inventory,backupConfiguration,backupConfigurationHash:hashBytes(fs.readFileSync(backupConfiguration)),onlineConfiguration,onlineConfigurationHash:hashBytes(fs.readFileSync(onlineConfiguration)),globalHash:H('global:0')};write(path.join(root,'fixture.json'),value);return value;
}
function prepareJournal(root,f,bundlePath,scenario='valid'){
 const bundle=JSON.parse(fs.readFileSync(path.join(bundlePath,'AUTONOMOUS_RESEARCH_STATE_BACKUP.json')));
 const entry=bundle.content.databases.find(v=>v.role==='native-store');
 const temporary=path.join(root,'changeset-source.sqlite');fs.copyFileSync(path.join(bundlePath,entry.backupRelativePath),temporary);
 const db=new DatabaseSync(temporary);
 if(scenario==='conflict')db.exec("UPDATE records SET value='different-before' WHERE id='subject'");
 if(scenario==='system-row')for(const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='autonomous_research_online_mutation_authority_metadata'").all())db.exec('DROP TRIGGER "'+row.name+'"');
 const session=db.createSession();
 if(scenario==='system-row')db.exec("UPDATE autonomous_research_online_mutation_authority_metadata SET genesis_state_hash='"+H('tampered-state')+"' WHERE singleton=1");
 else db.exec("UPDATE records SET value='after' WHERE id='subject'");
 const changeset=Buffer.from(session.changeset());session.close();db.close();fs.unlinkSync(temporary);
 const trust=JSON.parse(fs.readFileSync(f.onlineConfiguration));
 const state={databaseRole:entry.role,databaseInstanceId:entry.instanceId,writerId:'writer:fixture',operationId:'operation:fixture',schemaHash:entry.schemaHash,previousStateHash:H(`state:${entry.instanceId}:0`),changesetHash:hashBytes(changeset),databaseSequence:1,authorizationReceiptHashes:[],sideEffectReservationHashes:[]};
 const reserveRequest={version:1,kind:'AutonomousResearchOnlineMutationReserveRequest',protocol:'external-linearizable-reserve-apply-finalize-v1',scopeId:trust.scopeId,databaseScopeHash:trust.databaseScopeHash,writerManifestHash:trust.writerManifestHash,databaseRole:entry.role,databaseInstanceId:entry.instanceId,writerId:state.writerId,operationId:state.operationId,codeProvenanceHash:H('code'),mutationAttemptId:'attempt:replay',globalPreviousSequence:0,globalPreviousHash:f.globalHash,databasePreviousSequence:0,databasePreviousHash:H(`database:${entry.instanceId}:0`),schemaContractId:entry.schemaContractId,schemaHash:entry.schemaHash,preStateHash:state.previousStateHash,postStateHash:online.autonomousResearchOnlineMutationStateHash(state),changesetEncoding:'base64',changesetBase64:changeset.toString('base64'),changesetByteLength:changeset.length,changesetHash:state.changesetHash,authorizationReceiptHashes:[],sideEffectReservationHashes:[],requestedAt:NOW,requestedLeaseMs:60000};
 const sign=value=>({...value,signature:crypto.sign(null,Buffer.from(online.autonomousResearchOnlineMutationSignedPayload(value)),onlineKey).toString('base64')});
 const mirror=Object.fromEntries(Object.entries(reserveRequest).filter(([k])=>!['version','kind','requestedAt','requestedLeaseMs'].includes(k)));
 const reservationReceipt=sign({version:1,kind:'AutonomousResearchOnlineMutationReservationReceipt',status:'autonomous_research_online_mutation_reserved',authorityId:trust.authorityId,keyId:trust.keyId,requestHash:hashRecord(reserveRequest.kind,reserveRequest),reservationId:'reservation:replay',...mirror,globalSequence:1,globalHash:H('global:1'),databaseSequence:1,databaseHash:H(`database:${entry.instanceId}:1`),issuedAt:NOW,expiresAt:'2026-09-16T12:01:00.000Z'});
 const finalFields=['protocol','scopeId','databaseScopeHash','writerManifestHash','reservationId','databaseRole','databaseInstanceId','writerId','operationId','globalSequence','globalHash','databaseSequence','databaseHash','schemaHash','postStateHash','changesetHash','authorizationReceiptHashes','sideEffectReservationHashes'];
 const finalizeRequest={version:1,kind:'AutonomousResearchOnlineMutationFinalizeRequest',...Object.fromEntries(finalFields.map(k=>[k,reservationReceipt[k]])),reservationReceiptHash:online.autonomousResearchOnlineMutationReceiptHash(reservationReceipt),localMarkerHash:online.autonomousResearchOnlineMutationLocalMarkerHash({reservation:reservationReceipt,committedAt:NOW}),committedAt:NOW};
 const finalizationReceipt=sign({...Object.fromEntries(Object.entries(finalizeRequest).filter(([k])=>k!=='committedAt')),kind:'AutonomousResearchOnlineMutationFinalizationReceipt',status:'autonomous_research_online_mutation_finalized',authorityId:trust.authorityId,keyId:trust.keyId,requestHash:hashRecord(finalizeRequest.kind,finalizeRequest),sideEffectPermitHash:H('permit'),finalizedAt:NOW});
 if(scenario==='nested-signature')finalizationReceipt.signature='invalid';
 const databaseHeads=bundle.content.databases.map(v=>({databaseRole:v.role,databaseInstanceId:v.instanceId,sequence:v.instanceId===entry.instanceId?1:0,hash:v.instanceId===entry.instanceId?reservationReceipt.databaseHash:H(`database:${v.instanceId}:0`),schemaHash:v.schemaHash,stateHash:v.instanceId===entry.instanceId?reservationReceipt.postStateHash:H(`state:${v.instanceId}:0`)})).sort((a,b)=>a.databaseInstanceId.localeCompare(b.databaseInstanceId));
 const value={entries:[{reserveRequest,reservationReceipt,finalizeRequest,finalizationReceipt}],databaseHeads,globalHash:H('global:1')};write(path.join(root,'journal-fixture.json'),value);return value;
}
function backupClient(f,mode='valid'){
 const journalPath=path.join(path.dirname(f.backupConfiguration),'journal-fixture.json');const journal=fs.existsSync(journalPath)?JSON.parse(fs.readFileSync(journalPath)):null;
 const sign=v=>({...v,signature:crypto.sign(null,Buffer.from(backupPayload(v)),backupKey).toString('base64')});
 const invoke=q=>{if(mode==='timeout')throw Error('autonomous_research_state_backup_authority_timeout');const expires=new Date(Date.parse(q.requestedAt)+60000).toISOString();let value;
  const common={version:1,authorityId:'backup:authority',keyId:'backup:key',requestHash:hashRecord(q.kind,q)};
  if(q.kind==='AutonomousResearchStateBackupAuthorityReserveRequest')value={...common,kind:'AutonomousResearchStateBackupAuthorityReservation',status:'autonomous_research_state_backup_authority_reserved',reservationId:'backup:reservation',inventoryHash:q.inventoryHash,databaseScopeHash:q.databaseScopeHash,databaseInstanceIds:q.databaseInstanceIds,headSequence:0,headHash:f.globalHash,issuedAt:q.requestedAt,expiresAt:expires,mutationFenceProtocol:'external-linearizable-reserve-apply-finalize-v1',allRegisteredMutationsFenced:true};
  else if(q.kind==='AutonomousResearchStateBackupAuthorityFinalizeRequest')value={...common,kind:'AutonomousResearchStateBackupAuthorityFinalization',status:'autonomous_research_state_backup_authority_finalized',reservationId:q.reservationId,inventoryHash:q.inventoryHash,databaseScopeHash:q.databaseScopeHash,snapshotContentHash:q.snapshotContentHash,headSequence:0,headHash:f.globalHash,finalizedAt:q.requestedAt,allRegisteredMutationsFencedThroughFinalize:true};
  else if(q.kind==='AutonomousResearchStateBackupAuthorityCurrentHeadRequest')value={...common,kind:'AutonomousResearchStateBackupAuthorityCurrentHead',status:'autonomous_research_state_backup_authority_head_observed',reservationId:q.reservationId,databaseScopeHash:q.databaseScopeHash,headSequence:0,headHash:f.globalHash,observedAt:q.requestedAt,expiresAt:expires,mutationFenceProtocol:'external-linearizable-restore-validation-v1',allRegisteredMutationsFenced:true};
  else if(q.kind==='AutonomousResearchStateBackupAuthorityJournalRangeRequest'&&journal)value={...common,kind:'AutonomousResearchStateBackupAuthorityJournalRange',status:'autonomous_research_state_backup_authority_journal_range_complete',...Object.fromEntries(['reservationId','databaseScopeHash','snapshotContentHash','onlineAuthorityId','onlineKeyId','scopeId','writerManifestHash','fromGlobalSequence','fromGlobalHash','toGlobalSequence','toGlobalHash'].map(k=>[k,q[k]])),databaseHeads:journal.databaseHeads,entries:journal.entries,observedAt:q.requestedAt,expiresAt:expires,mutationFenceProtocol:'external-linearizable-finalized-mutation-journal-v1',completeFinalizedMutationJournal:true};
  else throw Error('unsupported_fixture_request');
  if(journal&&q.kind==='AutonomousResearchStateBackupAuthorityCurrentHeadRequest'){value.headSequence=1;value.headHash=journal.globalHash;}
  if(mode==='bad-scope')value.databaseScopeHash=H('other-scope');const signed=sign(value);if(mode==='bad-signature')signed.signature='invalid';return signed;
 };return{reserveSnapshot:invoke,finalizeSnapshot:invoke,observeCurrentHead:invoke,readFinalizedMutationJournal:invoke};
}
async function controller(f,common,events){
 const resident=createAutonomousResearchSupervisorInstanceRepository({runtimeRoot:f.runtime,create:false});
 const unavailable=()=>{throw Error('fixture_unexpected_renewal_or_reconciliation');};
 const service={offhostSources:()=>resolveLatestAutonomousResearchStateBackupSources({runtimeRoot:f.runtime,backupRoot:f.backupRoot,...common}),observeBundleHead:({bundlePath})=>observeAutonomousResearchStateBackupCurrentHead({bundlePath,backupRoot:f.backupRoot,...common}),restoreDrill:({bundlePath})=>drillAutonomousResearchStateRestore({bundlePath,backupRoot:f.backupRoot,...common}),reconcilePending:unavailable,reconcileAndRenew:unavailable};
 const controller=createAutonomousResearchStateRecoverabilityController({service,clock:common.clock,assertResidentLease:({now})=>{resident.assertInstanceLease({lease:f.lease,now});return true;}});
 try {const results=[];for(const event of events){try{let value;if(event.op==='status')value=controller.epochStatus();else if(event.op==='assert')value=controller.assertCurrent({action:event.action});else if(event.op==='mark')value=controller.markMutationFinalized(event.head);else if(event.op==='require')value=controller.markMutationReconciliationRequired(event.requirement);else value=await controller.reconcile({requiredValidityMs:event.required||0});results.push({ok:true,value});}catch(error){results.push({ok:false,error:error.message,fatal:error.stateRecoverabilityFatal===true,deferred:error.stateRecoverabilityDeferred===true,retryable:error.retryable===true,blockers:error.blockers||[]});}}return results;}finally{resident.close();}
}
async function run(input){const root=path.resolve(input.root);checkRoot(root);if(input.mode==='fixture')return fixture(root);const f=JSON.parse(fs.readFileSync(path.join(root,'fixture.json')));if(input.mode==='prepare-journal')return prepareJournal(root,f,input.bundlePath,input.scenario);const loaded=createAutonomousResearchStateBackupAuthorityProcessClient({configurationPath:f.backupConfiguration});const common={stateDatabaseManifest:f.manifest,authorityClient:backupClient(f,input.scenario),authorityTrust:loaded.trust,onlineMutationVerifier:loaded.onlineMutationVerifier,clock:{now:()=>new Date(input.now||f.now)}};
 if(input.mode==='controller')return controller(f,common,input.events);
 if(input.mode==='backup')return createAutonomousResearchStateBackup({runtimeRoot:f.runtime,backupRoot:f.backupRoot,...common});
 if(input.mode==='drill')return drillAutonomousResearchStateRestore({bundlePath:input.bundlePath,backupRoot:f.backupRoot,...common});
 if(input.mode==='sources')return resolveLatestAutonomousResearchStateBackupSources({runtimeRoot:f.runtime,backupRoot:f.backupRoot,...common});
 if(input.mode==='inspect')return inspectSqliteDatabase(input.databasePath,{immutable:true});throw Error('unknown_fixture_operation');
}
const input=JSON.parse(fs.readFileSync(0,'utf8'));
try{process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:true,value:await run(input)}));}catch(error){process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:false,error:error.message}));}
