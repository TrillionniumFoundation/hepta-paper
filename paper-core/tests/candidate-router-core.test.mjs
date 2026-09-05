import assert from 'node:assert/strict';
import test from 'node:test';
import { routeCandidateFrontier as route } from '../../paper-application/orchestration/candidate-router.mjs';
import { H, request, binding, candidate, input, singleton, code } from './candidate-router-test-support.mjs';
const ids=(r)=>r.candidates.map((x)=>x.candidateId);

test('deterministic order, safe dedupe and no local Pareto pruning',()=>{
 const a=candidate('a',{preconditions:['z','a'],dependencyEffects:['expensive'],value:{expectedMicrounits:500},cost:{maximumMicrousd:1}}),b=candidate('b',{dependencyEffects:[],value:{expectedMicrounits:400},cost:{maximumMicrousd:2}});
 const x=route(input([a,b])),y=route(input([b,candidate('a',{preconditions:['a','z'],dependencyEffects:['expensive'],value:{expectedMicrounits:500},cost:{maximumMicrousd:1}})]));
 assert.equal(x.candidateSetHash,y.candidateSetHash);assert.deepEqual(ids(x),ids(y));assert.equal(x.dominanceReductionApplied,false);
 const z={...singleton('z'),candidateId:'a'};const d=route(input([singleton('z'),structuredClone(singleton('z')),z]));assert.deepEqual(ids(d),['a']);assert.equal(d.duplicateCount,2);
});

test('conflicting ids and forged payload hashes fail',()=>{
 assert.throws(()=>route(input([candidate('x',{value:{n:1}}),candidate('x',{value:{n:2}})])),code('action_candidate_id_conflict'));
 const row=singleton();row.value.expectedMicrounits=999;assert.throws(()=>route(input([row])),code('action_candidate_payload_hash_invalid'));
});

test('request, snapshot, capability, module and side effect are exact',()=>{
 for(const [field,value,expected] of [['planningRequestId','other','action_candidate_request_mismatch'],['stateSnapshotHash',H('9'),'action_candidate_snapshot_mismatch'],['capabilityId','CAP-X','action_candidate_capability_mismatch'],['moduleVersion','2','action_candidate_module_not_bound']]) assert.throws(()=>route(input([singleton('x',{[field]:value})])),code(expected));
 assert.throws(()=>route(input([singleton()],{moduleBindings:[binding({capabilityIds:['CAP-X']})]})),code('action_candidate_module_capability_mismatch'));
 assert.throws(()=>route(input([singleton('x',{sideEffectClass:'external_effect'})])),code('action_candidate_side_effect_not_allowed'));
});

test('expiry and resources fail closed',()=>{
 assert.throws(()=>route(input([singleton()],{planningRequest:request({expiresAt:'2026-09-05T00:00:00Z'})})),code('planning_request_expired'));
 assert.throws(()=>route(input([singleton('x',{expiresAt:'2026-09-05T00:00:00Z'})])),code('action_candidate_not_current'));
 for(const [field,value] of [['cpuUnits',NaN],['gpuUnits',-1],['memoryMiB',1.5],['storageBytes',Infinity]]){const resourceVector={...candidate('x').resourceVector,[field]:value};assert.throws(()=>route(input([singleton('x',{resourceVector})])));}
});

test('unknown fields, sparse arrays and hard limits fail closed',()=>{
 assert.throws(()=>route(input([{...singleton(),secret:'x'}])),code('action_candidate_invalid'));
 const sparse=[];sparse.length=1;assert.throws(()=>route(input(sparse)),code('action_candidate_collection_invalid'));
 assert.throws(()=>route(input([candidate('a'),candidate('b',{value:{n:2}})],{planningRequest:request({candidateLimit:1})})),code('action_candidate_collection_invalid'));
});

test('singleton reason belongs only to a final singleton',()=>{
 assert.throws(()=>route(input([candidate('only')])),code('candidate_frontier_singleton_reason_required'));
 assert.throws(()=>route(input([singleton('a'),candidate('b',{value:{n:2}})])),code('candidate_frontier_singleton_reason_forbidden'));
});

test('result is detached immutable and nonauthorizing',()=>{
 const row=singleton(),supplied=input([row]),result=route(supplied);row.value.expectedMicrounits=999;assert.equal(result.candidates[0].value.expectedMicrounits,100);
 assert.throws(()=>{result.candidates[0].value.expectedMicrounits=3;},TypeError);assert.equal(result.externalActionPerformed,false);assert.ok(Object.values(result.authority).every((x)=>x===false));
});

test('objective and hard constraints bind frontier identity',()=>{
 const a=route(input([singleton()])),b=route(input([singleton()],{planningRequest:request({objectiveVersion:'v2'})})),c=route(input([singleton()],{planningRequest:request({hardConstraintSetHash:H('9')})}));
 assert.notEqual(a.candidateSetHash,b.candidateSetHash);assert.notEqual(a.candidateSetHash,c.candidateSetHash);
});
