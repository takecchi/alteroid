import { describe, expect, it } from 'vitest';

import { readProgress } from './progress-read.js';
import { createMemoryStores } from './testing.js';
import {
  CLONE_ALLOWED_TOOLS,
  CLONE_TOOL_NAMES,
  GITHUB_OBSERVATION_CLONE_OBSERVER,
  SELF_JOURNALING_CLONE_TOOLS,
  TRACELESS_CLONE_TOOLS,
  createCloneTools,
  qualifiedToolName,
} from './tools.js';

function recordTool(stores: ReturnType<typeof createMemoryStores>) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
  });
  const found = tools.find((entry) => entry.name === 'github_observation_record');
  if (!found) throw new Error('github_observation_record が登録されていない');
  return {
    found,
    call: async (args: Record<string, unknown>) => {
      const result = await found.handler(args as never, {});
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
    },
  };
}

const OK = { status: 'ok', openIssues: 12, openPulls: 0, truncated: false } as const;

describe('github_observation_record（#2245 段2）', () => {
  it('クローンの許可名簿にあり、自前で日誌へ書く側の名簿に載る', () => {
    expect(CLONE_TOOL_NAMES).toContain('github_observation_record');
    expect(CLONE_ALLOWED_TOOLS).toContain(qualifiedToolName('github_observation_record'));
    expect(SELF_JOURNALING_CLONE_TOOLS as readonly string[]).toContain('github_observation_record');
    expect(TRACELESS_CLONE_TOOLS as readonly string[]).not.toContain('github_observation_record');
  });

  it('説明文に、failed は数を作らないこと・query に母集合の引数を含めることが書かれている', () => {
    const { found } = recordTool(createMemoryStores());
    expect(found.description).toContain('取れなかった回は数を作らない');
    expect(found.description).toContain('母集合を切った引数');
    expect(found.description).toContain('--state open --limit');
  });

  it('ok を日誌へ記録し、observedBy は器が clone と埋める。/progress がそれを返す', async () => {
    const stores = createMemoryStores();
    const { call } = recordTool(stores);
    const reply = await call({
      repo: 'takecchi/alteroid',
      query: 'gh issue list --state open --limit 200',
      limit: 200,
      result: OK,
    });
    expect(reply).toContain('記録した');
    const rows = await stores.journal.list({ types: ['github_observation'] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'github_observation',
      observedBy: GITHUB_OBSERVATION_CLONE_OBSERVER,
      repo: 'takecchi/alteroid',
      limit: 200,
      result: OK,
    });
    const view = await readProgress(stores, { now: new Date() });
    if (view.github.state !== 'observed') throw new Error('observed のはず');
    expect(view.github.repos[0]!.latestOk).toMatchObject({ openIssues: 12, observedBy: 'clone' });
  });

  it('failed を記録し、数は混ざらない（引数に数を足しても落ちる）', async () => {
    const stores = createMemoryStores();
    const { call } = recordTool(stores);
    const reply = await call({
      repo: 'a/b',
      query: 'gh issue list',
      result: { status: 'failed', reason: 'gh: HTTP 502', openIssues: 99, openPulls: 99 },
    });
    expect(reply).toContain('取れなかった回として記録した');
    const [row] = await stores.journal.list({ types: ['github_observation'] });
    expect(row).toMatchObject({ result: { status: 'failed', reason: 'gh: HTTP 502' } });
    // 数は鍵でも値でも混ざらない。`result` は status と reason だけ（余分な鍵があれば落ちる）。
    // 行全体を `/99/` で照合すると、`at` の時刻のミリ秒（例: `42.994Z`）に当たって揺れる
    // （PR #2578 の CI、2026-10-02）。だから数は「前後が数字でも小数点でもない 99」として見る。
    if (row?.type !== 'github_observation') throw new Error('github_observation の行のはず');
    expect(row.result).toEqual({
      status: 'failed',
      reason: 'gh: HTTP 502',
    });
    const json = JSON.stringify(row);
    expect(json).not.toMatch(/"openIssues"|"openPulls"/);
    expect(json).not.toMatch(/(?<![\d.])99(?![\d.])/);
  });

  it('observedBy を引数で上書きできない', async () => {
    const stores = createMemoryStores();
    const { call } = recordTool(stores);
    await call({ repo: 'a/b', query: 'q', result: OK, observedBy: 'mgr-evil' });
    const [row] = await stores.journal.list({ types: ['github_observation'] });
    expect(row).toMatchObject({ observedBy: 'clone' });
    expect(JSON.stringify(row)).not.toContain('mgr-evil');
  });

  it.each([
    ['ok なのに数が無い', { repo: 'a/b', query: 'q', result: { status: 'ok' } }],
    ['負の数', { repo: 'a/b', query: 'q', result: { ...OK, openIssues: -1 } }],
    ['repo が空', { repo: '', query: 'q', result: OK }],
    ['failed の理由が空', { repo: 'a/b', query: 'q', result: { status: 'failed', reason: '' } }],
  ])('不正な入力（%s）は記録せず、送られた値を混ぜない', async (_name, args) => {
    const stores = createMemoryStores();
    const { call } = recordTool(stores);
    const reply = await call(args);
    expect(reply).toContain('記録していない');
    expect(await stores.journal.list({ types: ['github_observation'] })).toEqual([]);
  });

  it('日誌に書けないときは失敗を返し（書けたふりをしない）、/progress は変わらない', async () => {
    const stores = createMemoryStores();
    stores.journal.append = () => {
      throw new Error('journal store unavailable (test)');
    };
    const { call } = recordTool(stores);
    await expect(call({ repo: 'a/b', query: 'q', result: OK })).rejects.toThrow(
      /github_observation_record/,
    );
    expect(await stores.journal.list({ types: ['github_observation'] })).toEqual([]);
    expect((await readProgress(stores, { now: new Date() })).github.state).toBe('not_observed');
  });
});

