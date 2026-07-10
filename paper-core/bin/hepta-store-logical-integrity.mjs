#!/usr/bin/env node
import path from 'node:path';
import { createReadOnlyPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { buildSqliteLogicalIntegrityReport } from '../src/sqlite-logical-integrity.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const dbPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(defaultPaperRuntimeRoot(), 'hepta-paper.sqlite');
const report = buildSqliteLogicalIntegrityReport({ dbPath, store: createReadOnlyPaperStore({ dbPath }) });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== 'sqlite_logical_integrity_verified') process.exitCode = 1;
