import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { parseJsonOrThrow } from '../../workflow-kernel/runtime/data-utils.mjs';

export function mapDeliveryRow(row) {
  return row || null;
}

export function mapDeliveryRows(rows) {
  return Array.isArray(rows) ? rows.map(mapDeliveryRow) : [];
}

export function parseSubmissionOutboxPayload(message) {
  return parseJsonOrThrow(message?.payload_json || '{}', 'outbox payload is invalid');
}

export function hasValidDeliveryRecordHash(kind, record, field) {
  if (!record?.[field]) return false;
  const { [field]: _claimed, ...payload } = record;
  return hashRecord(kind, payload) === record[field];
}
