// Synthetic stored evidence only. Private fixture keys stay in this process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
import {hashBytes,hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {AUTONOMOUS_RESEARCH_ONLINE_MUTATION_REQUIRED_SCHEMA_OBJECTS as MUTATION, AUTONOMOUS_RESEARCH_RESIDENT_AUTHORITY_JOURNAL_REQUIRED_SCHEMA_OBJECTS as RESIDENT, autonomousResearchStateDatabaseScopeHash as scopeHash,autonomousResearchStateDatabaseInventoryHash as inventoryHash,autonomousResearchStateDatabaseManifestHash as manifestHash,autonomousResearchStateBackupContentHash as contentHash,autonomousResearchStateBackupBundleManifestHash as bundleHash} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {inspectSqliteDatabase} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {resolveLatestAutonomousResearchStateBackupSources} from '../../paper-adapters/automation/autonomous-research-state-backup-repository.mjs';
import {createAutonomousResearchStateBackupAuthorityProcessClient,autonomousResearchStateBackupAuthoritySignaturePayload as backupPayload,autonomousResearchStateBackupAuthorityReceiptHash as backupHash} from '../../paper-adapters/automation/autonomous-research-state-backup-authority.mjs';
import {autonomousResearchOnlineMutationSignedPayload as onlinePayload,autonomousResearchOnlineMutationStateHash as stateHash,autonomousResearchOnlineMutationReceiptHash as onlineHash,autonomousResearchOnlineMutationLocalMarkerHash as markerHash} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
const H=label=>hashRecord('StateRestoreSourceRustTestOnly',{label});
function fixture(root,scenario='snapshot'){
 if(!root.startsWith('/tmp/hepta-sqlite-authority-rust-backup-'))throw new Error('isolated_fixture_required');
 const seed=JSON.parse(execFileSync(process.execPath,[path.join(import.meta.dirname,'state-backup-authority-v1.mjs')],{input:JSON.stringify([{operation:'fixture',root,version:2}]),maxBuffer:64*1024*1024})).results[0].value;
 const backupPair=crypto.generateKeyPairSync('ed25519'),onlinePair=crypto.generateKeyPairSync('ed25519');
 const sign=(value,key,payload)=>{const unsigned=Object.fromEntries(Object.entries(value).filter(([k])=>k!=='signature'));return{...unsigned,signature:crypto.sign(null,Buffer.from(payload(unsigned)),key).toString('base64')};};
 const backupSign=value=>sign(value,backupPair.privateKey,backupPayload),onlineSign=value=>sign(value,onlinePair.privateKey,onlinePayload);
 const write=(file,value)=>{fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});fs.chmodSync(file,0o600);};
 const now=seed.now;const backupRoot=path.join(root,'backups'),bundlePath=path.join(backupRoot,'selected');fs.mkdirSync(path.join(bundlePath,'databases'),{recursive:true,mode:0o700});
 const manifest=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,'../../paper-core/config/autonomous-research-state-databases.v1.json'),'utf8'));
 for(const definition of manifest.databases)definition.requiredSchemaObjects=[...MUTATION,...(definition.role==='resident-instance'?RESIDENT:[]),'table:records'].sort();
 const databases=[],instances=[];
 for(const [index,definition] of manifest.databases.entries()){
  const backupRelativePath=`databases/${index+1}-${definition.role}.sqlite`,file=path.join(bundlePath,backupRelativePath);
  const db=new DatabaseSync(file);db.exec('CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT); INSERT INTO records VALUES(\'subject\',\'before\');');
  for(const object of definition.requiredSchemaObjects){const [type,name]=object.split(':');if(name==='records')continue;if(type==='table')db.exec(`CREATE TABLE "${name}"(id TEXT PRIMARY KEY,value TEXT);`);else if(type==='index')db.exec(`CREATE INDEX "${name}" ON records(value);`);else if(type==='trigger')db.exec(`CREATE TRIGGER "${name}" BEFORE UPDATE ON records BEGIN SELECT 1; END;`);}
  if(scenario==='missing-required-signed'&&index===0)db.exec('DROP TRIGGER autonomous_research_online_mutation_marker_no_update;');
  db.close();fs.chmodSync(file,0o600);
  const observed=inspectSqliteDatabase(file,{immutable:true});
  const entry={instanceId:`${definition.role}:singleton`,role:definition.role,paperId:null,sourceRelativePath:definition.relativePath,backupRelativePath,backupSha256:hashBytes(fs.readFileSync(file)),bytes:fs.statSync(file).size,schemaContractId:definition.schemaContractId,schemaHash:observed.schemaHash,userVersion:observed.userVersion,applicationId:observed.applicationId,quickCheck:observed.quickCheck,foreignKeyViolationCount:observed.foreignKeyViolationCount};
  if(scenario==='sqlite-garbage-signed'&&index===0){write(file,'not a sqlite database');entry.backupSha256=hashBytes(fs.readFileSync(file));entry.bytes=fs.statSync(file).size;}
  databases.push(entry);instances.push({instanceId:entry.instanceId,role:entry.role,paperId:null,sourceRelativePath:entry.sourceRelativePath,schemaContractId:entry.schemaContractId,schemaHash:entry.schemaHash,userVersion:entry.userVersion,applicationId:entry.applicationId,quickCheck:'ok',foreignKeyViolationCount:0,missingSchemaObjects:[]});
 }
 if(scenario==='declared-size-signed')databases[0].bytes=1024*1024*1024+1;
 instances.sort((a,b)=>a.instanceId.localeCompare(b.instanceId));
 const scope=scopeHash(instances);const inventory={version:1,kind:'AutonomousResearchStateDatabaseInventory',status:'autonomous_research_state_database_inventory_ready',manifestId:manifest.manifestId,manifestHash:manifestHash(manifest),databaseScopeHash:scope,instances,blockers:[]};inventory.inventoryHash=inventoryHash(inventory);
 const onlineConfigPath=path.join(root,'authority.json'),onlinePublicPath=path.join(root,'public.json');const onlineConfig=JSON.parse(fs.readFileSync(onlineConfigPath,'utf8'));const onlinePublic=JSON.parse(fs.readFileSync(onlinePublicPath,'utf8'));onlinePublic.publicKeyPem=onlinePair.publicKey.export({type:'spki',format:'pem'});write(onlinePublicPath,onlinePublic);onlineConfig.databaseScopeHash=scope;onlineConfig.publicKeySha256=hashBytes(fs.readFileSync(onlinePublicPath));write(onlineConfigPath,onlineConfig);
 const backupPublic=JSON.parse(fs.readFileSync(seed.publicPath,'utf8'));backupPublic.publicKeyPem=backupPair.publicKey.export({type:'spki',format:'pem'});write(seed.publicPath,backupPublic);const config=JSON.parse(fs.readFileSync(seed.configurationPath,'utf8'));config.publicKeySha256=hashBytes(fs.readFileSync(seed.publicPath));config.onlineMutationAuthorityConfigurationSha256=hashBytes(fs.readFileSync(onlineConfigPath));write(seed.configurationPath,config);
 const reserveRequest={...seed.base.reserve.request,inventoryHash:inventory.inventoryHash,databaseScopeHash:scope,databaseInstanceIds:instances.map(v=>v.instanceId).sort()};
 const reservation=backupSign({...seed.base.reserve.receipt,requestHash:hashRecord(reserveRequest.kind,reserveRequest),inventoryHash:inventory.inventoryHash,databaseScopeHash:scope,databaseInstanceIds:reserveRequest.databaseInstanceIds});
 const content={version:1,kind:'AutonomousResearchStateBackupContent',manifestId:manifest.manifestId,manifestHash:inventory.manifestHash,inventoryHash:inventory.inventoryHash,databaseScopeHash:scope,authorityReservationHash:backupHash(reservation),authorityHead:{sequence:reservation.headSequence,hash:reservation.headHash},createdAt:now,databases};
 const snapshotContentHash=contentHash(content);const finalizeRequest={...seed.base.finalize.request,inventoryHash:inventory.inventoryHash,databaseScopeHash:scope,snapshotContentHash};
 const finalization=backupSign({...seed.base.finalize.receipt,requestHash:hashRecord(finalizeRequest.kind,finalizeRequest),inventoryHash:inventory.inventoryHash,databaseScopeHash:scope,snapshotContentHash});
 const bundle={version:1,kind:'AutonomousResearchStateBackupBundleManifest',status:'autonomous_research_state_backup_recorded',content,snapshotContentHash,authorityReserveRequest:reserveRequest,authorityReservation:reservation,authorityFinalizeRequest:finalizeRequest,authorityFinalization:finalization,productionStateMutated:false};bundle.bundleManifestHash=bundleHash(bundle);
 const journalMode=['journal','splice','ordered-heads','journal-bad-signature'].includes(scenario);
 const headRequest={...seed.base.head.request,databaseScopeHash:scope,snapshotContentHash};
 let journalRequest=null,journalReceipt=null;
 if(journalMode){
  const seedEntry=seed.base.journal.receipt.entries[0],native=databases.find(v=>v.role==='native-store');const scratch=path.join(root,'replay.sqlite');fs.copyFileSync(path.join(bundlePath,native.backupRelativePath),scratch);const db=new DatabaseSync(scratch);const session=db.createSession();db.exec("UPDATE records SET value='after' WHERE id='subject';");const changeset=Buffer.from(session.changeset());session.close();db.close();fs.unlinkSync(scratch);
  const request={...seedEntry.reserveRequest,databaseScopeHash:scope,databaseInstanceId:native.instanceId,schemaHash:native.schemaHash,changesetBase64:changeset.toString('base64'),changesetByteLength:changeset.length,changesetHash:hashBytes(changeset)};
  request.postStateHash=stateHash({databaseRole:request.databaseRole,databaseInstanceId:request.databaseInstanceId,writerId:request.writerId,operationId:request.operationId,schemaHash:request.schemaHash,previousStateHash:request.preStateHash,changesetHash:request.changesetHash,databaseSequence:1,authorizationReceiptHashes:[],sideEffectReservationHashes:[]});
  const {version,kind,requestedAt,requestedLeaseMs,...mirrored}=request;void version;void kind;void requestedAt;void requestedLeaseMs;
  const r=onlineSign({...seedEntry.reservationReceipt,...mirrored,requestHash:hashRecord(request.kind,request)});
  const fRequest={...seedEntry.finalizeRequest,databaseScopeHash:scope,databaseInstanceId:native.instanceId,schemaHash:native.schemaHash,postStateHash:request.postStateHash,changesetHash:request.changesetHash,reservationReceiptHash:onlineHash(r),localMarkerHash:markerHash({reservation:r,committedAt:now})};
  const fReceipt=onlineSign({...seedEntry.finalizationReceipt,...Object.fromEntries(Object.entries(fRequest).filter(([k])=>!['kind','committedAt'].includes(k))),requestHash:hashRecord(fRequest.kind,fRequest)});
  const heads=instances.map(v=>({databaseRole:v.role,databaseInstanceId:v.instanceId,sequence:v.role==='native-store'?1:0,hash:v.role==='native-store'?r.databaseHash:H(v.role),schemaHash:v.schemaHash,stateHash:v.role==='native-store'?r.postStateHash:H(`state:${v.role}`)}));
  journalRequest={...seed.base.journal.request,databaseScopeHash:scope,snapshotContentHash};
  journalReceipt=backupSign({...seed.base.journal.receipt,databaseScopeHash:scope,snapshotContentHash,requestHash:hashRecord(journalRequest.kind,journalRequest),databaseHeads:heads,entries:[{reserveRequest:request,reservationReceipt:r,finalizeRequest:fRequest,finalizationReceipt:fReceipt}]});
  if(scenario==='journal-bad-signature'){journalReceipt.entries[0].finalizationReceipt.signature='invalid';journalReceipt=backupSign(journalReceipt);}
  if(scenario==='splice'){journalRequest={...journalRequest,reservationId:'backup:other-reservation',snapshotContentHash:H('other-snapshot')};journalReceipt=backupSign({...journalReceipt,reservationId:journalRequest.reservationId,snapshotContentHash:journalRequest.snapshotContentHash,requestHash:hashRecord(journalRequest.kind,journalRequest)});}
 }
 const current=backupSign({...seed.base.head.receipt,databaseScopeHash:scope,requestHash:hashRecord(headRequest.kind,headRequest),headSequence:journalMode?1:0,headHash:journalMode?seed.base.head.receipt.headHash:reservation.headHash});
 const restoredHeads=journalReceipt?structuredClone(journalReceipt.databaseHeads):[];if(scenario==='ordered-heads')restoredHeads[0]=Object.fromEntries(Object.entries(restoredHeads[0]).reverse());
 const restore={version:1,kind:'AutonomousResearchStateRestoreDrillReceipt',status:'autonomous_research_state_restore_drill_passed',bundlePath,bundleManifestHash:bundle.bundleManifestHash,snapshotContentHash,authorityCurrentHeadRequest:headRequest,authorityCurrentHeadReceipt:current,authorityCurrentHeadReceiptHash:backupHash(current),authorityJournalRangeRequest:journalRequest,authorityJournalRangeReceipt:journalReceipt,authorityJournalRangeReceiptHash:journalReceipt?backupHash(journalReceipt):null,journalReplayMutationCount:journalReceipt?1:0,recoveredDatabaseHeads:restoredHeads,recoverabilityProtocol:journalReceipt?'external-linearizable-finalized-mutation-journal-v1':'snapshot-current-head-exact-v1',completeFinalizedMutationJournal:Boolean(journalReceipt),recoverabilityBindingHash:null,databaseCount:databases.length,productionStateMutated:false,performedAt:now,blockers:[]};
 restore.recoverabilityBindingHash=hashRecord('AutonomousResearchStateRestoreRecoverabilityBinding',{bundleManifestHash:restore.bundleManifestHash,snapshotContentHash,currentHeadReceiptHash:restore.authorityCurrentHeadReceiptHash,journalRangeReceiptHash:restore.authorityJournalRangeReceiptHash,journalReplayMutationCount:restore.journalReplayMutationCount,recoveredDatabaseHeads:restore.recoveredDatabaseHeads,recoverabilityProtocol:restore.recoverabilityProtocol,completeFinalizedMutationJournal:restore.completeFinalizedMutationJournal});
 restore.restoreDrillReceiptHash=hashRecord('AutonomousResearchStateRestoreDrillReceipt',restore);
 const bundleFile=path.join(bundlePath,'AUTONOMOUS_RESEARCH_STATE_BACKUP.json'),restoreFile=path.join(bundlePath,'RESTORE_DRILL_RECEIPT.json');write(bundleFile,bundle);write(restoreFile,restore);
 if(scenario==='float-bytes')write(bundleFile,fs.readFileSync(bundleFile,'utf8').replaceAll(/"bytes":([0-9]+)/g,'"bytes":$1.0'));
 if(scenario==='corrupt-file')fs.appendFileSync(path.join(bundlePath,databases[0].backupRelativePath),'corrupt');
 const authority=createAutonomousResearchStateBackupAuthorityProcessClient({configurationPath:seed.configurationPath});
 const node=resolveLatestAutonomousResearchStateBackupSources({runtimeRoot:root,backupRoot,stateDatabaseManifest:manifest,authorityTrust:authority.trust,onlineMutationVerifier:authority.onlineMutationVerifier});
 return{configurationPath:seed.configurationPath,configurationFileHash:hashBytes(fs.readFileSync(seed.configurationPath)),bundlePath,bundleFileHash:hashBytes(fs.readFileSync(bundleFile)),restoreReceiptFileHash:hashBytes(fs.readFileSync(restoreFile)),manifest,inventory,now,node,firstDatabasePath:path.join(bundlePath,databases[0].backupRelativePath)};
}
const request=JSON.parse(fs.readFileSync(0,'utf8'));
try{process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:true,value:fixture(request.root,request.scenario)}));}catch(error){process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:false,error:error.message,stack:error.stack}));}
