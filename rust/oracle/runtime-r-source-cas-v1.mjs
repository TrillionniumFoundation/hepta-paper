import fs from 'node:fs';
import { inspectRRuntimeSourceCas } from '../../paper-composition/automation/r-runtime-source-cas-composition.mjs';

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({
  profile: { node: process.version },
  results: requests.map((request) => {
    try {
      return { ok: true, value: inspectRRuntimeSourceCas(request) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }),
}));
