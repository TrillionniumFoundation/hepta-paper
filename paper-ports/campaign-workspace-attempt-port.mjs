export function assertCampaignWorkspaceAttemptPort(port) {
  for (const method of ['prepare', 'describe', 'integrate']) {
    if (typeof port?.[method] !== 'function') throw new Error(`CampaignWorkspaceAttemptPort.${method} is required`);
  }
  return port;
}
