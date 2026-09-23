// Isolated original-runtime fixture. Never prints fixture key bytes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const [repository, root] = process.argv.slice(2);
if (!path.isAbsolute(repository) || !root.startsWith('/tmp/hepta-source-profile-')
    || fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) {
  throw Error('isolated_fixture_required');
}
const { productionOracleProfile } = await import(pathToFileURL(path.join(repository, 'rust/oracle/production-record-hash-v1.mjs')));
const { createLocalAutonomousResearchStateAuthority } = await import(pathToFileURL(path.join(repository, 'paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs')));
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const privateKeyPath = path.join(root, 'fixture-key.pem');
fs.writeFileSync(privateKeyPath, privateKey.export({format:'pem',type:'pkcs8'}), {mode:0o600,flag:'wx'});
const configuration = {
  version:1, kind:'HeptaLocalAutonomousResearchStateAuthorityConfiguration',
  authorityId:'authority:source-profile', keyId:'key:fixture', scopeId:'scope:source-profile',
  databaseScopeHash:`sha256:${'a'.repeat(64)}`, writerManifestHash:`sha256:${'b'.repeat(64)}`,
  privateKeyPath, stateDatabasePath:path.join(root,'authority.sqlite'), socketPath:path.join(root,'authority.sock'),
  maximumReservationLeaseMs:60000, maximumObservationAgeMs:60000,
};
const configurationPath = path.join(root,'configuration.json');
fs.writeFileSync(configurationPath,JSON.stringify(configuration),{mode:0o600,flag:'wx'});
const authority = createLocalAutonomousResearchStateAuthority({configurationPath});
authority.close();
const db = new DatabaseSync(configuration.stateDatabasePath, {readOnly:true});
try {
  const catalog = db.prepare('SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name').all();
  const metadata = db.prepare('SELECT * FROM authority_metadata').all();
  process.stdout.write(JSON.stringify({profile:productionOracleProfile(),catalog,metadata,userVersion:db.prepare('PRAGMA user_version').get().user_version})+'\n');
} finally { db.close(); }
