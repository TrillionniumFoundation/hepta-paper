import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import { buildNativeOwners } from '../../docs/tools/node-rust-route-acceptance.mjs';
import { compileAdvancedNumericalPluginDescriptor } from '../../paper-domain/research/advanced-numerical-plugin-contract.mjs';
import { immutableAuthoritySigningPayload } from '../../workflow-kernel/runtime/immutable-signed-json-bundle.mjs';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';
import { signedPluginFixture as originalSignedFixture, productionQualification } from './support/advanced-numerical-qualification-fixture.v2.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';


// Local signed status fixtures exercise integrity; they grant no activation,
// qualification, publication, scientific result or target-host authority.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let root, fixture, caller, binary, unknown, graph, ship, unknownShip, packagePin;
let keepFixture = false;
function checkedTest(name, body) { test(name, () => { try { body(); } catch (error) { keepFixture = true; throw error; } }); }
const observed = [];
const identity = s => [s.dev, s.ino, s.mode, s.nlink, s.uid, s.gid, s.size, s.mtimeNs, s.ctimeNs].map(String);
function pin(file) {
  const named = fs.lstatSync(file, { bigint: true }); assert.ok(named.isFile());
  assert.ok(named.size <= 256n * 1024n * 1024n);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    assert.deepEqual(identity(fs.fstatSync(fd, { bigint: true })), identity(named));
    const hash = crypto.createHash('sha256'), block = Buffer.alloc(64 * 1024); let used = 0n;
    for (let count; (count = fs.readSync(fd, block)) !== 0;) {
      used += BigInt(count); assert.ok(used <= named.size); hash.update(block.subarray(0, count));
    }
    assert.equal(used, named.size);
    for (const stat of [fs.fstatSync(fd, { bigint: true }), fs.lstatSync(file, { bigint: true })]) assert.deepEqual(identity(stat), identity(named));
    return { identity: identity(named), sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function copy(relative, from = path.join(source, relative), mode = 0o440) {
  const prior = pin(from), target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.copyFileSync(from, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, mode);
  const current = pin(target); assert.equal(prior.sha256, current.sha256);
  assert.notDeepEqual(prior.identity.slice(0, 2), current.identity.slice(0, 2));
  assert.deepEqual(pin(from), prior); return { original: prior, current };
}
const args = values => ['operator', 'advanced-numerical-plugin', '--', ...values];
function run(engine, values, additions = {}, executable = binary) {
  const out = spawnSync(engine === 'node' ? process.execPath : executable,
    engine === 'node' ? [path.join(root, 'paper-core/bin/hepta-paper.mjs'), ...args(values)] : args(values),
    { cwd: caller, env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...additions },
      shell: false, encoding: 'utf8', timeout: engine === 'node' ? 30_000 : 120_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(out.error, undefined, out.error?.message); assert.equal(out.signal, null, out.stderr); return out;
}
function pair(values, expectedExit, selected = []) {
  const prior = selected.map(pin), node = run('node', values), native = run('native', values);
  assert.equal(node.status, expectedExit, node.stderr); assert.equal(native.status, node.status, native.stderr);
  assert.equal(native.stdout, node.stdout); assert.equal(node.stderr, ''); assert.equal(native.stderr, '');
  assert.deepEqual(selected.map(pin), prior);
  observed.push({ values, nodeExit: node.status, nativeExit: native.status, wholeRawStdoutEqual: true,
    selectedRawIdentityUnchanged: true, nodeRawStdout: node.stdout, nativeRawStdout: native.stdout,
    localIntegrityQualified: JSON.parse(native.stdout).productionQualified === true, installedAuthority: false });
  return JSON.parse(native.stdout);
}
function signedFixture() {
  const base = fs.mkdtempSync(path.join(fixture, 'signed-')), plugin = path.join(base, 'plugin'), output = path.join(base, 'output');
  fs.mkdirSync(plugin, { mode: 0o700 }); fs.mkdirSync(output, { mode: 0o700 });
  const entry = path.join(plugin, 'plugin.py'), bytes = Buffer.from('print("fixture")\n');
  fs.writeFileSync(entry, bytes, { mode: 0o440 });
  const descriptor = compileAdvancedNumericalPluginDescriptor({ version: 1, pluginId: 'organization.causal-estimator',
    pluginVersion: '1.2.0', analysisFamily: 'causal-inference', runtime: { language: 'python', executable: 'python3',
      executableHash: `sha256:${'1'.repeat(64)}`, packageClosureHash: `sha256:${'2'.repeat(64)}` },
    entrypoint: { relativePath: 'plugin.py', sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` },
    sourceIdentity: { merkleHash: `sha256:${'3'.repeat(64)}`, workspaceManifestHash: `sha256:${'4'.repeat(64)}` },
    limits: { timeoutMs: 30_000, cpuSeconds: 10, memoryBytes: 256 * 1024 * 1024, maximumProcesses: 8,
      maximumOutputBytes: 1024 * 1024, maximumCapturedBytes: 128 * 1024 }, networkPolicy: 'none',
    assuranceContracts: { oracle: { kind: 'independent-numeric-oracle-v1', contractHash: `sha256:${'5'.repeat(64)}` },
      replay: { kind: 'deterministic-process-replay-v1', contractHash: `sha256:${'6'.repeat(64)}` },
      uncertainty: { kind: 'typed-uncertainty-report-v1', contractHash: `sha256:${'7'.repeat(64)}` } } });
  const key = crypto.generateKeyPairSync('ed25519'), clock = Date.now();
  const payload = { version: 1, kind: 'AdvancedNumericalPluginAuthority', pluginId: descriptor.pluginId,
    pluginVersion: descriptor.pluginVersion, descriptorHash: descriptor.advancedNumericalPluginDescriptorHash,
    signedAt: new Date(clock - 60_000).toISOString(), expiresAt: new Date(clock + 3_600_000).toISOString() };
  const authority = { ...payload, signatures: [{ keyId: 'numerical-key', role: 'advanced_numerical_plugin_authority',
    algorithm: 'ed25519', value: crypto.sign(null, immutableAuthoritySigningPayload(payload), key.privateKey).toString('base64') }] };
  const bundle = { version: 1, kind: 'AdvancedNumericalPluginSignedBundle', descriptor, authority };
  const trust = { version: 1, kind: 'AuthorityTrustStore', keys: [{ keyId: 'numerical-key', subjectId: 'numerical-subject',
    organization: 'local-development-fixture', algorithm: 'ed25519', publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }),
    roles: ['advanced_numerical_plugin_authority'], status: 'active' }] };
  const save = (name, value) => { const target = path.join(base, name); fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { mode: 0o440 }); return target; };
  const bundlePath = save('bundle.json', bundle), trustPath = save('trust.json', trust);
  const configuration = save('configuration.json', { version: 1, kind: 'AdvancedNumericalPluginRuntimeConfiguration',
    signedBundlePath: bundlePath, trustStorePath: trustPath, pluginRoot: plugin, outputRoot: output });
  return { base, entry, bundle, trust, configuration, bundlePath, trustPath, selected: [configuration, bundlePath, trustPath, entry] };
}
before(() => {
  try {
  assert.equal(process.version, 'v22.23.1'); const built = buildNativeOwners().owners['hepta-paper-rust'];
  fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.userInfo().homedir), '.hepta-numerical-status-'));
  root = path.join(fixture, 'deployment'); caller = path.join(fixture, 'caller'); fs.mkdirSync(caller, { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'paper-core/config'), { recursive: true, mode: 0o700 });
  const originalBinary = pin(built.path); binary = path.join(root, 'bin/hepta-paper-rust'); ship = copy('bin/hepta-paper-rust', built.path, 0o550).current;
  assert.equal(`sha256:${ship.sha256}`, built.sha256); assert.deepEqual(pin(built.path), originalBinary);
  unknown = path.join(fixture, 'unknown/hepta-paper-rust'); fs.mkdirSync(path.dirname(unknown));
  fs.copyFileSync(binary, unknown, fs.constants.COPYFILE_EXCL); fs.chmodSync(unknown, 0o550); unknownShip = pin(unknown);
  graph = new Map(); const pending = ['paper-core/bin/hepta-paper.mjs', 'paper-core/bin/advanced-numerical-plugin.mjs'];
  while (pending.length) {
    const relative = pending.pop(); if (graph.has(relative)) continue;
    const from = path.join(source, relative);
    const referenced = fs.lstatSync(from);
    if (referenced.isDirectory()) { fs.mkdirSync(path.join(root, relative), { recursive: true, mode: 0o700 }); continue; }
    graph.set(relative, copy(relative)); if (!relative.endsWith('.mjs')) continue;
    const contents = fs.readFileSync(from, 'utf8');
    for (const match of contents.matchAll(/(?:from\s+|import\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)) {
      const name = match[1]; if (name.startsWith('node:')) continue; assert.ok(name.startsWith('.'), `unbound import: ${name}`);
      const selected = path.relative(source, path.resolve(path.dirname(from), name)); assert.ok(selected && !selected.startsWith('../') && !path.isAbsolute(selected)); pending.push(selected);
    }
    for (const match of contents.matchAll(/new URL\(['"]([^'"]+)['"],\s*import\.meta\.url\)/gu)) {
      const selected = path.relative(source, path.resolve(path.dirname(from), match[1])); assert.ok(!selected.startsWith('../')); pending.push(selected);
    }
  }
  // Original module initialization checks all fixed image mirrors even on help.
  const imageInputs = ['python-scientific/Dockerfile', 'python-scientific/requirements.lock', 'python-scientific/hepta-dataset-access-supervisor',
    'python-gpu/Dockerfile', 'python-gpu/requirements.lock', 'python-gpu/scientific-requirements.lock', 'python-gpu/hepta-dataset-access-supervisor',
    'r-scientific/.dockerignore', 'r-scientific/Dockerfile', 'r-scientific/renv.lock', 'r-scientific/packages.lock',
    'r-scientific/restore-locked.R', 'r-scientific/verify-locked.R', 'r-scientific/normalize-installed.sh', 'r-scientific/hepta-dataset-access-supervisor'];
  for (const input of imageInputs) { const relative = `runtime-images/${input}`; if (!graph.has(relative)) graph.set(relative, copy(relative)); }
  packagePin = copy('package.json').current;
  } catch (error) { keepFixture = true; throw error; }
});
after(() => {
  if (!fixture || !packagePin) return;
  try {
  assert.deepEqual(pin(binary), ship); assert.deepEqual(pin(unknown), unknownShip); assert.deepEqual(pin(path.join(root, 'package.json')), packagePin);
  for (const [relative, expected] of graph) {
    assert.deepEqual(pin(path.join(source, relative)), expected.original); assert.deepEqual(pin(path.join(root, relative)), expected.current);
  }
  process.stdout.write(`# numerical-status-observations ${JSON.stringify(observed)}\n`);
  } catch (error) { keepFixture = true; throw error; }
  finally { if (!keepFixture) fs.rmSync(fixture, { recursive: true, force: false }); }
});
checkedTest('ordinary_numerical_help_default_grammar_and_physical_workspace_match_node', () => {
  pair(['--help'], 0); pair([], 1); pair(['--config=missing.json'], 1);
  const { booleanFlags, valueFlags } = resolveHeptaPaperCommand('operator', 'advanced-numerical-plugin').forwardedArgumentSchema;
  const failures = [['--'], ['positional'], ['--=x'], ['--unknown']];
  for (const key of booleanFlags) failures.push([`--${key}=true`], [`--${key}`, `--${key}`]);
  for (const key of valueFlags) failures.push([`--${key}`], [`--${key}=`], [`--${key}`, '--help'], [`--${key}=x`, `--${key}=y`]);
  for (const values of failures) {
    const node = run('node', values), native = run('native', values, {}, unknown);
    assert.equal(node.status, 2); assert.equal(native.status, 2); assert.equal(native.stdout, ''); assert.equal(node.stdout, '');
    assert.deepEqual(JSON.parse(native.stderr), JSON.parse(node.stderr));
  }
  const help = run('native', ['--help'], {}, unknown); assert.equal(help.status, 0); assert.equal(help.stdout, run('node', ['--help']).stdout);
  const absent = run('native', [], {}, unknown); assert.equal(absent.status, 1); assert.match(absent.stderr, /native_workspace_root_required/u);
  const explicit = run('native', [], { HEPTA_PAPER_WORKSPACE_ROOT: root }, unknown); assert.equal(explicit.status, 1); assert.equal(explicit.stdout, run('node', []).stdout);
});
checkedTest('ordinary_numerical_actual_signed_v1_status_require_ready_and_ignored_fields_match_raw_node', () => {
  const f = signedFixture(), values = ['--config', f.configuration];
  const report = pair(values, 0, f.selected); assert.equal(report.productionQualified, false);
  assert.ok(['advanced_numerical_plugin_runner_unqualified', 'advanced_numerical_plugin_runner_blocked'].includes(report.status));
  pair([...values, '--action=status', '--require-runner-ready'], 1, f.selected);
  pair([...values, '--request=unused-absent', '--output-directory=unused-absent'], 0, f.selected);
  const relative = path.relative(root, f.configuration); pair(['--config', relative], 0, f.selected);
});
checkedTest('ordinary_numerical_config_entrypoint_signature_and_revocation_refusals_preserve_inputs', () => {
  const rewrite = (file, value) => { fs.chmodSync(file, 0o600); fs.writeFileSync(file, value); fs.chmodSync(file, 0o440); };
  for (const mode of ['invalid-config', 'missing-dependency', 'bad-entry', 'revoked', 'wrong-role', 'tamper']) {
    const f = signedFixture();
    if (mode === 'invalid-config') rewrite(f.configuration, '{}');
    if (mode === 'missing-dependency') fs.unlinkSync(f.bundlePath);
    if (mode === 'bad-entry') rewrite(f.entry, 'print("changed")\n');
    if (mode === 'revoked' || mode === 'wrong-role') { f.trust.keys[0][mode === 'revoked' ? 'status' : 'roles'] = mode === 'revoked' ? 'revoked' : ['wrong']; rewrite(f.trustPath, JSON.stringify(f.trust)); }
    if (mode === 'tamper') { f.bundle.authority.pluginVersion = '9.9.9'; rewrite(f.bundlePath, JSON.stringify(f.bundle)); }
    const selected = f.selected.filter(file => fs.existsSync(file)); const report = pair(['--config', f.configuration], 1, selected);
    assert.equal(report.status, 'advanced_numerical_plugin_runner_blocked'); assert.equal(report.productionQualified, false);
  }
});

function qualifiedFixture({gpu=false}={}) {
  const f=originalSignedFixture({gpu}); f.now=new Date(Date.now()+25_000);
  const authority={version:1,kind:'AdvancedNumericalPluginAuthority',pluginId:f.descriptor.pluginId,
    pluginVersion:f.descriptor.pluginVersion,descriptorHash:f.descriptor.advancedNumericalPluginDescriptorHash,
    signedAt:new Date(f.now.getTime()-60_000).toISOString(),expiresAt:new Date(f.now.getTime()+60_000).toISOString()};
  f.bundle.authority={...authority,signatures:[{keyId:'advanced-numerical-plugin-key',role:'advanced_numerical_plugin_authority',
    algorithm:'ed25519',value:crypto.sign(null,immutableAuthoritySigningPayload(authority),f.pluginPrivateKey).toString('base64')}]};
  const q=structuredClone(productionQualification(f));
  const save=(name,value)=>{const file=path.join(f.root,name);fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o440});return file;};
  const bundle=save('bundle.json',f.bundle),trust=save('trust.json',f.trustStore),statement=save('statement.json',q.qualification),
    evidence=save('evidence.json',q.evidence),qualificationTrust=save('qualification-trust.json',q.trustStore);
  const configurationValue={version:2,kind:'AdvancedNumericalPluginRuntimeConfiguration',pluginRoot:f.pluginRoot,outputRoot:f.outputRoot};
  for(const [name,file] of [['signedBundle',bundle],['trustStore',trust],['qualification',statement],
    ['qualificationEvidence',evidence],['qualificationTrustStore',qualificationTrust]]) {
    configurationValue[name+'Path']=file;configurationValue[name+'FileHash']=hashBytes(fs.readFileSync(file));
  }
  if(gpu)for(const name of ['containerExecutable','containerImage','containerImageDigest','cpuFallbackPolicy','gpuDeviceIsolationScope','gpuDeviceSelector','gpuMemoryLimitBytes','gpuMemoryLimitEnforced','gpuMemoryLimitScope','requiresGpu','runtimeProfile'])configurationValue[name]=f.descriptor.runtime[name];
  const configuration=save('configuration.json',configurationValue);
  return {f,q,bundle,trust,statement,evidence,qualificationTrust,configuration,configurationValue,
    selected:[configuration,bundle,trust,statement,evidence,qualificationTrust,path.join(f.pluginRoot,'plugin.py')]};
}
checkedTest('ordinary_numerical_actual_v2_five_document_chain_and_role_refusals_match_raw_node',()=>{
  for(const mode of ['valid','file-hash','organization','revocation','receipt']) {
    const q=qualifiedFixture();
    const rewrite=(file,value)=>{fs.chmodSync(file,0o600);fs.writeFileSync(file,JSON.stringify(value)+'\n');fs.chmodSync(file,0o440);};
    if(mode==='file-hash')q.configurationValue.qualificationFileHash='sha256:'+'0'.repeat(64);
    if(mode==='organization'||mode==='revocation') {
      q.q.trustStore.keys[0][mode==='organization'?'organization':'status']=mode==='organization'?q.f.trustStore.keys[0].organization:'revoked';
      rewrite(q.qualificationTrust,q.q.trustStore);q.configurationValue.qualificationTrustStoreFileHash=hashBytes(fs.readFileSync(q.qualificationTrust));
    }
    if(mode==='receipt') {
      q.q.evidence.referenceExecutionReceipt.resultHash='sha256:'+'0'.repeat(64);rewrite(q.evidence,q.q.evidence);
      q.configurationValue.qualificationEvidenceFileHash=hashBytes(fs.readFileSync(q.evidence));
    }
    rewrite(q.configuration,q.configurationValue);
    const values=['--config',q.configuration];
    const report=pair(values,mode==='valid'?0:1,q.selected);
    if(mode==='valid') {
      assert.equal(report.productionQualified,true);assert.equal(report.capabilities.productionQualified,true);
      assert.equal(report.capabilities.qualificationStatementHash,q.q.qualification.advancedNumericalPluginQualificationStatementHash);
      assert.equal(report.capabilities.qualificationEvidenceBundleHash,q.q.evidence.advancedNumericalPluginQualificationEvidenceBundleHash);
      pair([...values,'--require-runner-ready'],report.sandboxAvailability.available?0:1,q.selected);
      pair([...values,'--request=unused-missing','--output-directory=unused-missing'],0,q.selected);
    } else {
      assert.equal(report.productionQualified,false);assert.equal(report.status,'advanced_numerical_plugin_runner_blocked');
    }
    fs.rmSync(q.f.root,{recursive:true,force:false});
  }
});

checkedTest('ordinary_numerical_actual_gpu_status_and_binding_refusals_match_raw_node',()=>{
  const gpuKeys=['containerExecutable','containerImage','containerImageDigest','cpuFallbackPolicy','gpuDeviceIsolationScope','gpuDeviceSelector','gpuMemoryLimitBytes','gpuMemoryLimitEnforced','gpuMemoryLimitScope','requiresGpu','runtimeProfile'];
  const rewrite=(file,value)=>{fs.chmodSync(file,0o600);fs.writeFileSync(file,JSON.stringify(value)+'\n');fs.chmodSync(file,0o440);};
  for(const mode of ['valid','v1','missing-gpu','selector','fallback','descriptor','revocation','cpu-mismatch']) {
    const q=qualifiedFixture({gpu:mode!=='cpu-mismatch'});
    if(mode==='v1') {
      q.configurationValue={version:1,kind:'AdvancedNumericalPluginRuntimeConfiguration',pluginRoot:q.f.pluginRoot,outputRoot:q.f.outputRoot,signedBundlePath:q.bundle,trustStorePath:q.trust};
    }
    if(mode==='missing-gpu')for(const key of gpuKeys)delete q.configurationValue[key];
    if(mode==='selector')q.configurationValue.gpuDeviceSelector='GPU-00000000-0000-0000-0000-000000000000';
    if(mode==='fallback')q.configurationValue.cpuFallbackPolicy='allowed';
    if(mode==='descriptor') {
      const bundle=structuredClone(q.f.bundle);bundle.descriptor.runtime.gpuDeviceSelector='bad';rewrite(q.bundle,bundle);
      q.configurationValue.signedBundleFileHash=hashBytes(fs.readFileSync(q.bundle));
    }
    if(mode==='revocation') {
      q.q.trustStore.keys[0].status='revoked';rewrite(q.qualificationTrust,q.q.trustStore);
      q.configurationValue.qualificationTrustStoreFileHash=hashBytes(fs.readFileSync(q.qualificationTrust));
    }
    if(mode==='cpu-mismatch')for(const key of gpuKeys)q.configurationValue[key]=null;
    rewrite(q.configuration,q.configurationValue);
    const args=['--config',q.configuration];const report=pair(args,mode==='valid'?0:1,q.selected);
    if(mode==='valid') {
      assert.equal(report.productionQualified,true);assert.equal(report.capabilities.requiresGpu,true);
      assert.equal(report.capabilities.runtimeProfile,'pythonGpu');
      assert.match(report.capabilities.gpuRuntimeAuthorityHash,/^sha256:[0-9a-f]{64}$/u);
      pair([...args,'--require-runner-ready'],report.sandboxAvailability.available?0:1,q.selected);
    } else assert.equal(report.status,'advanced_numerical_plugin_runner_blocked');
    fs.rmSync(q.f.root,{recursive:true,force:false});
  }
});
