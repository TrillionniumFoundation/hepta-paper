// Real original builders, strict dataset observation and actual profile loader.
// Private owned fixtures only; no topic generation, canary or authority hooks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {buildAutonomousResearchTopicProducerProfile,verifyAutonomousResearchTopicProducerProfile} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {inspectAutonomousResearchTopicProducerImplementationIdentity,readAutonomousResearchTopicProducerProfile} from '../../paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs';
import {inspectStrictDatasetManifest} from '../../paper-adapters/runtime/execution-snapshot.mjs';
import {resolveAutonomousResearchProviderConfiguration} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
const EVIDENCE='owned_original_topic_profile_and_dataset_fixture_no_generation_canary_or_independent_acceptance';
if(typeof process.argv[2]!=='string'||Buffer.byteLength(process.argv[2])>64*1024)throw Error('owned_topic_profile_argument_bound');
const input=JSON.parse(process.argv[2]);
const root=path.resolve(input.root);
const stat=fs.lstatSync(root);
if(!root.startsWith(fs.realpathSync(os.tmpdir())+path.sep)||fs.realpathSync(root)!==root||!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o700
 ||fs.readFileSync(path.join(root,'.owned-topic-profile-fixture'),'utf8')!=='owned topic profile fixture\n')throw Error('owned_topic_profile_fixture_required');
