#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMultiLanguageEmpiricalExecutor, AUTOMATION_RUNTIME_IMAGES } from '../../paper-composition/bootstrap/operator-automation-composition.mjs';
import { createOsSandboxedWorkerRunner, directoryMerkleHash } from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-smoke-'));
const source = path.join(root, 'source');
const output = path.join(root, 'output');
const rAssetRoot = path.resolve(process.env.HEPTA_R_ASSET_ROOT || '/data/home-data/hepta-paper-assets/drafts/NDU_Nature_work/ds004323_probe/code_extract/py_vgdl');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(output, { recursive: true });
try {
  fs.writeFileSync(path.join(source, 'cpu.py'), `import json,os,random,numpy as np,pandas as pd
from sklearn.linear_model import LinearRegression
random.seed(42); np.random.seed(42)
x=np.arange(20,dtype=float).reshape(-1,1); y=3*x[:,0]+2
model=LinearRegression().fit(x,y)
output=os.environ["HEPTA_OUTPUT_DIR"]
pd.DataFrame({"metric":["coefficient","intercept"],"value":[float(model.coef_[0]),float(model.intercept_)]}).to_csv(os.path.join(output,"results.csv"),index=False)
json.dump({"coefficient":float(model.coef_[0]),"intercept":float(model.intercept_)},open(os.path.join(output,"results.json"),"w"),sort_keys=True)
`);
  fs.writeFileSync(path.join(source, 'gpu.cu'), `#include <cuda_runtime.h>
#include <cstdlib>
#include <fstream>
#include <string>
__global__ void square(const float* x, float* y, int n){int i=blockIdx.x*blockDim.x+threadIdx.x;if(i<n)y[i]=x[i]*x[i];}
int main(){const int n=1024;float h[n];for(int i=0;i<n;i++)h[i]=float(i);float *x,*y;cudaMalloc(&x,sizeof(h));cudaMalloc(&y,sizeof(h));cudaMemcpy(x,h,sizeof(h),cudaMemcpyHostToDevice);square<<<4,256>>>(x,y,n);cudaDeviceSynchronize();cudaMemcpy(h,y,sizeof(h),cudaMemcpyDeviceToHost);cudaFree(x);cudaFree(y);if(h[17]!=289.0f)return 2;const char* output=std::getenv("HEPTA_OUTPUT_DIR");if(!output)return 3;std::ofstream out(std::string(output)+"/results.json");out<<"{\\\"cuda_square_17\\\":"<<h[17]<<"}\\n";return 0;}
`);
  fs.writeFileSync(path.join(source, 'gpu.py'), `import json,os
import cupy as cp
x=cp.arange(1024,dtype=cp.float32)
y=x*x
value=float(cp.asnumpy(y[17]))
assert value == 289.0
output=os.environ["HEPTA_OUTPUT_DIR"]
json.dump({"cupy_square_17":value,"device":int(cp.cuda.runtime.getDevice())},open(os.path.join(output,"results.json"),"w"),sort_keys=True)
open(os.path.join(output,"results.csv"),"w").write(f"metric,value\\ncupy_square_17,{value}\\n")
`);
  const gpuBinary = path.join(source, 'gpu-bench');
  const compile = spawnSync('nvcc', ['-O2', path.join(source, 'gpu.cu'), '-o', gpuBinary], { encoding: 'utf8', timeout: 120000 });
  if (compile.status !== 0) throw new Error(`CUDA fixture compilation failed: ${compile.stderr || compile.stdout}`);
  fs.writeFileSync(path.join(source, 'actual_asset.R'), `source('/datasets/ndu/TBRL_functions.R')
value <- remove_string_from_name('expt_bait')
stopifnot(identical(value, 'bait'))
output_dir <- Sys.getenv('HEPTA_OUTPUT_DIR')
stopifnot(nzchar(output_dir))
writeLines('{"function_result":1}', file.path(output_dir, 'results.json'))
write.csv(data.frame(metric='function_result', value=1), file.path(output_dir, 'results.csv'), row.names=FALSE, quote=FALSE)
`);
  const images = [AUTOMATION_RUNTIME_IMAGES.python.image, AUTOMATION_RUNTIME_IMAGES.pythonGpu.image, AUTOMATION_RUNTIME_IMAGES.r.image];
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: [gpuBinary],
    allowedRoots: [source],
    allowedOutputRoots: [output],
    allowedDatasetRoots: [rAssetRoot],
    allowedContainerImages: images,
    allowGpu: true,
    maximumTimeoutMs: 10 * 60 * 1000,
    maximumMemoryBytes: 6 * 1024 * 1024 * 1024,
    maximumCpuSeconds: 600,
  });
  const run = ({ language, entrypoint, image, requiresGpu = false, datasetMounts = [] }, suffix) => createMultiLanguageEmpiricalExecutor({ workerRunner: runner, runtimeImages: { [language]: image } }).execute({
    language,
    entrypoint,
    cwd: source,
    sourceRoot: source,
    outputDirectory: path.join(output, suffix),
    outputPaths: ['results.json', 'results.csv'],
    requireSeparateOutputRoot: true,
    timeoutMs: 10 * 60 * 1000,
    requiresGpu,
    datasetMounts,
    env: { HEPTA_SEED: '42', HEPTA_OUTPUT_DIR: '/output', PYTHONHASHSEED: '42', OMP_NUM_THREADS: '1' },
    memoryBytes: requiresGpu ? 6 * 1024 * 1024 * 1024 : 3 * 1024 * 1024 * 1024,
    cpuSeconds: 600,
    cachePolicy: 'bypass',
  });
  const specs = [
    { name: 'pythonCpu', language: 'python', entrypoint: 'cpu.py', image: AUTOMATION_RUNTIME_IMAGES.python },
    { name: 'pythonGpu', language: 'python', entrypoint: 'gpu.py', image: AUTOMATION_RUNTIME_IMAGES.pythonGpu, requiresGpu: true },
    { name: 'rActualAsset', language: 'r', entrypoint: 'actual_asset.R', image: AUTOMATION_RUNTIME_IMAGES.r, datasetMounts: [{ name: 'ndu', source: rAssetRoot, readOnly: true, manifestHash: directoryMerkleHash(rAssetRoot), licenseId: 'LicenseRef-Internal-Research', operatorAuthorizationHash: 'sha256:7aab397a9266d35a4061f97e2d0405a2bbc79ee55ca4829ffc82179317a0267a' }] },
  ];
  const receipts = {};
  const reproducible = {};
  for (const spec of specs) {
    const first = run(spec, `${spec.name}-first`);
    const second = run(spec, `${spec.name}-second`);
    receipts[spec.name] = first;
    reproducible[spec.name] = first.status === 'empirical_execution_completed'
      && second.status === 'empirical_execution_completed'
      && JSON.stringify(first.artifacts.map((item) => [item.path, item.sha256])) === JSON.stringify(second.artifacts.map((item) => [item.path, item.sha256]));
  }
  const runCuda = (suffix) => runner.run({ executable: gpuBinary, args: [], cwd: source, sourceRoot: source, outputDirectory: path.join(output, suffix), outputPaths: ['results.json'], timeoutMs: 120000, requiresGpu: true, env: { HEPTA_OUTPUT_DIR: '/output' }, memoryBytes: 1024 * 1024 * 1024, cpuSeconds: 120, containerImage: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image, containerExecutable: './gpu-bench' });
  const cudaFirst = runCuda('cudaGpu-first');
  const cudaSecond = runCuda('cudaGpu-second');
  receipts.cudaGpu = { ...cudaFirst, status: cudaFirst.ok ? 'empirical_execution_completed' : 'empirical_execution_failed' };
  reproducible.cudaGpu = cudaFirst.ok && cudaSecond.ok && JSON.stringify(cudaFirst.artifacts.map((item) => [item.path, item.sha256])) === JSON.stringify(cudaSecond.artifacts.map((item) => [item.path, item.sha256]));
  const passed = Object.values(receipts).every((receipt) => receipt.status === 'empirical_execution_completed') && Object.values(reproducible).every(Boolean);
  process.stdout.write(`${JSON.stringify({ status: passed ? 'automation_runtime_smoke_passed' : 'automation_runtime_smoke_failed', passed, reproducible, receipts, externalActionPerformed: false }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
