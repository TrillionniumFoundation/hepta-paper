// Differential oracle executes original Node implementations; no Rust runtime
// dependency. CLI calls also verify report-before-nonzero-gate behavior.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JOURNAL_PROFILES } from '../../paper-domain/journal/journal-registry.mjs';
import { buildJournalConnectorCoverage } from '../../paper-domain/submission/journal-connector-coverage.mjs';
import { buildJournalSubmissionTargetRegistry } from '../../paper-domain/submission/journal-submission-target-registry.mjs';
import { SUBMISSION_CONNECTOR_FAMILY_REGISTRY } from '../../paper-domain/submission/submission-connector-family-registry.mjs';
import { inspectPortalTargetQualificationRegistry, applyInspectedPortalTargetQualificationsToCoverage } from '../../paper-adapters/submission/portal-target-qualification-registry-repository.mjs';
import { qualificationFixtures } from './journal-qualification-fixtures-v1.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (key.startsWith('HEPTA_PORTAL_TARGET_QUALIFICATION_')) delete environment[key];
}
const results = requests.map((request) => {
  try {
    if (request.operation === 'qualification-fixtures') return { ok: true, value: qualificationFixtures(request.now ? Date.parse(request.now) : Date.now()) };
    if (request.operation === 'qualification-inspect') {
      const inspection = inspectPortalTargetQualificationRegistry({ ...request.options, now: new Date(request.options.now) });
      let applied = null;
      if (request.apply) {
        try {
          applied = { ok: true, value: applyInspectedPortalTargetQualificationsToCoverage(buildJournalConnectorCoverage(), inspection, { now: new Date(request.applyNow || request.options.now) }) };
        } catch (error) { applied = { ok: false, error: error.message }; }
      }
      return { ok: true, value: inspection, applied };
    }
    if (request.operation === 'profiles') return { ok: true, value: JOURNAL_PROFILES };
    if (request.operation === 'families') return { ok: true, value: SUBMISSION_CONNECTOR_FAMILY_REGISTRY };
    if (request.operation === 'cli') {
      const child = spawnSync(process.execPath, ['paper-core/bin/journal-connector-coverage.mjs', ...request.argv], {
        cwd: root, encoding: 'utf8', env: environment,
      });
      if (child.stdout.trim()) return { ok: true, value: JSON.parse(child.stdout), exitCode: child.status };
      const message = child.stderr.match(/\nError: ([^\n]+)/)?.[1];
      if (!message) throw new Error(`oracle_unrecognized_cli_error:${child.stderr}`);
      return { ok: false, error: message };
    }
    const profiles = Object.hasOwn(request, 'profiles') ? request.profiles : structuredClone(JOURNAL_PROFILES);
    if (request.operation === 'targets') return { ok: true, value: buildJournalSubmissionTargetRegistry({ profiles }) };
    if (request.operation === 'coverage') return { ok: true, value: buildJournalConnectorCoverage({ profiles }) };
    throw new Error(`oracle_unknown_operation:${request.operation}`);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
process.stdout.write(JSON.stringify({ profile: productionOracleProfile(), results }));
