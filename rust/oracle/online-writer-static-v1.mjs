import fs from 'node:fs';
import { discoverAutonomousResearchOnlineWriterMutationEntrypoints, inspectAutonomousResearchOnlineWriterStaticCoverage } from '../../paper-adapters/automation/autonomous-research-online-writer-static-inspection.mjs';
import { AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST } from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const results=input.map(request=>{try{
  if(request.mode==='manifest')return AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST;
  if(request.mode==='inspect')return inspectAutonomousResearchOnlineWriterStaticCoverage(request);
  return discoverAutonomousResearchOnlineWriterMutationEntrypoints(request.path,request.source);
}catch(error){return {error:error.message};}});
process.stdout.write(JSON.stringify(results));
