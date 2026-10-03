import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createActualCpuNumericalFixture } from './support/advanced-numerical-real-cpu-fixture.mjs';
import { observeAdvancedNumericalHostRuntimeClosure } from '../../paper-adapters/runtime/advanced-numerical-host-runtime-closure.mjs';
import { inspectWorkspaceExecutionSnapshot } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { verifyEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function actualRun(f) {
  const args=[path.join(root,'paper-core/bin/hepta-paper.mjs'),'operator','advanced-numerical-plugin','--','--action','run','--config',f.configurationPath,'--request',f.requestPath,'--output-directory',f.outputDirectory];
  const actual=spawnSync(process.execPath,args,{cwd:root,env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},encoding:'utf8',timeout:30_000,maxBuffer:4*1024*1024});
  assert.equal(actual.error,undefined);assert.equal(actual.signal,null);assert.equal(actual.stderr,'');
  return {exit:actual.status,report:JSON.parse(actual.stdout),stdout:actual.stdout};
}
test('actual numerical CPU run binds observed BOM and refuses result replay',context=>{
  const f=createActualCpuNumericalFixture();
  context.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const first=actualRun(f);assert.equal(first.exit,0);
  assert.equal(first.report.status,'advanced_numerical_plugin_execution_completed_unqualified');
  assert.equal(first.report.productionQualified,false);assert.equal(first.report.result.estimate.estimate,6);
  const w=first.report.workerReceipt;
  assert.equal(w.status,'os_sandbox_worker_passed');assert.equal(w.runtimeExecutableSnapshotHash,f.pythonHash);
  assert.equal(w.sourceWorkspaceManifestHashBefore,f.snapshot.manifestHash);assert.equal(w.workWorkspaceManifestHash,f.snapshot.manifestHash);
  assert.equal(w.environmentBom.runtime.packageClosure.basis,'content_manifest');
  assert.equal(w.environmentBom.runtime.packageClosure.observedPackageCount,0);
  assert.deepEqual(verifyEmpiricalEnvironmentBom(w.environmentBom),{valid:true,blockers:[]});
  const resultPath=path.join(f.outputDirectory,'result.json'), bytes=fs.readFileSync(resultPath), before=fs.lstatSync(resultPath,{bigint:true});
  const retry=actualRun(f);assert.equal(retry.exit,1);
  assert.deepEqual(retry.report.blockers,['advanced_numerical_plugin_result_preexists']);
  assert.equal(retry.report.requestHash,first.report.requestHash);assert.equal(retry.report.workerReceipt,undefined);
  assert.deepEqual(fs.readFileSync(resultPath),bytes);const after=fs.lstatSync(resultPath,{bigint:true});
  for(const k of ['ino','dev','mode','size','mtimeNs','ctimeNs'])assert.equal(before[k],after[k]);
  console.log('actual_original_cpu_run_and_replay',JSON.stringify({first,retry}));
});
test('numerical closure binds actual snapshots and preserves other runtime policies',context=>{
  const f=createActualCpuNumericalFixture();context.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const snapshot=inspectWorkspaceExecutionSnapshot(f.pluginRoot);
  const hint={basis:'signed-plugin-descriptor',identityHash:f.descriptor.runtime.packageClosureHash,manifestHash:f.descriptor.runtime.packageClosureHash,observedPackageCount:0};
  const args={runtimePackageClosure:hint,runtimeExecutableSnapshot:{hash:f.pythonHash},sourceExecutionSnapshot:snapshot,workExecutionSnapshot:snapshot};
  const first=observeAdvancedNumericalHostRuntimeClosure(args);assert.equal(first.basis,'content_manifest');
  const changed=observeAdvancedNumericalHostRuntimeClosure({...args,runtimeExecutableSnapshot:{hash:`sha256:${'9'.repeat(64)}`}});assert.notEqual(changed.manifestHash,first.manifestHash);
  assert.throws(()=>observeAdvancedNumericalHostRuntimeClosure({...args,workExecutionSnapshot:{...snapshot,manifestHash:`sha256:${'9'.repeat(64)}`}}),/observed_runtime_closure_invalid/);
  assert.throws(()=>observeAdvancedNumericalHostRuntimeClosure({...args,runtimeExecutableSnapshot:{hash:'invalid'}}),/observed_runtime_closure_invalid/);
  assert.throws(()=>observeAdvancedNumericalHostRuntimeClosure({...args,runtimePackageClosure:{...hint,manifestHash:`sha256:${'9'.repeat(64)}`}}),/observed_runtime_closure_invalid/);
  for(const supplied of [null,{basis:'unobserved'},{basis:'container_image_digest'}])assert.equal(observeAdvancedNumericalHostRuntimeClosure({runtimePackageClosure:supplied}),supplied);
});

test('BOM preparer owns observed closure and preserves non-closure error boundary', async () => {
  const { prepareWorkerEnvironmentBom, createWorkerEnvironmentBomPreparer, workerEnvironmentBomPreparationFailure, WorkerEnvironmentBomClosureError } = await import('../../paper-adapters/runtime/worker-environment-bom-binding.mjs');
  const invalid = { basis: 'signed-plugin-descriptor', identityHash: 'invalid' };
  assert.throws(() => prepareWorkerEnvironmentBom({ runtimePackageClosure: invalid }), (error) => error instanceof WorkerEnvironmentBomClosureError && error.message === 'worker_advanced_numerical_observed_runtime_closure_invalid');
  const availability = { available: true };
  const error = new Error('worker_advanced_numerical_observed_runtime_closure_invalid');
  assert.deepEqual(workerEnvironmentBomPreparationFailure(error, availability), {
    ok: false, status: 'os_sandbox_worker_blocked', blockers: [error.message], availability,
    isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false },
  });
  const prepare = createWorkerEnvironmentBomPreparer({ maximumTimeoutMs: 1, maximumMemoryBytes: 1, maximumCpuSeconds: 1, maximumPids: 1, maximumOutputBytes: 1, maximumCapturedBytes: 1 });
  assert.throws(() => prepare({ get timeoutMs() { throw new Error('actual_non_closure_error'); } }), (error) => !(error instanceof WorkerEnvironmentBomClosureError) && error.message === 'actual_non_closure_error');
});
