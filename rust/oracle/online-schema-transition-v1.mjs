// Synthetic private keys live only in this oracle process; only public documents
// and signed receipts are serialized. No deployed key or runtime is accessed.
import fs from 'node:fs';
import readline from 'node:readline';
import { fixture as databaseFixture,createAuthority,controlledClock,transitionInput,stateDatabaseManifest } from '../../paper-core/tests/support/autonomous-research-online-schema-transition-fixture.mjs';
import { planAutonomousResearchOnlineSchemaTransition,executeAutonomousResearchOnlineSchemaTransition,inspectAutonomousResearchOnlineSchemaTransitionReadiness } from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';

import path from 'node:path';
import crypto from 'node:crypto';
import * as contract from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import { AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES as ROLES, autonomousResearchStateDatabaseScopeHash as scopeHash } from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { createAutonomousResearchOnlineMutationReceiptVerifier } from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import { createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient } from '../../paper-adapters/automation/autonomous-research-online-schema-transition-authority.mjs';
import { autonomousResearchOnlineMutationSignedPayload as payload } from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import { hashBytes,hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const H = label => hashRecord('NativeSchemaTransitionSyntheticFixture',{label});
const pick=(v,names)=>Object.fromEntries(names.map(k=>[k,v[k]]));
const NOW='2026-09-16T12:00:00.000Z';
function fixture(root,version=1){
  if(!root.startsWith('/tmp/hepta-native-schema-'))throw new Error('isolated_fixture_required');
  const pair=crypto.generateKeyPairSync('ed25519');
  const sign=value=>{const body={...value};delete body.signature;return {...body,signature:crypto.sign(null,Buffer.from(payload(body)),pair.privateKey).toString('base64')}};
  const write=(name,value,mode=0o600)=>{const selected=path.join(root,name);fs.writeFileSync(selected,typeof value==='string'?value:JSON.stringify(value),{mode});fs.chmodSync(selected,mode);return selected;};
  const instances=[...ROLES].map(role=>({databaseRole:role,databaseInstanceId:`instance:${role}`,sourceRelativePath:`state/${role}.sqlite`,preSchemaContractId:'schema:before',schemaContractId:'schema:after',preSchemaHash:H(`pre:${role}`),expectedPostSchemaHash:H(`post:${role}`),sourceSha256:H(`source:${role}`),sourceFileIdentityHash:H(`identity:${role}`),journalPreimageHash:H(`journal:${role}`),expectedNormalizedSourceSha256:H(`normalized:${role}`),prePristineStateHash:H(`pristine:${role}`)})).sort((a,b)=>a.databaseInstanceId<b.databaseInstanceId?-1:1);
  const databaseScopeHash=scopeHash(instances.map(v=>({instanceId:v.databaseInstanceId,role:v.databaseRole,sourceRelativePath:v.sourceRelativePath})));
  const pub=write('public.json',{version:1,kind:'AutonomousResearchOnlineMutationAuthorityPublicKey',authorityId:'authority:test',keyId:'key:test',algorithm:'ed25519',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'})});
  const configuration={version:1,kind:'AutonomousResearchOnlineMutationAuthorityConfiguration',authorityId:'authority:test',keyId:'key:test',scopeId:'scope:test',databaseScopeHash,writerManifestHash:H('target-manifest'),publicKeyPath:pub,publicKeySha256:hashBytes(fs.readFileSync(pub)),maximumReservationLeaseMs:60000,maximumObservationAgeMs:60000};
  const configurationPath=write('authority.json',configuration);
  const reserve={version,kind:'AutonomousResearchOnlineSchemaTransitionReserveRequest',protocol:version===1?contract.AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL:contract.AUTONOMOUS_RESEARCH_PRISTINE_SCHEMA_REBIND_PROTOCOL,scopeId:configuration.scopeId,databaseScopeHash,writerManifestHash:configuration.writerManifestHash,stateDatabaseManifestHash:H('state-manifest'),transitionInventoryHash:H('pending'),schemaBundleHash:H('bundle'),authorityJournalSchemaContractId:'schema:journal',authorityJournalSchemaHash:H('journal'),markerSchemaHash:H('marker'),transitionId:H('pending'),instances,requestedAt:NOW,requestedLeaseMs:60000,requiredExecutionWindowMs:1000,...(version===2?{transitionMode:'pristine-finalized-writer-manifest-rebind',sourceWriterManifestHash:H('source-manifest'),prePristineRuntimeStateHash:H('pre-runtime')}: {})};
  reserve.transitionInventoryHash=hashRecord('AutonomousResearchOnlineSchemaTransitionInventory',pick(reserve,['stateDatabaseManifestHash','databaseScopeHash','instances']));
  const identity={...pick(reserve,['scopeId','databaseScopeHash','writerManifestHash','stateDatabaseManifestHash','schemaBundleHash']),instances:instances.map(v=>pick(v,['databaseRole','databaseInstanceId','sourceRelativePath','preSchemaContractId','schemaContractId','prePristineStateHash','expectedPostSchemaHash'])),...(version===2?pick(reserve,['transitionMode','sourceWriterManifestHash','prePristineRuntimeStateHash']):{})};
  reserve.transitionId=hashRecord('AutonomousResearchOnlineSchemaTransitionIdentity',identity);
  const previousDatabaseHeads=instances.map(i=>({databaseRole:i.databaseRole,databaseInstanceId:i.databaseInstanceId,sequence:0,hash:H(`previous:${i.databaseRole}`),schemaHash:i.preSchemaHash,stateHash:H(`previous-state:${i.databaseRole}`)}));
  const previousGlobalHash=H('previous-global');
  const databaseGenesis=version===2?contract.buildAutonomousResearchPristineSchemaRebindGenesis({request:reserve,previousGlobalHash,previousDatabaseHeads}):instances.map(i=>({...pick(i,['databaseRole','databaseInstanceId','schemaContractId']),schemaHash:i.expectedPostSchemaHash,globalSequence:0,globalHash:H('genesis-global'),databaseSequence:0,databaseHash:H(`database:${i.databaseRole}`),stateHash:H(`state:${i.databaseRole}`)}));
  const reservation=sign({version,kind:'AutonomousResearchOnlineSchemaTransitionReservationReceipt',status:'autonomous_research_online_schema_transition_reserved',authorityId:configuration.authorityId,keyId:configuration.keyId,requestHash:hashRecord(reserve.kind,reserve),reservationId:'reservation:test',...pick(reserve,['protocol','scopeId','databaseScopeHash','writerManifestHash','stateDatabaseManifestHash','transitionInventoryHash','schemaBundleHash','authorityJournalSchemaContractId','authorityJournalSchemaHash','markerSchemaHash','transitionId','instances']),databaseGenesis,issuedAt:NOW,expiresAt:'2026-09-16T12:01:00.000Z',allRegisteredMutationsFenced:true,quiescenceMode:version===2?'pristine-scope-held-through-target-configuration-restart':'scope-wide-no-new-reservations-until-finalize-or-expiry',...(version===2?{...pick(reserve,['transitionMode','sourceWriterManifestHash','prePristineRuntimeStateHash']),previousGlobalSequence:0,previousGlobalHash,previousDatabaseHeads,targetAuthorityConfigurationHash:H('target-configuration'),authorityRestartRequired:true}:{})});
  const reservationReceiptHash=contract.autonomousResearchOnlineSchemaTransitionReceiptHash(reservation);
  const installations=instances.map(i=>{const row={...pick(i,['databaseRole','databaseInstanceId','schemaContractId','preSchemaHash']),postSchemaHash:i.expectedPostSchemaHash,prePristineStateHash:i.prePristineStateHash,postPristineStateHash:H(`post-pristine:${i.databaseRole}`)};return{...row,installationHash:hashRecord('AutonomousResearchOnlineSchemaTransitionDatabaseInstallation',{transitionId:reserve.transitionId,reservationReceiptHash,...row})}});
  const finalize={version,kind:'AutonomousResearchOnlineSchemaTransitionFinalizeRequest',...pick(reserve,['protocol','scopeId','databaseScopeHash','writerManifestHash','transitionId','transitionInventoryHash','schemaBundleHash']),reservationId:reservation.reservationId,reservationReceiptHash,postInventoryHash:H('post-inventory'),postPristineRuntimeStateHash:H('post-pristine'),installations,completedAt:NOW};
  const finalization=sign({version,kind:'AutonomousResearchOnlineSchemaTransitionFinalizationReceipt',status:'autonomous_research_online_schema_transition_finalized',authorityId:configuration.authorityId,keyId:configuration.keyId,requestHash:hashRecord(finalize.kind,finalize),...pick(finalize,['protocol','scopeId','databaseScopeHash','writerManifestHash','transitionId','transitionInventoryHash','schemaBundleHash','reservationId','reservationReceiptHash','postInventoryHash','postPristineRuntimeStateHash','installations']),globalSequence:0,globalHash:H('final-global'),finalizedAt:NOW,allRegisteredMutationsFencedThroughFinalize:true,...(version===2?pick(reservation,['transitionMode','sourceWriterManifestHash','targetAuthorityConfigurationHash','authorityRestartRequired']):{})});
  const observe={version,kind:'AutonomousResearchOnlineSchemaTransitionObserveRequest',...pick(finalize,['protocol','scopeId','databaseScopeHash','writerManifestHash','transitionId','transitionInventoryHash','schemaBundleHash']),finalizationReceiptHash:contract.autonomousResearchOnlineSchemaTransitionReceiptHash(finalization),postInventoryHash:finalize.postInventoryHash,postPristineRuntimeStateHash:finalize.postPristineRuntimeStateHash,nonce:'schema-transition:test',requestedAt:NOW,...(version===2?pick(reserve,['transitionMode','sourceWriterManifestHash']):{})};
  const observation=sign({version,kind:'AutonomousResearchOnlineSchemaTransitionObservationReceipt',status:'autonomous_research_online_schema_transition_observed_finalized',authorityId:configuration.authorityId,keyId:configuration.keyId,requestHash:hashRecord(observe.kind,observe),...pick(observe,['protocol','scopeId','databaseScopeHash','writerManifestHash','transitionId','transitionInventoryHash','schemaBundleHash','finalizationReceiptHash','postInventoryHash','postPristineRuntimeStateHash']),transitionState:'finalized',globalSequence:0,globalHash:H('final-global'),observedAt:NOW,expiresAt:'2026-09-16T12:01:00.000Z',...(version===2?{...pick(reserve,['transitionMode','sourceWriterManifestHash']),authorityConfigurationActivated:true}:{})});
  const base={reserve:{request:reserve,receipt:reservation},finalize:{request:finalize,receipt:finalization,reservation,reserveRequest:reserve},observe:{request:observe,receipt:observation}};
  const verifier=createAutonomousResearchOnlineMutationReceiptVerifier({configurationPath});
  const names={reserve:'verifyAutonomousResearchOnlineSchemaTransitionReservation',finalize:'verifyAutonomousResearchOnlineSchemaTransitionFinalization',observe:'verifyAutonomousResearchOnlineSchemaTransitionObservation'};
  const verify=c=>{try{return{ok:true,accepted:contract[names[c.operation]]({...c,trust:verifier.trust,now:new Date(c.now),verifySignature:verifier.verifySignedReceipt})};}catch(error){return{ok:false,error:error.message}}};
  const cases=[];
  const add=(operation,label,change=()=>{},resign=true)=>{const c={operation,label,now:NOW,...structuredClone(base[operation])};change(c);if(resign)c.receipt=sign(c.receipt);cases.push({...c,expected:verify(c)});};
  for(const operation of Object.keys(base)){
    add(operation,`${operation}-valid`);
    add(operation,`${operation}-signature`,c=>c.receipt.signature='bad',false);
    add(operation,`${operation}-authority`,c=>c.receipt.authorityId='authority:wrong');
    add(operation,`${operation}-scope`,c=>c.receipt.databaseScopeHash=H('wrong'));
    add(operation,`${operation}-extra`,c=>c.receipt.extra=true);
    add(operation,`${operation}-request-extra`,c=>c.request.extra=true);
    add(operation,`${operation}-request-hash`,c=>c.receipt.requestHash=H('wrong'));
    add(operation,`${operation}-future`,c=>c.receipt[operation==='reserve'?'issuedAt':operation==='finalize'?'finalizedAt':'observedAt']='2026-09-16T12:00:05.001Z');
  }
  add('reserve','request-path-trailing-slash',c=>c.request.instances[0].sourceRelativePath+='/',false);
  add('reserve','request-lease-fractional',c=>c.request.requestedLeaseMs=1000.5,false);
  add('reserve','request-duplicate-role',c=>c.request.instances[0].databaseRole=c.request.instances[1].databaseRole,false);
  add('reserve','request-instance-order',c=>c.request.instances.reverse(),false);
  add('reserve','expired',c=>c.receipt.expiresAt=NOW);
  add('reserve','lease-too-long',c=>c.receipt.expiresAt='2026-09-16T12:01:00.001Z');
  add('reserve','genesis-schema',c=>c.receipt.databaseGenesis[0].schemaHash=H('wrong'));
  add('reserve','missing-instance',c=>c.receipt.instances.pop());
  add('reserve','scope-not-fenced',c=>c.receipt.allRegisteredMutationsFenced=false);
  add('finalize','installation-hash',c=>c.receipt.installations[0].installationHash=H('wrong'));
  add('finalize','after-reservation-expiry',c=>c.receipt.finalizedAt='2026-09-16T12:01:00.001Z');
  add('finalize','fence-not-held',c=>c.receipt.allRegisteredMutationsFencedThroughFinalize=false);
  add('observe','nonce-replay',c=>c.request.nonce='nonce:other');
  add('observe','expired',c=>c.receipt.expiresAt=NOW);
  add('observe','stale',c=>c.receipt.observedAt='2026-09-16T11:58:00.000Z');
  add('observe','not-finalized',c=>c.receipt.transitionState='pending');
  if(version===2){add('reserve','restart-required',c=>c.receipt.authorityRestartRequired=false);add('reserve','previous-sequence',c=>c.receipt.previousGlobalSequence=1);add('observe','not-activated',c=>c.receipt.authorityConfigurationActivated=false);}
  const replies=Object.fromEntries(Object.values(base).map(v=>[v.request.kind,v.receipt]));
  const commandPath=write('broker.py','#!/usr/bin/python3\nimport json,sys\nreplies=json.loads('+JSON.stringify(JSON.stringify(replies))+')\nrequest=json.load(sys.stdin)\nreply=replies.get(request.get("kind"))\nif reply is not None:\n for key in ["instances","installations"]:\n  if key in request: reply[key]=request[key]\nprint(json.dumps(reply))\n',0o700);
  const processConfigurationPath=write('process.json',{version:1,kind:'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',authorityConfigurationPath:configurationPath,authorityConfigurationSha256:hashBytes(fs.readFileSync(configurationPath)),commandPath,commandSha256:hashBytes(fs.readFileSync(commandPath)),fixedArguments:[],timeoutMs:1000});
  return {configurationPath,configurationFileHash:hashBytes(fs.readFileSync(configurationPath)),processConfigurationPath,processConfigurationFileHash:hashBytes(fs.readFileSync(processConfigurationPath)),base,cases,now:NOW};
}

function runtimeFixture(root){
  if(!root.startsWith('/tmp/hepta-native-schema-'))throw new Error('isolated_fixture_required');
  const generated=databaseFixture({after(){}});
  const runtimeRoot=path.join(root,'runtime');
  fs.renameSync(generated.runtimeRoot,runtimeRoot);fs.rmdirSync(generated.parent);
  const setup={runtimeRoot};
  const raw=createAuthority(runtimeRoot);const clock=controlledClock();
  const pair=crypto.generateKeyPairSync('ed25519');
  const sign=value=>{const body={...value};delete body.signature;return {...body,signature:crypto.sign(null,Buffer.from(payload(body)),pair.privateKey).toString('base64')}};
  const write=(name,value)=>{const target=path.join(root,name);fs.writeFileSync(target,JSON.stringify(value),{mode:0o600});return target;};
  const publicKeyPath=write('public.json',{version:1,kind:'AutonomousResearchOnlineMutationAuthorityPublicKey',authorityId:raw.client.trust.authorityId,keyId:raw.client.trust.keyId,algorithm:'ed25519',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'})});
  const configurationPath=write('authority.json',{...raw.client.trust,kind:'AutonomousResearchOnlineMutationAuthorityConfiguration',publicKeyPath,publicKeySha256:hashBytes(fs.readFileSync(publicKeyPath))});
  const verifier=createAutonomousResearchOnlineMutationReceiptVerifier({configurationPath});
  const verify=(name,options)=>contract[name]({...options,trust:verifier.trust,verifySignature:verifier.verifySignedReceipt});
  const client={trust:verifier.trust,
    reserveSchemaTransition:options=>sign(raw.client.reserveSchemaTransition(options)),
    finalizeSchemaTransition:options=>sign(raw.client.finalizeSchemaTransition(options)),
    observeSchemaTransition:options=>sign(raw.client.observeSchemaTransition(options)),
    verifyStoredReservation:options=>verify('verifyAutonomousResearchOnlineSchemaTransitionReservation',options),
    verifyHistoricalReservation:options=>verify('verifyAutonomousResearchOnlineSchemaTransitionReservation',{...options,now:new Date(options.receipt.issuedAt)}),
    verifyHistoricalFinalization:options=>verify('verifyAutonomousResearchOnlineSchemaTransitionFinalization',{...options,now:new Date(options.receipt.finalizedAt)}),
    verifyHistoricalObservation:options=>verify('verifyAutonomousResearchOnlineSchemaTransitionObservation',{...options,now:new Date(options.receipt.observedAt)}),
  };
  const input=transitionInput(setup,clock,{client});
  const planned=planAutonomousResearchOnlineSchemaTransition(input);
  const execution=executeAutonomousResearchOnlineSchemaTransition({...input,expectedTransitionId:planned.plan.transitionId});
  if(execution.status!=='autonomous_research_online_schema_transition_ready')throw new Error(`unexpected_fixture_execution:${execution.status}`);
  return {value:{runtimeRoot,stateDatabaseManifest,writerManifest:input.writerManifest,configurationPath,configurationFileHash:hashBytes(fs.readFileSync(configurationPath)),now:clock.now().toISOString()},input,client,clock,sign};
}
async function serve(){
  const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});let runtime;
  for await(const line of input){
    try{
      const message=JSON.parse(line);let value;
      if(message.operation==='runtime-fixture'){runtime=runtimeFixture(message.root);value=runtime.value;}
      else if(message.operation==='invoke'){
        const request=message.request;
        value=runtime.client.observeSchemaTransition({request,now:new Date(message.now||runtime.value.now)});
        if(message.badSignature)value.signature='invalid';
      }else if(message.operation==='readiness'){
        const original=crypto.randomUUID;
        crypto.randomUUID=()=>message.nonce.replace('schema-transition:','');
        try{value=inspectAutonomousResearchOnlineSchemaTransitionReadiness(runtime.input);}finally{crypto.randomUUID=original;}
      }else if(message.operation==='resign-audit'){
        const file=path.join(runtime.value.runtimeRoot,'autonomous-research/online-schema-transition/FINAL.json');
        const audit=JSON.parse(fs.readFileSync(file,'utf8'));
        if(message.variant==='numeric-spelling'){
          const original=fs.readFileSync(file,'utf8');
          const revised=original.replace(/("(?:version|globalSequence|databaseSequence|previousGlobalSequence|sequence|requestedLeaseMs|requiredExecutionWindowMs)"\s*:\s*)(-?[0-9]+)(?=[,}])/g,'$1$2.0');
          if(revised===original)throw new Error('numeric_fixture_not_changed');
          fs.writeFileSync(file,revised);value=true;
        }else if(message.variant==='splice-observation'){
          audit.observeRequest={...audit.observeRequest,finalizationReceiptHash:H('unrelated-finalization')};
          audit.observation=runtime.client.observeSchemaTransition({request:audit.observeRequest,now:new Date(runtime.value.now)});
        }else if(message.variant==='reorder-instances'){
          const row=audit.reservation.instances[0];audit.reservation.instances[0]=Object.fromEntries(Object.entries(row).reverse());
        }else if(message.variant==='signature')audit.reservation.signature='invalid';
        else throw new Error('unknown_tamper');
        if(message.variant!=='numeric-spelling'){
          delete audit.schemaTransitionReceiptHash;
          audit.schemaTransitionReceiptHash=hashRecord('AutonomousResearchOnlineSchemaTransitionAuditReceipt',audit);
          fs.writeFileSync(file,JSON.stringify(audit));value=true;
        }
      }else throw new Error('unknown_server_operation');
      process.stdout.write(JSON.stringify({ok:true,value})+'\n');
    }catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message})+'\n');}
  }
}
if(process.argv.includes('--serve')){await serve();}else{
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const results=input.map(request=>{try{
  if(request.operation==='fixture')return {ok:true,value:fixture(request.root,request.version)};
  if(request.operation==='process'){
    const client=createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient({processConfigurationPath:request.path});
    const names={reserve:'reserveSchemaTransition',finalize:'finalizeSchemaTransition',observe:'observeSchemaTransition'};
    return{ok:true,value:client[names[request.case.operation]]({...request.case,now:new Date(request.case.now)})};
  }
  throw new Error('unknown_operation');
}catch(error){return {ok:false,error:error.message};}});
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),results}));

}
