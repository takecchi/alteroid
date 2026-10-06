import { describe, expect, it } from 'vitest';

import { summarizeInboxBacklog } from './inbox-backlog.js';
import type { InboxEvent } from './schema.js';
import type { PendingInboxEvent } from './store.js';

/**
 * `summarizeInboxBacklog` の `oldestAt`（`humanOriginated.oldestAt` を含む）は、受信箱の行の
 * `at` を文字列の `<` で比べている。fs は #2927 より前に書いた `+09:00` のままの行を書き換えず
 * （`packages/storage-fs/src/inbox-at-utc-2927.test.ts`）、インメモリ実装も渡された表記のまま
 * 持つので、表記の違う行が同居する。ストア側（`pending().oldestAt`）は `compareIsoInstant` で
 * 実時刻を比べるのに、内訳だけが文字列順になり、いちばん古い行を取り違える。
 */
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

  // 実時刻では 00:00Z（+09:00 表記）のほうが 00:30Z より古い。文字列順だと逆になる組。
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