describe('github_observation の CI の軸（#2549）', () => {
  const CI = {
    pulls: 5,
    success: 3,
    failure: 1,
    pending: 1,
    checks: '必須チェックだけ（test / lint）',
  };

  it('説明文に、checks へ何を数えたか書くこと・取れなければ ciUnavailable と書くことがある', () => {
    const { found } = recordTool(createMemoryStores());
    expect(found.description).toContain('`checks` に書く');
    expect(found.description).toContain('ciUnavailable');
  });

  it('ok と ci あり: 日誌へ記録され、/progress が ci を返す', async () => {
    const stores = createMemoryStores();
    const { call } = recordTool(stores);
    expect(await call({ repo: 'a/b', query: 'q', result: { ...OK, ci: CI } })).toContain(
      '記録した',
    );
    const [row] = await stores.journal.list({ types: ['github_observation'] });
    expect(row).toMatchObject({ result: { ci: CI } });
    const view = await readProgress(stores, { now: new Date() });
    if (view.github.state !== 'observed') throw new Error('observed のはず');
    expect(view.github.repos[0]!.latestOk).toMatchObject({ ci: CI });
  });

  it('ok と ci なし（古い行）: そのまま読め、ci も ciUnavailable も作られない（0 を作らない）', async () => {
    const stores = createMemoryStores();
    const { call } = recordTool(stores);
    await call({ repo: 'a/b', query: 'q', result: OK });
    const view = await readProgress(stores, { now: new Date() });
    if (view.github.state !== 'observed') throw new Error('observed のはず');
    const latest = view.github.repos[0]!.latestOk!;
    expect(latest.openIssues).toBe(12);
    expect('ci' in latest).toBe(false);
    expect('ciUnavailable' in latest).toBe(false);
  });

  it('ciUnavailable あり: 理由が残り、ci は無い', async () => {
    const stores = createMemoryStores();
    const { call } = recordTool(stores);
    await call({
      repo: 'a/b',
      query: 'q',
      result: { ...OK, ciUnavailable: 'gh: check-runs が 403' },
    });
    const view = await readProgress(stores, { now: new Date() });
    if (view.github.state !== 'observed') throw new Error('observed のはず');
    const latest = view.github.repos[0]!.latestOk!;
    expect(latest.ciUnavailable).toBe('gh: check-runs が 403');
    expect('ci' in latest).toBe(false);
  });

  it.each([
    ['ci と ciUnavailable が両方ある', { ...OK, ci: CI, ciUnavailable: '取れなかった' }],
    ['ci の和が pulls を超える', { ...OK, ci: { ...CI, pulls: 2 } }],
    ['checks が空', { ...OK, ci: { ...CI, checks: '' } }],
    ['checks が長すぎる', { ...OK, ci: { ...CI, checks: 'x'.repeat(501) } }],
    ['ci の数が負', { ...OK, ci: { ...CI, failure: -1 } }],
    ['ciUnavailable が空', { ...OK, ciUnavailable: '' }],
  ])('不正（%s）は記録しない', async (_name, result) => {
    const stores = createMemoryStores();
    const { call } = recordTool(stores);
    expect(await call({ repo: 'a/b', query: 'q', result })).toContain('記録していない');
    expect(await stores.journal.list({ types: ['github_observation'] })).toEqual([]);
  });

  it('failed に ci / ciUnavailable を混ぜても日誌には入らない', async () => {
    const stores = createMemoryStores();
    const { call } = recordTool(stores);
    await call({
      repo: 'a/b',
      query: 'q',
      result: { status: 'failed', reason: 'gh: HTTP 502', ci: CI, ciUnavailable: 'x' },
    });
    const [row] = await stores.journal.list({ types: ['github_observation'] });
    expect(JSON.stringify(row)).not.toMatch(/"ci"|ciUnavailable|必須チェック/);
  });
});
