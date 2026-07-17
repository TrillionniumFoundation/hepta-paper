const OMITTED_PUBLIC_KEYS = new Set([
  'authorityEvidence', 'casRoot', 'harnessDefinition', 'mainTex', 'manifestPath', 'objectPath',
  'oracle', 'privateDefinition', 'privateKey', 'privateSplitManifest', 'rawOracle',
  'runtimeExecutableInvocationPath', 'runtimeExecutableOverlayTarget', 'scopeRoot', 'secretKey',
  'sourceRoots', 'sourceWorkspace', 'stderr', 'stdout',
]);
const FORBIDDEN_SECRET_KEY = /^(?:apiKey|authToken|cookie|credential|password|privateKey|secret|secretKey|seedPhrase|token)$/i;

function isHostAbsolutePath(value) {
  const text = String(value || '').trim();
  if (/^file:\/\//i.test(text) || /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]/.test(text)) return true;
  if (!text.startsWith('/')) return false;
  return !['/datasets', '/output', '/work', '/workspace']
    .some((root) => text === root || text.startsWith(`${root}/`));
}

function isCryptographicEncodingLocation(location) {
  return location.endsWith('.signature')
    || /\.signatures\[\d+\]\.value$/.test(location);
}

export function portableResearchEvidenceValue(value, key = '', location = '$') {
  if (OMITTED_PUBLIC_KEYS.has(key) || FORBIDDEN_SECRET_KEY.test(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map((item, index) => portableResearchEvidenceValue(item, '', `${location}[${index}]`))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([childKey, child]) => [
        childKey,
        portableResearchEvidenceValue(child, childKey, `${location}.${childKey}`),
      ])
      .filter(([, child]) => child !== undefined));
  }
  if (typeof value === 'string' && isHostAbsolutePath(value)
    && !isCryptographicEncodingLocation(location)) return 'redacted:host-absolute-path';
  return value;
}

export function researchEvidencePublicationBlockers(value, location = '$', blockers = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => researchEvidencePublicationBlockers(item, `${location}[${index}]`, blockers));
    return blockers;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_SECRET_KEY.test(key) || OMITTED_PUBLIC_KEYS.has(key)) blockers.push(`private_field:${location}.${key}`);
      researchEvidencePublicationBlockers(child, `${location}.${key}`, blockers);
    }
    return blockers;
  }
  if (typeof value === 'string' && isHostAbsolutePath(value)
    && !isCryptographicEncodingLocation(location)) {
    blockers.push(`host_absolute_path:${location}`);
  }
  return blockers;
}

export function portableResearchEvidenceDocument(kind, sourceHashField, sourceHash, document) {
  return Object.freeze({
    version: 1,
    kind,
    [sourceHashField]: sourceHash,
    redactionPolicy: 'public-research-evidence-no-host-paths-no-private-authority-v1',
    document: portableResearchEvidenceValue(document),
  });
}
