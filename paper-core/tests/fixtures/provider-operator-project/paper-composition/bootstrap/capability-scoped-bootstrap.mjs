import fs from 'node:fs';

const trace = process.env.HEPTA_TEST_TRACE_PATH;
if (typeof trace !== 'string' || trace.length === 0) throw new Error('test_trace_path_missing');
const log = (value) => fs.appendFileSync(trace, `${value}\n`);

export function bootstrapSubmissionContext() {
  return {
    services: {
      persistenceSession: { close() { log('session-close'); } },
      submissionDeliveryStore: {
        enqueue() { log('enqueue'); return { message_id: 1 }; },
        recordResponse() {
          log('delivery-verification');
          throw new Error('fixture_stop_at_delivery');
        },
      },
    },
  };
}
