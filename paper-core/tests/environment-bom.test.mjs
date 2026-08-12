import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEmpiricalEnvironmentBom,
  environmentBomSupportsDeterministicCpuCache,
  verifyEmpiricalEnvironmentBom,
} from '../../paper-domain/automation/environment-bom-contract.mjs';
import {
  buildEnvironmentBoundEmpiricalCacheKey,
  evaluateEmpiricalCacheReproducibility,
} from '../../paper-domain/automation/empirical-cache-reproducibility-policy.mjs';
import { collectEmpiricalEnvironmentBom } from '../../paper-adapters/runtime/environment-bom-collector.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const digest = (label) => hashRecord('EnvironmentBomFixture', label);

function deterministicCpuBom(overrides = {}) {
  return buildEmpiricalEnvironmentBom({
    platform: {
      operatingSystem: 'linux', architecture: 'x64', kernelReleaseHash: digest('kernel'),
      machineIdentityHash: digest('machine'), machineIdentityObservation: 'fixture',
      cpu: { modelHash: digest('cpu-model'), flagsHash: digest('cpu-flags'), logicalProcessorCount: 8, observation: 'fixture' },
    },
    runtime: {
      type: 'container', identityHash: digest('runtime'), language: 'python', languageVersionHash: digest('python-version'),
      containerImageDigest: digest('image'), hostExecutableHash: null,
      packageClosure: { basis: 'container_image_digest', identityHash: digest('image'), manifestHash: null, observedPackageCount: 0 },
    },
    gpu: { required: false, status: 'not_required', deviceCount: 0 },
    numericRuntime: {
      threads: {
        OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1',
        BLIS_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1',
      }, dynamicThreadingDisabled: true,
      explicitSingleThreadPolicy: true, policyObservation: 'fixture',
      blasImplementationHash: digest('blas'), blasImplementationObservation: 'fixture',
      numericalLibraryBehaviorHash: digest('numeric-behavior'),
      numericalLibraryBehaviorObservation: 'fixture',
    },
    limits: { timeoutMs: 30_000, memoryBytes: 512 * 1024 * 1024, cpuSeconds: 30, maximumPids: 32, maximumOutputBytes: 32 * 1024 * 1024, maximumCapturedBytes: 4 * 1024 * 1024 },
    determinism: {
      classification: 'explicit_deterministic_cpu', explicitlyRequested: true, deterministicSeedRequired: true,
      deterministicSeedBound: true, threadPolicyVerified: true, gpuDeterminismVerified: false,
    },
    buildReproducibility: {
      status: 'runtime_content_identity_pinned_rebuild_not_verified', runtimeContentIdentityPinned: true,
      bitwiseRebuildVerified: false, definitionHash: digest('build-definition'), blockers: ['bitwise_rebuild_not_verified'],
    },
    observedClaims: ['container_image_content_digest', 'effective_resource_limits'],
    unobservedClaims: ['bitwise_runtime_image_rebuild'],
    ...overrides,
  });
}

test('EnvironmentBOM verifies exact observed scope without claiming bitwise rebuilds', () => {
  const bom = deterministicCpuBom();
  assert.deepEqual(verifyEmpiricalEnvironmentBom(bom), { valid: true, blockers: [] });
  assert.equal(bom.buildReproducibility.bitwiseRebuildVerified, false);
  assert.ok(bom.buildReproducibility.blockers.includes('bitwise_rebuild_not_verified'));
  assert.ok(bom.unobservedClaims.includes('bitwise_runtime_image_rebuild'));
  assert.equal(environmentBomSupportsDeterministicCpuCache(bom).cacheable, true);

  const tampered = structuredClone(bom);
  tampered.limits.memoryBytes += 1;
  assert.equal(verifyEmpiricalEnvironmentBom(tampered).valid, false);

  const leakedThreadValue = buildEmpiricalEnvironmentBom({
    ...structuredClone(bom),
    numericRuntime: { ...bom.numericRuntime, threads: { ...bom.numericRuntime.threads, LD_PRELOAD: '/secret/path' } },
  });
  assert.ok(verifyEmpiricalEnvironmentBom(leakedThreadValue).blockers.includes('environment_bom_numeric_runtime_policy_invalid'));

  const arbitraryClosure = buildEmpiricalEnvironmentBom({
    ...structuredClone(bom),
    runtime: { ...bom.runtime, packageClosure: { ...bom.runtime.packageClosure, identityHash: digest('unbound') } },
  });
  assert.ok(verifyEmpiricalEnvironmentBom(arbitraryClosure).blockers.includes('environment_bom_package_closure_binding_invalid'));
});

test('cache identity binds BOM, hardware, runtime closure, limits, and determinism', () => {
  const bom = deterministicCpuBom();
  const decision = evaluateEmpiricalCacheReproducibility({ environmentBom: bom });
  assert.equal(decision.cacheAllowed, true);
  const key = buildEnvironmentBoundEmpiricalCacheKey({ sourceMerkleHash: digest('source') }, decision);
  assert.match(key, /^sha256:[0-9a-f]{64}$/);

  const changed = deterministicCpuBom({
    limits: { ...bom.limits, memoryBytes: bom.limits.memoryBytes * 2 },
  });
  const changedDecision = evaluateEmpiricalCacheReproducibility({ environmentBom: changed });
  assert.notEqual(buildEnvironmentBoundEmpiricalCacheKey({ sourceMerkleHash: digest('source') }, changedDecision), key);
});