const profilePath=path.join(root,'profile.json');
const datasetRoot=path.join(root,'datasets');
const dataPath=path.join(root,'fixture.json');
function write(file,value){fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});fs.chmodSync(file,0o600);}
function inspect(options){
 try{return {ok:true,value:readAutonomousResearchTopicProducerProfile(options)};}
 catch(error){return {ok:false,error:error.message};}
}
function rehash(value,domain,field){
 const {[field]:ignored,...payload}=value;
 return {...payload,[field]:hashRecord(domain,payload)};
}
function setup(){
 fs.mkdirSync(datasetRoot,{mode:0o700});
 const families=input.family?[input.family]:['rl_stochastic_control_benchmark','ml_algorithm_benchmark','econometrics_panel_benchmark','finance_asset_pricing_benchmark','operations_optimization_benchmark'];
 const registeredResearchProfiles=[];
 const manifests=[];
 for(const [index,family] of families.entries()){
  let source;
  if(input.layout==='file'){
   source=path.join(datasetRoot,'data-'+index+'.txt');write(source,'owned empirical fixture '+index+'\n');
  }else{
   source=path.join(datasetRoot,'dataset-'+index);fs.mkdirSync(source,{mode:0o700});
   for(const name of ['a.txt','A.txt','Z.txt','é.txt','e\u0301.txt','空.txt','line\nbreak.txt'])write(path.join(source,name),'owned empirical fixture '+name+'\n');
   fs.mkdirSync(path.join(source,'empty'),{mode:0o700});
   fs.mkdirSync(path.join(source,'inner'),{mode:0o700});
   write(path.join(source,'inner','b.txt'),'owned nested fixture\n');
  }
  const manifest=inspectStrictDatasetManifest(source,datasetRoot);
  if(manifest.blockers.length)throw Error('actual_fixture_manifest_not_ready');
  manifests.push(manifest);
  registeredResearchProfiles.push({profileId:'owned-profile-'+index,objective:'Evaluate the bounded empirical evidence for profile '+index+'.',
   protocolFamily:family,datasetMounts:[{name:'owned-data-'+index,source,readOnly:true,manifestHash:manifest.hash,licenseId:'CC0-1.0',benchmarkFamily:family}],
   budgets:{maxWallTimeMs:3600000,maxAgentCalls:24,maxCpuJobs:32,maxGpuJobs:0,maxTokenCount:100000,maxCostUsd:25,maxMemoryMiB:4096},revisionRounds:1,refereeCount:2});
 }
 const provider=resolveAutonomousResearchProviderConfiguration({environment:{}});
 const implementation=inspectAutonomousResearchTopicProducerImplementationIdentity();
 const profile=buildAutonomousResearchTopicProducerProfile({producerId:'owned-topic-loader',
  implementationSha256:implementation.implementationSha256,providerConfigurationHash:provider.autonomousResearchProviderConfigurationHash,
  registeredResearchProfiles,minimumGenerationIntervalMs:3600000,maximumTopicsPerUtcDay:2,maximumProviderCanaryAttemptsPerUtcDay:4,maximumProviderCanaryCostUsdPerUtcDay:1,capabilityValidityMs:900000});
 if(!verifyAutonomousResearchTopicProducerProfile(profile))throw Error('original_fixture_profile_invalid');
 write(profilePath,profile);
 const environment={HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE:profilePath,HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT:datasetRoot};
 const options={profilePath,datasetRoot,environment,expectedProfileHash:profile.producerProfileHash,expectedProviderConfigurationHash:profile.providerConfigurationHash};
 const expected=inspect(options);if(!expected.ok)throw Error('original_fixture_loader_not_ready:'+expected.error);
 const data={evidenceScope:EVIDENCE,profilePath,datasetRoot,environment,profile,manifests,expected};
 write(dataPath,data);return data;
}
function optionsFor(data){
 const environment=input.environment??data.environment;
 for(const name of ['HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE','HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT']){
  if(environment[name] && !path.resolve(root,environment[name]).startsWith(root+path.sep))throw Error('owned_topic_profile_environment_path_escape');
 }
 const selected=input.profilePath===null?null:input.profilePath??data.profilePath;
 const datasets=input.datasetRoot===null?null:input.datasetRoot??data.datasetRoot;
 for(const candidate of [selected,datasets]){
  if(candidate && !path.resolve(root,candidate).startsWith(root+path.sep))throw Error('owned_topic_profile_selected_path_escape');
 }
 return {profilePath:selected,datasetRoot:datasets,environment,
  expectedProfileHash:input.expectedProfileHash??null,expectedProviderConfigurationHash:input.expectedProviderConfigurationHash??null};
}
let value;
if(input.action==='setup')value=setup();
else{
 const data=JSON.parse(fs.readFileSync(dataPath,'utf8'));
 if(input.action==='inspect')value={evidenceScope:EVIDENCE,...inspect(optionsFor(data))};
 else if(input.action==='refresh-datasets'){
  const original=JSON.parse(fs.readFileSync(profilePath,'utf8'));
  const registeredResearchProfiles=original.registeredResearchProfiles.map(profile=>({...profile,datasetMounts:profile.datasetMounts.map(mount=>{
   if(!path.resolve(mount.source).startsWith(datasetRoot+path.sep))throw Error('owned_topic_profile_refresh_path_escape');
   const manifest=inspectStrictDatasetManifest(mount.source,datasetRoot);
   if(manifest.blockers.length)throw Error('owned_topic_profile_refresh_manifest_blocked');
   return {...mount,manifestHash:manifest.hash};
  })}));
  const profile=buildAutonomousResearchTopicProducerProfile({...original,registeredResearchProfiles});write(profilePath,profile);
  value={evidenceScope:EVIDENCE,profile,...inspect(optionsFor(data))};
 }
 else if(input.action==='rehash-profile'){
  // Rehash mutated actual documents without normalizing or replacing their claims.
  let profile=JSON.parse(fs.readFileSync(profilePath,'utf8'));
  if(input.rehashRegistered===true && Array.isArray(profile.registeredResearchProfiles)){
   profile={...profile,registeredResearchProfiles:profile.registeredResearchProfiles.map(p=>rehash(p,'AutonomousResearchRegisteredTopicProfile','researchProfileHash'))};
  }
  profile=rehash(profile,'AutonomousResearchTopicProducerProfile','producerProfileHash');write(profilePath,profile);
  value={evidenceScope:EVIDENCE,profile,verified:verifyAutonomousResearchTopicProducerProfile(profile),...inspect(optionsFor(data))};
 }else throw Error('owned_topic_profile_action_invalid');
}
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),value}));

