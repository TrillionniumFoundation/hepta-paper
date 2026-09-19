import fs from 'node:fs';
import {resolveWorkspaceLayout} from '../../paper-adapters/runtime/workspace-layout.mjs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
try {
  const value = resolveWorkspaceLayout(input.options || {});
  process.stdout.write(JSON.stringify({ok: true, value}));
} catch (error) {
  process.stdout.write(JSON.stringify({ok: false, error: error.message}));
}
