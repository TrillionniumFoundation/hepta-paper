import fs from 'node:fs';
import {buildEmpiricalEnvironmentBom,verifyEmpiricalEnvironmentBom,verifyEnvironmentBomAgainstWorkerReceipt} from '../../paper-domain/automation/environment-bom-contract.mjs';
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
const input=JSON.parse(fs.readFileSync(new URL('./numerical-bom.v2.input.json',import.meta.url),'utf8'));
const receipt=JSON.parse(fs.readFileSync(new URL('./numerical-bom.v2.worker.json',import.meta.url),'utf8'));
const clone=v=>JSON.parse(JSON.stringify(v));
const out={version:1,builderCases:[],verificationCases:[],receiptCases:[]};
function capture(run){try{return {ok:true,value:run()};}catch(error){return {ok:false,name:error.name,error:error.message};}}
function build(name,value,domain=null){out.builderCases.push({name,inputRaw:JSON.stringify(value),domain,resultRaw:JSON.stringify(capture(()=>buildEmpiricalEnvironmentBom(value)))});}
build('actual-observed-cpu-run',input);build('default',{});
for(const [name,v] of [['null',null],['zero',0],['false',false],['string','x'],['array',[]]])build('top-'+name,v);
for(const part of ['platform','runtime','gpu','numericRuntime','limits','determinism','buildReproducibility']) {
 const missing=clone(input);delete missing[part];build('missing-'+part,missing);
 for(const value of [null,0,false,'x',[]])build(part+'-'+JSON.stringify(value),{...clone(input),[part]:value});
}
build('canonical-string-sets',{...clone(input),observedClaims:['b','a','b',false,null,0,[],{}, {valueOf:null}],unobservedClaims:['😀','é','z','a']});
build('claim-conversion-error',{...clone(input),observedClaims:[{toString:null}]});
for(const n of ['threads','ascii-unknown','unicode-ties']) {
 const v=clone(input);v.numericRuntime.threads=n==='threads'?{OMP_NUM_THREADS:'1',MKL_NUM_THREADS:2,RAYON_NUM_THREADS:'3'}:n==='ascii-unknown'?{UNKNOWN:'1'}:{'é':'1','e\u0301':'2'};
 build(n,v,n==='threads'?null:'fixed_seven_numeric_threads');
}
for(const numberRaw of ['1e999','-1e999']) {
 const inputRaw=`{"runtime":{"type":${numberRaw}}}`;
 out.builderCases.push({name:'nonfinite-runtime-'+numberRaw,inputRaw,domain:'finite_json_numbers',resultRaw:JSON.stringify(capture(()=>buildEmpiricalEnvironmentBom(JSON.parse(inputRaw))))});
}
const bom=buildEmpiricalEnvironmentBom(input);
const groups=[['platform','EmpiricalEnvironmentHardwareIdentity','hardwareIdentityHash'],['runtime','EmpiricalEnvironmentRuntimeClosure','runtimeClosureHash'],['gpu','EmpiricalEnvironmentGpuIdentity','gpuIdentityHash'],['numericRuntime','EmpiricalNumericRuntimePolicy','numericRuntimePolicyHash'],['limits','EmpiricalEnvironmentResourceLimits','resourceLimitsHash'],['determinism','EmpiricalDeterminismPolicy','determinismPolicyHash'],['buildReproducibility','RuntimeBuildReproducibilityAssessment','buildReproducibilityHash']];
function rehash(value){
 for(const [part,kind,key] of groups){if(value[part]&&typeof value[part]==='object'&&!Array.isArray(value[part])){const p={...value[part]};delete p[key];value[part][key]=hashRecord(kind,p);}}
 const p={...value};delete p.environmentBomHash;value.environmentBomHash=hashRecord('EmpiricalEnvironmentBOM',p);return value;
}
function verify(name,v,rehashValue=false){if(rehashValue)v=rehash(v);out.verificationCases.push({name,bomRaw:JSON.stringify(v),resultRaw:JSON.stringify(capture(()=>verifyEmpiricalEnvironmentBom(v)))});}
verify('actual-observed-cpu-run',bom);
for(const v of [null,[],false,0,'x',{}, {version:1}, {...bom,environmentBomHash:'invalid'}])verify('shape-'+out.verificationCases.length,v);
for(const key of Object.keys(bom)){const v=clone(bom);delete v[key];verify('missing-top-'+key,v,true);}
for(const [part] of groups)for(const key of Object.keys(bom[part])){
 if(key.endsWith('Hash'))continue;
 for(const kind of ['missing','null','wrong']){const v=clone(bom);if(kind==='missing')delete v[part][key];else v[part][key]=kind==='null'?null:'changed';verify(part+'-'+key+'-'+kind,v,true);}
}
for(const field of ['basis','identityHash','manifestHash','observedPackageCount'])for(const kind of ['missing','null','wrong']){
 const v=clone(bom);if(kind==='missing')delete v.runtime.packageClosure[field];else v.runtime.packageClosure[field]=kind==='null'?null:'changed';verify('closure-'+field+'-'+kind,v,true);
}
const countMissing=clone(bom);delete countMissing.runtime.packageClosure.observedPackageCount;countMissing.runtime.packageClosure.identityHash=hashRecord('RuntimePackageClosureIdentity',{manifestHash:countMissing.runtime.packageClosure.manifestHash});verify('closure-missing-count-valid-binding',countMissing,true);
const manifestMissing=clone(bom);delete manifestMissing.runtime.packageClosure.manifestHash;manifestMissing.runtime.packageClosure.identityHash=hashRecord('RuntimePackageClosureIdentity',{observedPackageCount:0});verify('closure-missing-manifest-valid-binding',manifestMissing,true);
for(const [name,observedClaims,unobservedClaims] of [['overlap',['a'],['a']],['duplicate',['a','a'],[]],['unsorted',['b','a'],[]],['nonstring',[1],[]],['empty',[''],[]]])verify('claims-'+name,{...clone(bom),observedClaims,unobservedClaims},true);
verify('claims-string-error',{...clone(bom),observedClaims:[1,{toString:null}]},true);
verify('claims-observed-invalid-skips-unobserved-error',{...clone(bom),observedClaims:[1],unobservedClaims:[{toString:null}]},true);
verify('claims-valueOf-only',{...clone(bom),observedClaims:[{valueOf:null}]},true);
for(const value of [null,{},[],{'OMP_NUM_THREADS':'1'},{'OMP_NUM_THREADS':{toString:null}},{'UNKNOWN':'1'}])verify('threads-'+JSON.stringify(value),{...clone(bom),numericRuntime:{...clone(bom.numericRuntime),threads:value}},true);
function against(name,b,r){out.receiptCases.push({name,bomRaw:JSON.stringify(b),receiptRaw:JSON.stringify(r),resultRaw:JSON.stringify(capture(()=>verifyEnvironmentBomAgainstWorkerReceipt(b,r)))});}
against('actual-observed-cpu-run',bom,receipt);
for(const key of ['environmentBomHash','runtimeIdentityHash','runtimeIdentityType','containerImageDigest']){const r=clone(receipt);delete r[key];against('missing-'+key,bom,r);against('wrong-'+key,bom,{...clone(receipt),[key]:'changed'});}
for(const key of Object.keys(bom.limits).filter(k=>!k.endsWith('Hash'))){const r=clone(receipt);delete r.limits[key];against('missing-limit-'+key,bom,r);const wrong=clone(receipt);wrong.limits[key]=bom.limits[key]+1;against('wrong-limit-'+key,bom,wrong);}
for(const r of [null,{},[],0,false,'x'])against('receipt-'+JSON.stringify(r),bom,r);
for(const v of [false,true,1,0,null,'x']){const r=clone(receipt);r.isolation.gpuAccessRequested=v;against('gpu-request-'+JSON.stringify(v),bom,r);}
for(const cases of Object.values(out).filter(Array.isArray))for(const item of cases){const value=JSON.parse(item.resultRaw);if(value.ok)item.valueRaw=JSON.stringify(value.value);}
process.stdout.write(JSON.stringify(out)+'\n');
