// Owned storage fixtures only. Real original publisher/reader and Ed25519 checks
// over synthetic data; no verifier, image rebuild or external authority executes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createRuntimeImageReproducibilityReceiptRepository as repository} from '../../paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs';
import {verifyRuntimeImageReproducibilityReceipt} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
const input=JSON.parse(process.argv[2]);
const root=path.resolve(input.root);
const stat=fs.lstatSync(root);
if(!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid() || (stat.mode&0o077)!==0
  || fs.realpathSync(root)!==root || !root.startsWith(fs.realpathSync(os.tmpdir())+path.sep)
  || fs.readFileSync(path.join(root,'.owned-runtime-publication-fixture'),'utf8')!=='owned synthetic runtime publication fixture\n')throw Error('owned_runtime_publication_fixture_required');
const fixturePath=path.join(root,'publication-fixture.json');
const fixtureStat=fs.lstatSync(fixturePath);
if(!fixtureStat.isFile() || fixtureStat.isSymbolicLink() || fixtureStat.uid!==process.getuid() || fixtureStat.nlink!==1
 || fixtureStat.size>4*1024*1024 || (fixtureStat.mode&0o022)!==0)throw Error('owned_runtime_publication_data_required');
const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
const receiptPath=path.join(root,'owned-publication.json');
const databasePath=receiptPath+'.publication.sqlite';
const now='2026-07-16T08:00:45.000Z';
function verify(receipt, observed=now){
 return verifyRuntimeImageReproducibilityReceipt(receipt,{now:observed,currentCodeProvenanceHash:fixture.request.codeProvenanceHash,
 currentReleaseIdentityHash:fixture.request.releaseIdentityHash,currentInputs:fixture.inputs,configuration:fixture.configuration,
 profilePolicies:fixture.profilePolicies,verifySignature:({signingPayloadHash,signature,verifier})=>{
  const index=fixture.configuration.verifiers.findIndex(value=>value.serviceId===verifier.serviceId);
  return index>=0 && crypto.verify(null,Buffer.from(signingPayloadHash),fixture.publicKeys[index],Buffer.from(signature,'base64'));
 }});
}
function read(){
 try {
  const stored=repository({receiptPath}).read();
  return {ok:true,value:stored===null?null:{receipt:stored.receipt,inspection:verify(stored.receipt,input.now??now),receiptContentHash:stored.contentHash,publicationGeneration:stored.publicationGeneration}};
 }catch(error){return {ok:false,error:error.message};}
}
function output(value){process.stdout.write(JSON.stringify({profile:productionOracleProfile(),value}));}
if(input.action==='setup'){
 repository({receiptPath,receiptVerifier:verify}).publish({receipt:fixture.receipt,now:new Date(now)});
 output(read());
}else if(input.action==='read')output(read());
else if(input.action==='hold-wal'){
 const database=new DatabaseSync(databasePath);
 try{
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE runtime_image_reproducibility_receipt SET publication_generation=2 WHERE singleton_id=1;');
  output({held:true});process.stdout.write('\n');
  await new Promise(resolve=>{const timer=setTimeout(resolve,30000);process.stdin.once('data',()=>{clearTimeout(timer);resolve();});process.stdin.resume();});process.stdin.pause();
 }finally{database.close();}
}else if(input.action==='mutate'){
 const database=new DatabaseSync(databasePath);
 try{
  if(input.scenario==='no-authority')database.exec('DELETE FROM runtime_image_reproducibility_receipt');
  else if(input.scenario==='bad-row')database.exec("UPDATE runtime_image_reproducibility_receipt SET receipt_content_hash='wrong'");
  else if(input.scenario==='view')database.exec('ALTER TABLE runtime_image_reproducibility_receipt RENAME TO owned_hidden; CREATE VIEW runtime_image_reproducibility_receipt AS SELECT * FROM owned_hidden;');
  else if(input.scenario==='oversize')database.prepare('UPDATE runtime_image_reproducibility_receipt SET receipt_json=?').run(' '.repeat(32*1024*1024+1));
  else throw Error('owned_mutation_scenario_invalid');
 }finally{database.close();}
 if(input.removeMirror)fs.unlinkSync(receiptPath);
 output(read());
}else throw Error('owned_runtime_publication_action_invalid');
