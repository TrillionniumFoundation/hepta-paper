#!/usr/bin/env node
// Fixed business schema from original exports; no external action or privilege.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as schema from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-schema.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sources = [
  'paper-adapters/automation/campaign-one-shot-attempt-journal-schema.mjs',
  'paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs',
  'paper-composition/automation/autonomous-research-one-shot-campaign-attempt-state-machine.mjs',
  'paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs',
];
process.stdout.write(JSON.stringify({
  version: 1, kind: 'NativeOneShotJournalMutationContract',
  schemaStatements: schema.CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_STATEMENTS,
  schemaContractId: schema.CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_ID,
  schemaContractHash: schema.CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_HASH,
  sourceHashes: Object.fromEntries(sources.map(relative => [relative,
    createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')])),
}, null, 2) + '\n');

