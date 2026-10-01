import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
if (process.version !== 'v22.23.1' || process.versions.icu !== '78.2'
    || process.versions.cldr !== '48.0') throw new Error('release_replay_node_profile_unqualified');
const root=process.argv[1];
const corpus=readBoundedReplayInput('referee');
const module=await import(pathToFileURL(path.join(root,'paper-adapters/referee-revise/decision-routing.mjs')));
const legacy=await import(pathToFileURL(path.join(root,'migration/legacy-reference-fixture.mjs')));
const implementations={
  referee_revision_request_decision_plan:module.refereeRevisionRequestDecisionPlan,
  referee_revision_request_consuming_selection:module.refereeRevisionRequestConsumingSelection,
  evidence_resync_decision_plan:module.evidenceResyncDecisionPlan,
  evidence_resync_consuming_selection:module.evidenceResyncConsumingSelection,
  ready_merge_boundary_decision_plan:module.readyMergeBoundaryDecisionPlan,
  ready_merge_boundary_consuming_selection:module.readyMergeBoundaryConsumingSelection,
  post_apply_final_gate_decision_plan:module.postApplyFinalGateDecisionPlan,
  post_apply_final_gate_consuming_selection:module.postApplyFinalGateConsumingSelection,
};
const actual=corpus.cases.map(row=>implementations[row.name](...row.args));
function commandContract(value,restore=false){
  if(Array.isArray(value))return value.map(row=>commandContract(row,restore));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,row])=>[key,commandContract(row,restore)]));
  if(typeof value!=='string')return value;
  const match=(restore?/^hepta-paper:\/\/repair.safe-apply\/v1\?patch_id=(\d+)$/:/^\.\/bin\/paperctl merge-queue --patch-id (\d+) --json$/).exec(value);
  return match?(restore?`./bin/paperctl merge-queue --patch-id ${match[1]} --json`:`hepta-paper://repair.safe-apply/v1?patch_id=${match[1]}`):value;
}
const reference=legacy.materializeLegacyDifferentialReference();
try{
  const python=spawnSync('/usr/bin/python3',['-I','-B','-c',String.raw`
import json, pathlib, sys
sys.path.insert(0,sys.argv[1])
from paperctl_modules import referee_revision
cases=json.load(sys.stdin)
json.dump([getattr(referee_revision,row['name'])(*row['args']) for row in cases],sys.stdout)
`,reference.root],{input:JSON.stringify(commandContract(corpus.cases.slice(0,corpus.baseCaseCount),true)),encoding:'utf8',timeout:30_000,maxBuffer:16*1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'}});
  if(python.status!==0||python.error)throw new Error(`release_replay_python_oracle_failed:${python.stderr||python.error}`);
  process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},archiveReference:reference.verification,archivedPython:commandContract(JSON.parse(python.stdout)),actual})+'\n');
}finally{reference.cleanup()}
