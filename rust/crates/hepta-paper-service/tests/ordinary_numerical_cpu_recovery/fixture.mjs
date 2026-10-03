// Test data for the normal public entry; this never prepares a native authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createActualCpuNumericalFixture} from '../../../../../paper-core/tests/support/advanced-numerical-real-cpu-fixture.mjs';
import {compileAdvancedNumericalPluginDescriptor} from '../../../../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import {inspectWorkspaceExecutionSnapshot} from '../../../../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import {immutableAuthoritySigningPayload} from '../../../../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import {hashBytes} from '../../../../../workflow-kernel/record-hash.mjs';
const mode=process.argv[2];
if(!['write-term','write-kill','no-result'].includes(mode)) throw new Error('unknown ordinary CPU recovery fixture');
const f=createActualCpuNumericalFixture(),plugin=path.join(f.pluginRoot,'plugin.py');
const marker="with open('/output/ordinary-invocation','x',encoding='utf8') as stream: stream.write('ordinary-worker-started')\n";
const body=mode==='no-result'?marker+'import time\ntime.sleep(30)\n':marker+fs.readFileSync(plugin,'utf8')+`\nimport os,signal\nos.kill(os.getpid(),signal.${mode==='write-term'?'SIGTERM':'SIGKILL'})\n`;
fs.writeFileSync(plugin,body);
const snapshot=inspectWorkspaceExecutionSnapshot(f.pluginRoot);
if(snapshot.blockers.length) throw new Error('ordinary CPU recovery source snapshot refused');
const {advancedNumericalPluginDescriptorHash:_oldHash,...input}=f.descriptor;
const descriptor=compileAdvancedNumericalPluginDescriptor({...input,
 entrypoint:{relativePath:'plugin.py',sha256:hashBytes(Buffer.from(body))},
 sourceIdentity:{merkleHash:snapshot.merkleHash,workspaceManifestHash:snapshot.manifestHash}});
const original=JSON.parse(fs.readFileSync(path.join(f.root,'bundle.json'),'utf8'));
const {signatures:_signatures,...priorAuthority}=original.authority;
const authority={...priorAuthority,descriptorHash:descriptor.advancedNumericalPluginDescriptorHash};
const bundle={...original,descriptor,authority:{...authority,signatures:[{keyId:'advanced-numerical-plugin-key',role:'advanced_numerical_plugin_authority',algorithm:'ed25519',value:crypto.sign(null,immutableAuthoritySigningPayload(authority),f.pluginPrivateKey).toString('base64')}]}};
fs.writeFileSync(path.join(f.root,'bundle.json'),JSON.stringify(bundle)+'\n');
console.log(JSON.stringify({root:f.root,configurationPath:f.configurationPath,requestPath:f.requestPath,pluginRoot:f.pluginRoot,outputRoot:f.outputRoot,sourceFixtureOnly:true,installedAuthority:false,providerAuthority:false,scientificAuthority:false}));
