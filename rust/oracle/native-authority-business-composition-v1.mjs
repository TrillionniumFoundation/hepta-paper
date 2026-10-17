// Actual native daemon/client integration fixture only. Node creates the real
// incumbent business/schema state; every authority receipt is obtained from
// the separately running Rust runtime through the test-only Rust client ELF.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture as databaseFixture,stateDatabaseManifest}
  from '../../paper-core/tests/support/autonomous-research-online-schema-transition-fixture.mjs';
import {createDefaultPaperStore} from '../../paper-adapters/persistence/store-provider.mjs';
import {createSqliteCampaignStore} from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import {createAutonomousResearchSupervisorInstanceRepository}
  from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {resolveAutonomousResearchStateDatabaseInventory}
  from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST as writerManifest}
  from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {autonomousResearchOnlineWriterOperationManifestHash}
  from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient}
  from '../../paper-adapters/automation/autonomous-research-online-schema-transition-authority.mjs';
import {planAutonomousResearchOnlineSchemaTransition,executeAutonomousResearchOnlineSchemaTransition}
  from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';
import {validateAutonomousResearchOnlineSchemaTransitionAuditReceipt}
  from '../../paper-adapters/automation/autonomous-research-online-schema-transition-completion.mjs';
import {hashBytes,hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
import {verifyAutonomousResearchOnlineSchemaTransitionReservation} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
const REPO=path.resolve(import.meta.dirname,'../..'),LEASE_MS=900000;
const write=(p,v)=>{fs.writeFileSync(p,JSON.stringify(v),{mode:0o600});fs.chmodSync(p,0o600);};
function provisionNativeBusiness(runtime){
  const dbPath=path.join(runtime,'hepta-paper.sqlite');fs.unlinkSync(dbPath);
  const store=createDefaultPaperStore({root:runtime,runtimeRoot:runtime,dbPath});
  const past=new Date(Date.now()-7200000).toISOString(),clock={now:()=>new Date(past),nowIso:()=>past};
  const checked=sql=>{const result=store.execute(sql);if(!result.ok)throw Error(result.error||result.stderr);};
  try{
    const campaigns=createSqliteCampaignStore({store,clock});
    for(const [campaignId,policy] of [['standard-campaign',1],['legacy-campaign',0]]){
      campaigns.createCampaign({campaignId,paperId:`${campaignId}-paper`,terminalSiblingSettlementPolicyVersion:policy,nodes:[
        {nodeId:`${campaignId}:terminal`,kind:'agent',dependencies:[]},
        {nodeId:`${campaignId}:expired`,kind:'agent',dependencies:[]},
        {nodeId:`${campaignId}:queued`,kind:'agent',dependencies:[]},
      ]});
      checked(`UPDATE paper_campaigns SET status='failed',stop_reason='historical_failure',revision=7 WHERE campaign_id='${campaignId}';
        UPDATE campaign_nodes SET status='failed_terminal',failure_class='historical_failure',node_revision=3 WHERE node_id='${campaignId}:terminal';
        UPDATE campaign_nodes SET status='running',lease_owner='dead-worker',lease_expires_at='${past}',attempt_id='expired-attempt',lease_generation=5,node_revision=9 WHERE node_id='${campaignId}:expired';
        UPDATE campaign_nodes SET failure_class='保留↔é',node_revision=3 WHERE node_id='${campaignId}:queued';`);
    }
    const versions=store.query('SELECT MAX(version) AS version FROM schema_migrations');
    if(!versions.ok||versions.rows[0].version!==25)throw Error('actual_native_schema_25_required');
  }finally{store.close();}
}

function prepare(root,publicKeyPem){
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace,{mode:0o700});
  for(const name of ['paper-adapters','paper-application','paper-composition','paper-core','paper-domain','paper-ports','workflow-kernel','store'])
    fs.cpSync(path.join(REPO,name),path.join(workspace,name),{recursive:true,dereference:true});
  fs.symlinkSync(path.join(REPO,'node_modules'),path.join(workspace,'node_modules'));
  const generated=databaseFixture({after(){}}),runtime=path.join(root,'runtime');
  fs.renameSync(generated.runtimeRoot,runtime);fs.rmdirSync(generated.parent);
  provisionNativeBusiness(runtime);
  const residentPath=path.join(runtime,'autonomous-research/supervisor/resident-instance.sqlite');
  const db=new DatabaseSync(residentPath);db.exec('DROP TABLE autonomous_research_supervisor_instance');db.close();
  const resident=createAutonomousResearchSupervisorInstanceRepository({runtimeRoot:runtime});
  const lease=resident.acquireInstanceLease({ownerId:'resident:native-authority-business',now:new Date(),leaseMs:1800000,heartbeatMs:30000});resident.close();
  if(!lease)throw Error('actual_resident_lease_required');
  const backupRoot=path.join(runtime,'backups/autonomous-research-state');fs.mkdirSync(backupRoot,{recursive:true,mode:0o700});
  const inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:runtime,manifest:stateDatabaseManifest});
  const trust={version:1,kind:'AutonomousResearchOnlineMutationAuthorityTrust',authorityId:'native:authority:business',keyId:'native:key:business',scopeId:'native:scope:business',
    databaseScopeHash:inventory.databaseScopeHash,writerManifestHash:autonomousResearchOnlineWriterOperationManifestHash(writerManifest),
    maximumReservationLeaseMs:LEASE_MS,maximumObservationAgeMs:LEASE_MS};
  const onlinePublic=path.join(root,'online-public.json'),backupPublic=path.join(root,'backup-public.json');
  write(onlinePublic,{version:1,kind:'AutonomousResearchOnlineMutationAuthorityPublicKey',authorityId:trust.authorityId,keyId:trust.keyId,algorithm:'ed25519',publicKeyPem});
  write(backupPublic,{version:1,kind:'AutonomousResearchStateBackupAuthorityPublicKey',authorityId:trust.authorityId,keyId:trust.keyId,algorithm:'ed25519',publicKeyPem});
  const onlineConfiguration=path.join(root,'online-configuration.json');
  write(onlineConfiguration,{...trust,kind:'AutonomousResearchOnlineMutationAuthorityConfiguration',publicKeyPath:onlinePublic,publicKeySha256:hashBytes(fs.readFileSync(onlinePublic))});
  const commandPath=path.join(root,'native-fixture-client'),commandSha256=hashBytes(fs.readFileSync(commandPath));
  const onlineProcess=path.join(root,'online-process.json'),backupConfiguration=path.join(root,'backup-process.json');
  write(onlineProcess,{version:1,kind:'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',authorityConfigurationPath:onlineConfiguration,authorityConfigurationSha256:hashBytes(fs.readFileSync(onlineConfiguration)),commandPath,commandSha256,fixedArguments:[],timeoutMs:10000});
  write(backupConfiguration,{version:2,kind:'AutonomousResearchStateBackupAuthorityProcessConfiguration',authorityId:trust.authorityId,keyId:trust.keyId,commandPath,commandSha256,
    publicKeyPath:backupPublic,publicKeySha256:hashBytes(fs.readFileSync(backupPublic)),fixedArguments:[],timeoutMs:10000,maximumReservationLeaseMs:LEASE_MS,maximumHeadObservationAgeMs:LEASE_MS,
    onlineMutationAuthorityConfigurationPath:onlineConfiguration,onlineMutationAuthorityConfigurationSha256:hashBytes(fs.readFileSync(onlineConfiguration))});
  const daemonConfiguration=path.join(root,'daemon.json');
  write(daemonConfiguration,{...trust,kind:'HeptaLocalAutonomousResearchStateAuthorityConfiguration',privateKeyPath:path.join(root,'supplied-key.pem'),
    stateDatabasePath:path.join(root,'authority.sqlite'),socketPath:path.join(root,'authority.sock')});
  const value={root,workspace,runtime,backupRoot,onlineConfiguration,onlineProcess,onlineProcessHash:hashBytes(fs.readFileSync(onlineProcess)),
    backupConfiguration,backupConfigurationHash:hashBytes(fs.readFileSync(backupConfiguration)),daemonConfiguration,lease:{...lease,generation:lease.leaseGeneration}};
  write(path.join(root,'native-fixture.json'),value);return value;
}
function install(root){
  const f=JSON.parse(fs.readFileSync(path.join(root,'native-fixture.json'),'utf8'));
  const original=createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient({processConfigurationPath:f.onlineProcess});
  const client={...original,reserveSchemaTransition(options){
    try{return original.reserveSchemaTransition(options);}catch(cause){
      const last=JSON.parse(fs.readFileSync(path.join(root,'native-calls.jsonl'),'utf8').trim().split('\n').at(-1));
      const actual=JSON.parse(last.receiptJson);
      if(last.request.kind!==options.request.kind||actual.requestHash!==hashRecord(options.request.kind,options.request))throw cause;
      const signature=original.verifySignedReceipt(actual);
      if(signature!==true)throw Error(JSON.stringify({cause:cause.message,signature:false}));
      const verify=receipt=>verifyAutonomousResearchOnlineSchemaTransitionReservation({...options,receipt,trust:original.trust,verifySignature:original.verifySignedReceipt});
      // Diagnostics only: never return a projected receipt or modify authority
      // state. A genuine original-contract refusal remains a hard test failure.
      throw Error(JSON.stringify({cause:cause.message,signature,
        originalVerified:verify(actual),onlyInstancePropertyOrderProjected:verify({...actual,instances:options.request.instances}),
        requestKeys:Object.keys(options.request.instances[0]),receiptKeys:Object.keys(actual.instances[0])}));
    }
  }};
  const input={runtimeRoot:f.runtime,stateDatabaseManifest,writerManifest,authorityProcessConfigurationPath:f.onlineProcess,
    clock:{now:()=>new Date()},createAuthorityClient:()=>client};
  const planned=planAutonomousResearchOnlineSchemaTransition(input);
  const execution=executeAutonomousResearchOnlineSchemaTransition({...input,expectedTransitionId:planned.plan.transitionId});
  if(execution.status!=='autonomous_research_online_schema_transition_ready')throw Error(JSON.stringify(execution));
  const audit=JSON.parse(fs.readFileSync(path.join(f.runtime,'autonomous-research/online-schema-transition/FINAL.json'),'utf8'));
  const inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot:f.runtime,manifest:stateDatabaseManifest});
  validateAutonomousResearchOnlineSchemaTransitionAuditReceipt({receipt:audit,inventory,writerManifest,authorityClient:client});
  // Inspect the complete raw receipts received through the native client too.
  // The original executor above already checks the per-operation contracts;
  // this independent pass neither reorders a value nor resigns a receipt.
  const rawReceipts=fs.readFileSync(path.join(root,'native-calls.jsonl'),'utf8').trim().split('\n')
    .map(line=>JSON.parse(JSON.parse(line).receiptJson));
  for(const receipt of rawReceipts)
    if(original.verifySignedReceipt(receipt)!==true)throw Error('actual_native_raw_receipt_signature_invalid');
  for(const kind of ['AutonomousResearchOnlineSchemaTransitionReservationReceipt',
    'AutonomousResearchOnlineSchemaTransitionFinalizationReceipt',
    'AutonomousResearchOnlineSchemaTransitionObservationReceipt'])
    if(!rawReceipts.some(receipt=>receipt.kind===kind))throw Error(`actual_native_raw_receipt_missing:${kind}`);
  return {...f,audit,inventory,verifiedRawSchemaReceipts:rawReceipts.length};
}
try{
  const q=JSON.parse(fs.readFileSync(0,'utf8')),root=q.root;
  if(!root.startsWith('/tmp/hepta-online-initial-composition-')||fs.realpathSync(root)!==root)throw Error('isolated_fixture_required');
  const value=q.mode==='prepare'?prepare(root,q.publicKeyPem):q.mode==='install'?install(root):(()=>{throw Error('mode_invalid');})();
  process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:true,value}));
}catch(error){process.stdout.write(JSON.stringify({profile:productionOracleProfile(),ok:false,error:error.stack||error.message}));}
