// Compare each original inspector using the exact signed native request/response.
// Only this test's disposable ten-file runtime is accepted; public keys only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
import {hashBytes} from '../../workflow-kernel/record-hash.mjs';
import * as contract from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {inspectAutonomousResearchOnlineFinalizedDatabaseHead} from '../../paper-adapters/automation/autonomous-research-online-finalized-head-inspection.mjs';
const q=JSON.parse(fs.readFileSync(0,'utf8'));
if(!q.root.startsWith('/tmp/hepta-backup-cli-e2e-finalized-')||fs.realpathSync(q.root)!==q.root)throw Error('isolated_fixture_required');
const runtime=path.join(q.root,'runtime');
const key=crypto.createPublicKey(q.publicKeyPem);
const shared={trust:q.trust,verifySignature:r=>crypto.verify(null,Buffer.from(contract.autonomousResearchOnlineMutationSignedPayload(r)),key,Buffer.from(r.signature,'base64')),hashChangesetBase64:s=>hashBytes(Buffer.from(s,'base64'))};
const results=q.inventory.instances.map((instance,index)=>{
 const filename=path.resolve(runtime,instance.sourceRelativePath);
 if(!filename.startsWith(`${runtime}/`)||fs.realpathSync(filename)!==filename)throw Error('unsafe_fixture');
 const database=new DatabaseSync(filename,{readOnly:true});
 const previous=crypto.randomUUID;
 try{
  const record=q.records[index];
  crypto.randomUUID=()=>record.request.nonce.slice(5);
  const client={protocol:contract.AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,trust:q.trust,
   observeCurrentHead({request,now,expectedDatabaseInstances}){if(!contract.verifyAutonomousResearchOnlineMutationCurrentHead({receipt:record.receipt,request,now,expectedDatabaseInstances,...shared}))throw Error('head_invalid');return record.receipt;},
   verifyStoredReservation({receipt,request}){return contract.verifyAutonomousResearchOnlineMutationReservation({receipt,request,now:new Date(receipt.issuedAt),...shared});},
   verifyStoredFinalization({receipt,request,reservation}){return contract.verifyAutonomousResearchOnlineMutationFinalization({receipt,request,reservation,now:new Date(receipt.finalizedAt),...shared});}
  };
  return {ok:true,value:inspectAutonomousResearchOnlineFinalizedDatabaseHead({database,databaseInstanceId:instance.instanceId,inventory:q.inventory,authorityClient:client,writerManifest:q.manifest,clock:{now:()=>new Date(q.now)}})};
 }catch(error){return {ok:false,error:error.message};}finally{crypto.randomUUID=previous;database.close();}
});
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),results}));
