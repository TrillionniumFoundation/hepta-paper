// True original SQLite provisioning and pristine inspection. Synthetic runtime only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { composeAutonomousResearchStateBusinessSchemaProvisioningService } from '../../paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs';
import { buildAutonomousResearchMachineIntakeConfiguration } from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import { inspectAutonomousResearchTopicProducerImplementationIdentity } from '../../paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs';
import { buildAutonomousResearchTopicProducerProfile } from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import { normalizeRuntimeReproducibilityRefreshPolicy } from '../../paper-domain/automation/runtime-reproducibility-refresh-policy.mjs';
import { resolveAutonomousResearchStateDatabaseInventory } from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import { AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS as JOURNAL, AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH as JOURNAL_HASH, AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS as MARKER } from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import { inspectAutonomousResearchPristineDatabaseState, autonomousResearchPristineRuntimeStateHash, autonomousResearchPristineRuntimeStatePolicyHash } from '../../paper-adapters/automation/autonomous-research-pristine-runtime-state.mjs';
import { schemaTransitionExactSchemaHash } from '../../paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs';
import { autonomousResearchStateDatabaseManifestHash } from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildHeptaStoreRestoreDrillLedgerSubjectV3 } from '../../paper-domain/evidence/hepta-store-restore-drill-receipt-contract.mjs';
import { resolveReceiptIssuerPolicy } from '../../paper-domain/evidence/receipt-issuer-policy-registry.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const repositoryRoot=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../..');
const stateDatabaseManifest=JSON.parse(fs.readFileSync(path.join(repositoryRoot,'paper-core/config/autonomous-research-state-databases.v1.json'),'utf8'));
const stateDatabaseManifestHash=autonomousResearchStateDatabaseManifestHash(stateDatabaseManifest);
const H=label=>hashRecord('PristineRuntimeRustFixture',{label});
const START='2026-09-16T12:00:00.000Z';

function canonicalProvisioningInputs() {
  const providerConfigurationHash = H('provider-configuration');
  const topicProducerProfile = buildAutonomousResearchTopicProducerProfile({
    producerId: 'runtime-adoption-v2-producer',
    implementationSha256:
      inspectAutonomousResearchTopicProducerImplementationIdentity().implementationSha256,
    providerConfigurationHash,
    minimumGenerationIntervalMs: 60 * 60 * 1000,
    maximumTopicsPerUtcDay: 1,
    maximumProviderCanaryAttemptsPerUtcDay: 1,
    maximumProviderCanaryCostUsdPerUtcDay: 1,
    registeredResearchProfiles: [{
      profileId: 'runtime-adoption-v2-profile',
      objective: 'Exercise the pristine runtime adoption recovery boundary.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts: [{
        name: 'runtime-adoption-v2-dataset',
        source: '/datasets/runtime-adoption-v2',
        readOnly: true,
        manifestHash: H('dataset'),
        licenseId: 'CC0-1.0',
        benchmarkFamily: 'ml_algorithm_benchmark',
      }],
      budgets: {
        maxWallTimeMs: 60 * 60 * 1000,
        maxAgentCalls: 1,
        maxCpuJobs: 1,
        maxGpuJobs: 0,
        maxTokenCount: 1000,
        maxCostUsd: 1,
        maxMemoryMiB: 512,
      },
      revisionRounds: 2,
      refereeCount: 2,
    }],
  });
  const machineIntakeConfiguration =
    buildAutonomousResearchMachineIntakeConfiguration({
      recurringGoldenTemplates: [],
      machineAppendEnabled: true,
      machineProducerProfileHash: topicProducerProfile.producerProfileHash,
    });
  return Object.freeze({
    machineIntakeConfiguration,
    topicProducerProfile,
    runtimeRefreshPolicy: normalizeRuntimeReproducibilityRefreshPolicy({
      maximumAttemptsPerEpoch: 2,
      maximumCostUsdPerEpoch: 1,
    }),
  });
}

function fixture(root,phase='pre-rebind') {
  if(!root.startsWith('/tmp/hepta-pristine-rust-')) throw new Error('isolated_fixture_required');
  const runtimeRoot=path.join(root,'runtime');
  const provisioning=canonicalProvisioningInputs();
  const service=composeAutonomousResearchStateBusinessSchemaProvisioningService({workspaceRoot:repositoryRoot,runtimeRoot,machineIntakeConfiguration:provisioning.machineIntakeConfiguration,machineIntakeGenesisAuthorityMode:'root-owned-configuration',topicProducerProfile:provisioning.topicProducerProfile,runtimeReproducibilityPolicy:provisioning.runtimeRefreshPolicy});
  const plan=service.plan();const receipt=service.execute({expectedProvisioningPlanId:plan.provisioningPlanId});
  if(!receipt.ready)throw new Error('real_provisioning_not_ready');
  const inventory=resolveAutonomousResearchStateDatabaseInventory({runtimeRoot,manifest:stateDatabaseManifest});
  const instances=[];
  for(const instance of inventory.instances){
    const candidate=path.join(runtimeRoot,instance.sourceRelativePath);const database=new DatabaseSync(candidate);
    try {
      if(instance.role==='submission-handoff'&&phase==='pre-rebind') database.exec('DROP TABLE submission_authorization_consumptions; DELETE FROM handoff_schema_migrations WHERE version=2;');
      for(const sql of MARKER)database.exec(sql);
      if(instance.role==='resident-instance'){
        for(const sql of JOURNAL)database.exec(sql);
        database.prepare('INSERT INTO autonomous_research_online_authority_journal_metadata VALUES(1,1,?,?)').run('autonomous-research-online-authority-journal-v1',JOURNAL_HASH);
      }
      const schemaContractId=instance.role==='submission-handoff'&&phase==='pre-rebind'?'autonomous-submission-handoff-schema-v1':instance.schemaContractId;
      const schemaHash=schemaTransitionExactSchemaHash(database);
      database.prepare(`INSERT INTO autonomous_research_online_mutation_authority_metadata(singleton,schema_version,protocol,database_role,database_instance_id,schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,genesis_global_sequence,genesis_global_hash,genesis_database_sequence,genesis_database_hash,genesis_state_hash,provisioned_at) VALUES(1,1,?,?,?,?,?,?,?,0,?,0,?,?,?)`).run('external-linearizable-reserve-apply-finalize-v1',instance.role,instance.instanceId,schemaContractId,schemaHash,inventory.databaseScopeHash,H('writer'),H('global'),H(`database:${instance.instanceId}`),H(`state:${instance.instanceId}`),START);
      database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      instances.push({databasePath:candidate,databaseRole:instance.role,databaseInstanceId:instance.instanceId,schemaContractId,schemaHash,stateDatabaseManifestHash,phase});
    } finally {database.close();}
  }
  const inspections=instances.map(inspect);
  return {runtimeRoot,instances,inspections,pristineRuntimeStateHash:autonomousResearchPristineRuntimeStateHash(inspections),policyHash:autonomousResearchPristineRuntimeStatePolicyHash({stateDatabaseManifestHash})};
}
function inspect(input){const database=new DatabaseSync(input.databasePath,{readOnly:true});try{return inspectAutonomousResearchPristineDatabaseState({...input,database});}finally{database.close();}}

