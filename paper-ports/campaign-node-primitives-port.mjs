function assertMethods(port, name, methods) {
  for (const method of methods) {
    if (typeof port?.[method] !== 'function') throw new Error(`${name}.${method} is required`);
  }
  return port;
}

export function assertCampaignWorkspacePrimitivesPort(port) {
  return assertMethods(port, 'CampaignWorkspacePrimitivesPort', [
    'describe',
    'findEmpiricalEntrypoint',
    'readTextIfPresent',
    'hashFile',
    'outputDirectory',
    'materializeArtifacts',
    'prepareEmpiricalAssertionAuthority',
    'renderTrustedAutonomousManuscript',
    'finalizeTheoremSpecification',
    'readTheoremSpecification',
  ]);
}

export function assertCampaignAgentPrimitivesPort(port) {
  return assertMethods(port, 'CampaignAgentPrimitivesPort', [
    'execute',
    'buildFormalReviewEnvelope',
    'executeFormalProofSearchOperations',
  ]);
}

export function assertCampaignEmpiricalPrimitivesPort(port) {
  return assertMethods(port, 'CampaignEmpiricalPrimitivesPort', [
    'execute',
    'evaluateDatasetConsumption',
    'sanitizeLatex',
    'buildResultContract',
    'writeEvidenceBundle',
  ]);
}

export function assertCampaignQualityPrimitivesPort(port) {
  return assertMethods(port, 'CampaignQualityPrimitivesPort', [
    'theoremReadiness',
    'manuscriptQuality',
    'recordRevision',
  ]);
}

export function assertCampaignReleasePrimitivesPort(port) {
  return assertMethods(port, 'CampaignReleasePrimitivesPort', [
    'verifyFormal',
    'verifyResearch',
    'packageRelease',
  ]);
}

export function assertCampaignNodePrimitivesPort(port) {
  return Object.freeze({
    workspace: assertCampaignWorkspacePrimitivesPort(port?.workspace),
    agent: assertCampaignAgentPrimitivesPort(port?.agent),
    empirical: assertCampaignEmpiricalPrimitivesPort(port?.empirical),
    quality: assertCampaignQualityPrimitivesPort(port?.quality),
    release: assertCampaignReleasePrimitivesPort(port?.release),
  });
}
