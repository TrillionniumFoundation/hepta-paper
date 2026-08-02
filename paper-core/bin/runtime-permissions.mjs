#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { auditRuntimePermissions } from '../../paper-composition/bootstrap/operator-runtime-composition.mjs';
import { resolveWorkspaceLayout } from '../src/workspace-layout.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const args = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['execute', 'help', 'writer-quiesced'],
  positional: false,
});

if (args.help) {
  process.stdout.write(`${JSON.stringify({
    version: 1,
    kind: 'RuntimePermissionMaintenanceUsage',
    usage: 'npm run runtime:permissions [-- --execute --writer-quiesced]',
    defaultBehavior: 'read_only_audit',
    executeBehavior:
      'locked_descriptor_relative_owner_only_permission_hardening_after_confirmed_writer_quiescence',
  }, null, 2)}\n`);
} else {
  const layout = resolveWorkspaceLayout();
  const runtimeRoot = layout.runtimeRoot;
  const forbiddenRoots = new Set([
    path.parse(runtimeRoot).root,
    os.homedir(),
    layout.workspaceRoot,
    layout.assetRoot,
    layout.legacyRoot,
  ].map((candidate) => path.resolve(candidate)));
  if (forbiddenRoots.has(path.resolve(runtimeRoot))) {
    throw new Error('runtime_permission_root_conflicts_with_non_runtime_root');
  }
  const report = auditRuntimePermissions({
    runtimeRoot,
    execute: Boolean(args.execute),
    writerQuiescenceConfirmed: Boolean(args['writer-quiesced']),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.blockers.length) process.exitCode = 2;
}
