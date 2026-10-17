// Execute the actual Node CLI under an explicit test clock. Only tests use this
// wrapper; production Rust gets its clock directly from the operating system.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const OriginalDate=Date;
globalThis.Date=class extends OriginalDate {
  constructor(...args) {super(...(args.length?args:[input.now]));}
  static now() {return OriginalDate.parse(input.now);}
};
for(const name of Object.keys(process.env)) if(name.startsWith('HEPTA_NESTED_RUNTIME_')) delete process.env[name];
Object.assign(process.env,input.environment || {});
const entry=new URL('../../paper-core/bin/nested-runtime-platform-qualification.mjs',import.meta.url);
process.argv=[process.execPath,fileURLToPath(entry),...(input.argv || [])];
await import(entry.href);
