// Test-only ephemeral Ed25519 keys remain in this process. Only public key
// documents, signed receipts and fixed-response synthetic brokers reach disk.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAutonomousResearchOnlineMutationReceiptVerifier, createAutonomousResearchOnlineMutationAuthorityProcessClient } from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import { autonomousResearchOnlineMutationSignedPayload as payload, autonomousResearchOnlineMutationStateHash as stateHash, autonomousResearchOnlineMutationReceiptHash as receiptHash, autonomousResearchOnlineMutationLocalMarkerHash as markerHash } from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import { verifyAutonomousResearchOnlineMutationAbort, verifyAutonomousResearchOnlineMutationResolution } from '../../paper-domain/automation/autonomous-research-online-mutation-recovery-contract.mjs';
import { AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES as ROLES } from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashBytes,hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const H=label=>hashRecord('SqliteAuthorityRustTestOnly',{label});
function fixture(root,size=8){
  if(!root.startsWith('/tmp/hepta-sqlite-authority-rust-'))throw new Error('isolated_fixture_required');
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
  const finalFields=['protocol','scopeId','databaseScopeHash','writerManifestHash','reservationId','databaseRole','databaseInstanceId','writerId','operationId','globalSequence','globalHash','databaseSequence','databaseHash','schemaHash','postStateHash','changesetHash','authorizationReceiptHashes','sideEffectReservationHashes'];
  const finalizeRequest={version:1,kind:'AutonomousResearchOnlineMutationFinalizeRequest',...Object.fromEntries(finalFields.map(k=>[k,reservation[k]])),reservationReceiptHash:receiptHash(reservation),localMarkerHash:markerHash({reservation,committedAt:now}),committedAt:now};
  const {committedAt,...finalMirrored}=finalizeRequest;
  const finalization=sign({...finalMirrored,kind:'AutonomousResearchOnlineMutationFinalizationReceipt',status:'autonomous_research_online_mutation_finalized',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(finalizeRequest.kind,finalizeRequest),sideEffectPermitHash:H('permit'),finalizedAt:now});
  const abortFields=['protocol','scopeId','databaseScopeHash','writerManifestHash','reservationId','databaseRole','databaseInstanceId','writerId','operationId','mutationAttemptId','globalSequence','globalHash','databaseSequence','databaseHash','changesetHash'];
  const abortRequest={version:1,kind:'AutonomousResearchOnlineMutationAbortRequest',...Object.fromEntries(abortFields.map(k=>[k,reservation[k]])),reservationReceiptHash:receiptHash(reservation),reason:'local-apply-failed',requestedAt:now};
  const abort=sign({...abortRequest,kind:'AutonomousResearchOnlineMutationAbortReceipt',status:'autonomous_research_online_mutation_aborted',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(abortRequest.kind,abortRequest),abortedAt:now});
  const resolutionRequest={version:1,kind:'AutonomousResearchOnlineMutationResolutionRequest',...scope,mutationAttemptId:reserveRequest.mutationAttemptId,reserveRequestHash:hashRecord(reserveRequest.kind,reserveRequest),requestedAt:now};
  const resolution=sign({...resolutionRequest,kind:'AutonomousResearchOnlineMutationResolutionReceipt',status:'autonomous_research_online_mutation_resolution_observed',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(resolutionRequest.kind,resolutionRequest),resolution:'reserved',reservation,observedAt:now});
  const notFound=sign({...resolution,resolution:'not-found',reservation:null});
  const base={head:{request:headRequest,receipt:head},reserve:{request:reserveRequest,receipt:reservation},finalize:{request:finalizeRequest,receipt:finalization},abort:{request:abortRequest,receipt:abort},resolve:{request:resolutionRequest,receipt:resolution}};
  const cases=[];
  const add=(operation,label,change=()=>{},resign=true)=>{const selected=structuredClone(base[operation]);change(selected);if(resign)selected.receipt=sign(selected.receipt);cases.push({operation,label,...selected,now,expectedInstances,reservation,reserveRequest});};
  if(size<=8){
  for(const action of Object.keys(base))add(action,`${action}-valid`);
  add('resolve','not-found',v=>v.receipt=notFound);
  add('head','nonce-replay',v=>v.request.nonce='nonce:other');
  add('head','unresolved',v=>v.receipt.unresolvedReservationCount=1);
  add('head','missing-role',v=>v.receipt.databaseHeads.pop());
  add('head','duplicate-instance',v=>v.receipt.databaseHeads[1].databaseInstanceId=v.receipt.databaseHeads[0].databaseInstanceId);
  add('head','expired-head',v=>v.receipt.expiresAt=now);
  add('head','old-observation',v=>v.receipt.observedAt='2026-09-16T11:58:00.000Z');
  add('head','schema-drift',v=>v.receipt.databaseHeads[0].schemaHash=H('drift'));
  for(const action of Object.keys(base)){add(action,`${action}-bad-signature`,v=>v.receipt.signature='invalid',false);add(action,`${action}-wrong-authority`,v=>v.receipt.authorityId='authority:other');add(action,`${action}-extra-key`,v=>v.receipt.unexpected=true);}
  add('reserve','lease-expanded',v=>v.receipt.expiresAt='2026-09-16T12:02:00.000Z');
  add('reserve','lease-expired',v=>v.receipt.expiresAt=now);
  add('reserve','future-issued',v=>v.receipt.issuedAt='2026-09-16T12:00:05.001Z');
  add('reserve','global-sequence',v=>v.receipt.globalSequence=2);
  add('reserve','database-sequence',v=>v.receipt.databaseSequence=2);
  add('reserve','changeset-drift',v=>v.receipt.changesetBase64=Buffer.from('different').toString('base64'));
  add('reserve','request-hash-drift',v=>v.receipt.requestHash=H('wrong-request'));
  add('reserve','unpadded',v=>v.receipt.signature=v.receipt.signature.replaceAll('=',''),false);
  add('reserve','noncanonical-tail-bits',v=>{const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';const raw=v.receipt.signature.replaceAll('=','');v.receipt.signature=raw.slice(0,-1)+alphabet[alphabet.indexOf(raw.at(-1))|1]+'==';},false);
  add('reserve','whitespace-signature',v=>v.receipt.signature+='\n',false);
  add('finalize','marker-drift',v=>v.receipt.localMarkerHash=H('wrong-marker'));
  add('finalize','before-commit',v=>v.receipt.finalizedAt='2026-09-16T11:59:59.999Z');
  add('abort','future-abort',v=>v.receipt.abortedAt='2026-09-16T12:00:05.001Z');
  add('resolve','nested-signature-drift',v=>v.receipt.reservation.signature='invalid');
  add('resolve','old-resolution',v=>v.receipt.observedAt='2026-09-16T11:58:00.000Z');
  add('resolve','wrong-attempt',v=>v.receipt.mutationAttemptId='attempt:other');
  }
  const replies=Object.fromEntries(Object.values(base).map(({request,receipt})=>[request.kind,receipt]));
  const script='#!/usr/bin/python3\nimport json,sys\nreplies=json.loads('+JSON.stringify(JSON.stringify(replies))+')\nrequest=json.load(sys.stdin)\nprint(json.dumps(replies.get(request.get("kind"))))\n';
  const commandPath=write('broker.py',script,0o700);
  const processConfigurationPath=write('process.json',{version:1,kind:'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',authorityConfigurationPath:configurationPath,authorityConfigurationSha256:hashBytes(fs.readFileSync(configurationPath)),commandPath,commandSha256:hashBytes(fs.readFileSync(commandPath)),fixedArguments:[],timeoutMs:1000});
  return {configurationPath,configurationFileHash:hashBytes(fs.readFileSync(configurationPath)),processConfigurationPath,processConfigurationFileHash:hashBytes(fs.readFileSync(processConfigurationPath)),publicKeyPath:pub,commandPath,now,cases,base:size>8?{reserve:base.reserve}:base,expectedInstances};
}
function verify(request){
  const v=createAutonomousResearchOnlineMutationReceiptVerifier({configurationPath:request.configurationPath});
  const c=request.case;const shared={receipt:c.receipt,request:c.request,reservation:c.reservation,reserveRequest:c.reserveRequest,now:new Date(c.now),expectedDatabaseInstances:c.expectedInstances};
  if(c.operation==='head')return v.verifyCurrentHead(shared);
  if(c.operation==='reserve')return v.verifyReservation(shared);
  if(c.operation==='finalize')return v.verifyFinalization(shared);
  if(c.operation==='abort')return verifyAutonomousResearchOnlineMutationAbort({...shared,trust:v.trust,verifySignature:v.verifySignedReceipt});
  return verifyAutonomousResearchOnlineMutationResolution({...shared,trust:v.trust,verifySignature:v.verifySignedReceipt,verifyReservation:input=>v.verifyReservation(input)});
}
const requests=JSON.parse(fs.readFileSync(0,'utf8'));
const results=requests.map(request=>{try{
  if(request.operation==='fixture')return{ok:true,value:fixture(request.root,request.size)};
  if(request.operation==='verify')return{ok:true,accepted:verify(request)};
  if(request.operation==='process'){
    const client=createAutonomousResearchOnlineMutationAuthorityProcessClient({processConfigurationPath:request.processConfigurationPath});const c=request.case;
    const names={head:'observeCurrentHead',reserve:'reserveMutation',finalize:'finalizeMutation',abort:'abortMutation',resolve:'resolveMutationAttempt'};
    return{ok:true,value:client[names[c.operation]]({request:c.request,reservation:c.reservation,reserveRequest:c.reserveRequest,expectedDatabaseInstances:c.expectedInstances,now:new Date(c.now)})};
  }
  throw new Error('unknown_oracle_operation');
}catch(error){return{ok:false,error:error.message}}});
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),results}));
