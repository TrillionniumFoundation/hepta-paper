#!/usr/bin/env node
import fs from 'node:fs';
import { productionOracleProfile, evaluateProductionRecord } from '../../../oracle/production-record-hash-v1.mjs';

// stdin batch avoids operating-system argv limits for randomized differential
// corpora and retains raw JSON number/string lexemes rather than reparsing them
// into a different language's Value before reaching the actual Node functions.
if (process.argv[2] === '--batch') {
  const input = fs.readFileSync(0);
  if (!input.length || input.length > 16 * 1024 * 1024) throw new Error('oracle_input_limit');
  const request = JSON.parse(input);
  if (!Array.isArray(request.cases)) throw new Error('missing_cases');
  process.stdout.write(JSON.stringify({
    profile: productionOracleProfile(),
    results: request.cases.map((raw) => evaluateProductionRecord(raw, request.kind)),
  }));
} else {
  if (process.argv[2] === undefined) throw new Error('missing_JSON_argument');
  process.stdout.write(JSON.stringify({
    profile: productionOracleProfile(),
    ...evaluateProductionRecord(process.argv[2], process.argv[3]),
  }));
}
