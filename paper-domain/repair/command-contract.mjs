const SAFE_APPLY_PREFIX = 'hepta-paper://repair.safe-apply/v1';

export function buildSafeApplyPlanContract(patchId) {
  const normalized = Number.parseInt(String(patchId || ''), 10);
  if (!Number.isInteger(normalized) || normalized <= 0) return '';
  return `${SAFE_APPLY_PREFIX}?patch_id=${normalized}`;
}

export function parseSafeApplyPlanContract(value) {
  try {
    const url = new URL(String(value || ''));
    if (`${url.protocol}//${url.host}${url.pathname}` !== SAFE_APPLY_PREFIX) return null;
    const rawPatchId = url.searchParams.get('patch_id') || '';
    const patchId = Number.parseInt(rawPatchId, 10);
    return /^[1-9]\d*$/.test(rawPatchId) && [...url.searchParams.keys()].length === 1 && Number.isInteger(patchId) && patchId > 0
      ? Object.freeze({ version: 1, kind: 'RepairSafeApplyPlanContract', patchId, executeAuthority: false })
      : null;
  } catch {
    return null;
  }
}
