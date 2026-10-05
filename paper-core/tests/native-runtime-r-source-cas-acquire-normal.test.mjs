import { assertNativeSignalTargetOwned, recordRequestedParentTermination, waitForRequestedParentTermination } from './support/native-process-signal-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createNormalQualificationFixtureV1 } from './support/native-qualification-normal-fixture-v1.mjs';
let fixture;
const observations = [];
const args = values => ['operator', 'runtime-r-source-cas', '--', ...values];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
before(() => { fixture = createNormalQualificationFixtureV1(['runtime-r-source-cas']); });
after(() => { process.stdout.write(`# r-cas-acquisition-observations ${JSON.stringify(observations)}\n`); fixture?.close(); });
function setup(root, seed, packages = [['Alpha', '1.0'], ['zeta', '2.0']]) {
  const context = path.join(root, 'runtime-images/r-scientific'); fs.mkdirSync(context, { recursive: true, mode: 0o700 });
  const entries = Object.fromEntries(packages.map(([Package, Version]) => [Package, { Package, Version, Source: 'Repository', Repository: 'CRAN' }]));
  fs.writeFileSync(path.join(context, 'renv.lock'), JSON.stringify({ Packages: entries }), { mode: 0o600 });
  fs.mkdirSync(seed, { recursive: true, mode: 0o700 });
  for (const [name, version] of packages) {
    const dir = path.join(seed, name); fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'DESCRIPTION'), `Package: ${name}\nVersion: ${version}\nDescription: controlled local fixture\n`, { mode: 0o600 });
    const tar = spawnSync('/usr/bin/tar', ['-czf', path.join(seed, `${name}_${version}.tar.gz`), '-C', seed, name], { timeout: 10_000, maxBuffer: 64 * 1024 });
    assert.equal(tar.status, 0, String(tar.stderr));
  }
  return context;
}
function bytesInventory(root) {
  const rows = [];
  function walk(dir) { for (const name of fs.readdirSync(dir).sort()) {
    const selected = path.join(dir, name), s = fs.lstatSync(selected); assert.ok(!s.isSymbolicLink());
    if (s.isDirectory()) walk(selected); else { assert.ok(s.isFile() && s.nlink === 1 && s.size < 16 * 1024 * 1024); rows.push({ path: path.relative(root, selected), bytes: s.size, sha256: sha(fs.readFileSync(selected)) }); }
  } }
  walk(root); return rows;
}
test('normal_r_source_cas_acquire_context_then_safe_integer_concurrency_precedes_lock_and_seed', async () => {
  const selected=path.join(fixture.root,'concurrency-context');fs.mkdirSync(path.join(selected,'runtime-images/r-scientific'),{recursive:true,mode:0o700});
  for (const value of ['0', '-1', '17', '6.5', 'NaN', 'Infinity', '9007199254740993', 'text', '+0x1']) {
    const values = ['--action=acquire', '--root=concurrency-context', '--seed=missing', '--concurrency', value];
    const before = fixture.snapshot(fixture.root);
    const node = await fixture.run('node', args(values)), native = await fixture.run('native', args(values));
    for (const output of [node, native]) { assert.equal(output.status, 1); assert.equal(output.stdout, ''); assert.match(output.stderr, /r_runtime_source_cas_concurrency_invalid/u); }
    assert.deepEqual(fixture.snapshot(fixture.root), before);
    observations.push({ values, node, native, scope: 'existing repository context before concurrency, then before lock/seed; no writer effects' });
  }
  const values=['--action=acquire','--root=definitely-missing-context','--seed=missing','--concurrency=0'];
  const before=fixture.snapshot(fixture.root);const node=await fixture.run('node',args(values)),native=await fixture.run('native',args(values));
  for(const output of [node,native]){assert.equal(output.status,1);assert.equal(output.stdout,'');assert.match(output.stderr,/ENOENT: no such file or directory, lstat/u);assert.ok(!output.stderr.includes('concurrency_invalid'));}
  assert.deepEqual(fixture.snapshot(fixture.root),before);observations.push({values,node,native,scope:'actual original constructor precedence before numeric validator; stack/prefix compatibility not claimed'});
});
test('normal_r_source_cas_acquire_original_default_mixed_seed_contract_and_ready_replay_match_node', async () => {
  const seed = path.join(fixture.root, 'acquire-seed'), nodeRoot = path.join(fixture.root, 'acquire-node'), nativeRoot = path.join(fixture.root, 'acquire-native');
  const nodeContext = setup(nodeRoot, seed); fs.mkdirSync(path.join(nativeRoot, 'runtime-images/r-scientific'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(nodeContext, 'renv.lock'), path.join(nativeRoot, 'runtime-images/r-scientific/renv.lock'));
  const seedBefore = fixture.snapshot(seed);
  const node = await fixture.run('node', args(['--action=acquire', '--root=acquire-node', '--seed=acquire-seed']));
  const native = await fixture.run('native', args(['--action=acquire', '--root=acquire-native', '--seed=acquire-seed']));
  assert.equal(node.status, 0, node.stderr); assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout, node.stdout); assert.equal(native.stderr, ''); assert.equal(node.stderr, '');
  const report = JSON.parse(native.stdout); assert.equal(report.acquired, true); assert.equal(report.packageCount, 2);
  const a = bytesInventory(path.join(nodeContext, 'source-cas')), b = bytesInventory(path.join(nativeRoot, 'runtime-images/r-scientific/source-cas'));
  assert.deepEqual(b, a);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(nativeRoot, 'runtime-images/r-scientific/source-cas/manifest.json'))), JSON.parse(fs.readFileSync(path.join(nodeContext, 'source-cas/manifest.json'))));
  assert.deepEqual(fixture.snapshot(seed), seedBefore);
  observations.push({ node, native, materializedArchivesAndIndexes: a, fullManifestValueMatched: true, publisherSignatureAuthority: false });
  for (const concurrency of ['1', '16', '0x10', '0b10', '0o10', '6e0', '+6', '6.0', '\u00a06\u00a0']) {
    const values = ['--action=acquire', '--seed=missing-no-seed-on-ready-replay', '--concurrency', concurrency];
    const nodeBefore = fixture.snapshot(nodeRoot), nativeBefore = fixture.snapshot(nativeRoot);
    const left = await fixture.run('node', args([...values, '--root=acquire-node']));
    const right = await fixture.run('native', args([...values, '--root=acquire-native']), { PATH: '/no-archive-tools' });
    assert.equal(left.status, 0, left.stderr); assert.equal(right.status, 0, right.stderr); assert.equal(right.stdout, left.stdout); assert.equal(JSON.parse(right.stdout).acquired, false);
    assert.deepEqual(fixture.snapshot(nodeRoot), nodeBefore); assert.deepEqual(fixture.snapshot(nativeRoot), nativeBefore);
    observations.push({ concurrency, node: left, native: right, scope: 'same namespace offline ready replay; no seed/tar/curl' });
  }
});
test('normal_r_source_cas_acquire_existing_invalid_and_seed_refusal_preserve_original_inputs', async () => {
  for (const name of ['node', 'native']) {
    const root = path.join(fixture.root, `existing-${name}`), seed = path.join(fixture.root, `existing-seed-${name}`), context = setup(root, seed, [['demo', '1.0']]);
    fs.mkdirSync(path.join(context, 'source-cas')); fs.writeFileSync(path.join(context, 'source-cas/unknown'), 'unknown-result');
    const before = fixture.snapshot(root);
    const result = await fixture.run(name, args(['--action=acquire', '--root', root, '--seed', seed]));
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /r_runtime_source_cas_existing_invalid/u);
    assert.deepEqual(fixture.snapshot(root), before);
    observations.push({ engine: name, result, scope: 'unknown published namespace retained, no overwriting/delete' });
  }
  for (const name of ['node', 'native']) {
    const root = path.join(fixture.root, `seed-link-${name}`), seed = path.join(fixture.root, `bad-seed-${name}`), context = setup(root, seed, [['demo', '1.0']]);
    fs.symlinkSync('demo_1.0.tar.gz', path.join(seed, 'unexpected-link'));
    const before = fixture.snapshot(root), sb = fixture.snapshot(seed);
    const result = await fixture.run(name, args(['--action=acquire', '--root', root, '--seed', seed]));
    assert.equal(result.status, 1); assert.match(result.stderr, /r_runtime_source_cas_seed_symlink_invalid/u);
    assert.deepEqual(fixture.snapshot(root), before); assert.deepEqual(fixture.snapshot(seed), sb); assert.deepEqual(fs.readdirSync(context), ['renv.lock']);
    observations.push({ engine: name, result, scope: 'seed rejection before private staging/network' });
  }
});

