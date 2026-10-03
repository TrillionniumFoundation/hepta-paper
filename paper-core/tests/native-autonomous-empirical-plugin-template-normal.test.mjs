import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {before,after,test} from 'node:test';
import {buildNativeOwners,safeEnvironment} from '../../docs/tools/node-rust-route-acceptance.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const identity=m=>[m.dev,m.ino,m.mode,m.nlink,m.uid,m.gid,m.size,m.mtimeNs,m.ctimeNs].map(String);
function pin(file){const m=fs.lstatSync(file,{bigint:true});assert.ok(m.isFile());const bytes=fs.readFileSync(file);assert.deepEqual(identity(fs.lstatSync(file,{bigint:true})),identity(m));return {identity:identity(m),sha256:createHash('sha256').update(bytes).digest('hex')};}
function copy(from,to,mode=0o440){const p=pin(from);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);fs.chmodSync(to,mode);assert.equal(pin(to).sha256,p.sha256);assert.deepEqual(pin(from),p);return pin(to);}
let fixture,code,caller,binary,binarySource,binaryBefore,graph;
function invoke(program,args,extra={}){const env=safeEnvironment();const out=spawnSync(program,args,{cwd:caller,env:{...env,PATH:`${path.dirname(process.execPath)}:${env.PATH||'/usr/bin:/bin'}`,HEPTA_PAPER_RUNTIME_ROOT:'',HEPTA_PAPER_WORKSPACE_ROOT:'',...extra},timeout:120000,maxBuffer:16*1024*1024,encoding:'utf8',shell:false});assert.equal(out.error,undefined,out.error?.message);assert.equal(out.signal,null);return out;}
function run(native,args=[],env={}){const argv=['operator','autonomous-empirical-plugin-release',...args];return invoke(native?binary:process.execPath,native?argv:[path.join(code,'paper-core/bin/hepta-paper.mjs'),...argv],env);}
function comparison(args=[],env={}){const node=run(false,args,env),native=run(true,args,env);assert.equal(native.status,node.status,native.stderr);assert.equal(native.stdout,node.stdout);if(node.status!==0){assert.equal(native.stdout,'');const message=/Error: ([^\n]+)/u.exec(node.stderr);assert.ok(message,node.stderr);assert.ok(native.stderr.includes(message[1]),native.stderr);}return {node,native};}
function bytes(root){const out={};for(const entry of fs.readdirSync(root,{withFileTypes:true})){const file=path.join(root,entry.name);if(entry.isDirectory())Object.assign(out,bytes(file));else if(entry.isFile())out[file]=pin(file);}return out;}
before(()=>{
 const built=buildNativeOwners();binarySource=built.owners['hepta-paper-rust'].path;binaryBefore=pin(binarySource);assert.equal(`sha256:${binaryBefore.sha256}`,built.owners['hepta-paper-rust'].sha256);
 fixture=fs.mkdtempSync('/tmp/hepta-plugin-template-e2e-');code=path.join(fixture,'code');caller=path.join(fixture,'caller');fs.mkdirSync(caller);fs.mkdirSync(code);
 graph=new Map();const pending=['paper-core/bin/hepta-paper.mjs','paper-core/bin/autonomous-empirical-plugin-release.mjs','package.json'];
 while(pending.length){const relative=pending.pop();if(graph.has(relative))continue;assert.ok(graph.size<4096);assert.ok(relative&&!relative.startsWith('../')&&!path.isAbsolute(relative));const from=path.join(ROOT,relative),to=path.join(code,relative);graph.set(relative,{source:pin(from),copy:copy(from,to)});if(!relative.endsWith('.mjs'))continue;for(const match of fs.readFileSync(from,'utf8').matchAll(/(?:from\s+|import\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)){const specifier=match[1];if(specifier.startsWith('node:'))continue;assert.ok(specifier.startsWith('.'),`unbound_package:${specifier}`);pending.push(path.relative(ROOT,path.resolve(path.dirname(from),specifier)));}}
 fs.mkdirSync(path.join(code,'paper-core/config'),{recursive:true});
 binary=path.join(code,'bin/hepta-paper-rust');copy(binarySource,binary,0o550);
});
after(()=>{if(!fixture)return;try{assert.deepEqual(pin(binarySource),binaryBefore);for(const [relative,p]of graph){assert.deepEqual(pin(path.join(ROOT,relative)),p.source);assert.deepEqual(pin(path.join(code,relative)),p.copy);}}finally{fs.rmSync(fixture,{recursive:true,force:true});}});
test('normal_unsigned_plugin_template_six_profiles_null_unused_options_and_original_raw_wire',()=>{
 const before=bytes(code);
 const cases=[['--action=template'],['--action','template','--package-id',' custom.id ','--package-version',' 1.2.3-rc.1 '],['--action=template','--template=definitely-missing','--signing-config=definitely-missing','--install-root=definitely-missing','--activation=definitely-missing'],['--action=template','--signing-config=definitely-missing','--install-root=definitely-missing','--activation=definitely-missing']];
 const families=['rl_stochastic_control_benchmark','ml_algorithm_benchmark','econometrics_panel_benchmark','finance_asset_pricing_benchmark','operations_optimization_benchmark','registered_scalar_response_benchmark'];
 for(const family of families)cases.push(['--action=template','--benchmark-family',family]);
 cases.push(['--action=template',...families.flatMap(f=>['--benchmark-family',f])]);
 for(const values of cases){const pair=comparison(['--',...values]);assert.equal(pair.native.status,0);const value=JSON.parse(pair.native.stdout);if(value!==null){assert.ok(value.profiles.every(p=>p.profileId&&p.executionAdapterId&&p.fixtureEvaluatorId&&p.typedOracleKinds.length===6));} }
 assert.deepEqual(bytes(code),before);
});
test('normal_unsigned_plugin_original_help_defaults_registry_errors_and_authority_modes_refuse',()=>{
 for(const values of [['--help'],['--help','--action=invalid'],[],['--action=invalid'],['--action=inspect'],['--action=plan','--package-version=1.0.0'],['--action=publish','--template=missing'],['--action=template','--benchmark-family=invalid'],['--action=template','--benchmark-family=ml_algorithm_benchmark','--benchmark-family= ml_algorithm_benchmark '],['--action=template','--template=missing','--package-id=x'],['--action=template','--package-version=1.0']])comparison(['--',...values]);
 for(const args of [['unexpected'],['--','--root=x'],['--','--help=true'],['--','--action='],['--','--'],['--','--action','--help'],['--','--help','--help']]){const n=run(false,args),r=run(true,args);assert.equal(n.status,2);assert.equal(r.status,2);assert.equal(r.stdout,'');assert.deepEqual(JSON.parse(r.stderr),JSON.parse(n.stderr));}
 const before=bytes(code);
 for(const values of [['--action=plan','--template=missing','--signing-config=missing'],['--action=publish','--template=missing','--signing-config=missing','--install-root=missing'],['--action=inspect','--activation=missing','--template=ignored','--package-id=ignored']]){const out=run(true,['--',...values]);assert.equal(out.status,1);assert.equal(out.stdout,'');assert.match(out.stderr,/ordinary_unsigned_template_action_required/u);}
 assert.deepEqual(bytes(code),before);assert.equal(comparison(['--','--action=template']).native.status,0);
});
test('normal_unsigned_plugin_unknown_copy_requires_root_help_and_explicit_retry_are_pure',()=>{
 const unknown=path.join(fixture,'unknown/debug/copied-rust');copy(binarySource,unknown,0o550);const before=bytes(code);
 const rejected=invoke(unknown,['operator','autonomous-empirical-plugin-release','--','--action=template']);assert.equal(rejected.status,1);assert.equal(rejected.stdout,'');assert.match(rejected.stderr,/native_workspace_root_required/u);
 const help=invoke(unknown,['operator','autonomous-empirical-plugin-release','--','--help']);assert.equal(help.status,0);assert.equal(help.stdout,comparison(['--','--help']).native.stdout);
 const explicit=invoke(unknown,['operator','autonomous-empirical-plugin-release','--','--action=template'],{HEPTA_PAPER_WORKSPACE_ROOT:code});assert.equal(explicit.status,0);assert.equal(explicit.stdout,comparison(['--','--action=template']).native.stdout);assert.deepEqual(bytes(code),before);
});

test('normal_unsigned_plugin_configured_startup_domain_is_refused_before_help_without_io',()=>{
 const before=bytes(code);const bundle='HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE',trust='HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE';
 for(const key of [bundle,trust])for(const values of [['--help'],['--action=template']]){const env={[key]:'definitely-missing'};const n=run(false,['--',...values],env),r=run(true,['--',...values],env);assert.equal(n.status,1);assert.equal(r.status,1);assert.equal(n.stdout,'');assert.equal(r.stdout,'');assert.match(n.stderr,/immutable_signed_json_bundle_configuration_incomplete/u);assert.match(r.stderr,/immutable_signed_json_bundle_configuration_incomplete/u);}
 for(const values of [['--help'],['--action=template']]){const env={[bundle]:'definitely-missing',[trust]:'definitely-missing'};const n=run(false,['--',...values],env),r=run(true,['--',...values],env);assert.equal(n.status,1);assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/configured_startup_domain_unaccepted_v1/u);}
 comparison(['--','--help'],{[bundle]:'\uFEFF ',[trust]:' '});comparison(['--','--action=template'],{[bundle]:' ',[trust]:' '});
 const n=run(false,['--','--help=true'],{[bundle]:'definitely-missing'}),r=run(true,['--','--help=true'],{[bundle]:'definitely-missing'});assert.equal(n.status,2);assert.equal(r.status,2);assert.deepEqual(JSON.parse(r.stderr),JSON.parse(n.stderr));assert.deepEqual(bytes(code),before);
});
