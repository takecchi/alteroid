import { describe, expect, it } from 'vitest';

import { summarizeInboxBacklog } from './inbox-backlog.js';
import type { InboxEvent } from './schema.js';
import type { PendingInboxEvent } from './store.js';

describe('summarizeInboxBacklog — oldestAt は実時刻でいちばん古い行', () => {
  const NOW = Date.parse('2026-08-12T12:00:00.000Z');
  const human = (id: string, at: string): InboxEvent => ({
    type: 'human_message',
    id,
    at,
    conversationId: 'c',
    text: id,
  });
  const row = (id: string, at: string): PendingInboxEvent => ({
    event: human(id, at),
    at,
    deliveries: 0,
  });

  const rows = [
    row('evt-new', '2026-08-12T00:30:00.000Z'),
    row('evt-old', '2026-08-12T09:00:00+09:00'),
  ];

  it('oldestAt', () => {
    expect(summarizeInboxBacklog(rows, NOW).oldestAt).toBe('2026-08-12T09:00:00+09:00');
  });

  it('humanOriginated.oldestAt', () => {
    expect(summarizeInboxBacklog(rows, NOW).humanOriginated.oldestAt).toBe(
      '2026-08-12T09:00:00+09:00',
    );
  });
});
