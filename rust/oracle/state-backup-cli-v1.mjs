// Original CLI executed against an isolated ten-SQLite runtime. The fixture
// authority is a real subprocess signing requests with test-only Ed25519 keys.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
import {hashRecord, hashBytes} from '../../workflow-kernel/record-hash.mjs';
import {AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST as WRITER} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {autonomousResearchOnlineWriterOperationManifestHash} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS as RESIDENT_SCHEMA, AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS as MUTATION_SCHEMA} from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {AUTONOMOUS_RESEARCH_ONLINE_MUTATION_REQUIRED_SCHEMA_OBJECTS as MUTATION, AUTONOMOUS_RESEARCH_RESIDENT_AUTHORITY_JOURNAL_REQUIRED_SCHEMA_OBJECTS as RESIDENT} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {createAutonomousResearchSupervisorInstanceRepository} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {resolveAutonomousResearchStateDatabaseInventory} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {autonomousResearchStateBackupAuthoritySignaturePayload as backupPayload} from '../../paper-adapters/automation/autonomous-research-state-backup-authority.mjs';
import * as online from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {autonomousResearchOnlineUnresolvedReservationSetHash} from '../../paper-domain/automation/autonomous-research-online-unresolved-reservation-contract.mjs';
const NOW='2026-09-16T12:00:00.000Z';
const REPO=path.resolve(import.meta.dirname,'../..');
const H=label=>hashRecord('StateBackupCliNativeFixture',{label});
const privateKey=seed=>crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,seed)]),type:'pkcs8',format:'der'});
const backupKey=privateKey(91),onlineKey=privateKey(92);
const write=(file,value,mode=0o600)=>{fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode});fs.chmodSync(file,mode);};
function checkRoot(root) {
  if(!root.startsWith('/tmp/hepta-backup-cli-e2e-')||fs.realpathSync(root)!==root||!fs.lstatSync(root).isDirectory())throw Error('isolated_fixture_required');
}
function fixture(root) {
  checkRoot(root);
  const runtime=path.join(root,'runtime'),workspace=path.join(root,'workspace');
  fs.mkdirSync(runtime,{mode:0o700});fs.mkdirSync(workspace,{mode:0o700});
  const manifest=JSON.parse(fs.readFileSync(path.join(REPO,'paper-core/config/autonomous-research-state-databases.v1.json')));
  const writerHash=autonomousResearchOnlineWriterOperationManifestHash(WRITER);
  const resident=createAutonomousResearchSupervisorInstanceRepository({runtimeRoot:runtime});
  resident.acquireInstanceLease({ownerId:'resident:fixture',now:new Date(NOW),leaseMs:120000,heartbeatMs:1000});resident.close();
  for(const definition of manifest.databases) {
    definition.requiredSchemaObjects=[...MUTATION,'table:records',...(definition.role==='resident-instance'?[...RESIDENT,'table:autonomous_research_supervisor_instance']:[])].sort();
    const file=path.join(runtime,definition.relativePath);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    const db=new DatabaseSync(file);db.exec("CREATE TABLE records(id TEXT PRIMARY KEY,value TEXT);INSERT INTO records VALUES('subject','before');");
    for(const sql of MUTATION_SCHEMA)db.exec(sql);
    if(definition.role==='resident-instance')for(const sql of RESIDENT_SCHEMA)db.exec(sql);
    db.close();fs.chmodSync(file,0o600);
  }
  const inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:runtime,manifest});
  if(inventory.blockers.length)throw Error(JSON.stringify(inventory.blockers));
  for(const instance of inventory.instances) {
    const db=new DatabaseSync(path.join(runtime,instance.sourceRelativePath));
    db.prepare('INSERT INTO autonomous_research_online_mutation_authority_metadata(singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at) VALUES(1,1,?,?,?,?,?,?,?,0,?,0,?,?,?)').run('external-linearizable-reserve-apply-finalize-v1',instance.role,instance.instanceId,instance.schemaContractId,instance.schemaHash,inventory.databaseScopeHash,writerHash,H('global:0'),H(`database:${instance.instanceId}:0`),H(`state:${instance.instanceId}:0`),NOW);db.close();
  }
  const publicKey=(file,key,kind,authorityId,keyId)=>write(file,{version:1,kind,authorityId,keyId,algorithm:'ed25519',publicKeyPem:crypto.createPublicKey(key).export({type:'spki',format:'pem'})});
  const onlinePublic=path.join(root,'online-public.json'),backupPublic=path.join(root,'backup-public.json');
  publicKey(onlinePublic,onlineKey,'AutonomousResearchOnlineMutationAuthorityPublicKey','authority:cli','key:cli');
  publicKey(backupPublic,backupKey,'AutonomousResearchStateBackupAuthorityPublicKey','backup:cli','backup:key');
  const onlineConfiguration=path.join(root,'online-configuration.json');
  write(onlineConfiguration,{version:1,kind:'AutonomousResearchOnlineMutationAuthorityConfiguration',authorityId:'authority:cli',keyId:'key:cli',scopeId:'scope:cli',databaseScopeHash:inventory.databaseScopeHash,writerManifestHash:writerHash,publicKeyPath:onlinePublic,publicKeySha256:hashBytes(fs.readFileSync(onlinePublic)),maximumReservationLeaseMs:60000,maximumObservationAgeMs:60000});
  const broker=path.join(root,'authority.mjs');
  write(broker,`#!${process.execPath}\nimport {brokerMain} from ${JSON.stringify(import.meta.url)};\nawait brokerMain(${JSON.stringify(root)});\n`,0o700);
  const backupConfiguration=path.join(root,'backup-configuration.json');
  write(backupConfiguration,{version:2,kind:'AutonomousResearchStateBackupAuthorityProcessConfiguration',authorityId:'backup:cli',keyId:'backup:key',commandPath:broker,commandSha256:hashBytes(fs.readFileSync(broker)),publicKeyPath:backupPublic,publicKeySha256:hashBytes(fs.readFileSync(backupPublic)),fixedArguments:[],timeoutMs:10000,maximumReservationLeaseMs:60000,maximumHeadObservationAgeMs:60000,onlineMutationAuthorityConfigurationPath:onlineConfiguration,onlineMutationAuthorityConfigurationSha256:hashBytes(fs.readFileSync(onlineConfiguration))});
  const onlineProcess=path.join(root,'online-process.json');
  write(onlineProcess,{version:1,kind:'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',authorityConfigurationPath:onlineConfiguration,authorityConfigurationSha256:hashBytes(fs.readFileSync(onlineConfiguration)),commandPath:broker,commandSha256:hashBytes(fs.readFileSync(broker)),fixedArguments:[],timeoutMs:10000});
  fs.mkdirSync(path.join(workspace,'paper-core/config'),{recursive:true,mode:0o700});
  fs.mkdirSync(path.join(workspace,'paper-core/bin'),{recursive:true,mode:0o700});
  write(path.join(workspace,'paper-core/config/autonomous-research-state-databases.v1.json'),manifest);
  // Exact unchanged incumbent entrypoint; only its workspace location differs.
  fs.copyFileSync(path.join(REPO,'paper-core/bin/autonomous-research-state-backup.mjs'),path.join(workspace,'paper-core/bin/autonomous-research-state-backup.mjs'));
  fs.symlinkSync(path.join(REPO,'paper-core/src'),path.join(workspace,'paper-core/src'));
  fs.symlinkSync(path.join(REPO,'paper-composition'),path.join(workspace,'paper-composition'));
  const preload=path.join(root,'clock.mjs');
  write(preload,`const NativeDate=Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[${JSON.stringify(NOW)}]));}static now(){return NativeDate.parse(${JSON.stringify(NOW)});}};\n`);
  const value={root,runtime,workspace,manifest,writerManifest:WRITER,now:NOW,backupConfiguration,onlineProcess,onlineConfiguration,broker,preload,backupRoot:path.join(runtime,'backups/autonomous-research-state')};
  write(path.join(root,'fixture.json'),value);return value;
}
export async function brokerMain(root) {
  checkRoot(root);
  const q=JSON.parse(fs.readFileSync(0,'utf8'));
  fs.appendFileSync(path.join(root,'calls.jsonl'),`${JSON.stringify(q)}\n`,{mode:0o600});
  const mode=fs.existsSync(path.join(root,'broker-mode'))?fs.readFileSync(path.join(root,'broker-mode'),'utf8'):'valid';
  if(mode==='exit')process.exit(3);
  const now=q.requestedAt,expires=new Date(Date.parse(now)+60000).toISOString();
  const common={version:1,authorityId:'backup:cli',keyId:'backup:key',requestHash:hashRecord(q.kind,q)};
  let value,key=backupKey,payload=backupPayload;
  if(q.kind==='AutonomousResearchStateBackupAuthorityReserveRequest')value={...common,kind:'AutonomousResearchStateBackupAuthorityReservation',status:'autonomous_research_state_backup_authority_reserved',reservationId:'backup:reservation',inventoryHash:q.inventoryHash,databaseScopeHash:q.databaseScopeHash,databaseInstanceIds:q.databaseInstanceIds,headSequence:0,headHash:H('global:0'),issuedAt:now,expiresAt:expires,mutationFenceProtocol:'external-linearizable-reserve-apply-finalize-v1',allRegisteredMutationsFenced:true};
  else if(q.kind==='AutonomousResearchStateBackupAuthorityFinalizeRequest')value={...common,kind:'AutonomousResearchStateBackupAuthorityFinalization',status:'autonomous_research_state_backup_authority_finalized',reservationId:q.reservationId,inventoryHash:q.inventoryHash,databaseScopeHash:q.databaseScopeHash,snapshotContentHash:q.snapshotContentHash,headSequence:0,headHash:H('global:0'),finalizedAt:now,allRegisteredMutationsFencedThroughFinalize:true};
  else if(q.kind==='AutonomousResearchStateBackupAuthorityCurrentHeadRequest')value={...common,kind:'AutonomousResearchStateBackupAuthorityCurrentHead',status:'autonomous_research_state_backup_authority_head_observed',reservationId:q.reservationId,databaseScopeHash:q.databaseScopeHash,headSequence:0,headHash:H('global:0'),observedAt:now,expiresAt:expires,mutationFenceProtocol:'external-linearizable-restore-validation-v1',allRegisteredMutationsFenced:true};
  else if(q.kind==='AutonomousResearchOnlineUnresolvedReservationListRequest') {
    key=onlineKey;payload=online.autonomousResearchOnlineMutationSignedPayload;
    value={...q,kind:'AutonomousResearchOnlineUnresolvedReservationListReceipt',status:'autonomous_research_online_unresolved_reservations_observed',authorityId:'authority:cli',keyId:'key:cli',requestHash:hashRecord(q.kind,q),unresolvedReservations:[],unresolvedReservationCount:0,unresolvedReservationSetHash:autonomousResearchOnlineUnresolvedReservationSetHash([]),observedAt:now,expiresAt:expires};
  } else throw Error('unexpected_fixture_authority_operation');
  if(mode==='wrong-scope')value.databaseScopeHash=H('wrong-scope');
  value.signature=crypto.sign(null,Buffer.from(payload(value)),key).toString('base64');
  if(mode==='bad-signature'||(mode==='fail-second-database'&&fs.readFileSync(path.join(root,'calls.jsonl'),'utf8').trim().split('\n').length>=3))value.signature='invalid';
  process.stdout.write(JSON.stringify(value));
}
function command(root,input) {
  checkRoot(root);const f=JSON.parse(fs.readFileSync(path.join(root,'fixture.json')));
  const child=spawnSync(process.execPath,['--import',f.preload,path.join(f.workspace,'paper-core/bin/autonomous-research-state-backup.mjs'),...input.argv],{cwd:input.cwd||root,env:{...process.env,HEPTA_PAPER_RUNTIME_ROOT:'',...input.environment},encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
  if(child.error)throw child.error;
  let report=null;try{report=JSON.parse(child.stdout);}catch{}
  return {exitCode:child.status,report,stdout:report===null?child.stdout:null,error:child.stderr.match(/(?:^|\n)Error: ([^\n]+)/)?.[1]||null};
}
if(pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  const input=JSON.parse(fs.readFileSync(0,'utf8'));
  try {const value=input.mode==='writer'?WRITER:input.mode==='fixture'?fixture(input.root):command(input.root,input);process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:true,value}));}
  catch(error){process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:false,error:error.message}));}
}
