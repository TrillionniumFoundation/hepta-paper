import fs from 'node:fs';
import { evaluateAutonomousResearchStateSafetyReadiness, inspectAutonomousResearchOnlineWriterCoverage, unavailableAutonomousResearchOnlineAntiRollbackInspection, expandAutonomousResearchStateSafetyBlockerCodeCompatibility } from '../../paper-domain/automation/autonomous-research-state-safety-contract.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
function run(v) {
 try {
  if(v.mode==='unavailable')return unavailableAutonomousResearchOnlineAntiRollbackInspection({writerManifest:v.manifest});
  if(v.mode==='blockers')return expandAutonomousResearchStateSafetyBlockerCodeCompatibility(v.value);
  if(v.mode==='writer')return inspectAutonomousResearchOnlineWriterCoverage({...v,now:new Date(v.now)});
  return evaluateAutonomousResearchStateSafetyReadiness({...v,now:new Date(v.now)});
 }catch(error){return {error:error.message};}
}
process.stdout.write(JSON.stringify(Array.isArray(input)?input.map(run):run(input)));
