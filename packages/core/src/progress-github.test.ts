import { describe, expect, it } from 'vitest';

import { describeProgress } from './progress-describe.js';
import {
  GITHUB_OBSERVATION_SCAN_LIMIT,
  describeGithubCi,
  PROGRESS_GITHUB_NOT_OBSERVED,
  summarizeGithubObservations,
} from './progress-github.js';
import { readProgress } from './progress-read.js';
import type { JournalEntry } from './schema.js';
import { createMemoryStores } from './testing.js';

let seq = 0;
function ok(
  repo: string,
  at: string,
  counts: { openIssues: number; openPulls: number; truncated?: boolean } = {
    openIssues: 1,
    openPulls: 2,
  },
  observedBy = 'clone',
): JournalEntry {
  seq += 1;
  return {
    type: 'github_observation',
    id: `o${String(seq)}`,
    at,
    observedBy,
    repo,
    query: 'gh issue list --state open',
    limit: 100,
    result: { status: 'ok', truncated: false, ...counts },
  };
}
function failed(repo: string, at: string, reason = 'gh: HTTP 502'): JournalEntry {
  seq += 1;
  return {
    type: 'github_observation',
    id: `f${String(seq)}`,
    at,
    observedBy: 'mgr-1',
    repo,
    query: 'gh issue list --state open',
    result: { status: 'failed', reason },
  };
}

