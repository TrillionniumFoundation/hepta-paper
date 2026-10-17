// Source-only differential fixture. Actual incumbent owners create and verify
// ephemeral local-purpose authority; these keys grant no external capability.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repository,root,action='create',variant='normal']=process.argv.slice(2);
const load=(name)=>import(pathToFileURL(path.join(repository,name)).href);
const {inspectLocalGoldenDatasetProvisioning,executeLocalGoldenDatasetProvisioning}=await load('paper-adapters/automation/local-golden-dataset-provisioner.mjs');
const {readOperatorDatasetHarness}=await load('paper-adapters/automation/operator-dataset-harness-reader.mjs');
const {buildCanonicalAnalysisProtocol}=await load('paper-domain/automation/analysis-protocol-contract.mjs');
const {buildCampaignBenchmarkSelector}=await load('paper-domain/automation/campaign-benchmark-selector.mjs');
const constants=await load('paper-domain/automation/operator-dataset-harness-contract.mjs');
const {hashRecord}=await load('workflow-kernel/record-hash.mjs');
const {signAuthorityDocument}=await load('paper-adapters/authority/authority-signatures.mjs');
const write=(file,value)=>{fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});fs.chmodSync(file,0o600);};
const runtimeRoot=path.join(root,'runtime'),controlRoot=path.join(root,'control'),datasetRoot=path.join(root,'dataset');
if(action==='create'){
 for(const directory of [runtimeRoot,controlRoot,datasetRoot,path.join(root,'secrets')])fs.mkdirSync(directory,{mode:0o700});
 fs.writeFileSync(path.join(datasetRoot,'train.csv'),'feature,label\n1,0\n',{mode:0o444});
 fs.chmodSync(datasetRoot,0o555);
 const name='local-golden-ml',family='ml_algorithm_benchmark',seedSchedule=Array.from({length:32},(_,i)=>1000+i);
 const harness={version:1,kind:'OperatorAuthorizedDatasetBenchmarkHarness',benchmarkId:name,benchmarkFamily:family,seedSchedule,minimumRepetitions:1,cells:seedSchedule.map(seed=>({seed,repetition:1,cases:Array.from({length:8},(_,caseIndex)=>({caseId:hashRecord('LocalGoldenDatasetTestCase',{seed,caseIndex}),input:{primary:seed+caseIndex,secondary:caseIndex/10},ablationInput:{secondary:caseIndex/10},referenceResponse:0,oracle:{label:caseIndex%2,robustLabel:caseIndex%2}}))}))};
 const design=buildCampaignBenchmarkSelector({benchmarkId:family}).experimentDesign;
 const {analysisProtocolHash:_hash,...analysis}=buildCanonicalAnalysisProtocol({benchmarkId:name,benchmarkFamily:family,requiredMetrics:design.requiredMetrics,metricSpecs:design.metricSpecs});
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
 const trust={version:1,kind:'AuthorityTrustStore',authorityScope:constants.LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,evidenceClass:constants.LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,academicPromotionEligible:false,externalTrustClaimed:false,keyPurpose:constants.LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,keys:[{keyId:'local-golden-dataset-key',subjectId:'local-golden-dataset-operator',algorithm:'ed25519',publicKeyPem:publicKey.export({type:'spki',format:'pem'}),roles:[constants.LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE],keyPurpose:constants.LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,authorityScope:constants.LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,academicPromotionEligible:false,externalTrustClaimed:false,status:'active'}]};
 const files={splitAssignmentsPath:path.join(controlRoot,'splits.json'),harnessDefinitionPath:path.join(controlRoot,'hidden.json'),analysisProtocolPath:path.join(controlRoot,'analysis.json'),researchSemanticsPath:path.join(controlRoot,'semantics.json'),authorityTrustStorePath:path.join(controlRoot,'trust.json'),authorityPrivateKeyPath:path.join(root,'secrets/key.pem'),mountOutputPath:path.join(controlRoot,'mount.json')};
 write(files.splitAssignmentsPath,{version:1,kind:'LocalGoldenDatasetSplitAssignments',datasetName:name,entries:[{path:'train.csv',split:'train'}]});write(files.harnessDefinitionPath,harness);write(files.analysisProtocolPath,analysis);
 write(files.researchSemanticsPath,{version:1,kind:'OperatorDatasetResearchSemantics',population:'Rows in the frozen local golden training dataset.',variables:['feature','label'],intervention:'Apply the bounded candidate classifier.',comparator:'Compare with baseline and ablation classifiers.',estimands:['paired hidden-evaluation metric difference'],datasetConstraints:['local operator fixture; no external dataset-owner qualification'],eligibleSplits:['train']});
 write(files.authorityTrustStorePath,trust);
 fs.writeFileSync(files.authorityPrivateKeyPath,privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
 const now=new Date(),options={workspaceRoot:'/repository/hepta-paper',protectedRoots:[],runtimeRoot,controlRoot,isolationId:'golden-test-isolation',datasetName:name,datasetRoot,datasetLicenseId:'LicenseRef-Local-Golden-Test-Terms',...files,authorityKeyId:'local-golden-dataset-key',signedAt:new Date(now.getTime()-60000).toISOString(),expiresAt:new Date(now.getTime()+86400000).toISOString(),now};
 const inspected=inspectLocalGoldenDatasetProvisioning(options);
 executeLocalGoldenDatasetProvisioning({...options,expectedPlanId:inspected.plan.localGoldenDatasetProvisioningPlanId});
 let [mount]=JSON.parse(fs.readFileSync(files.mountOutputPath,'utf8'));
 const trustPath=path.join(runtimeRoot,'trust/AUTHORITY_TRUST_STORE.json');
 if(variant==='license')mount.licenseId='LicenseRef-Wrong';
 if(variant==='promotion')mount.academicPromotionEligible=true;
 if(variant==='revoked'){const current=JSON.parse(fs.readFileSync(trustPath,'utf8'));current.keys[0].status='revoked';write(trustPath,current);}
 if(variant==='float-version'){const raw=fs.readFileSync(trustPath,'utf8').replace('"version": 1,','"version": 1.0,');assert.match(raw,/1\.0/);fs.writeFileSync(trustPath,raw);}
 if(variant==='duplicates'){
  const current=JSON.parse(fs.readFileSync(trustPath,'utf8'));
  for(const id of ['\uE000','😀'])for(let i=0;i<2;i++)current.keys.push({...current.keys[0],keyId:id});
  write(trustPath,current);
 }
 if(variant==='expired'){
  const envelopePath=path.join(runtimeRoot,'private/dataset-harness-envelopes',mount.operatorDatasetHarnessHandle.slice(7)+'.json');
  const envelope=JSON.parse(fs.readFileSync(envelopePath,'utf8'));
  const {signatures:_signatures,...payload}=envelope.authority;
  envelope.authority=signAuthorityDocument({...payload,expiresAt:new Date(Date.now()-1000).toISOString()},{privateKeyPem:privateKey,keyId:'local-golden-dataset-key',role:constants.LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE});
  const validated=constants.validateOperatorDatasetHarnessEnvelope(envelope,{datasetName:mount.name,datasetManifestHash:mount.manifestHash});
  const bytes=Buffer.from(JSON.stringify(envelope)+'\n'),handle='sha256:'+crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(runtimeRoot,'private/dataset-harness-envelopes',handle.slice(7)+'.json'),bytes,{mode:0o600});
  mount={...mount,operatorAuthorizationHash:validated.operatorDatasetAuthorityDocumentHash,operatorDatasetAuthorityDocumentHash:validated.operatorDatasetAuthorityDocumentHash,operatorDatasetAuthority:validated.authority,benchmarkHarnessDocumentHash:handle,operatorDatasetHarnessHandle:handle};
 }
 if(variant==='subjects'){
  const envelopePath=path.join(runtimeRoot,'private/dataset-harness-envelopes',mount.operatorDatasetHarnessHandle.slice(7)+'.json');
  const envelope=JSON.parse(fs.readFileSync(envelopePath,'utf8'));
  const second=crypto.generateKeyPairSync('ed25519');
  envelope.authority=signAuthorityDocument(envelope.authority,{privateKeyPem:second.privateKey,keyId:'local-second-key',role:constants.LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE});
  const current=JSON.parse(fs.readFileSync(trustPath,'utf8'));current.keys[0].subjectId='\uE000';current.keys.push({...current.keys[0],keyId:'local-second-key',subjectId:'😀',publicKeyPem:second.publicKey.export({type:'spki',format:'pem'})});write(trustPath,current);
  const validated=constants.validateOperatorDatasetHarnessEnvelope(envelope,{datasetName:mount.name,datasetManifestHash:mount.manifestHash});
  const bytes=Buffer.from(JSON.stringify(envelope)+'\n'),handle='sha256:'+crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(runtimeRoot,'private/dataset-harness-envelopes',handle.slice(7)+'.json'),bytes,{mode:0o600});
  mount={...mount,operatorAuthorizationHash:validated.operatorDatasetAuthorityDocumentHash,operatorDatasetAuthorityDocumentHash:validated.operatorDatasetAuthorityDocumentHash,operatorDatasetAuthority:validated.authority,benchmarkHarnessDocumentHash:handle,operatorDatasetHarnessHandle:handle};
 }
 write(path.join(root,'mount.json'),mount);
}
const mount=JSON.parse(fs.readFileSync(path.join(root,'mount.json'),'utf8')),trust=JSON.parse(fs.readFileSync(path.join(runtimeRoot,'trust/AUTHORITY_TRUST_STORE.json'),'utf8'));
const result=readOperatorDatasetHarness(mount,{authorityTrustStore:trust,runtimeRoot});
fs.writeFileSync(path.join(root,'oracle.json'),JSON.stringify(result.receipt),{mode:0o600});
assert.equal(result.receipt.externalActionPerformed,false);assert.equal(result.receipt.rawOraclePublished,false);assert.equal(result.receipt.hostOnlyHarnessMounted,false);
console.log(JSON.stringify({node:process.version,icu:process.versions.icu,cldr:process.versions.cldr,unicode:process.versions.unicode,profile:'node22.23.1-icu78.2-cldr48-en-US-v1',collator:new Intl.Collator().resolvedOptions(),source_sha256:'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(path.join(repository,'workflow-kernel/record-hash.mjs'))).digest('hex'),status:result.receipt.status,privateDefinitionAvailable:!!result.privateDefinition,sourceOnly:true,externalActionPerformed:false}));
