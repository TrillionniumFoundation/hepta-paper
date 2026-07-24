import fs from 'node:fs';
import path from 'node:path';

import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { readRegularJsonFileSync } from '../runtime/pinned-file-reader.mjs';

const CONTROL_RELATIVE_ROOT = 'autonomous-research/online-schema-transition';

function fail(code) {
  throw new Error(code);
}

export function autonomousResearchOnlineSchemaTransitionControlPaths(
  runtimeRoot,
  { create = true } = {},
) {
  const root = path.resolve(runtimeRoot);
  const controlRoot = path.resolve(root, CONTROL_RELATIVE_ROOT);
  if (!pathWithin(root, controlRoot)) {
    fail('autonomous_research_online_schema_transition_control_path_invalid');
  }
  if (create) fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  if (fs.existsSync(controlRoot)) {
    const stat = fs.lstatSync(controlRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o022) {
      fail('autonomous_research_online_schema_transition_control_path_unsafe');
    }
  }
  return Object.freeze({
    controlRoot,
    activeStatePath: path.join(controlRoot, 'ACTIVE.json'),
    finalReceiptPath: path.join(controlRoot, 'FINAL.json'),
  });
}

export function writeAutonomousResearchOnlineSchemaTransitionJson(candidate, value) {
  writeDurableJsonSync(candidate, value);
}

export function readAutonomousResearchOnlineSchemaTransitionJson(candidate) {
  if (!fs.existsSync(candidate)) return null;
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o022) {
    fail('autonomous_research_online_schema_transition_control_file_unsafe');
  }
  const value = readRegularJsonFileSync(candidate);
  if (value === null) {
    fail('autonomous_research_online_schema_transition_control_file_invalid');
  }
  return value;
}
