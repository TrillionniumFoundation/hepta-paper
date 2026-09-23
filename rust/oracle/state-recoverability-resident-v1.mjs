// Synthetic, isolated resident lease differential oracle. No production runtime.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAutonomousResearchSupervisorInstanceRepository } from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const root=path.resolve(request.root);
if(!root.startsWith('/tmp/hepta-recoverability-resident-')||fs.lstatSync(root).isSymbolicLink())throw new Error('isolated fixture required');
let repository;
try {
 if(request.mode==='create'){
  repository=createAutonomousResearchSupervisorInstanceRepository({runtimeRoot:root});
  const lease=repository.acquireInstanceLease({ownerId:'resident:owner',now:new Date(request.now),leaseMs:60000,heartbeatMs:1000});
  const row=repository.assertInstanceLease({lease,now:new Date(request.now)});
  process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:true,value:{lease,row}}));
 }else{
  if(request.sql){const db=new DatabaseSync(path.join(root,'autonomous-research/supervisor/resident-instance.sqlite'));db.exec(request.sql);db.close();}
  repository=createAutonomousResearchSupervisorInstanceRepository({runtimeRoot:root,create:false,offlineProvision:false});
  const row=repository.assertInstanceLease({lease:request.lease,now:new Date(request.now)});
  process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:true,value:row}));
 }
}catch(error){process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:false,error:error.message}));}
finally{repository?.close();}
