import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  environmentBomSupportsDeterministicCpuCache,
  verifyEmpiricalEnvironmentBom,
} from './environment-bom-contract.mjs';

export function evaluateEmpiricalCacheReproducibility({ environmentBom, academic = false, cachePolicy = 'default' } = {}) {
  const verification = verifyEmpiricalEnvironmentBom(environmentBom);
  let cacheBypassReason = null;
  if (cachePolicy === 'bypass') cacheBypassReason = 'cache_policy_bypass';
  else if (academic) cacheBypassReason = 'academic_execution_cache_forbidden';
  else if (!verification.valid) cacheBypassReason = 'environment_bom_invalid';
  else if (environmentBom.gpu.required) cacheBypassReason = 'gpu_execution_nondeterministic';
  else if (environmentBom.determinism.classification === 'nondeterministic') cacheBypassReason = 'nondeterministic_execution';
  else if (environmentBom.determinism.classification !== 'explicit_deterministic_cpu') cacheBypassReason = 'determinism_policy_unknown';
  const support = environmentBomSupportsDeterministicCpuCache(environmentBom);
  if (!cacheBypassReason && !support.cacheable) cacheBypassReason = 'environment_bom_not_cacheable';
  const payload = Object.freeze({
    version: 1,
    kind: 'EmpiricalCacheReproducibilityDecision',
    environmentBomHash: environmentBom?.environmentBomHash || null,
    resourceLimitsHash: environmentBom?.limits?.resourceLimitsHash || null,
    hardwareIdentityHash: environmentBom?.platform?.hardwareIdentityHash || null,
    runtimeClosureHash: environmentBom?.runtime?.runtimeClosureHash || null,
    determinismPolicyHash: environmentBom?.determinism?.determinismPolicyHash || null,
    academic: academic === true,
    requestedPolicy: String(cachePolicy || 'default'),
    cacheAllowed: cacheBypassReason === null,
    cacheBypassReason,
    blockers: Object.freeze([...new Set([...verification.blockers, ...support.blockers])]),
  });
  return Object.freeze({
    ...payload,
    cacheReproducibilityDecisionHash: hashRecord('EmpiricalCacheReproducibilityDecision', payload),
  });
}

export function buildEnvironmentBoundEmpiricalCacheKey(baseDescriptor, decision) {
  if (!decision?.cacheAllowed || !decision.environmentBomHash) return null;
  return hashRecord('EnvironmentBoundEmpiricalExecutionCacheKey', {
    version: 1,
    baseDescriptor,
    environmentBomHash: decision.environmentBomHash,
    resourceLimitsHash: decision.resourceLimitsHash,
    hardwareIdentityHash: decision.hardwareIdentityHash,
    runtimeClosureHash: decision.runtimeClosureHash,
    determinismPolicyHash: decision.determinismPolicyHash,
    cacheReproducibilityDecisionHash: decision.cacheReproducibilityDecisionHash,
  });
}

export function verifyEmpiricalCacheReproducibilityDecision(decision, environmentBom) {
  if (!decision || decision.version !== 1 || decision.kind !== 'EmpiricalCacheReproducibilityDecision'
    || decision.environmentBomHash !== environmentBom?.environmentBomHash) return false;
  const expected = evaluateEmpiricalCacheReproducibility({
    environmentBom,
    academic: decision.academic,
    cachePolicy: decision.requestedPolicy,
  });
  return expected.cacheReproducibilityDecisionHash === decision.cacheReproducibilityDecisionHash
    && JSON.stringify(expected) === JSON.stringify(decision);
}
