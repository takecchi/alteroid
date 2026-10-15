import { describe, expect, it, vi } from 'vitest';

import { createPgTimeoutJournal, PG_TIMEOUT_JOURNAL_SOURCE } from './pg-timeout-journal.js';

const fastWait = async () => ({ waitedMs: 7, settled: true });

describe('PostgreSQL の期限切れを日誌へ残す（#4655）', () => {
  it('日誌を渡す前（マイグレーションの間）は標準エラーにだけ出し、渡した後は日誌にも1行残す', async () => {
    const stderr: string[] = [];
    const appended: unknown[] = [];
    const journal = createPgTimeoutJournal((text) => stderr.push(text), fastWait);

    journal.note({ kind: 'connect', timeoutMs: 10_000 });
    expect(stderr).toHaveLength(1);

    journal.attach({
      append: async (entry) => {
        appended.push(entry);
        return entry as never;
      },
    });
    journal.note({ kind: 'query', timeoutMs: 30_000, sql: 'select 1' });
    await vi.waitFor(() => {
      expect(appended).toHaveLength(1);
    });

    expect(stderr).toHaveLength(2);
    expect(appended).toEqual([
      {
        type: 'external_event',
        source: PG_TIMEOUT_JOURNAL_SOURCE,
        summary: expect.stringContaining('30000ms 以内に返らなかった') as unknown,
      },
    ]);
    expect(JSON.stringify(appended)).toContain('select 1');
  });

  it('日誌の行にスレッドの枠の待ちを添える。測れなかった回は「不明」と書く（#4890）', async () => {
    const appended: { summary: string }[] = [];
    let wait: { waitedMs: number; settled: boolean } | undefined = { waitedMs: 812, settled: true };
    const journal = createPgTimeoutJournal(
      () => undefined,
      async () => wait,
    );
    journal.attach({
      append: async (entry) => {
        appended.push(entry as { summary: string });
        return entry as never;
      },
    });

    journal.note({ kind: 'connect', timeoutMs: 10_000 });
    await vi.waitFor(() => {
      expect(appended).toHaveLength(1);
    });
    expect(appended[0]?.summary).toContain('10000ms 以内に繋げなかった');
    expect(appended[0]?.summary).toContain('スレッドの枠の待ち 812ms');

    wait = undefined;
    journal.note({ kind: 'connect', timeoutMs: 10_000 });
    await vi.waitFor(() => {
      expect(appended).toHaveLength(2);
    });
    expect(appended[1]?.summary).toContain('スレッドの枠の待ち: 不明');
  });

  it('⭐ 日誌を書いている間の打ち切りは数えるだけにして、次の1行に件数を添える（日誌の書き込みの期限切れが連鎖しない）', async () => {
    const appended: { summary: string }[] = [];
    const pending: (() => void)[] = [];
    const stderr: string[] = [];
    const journal = createPgTimeoutJournal((text) => stderr.push(text), fastWait);
    journal.attach({
      append: (entry) =>
        new Promise((resolve, reject) => {
          appended.push(entry as { summary: string });
          pending.push(() => reject(new Error('日誌の書き込みも期限で切れた')));
          void resolve;
        }),
    });

    journal.note({ kind: 'query', timeoutMs: 30_000, sql: 'select a' });
    // 書いている間に、書き込みそのものの期限切れを含めて2件
    journal.note({ kind: 'query', timeoutMs: 30_000, sql: 'insert into journal' });
    journal.note({ kind: 'query', timeoutMs: 30_000, sql: 'select b' });
    await vi.waitFor(() => {
      expect(appended).toHaveLength(1);
    });

    pending.shift()?.();
    // 書き終えた（失敗した）後も、自分からは書き直さない
    await vi.waitFor(() => {
      expect(stderr.join('')).toContain('日誌へ残せませんでした');
    });
    expect(appended).toHaveLength(1);

    journal.note({ kind: 'query', timeoutMs: 30_000, sql: 'select c' });
    await vi.waitFor(() => {
      expect(appended).toHaveLength(2);
    });
    expect(appended[1]?.summary).toContain('ほかに 2 件打ち切った');
  });
});
