// Test oracle only. Temporary signers attest synthetic OCI identities and never
// execute Docker, access production verifiers, or qualify a production image.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import { inspectRuntimeImageBuildInputClosures } from '../../paper-adapters/automation/runtime-image-build-input-closure.mjs';
import { readRuntimeImageReproducibilityProcessConfiguration } from '../../paper-adapters/automation/runtime-image-reproducibility-process-identity.mjs';
import { runtimeImageReproducibilityCodeProvenanceHash, runtimeImageReproducibilityReleaseIdentityHash, buildRuntimeImageReproducibilityReceipt, buildRuntimeImageReproducibilityRequest, runtimeImageReproducibilityResponseSigningPayloadHash, verifyRuntimeImageReproducibilityReceipt, RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE as scope } from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import {AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE as pluginPackage,AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY as registry,AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION as startup,AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES as rawProfiles,compileAutonomousEmpiricalFamilyPluginRegistry,compileAutonomousEmpiricalFamilyPluginPackage,verifyAutonomousEmpiricalFamilyPluginSignedBundle} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {immutableAuthoritySigningPayload} from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import {currentCodeProvenance} from '../../paper-adapters/runtime/code-provenance.mjs';
import {hashRecord} from '../../workflow-kernel/record-hash.mjs';
const H=value=>`sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const input=JSON.parse(process.argv[2] ?? fs.readFileSync(0,'utf8'));
function fixtureNodeDirectory(root){
 if(!root.startsWith(path.join(os.tmpdir(),'hepta-runtime-image-rust-')))throw new Error('isolated_fixture_required');
 const directory=path.join(root,'private-toolchain');fs.mkdirSync(directory,{mode:0o700});
 const executable=path.join(directory,'node');fs.copyFileSync(process.execPath,executable);fs.chmodSync(executable,0o500);
 return directory;
}
function verify(fixture,receipt,overrides={}){
 const context={now:'2026-07-16T08:00:45.000Z',currentCodeProvenanceHash:fixture.request.codeProvenanceHash,currentReleaseIdentityHash:fixture.request.releaseIdentityHash,currentInputs:fixture.inputs,configuration:fixture.configuration,profilePolicies:fixture.profilePolicies,...overrides,verifySignature:({signingPayloadHash,signature,verifier})=>{
  const i=fixture.configuration.verifiers.findIndex(v=>v.serviceId===verifier.serviceId);
  return i>=0&&crypto.verify(null,Buffer.from(signingPayloadHash),fixture.publicKeys[i],Buffer.from(signature,'base64'));
 }};
 return verifyRuntimeImageReproducibilityReceipt(receipt,context);
}
if(input.operation==='workflow'){
 const root=input.root;const workspace=path.join(root,'workspace');fs.mkdirSync(workspace,{mode:0o700});const repository=path.resolve(import.meta.dirname,'../..');
 for(const name of ['python-scientific','python-gpu'])fs.cpSync(path.join(repository,'runtime-images',name),path.join(workspace,'runtime-images',name),{recursive:true});fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({version:'1.0.0'}));
 for(const args of [['init','--quiet'],['add','.'],['-c','user.name=Isolated Test','-c','user.email=isolated@example.invalid','commit','--quiet','-m','fixture']])execFileSync('git',args,{cwd:workspace,stdio:'pipe'});
 const configPath=path.join(root,'configuration.json');const document=JSON.parse(fs.readFileSync(configPath,'utf8'));const helper=pathToFileURL(path.join(repository,'rust/oracle/runtime-image-isolated-verifier-v1.mjs')).href;
 document.verifiers.forEach((v,index)=>{const n=index+1;const pair=crypto.generateKeyPairSync('ed25519');const keyPath=path.join(root,`isolated-private-${n}.pem`),identityPath=path.join(root,`service-${n}.json`);fs.writeFileSync(keyPath,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});fs.writeFileSync(v.attestor.publicKeyPath,pair.publicKey.export({type:'spki',format:'pem'}));const executable=path.join(root,`live-verifier-${n}.mjs`);fs.writeFileSync(executable,`#!/usr/bin/env node\nimport fs from 'node:fs';\nimport {response} from ${JSON.stringify(helper)};\nlet text='';for await(const chunk of process.stdin)text+=chunk;const request=JSON.parse(text);process.stdout.write(JSON.stringify(response(request,JSON.parse(fs.readFileSync(${JSON.stringify(identityPath)},'utf8')),fs.readFileSync(${JSON.stringify(keyPath)},'utf8'))));\n`,{mode:0o755});v.command.executable=executable;});
 fs.writeFileSync(configPath,JSON.stringify(document,null,2)+'\n');const environment={...input.environment,PATH:fixtureNodeDirectory(root)+':/usr/bin:/bin'};const configuration=readRuntimeImageReproducibilityProcessConfiguration({configPath,environment});configuration.verifierTrust.forEach((v,i)=>fs.writeFileSync(path.join(root,`service-${i+1}.json`),JSON.stringify(v),{mode:0o600}));environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH=configuration.configurationIdentityHash;
 process.stdout.write(JSON.stringify({root:workspace,configPath,runtimeRoot:path.join(root,'runtime'),environment}));
}else if(input.operation==='external-plugin'){
 const pair=crypto.generateKeyPairSync('ed25519');let profiles=structuredClone(rawProfiles);if(input.scenario==='subset')profiles=profiles.filter(p=>p.executionProfile.language==='python');
 const registry=compileAutonomousEmpiricalFamilyPluginRegistry(profiles);const pkg=compileAutonomousEmpiricalFamilyPluginPackage({packageId:'isolated.external-package',packageVersion:'1.0.1',registry});
 const authority={version:1,kind:'AutonomousEmpiricalFamilyPluginPackageAuthority',packageId:pkg.packageId,packageVersion:pkg.packageVersion,packageHash:pkg.autonomousEmpiricalFamilyPluginPackageHash,pluginAbiHash:pkg.pluginAbiHash,evaluatorRegistryHash:pkg.evaluatorRegistryHash,signedAt:'2026-07-01T00:00:00.000Z',expiresAt:input.scenario==='expired'?'2026-07-02T00:00:00.000Z':'2027-07-01T00:00:00.000Z'};
 authority.signatures=[{keyId:'isolated-plugin-key',role:input.scenario==='wrong-role'?'other_role':'empirical_plugin_authority',algorithm:'ed25519',value:crypto.sign(null,immutableAuthoritySigningPayload(authority),pair.privateKey).toString('base64')}];
 if(input.scenario==='tamper-signature')authority.signatures[0].value=(authority.signatures[0].value[0]==='A'?'B':'A')+authority.signatures[0].value.slice(1);
 const bundle={version:1,kind:'AutonomousEmpiricalFamilyPluginSignedBundle',package:structuredClone(pkg),authority};
 if(input.scenario==='tamper-package')bundle.package.registry.profiles[0].minimumRepetitions=999;
 const trust={version:1,kind:'AuthorityTrustStore',keys:[{keyId:'isolated-plugin-key',subjectId:'isolated-authority',algorithm:'ed25519',publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}),roles:['empirical_plugin_authority'],status:input.scenario==='inactive-key'?'inactive':'active'}]};
 const bundlePath=path.join(input.root,'plugin-bundle.json'),trustPath=path.join(input.root,'plugin-trust.json');fs.writeFileSync(bundlePath,JSON.stringify(bundle,null,2)+'\n',{mode:0o600});fs.writeFileSync(trustPath,JSON.stringify(trust,null,2)+'\n',{mode:0o600});
 let expected;try{expected=verifyAutonomousEmpiricalFamilyPluginSignedBundle(bundle,{trustStore:trust,now:'2026-07-16T08:00:45.000Z'});}catch(error){expected={error:error.message};}
 process.stdout.write(JSON.stringify({environment:{HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE:bundlePath,HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE:trustPath},expected}));
}else if(input.operation==='release'){
 const codeProvenance=currentCodeProvenance({workspaceRoot:input.root,allowReleaseCommitEnvironment:false});
 process.stdout.write(JSON.stringify({codeProvenance,codeProvenanceHash:runtimeImageReproducibilityCodeProvenanceHash(codeProvenance),releaseIdentityHash:runtimeImageReproducibilityReleaseIdentityHash(codeProvenance)}));
}else if(input.operation==='inspect'){
 process.stdout.write(JSON.stringify(verify(input.fixture,input.receipt,input.overrides)));
}else if(input.operation==='fixture'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hepta-runtime-image-rust-'));fs.chmodSync(root,0o700);
 const write=(file,text,mode=0o600)=>{fs.writeFileSync(file,text,{mode});fs.chmodSync(file,mode);};
 const pairs=[crypto.generateKeyPairSync('ed25519'),crypto.generateKeyPairSync('ed25519')];
 const scenario=input.scenario||'valid';
 const verifiers=pairs.map((pair,index)=>{const n=index+1;const credentialRoot=path.join(root,`credentials-${n}`);fs.mkdirSync(credentialRoot,{mode:0o700});write(path.join(credentialRoot,'identity'),`isolated-test-credential-${n}\n`);
 const nodeInterpreter=scenario==='env-interpreter';
 const executable=path.join(root,`verifier-${n}.${nodeInterpreter?'mjs':'sh'}`);const responsePath=path.join(root,`response-${n}.json`);
 let source;
 if(scenario==='escaped-pipes'){source=`#!/usr/bin/python3\n# isolated verifier ${n}\nimport os,time,json,sys\njson.load(sys.stdin)\nif os.fork()==0:\n os.setsid()\n time.sleep(5)\n os._exit(0)\nprint('{}')\n`;}
 else if(nodeInterpreter){source=`#!/usr/bin/env node\nimport fs from 'node:fs';\n// isolated verifier ${n}\nlet text='';for await(const chunk of process.stdin)text+=chunk;const request=JSON.parse(text);const response=JSON.parse(fs.readFileSync(${JSON.stringify(responsePath)},'utf8'));if(response.requestHash!==request.requestHash)process.exit(9);process.stdout.write(JSON.stringify(response));\n`;}
 else{const action=scenario==='timeout'?'sleep 30':scenario==='exit'?'exit 7':scenario==='oversize'?'head -c 34603008 /dev/zero':scenario==='duplicate'?`printf '%s' '{"ok":1,"ok":2}'`:`cat >/dev/null\ncat ${JSON.stringify(responsePath)}`;source=`#!/bin/sh\n# isolated verifier ${n}\n${action}\n`;}
 write(executable,source,0o755);
 const publicKeyPath=path.join(root,`public-${n}.pem`);write(publicKeyPath,pair.publicKey.export({type:'spki',format:'pem'}),0o644);
 return {command:{serviceId:`runtime-builder-${n}`,principalId:`runtime-principal-${n}`,protocol:'runtime-image-reproducibility-json-stdio-v1',executable,args:[],credentialRoot,environmentAllowlist:[],timeoutMs:scenario==='timeout'?1000:60000,backend:{backendId:`buildkit-backend-${n}`,workerId:`buildkit-worker-${n}`,buildkitVersion:`v0.1${n}.0`,platform:'linux/amd64',endpointTlsSpkiHash:H(`backend-tls-${n}`),stateRootIdentityHash:H(`state-root-${n}`)}},attestor:{keyId:`runtime-key-${n}`,keyVersion:'version-1',subjectId:`runtime-attestor-${n}`,organization:`runtime-office-${n}`,role:'runtime_image_reproducibility_external_verifier',algorithm:'ed25519',status:'active',effectiveFrom:'2026-07-01T00:00:00.000Z',expiresAt:'2027-07-01T00:00:00.000Z',revokedAt:null,publicKeyPath}};
 });
 const document={version:1,kind:'RuntimeImageReproducibilityProcessConfiguration',status:'active',platform:'linux/amd64',sourceDateEpoch:1733097600,buildArgs:{},maximumReceiptAgeMs:86400000,maximumVerificationCostUsd:5,verificationCostAuthority:'operator_declared_worst_case_usd',verifiers};
 const configPath=path.join(root,'configuration.json');write(configPath,JSON.stringify(document,null,2)+'\n');
 const environment={PATH:(scenario==='env-interpreter'?fixtureNodeDirectory(root):path.dirname(process.execPath))+':/usr/bin:/bin'};
 const loaded=readRuntimeImageReproducibilityProcessConfiguration({configPath,environment});
 const configuration=Object.fromEntries(['platform','sourceDateEpoch','buildArgs','maximumReceiptAgeMs','maximumVerificationCostUsd','verificationCostAuthority','maximumVerifierTimeoutMs','minimumRefreshLeadMs','trustIdentityHash','configurationIdentityHash'].map(k=>[k,loaded[k]]));configuration.verifiers=loaded.verifierTrust;
 const profiles=['python','pythonGpu','r'];const definitions={};
 for(const profile of profiles){const contextPath=`context-${profile}`;const dir=path.join(root,contextPath);fs.mkdirSync(dir,{mode:0o700});write(path.join(dir,'Dockerfile'),`# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e\nFROM fixture/base@${H('base')}\nCOPY requirements.lock /requirements.lock\n`,0o644);write(path.join(dir,'requirements.lock'),`content-pinned-fixture-${profile}\n`,0o644);const definitionPaths=['Dockerfile','requirements.lock'];const records=definitionPaths.map(p=>({path:`${contextPath}/${p}`,sha256:H(fs.readFileSync(path.join(dir,p)))}));definitions[profile]={profile,contextPath,definitionPaths,image:`fixture/${profile}:v1`,imageDigest:H(`${profile}:manifest`),definitionManifestHash:hashRecord('RuntimeImageBuildDefinitionManifest',records)};}
 const inputs=inspectRuntimeImageBuildInputClosures({repositoryRoot:root,definitions,profiles,platform:'linux/amd64',buildArgs:{},sourceDateEpoch:1733097600});
 const options={nonce:'runtime-repro:fixture-1',requestedAt:'2026-07-16T07:59:00.000Z',expiresAt:'2026-07-16T08:01:00.000Z',configurationIdentityHash:configuration.configurationIdentityHash,trustIdentityHash:configuration.trustIdentityHash,codeProvenanceHash:H('current-code'),releaseIdentityHash:H('current-release'),inputs};
 const request=buildRuntimeImageReproducibilityRequest(options);
 const responses=configuration.verifiers.map((verifier,index)=>{
 const profileResults=inputs.map(input=>{const suffix=scenario==='oci-mismatch'&&index===1?':different':'';const layerBlobDigests=[H(`${input.profile}:layer-1${suffix}`),H(`${input.profile}:layer-2`)];const oci={indexDigest:H(`${input.profile}:index`),manifestDigest:input.registeredImageDigest,configDigest:H(`${input.profile}:config`),layerBlobDigests,allBlobDigests:[...new Set([input.registeredImageDigest,H(`${input.profile}:config`),...layerBlobDigests])].sort()};oci.ociDigestSetHash=hashRecord('RuntimeImageOciDigestSet',oci);
 return {profile:input.profile,inputClosureHash:input.runtimeImageCanonicalBuildInputClosureHash,contextTarMetadataPolicy:input.contextTarMetadataPolicy,contextTarMetadataPolicyHash:input.contextTarMetadataPolicyHash,contextTarMetadataPolicyApplied:true,dockerfileFrontend:input.dockerfileFrontend,dockerfileFrontendDigest:input.dockerfileFrontendDigest,registeredImage:input.image,registeredImageDigest:input.registeredImageDigest,platform:input.platform,sourceDateEpoch:input.sourceDateEpoch,sourceDateEpochAppliedToBuildkit:true,cacheDisabled:true,ociExporter:input.ociExporter,backendIdentityHash:verifier.backend.backendIdentityHash,buildExecutionClosureHash:hashRecord('RuntimeImageExternalBuildExecutionClosure',{inputClosureHash:input.runtimeImageCanonicalBuildInputClosureHash,backendIdentityHash:verifier.backend.backendIdentityHash}),oci};});
 const payload={version:1,kind:'RuntimeImageReproducibilityVerifierResponse',status:'runtime_image_oci_bitwise_rebuild_attested',verifierId:verifier.serviceId,verifierServiceIdentityHash:verifier.serviceIdentityHash,requestHash:request.requestHash,nonce:request.nonce,backend:verifier.backend,backendIdentityHash:verifier.backend.backendIdentityHash,profileResults,signer:verifier.signer,startedAt:['2026-07-16T07:59:10.000Z','2026-07-16T07:59:20.000Z'][index],completedAt:['2026-07-16T08:00:00.000Z','2026-07-16T08:00:30.000Z'][index]};
 if(scenario==='invalid-proof'&&index===1)payload.profileResults[0].cacheDisabled=false;
 const responseHash=hashRecord('RuntimeImageReproducibilityVerifierResponse',payload);const signature=crypto.sign(null,Buffer.from(runtimeImageReproducibilityResponseSigningPayloadHash(payload)),pairs[index].privateKey).toString('base64');return {...payload,responseHash,signature};
 });
 responses.forEach((response,index)=>write(path.join(root,`response-${index+1}.json`),JSON.stringify(response)));
 const receipt=buildRuntimeImageReproducibilityReceipt({request,responses,issuedAt:'2026-07-16T08:00:45.000Z',expiresAt:'2026-07-17T08:00:45.000Z'});
 const profilePolicies=Object.fromEntries(profiles.map(p=>[p,{dependencyArtifactsContentHashed:true,sourceArchivesContentHashed:true}]));
 const fixture={oracleRuntime:process.version,root,configPath,environment,document,configuration,options,request,responses,receipt,inputs,definitions,profilePolicies,scope,pluginPackage,registry,startup,publicKeys:pairs.map(p=>p.publicKey.export({type:'spki',format:'pem'}))};fixture.expected=verify(fixture,receipt);
 process.stdout.write(JSON.stringify(fixture));
}else throw Error('unknown oracle operation');
