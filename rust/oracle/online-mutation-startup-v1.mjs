// Test-only signed startup broker and isolated memory database. No real authority.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { hashRecord, hashBytes } from '../../workflow-kernel/record-hash.mjs';
import * as contract from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import { verifyAutonomousResearchOnlineMutationAbort } from '../../paper-domain/automation/autonomous-research-online-mutation-recovery-contract.mjs';
import * as unresolved from '../../paper-domain/automation/autonomous-research-online-unresolved-reservation-contract.mjs';
import { reconcileAutonomousResearchOnlineMutationDatabaseStartup } from '../../paper-adapters/automation/autonomous-research-online-mutation-startup-reconciliation.mjs';
import { buildExternallyFencedSqliteMutationFinalizeRequest } from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-recovery.mjs';
import { externallyFencedSqliteMutationExactSchemaHash } from '../../paper-adapters/automation/externally-fenced-sqlite-storage-primitives.mjs';
assert.equal(process.version, 'v22.23.1');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
assert.ok(input.privateKeyPath.startsWith('/tmp/hepta-sqlite-coordinator-'));
const f = input.fixture, scenario = input.scenario, entry = input.entry;
const key = crypto.createPrivateKey(fs.readFileSync(input.privateKeyPath));
const publicKey = crypto.createPublicKey(key);
const H = label => hashRecord('SqliteCoordinatorNativeFixture', { label });
const sign = value => ({ ...value, signature: crypto.sign(null, Buffer.from(contract.autonomousResearchOnlineMutationSignedPayload(value)), key).toString('base64') });
const verifySignature = receipt => crypto.verify(null, Buffer.from(contract.autonomousResearchOnlineMutationSignedPayload(receipt)), publicKey, Buffer.from(receipt.signature, 'base64'));
const db = new DatabaseSync(':memory:');
for (const sql of f.schema) db.exec(sql);
const schema = externallyFencedSqliteMutationExactSchemaHash(db);
db.prepare('INSERT INTO autonomous_research_online_mutation_authority_metadata(singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at) VALUES(1,1,?,?,?,?,?,?,?,0,?,0,?,?,?)').run(contract.AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,'resident-instance','resident-instance','resident-instance-schema-v1',schema,f.trust.databaseScopeHash,f.trust.writerManifestHash,H('genesis-global'),H('genesis-database'),H(scenario==='wrong-head'?'wrong':'genesis-state'),f.now);
if (['committed','finalize-failure','bad-marker'].includes(scenario)) {
 const r=entry.reservation, q=entry.reserveRequest;
 const final=buildExternallyFencedSqliteMutationFinalizeRequest(r,f.now);
 db.prepare('INSERT INTO autonomous_research_online_mutation_authority_marker(reservation_id,database_role,database_instance_id,writer_id,operation_id,global_sequence,global_hash,database_sequence,database_hash,schema_hash,pre_state_hash,post_state_hash,changeset_hash,reserve_request_hash,reserve_request_json,reservation_receipt_hash,reservation_receipt_json,local_marker_hash,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.reservationId,r.databaseRole,r.databaseInstanceId,r.writerId,r.operationId,r.globalSequence,r.globalHash,r.databaseSequence,r.databaseHash,r.schemaHash,r.preStateHash,r.postStateHash,r.changesetHash,scenario==='bad-marker'?H('wrong'):hashRecord(q.kind,q),JSON.stringify(q),contract.autonomousResearchOnlineMutationReceiptHash(r),JSON.stringify(scenario==='bad-marker'?{...r,requestHash:H('wrong')}:r),final.localMarkerHash,f.now);
 db.exec('UPDATE resident_state SET generation=1;');
}
let pending=scenario!=='empty'; const calls=[];
const common={trust:f.trust,verifySignature,hashChangesetBase64:s=>hashBytes(Buffer.from(s,'base64'))};
const invoke = request => {
 calls.push(request);
 const receipt={...request,authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(request.kind,request)};
 if(request.kind==='AutonomousResearchOnlineUnresolvedReservationListRequest') {
  const entries=pending?[entry]:[];
  Object.assign(receipt,{kind:'AutonomousResearchOnlineUnresolvedReservationListReceipt',status:'autonomous_research_online_unresolved_reservations_observed',unresolvedReservationCount:entries.length,unresolvedReservationSetHash:unresolved.autonomousResearchOnlineUnresolvedReservationSetHash(entries),unresolvedReservations:entries,observedAt:request.requestedAt,expiresAt:'2026-07-18T08:01:00.000Z'});
 }else if(request.kind==='AutonomousResearchOnlineMutationAbortRequest') {
  if(scenario==='abort-failure')throw new Error('injected_abort_failure');
  if(scenario!=='confirmation-unresolved')pending=false;
  Object.assign(receipt,{kind:'AutonomousResearchOnlineMutationAbortReceipt',status:'autonomous_research_online_mutation_aborted',abortedAt:request.requestedAt});
 }else if(request.kind==='AutonomousResearchOnlineMutationFinalizeRequest') {
  if(scenario==='finalize-failure')throw new Error('injected_finalization_failure');
  pending=false;delete receipt.committedAt;
  Object.assign(receipt,{kind:'AutonomousResearchOnlineMutationFinalizationReceipt',status:'autonomous_research_online_mutation_finalized',finalizedAt:f.now,sideEffectPermitHash:H('permit')});
 }else throw new Error('unexpected_broker_operation');
 const signed=sign(receipt);
 if(scenario==='bad-list-signature'&&request.kind==='AutonomousResearchOnlineUnresolvedReservationListRequest')signed.signature=Buffer.alloc(64).toString('base64');
 return signed;
};
const client={protocol:contract.AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,trust:f.trust,
 listUnresolvedMutations({request,now}){const receipt=invoke(request);if(!unresolved.verifyAutonomousResearchOnlineUnresolvedReservationList({receipt,request,now,verifyStoredReservation:({receipt:stored,request:reserve})=>contract.verifyAutonomousResearchOnlineMutationReservation({receipt:stored,request:reserve,now:new Date(stored.issuedAt),...common}),...common}))throw new Error('autonomous_research_online_unresolved_reservation_list_receipt_invalid');return receipt;},
 verifyStoredReservation({receipt,request}){return contract.verifyAutonomousResearchOnlineMutationReservation({receipt,request,now:new Date(receipt.issuedAt),...common});},
 finalizeMutation({request,reservation,now}){const receipt=invoke(request);if(!contract.verifyAutonomousResearchOnlineMutationFinalization({receipt,request,reservation,now,...common}))throw new Error('autonomous_research_online_mutation_finalization_receipt_invalid');return receipt;},
 abortMutation({request,reservation,now}){const receipt=invoke(request);if(!verifyAutonomousResearchOnlineMutationAbort({receipt,request,reservation,now,...common}))throw new Error('autonomous_research_online_mutation_abort_receipt_invalid');return receipt;},
};
const previous=crypto.randomUUID;crypto.randomUUID=()=>{const value=input.nonces.shift();if(!value)throw new Error('oracle_nonce_missing');return value;};
let result;
try { result={ok:reconcileAutonomousResearchOnlineMutationDatabaseStartup({database:db,databaseRole:'resident-instance',databaseInstanceId:'resident-instance',authorityClient:client,writerManifest:f.manifest,clock:{now:()=>new Date(f.now)}})}; } catch(error) { result={error:error.message}; }
finally {crypto.randomUUID=previous;}
const counts={generation:db.prepare('SELECT generation FROM resident_state').get().generation,markers:db.prepare('SELECT count(*) n FROM autonomous_research_online_mutation_authority_marker').get().n,finalized:db.prepare('SELECT count(*) n FROM autonomous_research_online_mutation_finalization_receipt').get().n};
db.close();process.stdout.write(JSON.stringify({result,calls,counts}));
