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
let fixture,code,caller,runtime,binary,binarySource,binaryBefore,graph,fixtureData;
function invoke(program,args,extra={}){const env=safeEnvironment();const out=spawnSync(program,args,{cwd:caller,env:{...env,PATH:`${path.dirname(process.execPath)}:${env.PATH||'/usr/bin:/bin'}`,HEPTA_PAPER_RUNTIME_ROOT:'',...extra},timeout:120000,maxBuffer:16*1024*1024,encoding:'utf8',shell:false});assert.equal(out.error,undefined,out.error?.message);assert.equal(out.signal,null);return out;}
function run(native,args=[],env={}){const argv=['operator','autonomous-state-backup',...args];return invoke(native?binary:process.execPath,native?argv:[path.join(code,'paper-core/bin/hepta-paper.mjs'),...argv],env);}
function comparison(args=[],env={}){const node=run(false,args,env),native=run(true,args,env);assert.equal(native.status,node.status,native.stderr);assert.equal(native.stdout,node.stdout);return {node,native};}
function bytes(root){const out={};for(const entry of fs.readdirSync(root,{withFileTypes:true})){const file=path.join(root,entry.name);if(entry.isDirectory())Object.assign(out,bytes(file));else if(entry.isFile())out[file]=pin(file);}return out;}
before(()=>{
 const built=buildNativeOwners();binarySource=built.owners['hepta-paper-rust'].path;binaryBefore=pin(binarySource);assert.equal(`sha256:${binaryBefore.sha256}`,built.owners['hepta-paper-rust'].sha256);
 fixture=fs.mkdtempSync('/tmp/hepta-backup-cli-e2e-');code=path.join(fixture,'code');caller=path.join(fixture,'caller');fs.mkdirSync(caller);fs.mkdirSync(code);
 const seeded=spawnSync(process.execPath,[path.join(ROOT,'rust/oracle/state-backup-cli-v1.mjs')],{cwd:ROOT,env:safeEnvironment(),input:JSON.stringify({mode:'fixture',root:fixture}),timeout:120000,maxBuffer:16*1024*1024,encoding:'utf8'});assert.equal(seeded.error,undefined);assert.equal(seeded.status,0);const result=JSON.parse(seeded.stdout);assert.equal(result.ok,true);assert.equal(result.profile.node,'v22.23.1');fixtureData=result.value;
 graph=new Map();const pending=['paper-core/bin/hepta-paper.mjs','paper-core/bin/autonomous-research-state-backup.mjs','package.json'];
 while(pending.length){const relative=pending.pop();if(graph.has(relative))continue;assert.ok(graph.size<4096);assert.ok(relative&&!relative.startsWith('../')&&!path.isAbsolute(relative));const from=path.join(ROOT,relative),to=path.join(code,relative);graph.set(relative,{source:pin(from),copy:copy(from,to)});if(!relative.endsWith('.mjs'))continue;for(const match of fs.readFileSync(from,'utf8').matchAll(/(?:from\s+|import\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)){const specifier=match[1];if(specifier.startsWith('node:'))continue;assert.ok(specifier.startsWith('.'),`unbound_package:${specifier}`);pending.push(path.relative(ROOT,path.resolve(path.dirname(from),specifier)));}}
 fs.mkdirSync(path.join(code,'paper-core/config'),{recursive:true});fs.writeFileSync(path.join(code,'paper-core/config/autonomous-research-state-databases.v1.json'),JSON.stringify(fixtureData.manifest),{mode:0o440});
 binary=path.join(code,'bin/hepta-paper-rust');copy(binarySource,binary,0o550);
 runtime=path.join(fixture,'hepta-paper-runtime/native-runtime');fs.mkdirSync(path.dirname(runtime),{recursive:true});fs.renameSync(fixtureData.runtime,runtime);
});
after(()=>{if(!fixture)return;try{assert.deepEqual(pin(binarySource),binaryBefore);for(const [relative,p]of graph){assert.deepEqual(pin(path.join(ROOT,relative)),p.source);assert.deepEqual(pin(path.join(code,relative)),p.copy);}}finally{fs.rmSync(fixture,{recursive:true,force:true});}});
test('normal_backup_status_default_relative_runtime_and_original_full_wire_preserve_sources',()=>{
 const before=bytes(runtime);const first=comparison();assert.equal(first.native.status,0);const report=JSON.parse(first.native.stdout);assert.equal(report.instances.length,10);
 comparison(['--']);comparison(['--','--action=status']);comparison(['--','--runtime-root','../hepta-paper-runtime/native-runtime']);comparison([],{HEPTA_PAPER_RUNTIME_ROOT:'../hepta-paper-runtime/native-runtime'});comparison(['--','--bundle=ignored']);assert.deepEqual(bytes(runtime),before);assert.equal(fs.existsSync(path.join(fixture,'calls.jsonl')),false);
 const empty=path.join(fixture,'empty');fs.mkdirSync(empty);const blocked=comparison(['--','--runtime-root',empty]);assert.equal(blocked.native.status,2);assert.equal(JSON.parse(blocked.native.stdout).inventoryHash,null);
});
test('normal_backup_help_and_registry_refusals_are_original_and_writer_refuses_without_mutation',()=>{
 for(const args of [['--','--help'],['--','--help','--action=unknown'],['--','--action=unknown'],['--','--action=restore-drill'],['--','--action=reconcile-and-renew']])comparison(args);
 for(const args of [['unexpected'],['--','--root=x'],['--','--help=true'],['--','--action='],['--','--'],['--','--action','--help'],['--','--help','--help']]){const n=run(false,args),r=run(true,args);assert.equal(n.status,2);assert.equal(r.status,2);assert.equal(r.stdout,'');assert.ok(r.stderr.includes(JSON.parse(n.stderr).error));}
 const before=bytes(runtime);
 for(const args of [['--action=backup'],['--action=renew'],['--action=restore-drill','--bundle=x'],['--action=reconcile-and-renew','--authority-config=x','--online-authority-process-config=x']]){const out=run(true,['--',...args]);assert.equal(out.status,1);assert.equal(out.stdout,'');assert.match(out.stderr,/ordinary_readonly_action_required/u);}
 assert.deepEqual(bytes(runtime),before);assert.equal(fs.existsSync(path.join(fixture,'calls.jsonl')),false);assert.equal(comparison().native.status,0);
});
test('normal_backup_unknown_copied_elf_requires_root_without_caller_cwd_fallback',()=>{
 const unknown=path.join(fixture,'unknown/debug/copied-rust');copy(binarySource,unknown,0o550);const before=bytes(runtime);
 const rejected=invoke(unknown,['operator','autonomous-state-backup']);assert.equal(rejected.status,1);assert.equal(rejected.stdout,'');assert.match(rejected.stderr,/native_workspace_root_required/u);assert.deepEqual(bytes(runtime),before);
 const help=invoke(unknown,['operator','autonomous-state-backup','--','--help']);assert.equal(help.status,0);
 const explicit=invoke(unknown,['operator','autonomous-state-backup'],{HEPTA_PAPER_WORKSPACE_ROOT:code});assert.equal(explicit.status,0);assert.equal(explicit.stdout,comparison().native.stdout);assert.deepEqual(bytes(runtime),before);
});
