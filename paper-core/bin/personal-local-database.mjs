#!/usr/bin/env node
import path from 'node:path';

import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import {
  clearPersonalDatabaseEmptySidecars,
  createPersonalDatabaseBackup,
  inspectPersonalLocalDatabase,
  recordPersonalDatabaseAntiRollback,
  restoreDrillPersonalDatabase,
} from '../../paper-adapters/persistence/personal-local-database-readiness.mjs';

function usage() {
  return [
    'Usage: personal-local-database --action status|record|backup|restore-drill|clear-empty-sidecars [options]',
    '',
    '  status                         Read-only local schema/lease/anti-rollback inspection.',
    '  record                        Record the current consistent database head.',
    '  backup                        Create a local content-addressed backup receipt.',
    '  restore-drill                 Verify a backup in a temporary restore root.',
    '  clear-empty-sidecars          Remove only proven-stale SQLite sidecars.',
    '  --runtime-root PATH           Runtime root (default workspace runtime).',
    '  --backup PATH                 Backup SQLite path for restore/sidecar actions.',
    '  --allow-legacy-schema        Permit backup before schema 25 migration.',
    '  --allow-stale-shared-memory  Explicitly permit removal of stale -shm.',
  ].join('\n');
}

function parse(argv) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['help', 'allow-legacy-schema', 'allow-stale-shared-memory'],
    valueFlags: ['action', 'runtime-root', 'backup'],
    positional: false,
  });
  if (args.help) return Object.freeze({ help: true });
  const action = args.action || 'status';
  if (!['status', 'record', 'backup', 'restore-drill', 'clear-empty-sidecars'].includes(action)) {
    throw new Error(`personal_local_database_action_invalid:${action}`);
  }
  if ((action === 'restore-drill' || action === 'clear-empty-sidecars') && !args.backup) {
    throw new Error('personal_local_database_backup_path_required');
  }
  return Object.freeze({
    help: false,
    action,
    runtimeRoot: path.resolve(args['runtime-root'] || defaultPaperRuntimeRoot()),
    backupPath: args.backup ? path.resolve(args.backup) : null,
    allowLegacySchema: args['allow-legacy-schema'] === true,
    allowStaleSharedMemory: args['allow-stale-shared-memory'] === true,
  });
}

export async function runPersonalLocalDatabase({ argv = process.argv.slice(2) } = {}) {
  const options = parse(argv);
  if (options.help) return Object.freeze({ report: usage(), exitCode: 0 });
  const report = options.action === 'status'
    ? await inspectPersonalLocalDatabase({ runtimeRoot: options.runtimeRoot })
    : options.action === 'record'
      ? await recordPersonalDatabaseAntiRollback({ runtimeRoot: options.runtimeRoot })
      : options.action === 'backup'
        ? await createPersonalDatabaseBackup({
          runtimeRoot: options.runtimeRoot,
          allowLegacySchema: options.allowLegacySchema,
        })
        : options.action === 'restore-drill'
          ? await restoreDrillPersonalDatabase({
            runtimeRoot: options.runtimeRoot,
            backupPath: options.backupPath,
          })
          : await clearPersonalDatabaseEmptySidecars({
            runtimeRoot: options.runtimeRoot,
            backupReceiptPath: options.backupPath,
            allowStaleSharedMemory: options.allowStaleSharedMemory,
          });
  const successfulStatuses = new Set([
    'personal_local_database_ready',
    'personal_database_anti_rollback_ready',
    'personal_database_backup_recorded',
    'personal_database_restore_drill_passed',
    'personal_database_sidecars_cleared',
  ]);
  return Object.freeze({
    report,
    exitCode: report.ready === true || successfulStatuses.has(report.status) ? 0 : 2,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runPersonalLocalDatabase().then(({ report, exitCode }) => {
    process.stdout.write(`${typeof report === 'string' ? report : JSON.stringify(report, null, 2)}\n`);
    process.exitCode = typeof report === 'string' ? 0 : exitCode;
  }).catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
