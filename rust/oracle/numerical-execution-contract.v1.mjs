import fs from 'node:fs';
import { signedPluginFixture } from '../../paper-core/tests/support/advanced-numerical-qualification-fixture.v2.mjs';
import {
  buildAdvancedNumericalPluginRequest,
  verifyAdvancedNumericalPluginResult,
} from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
const f = signedPluginFixture();
const requestCases = [];
const resultCases = [];
const base = {runId:'run-1',input:{values:[1,2,3]},seed:17};
function request(name, wire, descriptor = f.descriptor) {
  wire = JSON.parse(JSON.stringify(wire));
  let result;
  try { result = {ok:true,value:buildAdvancedNumericalPluginRequest({descriptor,...wire})}; }
  catch(error) { result = {ok:false,name:error.name,error:error.message}; }
  requestCases.push({name,descriptorRaw:JSON.stringify(descriptor),wireRaw:JSON.stringify(wire),resultRaw:JSON.stringify(result)});
}
try {
  request('valid',base);
  for(const id of [null,false,true,0,1,-1,1.5,9007199254740991,'',' abc ','abc','a:b.c-_','a/b','é','😀',[],['abc'],[['abc']],['abc','def'],{}, {toString:null}, {toString:1}, {valueOf:null}, {valueOf:1}, {valueOf:{}}, [{valueOf:null}], [[{valueOf:1}]], [{toString:null}], [[{toString:1}]],'a'.repeat(192),'a'.repeat(193),'\uFEFFabc\uFEFF']) request('runId-'+JSON.stringify(id),{...base,runId:id});
  for(const seed of [null,false,true,'17',0,-1,-0,1.5,9007199254740991,-9007199254740991,9007199254740992]) request('seed-'+JSON.stringify(seed),{...base,seed});
  request('seed-missing',{runId:'run-1',input:null});
  request('runId-missing',{input:null,seed:17});
  request('input-missing',{runId:'run-1',seed:17});
  for(const input of [null,true,false,0,-0,1.25,'hello','😀',[],[1,'x',null],{'ä':1,A:2,a:3,z:4},'x'.repeat(32766),'x'.repeat(32767)]) request('input-'+requestCases.length,{...base,input});
  request('descriptor-invalid',base,{...f.descriptor,pluginId:'changed'});
  for(const rawId of ['1e999','-1e999','[1e999]','[-1e999]']) {
    const wireRaw=`{"runId":${rawId},"input":null,"seed":17}`,wire=JSON.parse(wireRaw);
    let outcome;
    try {outcome={ok:true,value:buildAdvancedNumericalPluginRequest({descriptor:f.descriptor,...wire})};}
    catch(error) {outcome={ok:false,name:error.name,error:error.message};}
    requestCases.push({name:'raw-nonfinite-runId-'+rawId,descriptorRaw:JSON.stringify(f.descriptor),wireRaw,resultRaw:JSON.stringify(outcome)});
  }

  const built = buildAdvancedNumericalPluginRequest({descriptor:f.descriptor,...base});
  const hash = label => hashRecord('ActualContractCase',label);
  const payload = {version:1,kind:'AdvancedNumericalPluginResult',status:'advanced_numerical_computation_completed',pluginId:f.descriptor.pluginId,analysisFamily:f.descriptor.analysisFamily,requestHash:built.advancedNumericalPluginRequestHash,oracleContractHash:f.descriptor.assuranceContracts.oracle.contractHash,replayContractHash:f.descriptor.assuranceContracts.replay.contractHash,uncertaintyContractHash:f.descriptor.assuranceContracts.uncertainty.contractHash,estimateArtifactHash:hash('estimate'),oracleReceiptHash:hash('oracle'),replayReceiptHash:hash('replay'),uncertaintyArtifactHash:hash('artifact'),uncertaintyReceiptHash:hash('uncertainty')};
  const sign = p => ({...p,advancedNumericalPluginResultHash:hashRecord('AdvancedNumericalPluginResult',p)});
  function result(name,value,descriptor=f.descriptor,requestDocument=built) {
    value=JSON.parse(JSON.stringify(value));
    let actual;
    try { actual={ok:true,value:verifyAdvancedNumericalPluginResult(value,{descriptor,request:requestDocument})}; }
    catch(error) { actual={ok:false,name:error.name,error:error.message}; }
    resultCases.push({name,descriptorRaw:JSON.stringify(descriptor),requestRaw:JSON.stringify(requestDocument),resultRaw:JSON.stringify(value),actualRaw:JSON.stringify(actual)});
  }
  result('valid',sign(payload));
  result('extras-in-hash',sign({...payload,extra:{ä:[1,2,'😀'],nested:{b:2,a:1}}}));
  result('extra-not-hashed',{...sign(payload),extra:'changed'});
  for(const field of Object.keys(payload)) {
    const p={...payload};delete p[field];result('missing-'+field,sign(p));
    result('wrong-'+field,sign({...payload,[field]:null}));
  }
  for(const field of ['estimateArtifactHash','oracleReceiptHash','replayReceiptHash','uncertaintyArtifactHash','uncertaintyReceiptHash']) {
    result('uppercase-'+field,sign({...payload,[field]:payload[field].toUpperCase()}));
    result('array-'+field,sign({...payload,[field]:[payload[field]]}));
    result('object-'+field,sign({...payload,[field]:{toString:null}}));
    result('own-valueOf-'+field,sign({...payload,[field]:{valueOf:null}}));
  }
  result('uppercase-final-hash',{...sign(payload),advancedNumericalPluginResultHash:sign(payload).advancedNumericalPluginResultHash.toUpperCase()});
  result('wrong-final-hash',{...sign(payload),advancedNumericalPluginResultHash:hash('wrong')});
  result('null',null); result('array',[]);result('descriptor-contract-change',sign(payload),{...f.descriptor,assuranceContracts:{...f.descriptor.assuranceContracts,oracle:{contractHash:hash('changed')}}});
  result('request-change',sign(payload),f.descriptor,{...built,advancedNumericalPluginRequestHash:hash('changed')});
  process.stdout.write(JSON.stringify({version:1,kind:'ActualOriginalNumericalExecutionContractCases',requestCases,resultCases})+'\n');
} finally { fs.rmSync(f.root,{recursive:true,force:true}); }
