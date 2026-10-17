// Transport interoperability only: this fixture grants no signing, production,
// deployment, or authority qualification. It calls the actual incumbent client
// and server; the handler merely returns request data for byte-boundary tests.
import fs from 'node:fs';
import { runHeptaPaperStateAuthorityClient } from '../../paper-core/bin/hepta-paper-state-authority-client.mjs';
import { requestLocalAutonomousResearchStateAuthority, startLocalAutonomousResearchStateAuthorityServer } from '../../paper-adapters/automation/local-autonomous-research-state-authority-socket.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';

if (process.argv[2] === 'server') {
  const server = await startLocalAutonomousResearchStateAuthorityServer({
    socketPath: process.argv[3],
    authority: { handle(request) {
      if (request.kind === 'reject') throw new Error('fixture_authority_rejected');
      return { version: 1, kind: 'LocalAuthorityClientTransportFixture', request };
    } },
  });
  process.stdout.write(`${JSON.stringify({ profile: productionOracleProfile(), ready: true })}\n`);
  process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
} else {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  let result;
  try {
    const value = input.operation === 'request'
      ? await requestLocalAutonomousResearchStateAuthority(input.options)
      : await runHeptaPaperStateAuthorityClient(input.options);
    result = { ok: true, value: input.statusOnly ? null : value };
  } catch (error) { result = { ok: false, error: String(error?.message || error) }; }
  process.stdout.write(`${JSON.stringify({ profile: productionOracleProfile(), result })}\n`);
}
