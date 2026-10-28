import { describe, expect, it } from 'vitest';

import { buildActivityDigest, MAX_ITEMS } from './digest.js';
import type { Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 終端して何日も経った failed が、`#persist` で `updatedAt` だけ進むたびに要約の節「マネージャー」へ1本ずつ出ていた件の歯。
// 窓の判定は `updatedAt` ではなく、終端を刻む欄（`lease.releasedAt`・`lastFailure.at`・`lastSystemError.at`・`lastUnreported.at`・`lastReportAt`）で行う。

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const window = () => ({ since: new Date(NOW - DAY) });

function sectionOf(digest: string, heading: string): string {
  const start = digest.indexOf(heading);
  if (start === -1) return '';
  const rest = digest.slice(start);
  const end = rest.indexOf('\n\n');
  return end === -1 ? rest : rest.slice(0, end);
}

type Extra = Partial<Omit<Job, 'id' | 'status' | 'createdAt' | 'summary'>>;

async function put(stores: Stores, id: string, status: Job['status'], extra: Extra = {}) {
  await stores.jobs.putJob({
    id,
    createdAt: iso(20 * DAY),
    // `#persist` が進めた体: 終端が古くても `updatedAt` は今
    updatedAt: iso(1000),
    status,
    summary: `${id} の仕事`,
    ...extra,
  });
}

const releasedAgo = (ms: number): Extra => ({
  lease: {
    runnerId: 'runner-a',
    fence: 1,
    grantedAt: iso(ms + 1000),
    seenAt: iso(ms + 1000),
    ttlMs: 60_000,
    releasedAt: iso(ms),
  },
});

const failureAgo = (ms: number): Extra => ({
  lastFailure: { code: 'boom', via: 'sdk', at: iso(ms) },
});

describe('窓より前に終端した failed は、別の1行に畳む', () => {
  it('14 日前に終端して updatedAt だけ新しい failed は畳まれ、id と引き方が出る', async () => {
    const stores = createMemoryStores();
    await put(stores, 'old-failed-a', 'failed', releasedAgo(14 * DAY));
    await put(stores, 'old-failed-b', 'failed', failureAgo(14 * DAY));

    const section = sectionOf(await buildActivityDigest(stores, window()), '## マネージャー');

    expect(section).not.toMatch(/- old-failed-a \[/u);
    expect(section).not.toMatch(/- old-failed-b \[/u);
    expect(section).toContain('- 終端して窓より前の failed 2 本: old-failed-a, old-failed-b');
    expect(section).toContain('`manager_list`');
    expect(section).toContain('`manager_report`');
    expect(section).not.toContain('boom');
  });

  // ALTEROID_TOKEN_SAVING_EXCERPT=0（Clone は trimHistory: false を渡す）: 節約の前の形に戻り、窓より前の failed も1本ずつ出る
  it('⭐ trimHistory: false なら、窓より前に終端した failed も1本ずつ出る（畳まない）', async () => {
    const stores = createMemoryStores();
    await put(stores, 'old-failed-a', 'failed', releasedAgo(14 * DAY));
    await put(stores, 'old-failed-b', 'failed', failureAgo(14 * DAY));

    const section = sectionOf(
      await buildActivityDigest(stores, window(), undefined, undefined, { trimHistory: false }),
      '## マネージャー',
    );

    expect(section).toMatch(/- old-failed-a \[/u);
    expect(section).toMatch(/- old-failed-b \[/u);
    expect(section).not.toContain('終端して窓より前の failed');
  });

  it('窓の中で終端した failed は1本ずつ出る', async () => {
    const stores = createMemoryStores();
    await put(stores, 'new-failed', 'failed', releasedAgo(60_000));
    await put(stores, 'new-failed-reported', 'failed', {
      ...releasedAgo(14 * DAY),
      ...failureAgo(60_000),
    });

    const section = sectionOf(await buildActivityDigest(stores, window()), '## マネージャー');

    expect(section).toMatch(/- new-failed \[failed\//u);
    expect(section).toMatch(/- new-failed-reported \[failed\//u);
    expect(section).not.toContain('窓より前の failed');
  });

  it('終端した時刻が取れない failed（終端を刻む欄が無い）は、lastReportAt が古くても1本ずつ出る', async () => {
    const stores = createMemoryStores();
    await put(stores, 'no-stamp', 'failed');
    await put(stores, 'only-old-report', 'failed', { lastReportAt: iso(14 * DAY) });

    const section = sectionOf(await buildActivityDigest(stores, window()), '## マネージャー');

    expect(section).toMatch(/- no-stamp \[failed\//u);
    expect(section).toMatch(/- only-old-report \[failed\//u);
    expect(section).not.toContain('窓より前の failed');
  });

  it('背景処理を待っている failed は、終端が古くても1本ずつ出る', async () => {
    const stores = createMemoryStores();
    await put(stores, 'bg-failed', 'failed', releasedAgo(14 * DAY));

    const digest = await buildActivityDigest(
      stores,
      window(),
      undefined,
      new Map([['bg-failed', { tasks: 1, withheldReports: 0, breakdown: '', since: iso(DAY) }]]),
    );

    expect(digest).toMatch(/- bg-failed \[failed\//u);
    expect(digest).not.toContain('窓より前の failed');
  });

  it('走行中・人間の回答待ち・lost は、時刻の欄が古くても畳まれない', async () => {
    const stores = createMemoryStores();
    for (const status of ['running', 'waiting_human', 'lost'] as const) {
      await put(stores, `mgr-${status}`, status, {
        ...releasedAgo(14 * DAY),
        ...failureAgo(14 * DAY),
        lastReportAt: iso(14 * DAY),
      });
    }

    const section = sectionOf(await buildActivityDigest(stores, window()), '## マネージャー');

    for (const status of ['running', 'waiting_human', 'lost'] as const) {
      expect(section).toMatch(new RegExp(`- mgr-${status} \\[${status}/`, 'u'));
    }
    expect(section).not.toContain('窓より前の failed');
    expect(section).not.toContain('手が止まっている担当');
  });

  it('lastFailure 付きの stopped は、窓の中なら1本ずつ、窓より前なら done・stopped の行へ畳む', async () => {
    const stores = createMemoryStores();
    await put(stores, 'stopped-recent', 'stopped', failureAgo(60_000));
    await put(stores, 'stopped-old', 'stopped', failureAgo(14 * DAY));

    const section = sectionOf(await buildActivityDigest(stores, window()), '## マネージャー');

    expect(section).toMatch(/- stopped-recent \[stopped\//u);
    expect(section).toContain('boom');
    expect(section).not.toMatch(/- stopped-old \[/u);
    expect(section).toContain('- 手が止まっている担当（done・stopped）1 本: stopped-old');
    expect(section).not.toContain('窓より前の failed');
  });

  it('id の並びは MAX_ITEMS で切り、残りの件数を出す', async () => {
    const stores = createMemoryStores();
    const total = MAX_ITEMS + 4;
    for (let i = 0; i < total; i += 1) {
      await put(stores, `old-${String(i).padStart(2, '0')}`, 'failed', releasedAgo(14 * DAY));
    }

    const section = sectionOf(await buildActivityDigest(stores, window()), '## マネージャー');
    const line = section.split('\n').find((l) => l.startsWith('- 終端して窓より前の failed'));

    expect(line).toContain(`${total} 本: `);
    expect(line).toContain(' …ほか 4 件');
    expect(line?.split(', ')).toHaveLength(MAX_ITEMS);
  });

  it('1本ずつ出す枠（MAX_ITEMS）を、畳んだ failed が食わない', async () => {
    const stores = createMemoryStores();
    for (let i = 0; i < MAX_ITEMS; i += 1) {
      await put(stores, `old-${i}`, 'failed', releasedAgo(14 * DAY));
    }
    for (let i = 0; i < MAX_ITEMS; i += 1) {
      await put(stores, `run-${i}`, 'running');
    }

    const section = sectionOf(await buildActivityDigest(stores, window()), '## マネージャー');

    for (let i = 0; i < MAX_ITEMS; i += 1)
      expect(section).toMatch(new RegExp(`- run-${i} \\[`, 'u'));
    expect(section).not.toContain('…ほか 1 件');
    expect(section).toContain(`終端して窓より前の failed ${MAX_ITEMS} 本`);
  });
});

describe('件数の形（定期の依頼の tick）・日報の range でも同じ', () => {
  it('counts の形でも畳まれ、全体の形と節が同じ', async () => {
    const stores = createMemoryStores();
    await put(stores, 'old-failed', 'failed', releasedAgo(14 * DAY));
    await put(stores, 'new-failed', 'failed', releasedAgo(60_000));

    const full = await buildActivityDigest(stores, window());
    const counts = await buildActivityDigest(stores, window(), undefined, undefined, {
      shape: 'counts',
    });

    const section = sectionOf(counts, '## マネージャー');
    expect(section).toBe(sectionOf(full, '## マネージャー'));
    expect(section).toContain('- 終端して窓より前の failed 1 本: old-failed');
    expect(section).toMatch(/- new-failed \[failed\//u);
  });

  it('日報の range: その日（range の since 以降）に終端した failed は畳まれず、前の日のものは畳まれる', async () => {
    const stores = createMemoryStores();
    const since = new Date(NOW - 3 * DAY);
    const until = new Date(NOW - 2 * DAY);
    await put(stores, 'failed-that-day', 'failed', {
      ...releasedAgo(2.5 * DAY),
      updatedAt: iso(2.5 * DAY),
    });
    await put(stores, 'failed-day-before', 'failed', {
      ...releasedAgo(5 * DAY),
      updatedAt: iso(2.5 * DAY),
    });

    const section = sectionOf(
      await buildActivityDigest(stores, { since, until }),
      '## マネージャー',
    );

    expect(section).toMatch(/- failed-that-day \[failed\//u);
    expect(section).not.toMatch(/- failed-day-before \[/u);
    expect(section).toContain('- 終端して窓より前の failed 1 本: failed-day-before');
  });
});