function ledgerCase(input,root,scenario){
  if(!root.startsWith('/tmp/hepta-pristine-rust-')||!input.databasePath.startsWith('/tmp/hepta-pristine-rust-'))throw new Error('isolated_fixture_required');
  const databasePath=path.join(root,`ledger-${scenario}.sqlite`);fs.copyFileSync(input.databasePath,databasePath);
  const database=new DatabaseSync(databasePath);
  try{
    const backup={version:1,kind:'HeptaStoreBackupReceipt',status:'hepta_store_backup_recorded',sourcePath:"/tmp/Ω'雪/hepta-paper.sqlite",backupPath:"/tmp/Ω'雪/backups/store.sqlite",backupSha256:H('backup'),bytes:8192,createdAt:START};
    const backupHash=hashRecord(backup.kind,backup);
    const subject={status:'hepta_store_restore_drill_passed',backupPath:backup.backupPath,backupSha256:backup.backupSha256,backupLedgerReceiptSha256:backupHash,backupLedgerReceiptId:`store-admin:${backupHash}`,hashMatches:true,quickCheck:'ok',foreignKeyViolationCount:0,performedAt:'2026-09-16T12:00:01.000Z',liveDatabaseSha256Before:H('live')};
    let restore=scenario==='valid-v2'?{version:2,kind:'HeptaStoreRestoreDrillReceipt',...subject,productionStoreMutated:false}:buildHeptaStoreRestoreDrillLedgerSubjectV3(subject);
    if(scenario==='valid-v2')delete restore.liveDatabaseSha256Before;
    if(scenario==='orphan-backup')restore={...restore,backupLedgerReceiptSha256:H('absent'),backupLedgerReceiptId:`store-admin:${H('absent')}`};
    if(scenario==='causal-future-backup')backup.createdAt='2026-09-16T12:00:02.000Z';
    if(scenario==='v3-member-order')restore=Object.fromEntries(Object.entries(restore).reverse());
    const policy=resolveReceiptIssuerPolicy('store-administrator');
    for(const [receipt,evidence] of [[backup,'backup'],[restore,'restore_drill']]){
      let raw=JSON.stringify(receipt);const receiptHash=hashRecord(receipt.kind,receipt);
      if(scenario==='v3-integral-number'&&evidence==='restore_drill')raw=raw.replace('"version":3','"version":3.0').replace('"foreignKeyViolationCount":0','"foreignKeyViolationCount":0.0');
      if(scenario==='invalid-json'&&evidence==='restore_drill')raw='{';
      if(scenario==='duplicate-field'&&evidence==='restore_drill')raw=raw.replace('"version":3','"version":1,"version":3');
      database.prepare(`INSERT INTO receipt_ledger(receipt_id,stream,paper_id,kind,status,receipt_json,receipt_sha256,created_at,environment,evidence_class,release_commit,writer_id,writer_kind,writer_trusted,issuer_policy_id,issuer_policy_hash,issuer_assurance) VALUES(?,'store-admin',NULL,?,?,?,?,?,'administrative',?,NULL,?,?,1,'store-administrator',?,?)`).run(`store-admin:${receiptHash}`,receipt.kind,receipt.status,raw,receiptHash,'2026-09-16T12:00:03.000Z',evidence,policy.writerId,policy.writerKind,policy.issuerPolicyHash,policy.assurance);
    }
  }finally{database.close();}
  const selected={...input,databasePath};let result;try{result={ok:true,value:inspect(selected)}}catch(error){result={ok:false,error:error.message}}return {input:selected,result};
}

const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
for await (const line of rl) {try{const request=JSON.parse(line);let value;if(request.operation==='fixture')value=fixture(request.root,request.phase);else if(request.operation==='inspect')value=inspect(request.input);else if(request.operation==='aggregate')value=autonomousResearchPristineRuntimeStateHash(request.inspections);else if(request.operation==='ledger-case')value=ledgerCase(request.input,request.root,request.scenario);else throw new Error('unknown_operation');process.stdout.write(JSON.stringify({ok:true,value,profile:productionOracleProfile()})+'\n');}catch(error){process.stdout.write(JSON.stringify({ok:false,error:error.message,profile:productionOracleProfile()})+'\n');}}
