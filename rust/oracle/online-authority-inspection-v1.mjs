import fs from 'node:fs';
import { inspectAutonomousResearchOnlineMutationPassiveEvidence, inspectAutonomousResearchOnlineMutationActiveEvidence } from '../../paper-adapters/automation/autonomous-research-online-mutation-passive-inspection.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
let output;
try {
 const options={...input,now:new Date(input.now)};
 output=input.mode==='passive'?inspectAutonomousResearchOnlineMutationPassiveEvidence(options):inspectAutonomousResearchOnlineMutationActiveEvidence(options);
} catch(error) { output={error:error.message}; }
process.stdout.write(JSON.stringify(output));