// Hermetic transport-boundary proof: actual normal native CLI; actual original
// Node composition with its explicit port. No live HTTPS qualification claim.
function transportFixture(root, payloads, {failures = 0, delayMilliseconds = 30, wait = false} = {}) {
  const tools = path.join(root, 'tools'), state = path.join(root, 'state');
  fs.mkdirSync(tools, {recursive:true, mode:0o700}); fs.mkdirSync(state, {mode:0o700});
  const config = path.join(state, 'config.json');
  fs.writeFileSync(config, JSON.stringify({payloads, failures, delayMilliseconds, wait}), {mode:0o400});
  const program = `#!/usr/bin/python3
import fcntl,json,os,pathlib,sys,time
state=pathlib.Path(${JSON.stringify(state)})
config=json.loads((state/'config.json').read_text())
args=sys.argv[1:]
assert args[0]=='--disable' and args[args.index('--proto')+1]=='=https'
assert args[args.index('--proxy')+1]=='' and args[args.index('--noproxy')+1]=='*'
assert args[args.index('--request')+1]=='GET' and args[args.index('--retry')+1]=='0'
assert '--location' not in args and '--insecure' not in args
assert not any(k in os.environ for k in ['CURL_HOME','CURL_CA_BUNDLE','SSL_CERT_FILE','HTTPS_PROXY','TOKEN'])
url=args[args.index('--url')+1]
assert url.startswith('https://packagemanager.posit.co/cran/2024-11-01/src/contrib/')
name=url.rsplit('/',1)[1];assert name in config['payloads']
lock=open(state/'lock','a+')
def update(delta,initial=False):
 fcntl.flock(lock,fcntl.LOCK_EX)
 p=state/'calls.json';v=json.loads(p.read_text()) if p.exists() else {'counts':{},'active':0,'maximum':0,'argv':[]}
 if initial:
  v['counts'][name]=v['counts'].get(name,0)+1;v['argv'].append(args)
 v['active']+=delta;v['maximum']=max(v['maximum'],v['active'])
 p.write_text(json.dumps(v));fcntl.flock(lock,fcntl.LOCK_UN);return v['counts'].get(name,0)
attempt=update(1,True)
if config['wait'] and not (state/'release').exists():
 (state/'transport-marker.json').write_text(json.dumps({'pid':os.getpid(),'parent':os.getppid()}))
 os.close(1);os.close(2)
 time.sleep(30)
 update(-1)
 raise SystemExit(0)
try:
 time.sleep(config['delayMilliseconds']/1000)
 status='404' if attempt<=config['failures'] else '200'
 body=pathlib.Path(config['payloads'][name]).read_bytes() if status=='200' else b''
 sys.stdout.buffer.write(body+('\\nHEPTA_R_SOURCE_HTTP_V1\\n'+status+'\\n'+url+'\\n').encode())
finally:update(-1)
`;
  const curl = path.join(tools,'curl');fs.writeFileSync(curl,program,{mode:0o550});
  return {tools,state,config,curl,configPin:fixture.pin(config),curlPin:fixture.pin(curl)};
}
async function originalMixedOracle(root, seed, payloads, concurrency, failures=0) {
  const script=path.join(fixture.root,'original-mixed-acquire-oracle.mjs');
  const program=`import fs from 'node:fs';
import {composeRRuntimeSourceCasAcquisition} from './paper-composition/automation/r-runtime-source-cas-composition.mjs';
let raw='';for await(const block of process.stdin){raw+=block; if(Buffer.byteLength(raw)>65536)throw new Error('fixture input bound');}
const input=JSON.parse(raw);const counts={};let active=0,maximum=0;
const transport={version:1,kind:'RRuntimeSourceArchiveTransport',async fetchArchive({url}){
const name=url.split('/').at(-1);if(!Object.hasOwn(input.payloads,name))throw new Error('unknown fixture package');
counts[name]=(counts[name]||0)+1;const attempt=counts[name];active++;maximum=Math.max(maximum,active);
try{await new Promise(r=>setTimeout(r,30));if(attempt<=input.failures)throw new Error('fixture_http_404');return {url,bytes:fs.readFileSync(input.payloads[name])};}finally{active--;}}};
let value=null,error=null;try{value=await composeRRuntimeSourceCasAcquisition({repositoryRoot:input.root,seedSourceDirectory:input.seed,concurrency:input.concurrency,archiveTransport:transport});}catch(e){error=e.message;}
process.stdout.write(JSON.stringify({value,error,counts,maximum})+'\\n');`;
  if(!fs.existsSync(script))fs.writeFileSync(script,program,{mode:0o440});else assert.equal(fs.readFileSync(script,'utf8'),program);
  const scriptBefore=fixture.pin(script);
  const result=await fixture.run('oracle',[script],{},fixture.binary,null,JSON.stringify({root,seed,payloads,concurrency,failures}));
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');assert.deepEqual(fixture.pin(script),scriptBefore);
  return JSON.parse(result.stdout);
}
function cloneLock(fromContext, root) {
  const context=path.join(root,'runtime-images/r-scientific');fs.mkdirSync(context,{recursive:true,mode:0o700});
  fs.copyFileSync(path.join(fromContext,'renv.lock'),path.join(context,'renv.lock'));return context;
}
test('normal_r_source_cas_mixed_transport_retries_preserve_original_lock_order_and_full_materialized_bytes',async()=>{
  for(const concurrency of [1,6,16]) {
    const prefix=path.join(fixture.root,`mixed-concurrency-${concurrency}`);fs.mkdirSync(prefix,{mode:0o700});
    const seed=path.join(prefix,'seed'),payload=path.join(prefix,'payload'),nodeRoot=path.join(prefix,'node'),nativeRoot=path.join(prefix,'native');
    const packages=[['Alpha','1.0'],['netA','1.0'],['netB','1.0'],['netC','1.0'],['netD','1.0'],['netE','1.0'],['netF','1.0'],['netG','1.0']];
    const nc=setup(nodeRoot,payload,packages);fs.mkdirSync(seed,{mode:0o700});fs.copyFileSync(path.join(payload,'Alpha_1.0.tar.gz'),path.join(seed,'Alpha_1.0.tar.gz'));const rc=cloneLock(nc,nativeRoot);
    const payloads=Object.fromEntries(packages.slice(1).map(([p,v])=>[`${p}_${v}.tar.gz`,path.join(payload,`${p}_${v}.tar.gz`)]));
    const seedBefore=fixture.snapshot(seed),payloadBefore=fixture.snapshot(payload);
    const control=transportFixture(prefix,payloads,{failures:2});
    const node=await originalMixedOracle(nodeRoot,seed,payloads,concurrency,2);
    const values=['--action=acquire','--root',nativeRoot,'--seed',seed];if(concurrency!==6)values.push('--concurrency',String(concurrency));
    const native=await fixture.run('native',args(values),{PATH:`${control.tools}:/usr/bin:/bin`,TOKEN:'nonsecret-fixture-marker',HTTPS_PROXY:'http://must-not-contact.invalid'});
    assert.equal(native.status,0,native.stderr);assert.equal(native.stderr,'');assert.equal(node.error,null);
    assert.deepEqual(JSON.parse(native.stdout),node.value);assert.deepEqual(bytesInventory(path.join(rc,'source-cas')),bytesInventory(path.join(nc,'source-cas')));
    const calls=JSON.parse(fs.readFileSync(path.join(control.state,'calls.json')));assert.deepEqual(calls.counts,node.counts);
    assert.equal(calls.active,0);assert.ok(calls.maximum>=1&&calls.maximum<=Math.min(concurrency,7));if(concurrency===1)assert.equal(calls.maximum,1);else assert.ok(calls.maximum>1,'actual simultaneous transports');
    assert.deepEqual(fixture.pin(control.config),control.configPin);assert.deepEqual(fixture.pin(control.curl),control.curlPin);assert.deepEqual(fixture.snapshot(seed),seedBefore);assert.deepEqual(fixture.snapshot(payload),payloadBefore);
    const replayBefore=fixture.snapshot(nativeRoot),priorCalls=fixture.pin(path.join(control.state,'calls.json'));
    const retry=await fixture.run('native',args(['--action=acquire','--root',nativeRoot,'--seed','missing-after-ready']),{PATH:'/no-archive-tools'});
    assert.equal(retry.status,0,retry.stderr);assert.equal(JSON.parse(retry.stdout).acquired,false);assert.deepEqual(fixture.snapshot(nativeRoot),replayBefore);assert.deepEqual(fixture.pin(path.join(control.state,'calls.json')),priorCalls);
    observations.push({concurrency,node,native,actualNativeCalls:calls,scope:'original Node injected port and native normal fixed-tool boundary; live HTTPS authority false'});
  }
});
test('normal_r_source_cas_known_terminal_three_attempts_cleanup_then_same_namespace_fresh_retry',async()=>{
  const prefix=path.join(fixture.root,'mixed-known-failure');fs.mkdirSync(prefix,{mode:0o700});
  const payload=path.join(prefix,'payload'),nodeRoot=path.join(prefix,'node'),nativeRoot=path.join(prefix,'native');
  const nc=setup(nodeRoot,payload,[['demo','1.0']]);const rc=cloneLock(nc,nativeRoot);const payloads={'demo_1.0.tar.gz':path.join(payload,'demo_1.0.tar.gz')};
  const control=transportFixture(prefix,payloads,{failures:3});
  const node=await originalMixedOracle(nodeRoot,null,payloads,6,3);
  const native=await fixture.run('native',args(['--action=acquire','--root',nativeRoot]),{PATH:`${control.tools}:/usr/bin:/bin`});
  assert.equal(native.status,1);assert.equal(native.stdout,'');assert.match(native.stderr,/r_runtime_source_cas_download_failed:demo:/u);assert.match(node.error,/r_runtime_source_cas_download_failed:demo:/u);
  const calls=JSON.parse(fs.readFileSync(path.join(control.state,'calls.json')));assert.deepEqual(calls.counts,node.counts);assert.equal(calls.counts['demo_1.0.tar.gz'],3);assert.equal(calls.active,0);
  assert.deepEqual(fs.readdirSync(rc),['renv.lock']);assert.deepEqual(fs.readdirSync(nc),['renv.lock']);
  const fresh=await fixture.run('native',args(['--action=acquire','--root',nativeRoot]),{PATH:`${control.tools}:/usr/bin:/bin`});
  assert.equal(fresh.status,0,fresh.stderr);assert.equal(JSON.parse(fresh.stdout).acquired,true);
  const updated=JSON.parse(fs.readFileSync(path.join(control.state,'calls.json')));assert.equal(updated.counts['demo_1.0.tar.gz'],4);
  observations.push({node,native,fresh,actualCalls:updated,scope:'three known terminal transport failures; stage cleaned only after namespace proof; retry publishes once; exact error messages remain explicit boundary'});
});

