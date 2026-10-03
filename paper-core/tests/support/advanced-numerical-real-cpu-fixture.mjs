import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { signedPluginFixture } from './advanced-numerical-qualification-fixture.v2.mjs';
import { compileAdvancedNumericalPluginDescriptor } from '../../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import { inspectWorkspaceExecutionSnapshot } from '../../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { immutableAuthoritySigningPayload } from '../../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { hashBytes } from '../../../workflow-kernel/record-hash.mjs';

const body=String.raw`import json,base64,hashlib,sys
args=sys.argv[1:]; request=json.loads(base64.b64decode(args[args.index("--hepta-request-base64")+1]))
def record(kind,value):
    encoded=json.dumps({"kind":kind,"value":value},sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
    return "sha256:"+hashlib.sha256(encoded).hexdigest()
estimate={"estimate":sum(request["input"]["values"]),"seed":request["seed"]}
artifact=record("LocalNumericalEstimate",estimate)
contracts=request["assuranceContracts"]
result={"version":1,"kind":"AdvancedNumericalPluginResult","status":"advanced_numerical_computation_completed","pluginId":request["pluginId"],"analysisFamily":request["analysisFamily"],"requestHash":request["advancedNumericalPluginRequestHash"],"oracleContractHash":contracts["oracle"]["contractHash"],"replayContractHash":contracts["replay"]["contractHash"],"uncertaintyContractHash":contracts["uncertainty"]["contractHash"],"estimateArtifactHash":artifact,"oracleReceiptHash":record("LocalOracleObservation",estimate),"replayReceiptHash":record("LocalReplayObservation",estimate),"uncertaintyArtifactHash":record("LocalUncertaintyArtifact",estimate),"uncertaintyReceiptHash":record("LocalUncertaintyObservation",estimate),"estimate":estimate}
result["advancedNumericalPluginResultHash"]=record("AdvancedNumericalPluginResult",result)
with open(args[args.index("--hepta-output")+1],"x",encoding="utf8") as stream:
    json.dump(result,stream,separators=(",",":"),ensure_ascii=False)
`;

export function createActualCpuNumericalFixture({ maximumProcesses = 8192 } = {}) {
  const f=signedPluginFixture();
fs.writeFileSync(path.join(f.pluginRoot,'plugin.py'),body,{mode:0o644});
// writeFile preserves an existing mode. Pin the source mode independently of
// the creating process's umask before taking the actual execution snapshot.
fs.chmodSync(path.join(f.pluginRoot,'plugin.py'),0o664);
const python=fs.realpathSync.native('/usr/bin/python3');
if(!fs.lstatSync(python).isFile()) throw new Error('actual_cpu_python_not_regular');
const executable=path.basename(python);
const pythonHash=hashBytes(fs.readFileSync(python)), snapshot=inspectWorkspaceExecutionSnapshot(f.pluginRoot);
assert.equal(snapshot.blockers.length,0);
const {advancedNumericalPluginDescriptorHash:_hash,...input}=f.descriptor;
const descriptor=compileAdvancedNumericalPluginDescriptor({...input,limits:{...input.limits,maximumProcesses},runtime:{...input.runtime,executable,executableHash:pythonHash},entrypoint:{relativePath:'plugin.py',sha256:hashBytes(Buffer.from(body))},sourceIdentity:{merkleHash:snapshot.merkleHash,workspaceManifestHash:snapshot.manifestHash}});
const now=Date.now(), authority={version:1,kind:'AdvancedNumericalPluginAuthority',pluginId:descriptor.pluginId,pluginVersion:descriptor.pluginVersion,descriptorHash:descriptor.advancedNumericalPluginDescriptorHash,signedAt:new Date(now-60_000).toISOString(),expiresAt:new Date(now+3_600_000).toISOString()};
const bundle={version:1,kind:'AdvancedNumericalPluginSignedBundle',descriptor,authority:{...authority,signatures:[{keyId:'advanced-numerical-plugin-key',role:'advanced_numerical_plugin_authority',algorithm:'ed25519',value:crypto.sign(null,immutableAuthoritySigningPayload(authority),f.pluginPrivateKey).toString('base64')}]}};
const save=(name,value)=>{const file=path.join(f.root,name);fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600});return file;};
const bundlePath=save('bundle.json',bundle),trustPath=save('trust.json',f.trustStore);
const configurationPath=save('configuration.json',{version:1,kind:'AdvancedNumericalPluginRuntimeConfiguration',pluginRoot:f.pluginRoot,outputRoot:f.outputRoot,signedBundlePath:bundlePath,trustStorePath:trustPath});
const requestPath=save('request.json',{runId:'actual-cpu-run-1',input:{values:[1,2,3]},seed:17}),output=path.join(f.outputRoot,'normal-run-1');

 return {...f,configurationPath,requestPath,outputDirectory:output,python,pythonHash,descriptor,snapshot};
}
