import fs from 'node:fs';
import path from 'node:path';

import {
  createCanonicalCupyPdePoisson2dExecutor,
} from '../../paper-adapters/research-verify/canonical-cupy-pde-poisson-2d-executor.mjs';
import {
  runProcessIsolatedPdePoisson2dIndependentCpuOracle,
  verifyProcessIsolatedPdePoisson2dCpuOracleAgainstArtifacts,
} from '../../paper-adapters/research-verify/process-isolated-pde-poisson-2d-independent-cpu-oracle.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function preparePrivateOutputRoot(selected) {
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) {
    throw new Error('pde_poisson_2d_gpu_composition_output_root_absolute_required');
  }
  const root = path.normalize(selected);
  if (root === path.parse(root).root) {
    throw new Error('pde_poisson_2d_gpu_composition_output_root_unsafe');
  }
  if (!fs.existsSync(root)) {
    const parent = path.dirname(root);
    const parentIdentity = fs.lstatSync(parent);
    if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()
      || fs.realpathSync.native(parent) !== parent) {
      throw new Error('pde_poisson_2d_gpu_composition_output_parent_unsafe');
    }
    fs.mkdirSync(root, { mode: 0o700 });
  }
  const identity = fs.lstatSync(root);
  if (!identity.isDirectory() || identity.isSymbolicLink()
    || fs.realpathSync.native(root) !== root
    || (typeof process.geteuid === 'function' && identity.uid !== process.geteuid())
    || (identity.mode & 0o077) !== 0) {
    throw new Error('pde_poisson_2d_gpu_composition_output_root_unsafe');
  }
  return root;
}

export function composeCanonicalPdePoisson2dGpuSolver({
  outputRoot,
  runtimeRoot,
  ...limits
} = {}) {
  const selectedOutputRoot = preparePrivateOutputRoot(outputRoot);
  const gpuExecutor = createCanonicalCupyPdePoisson2dExecutor({
    outputRoot: selectedOutputRoot,
    runtimeRoot,
    ...limits,
  });
  return Object.freeze({
    version: 1,
    kind: 'CanonicalPdePoisson2dGpuComposition',
    gpuExecutor,
    async executeAndVerify(input = {}) {
      const gpuReceipt = await gpuExecutor.execute(input);
      if (gpuReceipt.status
        !== 'canonical_cupy_pde_poisson_2d_executed_pending_cpu_oracle') {
        return Object.freeze({
          version: 1,
          kind: 'CanonicalPdePoisson2dGpuScientificReceipt',
          status: 'canonical_pde_poisson_2d_gpu_scientific_execution_blocked',
          productionPromotionEligible: false,
          gpuReceipt,
          cpuOracleAssurance: null,
          blockers: gpuReceipt.blockers,
        });
      }
      const cpuOracleAssurance =
        runProcessIsolatedPdePoisson2dIndependentCpuOracle({
          artifactRoot: gpuReceipt.outputDirectory,
          artifactManifest: gpuReceipt.artifactManifest,
          producerSpecification: gpuReceipt.producerSpecification,
          absoluteDeadlineEpochMs: input.absoluteDeadlineEpochMs,
        });
      const verified = verifyProcessIsolatedPdePoisson2dCpuOracleAgainstArtifacts(
        cpuOracleAssurance,
        {
          artifactRoot: gpuReceipt.outputDirectory,
          artifactManifest: gpuReceipt.artifactManifest,
          producerSpecification: gpuReceipt.producerSpecification,
        },
      );
      const blockers = Object.freeze(verified ? [
        'pde_poisson_2d_external_operational_and_conformance_authority_required',
      ] : ['pde_poisson_2d_independent_cpu_oracle_invalid']);
      const payload = {
        version: 1,
        kind: 'CanonicalPdePoisson2dGpuScientificReceipt',
        status: verified
          ? 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable'
          : 'canonical_pde_poisson_2d_gpu_scientific_execution_blocked',
        gpuReceipt,
        cpuOracleAssurance,
        productionPromotionEligible: false,
        blockers,
      };
      return Object.freeze({
        ...payload,
        canonicalPdePoisson2dGpuScientificReceiptHash:
          hashRecord('CanonicalPdePoisson2dGpuScientificReceipt', payload),
      });
    },
  });
}