test('normal_r_source_cas_context_concurrency_lock_seed_layers_preserve_original_refusal_order',async()=>{
  for(const mode of ['missing-context','invalid-concurrency','malformed-lock','invalid-seed']) {
    const pairs=[];
    for(const engine of ['node','native']) {
      const root=path.join(fixture.root,`layer-${mode}-${engine}`),context=path.join(root,'runtime-images/r-scientific');
      const values=['--action=acquire','--root',root,'--seed',path.join(root,'missing-seed')];
      if(mode!=='missing-context')fs.mkdirSync(context,{recursive:true,mode:0o700});
      if(mode==='invalid-concurrency'){fs.writeFileSync(path.join(context,'renv.lock'),'invalid-json');values.push('--concurrency=0');}
      if(mode==='malformed-lock')fs.writeFileSync(path.join(context,'renv.lock'),'invalid-json');
      if(mode==='invalid-seed')fs.writeFileSync(path.join(context,'renv.lock'),JSON.stringify({Packages:{demo:{Package:'demo',Version:'1.0',Source:'Repository',Repository:'CRAN'}}}));
      const before=fixture.snapshot(root);const result=await fixture.run(engine,args(values));
      assert.equal(result.status,1);assert.equal(result.stdout,'');assert.deepEqual(fixture.snapshot(root),before);
      const expected={'missing-context':/ENOENT: no such file or directory, lstat/u,'invalid-concurrency':/r_runtime_source_cas_concurrency_invalid/u,'malformed-lock':/r_runtime_source_cas_lock_json_invalid/u,'invalid-seed':engine==='native'?/r_runtime_source_cas_seed_unavailable/u:/ENOENT: no such file or directory, lstat/u}[mode];
      assert.match(result.stderr,expected);if(mode==='invalid-concurrency')assert.ok(!result.stderr.includes('lock_json_invalid'));if(mode==='malformed-lock')assert.ok(!result.stderr.includes('seed_directory_invalid'));
      pairs.push({engine,values,result});
    }
    observations.push({mode,pairs,scope:'actual normal constructors/context, numeric, lock, seed refusal layers; no acquisition or namespace mutation'});
  }
});

