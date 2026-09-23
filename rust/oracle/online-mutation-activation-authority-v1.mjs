// Temporary public documents and signed receipts only; synthetic private keys
// exist only in this oracle process and are never written or printed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAutonomousResearchOnlineMutationReceiptVerifier, createAutonomousResearchOnlineMutationAuthorityProcessClient } from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import { autonomousResearchOnlineMutationSignedPayload as payload, autonomousResearchOnlineMutationStateHash as stateHash } from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import { autonomousResearchOnlineUnresolvedReservationSetHash as setHash } from '../../paper-domain/automation/autonomous-research-online-unresolved-reservation-contract.mjs';
import { AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES as ROLES } from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const H = label => hashRecord('SqliteAuthorityRustTestOnly', {label});
function fixture(root,size=8){
  if(!root.startsWith('/tmp/hepta-online-activation-authority-'))throw new Error('isolated_fixture_required');
  const pair=crypto.generateKeyPairSync('ed25519');
  const sign=value=>{const {signature,...body}=value;return{...body,signature:crypto.sign(null,Buffer.from(payload(body)),pair.privateKey).toString('base64')}};
  const write=(name,value,mode=0o600)=>{const selected=path.join(root,name);fs.writeFileSync(selected,typeof value==='string'?value:JSON.stringify(value),{mode});fs.chmodSync(selected,mode);return selected;};
  const pub=write('public.json',{version:1,kind:'AutonomousResearchOnlineMutationAuthorityPublicKey',authorityId:'authority:test',keyId:'key:test',algorithm:'ed25519',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'})});
  const configuration={version:1,kind:'AutonomousResearchOnlineMutationAuthorityConfiguration',authorityId:'authority:test',keyId:'key:test',scopeId:'scope:test',databaseScopeHash:H('scope'),writerManifestHash:H('manifest'),publicKeyPath:pub,publicKeySha256:hashBytes(fs.readFileSync(pub)),maximumReservationLeaseMs:60000,maximumObservationAgeMs:60000};
  const configurationPath=write('authority.json',configuration);
  const now='2026-09-16T12:00:00.000Z',expires='2026-09-16T12:01:00.000Z';
  const scope={protocol:'external-linearizable-reserve-apply-finalize-v1',scopeId:configuration.scopeId,databaseScopeHash:configuration.databaseScopeHash,writerManifestHash:configuration.writerManifestHash};
  const headRequest={version:1,kind:'AutonomousResearchOnlineMutationCurrentHeadRequest',...scope,nonce:'nonce:test',requestedAt:now};
  const heads=ROLES.map(role=>({databaseRole:role,databaseInstanceId:`instance:${role}`,sequence:0,hash:H(role),schemaHash:H(`schema:${role}`),stateHash:H(`state:${role}`)})).sort((a,b)=>a.databaseInstanceId.localeCompare(b.databaseInstanceId));
  const expectedInstances=heads.map(({databaseRole,databaseInstanceId,schemaHash})=>({databaseRole,databaseInstanceId,schemaHash}));
  const head=sign({version:1,kind:'AutonomousResearchOnlineMutationCurrentHeadReceipt',status:'autonomous_research_online_mutation_current_head_observed',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(headRequest.kind,headRequest),...scope,globalSequence:0,globalHash:H('global'),databaseHeads:heads,unresolvedReservationCount:0,observedAt:now,expiresAt:expires});
  const changeset=Buffer.alloc(size,7);
  const state={databaseRole:'native-store',databaseInstanceId:'instance:native-store',writerId:'writer:test',operationId:'operation:test',schemaHash:H('schema:native-store'),previousStateHash:H('state:native-store'),changesetHash:hashBytes(changeset),databaseSequence:1,authorizationReceiptHashes:[],sideEffectReservationHashes:[]};
  const reserveRequest={version:1,kind:'AutonomousResearchOnlineMutationReserveRequest',...scope,databaseRole:state.databaseRole,databaseInstanceId:state.databaseInstanceId,writerId:state.writerId,operationId:state.operationId,codeProvenanceHash:H('code'),mutationAttemptId:'attempt:test',globalPreviousSequence:0,globalPreviousHash:H('global'),databasePreviousSequence:0,databasePreviousHash:H('native-store'),schemaContractId:'schema:test',schemaHash:state.schemaHash,preStateHash:state.previousStateHash,postStateHash:stateHash(state),changesetEncoding:'base64',changesetBase64:changeset.toString('base64'),changesetByteLength:changeset.length,changesetHash:state.changesetHash,authorizationReceiptHashes:[],sideEffectReservationHashes:[],requestedAt:now,requestedLeaseMs:60000};
  const {version,kind,requestedAt,requestedLeaseMs,...mirrored}=reserveRequest;
  const reservation=sign({version:1,kind:'AutonomousResearchOnlineMutationReservationReceipt',status:'autonomous_research_online_mutation_reserved',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(reserveRequest.kind,reserveRequest),reservationId:'reservation:test',...mirrored,globalSequence:1,globalHash:H('next-global'),databaseSequence:1,databaseHash:H('next-database'),issuedAt:now,expiresAt:expires});
  const challengeRequest={version:1,kind:'AutonomousResearchOnlineMutationActiveChallengeRequest',...scope,challengeNonce:'challenge:test',requestedAt:now};
  const challenge=sign({version:1,kind:'AutonomousResearchOnlineMutationActiveChallengeReceipt',status:'autonomous_research_online_mutation_active_challenge_verified',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(challengeRequest.kind,challengeRequest),...scope,globalSequence:0,globalHash:H('global'),databaseHeads:heads,challengeNonce:challengeRequest.challengeNonce,challengedAt:now,expiresAt:expires});
  const scopeRequest={version:1,kind:'AutonomousResearchOnlineMutationScopeRequest',...scope,staticInspectionReceiptHash:H('ast'),astGateReceiptHash:H('ast'),codeProvenanceHash:H('code'),operationCount:1,operationIds:['operation:test'],requiredDatabaseRoles:[...ROLES].sort(),coveredDatabaseRoles:[...ROLES].sort(),nonce:'scope:test',requestedAt:now};
  const {nonce:scopeNonce,requestedAt:scopeRequestedAt,...scopeBody}=scopeRequest;
  const scopeReceipt=sign({...scopeBody,kind:'AutonomousResearchOnlineMutationScopeReceipt',status:'autonomous_research_online_mutation_scope_observed',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(scopeRequest.kind,scopeRequest),globalSequence:0,globalHash:H('global'),observedAt:now,expiresAt:expires});
  const listRequest={version:1,kind:'AutonomousResearchOnlineUnresolvedReservationListRequest',...scope,databaseRole:'native-store',databaseInstanceId:'instance:native-store',nonce:'unresolved:test',requestedAt:now};
  const entries=[{reserveRequest,reservation}];
  const unresolved=sign({...listRequest,kind:'AutonomousResearchOnlineUnresolvedReservationListReceipt',status:'autonomous_research_online_unresolved_reservations_observed',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(listRequest.kind,listRequest),unresolvedReservationCount:entries.length,unresolvedReservationSetHash:setHash(entries),unresolvedReservations:entries,observedAt:now,expiresAt:expires});
  const base={head:{request:headRequest,receipt:head},challenge:{request:challengeRequest,receipt:challenge},scope:{request:scopeRequest,receipt:scopeReceipt},list:{request:listRequest,receipt:unresolved}};
  const cases=[];
  const add=(operation,label,change=()=>{},resign=true)=>{const selected=structuredClone(base[operation]);change(selected);if(resign)selected.receipt=sign(selected.receipt);cases.push({operation,label,...selected,now,expectedInstances});};
  for(const op of Object.keys(base)){
    add(op,`${op}-valid`);
    add(op,`${op}-signature`,v=>v.receipt.signature='invalid',false);
    add(op,`${op}-authority`,v=>v.receipt.authorityId='authority:wrong');
    add(op,`${op}-scope`,v=>v.receipt.databaseScopeHash=H('wrong'));
    add(op,`${op}-replay`,v=>v.request[op==='challenge'?'challengeNonce':'nonce']='nonce:wrong');
    add(op,`${op}-extra`,v=>v.receipt.extra=true);
    add(op,`${op}-expiry`,v=>v.receipt.expiresAt=now);
    add(op,`${op}-old`,v=>v.receipt[op==='challenge'?'challengedAt':'observedAt']='2026-09-16T11:58:00.000Z');
    add(op,`${op}-future`,v=>v.receipt[op==='challenge'?'challengedAt':'observedAt']='2026-09-16T12:00:05.001Z');
    add(op,`${op}-request-shape`,v=>v.request.extra=true);
  }
  add('challenge','challenge-missing-role',v=>v.receipt.databaseHeads.pop());
  add('challenge','challenge-schema',v=>v.receipt.databaseHeads[0].schemaHash=H('wrong'));
  add('challenge','challenge-nonce',v=>v.receipt.challengeNonce='challenge:wrong');
  add('scope','scope-static',v=>v.receipt.staticInspectionReceiptHash=H('wrong'));
  add('scope','scope-count',v=>v.receipt.operationCount=2);
  add('scope','scope-operation',v=>v.receipt.operationIds=['operation:wrong']);
  add('scope','scope-request-order',v=>v.request.requiredDatabaseRoles.reverse());
  add('scope','scope-request-duplicate',v=>{v.request.operationIds=['operation:test','operation:test'];v.request.operationCount=2;});
  add('scope','scope-empty-covered-valid',v=>{v.request.coveredDatabaseRoles=[];v.receipt.coveredDatabaseRoles=[];v.receipt.requestHash=hashRecord(v.request.kind,v.request);});
  add('list','list-empty-valid',v=>{v.receipt.unresolvedReservations=[];v.receipt.unresolvedReservationCount=0;v.receipt.unresolvedReservationSetHash=setHash([]);});
  add('list','list-expired-reservation-stored-valid',v=>{
    const entry=v.receipt.unresolvedReservations[0];
    entry.reserveRequest.requestedAt='2026-09-15T12:00:00.000Z';
    entry.reservation.issuedAt='2026-09-15T12:00:00.000Z';
    entry.reservation.expiresAt='2026-09-15T12:01:00.000Z';
    entry.reservation.requestHash=hashRecord(entry.reserveRequest.kind,entry.reserveRequest);
    entry.reservation=sign(entry.reservation);
    v.receipt.unresolvedReservationSetHash=setHash(v.receipt.unresolvedReservations);
  });
  add('list','list-count',v=>v.receipt.unresolvedReservationCount=0);
  add('list','list-set-hash',v=>v.receipt.unresolvedReservationSetHash=H('wrong'));
  add('list','list-nested-signature',v=>{v.receipt.unresolvedReservations[0].reservation.signature='bad';v.receipt.unresolvedReservationSetHash=setHash(v.receipt.unresolvedReservations);});
  add('list','list-nested-binding',v=>{v.receipt.unresolvedReservations[0].reserveRequest.databaseInstanceId='instance:wrong';v.receipt.unresolvedReservationSetHash=setHash(v.receipt.unresolvedReservations);});
  add('list','list-multiple',v=>{v.receipt.unresolvedReservations.push(v.receipt.unresolvedReservations[0]);v.receipt.unresolvedReservationCount=2;v.receipt.unresolvedReservationSetHash=setHash(v.receipt.unresolvedReservations);});
  add('list','list-nested-extra',v=>{v.receipt.unresolvedReservations[0].extra=true;});
  const replies=Object.fromEntries(Object.values(base).map(({request,receipt})=>[request.kind,receipt]));
  const script='#!/usr/bin/python3\nimport json,sys\nreplies=json.loads('+JSON.stringify(JSON.stringify(replies))+')\nrequest=json.load(sys.stdin)\nprint(json.dumps(replies.get(request.get("kind"))))\n';
  const commandPath=write('broker.py',script,0o700);
  const processConfigurationPath=write('process.json',{version:1,kind:'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',authorityConfigurationPath:configurationPath,authorityConfigurationSha256:hashBytes(fs.readFileSync(configurationPath)),commandPath,commandSha256:hashBytes(fs.readFileSync(commandPath)),fixedArguments:[],timeoutMs:1000});
  return {configurationPath,configurationFileHash:hashBytes(fs.readFileSync(configurationPath)),processConfigurationPath,processConfigurationFileHash:hashBytes(fs.readFileSync(processConfigurationPath)),publicKeyPath:pub,now,cases,base,expectedInstances};
}
function verify(input){
  const verifier=createAutonomousResearchOnlineMutationReceiptVerifier({configurationPath:input.configurationPath});
  const names={head:'verifyCurrentHead',challenge:'verifyActiveChallenge',scope:'verifyScope',list:'verifyUnresolvedReservations'};
  return verifier[names[input.case.operation]]({...input.case,now:new Date(input.case.now),expectedDatabaseInstances:input.case.expectedInstances});
}
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const results=input.map(request=>{try{
  if(request.operation==='fixture')return {ok:true,value:fixture(request.root)};
  if(request.operation==='verify')return {ok:true,accepted:verify(request)};
  if(request.operation==='process'){
    const client=createAutonomousResearchOnlineMutationAuthorityProcessClient({processConfigurationPath:request.processConfigurationPath});
    const names={head:'observeCurrentHead',challenge:'challengeActiveAuthority',scope:'observeScope',list:'listUnresolvedMutations'};
    return {ok:true,value:client[names[request.case.operation]]({...request.case,now:new Date(request.case.now),expectedDatabaseInstances:request.case.expectedInstances})};
  }
  throw new Error('unknown_operation');
}catch(error){return {ok:false,error:error.message};}});
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),results}));
