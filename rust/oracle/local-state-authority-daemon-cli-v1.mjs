// Argument-only comparisons: every successful fixture requests help, so this
// oracle never starts an authority or reads a configured private key.
import fs from 'node:fs';
import { runHeptaPaperStateAuthorityDaemon } from '../../paper-core/bin/hepta-paper-state-authority-daemon.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
productionOracleProfile();
const rows = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = [];
for (const argv of rows) {
  if (!argv.some(v => v === '--help' || v.startsWith('--help='))) throw Error('help_fixture_required');
  try { results.push({ ok: true, value: await runHeptaPaperStateAuthorityDaemon({ argv }) }); }
  catch (error) { results.push({ ok: false, error: error.message }); }
}
process.stdout.write(`${JSON.stringify(results)}\n`);
