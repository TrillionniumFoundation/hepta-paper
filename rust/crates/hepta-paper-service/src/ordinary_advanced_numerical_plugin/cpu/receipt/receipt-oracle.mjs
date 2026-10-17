import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.argv[1];
const { createActualCpuNumericalFixture }=await import(pathToFileURL(path.join(root,'paper-core/tests/support/advanced-numerical-real-cpu-fixture.mjs')));
const { createOsSandboxWorkerExecutionFinalizer }=await import(pathToFileURL(path.join(root,'paper-adapters/runtime/os-sandbox-worker-execution-finalizer.mjs')));
const { hashRecord }=await import(pathToFileURL(path.join(root,'workflow-kernel/record-hash.mjs')));
const here=path.join(root,'rust/oracle');
const historical=JSON.parse(fs.readFileSync(path.join(here,'numerical-cpu-worker.original-receipt.v1.json')));
const historicalResult=JSON.parse(fs.readFileSync(path.join(here,'numerical-cpu-worker.original-result.v1.json')));
const cases=['positive','failed','aborted','timed-out','source-mutated','runtime-mutated','missing-artifact','fixture-provenance','stderr-error','pid-invalid','missing-runtime','empty-runtime-name','uppercase-expected'];
const outputs=[];
for(const name of cases){
 const f=createActualCpuNumericalFixture();const sandboxRoot=fs.mkdtempSync(path.join(os.tmpdir(),'hepta-os-sandbox-oracle-'));const out=path.join(sandboxRoot,'output');fs.mkdirSync(out);fs.mkdirSync(f.outputDirectory,{recursive:true});
 try{
  assert.equal(f.snapshot.merkleHash,historical.sourceMerkleHashBefore);
  assert.equal(f.snapshot.manifestHash,historical.sourceWorkspaceManifestHashBefore);
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(historicalResult));
  const runtimeCopy=name==='runtime-mutated'?path.join(sandboxRoot,'runtime'):f.python;
  if(name==='runtime-mutated')fs.copyFileSync(f.python,runtimeCopy);
  if(name==='source-mutated')fs.writeFileSync(path.join(f.pluginRoot,'mutated.txt'),'actual changed source');
  if(name==='runtime-mutated')fs.writeFileSync(runtimeCopy,'actual changed executable');
  if(name==='missing-artifact')fs.unlinkSync(path.join(out,'result.json'));
  // Preserve the fixed source/contract sample while binding the executable
  // observation to the actual host bytes used by this differential owner.
  const w={...historical,runtimeExecutableSnapshotHash:f.pythonHash,runtimeExecutableSnapshotHashAfter:f.pythonHash};
  const {ok:_ok,receiptHash:_receiptHash,blockers:_blockers,...positivePayload}=w;
  w.receiptHash=hashRecord('OsSandboxWorkerReceipt',positivePayload);
  const result={status:name==='failed'?1:0,signal:null,stdout:'',stderr:'',pid:w.executionProcessIdentity.launcherPid};
  if(name==='aborted')result.aborted=true;
  if(name==='timed-out')result.timedOut=true;
  if(name==='stderr-error'){result.status=1;result.error=new Error('actual_error');}
  if(name==='pid-invalid')result.pid=-1;
  const runtimePresent=name!=='missing-runtime';
  const invoke=w.executionProcessInvocation;
  const binding={executionProcessInvocation:invoke,executionProcessInvocationHash:hashRecord('OsSandboxWorkerProcessInvocationBinding',invoke)};
  const finalize=createOsSandboxWorkerExecutionFinalizer({
   activeExecutionIdentity:{runtimeType:'host',runtimeIdentityHash:w.runtimeIdentityHash,executableInvocationPath:w.runtimeExecutableInvocationPath},
   allowedOutputRoot:f.outputRoot,boundedCpu:w.limits.cpuSeconds,boundedMemory:w.limits.memoryBytes,boundedOutput:w.limits.maximumOutputBytes,boundedPids:w.limits.maximumPids,boundedTimeout:w.limits.timeoutMs,containerImageDigest:null,
   datasetAccessSupervisorIdentityPath:null,datasetAccessTracePath:null,datasetAuthorizationSet:{datasetAuthorizationSetHash:w.datasetAuthorizationSetHash},environmentBindingHash:w.environmentBindingHash,environmentBomBinding:{environmentBom:w.environmentBom,environmentBomHash:w.environmentBomHash},executionBackend:'bubblewrap',
   expectedSourceMerkleHash:name==='uppercase-expected'?w.expectedSourceMerkleHash.toUpperCase():w.expectedSourceMerkleHash,expectedSourceWorkspaceManifestHash:w.expectedSourceWorkspaceManifestHash,
   immutableWorkRootMountVerified:true,maximumCapturedBytes:w.limits.maximumCapturedBytes,mountedDatasets:[],outputPaths:['result.json'],outputRoot:out,permittedEnvironment:Object.entries(w.executionBindings),processInvocationId:invoke.processInvocationId,processInvocationBinding:binding,processLimitProbe:{available:true,mechanism:w.isolation.processLimitMechanism},productionEvidenceEligible:name!=='fixture-provenance',
   requireDatasetAccessProof:false,requireSeparateOutputRoot:true,requiresGpu:false,resolvedOutputDirectory:f.outputDirectory,resolvedSourceRoot:f.pluginRoot,
   runtimeExecutableOverlayTarget:w.runtimeExecutableOverlayTarget,runtimeExecutableSnapshot:runtimePresent?{path:runtimeCopy,hash:w.runtimeExecutableSnapshotHash,invocationName:name==='empty-runtime-name'?'':w.runtimeExecutableInvocationName}:null,
   sandboxRoot,selectedImage:null,sourceDatasetRoots:[],sourceExcludedNames:[],sourceMerkleHashBefore:w.sourceMerkleHashBefore,sourceWorkspaceManifestHashBefore:w.sourceWorkspaceManifestHashBefore,supervisorRoot:null,workRoot:f.pluginRoot,workSourceMerkleHash:w.workSourceMerkleHash,workWorkspaceManifestHash:w.workWorkspaceManifestHash,
  });
  const report=finalize(result);
  if(name==='positive')assert.deepEqual(report,w);
  outputs.push({name,report,result:{...result,error:result.error?{message:result.error.message}:null},sourceAfter:report.sourceMerkleHashAfter,sourceManifestAfter:report.sourceWorkspaceManifestHashAfter});
 }finally{fs.rmSync(f.root,{recursive:true,force:true});if(fs.existsSync(sandboxRoot))fs.rmSync(sandboxRoot,{recursive:true,force:true});}
}
process.stdout.write(JSON.stringify(outputs));
