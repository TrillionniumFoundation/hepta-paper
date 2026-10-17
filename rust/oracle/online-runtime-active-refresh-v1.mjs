import fs from 'node:fs';
import crypto from 'node:crypto';
import { refreshAutonomousResearchOnlineMutationAuthorityEvidence } from '../../paper-adapters/automation/autonomous-research-online-mutation-active-refresh.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const original=crypto.randomUUID;
let index=0;
crypto.randomUUID=()=>{if(index>=input.nonces.length)throw new Error('oracle_nonce_exhausted');return input.nonces[index++];};
let output;
try {output=refreshAutonomousResearchOnlineMutationAuthorityEvidence({...input,clock:{now:()=>new Date(input.now)}});}
catch(error){output={error:error.message};}
finally{crypto.randomUUID=original;}
process.stdout.write(JSON.stringify(output));
