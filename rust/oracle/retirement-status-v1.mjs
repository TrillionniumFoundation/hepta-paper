import fs from 'node:fs';
import { inspectLegacyArchiveRetirement } from '../../paper-core/bin/retire-legacy-archive.mjs';

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({
  profile: { node: process.version },
  results: requests.map((request) => {
    try {
      return { ok: true, value: inspectLegacyArchiveRetirement(request) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }),
}));
