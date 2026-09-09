// Source-bound oracle. Never duplicate stable(), stableStringify(), digest(), or
// hashRecord() here: tests must exercise the same exports used by production.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { stableStringify, digest, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const source = new URL('../../workflow-kernel/record-hash.mjs', import.meta.url);
export function productionOracleProfile() {
  return {
    profile: 'node22.23.1-icu78.2-cldr48-en-US-v1',
    node: process.version,
    icu: process.versions.icu,
    cldr: process.versions.cldr,
    unicode: process.versions.unicode,
    collator: new Intl.Collator().resolvedOptions(),
    source_sha256: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')}`,
  };
}

export function evaluateProductionRecord(raw, kind = 'CompatibilityQualification') {
  const value = JSON.parse(raw);
  return {
    canonical: stableStringify(value),
    digest: digest(value),
    record_hash: hashRecord(kind, value),
  };
}
