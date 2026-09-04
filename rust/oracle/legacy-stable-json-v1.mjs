import fs from 'node:fs';

const MAX_BYTES = 16 * 1024 * 1024;
const input = fs.readFileSync(0);
if (input.length === 0 || input.length > MAX_BYTES) throw new Error('input_limit');
const value = JSON.parse(input.toString('utf8'));
function stable(v, depth = 0) {
  if (depth > 256) throw new Error('depth_limit');
  if (Array.isArray(v)) return `[${v.map((item) => stable(item, depth + 1)).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((key) => `${JSON.stringify(key)}:${stable(v[key], depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
process.stdout.write(stable(value));
