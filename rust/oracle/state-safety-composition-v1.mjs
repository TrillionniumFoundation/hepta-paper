// Real ten-file runtime, original source tree, signed subprocess observations,
// and the untouched incumbent passive composition. Test-only keys stay private.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
import {hashBytes,hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {inspectAutonomousResearchStateSafety} from '../../paper-composition/automation/autonomous-research-state-safety-inspection.mjs';
import {resolveAutonomousResearchStateDatabaseInventory} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {refreshAutonomousResearchOnlineMutationAuthorityEvidence} from '../../paper-adapters/automation/autonomous-research-online-mutation-active-refresh.mjs';
import {createAutonomousResearchOnlineAuthorityEvidenceCacheWriter} from '../../paper-adapters/automation/autonomous-research-online-authority-evidence-cache.mjs';
import {createAutonomousResearchOnlineAuthorityEvidenceCache} from '../../paper-domain/automation/autonomous-research-online-authority-evidence-cache-contract.mjs';
import {autonomousResearchOnlineMutationSignedPayload} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
const REPO=path.resolve(import.meta.dirname,'../..');
const key=crypto.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,92)]),type:'pkcs8',format:'der'});
const H=label=>hashRecord('StateBackupCliNativeFixture',{label});
const write=(file,value,mode=0o600)=>{fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode});fs.chmodSync(file,mode);};
function fixtureFile(root){
  if(!root.startsWith('/tmp/hepta-backup-cli-e2e-')||fs.realpathSync(root)!==root)throw Error('isolated_fixture_required');
  return path.join(root,'fixture.json');
}
function setup(root){
  fixtureFile(root);
  const child=spawnSync(process.execPath,[path.join(REPO,'rust/oracle/state-backup-cli-v1.mjs')],{input:JSON.stringify({mode:'fixture',root}),encoding:'utf8'});
  if(child.status!==0)throw Error(child.stderr);
  const out=JSON.parse(child.stdout);if(!out.ok)throw Error(out.error);
  const f=out.value;
  // Copy complete real scan/import surfaces. No generated writer stubs or
  // caller-supplied coverage receipt stands in for source inspection.
  for(const name of ['paper-adapters','paper-application','paper-composition','paper-core','paper-domain','paper-ports','workflow-kernel','store']){
    fs.rmSync(path.join(f.workspace,name),{recursive:true,force:true});
    fs.cpSync(path.join(REPO,name),path.join(f.workspace,name),{recursive:true,dereference:true});
  }
  write(path.join(f.workspace,'paper-core/config/autonomous-research-state-databases.v1.json'),f.manifest);
  fs.symlinkSync(path.join(REPO,'node_modules'),path.join(f.workspace,'node_modules'));
  const broker=path.join(root,'passive-authority.mjs');
  write(broker,`#!${process.execPath}\nimport {brokerMain} from ${JSON.stringify(import.meta.url)};\nawait brokerMain(${JSON.stringify(root)});\n`,0o700);
  const config=JSON.parse(fs.readFileSync(f.onlineProcess));config.commandPath=broker;config.commandSha256=hashBytes(fs.readFileSync(broker));write(f.onlineProcess,config);
  write(fixtureFile(root),f);return f;
}
export async function brokerMain(root){
  const f=JSON.parse(fs.readFileSync(fixtureFile(root)));
  const q=JSON.parse(fs.readFileSync(0,'utf8'));
  fs.appendFileSync(path.join(root,'passive-calls.jsonl'),`${JSON.stringify(q)}\n`,{mode:0o600});
  const inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:f.runtime,manifest:f.manifest});
  const value={version:1,authorityId:'authority:cli',keyId:'key:cli',requestHash:hashRecord(q.kind,q),protocol:q.protocol,scopeId:q.scopeId,databaseScopeHash:q.databaseScopeHash,writerManifestHash:q.writerManifestHash,globalSequence:0,globalHash:H('global:0'),expiresAt:new Date(Date.parse(q.requestedAt)+60000).toISOString()};
  const heads=inventory.instances.map(i=>({databaseRole:i.role,databaseInstanceId:i.instanceId,sequence:0,hash:H(`database:${i.instanceId}:0`),schemaHash:i.schemaHash,stateHash:H(`state:${i.instanceId}:0`)})).sort((a,b)=>a.databaseInstanceId.localeCompare(b.databaseInstanceId));
  if(q.kind==='AutonomousResearchOnlineMutationCurrentHeadRequest')Object.assign(value,{kind:'AutonomousResearchOnlineMutationCurrentHeadReceipt',status:'autonomous_research_online_mutation_current_head_observed',databaseHeads:heads,unresolvedReservationCount:0,observedAt:q.requestedAt});
  else if(q.kind==='AutonomousResearchOnlineMutationActiveChallengeRequest')Object.assign(value,{kind:'AutonomousResearchOnlineMutationActiveChallengeReceipt',status:'autonomous_research_online_mutation_active_challenge_verified',databaseHeads:heads,challengeNonce:q.challengeNonce,challengedAt:q.requestedAt});
  else if(q.kind==='AutonomousResearchOnlineMutationScopeRequest'){
    Object.assign(value,{kind:'AutonomousResearchOnlineMutationScopeReceipt',status:'autonomous_research_online_mutation_scope_observed',observedAt:q.requestedAt});
    for(const field of ['staticInspectionReceiptHash','astGateReceiptHash','codeProvenanceHash','operationCount','operationIds','requiredDatabaseRoles','coveredDatabaseRoles'])value[field]=q[field];
  }else throw Error('unexpected_fixture_authority_operation');
  value.signature=crypto.sign(null,Buffer.from(autonomousResearchOnlineMutationSignedPayload(value)),key).toString('base64');
  process.stdout.write(JSON.stringify(value));
}
function run(input){
  if(input.mode==='fixture')return setup(input.root);
  const f=JSON.parse(fs.readFileSync(fixtureFile(input.root)));
  if(input.mode==='inspect')return inspectAutonomousResearchStateSafety({workspaceRoot:f.workspace,runtimeRoot:f.runtime,now:new Date(input.now||f.now),environment:input.environment||{}});
  if(input.mode==='cache'){
    const inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:f.runtime,manifest:f.manifest});
    const active=refreshAutonomousResearchOnlineMutationAuthorityEvidence({workspaceRoot:f.workspace,runtimeRoot:f.runtime,inventory,authorityProcessConfigurationPath:f.onlineProcess,clock:{now:()=>new Date(f.now)}});
    const receipt=createAutonomousResearchOnlineAuthorityEvidenceCacheWriter({runtimeRoot:f.runtime}).recordActiveAuthorityEvidence({databaseScopeHash:inventory.databaseScopeHash,writerManifestHash:active.authorityEvidence.currentHead.receipt.writerManifestHash,activeRefreshReceipt:active,expiresAt:active.authorityEvidence.currentHead.receipt.expiresAt});
    return {receipt,active};
  }
  if(input.mode==='tamper-cache'){
    const file=path.join(f.runtime,'automation-cache/online-authority-evidence-v1/current.json');
    const cache=JSON.parse(fs.readFileSync(file));
    cache.activeRefreshReceipt.authorityEvidence[input.role].receipt.signature='invalid';
    // Recompute structural hashes to prove the cryptographic verifier, rather
    // than the JSON cache hash, detects this attack.
    write(file,createAutonomousResearchOnlineAuthorityEvidenceCache(cache),0o400);return true;
  }
  throw Error('unknown_fixture_operation');
}
if(pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  try{process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:true,value:run(JSON.parse(fs.readFileSync(0,'utf8')))}));}
  catch(error){process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:false,error:error.message}));}
}
