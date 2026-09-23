const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export const AUTONOMOUS_RESEARCH_RESIDENT_REACTIVATION_EXIT_CODE = 75;

export class ResidentReactivationRequired extends Error {
  constructor({
    source,
    reason,
    startupIdentityHash,
    observedIdentityHash,
    receiptHash = null,
  } = {}) {
    if (typeof source !== 'string' || !source
      || typeof reason !== 'string' || !reason
      || !SHA256.test(String(startupIdentityHash || ''))
      || !SHA256.test(String(observedIdentityHash || ''))
      || startupIdentityHash === observedIdentityHash
      || (receiptHash !== null && !SHA256.test(String(receiptHash || '')))) {
      throw new Error('autonomous_research_resident_reactivation_request_invalid');
    }
    super(`${reason}:source=${source}:startup=${startupIdentityHash}:observed=${
      observedIdentityHash}`);
    this.name = 'ResidentReactivationRequired';
    this.code = 'AUTONOMOUS_RESEARCH_RESIDENT_REACTIVATION_REQUIRED';
    this.status = 'autonomous_research_resident_reactivation_required';
    this.residentReactivationRequired = true;
    this.exitCode = AUTONOMOUS_RESEARCH_RESIDENT_REACTIVATION_EXIT_CODE;
    this.source = source;
    this.reason = reason;
    this.startupIdentityHash = startupIdentityHash;
    this.observedIdentityHash = observedIdentityHash;
    this.receiptHash = receiptHash;
  }
}

export function isResidentReactivationRequired(error) {
  return error instanceof ResidentReactivationRequired
    && error.name === 'ResidentReactivationRequired'
    && error.code === 'AUTONOMOUS_RESEARCH_RESIDENT_REACTIVATION_REQUIRED'
    && error.status === 'autonomous_research_resident_reactivation_required'
    && error.residentReactivationRequired === true
    && error.exitCode === AUTONOMOUS_RESEARCH_RESIDENT_REACTIVATION_EXIT_CODE;
}

export function autonomousResearchResidentExitCode(error, fallback = 1) {
  return isResidentReactivationRequired(error)
    ? AUTONOMOUS_RESEARCH_RESIDENT_REACTIVATION_EXIT_CODE : fallback;
}

export function autonomousResearchResidentReactivationStopReason(error) {
  if (!isResidentReactivationRequired(error)) return null;
  return [error.status, `source=${error.source}`, `reason=${error.reason}`,
    `startup=${error.startupIdentityHash}`, `observed=${error.observedIdentityHash}`,
  ].join(':');
}
