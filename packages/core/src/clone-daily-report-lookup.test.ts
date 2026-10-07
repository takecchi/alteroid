import { describe, expect, it } from 'vitest';

import { EXCHANGE_KIND_FAILURE_PREFIX } from './exchange-kind.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { setup, waitFor } from './clone-test-harness.js';

const DATE = '2026-08-19';

type Row = { type: 'daily_report'; date: string; body: string; unavailable?: string };

function storesWithFailingLookup(message: string | null): {
  stores: Stores;
  rawList: Stores['journal']['list'];
} {
  const stores = createMemoryStores();
  const rawList = stores.journal.list.bind(stores.journal);
  if (message !== null) {
    stores.journal.list = ((query) => {
      const only = query?.types;
      if (only?.length === 1 && only[0] === 'daily_report') {
        return Promise.reject(new Error(message));
      }
      return rawList(query);
    }) as Stores['journal']['list'];
  }
  return { stores, rawList };
}

const reportsOf = async (rawList: Stores['journal']['list']) =>
  (await rawList({ types: ['daily_report'] })) as Row[];

const lookupNotices = async (rawList: Stores['journal']['list']) =>
  ((await rawList({ types: ['exchange'] })) as { with: string; text: string }[]).filter((entry) =>
    entry.text.startsWith(`${EXCHANGE_KIND_FAILURE_PREFIX}日報の既存確認`),
  );

function postDailyReport(post: (event: never) => void, date: string): void {
  (post as (event: unknown) => void)({
    type: 'timer',
    id: `evt-timer-${date}`,
    at: new Date().toISOString(),
    kind: 'daily_report',
    target: date,
  });
}

describe('クローン — 日報の既存確認が読めなかった回（#2447）', () => {
  it('読めなかった回でも日報は書き、重複の可能性を日誌に残す（理由は1行目だけ）', async () => {
    const { stores, rawList } = storesWithFailingLookup(
      'connection reset by peer\nsecret-second-line-value',
    );
    const s = setup(() => '今日はログイン周りを直した。', stores);

    postDailyReport(s.clone.post.bind(s.clone), DATE);

    await waitFor(async () => (await reportsOf(rawList)).length === 1, '日報が書かれる');
    await waitFor(async () => (await lookupNotices(rawList)).length === 1, '跡が残る');

    const reports = await reportsOf(rawList);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.unavailable).toBeUndefined();
    expect(reports[0]?.body).toContain('ログイン周り');

    const notices = await lookupNotices(rawList);
    expect(notices[0]?.text).toContain(DATE);
    expect(notices[0]?.text).toContain('重複');
    expect(notices[0]?.text).toContain('connection reset by peer');
    expect(notices[0]?.text).not.toContain('secret-second-line-value');
    await s.clone.stop();
  });

  it('読めなかった回に、ターンが失敗しても「作れなかった」の印は積まない（1日1件を確かめられない）', async () => {
    const { stores, rawList } = storesWithFailingLookup('lookup timed out');
    const s = setup(() => '部分的に出ていた本文', stores, {
      resultFor: () => ({ subtype: 'error_during_execution', text: '内部で何かが壊れた' }),
    });

    postDailyReport(s.clone.post.bind(s.clone), DATE);

    await waitFor(async () => (await lookupNotices(rawList)).length === 1, '跡が残る');

    expect(await reportsOf(rawList)).toHaveLength(0);
    await s.clone.stop();
  });

  it('対照: 読めたときは今までどおり書き、跡は残さない', async () => {
    const { stores, rawList } = storesWithFailingLookup(null);
    const s = setup(() => '今日はログイン周りを直した。', stores);

    postDailyReport(s.clone.post.bind(s.clone), DATE);

    await waitFor(async () => (await reportsOf(rawList)).length === 1, '日報が書かれる');
    expect((await reportsOf(rawList))[0]?.body).toContain('ログイン周り');
    expect(await lookupNotices(rawList)).toHaveLength(0);
    await s.clone.stop();
  });

  it('対照: 本物の日報が既にある日は、読めたときは書き足さない', async () => {
    const { stores, rawList } = storesWithFailingLookup(null);
    await stores.journal.append({ type: 'daily_report', date: DATE, body: '道具で書いた日報' });
    const s = setup(() => '書いておいた', stores);

    postDailyReport(s.clone.post.bind(s.clone), DATE);
    await waitFor(() => s.calls.length > 0, 'ターンが走る');
    await s.clone.stop();

    expect(await reportsOf(rawList)).toHaveLength(1);
    expect(await lookupNotices(rawList)).toHaveLength(0);
  });

  it('digest をまとめられなかった理由は reasonOf を通す（1行目だけ。素の String(error) を残さない）', async () => {
    const stores = createMemoryStores();
    stores.jobs.listJobs = () =>
      Promise.reject(new Error('jobs table unreachable\nsecret-digest-second-line'));
    const s = setup(() => '書いた', stores);

    postDailyReport(s.clone.post.bind(s.clone), DATE);
    await waitFor(() => s.calls.some((call) => call.inputs.length > 0), 'ターンが走る');

    const prompt = s.calls.flatMap((call) => call.inputs).join('\n');
    const at = prompt.indexOf('（この日の記録をまとめられなかった');
    expect(at).toBeGreaterThanOrEqual(0);
    const digestPart = prompt.slice(at);
    expect(digestPart).toContain('jobs table unreachable');
    expect(digestPart).not.toContain('secret-digest-second-line');
    await s.clone.stop();
  });
});