function nativeProcessPin(pid) {
  try {
    const raw=fs.readFileSync(`/proc/${pid}/stat`,'utf8');assert.ok(Buffer.byteLength(raw)<16384);
    const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/u);
    const status=fs.readFileSync(`/proc/${pid}/status`,'utf8');assert.ok(Buffer.byteLength(status)<65536);
    return {pid,state:fields[0],parent:Number(fields[1]),group:Number(fields[2]),session:Number(fields[3]),start:fields[19],uid:Number(/^Uid:\s+(\d+)/mu.exec(status)[1])};
  }catch(error){if(['ENOENT','ESRCH'].includes(error.code))return null;throw error;}
}
function signalCurrentNativePin(pin, signal, parentTermination = null) {
  const now=nativeProcessPin(pin.pid);if(!now||['Z','X'].includes(now.state))return false;
  const parentNow=parentTermination?nativeProcessPin(parentTermination.pin.pid):undefined;
  assertNativeSignalTargetOwned(pin,now,process.getuid(),parentTermination,parentNow);
  process.kill(pin.pid,signal);return true;
}
async function signalAfterRequestedParentTermination(pin, signal, termination, deadline) {
  const current=nativeProcessPin(pin.pid);if(!current||['Z','X'].includes(current.state))return false;
  if(termination)await waitForRequestedParentTermination(termination,deadline,{readPin:nativeProcessPin});
  return signalCurrentNativePin(pin,signal,termination);
}
async function pollNativeMarker(marker,deadline) {
  while(Date.now()<deadline) {
    if(fs.existsSync(marker)){const pin=fixture.pin(marker),raw=fs.readFileSync(marker);assert.deepEqual(fixture.pin(marker),pin);assert.ok(raw.length<4096);return JSON.parse(raw);}
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('actual native transport barrier not reached');
}
test('normal_r_source_cas_active_transport_term_kill_preserve_unknown_stage_and_fresh_replay',async()=>{
  for(const signal of ['SIGTERM','SIGKILL']) {
    const prefix=path.join(fixture.root,`active-${signal}`);fs.mkdirSync(prefix,{mode:0o700});
    const root=path.join(prefix,'native'),payload=path.join(prefix,'payload');const context=setup(root,payload,[['demo','1.0']]);
    const payloads={'demo_1.0.tar.gz':path.join(payload,'demo_1.0.tar.gz')};const control=transportFixture(prefix,payloads,{wait:true});
    const argsBefore=fixture.snapshot(root), lockBefore=fixture.pin(path.join(context,'renv.lock'));
    const inFlight=fixture.run('native',args(['--action=acquire','--root',root]),{PATH:`${control.tools}:/usr/bin:/bin`},fixture.binary,null,null,signal,signal==='SIGTERM');
    let observed,transportPin,parentPin,parentTermination,result,failure;
    const lifecycleDeadline=Date.now()+15000;
    try {
      observed=await pollNativeMarker(path.join(control.state,'transport-marker.json'),lifecycleDeadline);
      transportPin=nativeProcessPin(observed.pid);parentPin=nativeProcessPin(observed.parent);
      assert.ok(transportPin&&parentPin);assert.equal(transportPin.uid,process.getuid());assert.equal(transportPin.parent,parentPin.pid);
      assert.equal(parentPin.group,parentPin.pid);assert.equal(parentPin.session,parentPin.pid);assert.equal(fs.readlinkSync(`/proc/${parentPin.pid}/exe`),fixture.binary);
      const requested=signalCurrentNativePin(parentPin,signal);assert.equal(requested,true);
      parentTermination=recordRequestedParentTermination(parentPin,signal,requested);
      if(signal==='SIGKILL')await signalAfterRequestedParentTermination(transportPin,'SIGKILL',parentTermination,lifecycleDeadline);
      result=await inFlight;
      const live=nativeProcessPin(transportPin.pid);assert.ok(!live||['Z','X'].includes(live.state),'actual existing cancellation owner stops transport');
    }catch(error){failure=error;}finally{
      try {if(transportPin)await signalAfterRequestedParentTermination(transportPin,'SIGKILL',parentTermination,lifecycleDeadline);}
      catch(error){failure=failure?new AggregateError([failure,error],'native transport cleanup refused'):error;}
      try {if(parentPin)signalCurrentNativePin(parentPin,'SIGKILL');}
      catch(error){failure=failure?new AggregateError([failure,error],'native parent cleanup refused'):error;}
      try {result=await inFlight;}catch(error){failure=failure?new AggregateError([failure,error],'native completion refused'):error;}
    }
    if(failure)throw failure;
    assert.equal(result.status,null);assert.equal(result.signal,signal);
    // The shared ordinary signal owner restores Node termination only AFTER the
    // callback joins its archive children. The live-child assertion above runs
    // before this harness finally can signal that child; terminal signal alone
    // would not prove cooperative cleanup.
    assert.deepEqual(fixture.pin(path.join(context,'renv.lock')),lockBefore);assert.equal(fs.existsSync(path.join(context,'source-cas')),false);
    const stages=fs.readdirSync(context).filter(name=>name.startsWith('.source-cas.staging-'));assert.equal(stages.length,1);
    const retained=fixture.snapshot(path.join(context,stages[0]));fs.writeFileSync(path.join(control.state,'release'),'controlled fresh epoch',{mode:0o600});
    const retry=await fixture.run('native',args(['--action=acquire','--root',root]),{PATH:`${control.tools}:/usr/bin:/bin`});assert.equal(retry.status,0,retry.stderr);assert.equal(JSON.parse(retry.stdout).acquired,true);
    assert.deepEqual(fixture.snapshot(path.join(context,stages[0])),retained);assert.deepEqual(fixture.pin(control.config),control.configPin);assert.deepEqual(fixture.pin(control.curl),control.curlPin);
    const final=fixture.snapshot(root);const replay=await fixture.run('native',args(['--action=acquire','--root',root]),{PATH:'/no-archive-tools'});assert.equal(replay.status,0,replay.stderr);assert.equal(JSON.parse(replay.stdout).acquired,false);assert.deepEqual(fixture.snapshot(root),final);
    observations.push({signal,observed,transportPin,parentPin,result,retry,replay,initial:argsBefore,scope:'actual normal native fixed-tool start/EOF barrier and original TERM/KILL; unknown pre-publication stage retained; same namespace fresh retry; not Node cancellation parity or public network qualification'});
  }
});
