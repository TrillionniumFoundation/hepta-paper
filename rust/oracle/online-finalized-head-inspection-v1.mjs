// Isolated test-only SQLite and public-key verification. Never opens live state.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
import {hashBytes} from '../../workflow-kernel/record-hash.mjs';
import * as contract from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {inspectAutonomousResearchOnlineFinalizedDatabaseHead} from '../../paper-adapters/automation/autonomous-research-online-finalized-head-inspection.mjs';
const requests=JSON.parse(fs.readFileSync(0,'utf8'));
const results=requests.map(q=>{
 const db=new DatabaseSync(':memory:');const previous=crypto.randomUUID;
 try {
  for(const sql of q.schema)db.exec(sql);
  for(const [table,rows] of [['autonomous_research_online_mutation_authority_metadata',q.metadata],['autonomous_research_online_mutation_authority_marker',q.markers],['autonomous_research_online_mutation_finalization_receipt',q.finalizations]]){
   for(const row of rows){const names=Object.keys(row);if(names.some(n=>!/^[a-z_]+$/.test(n)))throw Error('fixture_invalid');db.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')})`).run(...names.map(n=>row[n]));}
  }
  const publicKey=crypto.createPublicKey(q.publicKeyPem),trust=q.trust;
  const verifySignature=r=>crypto.verify(null,Buffer.from(contract.autonomousResearchOnlineMutationSignedPayload(r)),publicKey,Buffer.from(r.signature,'base64'));
  const shared={trust,verifySignature,hashChangesetBase64:s=>hashBytes(Buffer.from(s,'base64'))};
  const client={protocol:contract.AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,trust,
   observeCurrentHead({request,now,expectedDatabaseInstances}){if(!contract.verifyAutonomousResearchOnlineMutationCurrentHead({receipt:q.head,request,now,expectedDatabaseInstances,...shared}))throw Error('head_invalid');return q.head;},
   verifyStoredReservation({receipt,request}){return contract.verifyAutonomousResearchOnlineMutationReservation({receipt,request,now:new Date(receipt.issuedAt),...shared});},
   verifyStoredFinalization({receipt,request,reservation}){return contract.verifyAutonomousResearchOnlineMutationFinalization({receipt,request,reservation,now:new Date(receipt.finalizedAt),...shared});}
  };
  crypto.randomUUID=()=>q.request.nonce.slice(5);
  const value=inspectAutonomousResearchOnlineFinalizedDatabaseHead({database:db,databaseInstanceId:'resident-instance',inventory:q.inventory,authorityClient:client,writerManifest:q.manifest,clock:{now:()=>new Date(q.now)}});
  return{ok:true,value};
 }catch(e){return{ok:false,error:e.message};}finally{crypto.randomUUID=previous;db.close();}
});
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),results}));
