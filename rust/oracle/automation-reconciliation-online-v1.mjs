// Test-only real schema25 business paths and a genuinely signed test authority.
// Only dedicated temporary fixture databases/keys are accepted; no runtime activation.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
import {hashRecord,hashBytes} from '../../workflow-kernel/record-hash.mjs';
import * as contract from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES as ROLES} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS as SYSTEM_SCHEMA} from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {autonomousResearchOnlineWriterOperationManifestHash} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {createExternallyFencedSqliteMutationCoordinator} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs';
import {externallyFencedSqliteMutationExactSchemaHash} from '../../paper-adapters/automation/externally-fenced-sqlite-storage-primitives.mjs';
import {NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_MUTATION_PLANS as PLANS,NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_ID as WRITER,NATIVE_STORE_AUTOMATION_RUNTIME_RECONCILIATION_WRITER_PLAN_HASH as IMPLEMENTATION} from '../../paper-adapters/automation/native-store-automation-runtime-reconciliation-mutation-plan.mjs';
import {executeAutomationRuntimeReconciliation} from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';
import {executeLegacyTerminalActiveResidueSettlement} from '../../paper-adapters/automation/legacy-terminal-active-residue-settlement.mjs';
import {createSqliteReceiptLedger} from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {issueAutomationReconcilerWriter} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
const NOW='2026-07-18T08:00:00.000Z';
const PROTOCOL=contract.AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL;
const H=label=>hashRecord('SqliteCoordinatorNativeFixture',{label});
function fixture(){
 const plans=PLANS,operations=Object.keys(plans).sort();
 const manifest={version:1,kind:'AutonomousResearchOnlineWriterCoverageManifest',manifestId:'reconciliation-online-fixture-v1',protocol:PROTOCOL,requiredDatabaseRoles:[...ROLES].sort(),writers:[{writerId:WRITER,databaseRoles:['native-store'],operationIds:operations,implementationHash:IMPLEMENTATION,protocol:PROTOCOL}],operations:[...operations.map(operationId=>({operationId,databaseRole:'native-store',sourceFile:'paper-adapters/automation/native-store-automation-runtime-reconciliation-mutation-plan.mjs',entrypoint:operationId,mutationClass:'business-dml',protocolStatus:'coordinator-integrated-reserve-apply-finalize-v1',coordinatorIntegrated:true})),...ROLES.filter(role=>role!=='native-store').map(role=>({operationId:`${role}.commit.v1`,databaseRole:role,sourceFile:`paper-adapters/automation/${role}-writer.mjs`,entrypoint:`${role}.commit`,mutationClass:'business-dml',protocolStatus:'uncovered-no-coordinator-integration',coordinatorIntegrated:false}))].sort((a,b)=>a.operationId<b.operationId?-1:1),coverage:{requiredRoleCount:10,coveredRoleCount:1,coveredDatabaseRoles:['native-store'],percent:10}};
 const trust={version:1,kind:'AutonomousResearchOnlineMutationAuthorityTrust',authorityId:'authority:test',keyId:'key:test',scopeId:'scope:test',databaseScopeHash:H('scope'),writerManifestHash:autonomousResearchOnlineWriterOperationManifestHash(manifest),maximumReservationLeaseMs:60000,maximumObservationAgeMs:60000};
 return {plans,manifest,trust,now:NOW,schema:SYSTEM_SCHEMA,genesisGlobalHash:H('genesis-global'),genesisDatabaseHash:H('genesis-database'),genesisStateHash:H('genesis-state'),otherSchemaHashes:Object.fromEntries(ROLES.map(role=>[role,H(`schema:${role}`)]))};
}
function coordinator(request){
 if(!request.privateKeyPath?.startsWith('/tmp/hepta-online-reconciliation-')||!request.databasePath?.startsWith('/tmp/hepta-online-reconciliation-'))throw new Error('oracle_requires_synthetic_key_fixture');
 const scenario=request.scenario;const f=fixture(),db=new DatabaseSync(request.databasePath);for(const sql of f.schema)db.exec(sql);
 if(['marker-failure','abort-failure'].includes(request.scenario))db.exec("CREATE TRIGGER coordinator_fixture_reject_marker BEFORE INSERT ON autonomous_research_online_mutation_authority_marker BEGIN SELECT RAISE(ABORT, 'injected_marker_failure'); END;");
 if(request.scenario==='record-failure')db.exec("CREATE TRIGGER coordinator_fixture_reject_finalization BEFORE INSERT ON autonomous_research_online_mutation_finalization_receipt BEGIN SELECT RAISE(ABORT, 'injected_record_failure'); END;");
 if(request.scenario==='receipt-failure')db.exec("CREATE TEMP TRIGGER reconciliation_online_receipt_failure BEFORE INSERT ON receipt_ledger BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END");
 if(request.scenario==='event-failure')db.exec("CREATE TEMP TRIGGER reconciliation_online_event_failure BEFORE INSERT ON campaign_events BEGIN SELECT RAISE(ABORT,'fixture_event_failure'); END");
 const schemaHash=externallyFencedSqliteMutationExactSchemaHash(db);
 db.prepare('INSERT INTO autonomous_research_online_mutation_authority_metadata(singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at) VALUES(1,1,?,?,?,?,?,?,?,0,?,0,?, ?,?)').run(PROTOCOL,'native-store','native-store','native-store-schema25-fixture-v1',schemaHash,f.trust.databaseScopeHash,f.trust.writerManifestHash,f.genesisGlobalHash,f.genesisDatabaseHash,f.genesisStateHash,NOW);
 const key=crypto.createPrivateKey(fs.readFileSync(request.privateKeyPath));const publicKey=crypto.createPublicKey(key);
 const sign=value=>Object.freeze({...value,signature:crypto.sign(null,Buffer.from(contract.autonomousResearchOnlineMutationSignedPayload(value)),key).toString('base64')});
 const verify=receipt=>crypto.verify(null,Buffer.from(contract.autonomousResearchOnlineMutationSignedPayload(receipt)),publicKey,Buffer.from(receipt.signature,'base64'));
 const hashes={globalHash:f.genesisGlobalHash,databaseHash:f.genesisDatabaseHash,stateHash:f.genesisStateHash,globalSequence:0,databaseSequence:0};
 const databaseHeads=()=>ROLES.map(role=>({databaseRole:role,databaseInstanceId:role,sequence:role==='native-store'?hashes.databaseSequence:0,hash:role==='native-store'?hashes.databaseHash:H(`head:${role}`),schemaHash:role==='native-store'?schemaHash:f.otherSchemaHashes[role],stateHash:role==='native-store'?hashes.stateHash:H(`state:${role}`)})).sort((a,b)=>a.databaseInstanceId<b.databaseInstanceId?-1:1);
 const instances=databaseHeads().map(({databaseRole,databaseInstanceId,schemaHash})=>({databaseRole,databaseInstanceId,schemaHash}));
 let reserved=null,allowFinalize=request.scenario!=='finalize-failure';const calls=[];
 const shared={trust:f.trust,verifySignature:verify,hashChangesetBase64:s=>hashBytes(Buffer.from(s,'base64'))};
 const client={protocol:PROTOCOL,trust:f.trust,
 observeCurrentHead({request:headRequest,now,expectedDatabaseInstances}){
 const mutations={
  'stale-parent-revision':"UPDATE paper_campaigns SET revision=revision+1 WHERE campaign_id IN ('campaign-2','legacy-campaign')",
  'stale-node-generation':"UPDATE campaign_nodes SET lease_generation=lease_generation+1 WHERE node_id IN ('node-1','legacy:expired-a')",
  'same-count-queued':"UPDATE campaign_nodes SET node_revision=node_revision+1 WHERE node_id IN ('node-3','legacy:queued-0000')",
 };
 if(mutations[scenario])db.exec(mutations[scenario]);
 const request=headRequest;calls.push({method:'head',request});const receipt=sign({version:1,kind:'AutonomousResearchOnlineMutationCurrentHeadReceipt',status:'autonomous_research_online_mutation_current_head_observed',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(request.kind,request),protocol:PROTOCOL,scopeId:f.trust.scopeId,databaseScopeHash:f.trust.databaseScopeHash,writerManifestHash:f.trust.writerManifestHash,globalSequence:hashes.globalSequence,globalHash:hashes.globalHash,databaseHeads:databaseHeads(),unresolvedReservationCount:0,observedAt:NOW,expiresAt:'2026-07-18T08:01:00.000Z'});if(!contract.verifyAutonomousResearchOnlineMutationCurrentHead({receipt,request,now,expectedDatabaseInstances,...shared}))throw new Error('head_invalid');return receipt;},
 reserveMutation({request:reserve,now}){calls.push({method:'reserve',request:reserve});if(request.scenario==='reserve-not-found')throw new Error('injected_reserve_failure');const {requestedAt,requestedLeaseMs,...mirror}=reserve;reserved=sign({...mirror,kind:'AutonomousResearchOnlineMutationReservationReceipt',status:'autonomous_research_online_mutation_reserved',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(reserve.kind,reserve),reservationId:'reservation:one',globalSequence:reserve.globalPreviousSequence+1,globalHash:H('global:1'),databaseSequence:reserve.databasePreviousSequence+1,databaseHash:H('database:1'),issuedAt:NOW,expiresAt:request.scenario==='expiring'?'2026-07-18T08:00:00.500Z':'2026-07-18T08:01:00.000Z'});if(!contract.verifyAutonomousResearchOnlineMutationReservation({receipt:reserved,request:reserve,now,...shared}))throw new Error('reservation_invalid');if(['reserve-lost','resolve-failure'].includes(request.scenario))throw new Error('injected_reserve_failure');return reserved;},
 resolveMutationAttempt({request:resolution}){calls.push({method:'resolve',request:resolution});if(request.scenario==='resolve-failure')throw new Error('injected_resolution_failure');return reserved;},
 verifyStoredReservation({receipt,request}){return contract.verifyAutonomousResearchOnlineMutationReservation({receipt,request,now:new Date(receipt.issuedAt),...shared});},
 finalizeMutation({request:final,reservation,now}){calls.push({method:'finalize',request:final});if(!allowFinalize)throw new Error('injected_finalization_failure');const {committedAt,...mirror}=final;const receipt=sign({...mirror,kind:'AutonomousResearchOnlineMutationFinalizationReceipt',status:'autonomous_research_online_mutation_finalized',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(final.kind,final),sideEffectPermitHash:H('permit'),finalizedAt:NOW});if(!contract.verifyAutonomousResearchOnlineMutationFinalization({receipt,request:final,reservation,now,...shared}))throw new Error('finalization_invalid');Object.assign(hashes,{globalSequence:reservation.globalSequence,globalHash:reservation.globalHash,databaseSequence:reservation.databaseSequence,databaseHash:reservation.databaseHash,stateHash:reservation.postStateHash});return receipt;},
 abortMutation({request:abort}){calls.push({method:'abort',request:abort});if(request.scenario==='abort-failure')throw new Error('injected_abort_failure');return sign({...abort,kind:'AutonomousResearchOnlineMutationAbortReceipt',status:'autonomous_research_online_mutation_aborted',authorityId:'authority:test',keyId:'key:test',requestHash:hashRecord(abort.kind,abort),abortedAt:NOW});}};
 const previous=crypto.randomUUID;const nonces=[...request.nonces];crypto.randomUUID=()=>{const n=nonces.shift();if(!n)throw new Error('oracle_nonce_missing');return n;};
 let clockCalls=0;const advancingClock=()=>new Date(Date.parse(NOW)+((request.advanceClockAt&&++clockCalls>=request.advanceClockAt)?59501:0));
 try {
  const epochCalls=[];
  const recoverabilityFence=request.epochFence ? {
    assertCurrent(){epochCalls.push({method:'current'});if(request.scenario==='fatal-epoch'){const e=new Error('fixture_epoch_lost');e.stateRecoverabilityFatal=true;throw e;}return {status:'current'};},
    reconcile(){epochCalls.push({method:'reconcile'});return {status:'current'};},
    markMutationFinalized(head){epochCalls.push({method:'finalized',value:head});if(request.scenario==='fatal-epoch'){const e=new Error('fixture_epoch_lost');e.stateRecoverabilityFatal=true;throw e;}},
    markMutationReconciliationRequired(requirement){epochCalls.push({method:'required',value:requirement});},
  }:null;
  const coordinator=createExternallyFencedSqliteMutationCoordinator({authorityClient:client,manifest:f.manifest,operationPlans:f.plans,databaseInstances:instances,clock:{now:advancingClock},recoverabilityEpochFence:recoverabilityFence});
  const businessCalls=[];
  const observeBusiness=kind=>{businessCalls.push(kind);if(businessCalls.length===request.businessClockFailureAt)throw new Error('fixture_after_plan_clock_failure');return request.businessNow;};
  const clock={now(){return new Date(observeBusiness('now'));},nowIso(){return observeBusiness('nowIso');}};
  let finalizedMutation=null;
  // Fixture-only StorePort links the real business function directly to the real
  // restricted signed coordinator. No active runtime capability is asserted.
  const store={query(sql,parameters=[]){return {ok:true,rows:db.prepare(sql).all(...parameters)};},execute(){throw new Error('fixture_unfenced_write_forbidden');},mutate(input){const coordinated=coordinator.executeMutation({...input,database:db,databaseInstanceId:'native-store',schemaContractId:'native-store-schema25-fixture-v1',writerId:WRITER,mutate(transaction){if(request.scenario==='before-apply')throw new Error('fixture_scope_lost_before');const result=input.mutate(transaction);if(request.scenario==='after-apply')throw new Error('fixture_scope_lost_after');return result;}});finalizedMutation=coordinated;return coordinated;}};
  const receiptLedger=createSqliteReceiptLedger({store,clock,issuerCapability:issueAutomationReconcilerWriter()});
  let result;
  try {const operation=request.legacy?executeLegacyTerminalActiveResidueSettlement:executeAutomationRuntimeReconciliation;result={ok:true,value:operation({store,clock,receiptLedger,campaignId:request.campaignId,noProgressSeconds:1800})};}
  catch(e){result={ok:false,error:e.message,committed:e.committed??null,stateRecoverabilityFatal:Boolean(e.stateRecoverabilityFatal),stateRecoverabilityDeferred:Boolean(e.stateRecoverabilityDeferred),retryable:Boolean(e.retryable)};}
  let recovery=null;
  if(request.recover){allowFinalize=true;try{recovery={ok:true,value:coordinator.recoverPendingMutations({database:db})};}catch(e){recovery={ok:false,error:e.message};}}
  const snapshot=Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB 'autonomous_research_online_mutation_*' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()]));
  return {result,recovery,calls,status:coordinator.inspectStatus(),snapshot,businessCalls,epochCalls,...(request.captureFinalized?{finalizedMutation}:{}),markerCount:db.prepare('SELECT count(*) n FROM autonomous_research_online_mutation_authority_marker').get().n,finalizationCount:db.prepare('SELECT count(*) n FROM autonomous_research_online_mutation_finalization_receipt').get().n};
 }finally{crypto.randomUUID=previous;db.close();}
}
const requests=JSON.parse(fs.readFileSync(0,'utf8'));
const results=requests.map(request=>{try{return {ok:true,value:request.operation==='fixture'?fixture():coordinator(request)};}catch(e){return {ok:false,error:e.message};}});
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),results}));
