// Test oracle only. Synthetic keys and receipts stay inside the supplied
// temporary fixture root and provide no production authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { captureReleaseDependencyTree } from '../../paper-adapters/runtime/release-dependency-tree.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { capabilityTargetBindings,
  capabilityConformanceReceiptHash, capabilityConformanceReplayEvidenceHash,
  capabilityConformanceReplayManifestHash, capabilityVerificationCodeProvenanceHash,
} from '../../paper-adapters/governance/capability-proof-verifier.mjs';

const request = JSON.parse(process.argv[2]);
const incumbentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceRoot = path.join(request.root,'workspace');
const runtimeRoot = path.join(request.root,'hepta-paper-runtime/native-runtime');
const assetRoot = path.join(request.root,'hepta-paper-assets');
function write(file,value) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{mode:0o600}); }
function read(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
const h = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
const copied=[];
function copyActual(relative) {
  if(!relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(p=>p==='..'||p==='.')) throw new Error('oracle_source_path_invalid');
  if(copied.some(p=>p.path===relative)) return;
  const file=path.join(incumbentRoot,relative), before=fs.lstatSync(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>4n*1024n*1024n||copied.length>=1024)throw new Error('oracle_source_identity_invalid');
  const bytes=fs.readFileSync(file), after=fs.lstatSync(file,{bigint:true});
  for(const k of ['dev','ino','mode','size','mtimeNs','ctimeNs']) if(before[k]!==after[k])throw new Error('oracle_source_changed');
  if(copied.reduce((sum,p)=>sum+p.bytes,0)+bytes.length>32*1024*1024)throw new Error('oracle_source_budget_exceeded');
  const destination=path.join(workspaceRoot,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,bytes,{mode:0o600});
  copied.push({path:relative,bytes:bytes.length,sha256:h(bytes)});
}
function copyActualClosure() {
  const pending=['paper-core/bin/release-trust-gate.mjs'];
  copyActual('package.json');copyActual('paper-core/config/release-dependency-tree.v1.json');
  while(pending.length) {
    const relative=pending.pop(); if(copied.some(p=>p.path===relative))continue;
    copyActual(relative);
    if(!relative.endsWith('.mjs'))continue;
    const source=fs.readFileSync(path.join(incumbentRoot,relative),'utf8');
    const ast=espree.parse(source,{ecmaVersion:'latest',sourceType:'module'});
    const imports=[];
    function visit(node) {
      if(!node||typeof node!=='object')return;
      if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)imports.push(node.source.value);
      if(node.type==='NewExpression'&&node.callee.type==='Identifier'&&node.callee.name==='URL'&&node.arguments[0]?.type==='Literal'&&typeof node.arguments[0].value==='string'&&node.arguments[1]?.type==='MemberExpression'&&node.arguments[1].object.type==='MetaProperty')imports.push(node.arguments[0].value);
      if(node.type==='ImportExpression') {
        if(node.source.type==='Literal'&&typeof node.source.value==='string')imports.push(node.source.value);
        // Dynamic nonliteral imports are not executed by this nullary read-only route.
      }
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
    }
    visit(ast);
    for(const specifier of imports) {
      if(specifier.startsWith('node:'))continue;
      if(!specifier.startsWith('.'))throw new Error(`oracle_bare_import_not_pinned:${specifier}`);
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative),specifier)));
    }
  }
}
function createImplementation(provenance) {
  const testPath='migration/tests/trust-fixture.mjs', testHash=h(fs.readFileSync(path.join(workspaceRoot,testPath)));
  const codeProvenanceHash=capabilityVerificationCodeProvenanceHash(provenance);
  const receipts=Object.entries(CAPABILITY_CATALOG).map(([capabilityId,{target}])=>{
    const receipt={version:2,kind:'CapabilityVerificationReceipt',status:'capability_implementation_verified',capabilityId,codeProvenance:provenance,codeProvenanceHash,test:{path:testPath,sha256:testHash,result:'passed'},targets:[{path:target,sha256:h(fs.readFileSync(path.join(workspaceRoot,target)))}]};
    receipt.capabilityVerificationReceiptHash=hashRecord('CapabilityVerificationReceipt',receipt);return receipt;
  });
  const manifest={version:2,kind:'CapabilityVerificationManifest',codeProvenance:provenance,codeProvenanceHash,receipts};
  manifest.capabilityVerificationManifestHash=hashRecord('CapabilityVerificationManifest',manifest);
  write(path.join(runtimeRoot,'audits/capability-verification/CAPABILITY_VERIFICATION_MANIFEST.json'),manifest);
}
function mutateTrust(kind) {
  if(kind==='numeric_lexemes') {
    const pending=[runtimeRoot];while(pending.length){const file=pending.pop(),stat=fs.lstatSync(file);if(stat.isDirectory()){for(const n of fs.readdirSync(file))pending.push(path.join(file,n));}else if(file.endsWith('.json')){const raw=fs.readFileSync(file,'utf8').replace(/("version": [12])([,\n])/g,'$1.0$2').replace(/("repositoryEntryCount": [0-9]+)([,\n])/g,'$1.0$2');fs.writeFileSync(file,raw);}}
    return;
  }
  const file=path.join(runtimeRoot,'audits/capability-verification/CAPABILITY_VERIFICATION_MANIFEST.json');
  if(kind==='missing_manifest'){fs.unlinkSync(file);return;}
  if(kind==='bad_manifest_hash'){const v=read(file);v.capabilityVerificationManifestHash=h('wrong');write(file,v);return;}
  if(kind==='duplicate_implementation'||kind==='bad_receipt_hash'||kind==='unsafe_target'||kind==='null_receipts'||kind==='zero_receipts'||kind==='string_receipts'||kind==='bad_test_result'||kind==='missing_test') {
    const v=read(file);
    if(kind==='duplicate_implementation')v.receipts.push(v.receipts[0]);
    if(kind==='null_receipts')v.receipts=null;
    if(kind==='zero_receipts')v.receipts=0;
    if(kind==='string_receipts')v.receipts='primitive-list';
    if(kind==='bad_receipt_hash')v.receipts[0].capabilityVerificationReceiptHash=h('wrong');
    if(kind==='unsafe_target') {v.receipts[0].targets[0].path='../escape';}
    if(kind==='bad_test_result')v.receipts[0].test.result='failed';
    if(kind==='missing_test')v.receipts[0].test.path='migration/tests/not-present.mjs';
    if(['unsafe_target','bad_test_result','missing_test'].includes(kind)){const{capabilityVerificationReceiptHash,ledgerReceiptId,...payload}=v.receipts[0];v.receipts[0].capabilityVerificationReceiptHash=hashRecord('CapabilityVerificationReceipt',payload);}
    const{capabilityVerificationManifestHash,...payload}=v;v.capabilityVerificationManifestHash=hashRecord('CapabilityVerificationManifest',payload);write(file,v);return;
  }
  mutate(kind);
}
function prepare() {
  fs.mkdirSync(workspaceRoot,{recursive:true}); fs.mkdirSync(runtimeRoot,{recursive:true});
  copyActualClosure();
  for (const {target} of Object.values(CAPABILITY_CATALOG)) copyActual(target);
  fs.mkdirSync(path.join(workspaceRoot,'migration/tests'),{recursive:true});
  fs.writeFileSync(path.join(workspaceRoot,'migration/tests/trust-fixture.mjs'),'// Descriptive imported implementation fixture; no execution qualification.\n');
  const sourcePath='submission/AoM/A_Theory_of__Expectations/main.tex';
  const source='Fixture production subject for a differential test only.\n';
  fs.mkdirSync(path.dirname(path.join(assetRoot,sourcePath)),{recursive:true});fs.writeFileSync(path.join(assetRoot,sourcePath),source);
  const git=(...args)=>execFileSync('git',args,{cwd:workspaceRoot,stdio:'pipe'});
  git('init');fs.appendFileSync(path.join(workspaceRoot,'.git/info/exclude'),'\n/bin/\n');git('config','user.email','test@example.invalid');git('config','user.name','Synthetic fixture');git('add','.');git('commit','-m','Synthetic operational parity fixture');
  if(request.sealed) prepareSealed();
  const provenance=currentCodeProvenance({workspaceRoot,allowReleaseCommitEnvironment:false});
  const commit=provenance.commit;
  createImplementation(provenance);
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
if(request.operation==='prepare') {
  prepare();
  process.stdout.write(JSON.stringify({version:1,node:process.version,workspaceRoot,runtimeRoot,assetRoot,closure:copied,realAuthorityCreated:false}));
} else if(request.operation==='mutate') {
  mutateTrust(request.mutate);
  process.stdout.write(JSON.stringify({node:process.version,mutated:request.mutate}));
} else if(request.operation==='run') {
  const env={...process.env,HEPTA_PAPER_RUNTIME_ROOT:request.relative?'../hepta-paper-runtime/native-runtime':runtimeRoot,HEPTA_PAPER_ASSET_ROOT:request.relative?'../hepta-paper-assets':assetRoot};
  if(request.defaults){delete env.HEPTA_PAPER_RUNTIME_ROOT;delete env.HEPTA_PAPER_ASSET_ROOT;}
  delete env.HEPTA_RELEASE_COMMIT;
  const result=spawnSync(process.execPath,[path.join(workspaceRoot,'paper-core/bin/release-trust-gate.mjs')],{cwd:workspaceRoot,env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
  if(result.error) throw result.error;
  process.stdout.write(JSON.stringify({node:process.version,exitCode:result.status,stdout:result.stdout,stderr:result.stderr}));
} else throw new Error('trust_oracle_operation_invalid');
