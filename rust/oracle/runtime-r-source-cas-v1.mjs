import fs from 'node:fs';
import { composeRRuntimeSourceCasAcquisition, inspectRRuntimeSourceCas } from '../../paper-composition/automation/r-runtime-source-cas-composition.mjs';

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({
  profile: { node: process.version },
  results: await Promise.all(requests.map(async (request) => {
    try {
      return { ok: true, value: request.action === 'acquire'
        ? await composeRRuntimeSourceCasAcquisition({ ...request,
          archiveTransport: { kind: 'RRuntimeSourceArchiveTransport', version: 1,
            async fetchArchive() { throw new Error('network_disabled_in_seed_oracle'); } } })
        : inspectRRuntimeSourceCas(request) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })),
}));
