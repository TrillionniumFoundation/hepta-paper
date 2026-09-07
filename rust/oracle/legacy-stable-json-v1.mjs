// Historical entry point now invokes the actual production serializer.
import fs from 'node:fs';
import { evaluateProductionRecord } from './production-record-hash-v1.mjs';

const input = fs.readFileSync(0);
if (input.length === 0 || input.length > 16 * 1024 * 1024) throw new Error('input_limit');
process.stdout.write(evaluateProductionRecord(input.toString('utf8')).canonical);
