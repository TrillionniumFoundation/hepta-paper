// Pure recorded-data contracts only. All canary claims here are fabricated test
// data, not execution evidence, independently signed receipts or authorization.
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
import {buildAutonomousResearchTopicProducerProfile as profile,materializeAutonomousResearchTopicProducerIntake as materialize,buildAutonomousResearchTopicProducerPlannedGeneration as planned,buildAutonomousResearchTopicProducerCapabilityReceipt as capability,verifyAutonomousResearchTopicProducerCapabilityReceipt as verify,verifyAutonomousResearchProviderCanaryPairReceipt as pairVerify} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';
const EVIDENCE='pure_recorded_contract_fixture_no_canary_execution_or_authority';
if(typeof process.argv[2]!=='string'||Buffer.byteLength(process.argv[2])>96*1024)throw Error('topic_generation_oracle_input_bound');
const input=JSON.parse(process.argv[2]);
const sha=c=>'sha256:'+c.repeat(64);
function setup(){
 const families=['rl_stochastic_control_benchmark','ml_algorithm_benchmark','econometrics_panel_benchmark','finance_asset_pricing_benchmark','operations_optimization_benchmark'];
 const producerProfile=profile({producerId:'recorded-contract',implementationSha256:sha('1'),providerConfigurationHash:sha('2'),registeredResearchProfiles:families.map((family,index)=>({profileId:'profile-'+index,objective:'Evaluate preregistered empirical observations '+index+'.',protocolFamily:family,datasetMounts:[{name:'recorded-data',source:'/recorded-contract-only/data-'+index,readOnly:true,manifestHash:sha('3'),licenseId:'CC0-1.0',benchmarkFamily:family}],budgets:{maxWallTimeMs:3600000,maxAgentCalls:24,maxCpuJobs:32,maxGpuJobs:0,maxTokenCount:100000,maxCostUsd:25,maxMemoryMiB:4096},revisionRounds:1,refereeCount:2})),minimumGenerationIntervalMs:3600000,maximumTopicsPerUtcDay:2,maximumProviderCanaryAttemptsPerUtcDay:4,maximumProviderCanaryCostUsdPerUtcDay:1,capabilityValidityMs:input.validity??900000});
 const observedAt=input.observedAt??'2026-09-22T00:00:00.000Z';
 function canary(role,skew=0){const start=new Date(Date.parse(observedAt)-skew).toISOString();const payload={version:1,kind:'CodexModelAvailabilityCanaryReceipt',status:'codex_model_live_canary_verified',selectedModelExecutionCanaryVerified:true,externalActionPerformed:true,externalActionScope:'single_read_only_ephemeral_model_canary',observedAt:start,expiresAt:new Date(Date.parse(start)+900000).toISOString(),fixtureEvidence:true,fixtureRole:role};return {...payload,codexModelAvailabilityCanaryReceiptHash:hashRecord('CodexModelAvailabilityCanaryReceipt',payload)};}
 const author=canary('research_author',input.authorSkew??0),reviewer=canary('formal_reviewer',input.reviewerSkew??0);
 const pairPayload={version:1,kind:'AutonomousResearchProviderCanaryPairReceipt',status:'autonomous_research_provider_canary_pair_verified',verified:true,externalActionPerformed:true,externalActionScope:'two_read_only_ephemeral_model_canaries',freshnessIntervalMs:900000,observedAt,autonomousResearchProviderConfigurationHash:producerProfile.providerConfigurationHash,researchAuthorCapabilityReceiptHash:sha('4'),formalReviewerCapabilityReceiptHash:sha('5'),researchAuthorProviderCanaryReceipt:author,formalReviewerProviderCanaryReceipt:reviewer,researchAuthorProviderCanaryReceiptHash:author.codexModelAvailabilityCanaryReceiptHash,formalReviewerProviderCanaryReceiptHash:reviewer.codexModelAvailabilityCanaryReceiptHash};
 const pair={...pairPayload,providerCanaryPairReceiptHash:hashRecord('AutonomousResearchProviderCanaryPairReceipt',pairPayload)};
 const options={producerProfile,generationSequence:input.sequence??1,admissionCreatedAt:input.admittedAt??observedAt,budgetReservationId:'reservation:recorded'};
 const generation=planned(options);
 const capOptions={producerProfile,machineIntakeConfigurationHash:sha('6'),generationSequence:options.generationSequence,intake:generation.intake,providerCanaryPairReceipt:pair,plannedGeneration:generation,producerLeaseGeneration:3,producerLeaseTokenHash:sha('7'),residentLeaseGeneration:4,residentLeaseTokenHash:sha('8'),capabilityNonce:'producer-nonce:'+'a'.repeat(32),now:observedAt};
 const receipt=capability(capOptions);if(!verify(receipt,{producerProfile,machineIntakeConfigurationHash:capOptions.machineIntakeConfigurationHash,intake:generation.intake,now:observedAt,requireFresh:true}))throw Error('original_recorded_fixture_invalid');
 return {profile:producerProfile,options,materialized:materialize(options),planned:generation,pair,capOptions,capability:receipt};
}
let result;try{
 let value;
 switch(input.action){
 case 'setup':value=setup();break;
 case 'materialize':value=materialize(input.options);break;
 case 'planned':value=planned(input.options);break;
 case 'profile':value=profile(input.options);break;
 case 'capability':value=capability(input.options);break;
 case 'verify':value=verify(input.value,input.options);break;
 case 'pair':value=pairVerify(input.value,input.options);break;
 case 'rehash':{const {[input.field]:ignored,...payload}=input.value;value={...payload,[input.field]:hashRecord(input.domain,payload)};break;}
 default:throw Error('unknown_action');
 }
 result={ok:true,value};
}catch(error){result={ok:false,error:error.message};}
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),evidenceScope:EVIDENCE,...result}));