test('academic, GPU, nondeterministic, and unknown executions always bypass cache', () => {
  const cpu = deterministicCpuBom();
  assert.equal(evaluateEmpiricalCacheReproducibility({ environmentBom: cpu, academic: true }).cacheBypassReason, 'academic_execution_cache_forbidden');

  const gpu = deterministicCpuBom({
    gpu: {
      required: true, status: 'observed', deviceCount: 1, modelSetHash: digest('gpu-model'),
      computeCapabilitySetHash: digest('gpu-compute'), driverVersionHash: digest('gpu-driver'), runtimeVersionHash: digest('gpu-runtime'),
    },
    determinism: {
      classification: 'gpu_nondeterministic', explicitlyRequested: false, deterministicSeedRequired: false,
      deterministicSeedBound: true, threadPolicyVerified: true, gpuDeterminismVerified: false,
    },
  });
  assert.equal(evaluateEmpiricalCacheReproducibility({ environmentBom: gpu }).cacheBypassReason, 'gpu_execution_nondeterministic');

  for (const classification of ['nondeterministic', 'unknown']) {
    const candidate = deterministicCpuBom({
      determinism: {
        classification, explicitlyRequested: false, deterministicSeedRequired: false,
        deterministicSeedBound: false, threadPolicyVerified: false, gpuDeterminismVerified: false,
      },
    });
    assert.equal(evaluateEmpiricalCacheReproducibility({ environmentBom: candidate }).cacheAllowed, false);
  }
});

test('collector records machine and numeric behavior identities while leaving unavailable BLAS explicit', () => {
  const runtimeIdentityHash = digest('host-runtime');
  const bom = collectEmpiricalEnvironmentBom({
    executionIdentity: { runtimeType: 'host', runtimeIdentityHash },
    language: 'node', executable: process.execPath,
    determinismPolicy: 'explicit_deterministic_cpu', deterministicSeed: 42,
    resourceLimits: { timeoutMs: 1000, memoryBytes: 128 * 1024 * 1024, cpuSeconds: 1, maximumPids: 8, maximumOutputBytes: 1024, maximumCapturedBytes: 1024 },
    env: {
      OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1',
      BLIS_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1', OMP_DYNAMIC: 'FALSE', MKL_DYNAMIC: 'FALSE',
    },
  });
  assert.equal(verifyEmpiricalEnvironmentBom(bom).valid, true);
  assert.match(bom.runtime.hostExecutableHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(bom.runtime.packageClosure.basis, 'unobserved');
  assert.match(bom.platform.machineIdentityHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(bom.numericRuntime.numericalLibraryBehaviorHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(bom.observedClaims.includes('hashed_machine_identity'));
  assert.ok(bom.observedClaims.includes('numerical_library_behavior_identity'));
  assert.ok(bom.unobservedClaims.includes('runtime_package_closure'));
  assert.ok(bom.unobservedClaims.includes('blas_implementation_identity'));
  assert.equal(environmentBomSupportsDeterministicCpuCache(bom).cacheable, false);
});

test('collector binds runtime-attested BLAS and numerical behavior identities for container workers', () => {
  const blasImplementationHash = digest('container-blas');
  const numericalLibraryBehaviorHash = digest('container-numeric-behavior');
  const bom = collectEmpiricalEnvironmentBom({
    executionIdentity: {
      runtimeType: 'container',
      runtimeIdentityHash: digest('container-runtime'),
      digest: digest('container-image'),
      blasImplementationHash,
      numericalLibraryBehaviorHash,
    },
    language: 'python',
    executable: 'python3',
    resourceLimits: { timeoutMs: 1000, memoryBytes: 128 * 1024 * 1024, cpuSeconds: 1, maximumPids: 8, maximumOutputBytes: 1024, maximumCapturedBytes: 1024 },
  });
  assert.equal(verifyEmpiricalEnvironmentBom(bom).valid, true);
  assert.equal(bom.numericRuntime.blasImplementationHash, blasImplementationHash);
  assert.equal(bom.numericRuntime.numericalLibraryBehaviorHash, numericalLibraryBehaviorHash);
  assert.ok(bom.observedClaims.includes('blas_implementation_identity'));
  assert.ok(bom.observedClaims.includes('numerical_library_behavior_identity'));
});

test('required GPU observation fails closed when the device identity is unavailable', () => {
  const fakeSpawn = () => ({ status: 1, stdout: '', stderr: 'unavailable' });
  const bom = collectEmpiricalEnvironmentBom({
    executionIdentity: { runtimeType: 'container', runtimeIdentityHash: digest('runtime'), digest: digest('image') },
    language: 'python', executable: 'python3', requiresGpu: true,
    resourceLimits: { timeoutMs: 1000, memoryBytes: 128 * 1024 * 1024, cpuSeconds: 1, maximumPids: 8, maximumOutputBytes: 1024, maximumCapturedBytes: 1024 },
    spawnSyncImpl: fakeSpawn,
  });
  const verification = verifyEmpiricalEnvironmentBom(bom);
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('environment_bom_gpu_identity_invalid'));
  assert.ok(bom.unobservedClaims.includes('gpu_hardware_and_driver_identity'));
});
