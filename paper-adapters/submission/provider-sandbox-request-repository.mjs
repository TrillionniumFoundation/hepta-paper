import fs from 'node:fs';
import path from 'node:path';

function fail(code) {
  throw Object.assign(new Error(`provider_sandbox_${code}`), { code: `provider_sandbox_${code}` });
}

// Owns only the private diagnostic request write. Never overwrites an existing
// request/response or writes a receipt, credential, campaign or publication state.
export function createProviderSandboxRequestFile({ runtimeRoot, bytes }) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024) fail('request_invalid');
  let rootIdentity;
  try {
    if (!path.isAbsolute(runtimeRoot) || fs.realpathSync(runtimeRoot) !== runtimeRoot) fail('runtime_unsafe');
    rootIdentity = fs.lstatSync(runtimeRoot, { bigint: true });
    if (!rootIdentity.isDirectory()) fail('runtime_unsafe');
  } catch { fail('runtime_unsafe'); }
  const input = path.join(runtimeRoot, 'provider-request.json');
  const output = path.join(runtimeRoot, 'provider-response.json');
  try { fs.lstatSync(output); fail('response_already_exists'); }
  catch (error) { if (error.code !== 'ENOENT') fail('response_already_exists'); }
  try { fs.writeFileSync(input, bytes, { mode: 0o600, flag: 'wx' }); }
  catch { fail('request_write_failed'); }
  return Object.freeze({ input, output,
    rootIdentity: Object.freeze({ dev: rootIdentity.dev, ino: rootIdentity.ino }) });
}
