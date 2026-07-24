export function assertHotCrpClientPort(value) {
  if (value?.kind !== 'HotCrpClientPort'
    || value.networkPolicy !== 'hotcrp-only'
    || value.credentialIsolation !== true
    || typeof value.probe !== 'function'
    || typeof value.getSubmissionSchema !== 'function'
    || typeof value.savePaper !== 'function'
    || typeof value.getPaper !== 'function') {
    throw new Error('hotcrp_client_port_invalid');
  }
  return value;
}
