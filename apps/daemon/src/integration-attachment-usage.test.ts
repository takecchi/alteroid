import type { AttachmentUsage, InboxEvent } from '@alteroid/core';
import {
  createMemoryStores,
  DAEMON_ATTACHMENT_USAGE_SOURCE,
  emptyAttachmentUsage,
  readIntegrationAttachmentNoticeBytes,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { INTEGRATION_ATTACHMENT_NOTICE_BYTES, noteIntegrationAttachmentUsage } from './app.js';

// 連携の鍵の添付の預かりが閾値を越えたら、日誌とクローンへ1回知らせる（#4005）。上げることは断らない。

function storesWithUsage(byKey: Record<string, number>) {
  const memory = createMemoryStores();
  const usage = emptyAttachmentUsage();
  for (const [keyId, totalBytes] of Object.entries(byKey)) {
    usage.byIntegrationKey[keyId] = { count: 1, totalBytes };
  }
  const attachments = {
    ...memory.attachments,
    usage: async (): Promise<AttachmentUsage> => usage,
  } as typeof memory.attachments;
  return { attachments, journal: memory.journal };
}

async function decisions(stores: ReturnType<typeof storesWithUsage>): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['decision'] });
  return entries.map((entry) => JSON.stringify(entry));
}

describe('noteIntegrationAttachmentUsage（連携の鍵の預かりの閾値の知らせ。#4005）', () => {
  it('既定の閾値は 1GiB', () => {
    expect(INTEGRATION_ATTACHMENT_NOTICE_BYTES).toBe(1024 * 1024 * 1024);
    expect(readIntegrationAttachmentNoticeBytes({})).toEqual({
      bytes: 1024 * 1024 * 1024,
      notes: [],
    });
  });

  it('閾値は ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES で変えられる。読めない値は既定へ倒し、理由を notes に出す', () => {
    expect(
      readIntegrationAttachmentNoticeBytes({
        ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES: '5000',
      }),
    ).toEqual({ bytes: 5000, notes: [] });
    expect(
      readIntegrationAttachmentNoticeBytes({ ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES: '  ' }),
    ).toEqual({ bytes: 1024 * 1024 * 1024, notes: [] });
    for (const raw of ['0', '-1', '1.5', 'abc']) {
      const read = readIntegrationAttachmentNoticeBytes({
        ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES: raw,
      });
      expect(read.bytes).toBe(1024 * 1024 * 1024);
      expect(read.notes).toHaveLength(1);
      expect(read.notes[0]).toContain('ALTEROID_ATTACHMENT_INTEGRATION_NOTICE_BYTES');
    }
  });

  it('この1件で閾値を越えたら、日誌とクローンへ1回ずつ知らせる', async () => {
    const stores = storesWithUsage({ k1: 1100 });
    const posted: InboxEvent[] = [];

    await noteIntegrationAttachmentUsage(stores, (event) => posted.push(event), 'k1', 200, 1000);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'external', source: DAEMON_ATTACHMENT_USAGE_SOURCE });
    expect(JSON.stringify(posted[0])).toContain('k1');
    const lines = await decisions(stores);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('連携の鍵 k1');
    expect(lines[0]).toContain('上げることは断っていない');
    // 日誌の根拠の文に内部の issue 番号を残さない。全文で固定する
    expect(lines[0]).toContain('"grounds":"keyId=k1 totalBytes=1100 threshold=1000"');
  });

  it('上げる前から越えていれば鳴らない（越えるのは一度きり）', async () => {
    const stores = storesWithUsage({ k1: 1500 });
    const posted: InboxEvent[] = [];

    await noteIntegrationAttachmentUsage(stores, (event) => posted.push(event), 'k1', 100, 1000);

    expect(posted).toEqual([]);
    expect(await decisions(stores)).toEqual([]);
  });

  it('越えていなければ鳴らない。ほかの鍵の量は数えない', async () => {
    const stores = storesWithUsage({ k1: 500, k2: 5000 });
    const posted: InboxEvent[] = [];

    await noteIntegrationAttachmentUsage(stores, (event) => posted.push(event), 'k1', 100, 1000);

    expect(posted).toEqual([]);
    expect(await decisions(stores)).toEqual([]);
  });

  it('ちょうど閾値に届いた回も鳴る（閾値以上）', async () => {
    const stores = storesWithUsage({ k1: 1000 });
    const posted: InboxEvent[] = [];

    await noteIntegrationAttachmentUsage(stores, (event) => posted.push(event), 'k1', 1, 1000);

    expect(posted).toHaveLength(1);
  });
});
