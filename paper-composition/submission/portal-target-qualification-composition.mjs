import {
  applyInspectedPortalTargetQualificationsToCoverage,
  executePortalTargetQualificationRegistryImport,
  inspectPortalTargetQualificationRegistry,
  planPortalTargetQualificationRegistryImport,
} from '../../paper-adapters/submission/portal-target-qualification-registry-repository.mjs';

export function inspectPortalTargetQualification(options = {}) {
  return inspectPortalTargetQualificationRegistry(options);
}

export function planPortalTargetQualificationImport(options = {}) {
  return planPortalTargetQualificationRegistryImport(options);
}

export function executePortalTargetQualificationImport(options = {}) {
  return executePortalTargetQualificationRegistryImport(options);
}

export function applyInspectedPortalTargetQualifications(
  coverage,
  inspection,
  options = {},
) {
  return applyInspectedPortalTargetQualificationsToCoverage(
    coverage,
    inspection,
    options,
  );
}
