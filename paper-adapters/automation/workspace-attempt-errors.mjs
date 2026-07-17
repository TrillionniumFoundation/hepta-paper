export function workspaceAttemptIntegrationError(code, { retryable = false, detail = null } = {}) {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  error.retryable = retryable;
  return error;
}