describe('summarizeGithubObservations（#2245 段1）', () => {
  it('記録が無ければ not_observed（0 件ではない）', () => {
    expect(summarizeGithubObservations([])).toEqual(PROGRESS_GITHUB_NOT_OBSERVED);
    expect(PROGRESS_GITHUB_NOT_OBSERVED.state).toBe('not_observed');
  });

  it('他の種別だけが渡されても not_observed', () => {
    const decision: JournalEntry = {
      type: 'decision',
      id: 'd1',
      at: '2026-10-01T00:00:00.000Z',
      decision: 'x',
      grounds: 'y',
    };
    expect(summarizeGithubObservations([decision]).state).toBe('not_observed');
  });

  it('新しい順の先頭を repo ごとの最新として採る。成功と失敗は別々に持つ', () => {
    const result = summarizeGithubObservations([
      failed('a/b', '2026-10-02T00:00:00.000Z'),
      ok('a/b', '2026-10-01T00:00:00.000Z', { openIssues: 7, openPulls: 0 }),
      ok('a/b', '2026-09-30T00:00:00.000Z', { openIssues: 99, openPulls: 99 }),
      ok('a/a', '2026-09-29T00:00:00.000Z'),
    ]);
    if (result.state !== 'observed') throw new Error('observed のはず');
    expect(result.repos.map((r) => r.repo)).toEqual(['a/a', 'a/b']);
    const ab = result.repos[1]!;
    expect(ab.latestOk).toMatchObject({ openIssues: 7, openPulls: 0 });
    expect(ab.latestFailed).toMatchObject({
      reason: 'gh: HTTP 502',
      observedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(ab.latestFailed).not.toHaveProperty('openIssues');
  });

  it('古さを判定しない（どれだけ古くても observed のまま、時刻をそのまま返す）', () => {
    const result = summarizeGithubObservations([ok('a/b', '2020-01-01T00:00:00.000Z')]);
    if (result.state !== 'observed') throw new Error('observed のはず');
    expect(result.repos[0]!.latestOk!.observedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(JSON.stringify(result)).not.toMatch(/stale|古い|fresh/);
  });

  it('上限より先が在るとき（limit+1 件目が在るとき）だけ reachedLimit が真になる', () => {
    const entries = [
      ok('a/b', '2026-10-01T00:00:00.000Z'),
      ok('a/b', '2026-09-30T00:00:00.000Z'),
      ok('c/d', '2026-09-29T00:00:00.000Z'),
    ];
    const hit = summarizeGithubObservations(entries, 2);
    const exact = summarizeGithubObservations(entries.slice(0, 2), 2);
    const miss = summarizeGithubObservations(entries, 3);
    if (hit.state !== 'observed' || exact.state !== 'observed' || miss.state !== 'observed')
      throw new Error('observed のはず');
    expect(hit.scan).toEqual({ limit: 2, reachedLimit: true });
    expect(exact.scan).toEqual({ limit: 2, reachedLimit: false });
    expect(miss.scan).toEqual({ limit: 3, reachedLimit: false });
    expect(hit.repos.map((r) => r.repo)).toEqual(['a/b']);
  });
});

describe('readProgress / describeProgress の github（#2245 段1）', () => {
  const NOW = new Date('2026-10-02T12:00:00.000Z');

  it('日誌の読みに types と limit（500）を渡す（無制限に読まない）', async () => {
    const stores = createMemoryStores();
    const queries: unknown[] = [];
    // `list` の件数は固定しない: メモリのストアの内側の先読み（+1）は実装の都合だから。
    const listPage = stores.journal.listPage.bind(stores.journal);
    stores.journal.listPage = (query) => {
      queries.push(query);
      return listPage(query);
    };
    await readProgress(stores, { now: NOW });
    const githubQueries = queries.filter(
      (q) =>
        (q as { types?: string[] } | undefined)?.types?.includes('github_observation') === true,
    );
    expect(githubQueries).toMatchObject([{ types: ['github_observation'], limit: 501 }]);
    expect(githubQueries).toHaveLength(1);
    expect(GITHUB_OBSERVATION_SCAN_LIMIT).toBe(500);
  });

  it('上限に当たったとき、欠けた側を「記録が無い」と言わず、読んだ範囲に無いと言う', async () => {
    const base = await readProgress(createMemoryStores(), { now: NOW });
    const github = summarizeGithubObservations(
      [failed('a/b', '2026-10-02T00:00:00.000Z'), failed('c/d', '2026-10-01T00:00:00.000Z')],
      1,
    );
    const text = describeProgress({ ...base, github });
    expect(text).toContain('読んだ範囲（新しい順 1 件）には成功した観測の記録が無い');
    expect(text).not.toContain('数: — （成功した観測の記録が無い');
  });

  it('pg のように LIMIT の後で読めない行を捨てる store でも、先が在れば reachedLimit が真（#2603）', async () => {
    const stores = createMemoryStores();
    const unreadable = new Set<string>();
    for (let i = 0; i < 600; i += 1) {
      const entry = await stores.journal.append({
        type: 'github_observation',
        observedBy: 'clone',
        repo: i === 0 ? 'old/only' : 'new/repo',
        query: 'gh issue list --state open',
        result: { status: 'ok', openIssues: i, openPulls: 0, truncated: false },
      });
      if (i === 590) unreadable.add(entry.id);
    }
    const list = stores.journal.list.bind(stores.journal);
    stores.journal.list = async (query) => {
      // pg と同じく、LIMIT の後で読めない行を捨てる。
      const rows = await list(query);
      return rows.filter((row) => !unreadable.has(row.id));
    };
    const view = await readProgress(stores, { now: NOW });
    if (view.github.state !== 'observed') throw new Error('observed のはず');
    expect(view.github.scan).toEqual({ limit: 500, reachedLimit: true });
    expect(view.github.repos.map((r) => r.repo)).toEqual(['new/repo']);
  });

  it('読めない行を捨てても、先が無ければ reachedLimit は偽（上限ちょうどで尽きた場合）', async () => {
    const stores = createMemoryStores();
    const unreadable = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const entry = await stores.journal.append({
        type: 'github_observation',
        observedBy: 'clone',
        repo: 'new/repo',
        query: 'gh issue list --state open',
        result: { status: 'ok', openIssues: i, openPulls: 0, truncated: false },
      });
      if (i === 250) unreadable.add(entry.id);
    }
    const list = stores.journal.list.bind(stores.journal);
    stores.journal.list = async (query) =>
      (await list(query)).filter((row) => !unreadable.has(row.id));
    const view = await readProgress(stores, { now: NOW });
    if (view.github.state !== 'observed') throw new Error('observed のはず');
    expect(view.github.scan.reachedLimit).toBe(false);
  });

  it('日誌の記録を repo ごとに返し、日誌が空なら not_observed', async () => {
    const stores = createMemoryStores();
    expect((await readProgress(stores, { now: NOW })).github.state).toBe('not_observed');

    await stores.journal.append({
      type: 'github_observation',
      observedBy: 'clone',
      repo: 'takecchi/alteroid',
      query: 'gh issue list --state open --limit 100',
      limit: 100,
      result: { status: 'ok', openIssues: 0, openPulls: 0, truncated: false },
    });
    const view = await readProgress(stores, { now: NOW });
    if (view.github.state !== 'observed') throw new Error('observed のはず');
    expect(view.github.repos[0]!.latestOk).toMatchObject({ openIssues: 0, openPulls: 0 });
    expect(view.github.scan.limit).toBe(GITHUB_OBSERVATION_SCAN_LIMIT);
  });

  it('文にするとき、観測者・母集合・時刻を出し、取れなかった回に数を作らない', async () => {
    const stores = createMemoryStores();
    await stores.journal.append({
      type: 'github_observation',
      observedBy: 'clone',
      repo: 'takecchi/alteroid',
      query: 'gh issue list --state open --limit 100',
      limit: 100,
      result: { status: 'ok', openIssues: 0, openPulls: 4, truncated: true },
    });
    await stores.journal.append({
      type: 'github_observation',
      observedBy: 'mgr-1',
      repo: 'takecchi/other',
      query: 'gh pr list',
      result: { status: 'failed', reason: 'gh: HTTP 502' },
    });
    const text = describeProgress(await readProgress(stores, { now: NOW }));
    expect(text).toContain('観測した側の申告');
    expect(text).toContain('open Issue 0 件 / open PR 4 件（limit に達した');
    expect(text).toContain('観測者 clone');
    expect(text).toContain('母集合 gh issue list --state open --limit 100 / limit 100');
    expect(text).toContain('数: — （成功した観測の記録が無い。0 件ではない）');
    expect(text).toContain('取れなかった回');
    expect(text).toContain('gh: HTTP 502');
    expect(text).not.toContain('GitHub: 観測していない');
    expect(text).not.toContain('%');
  });
});

describe('describeGithubCi（#2549）', () => {
  it('ci があれば内訳と、何を数えたかを出す', () => {
    const text = describeGithubCi({
      ci: { pulls: 5, success: 3, failure: 1, pending: 0, checks: '必須チェックだけ' },
    });
    expect(text).toContain('5 件の PR を確認');
    expect(text).toContain('success 3 / failure 1 / pending 0');
    expect(text).toContain('必須チェックだけ');
    expect(text).toContain('未集計 1 件');
  });

  it('打ち切りは下限と書く', () => {
    expect(
      describeGithubCi({
        ci: { pulls: 1, success: 1, failure: 0, pending: 0, checks: 'x', truncated: true },
      }),
    ).toContain('下限');
  });

  it('ci が無ければ「観測していない」で、success 0 などの数を作らない', () => {
    const text = describeGithubCi({});
    expect(text).toContain('観測していない');
    expect(text).not.toMatch(/success|failure|pending/);
  });

  it('ciUnavailable は理由を出し、数を作らない', () => {
    const text = describeGithubCi({ ciUnavailable: 'HTTP 403' });
    expect(text).toContain('HTTP 403');
    expect(text).not.toMatch(/success|failure|pending/);
  });

  it('summarize が ci を repo の最新へ運び、古い行（ci なし）には欄を作らない', () => {
    const withCi = ok('a/b', '2026-10-02T00:00:00.000Z');
    if (withCi.type !== 'github_observation' || withCi.result.status !== 'ok') throw new Error();
    withCi.result.ci = { pulls: 1, success: 1, failure: 0, pending: 0, checks: 'x' };
    const old = ok('a/c', '2026-10-01T00:00:00.000Z');
    const view = summarizeGithubObservations([withCi, old]);
    if (view.state !== 'observed') throw new Error();
    expect(view.repos[0]!.latestOk!.ci).toEqual({
      pulls: 1,
      success: 1,
      failure: 0,
      pending: 0,
      checks: 'x',
    });
    expect('ci' in view.repos[1]!.latestOk!).toBe(false);
  });
});
