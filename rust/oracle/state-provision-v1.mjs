// Actual Node constructors and public ephemeral-signature fixtures only.
// No provider, production authority root, installed credential or live service is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {hashRecord,hashBytes} from '../../workflow-kernel/record-hash.mjs';
import {signAuthorityDocument} from '../../paper-adapters/authority/authority-signatures.mjs';
import {installAutonomousResearchMachineIntakeExternalAuthorityTestDouble} from '../../paper-core/tests/test-doubles/autonomous-research-machine-intake-authority-rotation-authorization.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const real=relative=>pathToFileURL(fs.realpathSync(new URL(relative,import.meta.url))).href;
const authority=real('../../paper-adapters/automation/autonomous-research-machine-intake-authority.mjs');
const authorization=real('../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs');
const double=real('../../paper-core/tests/test-doubles/autonomous-research-machine-intake-authority-rotation-authorization.mjs');
registerHooks({resolve(specifier,context,next){const resolved=next(specifier,context);return context.parentURL?.split('?')[0]===authority&&resolved.url===authorization?{shortCircuit:true,url:double}:resolved;}});
const {buildAutonomousResearchMachineIntakeConfiguration}=await import('../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs');
const {composeAutonomousResearchStateBusinessSchemaProvisioningService}=await import('../../paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs');
if(typeof process.argv[2]!=='string'||Buffer.byteLength(process.argv[2])>65536)throw Error('fixture_argument_bound');
const input=JSON.parse(process.argv[2]);
const root=path.resolve(input.root);
const stat=fs.lstatSync(root);
if(!root.startsWith(fs.realpathSync(os.tmpdir())+'/hepta-native-provision-test-')||fs.realpathSync(root)!==root||!stat.isDirectory()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o700)throw Error('owned_fixture_required');
function write(name,value){const p=path.join(root,name);fs.writeFileSync(p,typeof value==='string'?value:JSON.stringify(value),{mode:0o600,flag:'wx'});return {path:p,sha256:hashBytes(fs.readFileSync(p))};}
write('.owned-topic-profile-fixture','owned topic profile fixture\n');
const topicRun=spawnSync(process.execPath,[path.join(ROOT,'rust/oracle/topic-producer-profile-v1.mjs'),JSON.stringify({action:'setup',root,layout:'file',family:'ml_algorithm_benchmark'})],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,LANG:'en_US.UTF-8'}});
if(topicRun.status!==0)throw Error('original_topic_fixture_failed:'+topicRun.stderr);
const topic=JSON.parse(topicRun.stdout).value.profile;
const machine=buildAutonomousResearchMachineIntakeConfiguration({recurringGoldenTemplates:[],machineAppendEnabled:true,machineProducerProfileHash:topic.producerProfileHash});
const machinePin=write('machine.json',machine);
const early=new Date(Date.now()-10000).toISOString();
const later=new Date(Date.now()+3600000).toISOString();
const keyEffective=new Date(Date.now()-3600000).toISOString();
const roles=['capability_owner','operational_observer'];
const pairs=roles.map(()=>crypto.generateKeyPairSync('ed25519'));
const trust={version:1,kind:'AuthorityTrustStore',keys:pairs.map((pair,i)=>({algorithm:'ed25519',effectiveFrom:keyEffective,expiresAt:later,keyId:`test-key:${i}`,organization:'disposable-test-only',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),revokedAt:null,roles:[roles[i]],status:'active',subjectId:`test-subject:${i}`}))};
let envelope={version:1,kind:'AutonomousResearchMachineIntakeAuthorityGenesisEnvelope',status:'external_genesis_authority_verified',configurationHash:machine.configurationHash,producerProfileHash:topic.producerProfileHash,authorityGeneration:1,ownerTrustStoreHash:hashRecord('AuthorityTrustStore',trust),nonce:'native-provision:disposable-test',signedAt:early,validFrom:early,expiresAt:later,signatures:[]};
for(let i=0;i<2;i++)envelope=signAuthorityDocument(envelope,{privateKeyPem:pairs[i].privateKey.export({type:'pkcs8',format:'pem'}),keyId:`test-key:${i}`,role:roles[i]});
const documents={ownerTrustStore:trust,genesisEnvelope:envelope,rotationTrustStore:{},bootstrapReceipt:{}};
installAutonomousResearchMachineIntakeExternalAuthorityTestDouble(()=>documents);
const pins=Object.fromEntries(Object.entries(documents).map(([name,value])=>[name,write(name+'.json',value)]));
const manifest=write('genesis-inputs.json',{version:1,kind:'NativeStateProvisioningGenesisInputsV1',...pins});
const runtimeRoot=path.join(root,'node-runtime');
const service=composeAutonomousResearchStateBusinessSchemaProvisioningService({workspaceRoot:ROOT,runtimeRoot,machineIntakeConfiguration:machine,machineIntakeGenesisAuthorityMode:'external',topicProducerProfile:topic,runtimeReproducibilityPolicy:{maximumAttemptsPerEpoch:2,maximumCostUsdPerEpoch:1}});
const plan=service.plan();const receipt=service.execute({expectedProvisioningPlanId:plan.provisioningPlanId});
if(receipt.ready!==true)throw Error('original_ten_database_provisioning_failed');
const definitions=JSON.parse(fs.readFileSync(path.join(ROOT,'paper-core/config/autonomous-research-state-databases.v1.json'),'utf8')).databases;
const databases=definitions.map(definition=>{
 const db=new DatabaseSync(path.join(runtimeRoot,definition.relativePath),{readOnly:true});
 try {
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all();
  const rows=Object.fromEntries(schema.filter(s=>s.type==='table').map(s=>[s.name,db.prepare('SELECT * FROM "'+s.name.replaceAll('"','""')+'" ORDER BY rowid').all()]));
  return {role:definition.role,relative:definition.relativePath,schema,rows};
 }finally{db.close();}
});
const result={evidenceScope:'actual_node_constructors_ephemeral_test_signatures_not_production_qualification',root,machine:machinePin.path,topic:path.join(root,'profile.json'),datasets:path.join(root,'datasets'),genesisInputs:manifest,documents:pins,databases};
write('node-expected.json',result);
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),value:result}));
