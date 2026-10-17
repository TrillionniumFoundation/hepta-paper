import fs from 'node:fs';
import { buildReleaseTrustLayerGate } from '../../paper-domain/governance/release-trust-layer-gate.mjs';

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({
  profile: { node: process.version },
  results: requests.map((request) => {
    try {
      return { ok: true, value: buildReleaseTrustLayerGate({
        releaseCommit: request.releaseCommit,
        capabilityCount: request.capabilityCount,
        implementationVerified: request.implementationVerified,
        releaseBoundConformanceVerified: request.releaseBoundConformanceVerified,
        independentProductionOperationalVerified: request.independentProductionOperationalVerified,
      }) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }),
}));

