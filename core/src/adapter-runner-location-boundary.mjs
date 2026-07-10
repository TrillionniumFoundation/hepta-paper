import { normalizeText } from './contracts.mjs';

export const ADAPTER_RUNNER_LOCATION_BOUNDARY_BLOCKER_CODE = 'runner_location_must_be_external_workspace';

const CORE_PACKAGE_SEGMENT = 'design-production-core';

export function normalizeAdapterRunnerLocation(value) {
  return normalizeText(value || '').replace(/\\/g, '/');
}

export function isExternalWorkspaceRunnerLocation(value) {
  const location = normalizeAdapterRunnerLocation(value);
  if (!location) return false;
  const segments = location.split('/').filter((segment) => segment && segment !== '.');
  if (segments[0] !== '..') return false;
  const targetSegments = segments.filter((segment) => segment !== '..');
  if (!targetSegments.length) return false;
  return !targetSegments.includes(CORE_PACKAGE_SEGMENT);
}
