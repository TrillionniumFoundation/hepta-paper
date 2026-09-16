// Test oracle only. Synthetic keys and receipts stay inside the supplied
// temporary fixture root and provide no production authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { inspectSealedReadOnlySubmodules } from '../../paper-adapters/runtime/sealed-readonly-submodule-provenance.mjs';
import { captureReleaseDependencyTree } from '../../paper-adapters/runtime/release-dependency-tree.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { loadCapabilityOperationalProofs, loadCapabilityConformanceProofs, capabilityTargetBindings,
  capabilityConformanceReceiptHash, capabilityConformanceReplayEvidenceHash,
  capabilityConformanceReplayManifestHash, capabilityVerificationCodeProvenanceHash,
} from '../../paper-adapters/governance/capability-proof-verifier.mjs';

const request = JSON.parse(fs.readFileSync(0,'utf8'));
const workspaceRoot = path.join(request.root,'workspace');
const runtimeRoot = path.join(request.root,'runtime');
const assetRoot = path.join(request.root,'assets');
function write(file,value) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600}); }
function read(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
const h = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
function prepare() {
  fs.mkdirSync(workspaceRoot,{recursive:true}); fs.mkdirSync(runtimeRoot,{recursive:true});
  write(path.join(workspaceRoot,'package.json'),{version:'0.1.0'});
  for (const {target} of Object.values(CAPABILITY_CATALOG)) { const file=path.join(workspaceRoot,target);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`// fixture ${target}\n`); }
  const sourcePath='submission/AoM/A_Theory_of__Expectations/main.tex';
  const source='Fixture production subject for a differential test only.\n';
  fs.mkdirSync(path.dirname(path.join(assetRoot,sourcePath)),{recursive:true});fs.writeFileSync(path.join(assetRoot,sourcePath),source);
  const git=(...args)=>execFileSync('git',args,{cwd:workspaceRoot,stdio:'pipe'});
  git('init');git('config','user.email','test@example.invalid');git('config','user.name','Synthetic fixture');git('add','.');git('commit','-m','Synthetic operational parity fixture');
  if(request.sealed) prepareSealed();
  const provenance=currentCodeProvenance({workspaceRoot,allowReleaseCommitEnvironment:false});
  const commit=provenance.commit;
  const productionSubject={paperId:'A_Theory_of__Expectations',sourcePath,sourceHash:h(source)};
  const roles=['capability_owner','operational_observer'];
  const keys=roles.map((role,index)=>{
    const pair=crypto.generateKeyPairSync('ed25519');
    return {privateKeyPem:pair.privateKey.export({type:'pkcs8',format:'pem'}),publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),keyId:`test-${index}`,role};
  });
  write(path.join(runtimeRoot,'owner-acceptance/OWNER_TRUST_STORE.json'),{version:1,kind:'AuthorityTrustStore',keys:keys.map(({publicKeyPem,keyId,role})=>({keyId,algorithm:'ed25519',status:'active',roles:[role],subjectId:`synthetic-${keyId}`,assurance:'external_independent',publicKeyPem}))});
  const bindings=capabilityTargetBindings(workspaceRoot,CAPABILITY_CATALOG);
  const verified=[];
  for(const capabilityId of Object.keys(CAPABILITY_CATALOG).sort()) {
    const common={capabilityId,productionSubject,inputHashes:[productionSubject.sourceHash],releaseCommit:commit,targetHashes:bindings[capabilityId],replayMatched:true};
    let operational={version:2,kind:'CapabilityOperationalReceipt',status:'production_runtime_observation_verified',executionClass:'production_runtime_observation',evidenceEnvironment:'production',evidenceClass:'operational',productionEligible:true,...common,executionReceiptHash:h('execution'),resultHash:h('result'),replayReceiptHash:h('replay')};
    for(const key of keys) operational=signAuthorityDocument(operational,key);
    write(path.join(runtimeRoot,'operational-proof/capabilities',capabilityId,'receipt.json'),operational);
    const firstResult={ok:true,capabilityId,externalActionPerformed:false}; const secondResult={...firstResult};
    const resultHash=hashRecord('CapabilityOperationalResult',{capabilityId,result:firstResult});
    const replayReceiptHash=hashRecord('CapabilityOperationalReplayComparison',{version:1,kind:'CapabilityOperationalReplayComparison',capabilityId,firstResultHash:resultHash,secondResultHash:resultHash,replayMatched:true});
    const evidence={version:2,kind:'CapabilityConformanceReplayEvidence',status:'production_source_bound_conformance_replay_verified',executionClass:'production_source_bound_conformance',evidenceEnvironment:'production_source_bound',evidenceClass:'conformance',productionEligible:false,externalActionPerformed:false,...common,codeProvenance:provenance,codeProvenanceHash:capabilityVerificationCodeProvenanceHash(provenance),firstResult,secondResult,resultHash,replayReceiptHash};
    evidence.executionReceiptHash=capabilityConformanceReplayEvidenceHash(evidence);
    const evidencePath=`conformance-proof/capabilities/${capabilityId}/evidence.json`;
    const receiptPath=`conformance-proof/capabilities/${capabilityId}/receipt.json`;
    let receipt={version:2,kind:'CapabilityConformanceReceipt',status:evidence.status,executionClass:evidence.executionClass,evidenceEnvironment:evidence.evidenceEnvironment,evidenceClass:'conformance',productionEligible:false,externalActionPerformed:false,...common,codeProvenance:provenance,codeProvenanceHash:evidence.codeProvenanceHash,resultHash,replayReceiptHash,executionReceiptHash:evidence.executionReceiptHash,executionEvidencePath:evidencePath};
    receipt.capabilityConformanceReceiptHash=capabilityConformanceReceiptHash(receipt);
    receipt=signAuthorityDocument(receipt,keys[0]);
    write(path.join(runtimeRoot,evidencePath),evidence);write(path.join(runtimeRoot,receiptPath),receipt);
    verified.push({capabilityId,resultHash,replayReceiptHash,executionReceiptHash:evidence.executionReceiptHash,conformanceReceiptHash:receipt.capabilityConformanceReceiptHash,evidencePath,receiptPath});
  }
  const manifest={version:2,kind:'CapabilityConformanceReplayManifest',status:'all_capabilities_conformance_replayed',productionEligible:false,externalActionPerformed:false,releaseCommit:commit,productionSubject,inputHashes:[productionSubject.sourceHash],paperId:productionSubject.paperId,productionSourceHash:productionSubject.sourceHash,capabilityCount:verified.length,verified,codeProvenance:provenance,codeProvenanceHash:capabilityVerificationCodeProvenanceHash(provenance)};
  manifest.capabilityConformanceReplayManifestHash=capabilityConformanceReplayManifestHash(manifest);
  write(path.join(runtimeRoot,'conformance-proof',`CAPABILITY_CONFORMANCE_REPLAY_MANIFEST_${commit.slice(0,12)}.json`),manifest);
}
function prepareSealed() {
  const run=(root,...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'}).toString().trim();
  fs.appendFileSync(path.join(workspaceRoot,'.git/info/exclude'),'\n/deployment-closure/\n');
  const definitions=[['core','core'],['rScientificSourceCas','runtime-images/r-scientific/source-cas']];
  for(const [key,relative] of definitions) {
    const origin=path.join(request.root,'origins',key);fs.mkdirSync(origin,{recursive:true});
    run(origin,'init');run(origin,'config','user.email','test@example.invalid');run(origin,'config','user.name','Synthetic closure fixture');
    fs.writeFileSync(path.join(origin,'payload.dat'),'pointer fixture\n');
    run(origin,'add','.');run(origin,'commit','-m','Fixture gitlink identity');
    run(workspaceRoot,'-c','protocol.file.allow=always','submodule','add','-q',origin,relative);
  }
  run(workspaceRoot,'commit','-qam','Add synthetic closure submodules');
  const submodules={};
  for(const [key,relative] of definitions) {
    const selected=path.join(workspaceRoot,relative);
    fs.writeFileSync(path.join(selected,'payload.dat'),`Hydrated ${key} bytes for a local differential fixture.\n`);
    fs.mkdirSync(path.join(selected,'nested'));fs.writeFileSync(path.join(selected,'nested','δ.dat'),'unicode fixture\n');
    fs.symlinkSync('payload.dat',path.join(selected,'payload-link'));
    submodules[key]={path:relative,commit:run(selected,'rev-parse','HEAD'),tree:run(selected,'rev-parse','HEAD^{tree}'),sealedTree:captureReleaseDependencyTree(selected)};
    fs.chmodSync(selected,0o555);
  }
  const payload={version:2,kind:'HeptaDeploymentToolClosure',submodules};
  const closure={...payload,closureHash:h(JSON.stringify(payload))};
  const file=path.join(workspaceRoot,'deployment-closure','TOOL-CLOSURE.json');
  write(file,closure);fs.chmodSync(file,0o444);fs.chmodSync(path.dirname(file),0o555);fs.chmodSync(workspaceRoot,0o555);
}
function mutate(kind) {
  const capability=Object.keys(CAPABILITY_CATALOG).sort()[0];
  const receipt=path.join(runtimeRoot,'operational-proof/capabilities',capability,'receipt.json');
  const trust=path.join(runtimeRoot,'owner-acceptance/OWNER_TRUST_STORE.json');
  const change=(file,fn)=>{const value=read(file);fn(value);write(file,value);};
  if(kind==='reordered_targets')change(receipt,value=>{value.targetHashes=value.targetHashes.map(item=>({sha256:item.sha256,path:item.path}));});
  if(kind==='reordered_subject')change(path.join(runtimeRoot,'conformance-proof/capabilities',capability,'receipt.json'),value=>{const s=value.productionSubject;value.productionSubject={sourceHash:s.sourceHash,sourcePath:s.sourcePath,paperId:s.paperId};});
  if(kind==='tamper_signature') change(receipt,value=>{value.resultHash=h('tampered');});
  if(kind==='reused_subject') change(trust,value=>{value.keys[1].subjectId=value.keys[0].subjectId;});
  if(kind==='local_assurance') change(trust,value=>{value.keys[1].assurance='local_fixture';});
  if(kind==='duplicate_key') change(trust,value=>{value.keys.push(value.keys[0]);});
  if(kind==='retired_key') change(trust,value=>{value.keys[1].status='retired';});
  if(kind==='missing_trust') fs.unlinkSync(trust);
  if(kind==='malformed_receipt') fs.writeFileSync(receipt,'{broken');
  if(kind==='world_writable') fs.chmodSync(receipt,0o666);
  if(kind==='receipt_symlink') {fs.renameSync(receipt,`${receipt}.backup`);fs.symlinkSync(`${receipt}.backup`,receipt);}
  if(kind==='receipt_hardlink') fs.linkSync(receipt,`${receipt}.link`);
  if(kind==='trust_symlink') {fs.renameSync(trust,`${trust}.backup`);fs.symlinkSync(`${trust}.backup`,trust);}
  if(kind==='dirty_source') fs.appendFileSync(path.join(workspaceRoot,CAPABILITY_CATALOG[capability].target),'// change\n');
  if(kind==='changed_production') fs.appendFileSync(path.join(assetRoot,'submission/AoM/A_Theory_of__Expectations/main.tex'),'change\n');
  if(kind==='bad_conformance') change(path.join(runtimeRoot,'conformance-proof/capabilities',capability,'evidence.json'),value=>{value.firstResult.externalActionPerformed=true;});
  if(kind==='historic_conformance') change(path.join(runtimeRoot,'conformance-proof/capabilities',capability,'receipt.json'),value=>{value.version=1;});
  if(kind==='duplicate_receipt') fs.copyFileSync(receipt,path.join(path.dirname(receipt),'duplicate.json'));
  if(kind==='readonly_root') fs.chmodSync(workspaceRoot,0o555);
  if(kind.startsWith('sealed_')) {
    const file=path.join(workspaceRoot,'deployment-closure','TOOL-CLOSURE.json');
    const rewrite=(change,rehash=true)=>{const value=read(file);change(value);if(rehash){const{closureHash,...payload}=value;value.closureHash=h(JSON.stringify(payload));}fs.chmodSync(file,0o644);write(file,value);fs.chmodSync(file,0o444);};
    if(kind==='sealed_bad_hash')rewrite(value=>{value.closureHash=h('tampered');},false);
    if(kind==='sealed_bad_commit')rewrite(value=>{value.submodules.core.commit='f'.repeat(40);});
    if(kind==='sealed_bad_tree')rewrite(value=>{value.submodules.core.tree='f'.repeat(40);});
    if(kind==='sealed_bad_content')fs.appendFileSync(path.join(workspaceRoot,'core/payload.dat'),'tampered\n');
    if(kind==='sealed_writable_file')fs.chmodSync(file,0o644);
    if(kind==='sealed_writable_root')fs.chmodSync(workspaceRoot,0o755);
    if(kind==='sealed_writable_submodule')fs.chmodSync(path.join(workspaceRoot,'core'),0o755);
    if(kind==='sealed_bad_keys')rewrite(value=>{value.submodules.extra={};});
    if(kind==='sealed_noncanonical'){fs.chmodSync(file,0o644);fs.appendFileSync(file,' \n');fs.chmodSync(file,0o444);}
    if(kind==='sealed_missing'){fs.chmodSync(path.dirname(file),0o755);fs.unlinkSync(file);}
    if(kind==='sealed_hardlink'){fs.chmodSync(path.dirname(file),0o755);fs.linkSync(file,`${file}.link`);fs.chmodSync(path.dirname(file),0o555);}
    if(kind==='sealed_symlink'){fs.chmodSync(path.dirname(file),0o755);fs.renameSync(file,`${file}.backup`);fs.symlinkSync(`${file}.backup`,file);fs.chmodSync(path.dirname(file),0o555);}
  }
  if(kind==='missing_operational') fs.rmSync(path.join(runtimeRoot,'operational-proof'),{recursive:true});
}
try {
if(request.prepare)prepare();
if(request.mutate)mutate(request.mutate);
if(request.inspectSealed){
  const inspection=inspectSealedReadOnlySubmodules({workspaceRoot});
  process.stdout.write(JSON.stringify({profile:{node:process.version},inspection}));
} else {
const codeProvenance=currentCodeProvenance({workspaceRoot,allowReleaseCommitEnvironment:false});
const options={workspaceRoot,runtimeRoot,assetRoot,capabilityCatalog:CAPABILITY_CATALOG,releaseCommit:codeProvenance.commit,codeProvenance};
const proofs=loadCapabilityOperationalProofs(options);const conformance=loadCapabilityConformanceProofs(options);
const capabilities=Object.keys(CAPABILITY_CATALOG).sort().map(capabilityId=>({capabilityId,operationallyProven:proofs.has(capabilityId),operationalReceiptHashes:proofs.get(capabilityId)?.operationalReceiptHashes||[],conformanceVerified:conformance.has(capabilityId),conformanceReceiptHashes:conformance.get(capabilityId)?.conformanceReceiptHashes||[],conformanceIssuerAssurances:conformance.get(capabilityId)?.issuerAssurances||[]}));
const status={version:1,kind:'CapabilityOperationalProofStatus',status:capabilities.every(item=>item.operationallyProven)?'all_capabilities_operationally_proven':'capability_operational_proof_pending',releaseCommit:codeProvenance.commit,capabilityCount:capabilities.length,operationallyProven:capabilities.filter(item=>item.operationallyProven).length,operationallyPending:capabilities.filter(item=>!item.operationallyProven).length,conformanceVerified:capabilities.filter(item=>item.conformanceVerified).length,conformancePending:capabilities.filter(item=>!item.conformanceVerified).length,conformanceCannotQualifyAsOperationalProof:true,externalOwnerSignatureRequired:true,capabilities};
process.stdout.write(JSON.stringify({profile:{node:process.version},status,codeProvenance}));

}
} catch(error) { process.stdout.write(JSON.stringify({profile:{node:process.version},error:error.message})); }
