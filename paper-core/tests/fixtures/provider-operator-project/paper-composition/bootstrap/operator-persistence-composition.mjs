import fs from 'node:fs';

const trace = process.env.HEPTA_TEST_TRACE_PATH;
if (typeof trace !== 'string' || trace.length === 0) throw new Error('test_trace_path_missing');
const log = (value) => fs.appendFileSync(trace, `${value}\n`);

export function createDefaultPaperStore({ runtimeRoot }) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  return { close() { log('bootstrap-close'); } };
}
