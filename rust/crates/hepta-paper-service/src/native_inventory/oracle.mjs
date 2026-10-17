// Real incumbent inventory/factory source. This isolated local registration is
// fixture input creation, never writable installed bootstrap or execution.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createDefaultPaperStore, createReadOnlyPaperStore} from '../../../../../paper-adapters/persistence/store-provider.mjs';
import {createSqliteCampaignStore} from '../../../../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import {createSystemClock} from '../../../../../paper-adapters/runtime/system-clock.mjs';
import {createPaperTask} from '../../../../../paper-domain/contracts/workflow-contracts.mjs';
import {buildPaperCampaignPlan} from '../../../../../paper-domain/automation/campaign-plan.mjs';
import {discoverInventory} from '../../../../../paper-adapters/inventory/index.mjs';

assert.equal(process.version,'v22.23.1');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const {root,database,name}=input;
const source=path.join(root,'drafts','local-paper');
if(input.action==='prepare') {
 fs.mkdirSync(source,{recursive:true,mode:0o700});
 fs.mkdirSync(path.dirname(database),{recursive:true,mode:0o700});
 fs.mkdirSync(path.join(root,'registry'),{recursive:true,mode:0o700});
 const write=(name,bytes)=>fs.writeFileSync(path.join(source,name),bytes,{mode:0o600});
 write('main.tex','\\documentclass{article}\n\\begin{document}local fixture\\end{document}\n');
 write('paper.pdf','PDF bytes');write('source.zip','ZIP bytes');write('research_evidence.json','{"observation":true}');
 write('paper.json',JSON.stringify({paper_production:{profile:'empirical_or_experiment_paper'}}));
 // Stable actual filesystem times let the whole Value oracle exercise the
 // incumbent stable ordering and nanosecond-bound file identity recipes.
 for(const n of ['main.tex','paper.pdf','source.zip','research_evidence.json','paper.json']) fs.utimesSync(path.join(source,n),1700000000.123,1700000000.123);
 fs.writeFileSync(path.join(root,'registry','venues.yaml'),'venues:\n  - venue_id: yaml-v\n    name: YAML Local Venue\n    kind: local\n    cycle: "2026"\n    deadline: "2026-12-31"\n',{mode:0o600});
 fs.writeFileSync(path.join(root,'registry','papers.yaml'),'papers:\n  - slug: yaml-paper\n    title: YAML Paper\n    status: draft\n    canonical_dir: drafts/local-paper\n    venue_target: YAML Local Venue\n',{mode:0o600});
 fs.writeFileSync(path.join(root,'registry','workflows.yaml'),'workflows:\n  paper_production:\n    local_only: true\n    rounds: 2\n',{mode:0o600});
 const store=createDefaultPaperStore({root,dbPath:database});
 try {
  const task=createPaperTask({paperId:'local-paper',title:'Local Paper',status:'draft',canonicalDir:'drafts/local-paper',sourceWorkspace:'drafts/local-paper',mainTex:'drafts/local-paper/main.tex',createdAt:input.observedAt});
  const plan=buildPaperCampaignPlan({paperId:task.paperId,mode:'local-build',campaignId:'native-inventory-registration',paperTask:task,paperState:null,sourceWorkspace:source,maxRounds:1,languages:['latex'],createdAt:input.observedAt});
  const campaigns=createSqliteCampaignStore({store,clock:createSystemClock()});
  const registered=campaigns.createCampaign(plan);
  assert.equal(registered.campaignId,plan.campaignId);
  assert.equal(store.run('UPDATE papers SET title=?,venue_target=?,current_pdf=?,current_source_zip=? WHERE slug=?',['Local Paper','Local Venue','drafts/local-paper/paper.pdf','drafts/local-paper/source.zip','local-paper']).ok,true);
  if(name!=='empty-venues') assert.equal(store.run('INSERT INTO venues(venue_id,name,kind,cycle,deadline,metadata_json) VALUES(?,?,?,?,?,?)',['local-v','Local Venue','local','2026','2026-12-31','{}']).ok,true);
  if(name==='empty-auto'||name==='yaml') assert.equal(store.run('DELETE FROM papers').ok,true);
  if(name==='missing-papers'||name==='missing-papers-auto') assert.equal(store.execute('PRAGMA foreign_keys=OFF; DROP TABLE papers;').ok,true);
  if(name==='missing-column') assert.equal(store.execute('ALTER TABLE venues RENAME COLUMN name TO renamed_name;').ok,true);
  if(name==='malformed-json'||name==='malformed-json-auto'||name==='malformed-json-yaml') assert.equal(store.run('UPDATE papers SET metadata_json=?',['{malformed']).ok,true);
  if(name==='numeric-fields') assert.equal(store.run('UPDATE papers SET title=?,status=?,paper_type=?,current_verdict=?,updated_at=?',[0,3.25,'',1,'a\r b\t c\n\n\n d']).ok,true);
  if(name==='blob-fields') {
   const r=store.run('UPDATE papers SET title=?,status=?,paper_type=?,current_verdict=?,updated_at=?',[new Uint8Array([65,66]),new Uint8Array([7]),new Uint8Array(),new Uint8Array([1,2]),new Uint8Array([0])]);assert.equal(r.ok,true,JSON.stringify({name,error:r.error,stderr:r.stderr}));
  }
  if(name==='blob-venue') {
   const r=store.run('UPDATE papers SET venue_target=?',[new Uint8Array([65,66])]);assert.equal(r.ok,true,JSON.stringify({name,error:r.error,stderr:r.stderr}));
   const v=store.run('UPDATE venues SET name=?',[new Uint8Array([65,66])]);assert.equal(v.ok,true,JSON.stringify({name,error:v.error,stderr:v.stderr}));
  }
  if(name==='missing-source') { fs.renameSync(source,path.join(root,'elsewhere'));assert.equal(store.run('UPDATE papers SET source_dir=?,canonical_dir=?,current_pdf=?,current_source_zip=?',['drafts/missing','drafts/missing','','']).ok,true); }
  if(name==='no-main') {fs.unlinkSync(path.join(source,'main.tex'));}
  if(name==='tex-order') {fs.unlinkSync(path.join(source,'main.tex'));for(const n of ['ž.tex','a.tex','É.tex','sample.tex','manuscript.tex']) write(n,n);}
  if(name==='loose') {const d=path.join(root,'drafts','unregistered_paper');fs.mkdirSync(d,{mode:0o700});fs.writeFileSync(path.join(d,'main.tex'),'loose source',{mode:0o600});}
  if(name==='quality-formal') write('paper.json','{"paper_production":{"profile":"theorem_or_proof_paper"}}');
  if(name==='quality-malformed') write('paper.json','{invalid');
  if(name==='retired') assert.equal(store.run('UPDATE papers SET status=?',['retired_stale']).ok,true);
  if(name==='quarantined') assert.equal(store.run('UPDATE papers SET source_dir=?,canonical_dir=?',['tests/fixtures','tests/fixtures']).ok,true);
  if(name==='null-metadata') assert.equal(store.run('UPDATE papers SET metadata_json=?',['null']).ok,true);
  if(name==='proposal'||name==='external-proposal') {
   const p=name==='external-proposal'?path.join(path.dirname(database),'proposals/p'):path.join(root,'hepta-paper-workspace/runtime/proposals/p');fs.mkdirSync(p,{recursive:true,mode:0o700});fs.writeFileSync(path.join(p,'main.tex'),'proposal',{mode:0o600});
   const s=input.proposalStagingRoot||path.join(root,'hepta-paper-workspace/runtime/proposal-staging');fs.mkdirSync(s,{recursive:true,mode:0o700});fs.writeFileSync(path.join(s,'p.json'),JSON.stringify({kind:'PaperProposalStagingRecord',status:'proposal_staged_for_inventory',paperId:'proposal-paper',title:'Proposal',sourceWorkspace:path.relative(root,p),createdAt:input.observedAt,safety:{executesExternalAction:false}}),{mode:0o600});
  }
  if(name==='known-marker'||name==='partial-marker') {
   const statements=JSON.parse(fs.readFileSync(new URL('../../../../../store/schema/autonomous-research-online-mutation-marker.v1.json',import.meta.url),'utf8'));
   assert.equal(statements.length,11);
   for(const sql of name==='partial-marker'?statements.slice(0,1):statements) assert.equal(store.execute(sql).ok,true);
  }
  if(name==='unknown-schema') assert.equal(store.execute('CREATE TABLE native_fixture_unknown(value TEXT);').ok,true);
  if(name==='changed-schema') assert.equal(store.execute('ALTER TABLE venues ADD COLUMN native_fixture_extra TEXT;').ok,true);
  store.execute('PRAGMA wal_checkpoint(TRUNCATE);');
  assert.equal(store.query('PRAGMA journal_mode=DELETE;').ok,true);
 } finally {store.close();}
 if(name==='missing-db') fs.unlinkSync(database);
 process.stdout.write(JSON.stringify({registered:true,ordinarySourceFilesCreated:true,workflowExecutionPerformed:false,authorityGranted:false}));
} else {
 let store=null;
 try {
  if(input.database) store=createReadOnlyPaperStore({root,dbPath:input.database,immutable:true,allowMissing:true});
  const result=await discoverInventory({root,store,inventorySource:input.inventorySource,includeLooseDrafts:input.includeLooseDrafts,includeRetired:input.includeRetired,includeQuarantined:input.includeQuarantined,includeProposalStaging:input.includeProposalStaging,proposalStagingRoot:input.proposalStagingRoot,paperIds:input.paperIds,limit:input.limit,observedAt:input.observedAt});
  process.stdout.write(JSON.stringify({ok:true,result}));
 } catch(error) {process.stdout.write(JSON.stringify({ok:false,error:error.message}));} finally {store?.close();}
}
