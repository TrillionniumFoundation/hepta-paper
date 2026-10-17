// Actual source functions, including private pure projection helpers exposed by
// a test-only appended export. No function body or dependency is substituted.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { fileSha256HashSync } from '../../paper-adapters/runtime/pinned-file-reader.mjs';
const schemaURL = pathToFileURL(fs.realpathSync(new URL('../../paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs', import.meta.url))).href;
registerHooks({load(url,context,next){const result=next(url,context);if(url===schemaURL)return{...result,source:String(result.source)+'\nexport { expectedNormalizedSourceSha256, expectedPostSchemaHash, normalizeCopiedDatabaseJournal };\n'};return result;}});
const schema=await import(schemaURL);
const {withAutonomousResearchStateDatabasePrivateSnapshot,resolveAutonomousResearchStateDatabaseInventory}=await import('../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs');
const {AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS:migrations}=await import('../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs');
const NOW='2026-09-16T12:00:00.000Z';
function assertRoot(root){if(!root.startsWith('/tmp/hepta-schema-source-rust-'))throw new Error('isolated_fixture_required');}
function fixture({root,scenario}) {
  assertRoot(root); fs.mkdirSync(root,{recursive:true,mode:0o700});
  const active=path.join(root,'writer.sqlite');const target=path.join(root,'candidate.sqlite');
  const database=new DatabaseSync(active);
  try {
    database.exec('PRAGMA journal_mode=DELETE; CREATE TABLE business(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO business VALUES(1,\'before\');');
    if(scenario==='handoff'){
      database.exec(migrations[0].sql);
      database.prepare('INSERT INTO handoff_schema_migrations VALUES(?,?,?,?)').run(1,migrations[0].name,migrations[0].migrationHash,NOW);
      database.prepare('INSERT INTO handoff_cutover VALUES(?,?,?,?,?,?)').run(1,'autonomous-submission-handoff-cutover-v1',`sha256:${'1'.repeat(64)}`,'active',NOW,NOW);
    }
    if(scenario==='hidden')database.exec('CREATE TABLE sqliteXbusiness(secret TEXT); INSERT INTO sqliteXbusiness VALUES(\'not pristine\');');
    if(scenario==='target-conflict')database.exec('CREATE TABLE autonomous_research_online_mutation_authority_marker(fake TEXT);');
    if(scenario==='foreign-key')database.exec('PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(5);');
    if(['wal','wal-no-shm','stale-shm'].includes(scenario)){
      database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE business SET value=\'effective WAL\';');
      if(scenario==='stale-shm')database.prepare('PRAGMA wal_checkpoint(TRUNCATE);').get();
    }
    fs.copyFileSync(active,target,fs.constants.COPYFILE_EXCL);
    for(const suffix of ['-wal','-shm'])if(fs.existsSync(`${active}${suffix}`)&&!(scenario==='wal-no-shm'&&suffix==='-shm'))fs.copyFileSync(`${active}${suffix}`,`${target}${suffix}`,fs.constants.COPYFILE_EXCL);
  }finally{database.close();}
  fs.rmSync(active);
  for(const suffix of ['','-wal','-shm'])if(fs.existsSync(`${target}${suffix}`))fs.chmodSync(`${target}${suffix}`,0o600);
  const probe=new DatabaseSync(':memory:');try{return{relativePath:'candidate.sqlite',role:scenario==='handoff'?'submission-handoff':'native-store',sqliteVersion:probe.prepare('SELECT sqlite_version() AS version;').get().version};}finally{probe.close();}
}
function projection(input){
  assertRoot(input.root);
  const candidate=path.join(input.root,input.relativePath);const options={databaseRole:input.role};
  const identity=schema.schemaTransitionFileIdentity(candidate,options);
  const preSchemaHash=withAutonomousResearchStateDatabasePrivateSnapshot({sourcePath:candidate,inspect(copy){const db=new DatabaseSync(copy,{readOnly:true});try{return schema.schemaTransitionExactSchemaHash(db);}finally{db.close();}}});
  const normalized=schema.expectedNormalizedSourceSha256(candidate,input.role);
  return{databaseRole:input.role,sourceRelativePath:input.relativePath,sourceSha256:fileSha256HashSync(candidate),sourceFileIdentity:identity,sourceFileIdentityHash:hashRecord('AutonomousResearchOnlineSchemaTransitionSourceFileIdentity',schema.schemaTransitionStableFileIdentity(identity)),journalPreimageHash:schema.schemaTransitionJournalPreimageHash(candidate,options),expectedNormalizedSourceSha256:normalized,preSchemaHash,expectedPostSchemaHash:schema.expectedPostSchemaHash({candidate,instance:{role:input.role},appliedAt:NOW}),quickCheck:'ok',foreignKeyViolationCount:0};
}
function normalizeCopy(input){assertRoot(input.root);const candidate=path.join(input.root,input.relativePath);schema.normalizeCopiedDatabaseJournal(candidate);schema.assertSchemaTransitionNoSidecars(candidate);return{sha256:fileSha256HashSync(candidate)};}
const {fixture:businessFixture,createAuthority,stateDatabaseManifest}=await import('../../paper-core/tests/support/autonomous-research-online-schema-transition-fixture.mjs');
const {AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST:writerManifest}=await import('../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs');
const authorities=new Map();
function fullFixture(input){
 assertRoot(input.root);fs.mkdirSync(input.root,{recursive:true,mode:0o700});
 let expectedPreRebindPristineRuntimeStateHash=null;let generated;
 if(input.version===2){
  const parent=fs.mkdtempSync('/tmp/hepta-pristine-rust-schema-plan-');
  const process=spawnSync(globalThis.process.execPath,[new URL('./pristine-runtime-state-v1.mjs',import.meta.url).pathname],{input:JSON.stringify({operation:'fixture',root:parent})+'\n',encoding:'utf8',maxBuffer:16*1024*1024});
  if(process.status!==0)throw new Error('actual_pristine_fixture_failed');
  const response=JSON.parse(process.stdout);if(!response.ok)throw new Error(response.error);
  generated={parent,runtimeRoot:response.value.runtimeRoot};expectedPreRebindPristineRuntimeStateHash=response.value.pristineRuntimeStateHash;
 }else generated=businessFixture({after(){}});
 const runtimeRoot=path.join(input.root,'runtime');fs.renameSync(generated.runtimeRoot,runtimeRoot);fs.rmdirSync(generated.parent);
 const raw=createAuthority(runtimeRoot);const trust={...raw.client.trust};
 if(input.version===2){
  const candidate=path.join(runtimeRoot,stateDatabaseManifest.databases.find(v=>v.role==='native-store').relativePath);
  const db=new DatabaseSync(candidate,{readOnly:true});try{trust.writerManifestHash=db.prepare('SELECT writer_manifest_hash FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1').get().writer_manifest_hash;}finally{db.close();}
 }
 const keys=crypto.generateKeyPairSync('ed25519');
 const publicKeyPath=path.join(input.root,'public.json');fs.writeFileSync(publicKeyPath,JSON.stringify({version:1,kind:'AutonomousResearchOnlineMutationAuthorityPublicKey',authorityId:trust.authorityId,keyId:trust.keyId,algorithm:'ed25519',publicKeyPem:keys.publicKey.export({type:'spki',format:'pem'})}),{mode:0o600});
 const configurationPath=path.join(input.root,'authority.json');fs.writeFileSync(configurationPath,JSON.stringify({...trust,kind:'AutonomousResearchOnlineMutationAuthorityConfiguration',publicKeyPath,publicKeySha256:hashBytes(fs.readFileSync(publicKeyPath))}),{mode:0o600});
 authorities.set(input.root,{raw,keys,runtimeRoot,trust});
 return{runtimeRoot,stateDatabaseManifest,writerManifest,trust,configurationPath,configurationFileHash:hashBytes(fs.readFileSync(configurationPath)),expectedPreRebindPristineRuntimeStateHash};
}
function fullPlan(input){assertRoot(input.root);return schema.buildAutonomousResearchOnlineSchemaTransitionPlan({...input.setup,clock:{now:()=>new Date(NOW)},requestedLeaseMs:60000,requiredExecutionWindowMs:1000,expectedPreRebindPristineRuntimeStateHash:input.expectedPreRebindPristineRuntimeStateHash??input.setup.expectedPreRebindPristineRuntimeStateHash});}
const {autonomousResearchOnlineMutationSignedPayload}=await import('../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs');
const schemaContract=await import('../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs');
function reserveMaintenance(input){
 assertRoot(input.root);const authority=authorities.get(input.root);if(!authority)throw new Error('missing_temporary_authority');
 const value=structuredClone(authority.raw.client.reserveSchemaTransition({request:input.request,now:new Date(input.request.requestedAt)}));delete value.signature;
 if(input.request.version===2){
  value.version=2;value.quiescenceMode='pristine-scope-held-through-target-configuration-restart';
  for(const key of ['transitionMode','sourceWriterManifestHash','prePristineRuntimeStateHash'])value[key]=input.request[key];
  value.previousGlobalSequence=0;
  value.previousDatabaseHeads=input.request.instances.map(instance=>{const db=new DatabaseSync(path.join(authority.runtimeRoot,instance.sourceRelativePath),{readOnly:true});try{const row=db.prepare('SELECT * FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1').get();if(value.previousGlobalHash&&value.previousGlobalHash!==row.genesis_global_hash)throw new Error('fixture_global_head_mismatch');value.previousGlobalHash=row.genesis_global_hash;return{databaseRole:instance.databaseRole,databaseInstanceId:instance.databaseInstanceId,sequence:row.genesis_database_sequence,hash:row.genesis_database_hash,schemaHash:row.schema_hash,stateHash:row.genesis_state_hash};}finally{db.close();}});
  value.databaseGenesis=schemaContract.buildAutonomousResearchPristineSchemaRebindGenesis({request:input.request,previousGlobalHash:value.previousGlobalHash,previousDatabaseHeads:value.previousDatabaseHeads});
  value.targetAuthorityConfigurationHash=hashRecord('SyntheticTargetAuthorityConfiguration',{transitionId:input.request.transitionId});value.authorityRestartRequired=true;
 }

 if(input.mode==='unfenced')value.allRegisteredMutationsFenced=false;
 if(input.mode==='splice')value.instances[0].sourceSha256=`sha256:${'0'.repeat(64)}`;
 const signature=crypto.sign(null,Buffer.from(autonomousResearchOnlineMutationSignedPayload(value)),authority.keys.privateKey).toString('base64');
 if(input.mode==='source-drift'){const candidate=path.join(authority.runtimeRoot,input.request.instances[0].sourceRelativePath);const db=new DatabaseSync(candidate);try{db.exec('CREATE TABLE changed_during_reservation(id TEXT);');}finally{db.close();}}
 const receipt={...value,signature:input.mode==='bad-signature'?'bad':signature};
 authority.lastReceipt=receipt;
 const accepted=schemaContract.verifyAutonomousResearchOnlineSchemaTransitionReservation({receipt,request:input.request,trust:authority.trust,now:new Date(input.request.requestedAt),verifySignature:v=>crypto.verify(null,Buffer.from(autonomousResearchOnlineMutationSignedPayload(v)),authority.keys.publicKey,Buffer.from(v.signature,'base64'))});
 return{receipt,accepted};
}

