export function assertSubmissionBrowserSessionPort(value) {
  if (value?.kind !== 'SubmissionBrowserSessionPort'
    || value.browserEngine !== 'playwright'
    || value.networkPolicy !== 'provider-scoped'
    || value.credentialIsolation !== true
    || value.selectorPolicy !== 'semantic-versioned-fail-closed'
    || value.captchaBypassPermitted !== false
    || value.finalCommitAutomationPermitted !== false
    || typeof value.probe !== 'function'
    || typeof value.discoverForm !== 'function'
    || typeof value.createDraft !== 'function'
    || typeof value.fillFields !== 'function'
    || typeof value.uploadFiles !== 'function'
    || typeof value.capturePreview !== 'function'
    || typeof value.getStatus !== 'function'
    || typeof value.reconcile !== 'function'
    || typeof value.handoffToHuman !== 'function') {
    throw new Error('submission_browser_session_port_invalid');
  }
  return value;
}
