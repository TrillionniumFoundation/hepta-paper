// Test-only oracle. Every key read or generated here is confined to an explicit
// private temporary fixture root; private bytes are never serialized or logged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inspectLocalReleaseIntegrityKey, provisionLocalReleaseIntegrityKey, loadExistingLocalReleaseIntegritySigningKey } from '../../paper-core/bin/release-integrity-key-management.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
const root = path.resolve(import.meta.dirname, '../..');
function safeRoot(request) {
  const selected = path.resolve(request.runtimeRoot);
  if (!selected.startsWith('/tmp/hepta-release-key-rust-')) throw new Error('oracle_requires_private_temporary_fixture');
  return selected;
}
const results = requests.map(request => {
  let retained = null;
  try {
    const runtimeRoot = safeRoot(request);
    process.env.PAPER_FACTORY_LEGACY_ROOT = request.legacyRoot || path.join(path.dirname(runtimeRoot), 'legacy');
    const environment = { ...process.env, HEPTA_PAPER_ASSET_ROOT: request.assetRoot || path.join(path.dirname(runtimeRoot), 'assets'), HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot, HEPTA_PAPER_RUNTIME_ISOLATED: request.isolated ? '1' : '0' };
    const options = {runtimeRoot, environment, ...(request.assetRoot ? {assetRoot:request.assetRoot}: {})};
    let value;
    if (request.operation === 'fixture') {
      const keyRoot = path.join(runtimeRoot,'release-signing');
      fs.mkdirSync(keyRoot,{mode:0o700});
      const algorithm = request.algorithm || 'ed25519';
      const generated = crypto.generateKeyPairSync(algorithm, algorithm === 'rsa' ? {modulusLength:2048} : algorithm === 'ec' ? {namedCurve:'P-256'} : {});
      const publicPair = request.mismatch ? crypto.generateKeyPairSync('ed25519') : generated;
      const privatePem = Buffer.from(generated.privateKey.export({type:'pkcs8',format:'pem'}));
      try {
        fs.writeFileSync(path.join(keyRoot,'release-integrity-ed25519-private.pem'),privatePem,{mode:0o600});
        fs.writeFileSync(path.join(keyRoot,'release-integrity-ed25519-public.pem'),publicPair.publicKey.export({type:'spki',format:'pem'}),{mode:0o444});
      } finally { privatePem.fill(0); }
      value = inspectLocalReleaseIntegrityKey(options);
    } else if (request.operation === 'fault') {
      const scenario = request.scenario;
      const base = path.dirname(runtimeRoot);
      const keyRoot = path.join(runtimeRoot, 'release-signing');
      const concurrent = path.join(base, 'concurrent');
      if (['staging-open','empty-cleanup'].includes(scenario)) {
        fs.mkdirSync(concurrent,{mode:0o755});
        fs.chmodSync(concurrent,0o755);
        if(scenario==='empty-cleanup')fs.writeFileSync(path.join(concurrent,'marker'),'preserve concurrent directory');
      }
      if (scenario==='file-cleanup')fs.writeFileSync(concurrent,'preserve concurrent file');
      let injected=false;
      const descriptors=new Map();
      const fileSystem=new Proxy(fs,{get(target,property){
        if(property==='openSync')return (candidate,flags,...args)=>{
          if(scenario==='staged-write' && String(candidate).endsWith('release-integrity-ed25519-public.pem'))throw new Error('injected_staged_write');
          if(scenario==='staging-open' && !injected && String(candidate).includes('.release-signing-staging-') && (flags&fs.constants.O_DIRECTORY)!==0){
            injected=true;fs.renameSync(candidate,path.join(base,'held-owned'));fs.renameSync(concurrent,candidate);
          }
          const fd=target.openSync(candidate,flags,...args);descriptors.set(fd,String(candidate));return fd;
        };
        if(property==='fsyncSync')return (fd)=>{
          target.fsyncSync(fd);
          if(scenario==='file-cleanup' && descriptors.get(fd)?.endsWith('release-integrity-ed25519-private.pem'))throw new Error('injected_write_failure');
        };
        if(property==='linkSync')return (source,destination)=>{
          if(scenario==='empty-cleanup' && destination===path.join(keyRoot,'release-integrity-ed25519-public.pem'))throw new Error('injected_publish_failure');
          return target.linkSync(source,destination);
        };
        if(property==='renameSync')return (source,destination)=>{
          const selected=(scenario==='empty-cleanup' && source===keyRoot) || (scenario==='file-cleanup' && String(source).endsWith('release-integrity-ed25519-private.pem'));
          if(!injected && selected){injected=true;fs.renameSync(source,path.join(base,'held-owned'));fs.renameSync(concurrent,source);}
          return target.renameSync(source,destination);
        };
        return target[property];
      }});
      value=provisionLocalReleaseIntegrityKey({...options,execute:true,fileSystem,beforePublish(){
        if(scenario==='root-replaced'){fs.renameSync(runtimeRoot,path.join(base,'runtime-held'));fs.mkdirSync(runtimeRoot);}
        if(scenario==='empty-rival'){fs.mkdirSync(keyRoot,{mode:0o700});fs.chmodSync(keyRoot,0o700);}
      }});
    } else if (request.operation === 'pair-window') {
      const keyRoot=path.join(runtimeRoot,'release-signing');
      const privatePath=path.join(keyRoot,'release-integrity-ed25519-private.pem');
      const publicPath=path.join(keyRoot,'release-integrity-ed25519-public.pem');
      let changed=false;
      const fileSystem=new Proxy(fs,{get(target,property){
        if(property==='openSync')return(candidate,...args)=>{
          if(!changed && String(candidate)===publicPath){
            changed=true;
            if(request.mutation==='replace'){
              const replacement=path.join(path.dirname(runtimeRoot),'replacement');
              fs.writeFileSync(replacement,'synthetic unrelated private marker',{mode:0o600});
              fs.renameSync(replacement,privatePath);
            } else if(request.mutation==='permissions')fs.chmodSync(privatePath,0o644);
            else if(request.mutation==='hardlink')fs.linkSync(privatePath,path.join(path.dirname(runtimeRoot),'retained-hardlink'));
            else fs.writeFileSync(path.join(keyRoot,'unexpected'),'marker');
          }
          return target.openSync(candidate,...args);
        };
        return target[property];
      }});
      if(request.selectedOperation==='status')value=inspectLocalReleaseIntegrityKey({...options,fileSystem});
      else {
        retained=loadExistingLocalReleaseIntegritySigningKey(runtimeRoot,{...options,fileSystem,includePrivate:request.selectedOperation==='private-load'});
        value={publicPath:retained.publicPath,publicKeyFingerprint:retained.publicKeyFingerprint,privateRetained:Buffer.isBuffer(retained.privateKeyPem)};
      }
      if(!changed)throw new Error('oracle_pair_window_not_exercised');
    } else if (request.operation === 'status') value = inspectLocalReleaseIntegrityKey(options);
    else if (request.operation === 'provision') value = provisionLocalReleaseIntegrityKey({...options,execute:request.execute===true});
    else if (request.operation === 'load') {
      retained = loadExistingLocalReleaseIntegritySigningKey(runtimeRoot,{...options,includePrivate:request.includePrivate===true});
      value = {publicPath:retained.publicPath,publicKeyFingerprint:retained.publicKeyFingerprint,privateRetained:Buffer.isBuffer(retained.privateKeyPem)};
    } else if (request.operation === 'cli') {
      const child = spawnSync(process.execPath,[path.join(root,'paper-core/bin/release-integrity-key.mjs'),...request.argv],{cwd:root,encoding:'utf8',env:environment});
      if (child.status===1) return {ok:false,error:child.stderr.match(/(?:^|\n)Error: ([^\n]+)/)?.[1] || 'oracle_unrecognized_error'};
      return {ok:true,value:request.argv.includes('--help')?child.stdout.trimEnd():JSON.parse(child.stdout),exitCode:child.status};
    } else throw new Error('oracle_unknown_operation');
    return {ok:true,value};
  } catch (error) {return {ok:false,error:error.message};}
  finally {if(retained?.privateKeyPem)retained.privateKeyPem.fill(0);}
});
process.stdout.write(JSON.stringify({profile:productionOracleProfile(),results}));