const {executeAutonomousResearchOnlineSchemaTransitionJournalNormalization}=await import('../../paper-adapters/automation/autonomous-research-online-schema-transition-journal-normalization.mjs');
function makeWal(input) {
 assertRoot(input.root);const authority=authorities.get(input.root);const definition=stateDatabaseManifest.databases.find(v=>v.role==='native-store');const candidate=path.join(authority.runtimeRoot,definition.relativePath);
 const db=new DatabaseSync(candidate);let copied;try{db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE normalization_probe(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO normalization_probe VALUES(1,'before'); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE normalization_probe SET value='effective WAL';");copied=['','-wal','-shm'].map(suffix=>[suffix,fs.readFileSync(candidate+suffix)]);}finally{db.close();}
 for(const[suffix,bytes]of copied){fs.writeFileSync(candidate+suffix,bytes,{mode:0o600});fs.chmodSync(candidate+suffix,0o600);}
 return{relativePath:definition.relativePath};
}
function normalizeScope(input) {
 assertRoot(input.root);const authority=authorities.get(input.root);
 const authorityClient={verifyStoredReservation({receipt,request,now}){return schemaContract.verifyAutonomousResearchOnlineSchemaTransitionReservation({receipt,request,trust:authority.trust,now,verifySignature:v=>crypto.verify(null,Buffer.from(autonomousResearchOnlineMutationSignedPayload(v)),authority.keys.publicKey,Buffer.from(v.signature,'base64'))});}};
 // Preserve the original authority response's actual member order. Node's v2
 // validGenesis uses JSON.stringify on rows. A Rust Value roundtrip reorders
 // those members; compare every signed field and signature before using the
 // originally issued object, never synthesize or relax the verifier result.
 const reservation=authority.lastReceipt;
 if(!reservation||reservation.signature!==input.reservation.signature||autonomousResearchOnlineMutationSignedPayload(reservation)!==autonomousResearchOnlineMutationSignedPayload(input.reservation))throw new Error('original_signed_receipt_mismatch');
 return executeAutonomousResearchOnlineSchemaTransitionJournalNormalization({runtimeRoot:authority.runtimeRoot,currentInventory:resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:authority.runtimeRoot,manifest:stateDatabaseManifest}),plan:input.plan,reserveRequest:input.request,reservation,authorityClient,clock:{now:()=>new Date(NOW)}});
}

const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of rl){try{const input=JSON.parse(line);const value=input.operation==='make-wal'?makeWal(input):input.operation==='normalize-scope'?normalizeScope(input):input.operation==='fixture'?fixture(input):input.operation==='normalize-copy'?normalizeCopy(input):input.operation==='full-fixture'?fullFixture(input):input.operation==='full-plan'?fullPlan(input):input.operation==='reserve-maintenance'?reserveMaintenance(input):projection(input);process.stdout.write(JSON.stringify({ok:true,value,profile:productionOracleProfile()})+'\n');}catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message,profile:productionOracleProfile()})+'\n');}}
