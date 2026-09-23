// Real incumbent producer, isolated fixture key and journal only.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createSchemaHistoryFixture } from '../schema_history/oracle.mjs';

const [repository, root, mode='tail'] = process.argv.slice(2);
const { productionOracleProfile } = await import(pathToFileURL(path.join(repository,'rust/oracle/production-record-hash-v1.mjs')));
const { hashBytes } = await import(pathToFileURL(path.join(repository,'workflow-kernel/record-hash.mjs')));
const mutation = await import(pathToFileURL(path.join(repository,'paper-domain/automation/autonomous-research-online-mutation-contract.mjs')));
const fixture = await createSchemaHistoryFixture({repository,root,rebindCount:mode==='rebound'?1:0,stopAt:'activated'});
const {authority,configuration,genesis} = fixture;
const copied=(value,fields)=>Object.fromEntries(fields.map(k=>[k,value[k]]));
const shared='protocol scopeId databaseScopeHash writerManifestHash reservationId databaseRole databaseInstanceId writerId operationId globalSequence globalHash databaseSequence databaseHash changesetHash'.split(' ');
let now=Date.parse('2026-09-21T01:00:00.000Z');
function reserve(index) {
  fixture.setNow(new Date(now).toISOString());
  const current=authority.inspect();
  const previous=current.databaseHeads[index % 2];
  const epoch=genesis.databaseHeads.find(h=>h.databaseInstanceId===previous.databaseInstanceId);
  const bytes=Buffer.from(`actual incumbent mutation history ${index}`);
  const state={databaseRole:previous.databaseRole,databaseInstanceId:previous.databaseInstanceId,
    writerId:'writer:history',operationId:'operation:history',schemaHash:previous.schemaHash,
    previousStateHash:previous.stateHash,changesetHash:hashBytes(bytes),databaseSequence:previous.sequence+1,
    authorizationReceiptHashes:[],sideEffectReservationHashes:[]};
  const request={version:1,kind:'AutonomousResearchOnlineMutationReserveRequest',
    protocol:mutation.AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    ...copied(configuration,['scopeId','databaseScopeHash','writerManifestHash']),
    ...copied(state,['databaseRole','databaseInstanceId','writerId','operationId','schemaHash','changesetHash','authorizationReceiptHashes','sideEffectReservationHashes']),
    codeProvenanceHash:hashBytes(Buffer.from('fixture-code')),mutationAttemptId:`mutation:history:${index}`,
    globalPreviousSequence:current.globalSequence,globalPreviousHash:current.globalHash,
    databasePreviousSequence:previous.sequence,databasePreviousHash:previous.hash,
    schemaContractId:epoch.schemaContractId,preStateHash:previous.stateHash,
    postStateHash:mutation.autonomousResearchOnlineMutationStateHash(state),
    changesetEncoding:'base64',changesetBase64:bytes.toString('base64'),changesetByteLength:bytes.length,
    requestedAt:new Date(now).toISOString(),requestedLeaseMs:1000};
  return authority.handle(request);
}
function finalize(reservation, late) {
  const committedAt=new Date(now).toISOString();
  now+=late?60000:1;
  fixture.setNow(new Date(now).toISOString());
  return authority.handle({version:1,kind:'AutonomousResearchOnlineMutationFinalizeRequest',
    ...copied(reservation,shared),...copied(reservation,['schemaHash','postStateHash','authorizationReceiptHashes','sideEffectReservationHashes']),
    reservationReceiptHash:mutation.autonomousResearchOnlineMutationReceiptHash(reservation),
    localMarkerHash:mutation.autonomousResearchOnlineMutationLocalMarkerHash({reservation,committedAt}),committedAt});
}
try {
  if(mode!=='empty') {
    for(let index=0;index<3;index++) {
      if(mode==='regressing-clock'&&index===2) now-=120000;
      const reservation=reserve(index);finalize(reservation,index===1);now+=1000;
    }
    if(mode==='tail'||mode==='reserved') {
      const reservation=reserve(3);
      if(mode==='tail') authority.handle({version:1,kind:'AutonomousResearchOnlineMutationAbortRequest',
        ...copied(reservation,shared),mutationAttemptId:reservation.mutationAttemptId,
        reservationReceiptHash:mutation.autonomousResearchOnlineMutationReceiptHash(reservation),
        reason:'local-apply-failed',requestedAt:new Date(now).toISOString()});
    }
  }
  process.stdout.write(JSON.stringify({profile:productionOracleProfile(),configuration,
    publicKeyPem:fixture.publicKeyPem,genesis,terminal:authority.inspect()})+'\n');
} finally {fixture.close();}
